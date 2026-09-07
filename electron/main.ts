import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { readFile, stat } from 'node:fs/promises';
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
  createProfile,
  deleteProfile,
  getProfile,
  getSharedRoot,
  getActiveProfile,
  listProfiles,
  profileForWork,
  setActiveProfile,
  ensureChromeHosts,
  markOnboardingAll,
  shareAllProjects,
  syncAllPlugins
} from './profiles';
import { countCompactions, deleteSession, listSessions } from './sessions';
import { openTerminal } from './terminal';
import { tokensFor } from './tokens';
import { readTranscript } from './transcript';
import { readUsage } from './usage';
import { WINDOWS } from './wsl';
import type { Profile, ProfileWithStatus, Result } from '../shared/types';

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

/** Las sesiones son un pozo compartido: viven en un único directorio que todas
 *  las cuentas ven. La cuenta activa sólo decide qué credenciales se usan. */
async function findSession(id: string) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error(`Id de sesión inválido: ${id}`);
  const sharedRoot = await getSharedRoot();
  const session = (await listSessions(sharedRoot, WINDOWS)).find((s) => s.id === id);
  if (!session) throw new Error(`Sesión no encontrada: ${id}`);
  return { sharedRoot, session };
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
  await ensureHostScript(profile.configDir, await getSharedRoot(), profile.entorno).catch((error) => {
    console.warn('No se pudo fijar la cuenta en el puente de Chrome:', error);
  });
  const usage = await readUsage(profile.configDir).catch(() => null);
  const label = usage?.email ? `${profile.name} · ${usage.email}` : profile.name;
  await openTerminal(cwd, command, profile.configDir, label);
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

    const url = await startLogin(id, profile.configDir);
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
    const { profile, relevo } = await profileForWork();
    return { ...(await openDesktopForProfile(profile, await getSharedRoot(), resumeLink(session.id))), relevo };
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

  handle('sessions:list', async () => listSessions(await getSharedRoot(), WINDOWS));
  // Reanuda con la cuenta activa. No hay que mover nada: su `projects` es el
  // mismo directorio donde ya está el transcript.
  handle('sessions:resume', async (id: string) => {
    const { sharedRoot, session } = await findSession(id);
    const { profile: target, relevo } = await profileForWork();
    await requireLogin(target);
    await openTerminalAs(session.cwd, `claude --resume ${session.id}`, target);
    return {
      compactions: await countCompactions(join(sharedRoot, 'projects', session.projectSlug, `${session.id}.jsonl`)),
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
    await openTerminalAs(dir, 'claude', profile);
    return { relevo };
  });
  // Leer el transcript completo, para verlo dentro de la app. La terminal
  // reproduce la conversación al reanudar, pero lo que pasa del scrollback se
  // pierde; acá está todo lo que quedó grabado.
  handle('sessions:transcript', async (id: string) => {
    const { sharedRoot, session } = await findSession(id);
    return readTranscript(join(sharedRoot, 'projects', session.projectSlug, `${session.id}.jsonl`));
  });
  // El consumo de cada sesión. Va aparte de `sessions:list` porque obliga a
  // leer los transcripts enteros —558 MB en esta máquina, 2,5 s la primera
  // vez— y la lista tiene que poder aparecer antes que los números. Después
  // sólo se relee el archivo de la sesión que está corriendo. Ver `tokens.ts`.
  handle('sessions:tokens', async () => {
    const sharedRoot = await getSharedRoot();
    const sessions = await listSessions(sharedRoot, WINDOWS);
    return tokensFor(
      sessions.map((s) => ({ id: s.id, path: join(sharedRoot, 'projects', s.projectSlug, `${s.id}.jsonl`) }))
    );
  });
  handle('sessions:delete', async (id: string) => {
    const { sharedRoot, session } = await findSession(id);
    await deleteSession(sharedRoot, session.projectSlug, session.id);
    return null;
  });
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
