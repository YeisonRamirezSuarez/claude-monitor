/** En qué estado está la raíz de una cuenta WSL. Ninguno es silencioso: la
 *  lista vacía sin explicación es justo lo que hay que evitar. */
export type EstadoRaiz =
  | { tipo: 'ok' }
  | { tipo: 'sin-distro'; mensaje: string }
  | { tipo: 'apagada'; mensaje: string }
  | { tipo: 'sin-config'; mensaje: string }
  | { tipo: 'sin-cli'; mensaje: string };

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Dónde vive una instalación de Claude Code.
 *
 *  Es opcional en `Profile` a propósito: su ausencia significa Windows, que es
 *  el caso de siempre, así que un `profiles.json` escrito antes de esto sigue
 *  siendo válido y no hace falta migrarlo. */
export type Entorno =
  | { tipo: 'windows' }
  | { tipo: 'wsl'; distro: string; home: string };

/** Una raíz de lectura y en qué estado está. Viaja por IPC: la UI necesita
 *  poder decir "distro apagada" en vez de mostrar una lista corta y muda. */
export type Raiz = { configDir: string; entorno: Entorno; estado: EstadoRaiz };

export type Profile = {
  id: string;
  name: string;
  configDir: string;
  isDefault: boolean;
  entorno?: Entorno;
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
  /** De dónde salieron los números, por orden de confianza. `vivo` es la API en
   *  este momento; `guardado` es lo último que la API contestó, que el panel
   *  conserva en disco para que un tropiezo no borre las barras; `cli` es la
   *  caché que escribe Claude Code, que puede estar días atrasada. */
  origen: 'vivo' | 'guardado' | 'cli';
  /** Por qué no se pudo consultar en vivo, o '' si se pudo. Ver `MotivoFalla`
   *  en `electron/usage.ts`. */
  motivo: string;
  /** Cuándo se trajeron estos números. 0 si no se sabe. */
  fetchedAtMs: number;
  limits: UsageLimit[];
};

export type ProfileWithStatus = Profile & {
  /** El directorio de configuración existe en disco. */
  exists: boolean;
  /** Hay `.credentials.json` válido y no vencido. */
  authenticated: boolean;
  /** Cuándo vence la sesión según el archivo. `null` con `authenticated` en
   *  `true` significa que el archivo no lo dice y se está suponiendo. */
  authExpiresAt: number | null;
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
  /** La raíz que contiene este archivo. Va la RAÍZ y no un `profileId` porque
   *  por el pozo muchas cuentas Windows comparten una sola raíz: atar la
   *  sesión a una cuenta sería falso. */
  raiz: string;
  /** Dónde se reanuda. La UI la usa para la marca; el lanzador, para el shell. */
  entorno: Entorno;
};

export type ChromeStatus = {
  profileExists: boolean;
  extension: boolean;
  loggedIn: boolean;
  /** Esta lectura pudo abrir los archivos de Chrome. En `false`, lo de arriba
   *  sale del registro en disco y puede tener cualquier antigüedad. */
  verified: boolean;
  /** Cuándo se observó lo más viejo de lo que se afirma. 0 = nunca se pudo. */
  seenAt: number;
};

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

/** Lo que la app tiene para contar de una apertura: cuánto se perdió por
 *  compactación, y si hubo que cambiar de cuenta por falta de cupo. */
export type ResumeResult = { compactions: number; relevo: string | null };

/** Se cambió de cuenta al abrir porque la activa no tenía cupo, con la
 *  explicación para mostrar. `null` cuando se abrió con la de siempre. */
export type Relevo = { relevo: string | null };

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
  /** Las distros de WSL instaladas, para elegir una al dar de alta una cuenta
   *  que vive ahí. No enciende ninguna: `wsl -l -q` lista sin tocar el disco. */
  listarDistrosWsl: () => Promise<Result<string[]>>;
  /** Da de alta una cuenta que vive en una distro de WSL. El `configDir` es
   *  ADOPTADO: no se crea nada en disco. Ver `createWslProfile` en `profiles.ts`. */
  createWslProfile: (name: string, distro: string) => Promise<Result<Profile>>;
  /** Enciende una distro a propósito, porque el usuario apretó el botón. Es el
   *  único lugar de la app que lo hace — ver `encenderDistro` en `wsl.ts`. */
  encenderDistro: (distro: string) => Promise<Result<void>>;
  /** Arranca el login de una cuenta y abre la autorización en el Chrome de esa
   *  misma cuenta, no en el navegador por defecto. Devuelve la URL abierta;
   *  después hay que mandar el código con `submitLoginCode`. */
  loginProfile: (id: string) => Promise<Result<LoginStart>>;
  /** El código que el usuario copia del navegador para terminar el login. */
  submitLoginCode: (id: string, code: string) => Promise<Result<null>>;
  cancelLogin: (id: string) => Promise<Result<null>>;
  /** Las sesiones de todas las raíces, ordenadas por fecha, junto con el
   *  estado de cada raíz — la UI necesita poder decir "distro apagada" en vez
   *  de mostrar una lista corta sin explicación. */
  listSessions: () => Promise<Result<{ sesiones: SessionMeta[]; raices: Raiz[] }>>;
  /** Reanuda con la cuenta ACTIVA: es la que consume los tokens. Devuelve
   *  cuántas veces se compactó — si es > 0, Claude arranca desde el último
   *  resumen y el historial previo no vuelve. */
  resumeSession: (id: string) => Promise<Result<ResumeResult>>;
  /** Abre una terminal nueva corriendo `claude` en `cwd` con la cuenta activa.
   *  Sin `cwd` pide la carpeta con el selector nativo. */
  newSession: (cwd?: string) => Promise<Result<Relevo | null>>;
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
  /** Abre el Claude Desktop de esta cuenta: su propia carpeta de datos, con su
   *  propio login, y `CLAUDE_CONFIG_DIR` puesto para que sus transcripts caigan
   *  en el mismo pozo que los de la terminal. `firstRun` avisa que esa ventana
   *  todavía no tiene sesión iniciada. */
  openDesktop: (id: string) => Promise<Result<DesktopOpenResult>>;
  /** Abre el Claude Desktop de la cuenta ACTIVA directamente en `cwd`, con una
   *  sesión nueva. Sin `cwd` pide la carpeta con el selector nativo, y devuelve
   *  `null` si se cancela. Desktop no sabe reanudar una sesión del CLI por id:
   *  lo más cerca es abrir su carpeta, y las sesiones del CLI de esa cuenta
   *  aparecen en el panel lateral de Desktop. */
  openDesktopIn: (cwd?: string) => Promise<Result<DesktopOpenResult | null>>;
  /** Reanuda esa misma conversación en el Claude Desktop de la cuenta activa.
   *  Desktop adopta el transcript del CLI por su id: es la conversación
   *  entera, no una sesión nueva en la misma carpeta. */
  resumeInDesktop: (id: string) => Promise<Result<DesktopOpenResult>>;
  /** Si esta app tiene el protocolo `claude://`. Hace falta para el login con
   *  Google de Desktop: la respuesta vuelve del navegador por ese enlace y hay
   *  que reenviarla a la ventana que la pidió. Reanudar y abrir carpetas en
   *  Desktop no dependen de esto: van como argumento al ejecutable. */
  protocolStatus: () => Promise<Result<ProtocolStatus>>;
  claimProtocol: () => Promise<Result<ProtocolStatus>>;
  releaseProtocol: () => Promise<Result<ProtocolStatus>>;
  /** El registro de la app y, si se pide una cuenta, las líneas que importan
   *  del log de su ventana de Claude Desktop. */
  readLogs: (profileId?: string) => Promise<Result<Logs>>;
};

export type DesktopOpenResult = {
  /** La carpeta de datos se acaba de crear: hay que iniciar sesión adentro. */
  firstRun: boolean;
  /** No se relanzó nada: la ventana de esa cuenta ya estaba abierta y no había
   *  nada que entregarle. Relanzar sin motivo reinicia un login de Google que
   *  esté a mitad de camino. */
  yaAbierta?: boolean;
  /** Cuántas ventanas de Desktop hay abiertas por fuera del panel, con la
   *  cuenta que se haya usado en el acceso directo de Windows. Se ven iguales a
   *  las del panel, así que conviene avisar antes de que se confundan. */
  ajenas?: number;
  relevo?: string | null;
  /**
   * La carpeta de trabajo de una sesión de WSL, en forma UNC, para poder
   * decírsela al usuario.
   *
   * Desktop importa la conversación entera y después no encuentra la carpeta:
   * el `cwd` del transcript es POSIX (`/home/…`) y del lado de Windows no
   * existe, así que muestra "La carpeta de trabajo ya no existe". No se puede
   * evitar desde acá — el enlace `claude://resume?session=…` sólo acepta el
   * `session`, verificado en el bundle de Desktop: su handler lee ese único
   * parámetro y la carpeta la saca del `.jsonl`—. Lo que sí se puede es
   * decirle al usuario exactamente qué pegar en "Elegir carpeta".
   */
  carpetaWsl?: string;
};

export type ProtocolStatus = { nuestro: boolean; empaquetada?: boolean };

export type Logs = {
  /** Dónde queda el registro en disco, para poder mandarlo. */
  archivo: string;
  panel: string[];
  desktop: string[];
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
