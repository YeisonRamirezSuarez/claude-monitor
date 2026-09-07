import { spawn, type SpawnOptions } from 'node:child_process';
import { stat } from 'node:fs/promises';

/** Lanza el proceso y se resuelve recién cuando el SO confirma que arrancó.
 *  Sin esto el fallo es asíncrono: `spawn` no lanza, emite 'error', y un
 *  'error' sin listener es una excepción no capturada que tumba el proceso
 *  principal de Electron después de que el handler ya respondió ok. */
export function launch(command: string, args: string[], options: SpawnOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

/**
 * El entorno de la terminal nueva: el del sistema sin ninguna variable de
 * Claude Code, más el CLAUDE_CONFIG_DIR de la cuenta.
 *
 * Si la app se abre desde adentro de una sesión de Claude Code hereda sus
 * marcadores (CLAUDE_CODE_CHILD_SESSION, CLAUDECODE, CLAUDE_CODE_SESSION_ID…),
 * y pasárselos a la terminal hace que el Claude de allá se crea un proceso
 * hijo y APAGUE el guardado del transcript:
 *
 *   "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"
 *
 * La sesión funciona, pero no deja `.jsonl`. Y como la app lista transcripts,
 * ese trabajo no aparece en ningún lado. Se borra todo lo que empiece con
 * CLAUDE: la terminal que abrimos es una sesión nueva e independiente, no la
 * hija de nadie.
 */
/*
 * Acá hubo un intento de mandar `BROWSER` apuntando al Chrome de la cuenta, para
 * que el login del CLI dejara de paso la sesión de claude.ai que necesita la
 * extensión. No funciona, por dos motivos independientes:
 *
 *   1. `BROWSER` tendría que ser un `.bat` (hace falta pasar
 *      `--profile-directory`), y desde Node 20 spawnear un `.bat` sin shell da
 *      EINVAL. Medido: shell=false falla, y ni con shell llegó la URL.
 *   2. Claude Code administra esa variable él mismo — la pisa con la del
 *      "attacher", o directamente la borra.
 *
 * Queda escrito para que no se vuelva a intentar.
 */
export function sessionEnv(base: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^CLAUDE/i.test(key)) env[key] = value;
  }
  // Barras normales, a propósito. `wt.exe` reparsea su línea de comandos y se
  // come las barras invertidas: "C:\\Users\\x\\perfil" llega como "C:Usersxperfil",
  // que es una ruta relativa válida y distinta. Claude Code la crea vacía, no
  // encuentra credenciales y pide login de nuevo — cada vez. Windows acepta las
  // dos formas, y las barras normales sobreviven el reparseo intactas.
  env.CLAUDE_CONFIG_DIR = configDir.split('\\').join('/');
  return env;
}

/** Comillas simples de PowerShell: adentro no se expande nada, y lo único que
 *  hay que escapar es la comilla misma, duplicándola. El nombre de la cuenta lo
 *  escribe el usuario y termina en la línea de comandos de un shell. */
export function psQuote(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

/**
 * El comando con un cartel arriba diciendo con qué cuenta se entra.
 *
 * Sin esto la terminal arranca y no hay forma de saber cuál de las cuentas está
 * gastando los tokens: `claude` no lo dice, y la carpeta de configuración no se
 * ve por ningún lado.
 *
 * Separa con salto de línea y no con ';' a propósito: `wt.exe` corta su línea
 * de comandos en cada ';' y lo que viene después se pierde. Probado — con ';'
 * la segunda sentencia no llega a ejecutarse; con salto de línea, sí, y
 * PowerShell lo toma como separador igual.
 */
export function bannerCommand(command: string, label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  if (!clean) return command;
  return [
    "Write-Host ''",
    `Write-Host ${psQuote(`  Cuenta: ${clean}`)} -ForegroundColor Cyan`,
    "Write-Host ''",
    command
  ].join('\n');
}

/** El nombre de la pestaña, para que la cuenta siga a la vista cuando el cartel
 *  ya quedó arriba en el scrollback. Sin ';' ni comillas, que son justo lo que
 *  `wt.exe` reparsea. */
export function tabTitle(label: string): string {
  return label.replace(/[;"]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Comilla simple de POSIX: adentro no se expande nada, y lo único que no se
 *  puede escapar es la comilla misma — hay que cerrar, escaparla y reabrir.
 *  Hermano de `psQuote`, y por la misma razón: el nombre de la cuenta lo
 *  escribe el usuario y termina en la línea de comandos de un shell. */
export function shQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** El mismo cartel que `bannerCommand`, del lado Linux: `Write-Host` adentro
 *  de Ubuntu no es nada. */
export function bannerBash(command: string, label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  if (!clean) return command;
  return [`printf '\\n  Cuenta: %s\\n\\n' ${shQuote(clean)}`, command].join('\n');
}

/**
 * Abre una terminal externa en `cwd` ejecutando `command` con
 * CLAUDE_CONFIG_DIR apuntando al perfil activo. Prefiere Windows Terminal;
 * si no está instalado, usa PowerShell.
 *
 * `label` identifica la cuenta y se muestra al entrar. Es opcional para que un
 * llamador que no la tenga a mano no quede obligado a inventarla.
 *
 * Rechaza si no se pudo abrir ninguna de las dos, para que el llamador pueda
 * mostrarle el error al usuario en vez de dejarlo mirando una ventana que
 * nunca aparece.
 */
export async function openTerminal(
  cwd: string,
  command: string,
  configDir: string,
  label = ''
): Promise<void> {
  // Un cwd inexistente hace fallar el spawn con el mismo ENOENT que un wt.exe
  // ausente, así que el fallback se dispararía por algo que no puede arreglar.
  // Se chequea antes para dar un error que el usuario entienda: pasa seguido,
  // porque la carpeta de un proyecto viejo pudo haberse movido o borrado.
  const dir = await stat(cwd).catch(() => null);
  if (!dir?.isDirectory()) {
    throw new Error(`No se puede abrir la terminal: la carpeta ya no existe (${cwd}).`);
  }

  const options: SpawnOptions = { cwd, env: sessionEnv(process.env, configDir), detached: true, stdio: 'ignore' };
  const full = bannerCommand(command, label);
  const title = tabTitle(label);

  // wt.exe reparsea su propia línea de comandos: trata ';' como separador de
  // subcomandos (cada uno puede nombrar un ejecutable) y hace su propio
  // seguimiento de comillas. `cwd` sale del contenido de un .jsonl, así que no
  // es confiable, y ambos caracteres son legales en NTFS. Si aparece cualquiera
  // de los dos se va directo a PowerShell, que recibe el directorio por
  // `options.cwd` y nunca por la línea de comandos.
  if (!/[;"]/.test(cwd)) {
    const args = ['-d', cwd, ...(title ? ['--title', title] : []), 'powershell.exe', '-NoExit', '-Command', full];
    try {
      await launch('wt.exe', args, options);
      return;
    } catch {
      // Windows Terminal no está instalado: se cae a PowerShell.
    }
  }

  await launch('powershell.exe', ['-NoExit', '-Command', full], options);
}
