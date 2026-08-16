import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureHostScript } from './chrome-host';
import { chromeStatus, openChromeForProfile } from './chrome-launch';
import { isLoggedIn } from './credentials';
import { cancelLogin, startLogin, submitCode } from './login';
import { markOnboardingDone } from './onboarding';
import {
  createProfile,
  deleteProfile,
  getActiveProfile,
  getProfile,
  getSharedRoot,
  listProfiles,
  setActiveProfile,
  ensureChromeHosts,
  markOnboardingAll,
  shareAllProjects,
  syncAllPlugins
} from './profiles';
import { countCompactions, deleteSession, listSessions } from './sessions';
import { openTerminal } from './terminal';
import { readTranscript } from './transcript';
import { readUsage } from './usage';
import type { Profile, Result } from '../shared/types';

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
  const session = (await listSessions(sharedRoot)).find((s) => s.id === id);
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
    `La cuenta "${profile.name}" no tiene la sesión iniciada. Hacelo desde acá con "Iniciar sesión": ` +
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
  await ensureHostScript(profile.configDir, await getSharedRoot()).catch((error) => {
    console.warn('No se pudo fijar la cuenta en el puente de Chrome:', error);
  });
  const usage = await readUsage(profile.configDir).catch(() => null);
  const label = usage?.email ? `${profile.name} · ${usage.email}` : profile.name;
  await openTerminal(cwd, command, profile.configDir, label);
}

function registerHandlers() {
  handle('profiles:list', () => listProfiles());
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

    // El navegador de la cuenta tiene que estar logueado ANTES de esto.
    //
    // `claude auth login` abre su propia pestaña en el navegador por defecto y
    // no se le puede impedir: si el usuario autoriza ahí, la sesión de
    // claude.ai queda guardada en el Chrome equivocado y el de la cuenta sigue
    // vacío — que es exactamente por qué la extensión no funcionaba. Con la
    // sesión ya iniciada acá, la pestaña que abre la app muestra el botón de
    // autorizar directo, sin pedir login, y la otra queda como ruido inofensivo.
    const estado = await chromeStatus(profile.id, profile.name);
    if (!estado.loggedIn) {
      await openChromeForProfile(profile.id, profile.name).catch(() => {});
      throw new Error(
        `Primero iniciá sesión en claude.ai dentro del Chrome de "${profile.name}", que se acaba de abrir. ` +
          'Después volvé y tocá "Iniciar sesión". Si autorizás en tu Chrome de siempre, la sesión queda guardada ahí y la extensión no funciona.'
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
    await markOnboardingDone(profile.configDir, await getSharedRoot()).catch(() => {});
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

  handle('sessions:list', async () => listSessions(await getSharedRoot()));
  // Reanuda con la cuenta activa. No hay que mover nada: su `projects` es el
  // mismo directorio donde ya está el transcript.
  handle('sessions:resume', async (id: string) => {
    const { sharedRoot, session } = await findSession(id);
    const target = await getActiveProfile();
    await requireLogin(target);
    await openTerminalAs(session.cwd, `claude --resume ${session.id}`, target);
    return {
      compactions: await countCompactions(join(sharedRoot, 'projects', session.projectSlug, `${session.id}.jsonl`))
    };
  });
  // Una cuenta recién creada apunta a un CLAUDE_CONFIG_DIR vacío: no tiene
  // sesiones ni proyectos, y sin esto no habría forma de crear la primera
  // desde la app. Abre `claude` (sin --resume) en la carpeta elegida.
  handle('sessions:new', async (cwd?: string) => {
    const profile = await getActiveProfile();
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
    return null;
  });
  // Leer el transcript completo, para verlo dentro de la app. La terminal
  // reproduce la conversación al reanudar, pero lo que pasa del scrollback se
  // pierde; acá está todo lo que quedó grabado.
  handle('sessions:transcript', async (id: string) => {
    const { sharedRoot, session } = await findSession(id);
    return readTranscript(join(sharedRoot, 'projects', session.projectSlug, `${session.id}.jsonl`));
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
  registerHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
