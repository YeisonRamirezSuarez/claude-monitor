import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Profile, ProfileWithStatus } from '../shared/types';
import { ensureAll, ensureHostScript } from './chrome-host';
import { chromeStatus } from './chrome-launch';
import { isLoggedIn } from './credentials';
import { syncAll, syncPlugins } from './plugins';
import { effectiveActiveId, visibleProfiles } from './profile-visibility';
import { shareAll, shareProjects, unlinkShared } from './shared-projects';
import { readUsage } from './usage';

type Registry = { activeProfileId: string; profiles: Profile[] };

const registryPath = () => join(app.getPath('userData'), 'profiles.json');
const profilesRoot = () => join(app.getPath('userData'), 'profiles');

function defaultProfile(): Profile {
  return {
    id: 'default',
    name: 'Cuenta principal',
    configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    isDefault: true
  };
}

async function saveRegistry(registry: Registry): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(registryPath(), JSON.stringify(registry, null, 2), 'utf8');
}

async function loadRegistry(): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(), 'utf8')) as Registry;
    if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) return parsed;
  } catch {
    // no existe o está corrupto: se regenera
  }
  const fresh: Registry = { activeProfileId: 'default', profiles: [defaultProfile()] };
  await saveRegistry(fresh);
  return fresh;
}

async function isAuthenticated(configDir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(configDir, '.credentials.json'), 'utf8');
    return isLoggedIn(JSON.parse(raw));
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function listProfiles(): Promise<{ activeProfileId: string; profiles: ProfileWithStatus[] }> {
  const registry = await loadRegistry();
  const profiles = await Promise.all(
    visibleProfiles(registry.profiles).map(async (p) => ({
      ...p,
      exists: await exists(p.configDir),
      authenticated: await isAuthenticated(p.configDir),
      chrome: await chromeStatus(p.id),
      usage: await readUsage(p.configDir)
    }))
  );
  return { activeProfileId: effectiveActiveId(registry.profiles, registry.activeProfileId), profiles };
}

export async function getActiveProfile(): Promise<Profile> {
  const registry = await loadRegistry();
  const id = effectiveActiveId(registry.profiles, registry.activeProfileId);
  return registry.profiles.find((p) => p.id === id) ?? registry.profiles[0];
}

/** El pozo de sesiones vive en la cuenta principal: es el `~/.claude` real, el
 *  que ya tiene todo el historial y el que usa el CLI cuando se lo abre a mano. */
export async function getSharedRoot(): Promise<string> {
  const registry = await loadRegistry();
  return (registry.profiles.find((p) => p.id === 'default') ?? defaultProfile()).configDir;
}

/** Deja el `projects` de todas las cuentas apuntando al pozo. Se llama al
 *  arrancar para arreglar las cuentas creadas antes de este cambio. */
export async function shareAllProjects(): Promise<void> {
  const registry = await loadRegistry();
  await shareAll(registry.profiles, await getSharedRoot());
}

/** Deja a todas las cuentas con los plugins del pozo. Se llama al arrancar
 *  porque el pozo es lo que el usuario configura a mano: si habilita un plugin
 *  ahí, la próxima sesión de cualquier cuenta ya lo tiene. */
export async function syncAllPlugins(): Promise<void> {
  const registry = await loadRegistry();
  await syncAll(registry.profiles, await getSharedRoot());
}

/** Deja el puente de Chrome de cada cuenta apuntando a su propia carpeta, para
 *  que emparejar la extensión sea una vez por cuenta y no una por sesión. */
export async function ensureChromeHosts(): Promise<void> {
  const registry = await loadRegistry();
  await ensureAll(registry.profiles, await getSharedRoot());
}

export async function getProfile(id: string): Promise<Profile> {
  const registry = await loadRegistry();
  const profile = registry.profiles.find((p) => p.id === id);
  if (!profile) throw new Error(`Perfil desconocido: ${id}`);
  return profile;
}

export async function createProfile(name: string): Promise<Profile> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('El nombre de la cuenta no puede estar vacío');

  const registry = await loadRegistry();
  const id = randomUUID().slice(0, 8);
  const profile: Profile = { id, name: trimmed, configDir: join(profilesRoot(), id), isDefault: false };
  await mkdir(profile.configDir, { recursive: true });
  const sharedRoot = await getSharedRoot();
  await shareProjects(profile.configDir, sharedRoot);
  // Una cuenta recién creada tiene que nacer con los mismos plugins que el
  // resto: si no, su primera sesión sale pelada.
  await syncPlugins(profile.configDir, sharedRoot);
  // Y con su puente de Chrome ya apuntado, para no arrancar emparejando contra
  // la carpeta de otra cuenta.
  await ensureHostScript(profile.configDir, sharedRoot).catch(() => {});
  registry.profiles.push(profile);
  await saveRegistry(registry);
  return profile;
}

export async function setActiveProfile(id: string): Promise<void> {
  const registry = await loadRegistry();
  if (!registry.profiles.some((p) => p.id === id)) throw new Error(`Perfil desconocido: ${id}`);
  registry.activeProfileId = id;
  await saveRegistry(registry);
}

export async function deleteProfile(id: string): Promise<void> {
  const registry = await loadRegistry();
  const profile = registry.profiles.find((p) => p.id === id);
  if (!profile) throw new Error(`Perfil desconocido: ${id}`);
  // Dos condiciones, a propósito: `isDefault` sale de profiles.json, que es un
  // archivo editable, y lo que protege este guard es el ~/.claude real del
  // usuario. El id no depende del contenido del registro.
  if (profile.isDefault || profile.id === 'default') {
    throw new Error('La cuenta principal no se puede eliminar');
  }

  // Primero el junction, después la carpeta. Al revés, un `rm -rf` que siga el
  // enlace se lleva puesto el pozo entero.
  await unlinkShared(profile.configDir);
  await rm(profile.configDir, { recursive: true, force: true });
  registry.profiles = registry.profiles.filter((p) => p.id !== id);
  if (registry.activeProfileId === id) registry.activeProfileId = 'default';
  await saveRegistry(registry);
}
