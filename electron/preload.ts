import { contextBridge, ipcRenderer } from 'electron';
import type { ClaudeMonitorApi } from '../shared/types';

const api: ClaudeMonitorApi = {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (name) => ipcRenderer.invoke('profiles:create', name),
  setActiveProfile: (id) => ipcRenderer.invoke('profiles:setActive', id),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  loginProfile: (id) => ipcRenderer.invoke('profiles:login', id),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  resumeSession: (id) => ipcRenderer.invoke('sessions:resume', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id)
};

contextBridge.exposeInMainWorld('claudeMonitor', api);
