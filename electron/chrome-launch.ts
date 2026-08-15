import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Un Chrome por cuenta, para que la extensión funcione con cualquiera.
 *
 * La extensión de Claude no se autentica con el token del CLI: usa la sesión
 * web de claude.ai que hay en Chrome, y exige que sea la MISMA cuenta con la
 * que corre Claude Code. Esa sesión es una cookie del navegador, y Chrome
 * guarda una sola por perfil — logueando la segunda cuenta se pisa la primera.
 *
 * Rotar esa cookie desde la app sería descifrar y reinyectar credenciales de
 * sesión: no se hace. Lo que sí existe es la separación que Chrome ya trae —
 * un perfil por cuenta, cada uno con su propio store de cookies. Acá se lanza
 * Chrome con el perfil de la cuenta elegida; el login a claude.ai lo hace el
 * usuario, una vez, y de ahí en más lo recuerda Chrome.
 *
 * Sigue siendo una cuenta a la vez: el registro de native messaging y el pipe
 * del puente son únicos por usuario de Windows.
 */

/** Dónde buscar `chrome.exe` cuando el registro no lo dice. */
function fallbackPaths(): string[] {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return [programFiles, programFilesX86, localAppData].map((base) =>
    join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')
  );
}

/** Saca la ruta del ejecutable de la salida de `reg query`. La clave
 *  `App Paths\chrome.exe` es la que Windows usa para resolver "chrome" y la
 *  escribe el propio instalador, así que aguanta instalaciones fuera de lugar. */
export function parseRegistryPath(output: string): string | null {
  // El nombre del valor por defecto está traducido —"(Predeterminado)" acá,
  // "(Default)" en inglés— así que se busca por el tipo, que no cambia.
  const match = output.match(/REG_SZ\s+(.+?\.exe)/i);
  return match ? match[1].trim() : null;
}

export async function findChrome(): Promise<string | null> {
  const key = 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe';
  for (const root of ['HKCU', 'HKLM']) {
    const output = await run('reg', ['query', `${root}\\${key}`, '/ve'])
      .then((r) => r.stdout)
      .catch(() => '');
    const path = output && parseRegistryPath(output);
    if (path && (await stat(path).catch(() => null))) return path;
  }
  for (const path of fallbackPaths()) {
    if (await stat(path).catch(() => null)) return path;
  }
  return null;
}

/**
 * El nombre de la carpeta del perfil de Chrome de una cuenta.
 *
 * Va derivado del id y no del nombre que puso el usuario: el nombre se puede
 * repetir o cambiar, y renombrar la carpeta le haría perder a Chrome las
 * cookies —que es justo lo único que este perfil existe para guardar—. Sólo
 * letras, números y guiones, que es lo que un nombre de carpeta aguanta.
 */
export function chromeProfileName(profileId: string): string {
  return `Claude-${profileId.replace(/[^A-Za-z0-9-]/g, '')}`;
}

/** La carpeta de datos de Chrome del usuario, donde viven los perfiles. */
export function chromeUserData(): string {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'Google', 'Chrome', 'User Data');
}

/** El id de la extensión de Claude. Sale del `allowed_origins` del manifiesto
 *  del native host que instala Claude Code. */
export const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

const STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
const CLAUDE_URL = 'https://claude.ai';

/**
 * Qué abrir para esta cuenta, según lo que le falte.
 *
 * Una sola pestaña por vez, y en orden: primero la sesión de claude.ai, después
 * la extensión. Abrir las dos juntas dejaba tres pestañas encimadas y no se
 * entendía cuál atender primero — y encima la extensión no sirve de nada hasta
 * que la sesión exista.
 */
export function nextStepUrl(status: ChromeStatus): string {
  if (!status.loggedIn) return CLAUDE_URL;
  if (!status.extension) return STORE_URL;
  return CLAUDE_URL;
}

/** Si un archivo de preferencias de Chrome declara la extensión instalada. */
export function declaresExtension(prefs: string, id = EXTENSION_ID): boolean {
  try {
    const settings = (JSON.parse(prefs) as { extensions?: { settings?: Record<string, unknown> } })?.extensions
      ?.settings;
    return Boolean(settings && settings[id]);
  } catch {
    return false;
  }
}

/**
 * Si el perfil tiene instalada la extensión de Claude.
 *
 * Las extensiones son por perfil: un perfil nuevo nace sin ninguna, aunque el
 * perfil `Default` las tenga todas. Sin la extensión, la sesión del CLI dice
 * "browser extension is not connected" por más que claude.ai esté logueado —
 * que es exactamente lo que pasaba.
 *
 * Chrome reparte esto entre `Preferences` y `Secure Preferences` según la
 * versión y cómo se instaló, así que se miran los dos.
 */
export async function hasExtension(profileName: string): Promise<boolean> {
  for (const file of ['Preferences', 'Secure Preferences']) {
    const raw = await readFile(join(chromeUserData(), profileName, file), 'utf8').catch(() => null);
    if (raw && declaresExtension(raw)) return true;
  }
  return false;
}

/**
 * Si el perfil tiene iniciada la sesión de claude.ai.
 *
 * Se busca el NOMBRE de la cookie `sessionKey` pegado a su dominio, que es como
 * quedan contiguos en el registro de SQLite. No se lee ningún valor: los de las
 * cookies están cifrados y no hacen falta — alcanza con saber si existe.
 *
 * Es una heurística sobre el archivo crudo, no una consulta SQL: traer un motor
 * de base de datos para responder "sí o no" no se justifica. Si algún día el
 * formato cambia, esto dice "no logueado" y a lo sumo se muestra un aviso de
 * más; nunca al revés.
 */
export function hasSessionCookie(cookies: Buffer): boolean {
  return cookies.includes('claude.aisessionKey');
}

/** Lo que le falta —o no— al Chrome de una cuenta. */
export type ChromeStatus = { profileExists: boolean; extension: boolean; loggedIn: boolean };

export async function chromeStatus(profileId: string): Promise<ChromeStatus> {
  const name = chromeProfileName(profileId);
  const dir = join(chromeUserData(), name);
  const profileExists = Boolean(await stat(dir).catch(() => null));
  if (!profileExists) return { profileExists: false, extension: false, loggedIn: false };

  return { profileExists, extension: await hasExtension(name), loggedIn: await readSession(dir) };
}

/**
 * Lee el archivo de cookies del perfil y dice si está la sesión.
 *
 * El nombre del temporal lleva un identificador único, y no es adorno: la lista
 * de cuentas se refresca sola al volver el foco, así que puede haber dos
 * lecturas en vuelo a la vez —incluso desde procesos distintos—. Con un nombre
 * fijo, una borraba la copia mientras la otra la leía y la cuenta aparecía
 * deslogueada sin estarlo. Ese era el "ya había iniciado sesión y me dice que
 * no".
 *
 * Si la copia falla se intenta leer el original: Chrome tiene el archivo
 * tomado, pero permite leerlo.
 */
async function readSession(dir: string): Promise<boolean> {
  const origen = join(dir, 'Network', 'Cookies');
  const copia = join(tmpdir(), `cm-cookies-${randomUUID()}`);
  try {
    await copyFile(origen, copia);
    return hasSessionCookie(await readFile(copia));
  } catch {
    return await readFile(origen)
      .then(hasSessionCookie)
      .catch(() => false);
  } finally {
    await rm(copia, { force: true }).catch(() => {});
  }
}

/** Cómo se va a ver el perfil en el selector de Chrome. Con prefijo para que se
 *  agrupen y se distingan de los perfiles que el usuario haya hecho a mano. */
export function displayName(accountName: string): string {
  return `Claude · ${accountName}`.replace(/\s+/g, ' ').trim();
}

/** El `Preferences` del perfil con el nombre puesto, o `null` si ya estaba así.
 *  Se conserva todo el resto: ahí vive la configuración entera del perfil. */
export function withProfileName(prefs: string, name: string): string | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(prefs) as Record<string, unknown>;
  } catch {
    return null; // preferencias ilegibles: no se reescriben
  }
  const profile = (typeof o.profile === 'object' && o.profile !== null ? o.profile : {}) as Record<string, unknown>;
  if (profile.name === name) return null;
  return JSON.stringify({ ...o, profile: { ...profile, name } });
}

/**
 * El `Local State` con el nombre del perfil actualizado.
 *
 * Es el archivo que alimenta el selector de perfiles de Chrome. Sólo se toca la
 * entrada que ya existe: dar de alta un perfil en esa lista es cosa de Chrome, y
 * inventar una entrada rompería el selector.
 */
export function withInfoCacheName(localState: string, dir: string, name: string): string | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(localState) as Record<string, unknown>;
  } catch {
    return null;
  }
  const profile = o.profile as { info_cache?: Record<string, Record<string, unknown>> } | undefined;
  const entry = profile?.info_cache?.[dir];
  if (!entry || entry.name === name) return null;
  entry.name = name;
  return JSON.stringify(o);
}

/** Si hay algún Chrome corriendo. Con Chrome abierto no se le pueden reescribir
 *  las preferencias: las tiene en memoria y las vuelca al cerrar, pisando lo que
 *  hayamos puesto. */
async function chromeRunning(): Promise<boolean> {
  const stdout = await run('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'])
    .then((r) => r.stdout)
    .catch(() => '');
  return /chrome\.exe/i.test(stdout);
}

/**
 * Le pone a un perfil de Chrome el nombre de la cuenta.
 *
 * Sin esto los perfiles salen como "Persona 1", "Persona 2"… y no hay forma de
 * saber cuál es cuál desde el navegador.
 *
 * Devuelve `true` si quedó aplicado. Si el perfil ya existe y Chrome está
 * abierto no se toca nada: hay que esperar a que se cierre. Un perfil que
 * todavía no existe sí se puede nombrar de entrada, sembrando su `Preferences`
 * antes de que Chrome lo cree — que es el caso de una cuenta recién agregada.
 */
export async function setProfileDisplayName(profileName: string, name: string): Promise<boolean> {
  const dir = join(chromeUserData(), profileName);
  const prefsPath = join(dir, 'Preferences');
  const prefs = await readFile(prefsPath, 'utf8').catch(() => null);

  if (prefs === null) {
    await mkdir(dir, { recursive: true });
    await writeFile(prefsPath, JSON.stringify({ profile: { name } }), 'utf8');
    return true;
  }

  if (await chromeRunning()) return false;

  const patched = withProfileName(prefs, name);
  if (patched) await writeFile(prefsPath, patched, 'utf8');

  const statePath = join(chromeUserData(), 'Local State');
  const state = await readFile(statePath, 'utf8').catch(() => null);
  const patchedState = state && withInfoCacheName(state, profileName, name);
  if (patchedState) await writeFile(statePath, patchedState, 'utf8');

  return true;
}

/**
 * Abre Chrome con el perfil de esta cuenta, en claude.ai.
 *
 * Siempre abre claude.ai, no sólo la primera vez. La versión anterior decidía
 * eso mirando si existía la carpeta del perfil, y estaba mal: Chrome la crea al
 * arrancar, se haya iniciado sesión o no. Alcanzaba con abrir y cerrar sin
 * loguearse para que la app diera el perfil por listo y no volviera a llevar a
 * claude.ai — quedando en un estado del que no se salía.
 *
 * Abrir claude.ai siempre no tiene ese problema y encima se verifica solo: si
 * la sesión está iniciada, carga y de paso muestra con qué cuenta; si no, pide
 * el login, que es justo lo que falta.
 *
 * Abre UNA pestaña: la que corresponda según lo que le falte a la cuenta, o la
 * que pida el llamador (la autorización del login). Nunca varias — ver
 * `nextStepUrl`.
 *
 * `firstRun` sólo sirve para el aviso de la interfaz. Que la carpeta sea nueva
 * no prueba nada sobre la sesión, así que no decide comportamiento.
 */
export async function openChromeForProfile(
  profileId: string,
  accountName: string,
  url?: string
): Promise<{ firstRun: boolean; needsExtension: boolean; pendingRename: boolean }> {
  const chrome = await findChrome();
  if (!chrome) {
    throw new Error('No se encontró chrome.exe. ¿Está instalado Google Chrome?');
  }

  const name = chromeProfileName(profileId);
  const firstRun = !(await stat(join(chromeUserData(), name)).catch(() => null));
  const status = await chromeStatus(profileId);
  // Antes de abrirlo, para que Chrome lo lea al arrancar el perfil.
  const pendingRename = !(await setProfileDisplayName(name, displayName(accountName)).catch(() => false));

  const args = [`--profile-directory=${name}`, url ?? nextStepUrl(status)];
  const needsExtension = !status.extension;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });

  return { firstRun, needsExtension, pendingRename };
}
