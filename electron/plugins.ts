import { lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Profile } from '../shared/types';

/**
 * Hace que toda sesión arranque con los mismos plugins, sin importar la cuenta.
 *
 * Los plugins se enganchan en `<configDir>/settings.json` (`enabledPlugins` y
 * `extraKnownMarketplaces`) y se descargan en `<configDir>/plugins/`. Como cada
 * cuenta es un CLAUDE_CONFIG_DIR propio, una cuenta nueva arranca con un
 * `settings.json` casi vacío: caveman, ponytail y el resto simplemente no
 * existen ahí, y la sesión sale pelada.
 *
 * Acá se hacen las dos mitades. El `plugins/` de cada cuenta se apunta al del
 * pozo con un junction —son 27 MB de caché ya descargada, y clonar los
 * marketplaces de nuevo por cuenta es lento y depende de la red justo al abrir
 * una sesión— y las claves de `settings.json` que definen qué corre se copian
 * del pozo.
 *
 * Lo demás del `settings.json` de la cuenta no se toca: el tema, el modelo y
 * cualquier cosa que el usuario haya puesto ahí son de esa cuenta.
 */

/** Lo que define qué plugins corren y qué muestran. El pozo manda: si una clave
 *  no está en el pozo, se saca de la cuenta, así apagar un plugin en el pozo lo
 *  apaga en todos lados en vez de dejarlo colgado en una cuenta cualquiera. */
export const PLUGIN_KEYS = ['enabledPlugins', 'extraKnownMarketplaces', 'statusLine', 'hooks'] as const;

type Settings = Record<string, unknown>;

function parse(raw: string): Settings {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Settings) : {};
  } catch {
    return {};
  }
}

/**
 * El `settings.json` de la cuenta con la configuración de plugins del pozo.
 *
 * Devuelve el texto tal cual hay que escribirlo, o `null` si ya estaba igual —
 * para no reescribir el archivo en cada arranque.
 */
export function mergeSettings(poolRaw: string, ownRaw: string): string | null {
  const pool = parse(poolRaw);
  const own = parse(ownRaw);
  const merged: Settings = { ...own };

  for (const key of PLUGIN_KEYS) {
    if (key in pool) merged[key] = pool[key];
    else delete merged[key];
  }

  const text = `${JSON.stringify(merged, null, 2)}\n`;
  return text === ownRaw ? null : text;
}

/** Apunta el `plugins/` de la cuenta al del pozo. Lo que la cuenta tuviera
 *  propio no se borra: se aparta con fecha, igual que en `shared-projects.ts`. */
async function linkPlugins(configDir: string, sharedRoot: string): Promise<void> {
  const link = join(configDir, 'plugins');
  const target = join(sharedRoot, 'plugins');
  await mkdir(target, { recursive: true });

  const current = await lstat(link).catch(() => null);
  if (current?.isSymbolicLink()) return;

  if (current) {
    const vacio = (await readdir(link).catch(() => ['algo'])).length === 0;
    await rename(link, `${link}.reemplazado-${Date.now()}`).catch(() => {});
    if (!vacio && (await lstat(link).catch(() => null))) return; // no se pudo apartar: se deja como está
  }

  await symlink(target, link, 'junction');
}

/** Deja una cuenta con los plugins del pozo. */
export async function syncPlugins(configDir: string, sharedRoot: string): Promise<void> {
  if (configDir === sharedRoot) return; // la cuenta dueña del pozo

  await linkPlugins(configDir, sharedRoot);

  const poolRaw = await readFile(join(sharedRoot, 'settings.json'), 'utf8').catch(() => null);
  if (poolRaw === null) return; // sin pozo no hay nada que copiar

  const path = join(configDir, 'settings.json');
  const ownRaw = await readFile(path, 'utf8').catch(() => '{}');
  const merged = mergeSettings(poolRaw, ownRaw);
  if (merged !== null) await writeFile(path, merged, 'utf8');
}

export async function syncAll(profiles: Profile[], sharedRoot: string): Promise<void> {
  for (const profile of profiles) {
    await syncPlugins(profile.configDir, sharedRoot).catch(() => {});
  }
}
