import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Profile } from '../shared/types';
import { pruneStalePairing } from './chrome-launch';

/**
 * Hace que la extensión de Chrome hable con la cuenta que se está usando.
 *
 * Claude Code registra un único puente para todo el equipo: una clave en
 * `HKCU\Software\Google\Chrome\NativeMessagingHosts` apunta a un manifiesto, y
 * ese manifiesto a un `.bat` que arranca `claude.exe --chrome-native-host`. El
 * `.bat` no define `CLAUDE_CONFIG_DIR`, así que el puente hereda el entorno de
 * Chrome y resuelve a `~/.claude`.
 *
 * El emparejamiento (`chromeExtension.pairedDeviceId`) se guarda en el
 * `.claude.json` de la carpeta que el puente resolvió. Resultado: la sesión
 * corre con la cuenta X, pide emparejar porque X no lo tiene, y la respuesta se
 * guarda en `~/.claude`. X nunca queda emparejada y vuelve a pedir login. Para
 * siempre.
 *
 * El primer intento fue apuntar el manifiesto a un `.bat` propio. Duró un
 * segundo: `claude` re-registra el puente CADA vez que arranca, y siempre corre
 * después que la app. Medido — la app escribió a las 16:08:39 y a las 16:08:40
 * el manifiesto ya estaba pisado.
 *
 * Pero ese mismo comportamiento es la solución. El manifiesto que Claude Code
 * escribe apunta a `<configDir>/chrome/chrome-native-host.bat`, o sea que YA
 * lleva la cuenta: hay un `.bat` por carpeta. Y a diferencia del manifiesto,
 * el `.bat` sólo lo escribe cuando falta (visto: creado a las 14:43 y sin tocar
 * después de decenas de sesiones). Así que se parcha ese `.bat`, una vez por
 * cuenta, y se deja el manifiesto en paz. Arranque quien arranque, el puente
 * queda en la carpeta correcta — y si el `.bat` desaparece, se vuelve a parchar
 * antes de la próxima sesión.
 *
 * Sigue habiendo una sola cuenta emparejada a la vez: el registro es uno solo y
 * el named pipe (`claude-mcp-browser-bridge-<usuario>`) también. Lo que cambia
 * es que se empareja una vez por cuenta en vez de una vez por sesión.
 */

/** La línea que marca lo nuestro dentro de un archivo que Claude Code dice no
 *  editar a mano. Sirve para reconocer el parche y no duplicarlo. */
const MARK = 'REM --- Claude Monitor: fija la cuenta de esta carpeta ---';

const hostScript = (configDir: string) => join(configDir, 'chrome', 'chrome-native-host.bat');

/** Saca la ruta de `claude.exe` del `.bat` que generó Claude Code, que es la
 *  única fuente confiable: la instalación puede no estar en el lugar de siempre. */
export function parseClaudeExe(bat: string): string | null {
  const match = bat.match(/"([^"]+claude\.exe)"\s*--chrome-native-host/i);
  return match ? match[1] : null;
}

/**
 * El `.bat` con la cuenta puesta.
 *
 * Devuelve `null` si ya estaba bien o si el archivo no es el que se espera —
 * sin la línea que arranca el puente no hay dónde insertar, y escribir algo
 * inventado dejaría la extensión sin puente.
 *
 * Barre cualquier `set CLAUDE_CONFIG_DIR` anterior antes de poner el suyo, para
 * que mover una cuenta de carpeta no deje dos.
 */
export function patchScript(bat: string, configDir: string): string | null {
  const lines = bat.split(/\r?\n/).filter((l) => l.trim() !== MARK && !/^\s*set\s+"?CLAUDE_CONFIG_DIR=/i.test(l));

  const at = lines.findIndex((l) => /--chrome-native-host/.test(l));
  if (at === -1) return null;

  // `cmd` no se come las barras invertidas —eso es cosa de `wt.exe`, ver
  // `terminal.ts`— así que la ruta va tal cual.
  lines.splice(at, 0, MARK, `set "CLAUDE_CONFIG_DIR=${configDir}"`);
  const patched = lines.join('\r\n');
  return patched === bat ? null : patched;
}

/** El `.bat` completo, para una cuenta que todavía no tiene el suyo. Mismo
 *  formato que el de Claude Code: no puede imprimir nada, porque el protocolo
 *  de native messaging es binario sobre stdout y cualquier eco lo corrompe. */
export function buildScript(configDir: string, claudeExe: string): string {
  return [
    '@echo off',
    'REM Chrome native host wrapper script',
    MARK,
    `set "CLAUDE_CONFIG_DIR=${configDir}"`,
    `"${claudeExe}" --chrome-native-host`,
    ''
  ].join('\r\n');
}

/** La ruta del ejecutable, buscada en el `.bat` de la cuenta y, si no lo tiene,
 *  en el del pozo — que siempre existe. */
async function findClaudeExe(configDir: string, sharedRoot?: string): Promise<string | null> {
  for (const dir of [configDir, sharedRoot]) {
    if (!dir) continue;
    const bat = await readFile(hostScript(dir), 'utf8').catch(() => null);
    const exe = bat && parseClaudeExe(bat);
    if (exe) return exe;
  }
  return null;
}

/**
 * Deja el puente de esta cuenta apuntando a su propia carpeta.
 *
 * Devuelve `true` si tocó algo. `false` significa que no hacía falta o que no
 * se pudo: nunca escribe un `.bat` que no sepa armar.
 */
export async function ensureHostScript(configDir: string, sharedRoot?: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  const script = hostScript(configDir);
  const bat = await readFile(script, 'utf8').catch(() => null);

  if (bat === null) {
    // Todavía no existe. Se crea acá, ya con la cuenta puesta: Claude Code sólo
    // lo escribe cuando falta, así que el nuestro es el que va a quedar.
    const exe = await findClaudeExe(configDir, sharedRoot);
    if (!exe) return false;
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, buildScript(configDir, exe), 'utf8');
    return true;
  }

  const patched = patchScript(bat, configDir);
  if (patched === null) return false;

  // El respaldo se hace una sola vez, contra el original de Claude Code.
  // `EXCL` para que un segundo parche no pise la copia buena con la nuestra.
  await copyFile(script, `${script}.bak-claude-monitor`, constants.COPYFILE_EXCL).catch(() => {});
  await writeFile(script, patched, 'utf8');
  return true;
}

/**
 * Deja el puente de cada cuenta apuntando a su propia carpeta.
 *
 * Acá vivía además una copia del emparejamiento de la extensión entre cuentas.
 * Se sacó: identifica al NAVEGADOR, y desde que cada cuenta tiene el suyo,
 * copiarlo dejaba a la cuenta afirmando estar emparejada con un navegador que
 * no era el suyo — y el emparejamiento real nunca se hacía. Ver
 * `pruneStalePairing` en `chrome-launch.ts`.
 */
export async function ensureAll(profiles: Profile[], sharedRoot: string): Promise<void> {
  for (const profile of profiles) {
    await ensureHostScript(profile.configDir, sharedRoot).catch(() => {});
    await pruneStalePairing(profile.configDir, profile.id).catch(() => {});
  }
}
