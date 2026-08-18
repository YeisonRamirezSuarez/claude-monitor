import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { merge, readRecord, vale, writeRecord, type Observacion } from './browser-store';

const run = promisify(execFile);

/**
 * Un Chrome por cuenta, para que la extensión funcione con cualquiera.
 *
 * La extensión de Claude no se autentica con el token del CLI: usa la sesión
 * web de claude.ai que hay en Chrome, y exige que sea la MISMA cuenta con la
 * que corre Claude Code. Esa sesión es una cookie del navegador, y Chrome
 * guarda una sola por perfil.
 *
 * Rotar esa cookie desde la app sería descifrar y reinyectar credenciales de
 * sesión: no se hace. Se usa la separación que Chrome ya trae.
 *
 * Cada cuenta tiene su propio `--user-data-dir`, y no un perfil dentro del
 * Chrome del usuario. La razón es concreta: con Chrome ya abierto,
 * `--profile-directory` SE IGNORA — la instancia que está corriendo se queda
 * con la URL y la abre en el perfil que ya tenía. Medido: pidiendo
 * `Claude-204db0cb` con otra ventana abierta, el único proceso de navegador
 * seguía siendo el otro perfil, y con `--new-window` pasaba lo mismo. Por eso
 * abrieras la cuenta que abrieras, caías siempre en la misma.
 *
 * `--user-data-dir` no tiene ese problema: cada carpeta es su propia instancia
 * de Chrome, con su propio candado, así que no hay forma de que otra se quede
 * con la ventana. Además pueden convivir dos cuentas abiertas a la vez.
 *
 * Sigue siendo una cuenta a la vez para la extensión: el registro de native
 * messaging y el pipe del puente son únicos por usuario de Windows.
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

const localAppData = () => process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');

/** La carpeta de datos del Chrome del usuario. Sólo se usa para migrar lo que
 *  quedó de cuando las cuentas eran perfiles ahí adentro. */
export const chromeUserData = () => join(localAppData(), 'Google', 'Chrome', 'User Data');

/**
 * La carpeta de datos del Chrome de una cuenta.
 *
 * Va derivada del id y no del nombre que puso el usuario: el nombre se puede
 * cambiar, y mover la carpeta le haría perder a Chrome las cookies, que es lo
 * único que este navegador existe para guardar.
 */
export function browserDir(profileId: string): string {
  return join(localAppData(), 'claude-monitor', 'chrome', profileId.replace(/[^A-Za-z0-9-]/g, ''));
}

/** Cómo se llamaba el perfil cuando vivían dentro del Chrome del usuario. */
export const legacyProfileName = (profileId: string) => `Claude-${profileId.replace(/[^A-Za-z0-9-]/g, '')}`;

/** Dentro de su propia carpeta de datos, Chrome usa el perfil `Default`. */
const profilePath = (profileId: string, ...parts: string[]) => join(browserDir(profileId), 'Default', ...parts);

/** El id de la extensión de Claude. Sale del `allowed_origins` del manifiesto
 *  del native host que instala Claude Code. */
export const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

const STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
const CLAUDE_URL = 'https://claude.ai';

/** Migraciones en curso, para que dos lecturas simultáneas no copien lo mismo
 *  dos veces. `listProfiles` consulta todas las cuentas en paralelo. */
const migrando = new Map<string, Promise<void>>();

/**
 * Trae lo que la cuenta tenía cuando su navegador era un perfil dentro del
 * Chrome del usuario: sesión de claude.ai, extensión y lo demás.
 *
 * Se copia también el `Local State` de origen, y no es un detalle: ahí vive la
 * clave con la que están cifradas las cookies. Sin ella, la sesión no se puede
 * descifrar en la carpeta nueva y habría que iniciarla de nuevo.
 *
 * Se copia a un nombre aparte y recién al terminar se renombra al definitivo.
 * El renombre es atómico, así que la carpeta buena nunca existe a medias: o no
 * está, o está completa. Copiando directo sobre el destino, cualquier lectura
 * durante los ~80 MB de copia veía un perfil sin cookies y lo reportaba como
 * deslogueado — y peor, se podía llegar a abrir Chrome sobre eso.
 *
 * No borra el perfil viejo. Si algo sale mal, sigue estando.
 */
function migrateLegacy(profileId: string): Promise<void> {
  const enCurso = migrando.get(profileId);
  if (enCurso) return enCurso;

  const tarea = (async () => {
    const destino = browserDir(profileId);
    if (await stat(destino).catch(() => null)) return; // ya migrada o ya creada

    const origen = join(chromeUserData(), legacyProfileName(profileId));
    if (!(await stat(origen).catch(() => null))) return; // no hay nada que traer

    const parcial = `${destino}.migrando-${randomUUID().slice(0, 8)}`;
    try {
      await mkdir(parcial, { recursive: true });
      await cp(origen, join(parcial, 'Default'), { recursive: true });
      await copyFile(join(chromeUserData(), 'Local State'), join(parcial, 'Local State')).catch(() => {});
      await rename(parcial, destino);
    } catch {
      // A medio copiar no sirve de nada y confundiría a la próxima pasada.
      await rm(parcial, { recursive: true, force: true }).catch(() => {});
    }
  })().finally(() => migrando.delete(profileId));

  migrando.set(profileId, tarea);
  return tarea;
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
 * Si el navegador de la cuenta tiene instalada la extensión de Claude.
 *
 * Las extensiones son por perfil: uno nuevo nace sin ninguna, aunque el Chrome
 * de siempre las tenga todas. Sin la extensión, la sesión del CLI dice "browser
 * extension is not connected" por más que claude.ai esté logueado.
 *
 * Chrome reparte esto entre `Preferences` y `Secure Preferences` según la
 * versión y cómo se instaló, así que se miran los dos.
 */
export async function hasExtension(profileId: string): Promise<boolean> {
  for (const file of ['Preferences', 'Secure Preferences']) {
    const raw = await readFile(profilePath(profileId, file), 'utf8').catch(() => null);
    if (raw && declaresExtension(raw)) return true;
  }
  return false;
}

/**
 * Si el navegador de la cuenta tiene iniciada la sesión de claude.ai.
 *
 * Se busca el NOMBRE de la cookie `sessionKey` pegado a su dominio, que es como
 * quedan contiguos en el registro de SQLite. No se lee ningún valor: los de las
 * cookies están cifrados y no hacen falta — alcanza con saber si existe.
 */
export function hasSessionCookie(cookies: Buffer): boolean {
  return cookies.includes('claude.aisessionKey');
}

/** Lo que le falta —o no— al navegador de una cuenta. */
export type ChromeStatus = { profileExists: boolean; extension: boolean; loggedIn: boolean };

/** Dónde se anota lo que la app sabe de cada navegador. */
export const storeDir = () => join(localAppData(), 'claude-monitor', 'browsers');

/** Si el navegador de la cuenta conoce ese identificador de dispositivo. La
 *  extensión guarda su estado en el almacén local de Chrome; no se interpreta
 *  el formato, sólo se busca si el identificador está ahí. */
async function browserKnowsDevice(profileId: string, deviceId: string): Promise<Observacion> {
  const dir = profilePath(profileId, 'Local Extension Settings', EXTENSION_ID);
  const archivos = await readdir(dir).catch(() => null);
  if (archivos === null) return { ok: false, readable: false }; // la extensión nunca corrió acá

  for (const f of archivos) {
    const buf = await readFile(join(dir, f)).catch(() => null);
    if (buf?.includes(deviceId)) return { ok: true, readable: true };
  }
  return { ok: false, readable: true };
}

/**
 * Borra el emparejamiento de la extensión si apunta a un navegador que no es el
 * de esta cuenta.
 *
 * `chromeExtension.pairedDeviceId` identifica al NAVEGADOR con el que la cuenta
 * se emparejó. Cuando cada cuenta era un perfil dentro del Chrome del usuario,
 * la app copiaba ese dato entre cuentas: era el mismo navegador y servía. Con
 * un navegador propio por cuenta dejó de servir — y quedó peor que no tenerlo,
 * porque la configuración afirma estar emparejada con un dispositivo que no
 * existe, y el emparejamiento real nunca llega a hacerse.
 *
 * Visto en esta máquina: las cuentas apuntaban a "Browser 1", un identificador
 * que ningún navegador del equipo conocía.
 *
 * Sólo borra cuando de verdad se pudo mirar el almacén de la extensión y el
 * identificador no estaba. Si no se pudo mirar, se deja como está: un
 * emparejamiento bueno borrado por las dudas obliga a rehacerlo a mano.
 */
export async function pruneStalePairing(configDir: string, profileId: string): Promise<boolean> {
  const path = join(configDir, '.claude.json');
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return false;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const pairing = config.chromeExtension as { pairedDeviceId?: unknown } | undefined;
  const deviceId = pairing?.pairedDeviceId;
  if (typeof deviceId !== 'string' || !deviceId) return false;

  const conocido = await browserKnowsDevice(profileId, deviceId);
  if (!conocido.readable || conocido.ok) return false;

  delete config.chromeExtension;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return true;
}

/**
 * Qué le falta al navegador de una cuenta.
 *
 * Lo que se devuelve sale del registro en disco, no de mirar los archivos de
 * Chrome en el momento. Mirar sirve para ACTUALIZAR el registro, no para
 * reemplazarlo: mientras Chrome escribe, o mientras se copia un perfil, lo que
 * se lee no refleja la realidad, y así fue como la app llegó a avisar "falta
 * iniciar sesión" sobre cuentas que la tenían. Ver `browser-store.ts`.
 */
export async function chromeStatus(profileId: string, accountName = ''): Promise<ChromeStatus> {
  await migrateLegacy(profileId).catch(() => {});

  const previo = await readRecord(storeDir(), profileId);
  const profileExists = Boolean(await stat(profilePath(profileId)).catch(() => null));

  const registro = merge(
    previo,
    {
      id: profileId,
      userDataDir: browserDir(profileId),
      displayName: previo?.displayName || (accountName ? displayName(accountName) : '')
    },
    // Sin carpeta no hay nada que mirar, y tampoco hay que desmentir lo
    // guardado: `readable: false` deja el último estado conocido en su lugar.
    profileExists ? await observeSession(profileId) : { ok: false, readable: false },
    profileExists ? await observeExtension(profileId) : { ok: false, readable: false }
  );
  await writeRecord(storeDir(), registro).catch(() => {});

  return { profileExists, extension: vale(registro.extension), loggedIn: vale(registro.session) };
}

/**
 * Lee el archivo de cookies y dice si está la sesión.
 *
 * El nombre del temporal lleva un identificador único, y no es adorno: la lista
 * de cuentas se refresca sola al volver el foco, así que puede haber dos
 * lecturas en vuelo a la vez. Con un nombre fijo, una borraba la copia mientras
 * la otra la leía y la cuenta aparecía deslogueada sin estarlo.
 *
 * Si la copia falla se intenta leer el original: Chrome tiene el archivo
 * tomado, pero permite leerlo.
 */
async function observeSession(profileId: string): Promise<Observacion> {
  const origen = profilePath(profileId, 'Network', 'Cookies');
  const copia = join(tmpdir(), `cm-cookies-${randomUUID()}`);
  try {
    await copyFile(origen, copia);
    return { ok: hasSessionCookie(await readFile(copia)), readable: true };
  } catch {
    // La copia falló —Chrome lo tiene tomado, o el archivo no está—; se intenta
    // el original. Si tampoco se puede, se informa que NO se pudo mirar, que no
    // es lo mismo que "no hay sesión".
    return await readFile(origen)
      .then((buf) => ({ ok: hasSessionCookie(buf), readable: true }))
      .catch(() => ({ ok: false, readable: false }));
  } finally {
    await rm(copia, { force: true }).catch(() => {});
  }
}

/** Igual que `hasExtension`, pero distinguiendo "no está" de "no se pudo leer".
 *  Los dos archivos ausentes significan que no hay nada que leer todavía. */
async function observeExtension(profileId: string): Promise<Observacion> {
  let leido = false;
  for (const file of ['Preferences', 'Secure Preferences']) {
    const raw = await readFile(profilePath(profileId, file), 'utf8').catch(() => null);
    if (raw === null) continue;
    leido = true;
    if (declaresExtension(raw)) return { ok: true, readable: true };
  }
  return { ok: false, readable: leido };
}

/**
 * Qué abrir para esta cuenta, según lo que le falte.
 *
 * Una sola pestaña por vez, y en orden: primero la extensión, después la sesión
 * de claude.ai. Abrir las dos juntas dejaba pestañas encimadas y no se entendía
 * cuál atender primero.
 *
 * La extensión va primero porque es el paso que el usuario no descubre solo: se
 * instala una vez por perfil, no depende de tener sesión —la tienda no pide
 * cuenta de Claude para instalarla— y con ella puesta antes del login, apenas
 * la sesión de claude.ai existe la extensión ya conecta. Al revés el usuario
 * terminaba logueado, creyendo que había terminado, y la sesión del CLI decía
 * "browser extension is not connected" sin explicar qué faltaba.
 */
export function nextStepUrl(status: ChromeStatus): string {
  return status.extension ? CLAUDE_URL : STORE_URL;
}

/** Cómo se va a ver el navegador de esta cuenta. */
export function displayName(accountName: string): string {
  return `Claude · ${accountName}`.replace(/\s+/g, ' ').trim();
}

/** El `Preferences` con el nombre puesto, o `null` si ya estaba así. Se
 *  conserva todo el resto: ahí vive la configuración entera del perfil. */
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
 * Los procesos de Chrome que corren sobre la carpeta de ESTA cuenta.
 *
 * Se mira sólo su instancia: el Chrome de siempre del usuario no tiene nada que
 * ver, y confundirlos significaría cerrarle las ventanas al usuario.
 *
 * Chrome levanta muchos procesos por ventana y todos heredan la línea de
 * comando con el `--user-data-dir`. El del navegador —el que manda, el que
 * cierra a los demás— es el único sin `--type=`. `soloRaiz` deja ese.
 *
 * La comparación va en minúsculas porque así se compara todo lo demás en
 * Windows, y `.Contains()` de .NET distingue mayúsculas. Se usa `.Contains()`
 * y no `-like` a propósito: `-like` interpretaría un `[` del nombre de usuario
 * como comodín y no encontraría nada.
 */
async function profilePids(profileId: string, soloRaiz = false): Promise<number[]> {
  const dir = browserDir(profileId).toLowerCase().replace(/'/g, "''");
  const raiz = soloRaiz ? " -and -not $_.CommandLine.Contains('--type=')" : '';
  const stdout = await run('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${dir}')${raiz} } | ForEach-Object { $_.ProcessId }`
  ])
    .then((r) => r.stdout)
    .catch(() => '');
  return stdout
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Si el navegador de ESTA cuenta está corriendo. Con Chrome abierto no se le
 *  pueden reescribir las preferencias: las tiene en memoria y las vuelca al
 *  cerrar, pisando lo que hayamos puesto. */
async function instanceRunning(profileId: string): Promise<boolean> {
  return (await profilePids(profileId)).length > 0;
}

/**
 * Si el navegador que la app abrió para configurar una cuenta ya cumplió con lo
 * suyo y se puede cerrar.
 *
 * `authenticated` —el login del CLI hecho— es el corte: de ahí en adelante ese
 * navegador es del usuario, que lo abre a mano para usar la herramienta de
 * navegador, y cerrárselo sería sacarle la ventana de las manos.
 *
 * `loginEnCurso` protege el caso peor: la autorización se muestra JUSTO en esa
 * ventana y este chequeo corre en cada refresco, incluido el que dispara volver
 * a la app a pegar el código.
 */
export function setupBrowserDone(
  cuenta: { authenticated: boolean; chrome: ChromeStatus },
  loginEnCurso: boolean
): boolean {
  return !cuenta.authenticated && !loginEnCurso && cuenta.chrome.extension && cuenta.chrome.loggedIn;
}

/**
 * Cierra el navegador de esta cuenta. Devuelve si había algo que cerrar.
 *
 * Se le pide a la ventana que se cierre, no se mata el proceso: Chrome vuelca
 * al salir lo que tiene en memoria —cookies incluidas— y matarlo además le hace
 * mostrar "no se cerró correctamente" la próxima vez.
 */
export async function closeChromeForProfile(profileId: string): Promise<boolean> {
  const pids = await profilePids(profileId, true);
  if (pids.length === 0) return false;
  // ponytail: cierra la ventana principal de esa instancia; si la cuenta tiene
  // varias ventanas abiertas quedan las otras. Con `$_.CloseMainWindow()` en un
  // bucle hasta que no queden, si alguna vez molesta.
  await run('powershell', [
    '-NoProfile',
    '-Command',
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`
  ]).catch(() => {});
  return true;
}

/**
 * Le pone al navegador de la cuenta el nombre de la cuenta.
 *
 * Devuelve `true` si quedó aplicado. Con esa instancia abierta no se toca nada:
 * hay que esperar a que se cierre. Una carpeta que todavía no existe sí se
 * puede nombrar de entrada, sembrando su `Preferences` antes de que Chrome la
 * cree — que es el caso de una cuenta recién agregada.
 */
export async function setProfileDisplayName(profileId: string, name: string): Promise<boolean> {
  const prefsPath = profilePath(profileId, 'Preferences');
  const prefs = await readFile(prefsPath, 'utf8').catch(() => null);

  if (prefs === null) {
    await mkdir(profilePath(profileId), { recursive: true });
    await writeFile(prefsPath, JSON.stringify({ profile: { name } }), 'utf8');
    return true;
  }

  if (await instanceRunning(profileId)) return false;

  const patched = withProfileName(prefs, name);
  if (patched) await writeFile(prefsPath, patched, 'utf8');
  return true;
}

/**
 * Abre el Chrome de esta cuenta.
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
): Promise<{ firstRun: boolean; needsExtension: boolean; needsLogin: boolean; pendingRename: boolean }> {
  const chrome = await findChrome();
  if (!chrome) {
    throw new Error('No se encontró chrome.exe. ¿Está instalado Google Chrome?');
  }

  const dir = browserDir(profileId);
  // Primero el estado: es lo que dispara la migración y espera a que termine, así
  // nunca se abre Chrome sobre un perfil a medio copiar.
  const status = await chromeStatus(profileId);
  const firstRun = !(await stat(dir).catch(() => null));
  // Antes de abrirlo, para que Chrome lo lea al arrancar.
  const pendingRename = !(await setProfileDisplayName(profileId, displayName(accountName)).catch(() => false));

  await new Promise<void>((resolve, reject) => {
    const child = spawn(chrome, [`--user-data-dir=${dir}`, url ?? nextStepUrl(status)], {
      detached: true,
      stdio: 'ignore'
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });

  return { firstRun, needsExtension: !status.extension, needsLogin: !status.loggedIn, pendingRename };
}
