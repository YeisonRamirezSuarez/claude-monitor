export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type Profile = {
  id: string;
  name: string;
  configDir: string;
  isDefault: boolean;
};

export type ProfileWithStatus = Profile & {
  /** El directorio de configuración existe en disco. */
  exists: boolean;
  /** Hay `.credentials.json` válido y no vencido. */
  authenticated: boolean;
};

/** Lo que se puede leer del contenido de un .jsonl. Deliberadamente sin `id`:
 *  el `sessionId` que traen las líneas puede ser el de la sesión padre cuando
 *  el archivo es un fork, así que no identifica al archivo. Ver `SessionMeta.id`. */
export type ParsedSession = {
  cwd: string;
  gitBranch: string;
  preview: string;
};

export type SessionMeta = ParsedSession & {
  /** Nombre del archivo sin `.jsonl`. Es la identidad real de la sesión: la que
   *  resuelve a un archivo en disco al borrar y la que espera `claude --resume`. */
  id: string;
  projectSlug: string;
  mtime: number;
  sizeBytes: number;
};

export type ProfileList = { activeProfileId: string; profiles: ProfileWithStatus[] };

export type ClaudeMonitorApi = {
  listProfiles: () => Promise<Result<ProfileList>>;
  createProfile: (name: string) => Promise<Result<Profile>>;
  setActiveProfile: (id: string) => Promise<Result<null>>;
  deleteProfile: (id: string) => Promise<Result<null>>;
  loginProfile: (id: string) => Promise<Result<null>>;
  listSessions: () => Promise<Result<SessionMeta[]>>;
  resumeSession: (id: string) => Promise<Result<null>>;
  deleteSession: (id: string) => Promise<Result<null>>;
};

declare global {
  interface Window {
    claudeMonitor: ClaudeMonitorApi;
  }
}
