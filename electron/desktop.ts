import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Profile } from '../shared/types';
import { parseRegistryPath } from './chrome-launch';
import { anotar } from './registro';
import { launch, sessionEnv } from './terminal';

const run = promisify(execFile);

/**
 * Claude Desktop por cuenta, con la misma separación que se usa para Chrome.
 *
 * Desktop no acepta argumentos propios: no hay `--resume`, ni forma de decirle
 * qué carpeta abrir. Y su login no es el del CLI — la app se autentica con la
 * cuenta de claude.ai que se inicia adentro, y guarda ese token en su carpeta
 * de datos de Electron, no en el `.credentials.json` de la cuenta. Por eso una
 * cuenta puede tener el CLI autorizado y Desktop no, o al revés.
 *
 * De ahí salen las dos cosas que hace este módulo:
 *
 *   1. `--user-data-dir` por cuenta. Es la bandera de Chromium que Electron
 *      hereda, y mueve TODO el estado de la app —token, historial, ajustes,
 *      MCP— a la carpeta que se le diga. Además el candado de instancia única
 *      va contra esa carpeta, así que dos cuentas pueden estar abiertas a la
 *      vez. Sin la bandera, abrir Desktop de nuevo sólo enfoca la ventana que
 *      ya estaba, con la cuenta que ya tenía.
 *
 *   2. `CLAUDE_CONFIG_DIR` en el entorno del proceso, apuntando al POZO y no a
 *      la carpeta de la cuenta. El motor que corre adentro de la pestaña Code
 *      es el mismo Claude Code y lee esa variable al arrancar, así que con eso
 *      sus transcripts caen donde la app los lista.
 *
 *      Va al pozo por una razón medida, no por comodidad: el `projects` de cada
 *      cuenta es un junction al del pozo, y Desktop LEE a través de un enlace
 *      así pero se niega a ESCRIBIR. Su propio log lo dice —"reads proceed
 *      through a symlinked directory below the config root (a relocated
 *      projects dir); writes there stay refused"— y reanudar una conversación
 *      es una escritura: al importarla reescribe el `.jsonl`. Apuntando a la
 *      carpeta de la cuenta, cada intento moría con `PlantDetectedError` y la
 *      app sólo mostraba "No se pudo abrir esa sesión desde Claude Code".
 *
 *      Que sea el pozo no mezcla cuentas: la cuenta de Desktop es la que está
 *      logueada adentro de su `--user-data-dir`, no la que diga esta variable.
 *      Y el pozo es justo donde las conversaciones tienen que caer, porque es
 *      compartido por todas las cuentas a propósito.
 *
 * `--user-data-dir` no está documentado por Anthropic: es de Chromium, y
 * Desktop lo hereda por ser Electron. Funciona hoy; si una versión lo apagara,
 * el síntoma sería que todas las cuentas abren la misma ventana.
 *
 * El login con Google, en Windows, SÍ sale al navegador del sistema —no se
 * queda adentro de la ventana como en macOS, que usa
 * `ASWebAuthenticationSession`—. Vuelve por un servidor HTTP que Desktop
 * levanta en `127.0.0.1` sólo para esa ventana. Con eso alcanza: cada
 * instancia escucha en su propio puerto, así que no hay forma de que la
 * respuesta aterrice en la cuenta equivocada. Lo que sí puede pasar, y pasó,
 * es que RELANZAR el ejecutable mientras ese login está a mitad de camino
 * hace que Desktop lo reinicie entero —tira la pestaña que el usuario ya
 * tenía abierta—. No hay forma de saber desde acá si un login está a mitad de
 * camino, así que no se bloquea el relanzamiento: sólo se evita el
 * DUPLICADO del mismo clic, con `ultimoLanzamiento` más abajo. Bloquear del
 * todo dejaba a una cuenta sin ventana visible —Desktop puede quedar
 * corriendo en segundo plano al cerrarla, como cualquier app con bandeja— sin
 * ninguna forma de traerla de vuelta.
 */

const localAppData = () => process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');

/** Dónde viven las carpetas de datos de Desktop, una por cuenta. */
export const desktopRoot = () => join(localAppData(), 'claude-monitor', 'desktop');

/** Igual que con Chrome: va por id y no por nombre, porque el nombre se puede
 *  cambiar y mover la carpeta le haría perder el login a esa cuenta.
 *
 *  Todas las cuentas van acá, la principal incluida: la carpeta propia de
 *  Desktop (`%APPDATA%\Claude`, la del acceso directo de Windows) queda afuera
 *  a propósito, porque la cuenta que esté logueada ahí no tiene por qué ser
 *  ninguna de las del panel. */
export function desktopDir(profileId: string): string {
  return join(desktopRoot(), profileId.replace(/[^A-Za-z0-9-]/g, ''));
}

/** Squirrel deja una carpeta por versión (`app-1.2.3`) y no borra las viejas,
 *  así que hay que elegir. Ordena por número y no alfabéticamente: `app-1.10.0`
 *  es más nueva que `app-1.9.0` y como texto queda antes. */
export function newestAppDir(names: string[]): string | null {
  const versions = names
    .map((name) => /^app-(\d+(?:\.\d+)*)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[0], parts: m[1].split('.').map(Number) }));
  if (versions.length === 0) return null;
  versions.sort((a, b) => {
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
      const diff = (b.parts[i] ?? 0) - (a.parts[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return versions[0].name;
}

/** El valor del registro viene entrecomillado y con los argumentos del
 *  protocolo pegados: `"C:\...\claude.exe" -- "%1"`. */
export function stripQuotes(path: string): string {
  return path.replace(/^"+/, '').replace(/"+$/, '').trim();
}

/**
 * Dónde está el ejecutable de la instalación de la Microsoft Store.
 *
 * Es la que instala hoy `claude.ai/download`, y la que no se puede encontrar
 * mirando el disco: vive en `C:\Program Files\WindowsApps`, que no se puede
 * listar, y no deja clave de protocolo en el registro —el manifiesto del
 * paquete declara `claude://` por su cuenta—. Se le pregunta al gestor de
 * paquetes, que es lo único que la ve.
 *
 * Contra lo que se lee por ahí, `WindowsApps` no impide LANZAR el ejecutable:
 * impide listar la carpeta. Medido en esta máquina: con la ruta completa,
 * `claude.exe --user-data-dir=…` arranca una instancia aparte, con su propia
 * carpeta de datos, conviviendo con la que ya estaba abierta.
 */
async function findStoreInstall(): Promise<string | null> {
  const stdout = await run('powershell', [
    '-NoProfile',
    '-Command',
    '(Get-AppxPackage -Name Claude | Select-Object -First 1).InstallLocation'
  ])
    .then((r) => r.stdout.trim())
    .catch(() => '');
  if (!stdout) return null;
  const path = join(stdout, 'app', 'claude.exe');
  return (await stat(path).catch(() => null)) ? path : null;
}

/**
 * Si una ruta puede ser el Claude Desktop y no otra cosa.
 *
 * Hace falta porque una de las fuentes es el registro del protocolo
 * `claude://`, y esa clave la puede tener cualquiera — incluida ESTA app, que
 * la toma para que el login de Google de Desktop no se vaya al navegador. Sin
 * este filtro, tomar el protocolo hacía que el botón "Desktop" abriera el
 * Electron del panel: la clave decía `electron.exe` y se lanzaba eso, con la
 * ventana de bienvenida de Electron y nada más.
 *
 * Dos condiciones. El nombre tiene que ser `claude.exe`, y no puede ser el
 * ejecutable con el que corre esta app.
 */
export function pareceClaudeDesktop(path: string, propio = process.execPath): boolean {
  if (basename(path).toLowerCase() !== 'claude.exe') return false;
  return path.toLowerCase() !== propio.toLowerCase();
}

/**
 * Dónde está el ejecutable de Claude Desktop.
 *
 * Tres instalaciones posibles y ninguna descarta a las otras: en esta máquina
 * conviven la MSIX de Desktop y el `claude.exe` del CLI, con el mismo nombre.
 *
 * El orden va de lo que no se puede falsear a lo que sí. Primero la carpeta de
 * Squirrel, que es una ruta fija en disco. Después la MSIX, que se la pregunta
 * al gestor de paquetes de Windows. Y recién al final el registro del
 * protocolo, que es el único que otro programa puede reescribir — y que esta
 * misma app reescribe. Antes iba primero, y por eso se rompía.
 */
export async function findClaudeDesktop(): Promise<string | null> {
  const base = join(localAppData(), 'AnthropicClaude');
  const dir = newestAppDir(await readdir(base).catch(() => []));
  if (dir) {
    const path = join(base, dir, 'claude.exe');
    if (pareceClaudeDesktop(path) && (await stat(path).catch(() => null))) return path;
  }

  const store = await findStoreInstall();
  if (store) return store;

  const output = await run('reg', ['query', 'HKCR\\claude\\shell\\open\\command', '/ve'])
    .then((r) => r.stdout)
    .catch(() => '');
  const fromRegistry = output && parseRegistryPath(output);
  if (!fromRegistry) return null;
  const path = stripQuotes(fromRegistry);
  if (!pareceClaudeDesktop(path)) return null;
  return (await stat(path).catch(() => null)) ? path : null;
}

/**
 * El enlace que Desktop entiende como "abrí una sesión nueva en esta carpeta".
 *
 * Desktop no tiene banderas propias —no hay `--resume` ni un argumento de
 * carpeta— pero sí registra el protocolo `claude://`, y acepta un enlace de
 * esos como argumento de línea de comandos: su propio arranque por alias
 * normaliza la carpeta que le pasan a exactamente esta forma antes de
 * procesarla. Sale del bundle de la app, no de la documentación, así que una
 * versión futura lo podría cambiar; el síntoma sería que Desktop abre pero se
 * queda donde estaba en vez de ir a la carpeta.
 */
export function newSessionLink(folder: string): string {
  return `claude://code/new?folder=${encodeURIComponent(folder)}`;
}

/** Los ids que Desktop acepta en el enlace de reanudar: UUID, igual que los del
 *  CLI. Cualquier otra cosa la descarta sin decir nada, así que se filtra acá
 *  para poder explicar el problema en vez de abrir una ventana muda. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * El enlace que hace que Desktop ADOPTE una sesión del CLI y siga la
 * conversación donde iba.
 *
 * Es lo mismo que hace `/desktop` desde la terminal. Desktop importa el
 * transcript de ese id —el `.jsonl` que ya está en `projects/` de la cuenta— y
 * abre la conversación entera, no una sesión nueva en la misma carpeta.
 *
 * Necesita dos cosas del entorno para encontrarlo: que Desktop esté logueado
 * (sin eso avisa "Sign in to the desktop app and try again") y que
 * `CLAUDE_CONFIG_DIR` apunte a la cuenta dueña del transcript.
 *
 * Sale del bundle de la app y no de la documentación. Si una versión lo
 * cambiara, el síntoma sería que Desktop abre pero no aparece la conversación.
 */
export function resumeLink(sessionId: string): string {
  if (!UUID.test(sessionId)) throw new Error(`Id de sesión inválido: ${sessionId}`);
  return `claude://resume?session=${sessionId}`;
}

/**
 * La última cuenta cuyo Desktop abrió la app, y cuándo.
 *
 * Existe para una sola cosa: saber a quién entregarle un enlace `claude://`
 * que llega de afuera. El caso que importa es el login con Google, que en
 * Windows SIEMPRE sale al navegador del sistema —la alternativa que Desktop
 * tiene para quedarse adentro, `ASWebAuthenticationSession`, es de macOS— y
 * vuelve por el protocolo. Ese enlace no dice de qué cuenta es.
 *
 * Reenviarlo a la cuenta activa estaba mal: el usuario abre el Desktop de la
 * cuenta que quiere agregar, se loguea, y la respuesta aterrizaba en otra
 * ventana — la cuenta quedaba guardada donde no era y la ventana que la pidió
 * seguía vacía. La que está esperando la respuesta es la última que se abrió.
 */
let ultimo: { profileId: string; enMs: number } | null = null;

/**
 * Cuándo se lanzó por última vez el Desktop de cada cuenta. Sirve para una
 * sola cosa: no relanzar dos veces por el mismo clic —doble clic, un tap que
 * quedó en cola— sin bloquear un clic deliberado más tarde.
 */
const ultimoLanzamiento = new Map<string, number>();

/** Ventana de gracia contra el clic duplicado. Corta, a propósito: lo bastante
 *  para absorber un doble clic, lo bastante poco para no dejar a alguien sin
 *  poder traer de vuelta una ventana que Desktop mandó a segundo plano. */
const DEBOUNCE_MS = 4000;

/**
 * Cuántas ventanas de Desktop hay abiertas POR FUERA del panel.
 *
 * Desktop trae su propio acceso directo de Windows, y ese abre la carpeta de
 * datos propia de la app, sin `--user-data-dir`. Esa ventana no es de ninguna
 * cuenta del panel: está logueada con lo que sea que se haya usado ahí, y el
 * panel no la administra ni la debe adoptar.
 *
 * El problema es que todas las ventanas de Desktop se ven iguales —mismo
 * título, mismo tamaño— así que una ventana ajena abierta atrás se confunde
 * con la de la cuenta que se acaba de abrir, y parece que el panel abrió la
 * cuenta equivocada. Contarlas alcanza para poder avisar.
 *
 * Sólo mira los procesos raíz (los sin `--type=`): cada ventana levanta varios
 * hijos que heredan la misma línea de comando y los contaría de más.
 *
 * Filtra además por la ruta del ejecutable, porque el CLI también se llama
 * `claude.exe` y estaría corriendo justo cuando se pregunta esto.
 */
export async function instanciasAjenas(): Promise<number> {
  const exe = await findClaudeDesktop();
  if (!exe) return 0;
  const raiz = desktopRoot().toLowerCase().replace(/'/g, "''");
  const ruta = exe.toLowerCase().replace(/'/g, "''");
  const stdout = await run('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq '${ruta}' -and $_.CommandLine -and -not $_.CommandLine.Contains('--type=') -and -not $_.CommandLine.ToLower().Contains('${raiz}') } | Measure-Object | ForEach-Object { $_.Count }`
  ])
    .then((r) => r.stdout)
    .catch(() => '');
  const n = Number(stdout.trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** La cuenta que probablemente esté esperando un enlace, o `null` si hace
 *  demasiado que no se abre ninguna. El corte es generoso: un login con Google
 *  pasa por el navegador, a veces por un segundo factor, y puede tardar. */
export function esperandoEnlace(ahora = Date.now(), ventanaMs = 15 * 60 * 1000): string | null {
  if (!ultimo) return null;
  return ahora - ultimo.enMs <= ventanaMs ? ultimo.profileId : null;
}

/**
 * Abre el Claude Desktop de esta cuenta.
 *
 * `firstRun` avisa que la carpeta de datos se acaba de crear: esa ventana
 * arranca sin sesión, y el login se hace ahí adentro, con la cuenta que
 * corresponda.
 *
 * Se puede abrir cuantas cuentas se quiera, y a la vez: cada una es su propia
 * instancia con su propio candado. Ver el comentario del cuerpo sobre por qué
 * acá no hace falta cerrar las demás para iniciar sesión.
 *
 * La ventana sobrevive a la app: se lanza `detached` y sin heredar stdio, así
 * que no muere ni cuando se cierra la consola desde la que se abrió el panel.
 * Medido: consola matada, ventana de Desktop intacta.
 */
export async function openDesktopForProfile(
  profile: Profile,
  configDir: string,
  link?: string
): Promise<{ firstRun: boolean; yaAbierta?: boolean; ajenas?: number }> {
  // Acá había un guard que se negaba a abrir Desktop para una cuenta de WSL,
  // por el §7 del spec: "Desktop es una app de Windows y no puede hospedar una
  // sesión de la distro". Eso YA NO ES CIERTO y bloqueaba justo a quien más
  // necesita esta app: Desktop trae su propio selector con Local / Nube /
  // Control remoto / WSL / SSH, y por WSL se elige la distro y después la
  // carpeta. Verificado además en su bundle, que arma las rutas de la distro
  // en forma UNC, igual que `posixAWindows` en `wsl.ts`.
  //
  // Y aunque no fuera cierto, este guard estaba en el lugar equivocado: lo que
  // hace esta función es abrir la VENTANA de una cuenta —su `--user-data-dir`,
  // su login—, que no tiene nada de Windows ni de la distro. El `configDir`
  // que se le pasa es el POZO, no el de la cuenta (ver los llamadores), así
  // que tampoco había nada que traducir. Lo único que seguía sin poder hacerse
  // era ADOPTAR un transcript que vive adentro de la distro, y ese guard vive
  // aparte, en `desktop:resume`.

  const exe = await findClaudeDesktop();
  if (!exe) {
    throw new Error(
      'No se encontró Claude Desktop. Instalá la app de escritorio desde claude.ai/download y volvé a intentar.'
    );
  }

  const dir = desktopDir(profile.id);
  const firstRun = !(await stat(dir).catch(() => null));

  // Bloquear el relanzamiento del todo estuvo mal: Desktop puede quedar
  // corriendo SIN ninguna ventana visible —lo manda a segundo plano al
  // cerrarla, como cualquier app con bandeja— y ahí relanzar es la ÚNICA
  // forma de traerla de vuelta. Un guard que nunca relanza deja a la cuenta
  // sin cómo abrirse nunca más.
  //
  // Lo que sí hay que evitar es el relanzamiento DUPLICADO del mismo clic: eso
  // fue lo que rompió el login la primera vez —no clics deliberados minutos
  // aparte, un doble disparo pegado en el tiempo—. Por eso el corte es por
  // tiempo, corto, y no por "hay una instancia corriendo, para siempre".
  const desde = ultimoLanzamiento.get(profile.id);
  if (!link && desde !== undefined && Date.now() - desde < DEBOUNCE_MS) {
    anotar('desktop: relanzamiento duplicado, se ignora', { cuenta: profile.name, dir });
    return { firstRun: false, yaAbierta: true };
  }

  ultimoLanzamiento.set(profile.id, Date.now());
  ultimo = { profileId: profile.id, enMs: Date.now() };
  const args = [`--user-data-dir=${dir}`, ...(link ? [link] : [])];
  anotar('desktop: abriendo', { cuenta: profile.name, exe, dir, enlace: link ?? '(ninguno)', configDir, firstRun });
  await launch(exe, args, {
    env: sessionEnv(process.env, configDir),
    detached: true,
    stdio: 'ignore'
  });
  const ajenas = await instanciasAjenas().catch(() => 0);
  if (ajenas) anotar('desktop: hay ventanas abiertas fuera del panel', { cuantas: ajenas });
  return { firstRun, ajenas };
}
