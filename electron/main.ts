import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { constants } from 'node:fs';
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureHostScript } from './chrome-host';
import { chromeStatus, closeChromeForProfile, openChromeForProfile, setupBrowserDone } from './chrome-launch';
import { isLoggedIn } from './credentials';
import { desktopDir, esperandoEnlace, newSessionLink, openDesktopForProfile, resumeLink } from './desktop';
import { enlaceEn, soltar, tenemosElProtocolo, tomar } from './protocol';
import { anotar, archivoDeRegistro, leer, registroDeDesktop } from './registro';
import { cancelLogin, loginPending, startLogin, submitCode } from './login';
import { markOnboardingDone } from './onboarding';
import {
  allProfiles,
  createProfile,
  createWslProfile,
  deleteProfile,
  getProfile,
  getSharedRoot,
  getActiveProfile,
  listProfiles,
  profileForWork,
  raices,
  setActiveProfile,
  ensureChromeHosts,
  markOnboardingAll,
  shareAllProjects,
  syncAllPlugins
} from './profiles';
import { countCompactions, deleteSession, listSessions, mezclarRaices } from './sessions';
import { openTerminal } from './terminal';
import { tokensFor } from './tokens';
import { dondeEstaAbierta, quienLaTiene } from './liveness';
import { readTranscript, reescribirCwd } from './transcript';
import { readUsage } from './usage';
import {
  cuentaParaSesion,
  distrosCorriendo,
  distrosInstaladas,
  encenderDistro,
  esWsl,
  posixAWindows
} from './wsl';
import type { Profile, ProfileWithStatus, Raiz, Result, SessionMeta } from '../shared/types';

/** Envuelve un handler para que el renderer nunca reciba una excepción cruda. */
function handle<T>(channel: string, fn: (...args: any[]) => Promise<T>) {
  ipcMain.handle(channel, async (_event, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Los ids de sesión de Claude Code son UUID; todo lo demás se rechaza porque
 * el id termina interpolado en la linea de comando de una terminal externa. */
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Busca la sesión en todas las raíces, no en un pozo único: cada cuenta WSL
 *  trae la suya, y las que no se pueden leer (distro apagada, sin config) se
 *  saltean sin tocarlas. */
async function findSession(id: string) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error(`Id de sesión inválido: ${id}`);
  for (const raiz of await raices()) {
    if (raiz.estado.tipo !== 'ok') continue;
    const session = (await listSessions(raiz.configDir, raiz.entorno)).find((s) => s.id === id);
    if (session) return { session };
  }
  throw new Error(`Sesión no encontrada: ${id}`);
}

/**
 * Deja el `cwd` del transcript apuntando a la carpeta como la ve Windows, para
 * que Claude Desktop la encuentre. Ver `reescribirCwd`.
 *
 * Escribe a un temporal y renombra: un corte a mitad de la escritura sobre el
 * archivo original dejaría la conversación truncada, y es la conversación del
 * usuario. `rename` en el mismo directorio es atómico.
 *
 * Y deja UNA copia intacta la primera vez, con la ruta POSIX original. La
 * primera nada más: en la segunda pasada el original ya está en UNC y
 * pisarla borraría la única versión con la ruta de Linux.
 *
 * Nada de esto es fatal: si el transcript no se puede tocar —permisos, la
 * distro que se apagó justo— igual se abre Desktop, que como mucho va a pedir
 * la carpeta. Perder la conversación por no poder editar un campo sería la
 * peor de las dos.
 */
async function apuntarCwdAWindows(ruta: string, viejo: string, nuevo: string): Promise<void> {
  try {
    const contenido = await readFile(ruta, 'utf8');
    const cambiado = reescribirCwd(contenido, viejo, nuevo);
    if (cambiado === contenido) return;
    await copyFile(ruta, `${ruta}.pre-unc`, constants.COPYFILE_EXCL).catch(() => {});
    await writeFile(`${ruta}.tmp`, cambiado, 'utf8');
    await rename(`${ruta}.tmp`, ruta);
    anotar('desktop: cwd del transcript apuntado a Windows', { ruta, viejo, nuevo });
  } catch (error) {
    anotar('desktop: no se pudo apuntar el cwd, Desktop va a pedir la carpeta', {
      ruta,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/** La ruta del transcript de una sesión, desde la raíz que la contiene. Antes
 *  se armaba con `sharedRoot`, que asumía una sola. */
const rutaDe = (s: SessionMeta) => join(s.raiz, 'projects', s.projectSlug, `${s.id}.jsonl`);

/**
 * Lee una raíz y, si vino vacía, confirma que sea por falta de sesiones y no
 * porque la distro se apagó en el medio.
 *
 * La carrera es real, no hipotética: se observó a la distro encenderse al
 * tocar la UNC y apagarse sola por inactividad antes del chequeo siguiente. Si
 * eso pasa entre `raices()` y la lectura, `listSessions` come el error de
 * `readdir` y devuelve `[]` — y las sesiones desaparecerían sin explicación,
 * que es justo lo prohibido. La reconsulta cuesta 0,12 s y sólo ocurre en el
 * caso de cero sesiones.
 */
async function leerRaiz(r: Raiz): Promise<{ sesiones: SessionMeta[]; raiz: Raiz }> {
  if (r.estado.tipo !== 'ok') return { sesiones: [], raiz: r };
  const sesiones = await listSessions(r.configDir, r.entorno);
  if (sesiones.length > 0 || r.entorno.tipo !== 'wsl') return { sesiones, raiz: r };
  const corriendo = await distrosCorriendo();
  if (corriendo.includes(r.entorno.distro)) return { sesiones, raiz: r };
  return { sesiones: [], raiz: { ...r, estado: { tipo: 'apagada', mensaje: 'Distro apagada' } } };
}

/**
 * Corta antes de abrir la terminal si a la cuenta le falta el login.
 *
 * Si el CLI arranca sin credenciales, ofrece iniciar sesión y abre la pestaña
 * en el navegador POR DEFECTO — no en el de la cuenta. Y eso no se puede
 * redirigir: `BROWSER` no admite argumentos, así que no hay forma de indicarle
 * un `--user-data-dir` (probado con y sin comillas: no abre nada). Si autoriza
 * ahí, la sesión de claude.ai queda en el navegador equivocado y la extensión
 * de la cuenta se queda sin nada.
 *
 * Por eso el login se resuelve entero en la app, antes. Es preferible frenar
 * acá con una explicación a dejar que la terminal mande al lugar equivocado.
 */
async function requireLogin(profile: Profile): Promise<void> {
  const credenciales = await readFile(join(profile.configDir, '.credentials.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  if (isLoggedIn(credenciales)) return;

  throw new Error(
    `La cuenta "${profile.name}" no tiene la sesión iniciada. Hacelo desde acá con "Configurar Claude": ` +
      'si dejás que te la pida la terminal, el login se abre en tu Chrome de siempre y la extensión de esta cuenta queda sin sesión.'
  );
}

/**
 * Abre una terminal con una cuenta: la anuncia, y deja la extensión de Chrome
 * apuntando a la misma.
 *
 * Lo de Chrome va acá porque el emparejamiento de la extensión se guarda en el
 * `.claude.json` de la cuenta: si el puente resuelve a otra carpeta, la sesión
 * pide emparejar de nuevo y la respuesta se guarda donde no sirve. Se hace
 * justo antes de abrir la terminal porque `claude` recrea ese `.bat` cuando
 * falta, y ahí perdería la cuenta. Ver `chrome-host.ts`.
 *
 * El correo se resuelve preguntando de quién es el token, no leyendo la
 * carpeta, porque es lo único que no miente cuando un login aterrizó en el
 * lugar equivocado. Sale de la caché de `readUsage`, que ya está caliente
 * porque la lista de cuentas la refresca todo el tiempo.
 *
 * Ningún paso previo puede impedir que la terminal se abra: sin extensión o sin
 * el nombre de la cuenta se trabaja igual, y quedarse sin poder abrir una
 * sesión sería mucho peor.
 */
async function openTerminalAs(cwd: string, command: string, profile: Profile) {
  // `ensureHostScript` no hace nada en una cuenta WSL: el puente de Chrome es
  // un `.bat` de Windows y la extensión no llega a la sesión de la distro (su
  // guard está adentro, ver `esWsl` en wsl.ts).
  await ensureHostScript(profile.configDir, await getSharedRoot(), profile.entorno).catch((error) => {
    console.warn('No se pudo fijar la cuenta en el puente de Chrome:', error);
  });
  // Leer el `configDir` de una cuenta WSL toca la UNC y puede encender la
  // distro. Acá es lo correcto: el usuario pidió una sesión ADENTRO de ella, y
  // `openTerminal` la va a encender igual. La regla de no encenderla de rebote
  // rige para lo que se lee solo (la lista, el refresco), no para esto.
  const usage = await readUsage(profile.configDir).catch(() => null);
  const label = usage?.email ? `${profile.name} · ${usage.email}` : profile.name;
  await openTerminal(cwd, command, profile.configDir, label, profile.entorno);
}

/**
 * Cierra el Chrome que la app abrió para configurar una cuenta, apenas esa
 * cuenta ya no lo necesita abierto.
 *
 * Esa ventana se abre para dos trámites —instalar la extensión e iniciar sesión
 * en claude.ai— y una vez hechos no tiene nada más que mostrar. Dejándola
 * abierta, el usuario termina con un Chrome de más por cada cuenta que agrega y
 * sin saber si todavía hace falta.
 *
 * Sólo mientras la cuenta se está configurando: `authenticated` significa que
 * el login del CLI ya se completó, y de ahí en adelante ese navegador es del
 * usuario —lo abre con el botón "Chrome" para usar la herramienta de navegador—
 * así que cerrárselo sería sacarle la ventana de las manos.
 *
 * Y nunca con un login en curso: la autorización se está mostrando JUSTO en esa
 * ventana, y este chequeo corre en cada refresco, incluso cuando el usuario
 * vuelve a la app a pegar el código.
 */
async function closeSetupBrowsers(profiles: ProfileWithStatus[]): Promise<void> {
  await Promise.all(
    profiles.map(async (p) => {
      if (!setupBrowserDone(p, loginPending(p.id))) return;
      await closeChromeForProfile(p.id).catch(() => {});
    })
  );
}

/**
 * El barrido de raíces del refresco en curso, que `sessions:list` deja servido
 * para que `sessions:tokens` no lo repita.
 *
 * El panel dispara los dos handlers juntos en cada foco de ventana (ver
 * `refresh` en `src/App.tsx`), y cada barrido cuesta dos listados de `wsl.exe`
 * más un `hayCliEn` por cuenta WSL. Duplicarlo era pagar todo eso dos veces por
 * alt-tab.
 *
 * Se consume UNA vez: el que lo toma lo borra. Así un `sessions:tokens` suelto
 * —o uno que llegue tarde, después de que otro refresco ya lo haya usado— hace
 * su propio barrido en vez de trabajar sobre una lista vieja.
 */
let barridoServido: Array<{ sesiones: SessionMeta[]; raiz: Raiz }> | null = null;

async function barrerRaices(): Promise<Array<{ sesiones: SessionMeta[]; raiz: Raiz }>> {
  return Promise.all((await raices()).map(leerRaiz));
}

function registerHandlers() {
  // La lista se refresca sola cada vez que la ventana toma el foco, así que es
  // también el momento en que la app se entera de que el usuario ya terminó lo
  // suyo en el navegador de una cuenta.
  handle('profiles:list', async () => {
    const lista = await listProfiles();
    await closeSetupBrowsers(lista.profiles).catch(() => {});
    return lista;
  });
  handle('profiles:create', (name: string) => createProfile(name));
  // Cambiar de cuenta no toca el puente de Chrome: `claude` lo re-registra al
  // arrancar, apuntando al `.bat` de la carpeta con la que corre. Lo que importa
  // es que ese `.bat` tenga la cuenta puesta, y de eso se ocupa `openTerminalAs`.
  handle('profiles:setActive', async (id: string) => {
    await setActiveProfile(id);
    return null;
  });
  handle('profiles:delete', async (id: string) => {
    await deleteProfile(id);
    return null;
  });
  // El login, conducido desde la app en vez de en una terminal suelta.
  //
  // Corriéndolo en una terminal, la URL de autorización la abre el navegador
  // POR DEFECTO: obliga a un segundo login para el Chrome de la cuenta, y si
  // ese navegador está logueado con otra cuenta, autoriza la equivocada sin
  // avisar. Acá se lee la URL y se abre en el Chrome de ESTA cuenta — el mismo
  // recorrido deja el token del CLI y la sesión de claude.ai que necesita la
  // extensión. Ver `login.ts`.
  handle('profiles:login', async (id: string) => {
    const profile = await getProfile(id);

    // El navegador de la cuenta tiene que tener la extensión y la sesión ANTES
    // de esto, y en ese orden.
    //
    // La extensión primero porque es lo que la app no puede hacer por el
    // usuario y lo que nadie descubre solo: es por perfil, así que un Chrome
    // recién creado no la tiene por más que el Chrome de siempre sí. Sin ella
    // la sesión del CLI dice "browser extension is not connected" cuando ya
    // parecía que todo estaba listo.
    //
    // La sesión después, y antes del login del CLI: `claude auth login` abre su
    // propia pestaña en el navegador por defecto y no se le puede impedir. Si
    // el usuario autoriza ahí, la sesión de claude.ai queda guardada en el
    // Chrome equivocado y el de la cuenta sigue vacío — que es exactamente por
    // qué la extensión no funcionaba. Con la sesión ya iniciada acá, la pestaña
    // que abre la app muestra el botón de autorizar directo, sin pedir login, y
    // la otra queda como ruido inofensivo.
    //
    // Se abre Chrome en el paso que falte —`nextStepUrl` decide cuál— y se
    // frena con la explicación de ese paso, uno por vez.
    //
    // Nada de esto rige para una cuenta de WSL, y por eso se saltea entero: el
    // puente de la extensión es un `.bat` de Windows que `ensureHostScript` se
    // niega a escribir ahí (ver `esWsl` en wsl.ts), y el CLI que se autoriza
    // corre en Linux. Sin el salteo, lo PRIMERO que toca un usuario de WSL
    // después de dar de alta la cuenta es instalar una extensión en un Chrome
    // descartable y loguearse en claude.ai ahí, para un navegador que nunca va
    // a hablar con esa sesión. Se va directo a `startLogin`; la URL de
    // autorización se sigue abriendo igual, abajo.
    if (!esWsl(profile.entorno)) {
      const estado = await chromeStatus(profile.id, profile.name);
      if (!estado.extension || !estado.loggedIn) {
        await openChromeForProfile(profile.id, profile.name).catch(() => {});
        throw new Error(
          !estado.extension
            ? `Paso 1: instalá la extensión de Claude en el Chrome de "${profile.name}", que se acaba de abrir en la tienda. ` +
              'Las extensiones son por perfil, así que va una vez por cada cuenta. Después volvé y tocá "Configurar Claude" otra vez.'
            : `Paso 2: iniciá sesión en claude.ai dentro del Chrome de "${profile.name}", que se acaba de abrir. ` +
              'Después volvé y tocá "Configurar Claude". Si autorizás en tu Chrome de siempre, la sesión queda guardada ahí y la extensión no funciona.'
        );
      }
    }

    const url = await startLogin(id, profile.configDir, profile.entorno);
    const { needsExtension } = await openChromeForProfile(profile.id, profile.name, url).catch(() => {
      cancelLogin(id);
      throw new Error('No se pudo abrir Chrome para autorizar. ¿Está instalado?');
    });
    return { url, needsExtension };
  });
  // El código que el usuario copia del navegador. Va derecho al stdin del
  // proceso: no se guarda ni se registra.
  handle('profiles:loginCode', async (id: string, code: string) => {
    await submitCode(id, code);
    // El token ya está guardado, pero una carpeta nueva sigue sin la marca de
    // presentación: sin ella el CLI arranca pidiendo elegir método de ingreso,
    // y elegir ahí lanza otro login que abre el navegador por defecto. Ver
    // `onboarding.ts`.
    const profile = await getProfile(id);
    await markOnboardingDone(profile.configDir, await getSharedRoot(), profile.entorno).catch(() => {});
    return null;
  });
  handle('profiles:loginCancel', async (id: string) => {
    cancelLogin(id);
    return null;
  });

  // Un Chrome por cuenta. La extensión se autentica con la sesión web de
  // claude.ai del navegador y exige que sea la misma cuenta que Claude Code;
  // Chrome guarda una sola sesión por perfil, así que hace falta un perfil por
  // cuenta. Ver `chrome-launch.ts`.
  handle('chrome:open', async (id: string) => {
    const profile = await getProfile(id);
    return openChromeForProfile(profile.id, profile.name);
  });

  // Claude Desktop con la carpeta de datos de esta cuenta, para que su login
  // sea el de esta cuenta y no el de la última que entró.
  //
  // No pide `requireLogin`: el login del CLI y el de Desktop son dos cosas
  // distintas —Desktop guarda su token en su propia carpeta de datos— así que
  // una cuenta sin el CLI autorizado igual puede trabajar acá, y este botón es
  // justamente por dónde inicia sesión. Ver `desktop.ts`.
  handle('desktop:open', async (id: string) => {
    const profile = await getProfile(id);
    return openDesktopForProfile(profile, await getSharedRoot());
  });

  // Lo mismo pero en Desktop, y con la cuenta activa: abrir una carpeta a
  // trabajar es la otra mitad de "reanudar", y Desktop es el otro lugar donde
  // se puede trabajar. Sin `cwd` pide la carpeta, igual que `sessions:new`.
  //
  // No hay `requireLogin`: eso mira el token del CLI, y Desktop se autentica
  // por su cuenta adentro de la app. Exigirlo dejaría afuera justo a la cuenta
  // que todavía no pasó por el login del CLI.
  handle('desktop:openIn', async (cwd?: string) => {
    const { profile, relevo } = await profileForWork();
    let dir = typeof cwd === 'string' && cwd ? cwd : null;
    if (!dir) {
      const picked = await dialog.showOpenDialog({
        title: 'Elegí la carpeta del proyecto',
        properties: ['openDirectory']
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      dir = picked.filePaths[0];
    }
    // La carpeta de un proyecto de la distro llega POSIX (`/home/…`), que del
    // lado de Windows no existe: sin traducir, el `stat` de abajo fallaría y
    // Desktop tampoco la encontraría. En UNC sí: verificado en el bundle de
    // Desktop, que arma las rutas de la distro exactamente en esa forma.
    //
    // La distro sale de la cuenta activa, que es la misma con la que la
    // interfaz decide mostrar el botón. Sin cuenta WSL activa no hay de dónde
    // sacarla y la ruta se deja como vino: el `stat` falla y lo dice.
    if (dir.startsWith('/') && profile.entorno?.tipo === 'wsl') {
      dir = posixAWindows(profile.entorno.distro, dir);
    }
    // Una carpeta que ya no existe abriría Desktop igual, en cualquier lado y
    // sin decir por qué: pasa seguido con un proyecto viejo movido o borrado.
    const destino = await stat(dir).catch(() => null);
    if (!destino?.isDirectory()) {
      throw new Error(`No se puede abrir en Claude Desktop: la carpeta ya no existe (${dir}).`);
    }
    return { ...(await openDesktopForProfile(profile, await getSharedRoot(), newSessionLink(dir))), relevo };
  });

  // Reanudar la MISMA conversación, pero en Desktop.
  //
  // Desktop adopta el transcript del CLI por su id y sigue donde iba — es lo
  // que hace `/desktop` desde la terminal. Para encontrarlo necesita
  // `CLAUDE_CONFIG_DIR` apuntando a la cuenta, y de eso ya se ocupa
  // `openDesktopForProfile`.
  //
  // Se resuelve la sesión antes de abrir nada: si el `.jsonl` no está, Desktop
  // sólo muestra un aviso suyo y la ventana queda abierta sin explicar nada.
  handle('desktop:resume', async (id: string) => {
    const { session } = await findSession(id);
    // Acá se negaba a abrir en Desktop cualquier sesión de una distro. El motivo
    // que se daba —"Desktop es una app de Windows"— es falso: Desktop tiene su
    // propio selector Local / Nube / Control remoto / WSL / SSH.
    //
    // Lo que faltaba era decirle DÓNDE buscar el transcript. Desktop lo resuelve
    // por su `CLAUDE_CONFIG_DIR`, y acá se le pasaba siempre el pozo de Windows,
    // que por supuesto no contiene una conversación de la distro. Ahora se le
    // pasa la raíz de la sesión: para una de WSL es la UNC del `~/.claude` de
    // adentro de la distro, y sobre esa UNC `node:fs` —y Desktop, que es
    // Electron— lee y escribe. Reanudar es una escritura (Desktop reescribe el
    // `.jsonl` al importarlo), y por eso importa que sea un directorio de
    // verdad y no un enlace: el `projects` del pozo lo es. Ver el
    // `PlantDetectedError` que describe el comentario grande de `desktop.ts`.
    // La carpeta de trabajo, dejada como Desktop la puede encontrar.
    //
    // Desktop la saca del `cwd` del transcript y no hay forma de pasársela por
    // el enlace. La de una sesión de la distro es POSIX, del lado de Windows no
    // existe, y el resultado era: la conversación se abría entera y arriba
    // aparecía "La carpeta de trabajo ya no existe". De paso, como Desktop
    // agrupa los proyectos por esa cadena, la misma carpeta figuraba dos veces
    // en su barra lateral —una por el `/home/…` y otra por la UNC que el
    // usuario elegía a mano—.
    // Antes que nada: si otro Claude Code la tiene abierta, Desktop se va a
    // negar a adoptarla —`liveOwnershipRefusal` en su bundle— y lo va a hacer
    // callado: abre la ventana y la conversación llega hasta donde estaba, sin
    // lo último. Ese era el "no me trae lo último".
    //
    // Negarse no es opcional y no es nuestro: dos procesos escribiendo el
    // mismo `.jsonl` lo rompen. Lo que sí es nuestro es DECIRLO, y decir dónde
    // cerrarla. Ver `liveness.ts`.
    const dueno = await quienLaTiene(session.raiz, session.id, session.entorno);
    if (dueno) {
      throw new Error(
        `Esta conversación la tiene abierta ${dondeEstaAbierta(dueno)} (proceso ${dueno.pid})` +
          `${dueno.cwd ? ` en ${dueno.cwd}` : ''}. Claude Desktop no adopta una sesión que otro ` +
          'proceso está escribiendo —se la llevaría a medias y sin lo último—. Cerrala ahí y volvé ' +
          'a tocar el botón.'
      );
    }

    const carpetaWsl =
      session.entorno.tipo === 'wsl' ? posixAWindows(session.entorno.distro, session.cwd) : null;
    if (carpetaWsl) await apuntarCwdAWindows(rutaDe(session), session.cwd, carpetaWsl);

    const { profile, relevo } = await profileForWork();
    return {
      ...(await openDesktopForProfile(profile, session.raiz, resumeLink(session.id))),
      relevo,
      carpetaWsl: carpetaWsl ?? undefined
    };
  });

  // El protocolo `claude://`, que es lo que decide si Desktop hace el login de
  // Google adentro de su ventana o lo manda al navegador. Ver `protocol.ts`.
  handle('protocol:status', async () => ({ nuestro: tenemosElProtocolo(), empaquetada: app.isPackaged }));
  handle('protocol:claim', async () => {
    const nuestro = tomar() && tenemosElProtocolo();
    anotar('protocolo: tomado a mano', { nuestro });
    return { nuestro };
  });
  handle('protocol:release', async () => {
    soltar();
    const nuestro = tenemosElProtocolo();
    anotar('protocolo: devuelto', { nuestro });
    return { nuestro };
  });

  // El registro, para poder ver desde la app lo que pasa afuera de ella.
  // Va junto con el log de la ventana de Desktop de la cuenta pedida: la
  // mitad de los problemas se explican comparando las dos horas.
  handle('logs:read', async (profileId?: string) => ({
    archivo: archivoDeRegistro(),
    panel: leer(),
    desktop: profileId ? await registroDeDesktop(desktopDir(profileId)) : []
  }));

  handle('sessions:list', async () => {
    const leidas = await barrerRaices();
    // Servido para el `sessions:tokens` que el panel dispara justo después.
    barridoServido = leidas;
    // Las raíces viajan con las sesiones: la UI necesita poder decir "distro
    // apagada" en vez de mostrar una lista corta sin explicación.
    return {
      sesiones: mezclarRaices(leidas.map((l) => l.sesiones)),
      raices: leidas.map((l) => l.raiz)
    };
  });
  // Reanuda con la cuenta de la sesión: la activa si es de Windows, como
  // siempre (su `projects` es el mismo directorio donde ya está el
  // transcript); la de la distro si es de WSL, porque ahí la activa puede ser
  // cualquier otra y el transcript sólo lo ve la cuenta de esa distro. Ver
  // `cuentaParaSesion`.
  handle('sessions:resume', async (id: string) => {
    const { session } = await findSession(id);
    const { profiles, activeProfileId } = await allProfiles();
    const target = cuentaParaSesion(session, profiles, activeProfileId);
    if (!target) {
      // Los dos casos son `null` pero tienen causas opuestas, y confundirlos
      // manda al usuario a hacer justo lo contrario de lo que necesita: en uno
      // falta dar de alta una cuenta de WSL, en el otro sobra la que está
      // activa. Ver `cuentaParaSesion`.
      const activa = profiles.find((p) => p.id === activeProfileId);
      throw new Error(
        session.entorno.tipo === 'wsl'
          ? `No hay ninguna cuenta dada de alta para la distro "${session.entorno.distro}": sin ella no se puede reanudar esta sesión sin arriesgarse a abrirla con la cuenta equivocada. Agregala con "Agregar cuenta de WSL" y volvé a intentar.`
          : activa?.entorno?.tipo === 'wsl'
            ? `La cuenta activa "${activa.name}" vive adentro de la distro "${activa.entorno.distro}" y esta sesión es de Windows: abrirla con esa cuenta arrancaría "claude" en el ~/.claude de la distro, que no contiene este transcript — la sesión no aparecería y nadie te diría por qué. Elegí arriba una cuenta de Windows y volvé a intentar.`
            : 'No hay ninguna cuenta activa con la que reanudar esta sesión.'
      );
    }
    await requireLogin(target);
    await openTerminalAs(session.cwd, `claude --resume ${session.id}`, target);
    // El aviso de cambio de cuenta por falta de cupo sólo tiene sentido en
    // Windows: ahí hay más de una cuenta candidata y cuál usar es decisión del
    // usuario. Una sesión de WSL tiene una única cuenta posible —la de su
    // distro—, así que no hay entre qué elegir ni cupo de otra que ofrecer.
    const relevo = session.entorno.tipo === 'wsl' ? null : (await profileForWork()).relevo;
    return {
      compactions: await countCompactions(rutaDe(session)),
      relevo
    };
  });
  // Una cuenta recién creada apunta a un CLAUDE_CONFIG_DIR vacío: no tiene
  // sesiones ni proyectos, y sin esto no habría forma de crear la primera
  // desde la app. Abre `claude` (sin --resume) en la carpeta elegida.
  handle('sessions:new', async (cwd?: string) => {
    const { profile, relevo } = await profileForWork();
    await requireLogin(profile);
    let dir = typeof cwd === 'string' && cwd ? cwd : null;
    if (!dir) {
      const picked = await dialog.showOpenDialog({
        title: 'Elegí la carpeta del proyecto',
        properties: ['openDirectory']
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      dir = picked.filePaths[0];
    }
    // `dir` no se traduce a POSIX acá aunque `profile` sea de WSL: el diálogo
    // es de Windows siempre (elija la carpeta que elija, incluso una dentro de
    // una distro por su UNC \\wsl.localhost\...), y `openTerminal` ->
    // `abrirEnWsl` YA hace `cwd.startsWith('/') ? cwd : windowsAPosix(distro,
    // cwd)` antes del `--cd`. Traducir acá también dejaría dos lugares con la
    // misma regla, que es justo lo que se evita: la traducción vive en un
    // único lugar, el que no se puede saltear.
    await openTerminalAs(dir, 'claude', profile);
    return { relevo };
  });
  // Leer el transcript completo, para verlo dentro de la app. La terminal
  // reproduce la conversación al reanudar, pero lo que pasa del scrollback se
  // pierde; acá está todo lo que quedó grabado.
  handle('sessions:transcript', async (id: string) => {
    const { session } = await findSession(id);
    return readTranscript(rutaDe(session));
  });
  // El consumo de cada sesión. Va aparte de `sessions:list` porque obliga a
  // leer los transcripts enteros —558 MB en esta máquina, 2,5 s la primera
  // vez— y la lista tiene que poder aparecer antes que los números. Después
  // sólo se relee el archivo de la sesión que está corriendo. Ver `tokens.ts`.
  handle('sessions:tokens', async () => {
    const leidas = barridoServido ?? (await barrerRaices());
    barridoServido = null;
    const sesiones = mezclarRaices(leidas.map((l) => l.sesiones));
    return tokensFor(sesiones.map((s) => ({ id: s.id, path: rutaDe(s) })));
  });
  handle('sessions:delete', async (id: string) => {
    const { session } = await findSession(id);
    // Mismo motivo que en `desktop:resume`: el botón deshabilitado es la
    // presentación, este canal es la frontera. Borrar sesiones de WSL no está
    // habilitado en esta rebanada (§9 del spec) — y acá el borrado sí
    // funcionaría por UNC, así que el guard no es decorativo.
    if (session.entorno.tipo === 'wsl') {
      throw new Error(`Borrar sesiones de ${session.entorno.distro} no está disponible todavía.`);
    }
    await deleteSession(session.raiz, session.projectSlug, session.id);
    return null;
  });

  // El alta de una cuenta que vive en una distro de WSL: listar las
  // instaladas para elegir, y crear el perfil adoptando su `~/.claude`.
  handle('profiles:listarDistros', async () => distrosInstaladas());
  handle('profiles:createWsl', (name: string, distro: string) => createWslProfile(name, distro));
  // Sólo acá se enciende una distro, y sólo porque el usuario apretó el botón.
  handle('wsl:encender', (distro: string) => encenderDistro(distro));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: join(import.meta.dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

/**
 * Le entrega un enlace `claude://` al Desktop que lo está esperando.
 *
 * Con el protocolo tomado, estos enlaces llegan acá en vez de a Desktop, y hay
 * que reenviarlos o dejarían de funcionar para todo el sistema. Se manda como
 * argumento de línea de comandos, que es como Desktop los acepta igual.
 *
 * A quién: a la última cuenta cuyo Desktop abrió la app, y sólo si fue hace
 * poco. El enlace no dice de quién es —viene de afuera, con su contenido y nada
 * más— pero el que lo espera es el que acaba de mandar al usuario al navegador.
 * Ese es el caso del login con Google, que es para lo que existe esto.
 *
 * Sin una apertura reciente se cae a la cuenta activa, que es lo mejor que se
 * puede suponer cuando el enlace llega de la nada.
 */
async function reenviarEnlace(url: string): Promise<void> {
  const esperando = esperandoEnlace();
  const profile = esperando ? await getProfile(esperando).catch(() => null) : null;
  const destino = profile ?? (await getActiveProfile());
  anotar('enlace claude:// recibido', {
    url,
    destino: destino.name,
    porque: profile ? 'ultima ventana abierta' : 'cuenta activa (sin apertura reciente)'
  });
  await openDesktopForProfile(destino, await getSharedRoot(), url).catch((error) => {
    anotar('enlace: NO se pudo reenviar', { error: String(error) });
  });
}

// Una sola instancia, para que un enlace del sistema no abra un panel nuevo
// sino que llegue al que ya está corriendo. Sin esto, Windows lanza otra copia
// entera de la app por cada `claude://`.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = enlaceEn(argv);
    if (url) void reenviarEnlace(url);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  // La app no tiene nada que ofrecer en un menú: ni archivos que abrir, ni
  // edición, ni ventanas. La barra de File/Edit/View/Window/Help es la que
  // Electron pone por defecto, y sólo ocupa lugar.
  Menu.setApplicationMenu(null);
  // Arregla las cuentas creadas antes de que las sesiones fueran compartidas.
  await shareAllProjects().catch(() => {});
  // Y las deja con los plugins del pozo, para que toda sesión arranque igual.
  await syncAllPlugins().catch(() => {});
  // Y sin el arranque de primera vez, que pide elegir método de ingreso.
  await markOnboardingAll().catch(() => {});
  // Y con el puente de Chrome apuntando cada uno a su propia cuenta.
  await ensureChromeHosts().catch(() => {});
  // El protocolo `claude://`, tomado al arrancar y sin preguntar.
  //
  // No es una preferencia: es lo que hace que agregar una cuenta de Desktop con
  // Google funcione. Sin esto, Desktop manda ese login al navegador, la
  // respuesta vuelve al Desktop de siempre y la cuenta queda guardada en el
  // lugar equivocado — o sea, la app no cumple lo que promete. Preguntarlo cada
  // vez era pedirle al usuario que decidiera sobre un detalle interno.
  //
  // Se puede devolver desde el panel; se vuelve a tomar en el próximo arranque.
  if (!tenemosElProtocolo()) tomar();
  anotar('panel: arrancado', { protocoloNuestro: tenemosElProtocolo(), empaquetada: app.isPackaged });
  registerHandlers();
  createWindow();
  // Windows puede haber lanzado la app PARA entregar un enlace: entonces no
  // llega por `second-instance` sino en la línea de comandos del arranque.
  const url = enlaceEn(process.argv);
  if (url) await reenviarEnlace(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
