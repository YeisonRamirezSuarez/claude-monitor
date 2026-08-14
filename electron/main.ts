import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { join } from 'node:path';
import {
  createProfile,
  deleteProfile,
  getActiveProfile,
  getSharedRoot,
  listProfiles,
  setActiveProfile,
  shareAllProjects
} from './profiles';
import { countCompactions, deleteSession, listSessions } from './sessions';
import { openTerminal } from './terminal';
import type { Result } from '../shared/types';

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

function registerHandlers() {
  handle('profiles:list', () => listProfiles());
  handle('profiles:create', (name: string) => createProfile(name));
  handle('profiles:setActive', async (id: string) => {
    await setActiveProfile(id);
    return null;
  });
  handle('profiles:delete', async (id: string) => {
    await deleteProfile(id);
    return null;
  });
  handle('profiles:login', async (id: string) => {
    const { profiles } = await listProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`Perfil desconocido: ${id}`);
    await openTerminal(profile.configDir, 'claude auth login', profile.configDir);
    return null;
  });

  handle('sessions:list', async () => listSessions(await getSharedRoot()));
  // Reanuda con la cuenta activa. No hay que mover nada: su `projects` es el
  // mismo directorio donde ya está el transcript.
  handle('sessions:resume', async (id: string) => {
    const { sharedRoot, session } = await findSession(id);
    const target = await getActiveProfile();
    await openTerminal(session.cwd, `claude --resume ${session.id}`, target.configDir);
    return {
      compactions: await countCompactions(join(sharedRoot, 'projects', session.projectSlug, `${session.id}.jsonl`))
    };
  });
  // Una cuenta recién creada apunta a un CLAUDE_CONFIG_DIR vacío: no tiene
  // sesiones ni proyectos, y sin esto no habría forma de crear la primera
  // desde la app. Abre `claude` (sin --resume) en la carpeta elegida.
  handle('sessions:new', async (cwd?: string) => {
    const profile = await getActiveProfile();
    let dir = typeof cwd === 'string' && cwd ? cwd : null;
    if (!dir) {
      const picked = await dialog.showOpenDialog({
        title: 'Elegí la carpeta del proyecto',
        properties: ['openDirectory']
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      dir = picked.filePaths[0];
    }
    await openTerminal(dir, 'claude', profile.configDir);
    return null;
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
  registerHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
