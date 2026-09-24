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
  configDirDeCuenta,
  configDirUNC,
  distrosCorriendo,
  distrosInstaladas,
  esWsl,
  estadoDeRaiz,
  hayCliEn,
  homeDe,
  posixAWindows,
  prepararCuentaEnDistro,
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
 * Son exactamente los valores que devuelven hoy `exists`, `authState` y
 * `readUsage` cuando no hay nada que leer, para que la interfaz no tenga que
 * aprender un caso nuevo. `chrome` no está acá a propósito: lo pone el llamador
 * con la lectura de verdad. Ver el comentario en `listProfiles`.
 */
function sinMirar(p: Profile): Omit<ProfileWithStatus, 'chrome'> {
  return { ...p, exists: false, authenticated: false, authExpiresAt: null, usage: null };
}

export async function listProfiles(): Promise<{ activeProfileId: string; profiles: ProfileWithStatus[] }> {
  const registry = await loadRegistry();
  const visibles = visibleProfiles(registry.profiles);
  // La compuerta NO es una optimización: `exists`, `authState` y `readUsage` leen
  // el `configDir`, y el de una cuenta WSL es una UNC — tocarla ENCIENDE la distro
  // apagada del usuario (1,90 s, 345 MB de vmmemWSL). Esto corre en cada refresco
  // del panel, así que sin compuerta la VM quedaría prendida para siempre por
  // culpa del monitor.
  const corriendo = await distrosVivas(visibles);
  const profiles = await Promise.all(
    visibles.map(async (p) => {
      // Chrome queda AFUERA de la compuerta: es de Windows, no vive en la distro
      // —`chromeStatus` sólo mira LOCALAPPDATA y el id, nunca el configDir—, y
      // apagarlo a mano le borraría a la cuenta lo último que se supo de su
      // navegador. Ver `merge` en browser-store.ts.
      const chrome = await chromeStatus(p.id, p.name);
      if (!sePuedeLeer(p.entorno, corriendo)) return { ...sinMirar(p), chrome };
      const auth = await authState(p.configDir);
      return {
        ...p,
        exists: await exists(p.configDir),
        authenticated: auth.authenticated,
        authExpiresAt: auth.expiresAt,
        chrome,
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

/**
 * Los perfiles tal cual están dados de alta, y cuál es la activa. Sin tocar
 * disco más allá del registro: nada de credenciales, uso, ni la UNC de una
 * distro.
 *
 * Existe para `cuentaParaSesion`: para elegir con qué cuenta reanudar una
 * sesión ya identificada alcanza con saber cuáles hay y cuál es cada una —no
 * hace falta el costo de `listProfiles`/`profileForWork` (login, cupo, Chrome)
 * para una decisión que no depende de nada de eso.
 */
export async function allProfiles(): Promise<{ profiles: Profile[]; activeProfileId: string }> {
  const registry = await loadRegistry();
  return {
    profiles: visibleProfiles(registry.profiles),
    activeProfileId: effectiveActiveId(registry.profiles, registry.activeProfileId)
  };
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
/**
 * Lo que respondió `hayCliEn` para cada distro, mientras esa distro siga arriba.
 *
 * Por qué se cachea: `hayCliEn` es un login shell adentro de la distro
 * (`bash -lc 'command -v claude'`) y con nvm en el `.bashrc` tarda de 0,5 a
 * 1,5 s. `raices()` corre en cada refresco del panel —o sea, en cada foco de
 * ventana—, así que sin caché el alt-tab paga ese segundo por cuenta WSL.
 *
 * Por qué es SEGURO cachearlo, que es lo que no se ve solo: la respuesta sólo
 * cambia si alguien instala o desinstala `claude` adentro de la distro, y la
 * entrada se descarta en cuanto esa distro deja de aparecer en
 * `wsl -l -q --running`. Instalar el CLI implica una sesión adentro de la
 * distro, pero puede hacerse sin apagarla; el peor caso es entonces que el
 * panel siga diciendo `sin-cli` hasta que la distro se apague (WSL lo hace solo
 * por inactividad) o hasta el próximo arranque del panel. Es un estado que se
 * recupera solo, no un dato que se pierda.
 *
 * La caché puede quedar vieja en las dos direcciones, no en una sola: si
 * alguien DESinstala `claude` sin apagar la distro, sigue diciendo que hay CLI
 * hasta el próximo apagado. Eso no habilita nada peligroso porque este dato
 * alimenta un cartel informativo (`sin-cli`) y ninguna compuerta: reanudar y
 * crear no lo consultan, y si el CLI no está, el que falla y lo dice es el
 * `claude` de adentro de la distro.
 *
 * El alta de una cuenta (`createWslProfile`) NO pasa por acá a propósito: ahí
 * el usuario acaba de instalar el CLI y espera que se lo vea al instante.
 */
const cliPorDistro = new Map<string, boolean>();

async function hayCliRecordado(distro: string, corriendo: string[]): Promise<boolean> {
  // Se olvida todo lo que ya no corre: al volver a arrancar, el PATH de login
  // puede ser otro.
  for (const conocida of [...cliPorDistro.keys()]) {
    if (!corriendo.includes(conocida)) cliPorDistro.delete(conocida);
  }
  const recordado = cliPorDistro.get(distro);
  if (recordado !== undefined) return recordado;
  const hay = await hayCliEn(distro);
  cliPorDistro.set(distro, hay);
  return hay;
}

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

  // UNA raíz por DISTRO, no una por cuenta, y es el POZO de la distro
  // (`~/.claude`), no el `configDir` de cada cuenta. Dos motivos, los dos
  // medidos:
  //
  //   - Las cuentas de una distro comparten `projects/` por un symlink de
  //     Linux, igual que las de Windows lo comparten por un junction. Una raíz
  //     por cuenta listaría las MISMAS sesiones N veces.
  //   - Y ni siquiera las vería: Windows no atraviesa ese symlink por la UNC
  //     (`Get-ChildItem` devuelve el enlace, un nivel más adentro da "no
  //     existe"). El pozo, en cambio, es un directorio de verdad y se lee bien.
  const distros = [...new Set(wsl.map((p) => p.entorno.distro))];
  for (const distro of distros) {
    const { home } = wsl.find((p) => p.entorno.distro === distro)!.entorno;
    // Sólo se mira el disco si la distro YA está corriendo. Si no, ni se toca.
    const arranca = corriendo.includes(distro) && instaladas.includes(distro);
    const pozo = configDirUNC(distro, home);
    const hayConfig = arranca ? Boolean(await stat(pozo).catch(() => null)) : false;
    const hayCli = arranca ? await hayCliRecordado(distro, corriendo) : false;
    salida.push({
      configDir: pozo,
      entorno: { tipo: 'wsl', distro, home },
      estado: estadoDeRaiz({ distro, corriendo, instaladas, hayConfig, hayCli })
    });
  }
  return salida;
}

/**
 * Da de alta una cuenta que vive en una distro. Se pueden tener N por distro.
 *
 * Mismo modelo que en Windows y por el mismo motivo: cada cuenta es su propio
 * CLAUDE_CONFIG_DIR —su login, su consumo— y lo único compartido es
 * `projects/`. Acá el CLAUDE_CONFIG_DIR es `~/.claude-monitor/<id>` ADENTRO de
 * la distro, y su `projects` es un symlink de Linux al `projects` del pozo de
 * esa distro (`~/.claude/projects`), que es lo que ya usa `claude` cuando corre
 * a mano.
 *
 * Antes esto ADOPTABA el `~/.claude` de la distro entero, y entonces dos
 * cuentas eran la misma: mismo login, mismas credenciales, y cada sesión salía
 * DUPLICADA en la lista porque `raices()` armaba una raíz por cuenta. Ahora la
 * raíz es una por distro (el pozo), así que agregar cuentas no duplica nada.
 *
 * La carpeta se crea del lado de Linux (ver `prepararCuentaEnDistro`): un
 * junction de Windows no se puede crear en ext4.
 */
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
  await prepararCuentaEnDistro(distro, home, id);
  const profile: Profile = {
    id,
    name: trimmed,
    configDir: posixAWindows(distro, configDirDeCuenta(home, id)),
    isDefault: false,
    entorno: { tipo: 'wsl', distro, home }
  };
  // Ni shareProjects, ni syncPlugins, ni ensureHostScript: el enlace de
  // `projects` ya lo hizo `prepararCuentaEnDistro` del lado de Linux, el pozo
  // de Windows no admite una cuenta de la distro, y Chrome es de Windows.
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
 *   - El `configDir` de una cuenta WSL. Con `createWslProfile` esa carpeta hoy
 *     la crea la app (`~/.claude-monitor/<id>` adentro de la distro), así que
 *     por la regla de propiedad "se podría" borrar. NO SE HACE, y no es un
 *     descuido: adentro tiene un `projects` que es un symlink de Linux al pozo
 *     de la distro, y desde Windows ese enlace NO se ve como enlace —medido:
 *     `Get-ChildItem` devuelve la entrada y un nivel más adentro da "no
 *     existe"—. Si `lstat` por la UNC lo reporta como directorio, el `rm -rf`
 *     lo seguiría y se llevaría puesto el historial entero de esa persona.
 *     Dejar una carpeta huérfana es infinitamente más barato que eso. El
 *     guard de acá abajo ya lo cubre: una UNC nunca cuelga de `profilesRoot()`.
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
