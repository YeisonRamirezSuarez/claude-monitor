import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Profile, ProfileWithStatus } from '../shared/types';

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
    const expiresAt = JSON.parse(raw)?.claudeAiOauth?.expiresAt;
    return typeof expiresAt === 'number' && expiresAt > Date.now();
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
    registry.profiles.map(async (p) => ({
      ...p,
      exists: await exists(p.configDir),
      authenticated: await isAuthenticated(p.configDir)
    }))
  );
  return { activeProfileId: registry.activeProfileId, profiles };
}

export async function getActiveProfile(): Promise<Profile> {
  const registry = await loadRegistry();
  return registry.profiles.find((p) => p.id === registry.activeProfileId) ?? registry.profiles[0];
}

export async function createProfile(name: string): Promise<Profile> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('El nombre de la cuenta no puede estar vacío');

  const registry = await loadRegistry();
  const id = randomUUID().slice(0, 8);
  const profile: Profile = { id, name: trimmed, configDir: join(profilesRoot(), id), isDefault: false };
  await mkdir(profile.configDir, { recursive: true });
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

  await rm(profile.configDir, { recursive: true, force: true });
  registry.profiles = registry.profiles.filter((p) => p.id !== id);
  if (registry.activeProfileId === id) registry.activeProfileId = 'default';
  await saveRegistry(registry);
}
