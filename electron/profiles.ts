import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Entorno, Profile, ProfileWithStatus, Raiz } from '../shared/types';
import { ensureAll, ensureHostScript } from './chrome-host';
import { chromeStatus } from './chrome-launch';
import { isLoggedIn, sessionExpiry } from './credentials';
import { markAllOnboardingDone } from './onboarding';
import { syncAll, syncPlugins } from './plugins';
import { effectiveActiveId, visibleProfiles } from './profile-visibility';
import { avisoDeCupo } from './relevo';
import { shareAll, shareProjects, unlinkShared } from './shared-projects';
import { readUsage } from './usage';
import {
  WINDOWS,
  configDirUNC,
  distrosCorriendo,
  distrosInstaladas,
  esWsl,
  estadoDeRaiz,
  hayCliEn,
  homeDe,
  sePuedeLeer
} from './wsl';

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

/** Si la sesión vive, y hasta cuándo. `expiresAt` en `null` con
 *  `authenticated` en `true` es el caso suposición: hay token de renovación
 *  pero el archivo no dice cuándo vence. Ver `credentials.ts`. */
async function authState(configDir: string): Promise<{ authenticated: boolean; expiresAt: number | null }> {
  try {
    const parsed = JSON.parse(await readFile(join(configDir, '.credentials.json'), 'utf8'));
    return { authenticated: isLoggedIn(parsed), expiresAt: sessionExpiry(parsed) };
  } catch {
    return { authenticated: false, expiresAt: null };
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

/**
 * Las distros corriendo, y sólo si hay alguna cuenta que las necesite.
 *
 * Se pregunta UNA vez por llamada, no una por cuenta. Sin cuentas WSL no se
 * ejecuta `wsl.exe` en absoluto: el usuario que no tiene WSL no paga nada por
 * esta compuerta.
 */
async function distrosVivas(profiles: Profile[]): Promise<string[]> {
  return profiles.some((p) => esWsl(p.entorno)) ? distrosCorriendo() : [];
}

/**
 * Lo que se puede afirmar de una cuenta a la que NO se le puede mirar el disco.
 *
 * Son exactamente los valores que devuelven hoy `exists`, `authState`,
 * `chromeStatus` y `readUsage` cuando no hay nada que leer, para que la interfaz
 * no tenga que aprender un caso nuevo.
 */
function sinMirar(p: Profile): ProfileWithStatus {
  return {
    ...p,
    exists: false,
    authenticated: false,
    authExpiresAt: null,
    chrome: { profileExists: false, extension: false, loggedIn: false, verified: false, seenAt: 0 },
    usage: null
  };
}

export async function listProfiles(): Promise<{ activeProfileId: string; profiles: ProfileWithStatus[] }> {
  const registry = await loadRegistry();
  const visibles = visibleProfiles(registry.profiles);
  // La compuerta NO es una optimización: `exists`, `authState`, `chromeStatus` y
  // `readUsage` leen el `configDir`, y el de una cuenta WSL es una UNC — tocarla
  // ENCIENDE la distro apagada del usuario (1,90 s, 345 MB de vmmemWSL). Esto
  // corre en cada refresco del panel, así que sin compuerta la VM quedaría
  // prendida para siempre por culpa del monitor.
  const corriendo = await distrosVivas(visibles);
  const profiles = await Promise.all(
    visibles.map(async (p) => {
      if (!sePuedeLeer(p.entorno, corriendo)) return sinMirar(p);
      const auth = await authState(p.configDir);
      return {
        ...p,
        exists: await exists(p.configDir),
        authenticated: auth.authenticated,
        authExpiresAt: auth.expiresAt,
        chrome: await chromeStatus(p.id, p.name),
        usage: await readUsage(p.configDir)
      };
    })
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
/**
 * La cuenta con la que abrir, que es SIEMPRE la activa, más el aviso de cupo si
 * esa cuenta ya no da.
 *
 * No elige por el usuario a propósito. Cambiar de cuenta sola movería el gasto
 * a otra sin que nadie lo pidiera, y cuál usar es una decisión suya. El aviso
 * dice cuál tiene cupo; cambiarla es un clic en el panel. Ver `relevo.ts`.
 */
export async function profileForWork(): Promise<{ profile: Profile; relevo: string | null }> {
  const registry = await loadRegistry();
  const activeId = effectiveActiveId(registry.profiles, registry.activeProfileId);
  const visibles = visibleProfiles(registry.profiles);
  // Misma compuerta que en `listProfiles`, y por el mismo motivo: `authState` y
  // `readUsage` leen el `configDir`, que en una cuenta WSL es una UNC, y tocarla
  // enciende la distro. Averiguar si a una cuenta le queda cupo no puede costar
  // prenderle la VM al usuario.
  const corriendo = await distrosVivas(visibles);
  const candidatos = await Promise.all(
    visibles.map(async (p) =>
      sePuedeLeer(p.entorno, corriendo)
        ? {
            id: p.id,
            name: p.name,
            authenticated: (await authState(p.configDir)).authenticated,
            usage: await readUsage(p.configDir)
          }
        : { id: p.id, name: p.name, authenticated: false, usage: null }
    )
  );
  const profile = registry.profiles.find((p) => p.id === activeId) ?? registry.profiles[0];
  return { profile, relevo: avisoDeCupo(candidatos, activeId) };
}

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

/** Marca todas las cuentas como ya presentadas. Arregla las creadas antes de
 *  este cambio, que arrancaban pidiendo elegir método de ingreso. */
export async function markOnboardingAll(): Promise<void> {
  const registry = await loadRegistry();
  // El guard de WSL vive en markAllOnboardingDone, junto al resto de la
  // lógica de onboarding, no acá.
  await markAllOnboardingDone(registry.profiles, await getSharedRoot());
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

/**
 * Todas las raíces que hay que leer: el pozo de Windows más una por cada
 * cuenta WSL.
 *
 * La compuerta es `wsl -l -q --running` y NO es una optimización: tocar la UNC
 * de una distro apagada la enciende (medido: True en 1,90 s, la distro queda
 * Running, 345 MB de vmmemWSL). Como el panel refresca la lista, sondear a
 * ciegas dejaría la VM prendida para siempre — el monitor sería la causa del
 * problema de memoria que ayuda a observar.
 */
export async function raices(): Promise<Raiz[]> {
  const registry = await loadRegistry();
  const salida: Raiz[] = [
    { configDir: await getSharedRoot(), entorno: WINDOWS, estado: { tipo: 'ok' } }
  ];

  const wsl = registry.profiles.filter(
    (p): p is Profile & { entorno: Extract<Entorno, { tipo: 'wsl' }> } => p.entorno?.tipo === 'wsl'
  );
  if (wsl.length === 0) return salida;

  const [instaladas, corriendo] = await Promise.all([distrosInstaladas(), distrosCorriendo()]);

  for (const p of wsl) {
    const { distro } = p.entorno;
    // Sólo se mira el disco si la distro YA está corriendo. Si no, ni se toca.
    const arranca = corriendo.includes(distro) && instaladas.includes(distro);
    const hayConfig = arranca ? Boolean(await stat(p.configDir).catch(() => null)) : false;
    const hayCli = arranca ? await hayCliEn(distro) : false;
    salida.push({
      configDir: p.configDir,
      entorno: p.entorno,
      estado: estadoDeRaiz({ distro, corriendo, instaladas, hayConfig, hayCli })
    });
  }
  return salida;
}

/** Da de alta una cuenta que vive en una distro. El `configDir` es ADOPTADO:
 *  no se crea nada en disco, y por eso `sePuedeBorrarDelDisco` lo protege. */
export async function createWslProfile(name: string, distro: string): Promise<Profile> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('El nombre de la cuenta no puede estar vacío');
  if (!(await distrosInstaladas()).includes(distro)) {
    throw new Error(`La distro ${distro} no está instalada`);
  }
  if (!(await hayCliEn(distro))) {
    throw new Error(`En ${distro} no hay \`claude\` instalado. Instalalo ahí y volvé a intentar.`);
  }
  const home = await homeDe(distro);
  const registry = await loadRegistry();
  const id = randomUUID().slice(0, 8);
  const profile: Profile = {
    id,
    name: trimmed,
    configDir: configDirUNC(distro, home),
    isDefault: false,
    entorno: { tipo: 'wsl', distro, home }
  };
  // Ni mkdir, ni shareProjects, ni syncPlugins, ni ensureHostScript: la carpeta
  // ya existe y es del usuario, el pozo no la admite, y Chrome es de Windows.
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

/**
 * Si es legítimo hacer `rm -rf` de este `configDir`.
 *
 * La regla es de propiedad, no de contenido: la app sólo borra del disco lo que
 * ella misma creó, que es todo lo que cuelga de `profilesRoot()`
 * (ver `createProfile`, que arma el configDir con `join(profilesRoot(), id)`).
 *
 * Cualquier otra cosa es una carpeta ADOPTADA y se da de baja del registro sin
 * tocar el disco. Los dos casos que esto protege:
 *
 *   - El `~/.claude` real del usuario, que el guard viejo cubría por `isDefault`
 *     — un campo que sale de un archivo editable.
 *   - El `configDir` de una cuenta WSL, que apunta a la instalación real de
 *     Claude Code adentro de la distro: credenciales, historial y ajustes de
 *     esa persona. El borrado por UNC funciona, así que sin este guard el
 *     "eliminar cuenta" del panel se la llevaba puesta.
 */
export function sePuedeBorrarDelDisco(configDir: string, raizDePerfiles: string): boolean {
  const rel = relative(raizDePerfiles, configDir);
  // Vacío = es la raíz misma. '..' al principio = está afuera. Absoluto = otro
  // volumen o una UNC, que nunca cuelga de la raíz.
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
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
  // Antes esto era un `rm` incondicional. Ver `sePuedeBorrarDelDisco`.
  if (sePuedeBorrarDelDisco(profile.configDir, profilesRoot())) {
    await unlinkShared(profile.configDir);
    await rm(profile.configDir, { recursive: true, force: true });
  }
  registry.profiles = registry.profiles.filter((p) => p.id !== id);
  if (registry.activeProfileId === id) registry.activeProfileId = 'default';
  await saveRegistry(registry);
}
