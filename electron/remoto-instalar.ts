/**
 * El hook del puente de Telegram en `settings.json`. Va en el del pozo (la
 * cuenta principal) y de ahí lo reparte `syncAllPlugins`: `syncPlugins` pisa la
 * clave `hooks` de cada cuenta con la del pozo (`PLUGIN_KEYS` en plugins.ts), así
 * que instalarlo cuenta por cuenta no duraría. Las entradas propias se
 * reconocen por el nombre del script; las demás no se tocan.
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getSharedRoot, syncAllPlugins } from './profiles';

export const EVENTOS: Array<[string, string]> = [
  ['PermissionRequest', '*'],
  ['PreToolUse', 'AskUserQuestion'],
  ['Stop', '*'],
  ['PostToolUse', '*'],
  ['SessionStart', '*'],
  ['PreCompact', '*'],
  ['PostCompact', '*']
];

type Entrada = { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> };
type Settings = { hooks?: Record<string, Entrada[]> } & Record<string, unknown>;

const esNuestra = (e: Entrada) => (e.hooks ?? []).some((h) => (h.command ?? '').includes('remoto-hook.js'));

// Stripea BOM UTF-8 si está presente
function stripBOM(raw: string): string {
  return raw.startsWith('\ufeff') ? raw.slice(1) : raw;
}

function leer(raw: string): Settings | null {
  try {
    const s = JSON.parse(stripBOM(raw)) as Settings;
    if (typeof s !== 'object' || s === null) return null;
    // Validar que hooks sea un objeto plano si existe
    if (s.hooks !== undefined) {
      if (typeof s.hooks !== 'object' || Array.isArray(s.hooks)) return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function sinHook(raw: string): string | null {
  const s = leer(raw);
  if (!s) return null;
  const hooks = s.hooks ?? {};
  let cambio = false;

  for (const ev of Object.keys(hooks)) {
    // Validar que hooks[ev] sea un array
    if (!Array.isArray(hooks[ev])) continue;

    const nuevas = [];
    for (const entrada of hooks[ev] || []) {
      // Guardar contra null o no-objeto
      if (!entrada || typeof entrada !== 'object') continue;

      // Validar que entrada.hooks sea un array
      if (!Array.isArray(entrada.hooks)) {
        nuevas.push(entrada);
        continue;
      }

      // Filtrar solo nuestros comandos de DENTRO del grupo
      const hooksSinNuestro = entrada.hooks.filter((h) => {
        // Guardar contra null o no-objeto en hooks internos
        if (!h || typeof h !== 'object') return true;
        return !(h.command ?? '').includes('remoto-hook.js');
      });

      // Detectar cambio: si se removieron hooks
      if (hooksSinNuestro.length !== entrada.hooks.length) {
        cambio = true;
      }

      // Mantener la entrada si quedan hooks
      if (hooksSinNuestro.length > 0) {
        nuevas.push({ ...entrada, hooks: hooksSinNuestro });
      }
    }

    // Actualizar o remover el event key
    if (nuevas.length > 0) {
      if (nuevas.length !== (hooks[ev] || []).length) {
        cambio = true;
      }
      hooks[ev] = nuevas;
    } else if ((hooks[ev] || []).length > 0) {
      cambio = true;
      delete hooks[ev];
    }
  }

  if (!cambio) return null;
  s.hooks = hooks;
  return `${JSON.stringify(s, null, 2)}\n`;
}

export function conHook(raw: string, comando: string): string | null {
  const s = leer(raw);
  if (!s) return null;

  // Validar que cada evento sea un array si existe
  const hooks = s.hooks ?? {};
  for (const [ev] of EVENTOS) {
    if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) {
      throw new Error('No pude leer settings.json de la cuenta principal: no lo toco.');
    }
  }

  const limpio = leer(sinHook(raw) ?? raw)!;
  const newHooks = limpio.hooks ?? {};
  for (const [ev, matcher] of EVENTOS) {
    // Validar que newHooks[ev] sea un array antes de operaciones
    if (!Array.isArray(newHooks[ev])) newHooks[ev] = [];
    newHooks[ev] = [...(newHooks[ev] ?? []), { matcher, hooks: [{ type: 'command', command: comando, timeout: 86400 }] }];
  }
  limpio.hooks = newHooks;
  const salida = `${JSON.stringify(limpio, null, 2)}\n`;
  return JSON.stringify(leer(salida)) === JSON.stringify(s) ? null : salida;
}

async function editarPozo(
  cambiar: (raw: string) => string | null,
  getRoot?: () => Promise<string>,
  sync?: () => Promise<void>,
  readFn?: typeof readFile
): Promise<void> {
  const root = getRoot ? await getRoot() : await getSharedRoot();
  const archivo = join(root, 'settings.json');

  let raw: string;
  try {
    raw = await (readFn || readFile)(archivo, 'utf8');
  } catch (err: any) {
    // Solo ENOENT crea archivo nuevo; otros errores se propagan
    if (err.code === 'ENOENT') {
      raw = '{}';
    } else {
      // Propagar otros errores de lectura (EACCES, EBUSY, EPERM, etc)
      throw err;
    }
  }

  // Validar que el contenido sea parseable
  if (leer(raw) === null && raw !== '{}') {
    throw new Error('No pude leer settings.json de la cuenta principal: no lo toco.');
  }

  let nuevo: string | null;
  try {
    nuevo = cambiar(raw);
  } catch (err) {
    // Los errores de cambiar (como de conHook) se propagan
    throw err;
  }

  if (nuevo !== null) {
    // Escritura atómica: escribe a .tmp, luego renombra
    const tmp = `${archivo}.tmp`;
    await mkdir(dirname(tmp), { recursive: true });
    await writeFile(tmp, nuevo, 'utf8');
    await rename(tmp, archivo);
  }

  const syncFn = sync || syncAllPlugins;
  await syncFn();
}

/**
 * El hook se instala como `node "…"`: sin Node en el PATH, Claude Code lo corre en cada evento y falla
 * callado, y el puente parece prendido sin recibir nada. Con shell, igual que lo lanza Claude Code.
 */
export function hayNode(comando = 'node'): Promise<boolean> {
  return new Promise((ok) => {
    const h = spawn(comando, ['--version'], { shell: true, windowsHide: true, stdio: 'ignore' });
    h.on('error', () => ok(false));
    h.on('exit', (c) => ok(c === 0));
  });
}

export async function instalarHook(
  fuente: string,
  destino: string,
  getRoot?: () => Promise<string>,
  sync?: () => Promise<void>,
  readFn?: typeof readFile
): Promise<void> {
  await mkdir(dirname(destino), { recursive: true });
  await copyFile(fuente, destino);
  await editarPozo(
    (raw) => conHook(raw, `node "${destino.split('\\').join('/')}"`),
    getRoot,
    sync,
    readFn
  );
}

export async function sacarHook(
  getRoot?: () => Promise<string>,
  sync?: () => Promise<void>
): Promise<void> {
  await editarPozo(sinHook, getRoot, sync);
}
