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
  /** Qué le falta al Chrome de esta cuenta para que ande la extensión. */
  chrome: ChromeStatus;
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

export type ChromeStatus = { profileExists: boolean; extension: boolean; loggedIn: boolean };

/**
 * Lo que consumió una sesión, sacado de su transcript.
 *
 * Los cuatro números van separados a propósito: la lectura de caché suele ser
 * el grueso del volumen y es la más barata de todas, así que sumarla con la
 * entrada normal daría una cifra que asusta y no significa nada.
 */
export type SessionTokens = {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  /** Respuestas del modelo, ya sin contar las repetidas. */
  requests: number;
  /** Los modelos que atendieron esta sesión. */
  models: string[];
};

export type ResumeResult = { compactions: number };

/** Un turno de la conversación, ya sin la maquinaria de herramientas. */
export type TranscriptMessage = {
  role: 'user' | 'assistant';
  text: string;
  /** Cuántas herramientas usó el asistente en ese turno. Un turno que sólo
   *  ejecutó comandos no tiene texto, y sin esto se vería como un hueco. */
  tools: number;
  timestamp: string;
};

export type Transcript = {
  cwd: string;
  messages: TranscriptMessage[];
  /** Se corto por el tope de mensajes. */
  truncated: boolean;
};

export type ProfileList = { activeProfileId: string; profiles: ProfileWithStatus[] };

export type ClaudeMonitorApi = {
  listProfiles: () => Promise<Result<ProfileList>>;
  createProfile: (name: string) => Promise<Result<Profile>>;
  setActiveProfile: (id: string) => Promise<Result<null>>;
  deleteProfile: (id: string) => Promise<Result<null>>;
  /** Arranca el login de una cuenta y abre la autorización en el Chrome de esa
   *  misma cuenta, no en el navegador por defecto. Devuelve la URL abierta;
   *  después hay que mandar el código con `submitLoginCode`. */
  loginProfile: (id: string) => Promise<Result<LoginStart>>;
  /** El código que el usuario copia del navegador para terminar el login. */
  submitLoginCode: (id: string, code: string) => Promise<Result<null>>;
  cancelLogin: (id: string) => Promise<Result<null>>;
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
  /** El consumo de cada sesión, por id. Se pide aparte de `listSessions`
   *  porque hay que leer los transcripts enteros: la lista tiene que poder
   *  aparecer antes de que estén los números. */
  sessionTokens: () => Promise<Result<Record<string, SessionTokens>>>;
  /** La conversación completa de una sesión, leída del `.jsonl`. */
  readTranscript: (id: string) => Promise<Result<Transcript>>;
  /** Abre Chrome con el perfil de esta cuenta, que es lo que necesita la
   *  extensión: se autentica con la sesión web de claude.ai del navegador, no
   *  con el token del CLI. `firstRun` avisa que el perfil se acaba de crear y
   *  hay que iniciar sesión e instalar la extensión ahí. */
  openChrome: (id: string) => Promise<Result<ChromeOpenResult>>;
};

export type LoginStart = { url: string; needsExtension: boolean };

export type ChromeOpenResult = {
  firstRun: boolean;
  needsExtension: boolean;
  /** Al Chrome de la cuenta le falta la sesión de claude.ai. */
  needsLogin: boolean;
  pendingRename: boolean;
};

declare global {
  interface Window {
    claudeMonitor: ClaudeMonitorApi;
  }
}
