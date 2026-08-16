import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Marca la cuenta como ya presentada, para que el CLI no corra el arranque de
 * primera vez.
 *
 * Una carpeta de configuración nueva no tiene `hasCompletedOnboarding`, y sin
 * esa marca Claude Code arranca preguntando qué tipo de acceso se quiere usar
 * —suscripción o consola— aunque las credenciales ya estén guardadas. En el
 * binario está explícito: trata `hasCompletedOnboarding !== true` como estado
 * pendiente de presentación.
 *
 * Eso desconcertaba con razón: la app terminaba el login, escribía el token, y
 * la terminal igual pedía elegir método de ingreso. Peor: elegir ahí lanza otro
 * login que abre el navegador por defecto, y la sesión de claude.ai termina en
 * el Chrome equivocado — justo lo que la app viene evitando.
 *
 * Sólo se marca la presentación. El historial de uso de otra cuenta —cuántas
 * veces arrancó, qué avisos vio— no se copia: no es de esta cuenta y fingirlo
 * no arregla nada.
 */

/** La versión de presentación que ya vio el usuario. Si no se sabe, alcanza con
 *  la marca: lo que decide el arranque de primera vez es el booleano. */
export const ONBOARDING_KEYS = ['hasCompletedOnboarding', 'lastOnboardingVersion'] as const;

/**
 * El `.claude.json` de la cuenta con la marca puesta, o `null` si ya la tenía.
 *
 * Conserva todo lo demás: ese archivo tiene decenas de claves de la cuenta, y
 * el CLI lo reescribe por su cuenta.
 */
export function withOnboardingDone(raw: string, version = ''): string | null {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // ilegible: no se reescribe, se rearma solo
  }
  if (config.hasCompletedOnboarding === true) return null;

  const salida: Record<string, unknown> = { ...config, hasCompletedOnboarding: true };
  if (version && !salida.lastOnboardingVersion) salida.lastOnboardingVersion = version;
  return `${JSON.stringify(salida, null, 2)}\n`;
}

/** De dónde sale la versión de presentación: la que ya tiene el pozo. */
export function readOnboardingVersion(poolRaw: string): string {
  try {
    const v = (JSON.parse(poolRaw) as Record<string, unknown>).lastOnboardingVersion;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * Deja la cuenta lista para arrancar sin preguntas.
 *
 * `sharedRoot` sólo aporta la versión de presentación. Su `.claude.json` puede
 * estar al lado de la carpeta o adentro, según cómo se haya instalado el CLI;
 * se prueban las dos, igual que en `chrome-host.ts`.
 */
export async function markOnboardingDone(configDir: string, sharedRoot?: string): Promise<boolean> {
  const path = join(configDir, '.claude.json');
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return false; // todavía no existe: se marca después del primer arranque

  let version = '';
  for (const candidato of sharedRoot ? [`${sharedRoot}.json`, join(sharedRoot, '.claude.json')] : []) {
    const poolRaw = await readFile(candidato, 'utf8').catch(() => null);
    if (poolRaw) {
      version = readOnboardingVersion(poolRaw);
      if (version) break;
    }
  }

  const patched = withOnboardingDone(raw, version);
  if (patched === null) return false;
  await writeFile(path, patched, 'utf8');
  return true;
}
