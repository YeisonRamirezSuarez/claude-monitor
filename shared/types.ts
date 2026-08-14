export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type Profile = {
  id: string;
  name: string;
  configDir: string;
  isDefault: boolean;
};

/** Un límite de consumo tal como lo reporta Claude Code. `kind` viene de la
 *  API (session, weekly_all, …) y `resetsAt` es ISO-8601 o null. */
export type UsageLimit = {
  kind: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
};

export type AccountUsage = {
  email: string;
  /** Nombre de la cuenta según la API. Vacío si no se pudo consultar en vivo. */
  accountName: string;
  plan: string;
  /** Los números salen de la API en este momento. Si es false son la caché
   *  que dejó el CLI, que puede estar horas atrasada. */
  live: boolean;
  /** Cuándo se trajeron estos números. 0 si no se sabe. */
  fetchedAtMs: number;
  limits: UsageLimit[];
};

export type ProfileWithStatus = Profile & {
  /** El directorio de configuración existe en disco. */
  exists: boolean;
  /** Hay `.credentials.json` válido y no vencido. */
  authenticated: boolean;
  /** Consumo cacheado por el CLI. null si la cuenta nunca se usó. */
  usage: AccountUsage | null;
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

export type ResumeResult = { compactions: number };

export type ProfileList = { activeProfileId: string; profiles: ProfileWithStatus[] };

export type ClaudeMonitorApi = {
  listProfiles: () => Promise<Result<ProfileList>>;
  createProfile: (name: string) => Promise<Result<Profile>>;
  setActiveProfile: (id: string) => Promise<Result<null>>;
  deleteProfile: (id: string) => Promise<Result<null>>;
  loginProfile: (id: string) => Promise<Result<null>>;
  /** Las sesiones del pozo compartido, ordenadas por fecha. */
  listSessions: () => Promise<Result<SessionMeta[]>>;
  /** Reanuda con la cuenta ACTIVA: es la que consume los tokens. Devuelve
   *  cuántas veces se compactó — si es > 0, Claude arranca desde el último
   *  resumen y el historial previo no vuelve. */
  resumeSession: (id: string) => Promise<Result<ResumeResult>>;
  /** Abre una terminal nueva corriendo `claude` en `cwd` con la cuenta activa.
   *  Sin `cwd` pide la carpeta con el selector nativo. */
  newSession: (cwd?: string) => Promise<Result<null>>;
  deleteSession: (id: string) => Promise<Result<null>>;
};

declare global {
  interface Window {
    claudeMonitor: ClaudeMonitorApi;
  }
}
