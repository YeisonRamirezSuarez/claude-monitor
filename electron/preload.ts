import { contextBridge, ipcRenderer } from 'electron';
import type { ClaudeMonitorApi } from '../shared/types';

const api: ClaudeMonitorApi = {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (name) => ipcRenderer.invoke('profiles:create', name),
  setActiveProfile: (id) => ipcRenderer.invoke('profiles:setActive', id),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  listarDistrosWsl: () => ipcRenderer.invoke('profiles:listarDistros'),
  createWslProfile: (name, distro) => ipcRenderer.invoke('profiles:createWsl', name, distro),
  encenderDistro: (distro) => ipcRenderer.invoke('wsl:encender', distro),
  loginProfile: (id) => ipcRenderer.invoke('profiles:login', id),
  submitLoginCode: (id, code) => ipcRenderer.invoke('profiles:loginCode', id, code),
  cancelLogin: (id) => ipcRenderer.invoke('profiles:loginCancel', id),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  resumeSession: (id) => ipcRenderer.invoke('sessions:resume', id),
  newSession: (cwd) => ipcRenderer.invoke('sessions:new', cwd),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  readTranscript: (id) => ipcRenderer.invoke('sessions:transcript', id),
  sessionTokens: () => ipcRenderer.invoke('sessions:tokens'),
  openChrome: (id) => ipcRenderer.invoke('chrome:open', id),
  openDesktop: (id) => ipcRenderer.invoke('desktop:open', id),
  openDesktopIn: (cwd) => ipcRenderer.invoke('desktop:openIn', cwd),
  resumeInDesktop: (id) => ipcRenderer.invoke('desktop:resume', id),
  protocolStatus: () => ipcRenderer.invoke('protocol:status'),
  claimProtocol: () => ipcRenderer.invoke('protocol:claim'),
  releaseProtocol: () => ipcRenderer.invoke('protocol:release'),
  readLogs: (profileId) => ipcRenderer.invoke('logs:read', profileId)
};

contextBridge.exposeInMainWorld('claudeMonitor', api);
