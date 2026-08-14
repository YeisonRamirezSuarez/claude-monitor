import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { createProfile, deleteProfile, getActiveProfile, listProfiles, setActiveProfile } from './profiles';
import { deleteSession, listSessions } from './sessions';
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

async function findSession(id: string) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error(`Id de sesión inválido: ${id}`);
  const profile = await getActiveProfile();
  const session = (await listSessions(profile.configDir)).find((s) => s.id === id);
  if (!session) throw new Error(`Sesión no encontrada: ${id}`);
  return { profile, session };
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

  handle('sessions:list', async () => listSessions((await getActiveProfile()).configDir));
  handle('sessions:resume', async (id: string) => {
    const { profile, session } = await findSession(id);
    await openTerminal(session.cwd, `claude --resume ${session.id}`, profile.configDir);
    return null;
  });
  handle('sessions:delete', async (id: string) => {
    const { profile, session } = await findSession(id);
    await deleteSession(profile.configDir, session.projectSlug, session.id);
    return null;
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
