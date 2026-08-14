import { spawn, type SpawnOptions } from 'node:child_process';
import { stat } from 'node:fs/promises';

/** Lanza el proceso y se resuelve recién cuando el SO confirma que arrancó.
 *  Sin esto el fallo es asíncrono: `spawn` no lanza, emite 'error', y un
 *  'error' sin listener es una excepción no capturada que tumba el proceso
 *  principal de Electron después de que el handler ya respondió ok. */
function launch(command: string, args: string[], options: SpawnOptions): Promise<void> {
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
 * Abre una terminal externa en `cwd` ejecutando `command` con
 * CLAUDE_CONFIG_DIR apuntando al perfil activo. Prefiere Windows Terminal;
 * si no está instalado, usa PowerShell.
 *
 * Rechaza si no se pudo abrir ninguna de las dos, para que el llamador pueda
 * mostrarle el error al usuario en vez de dejarlo mirando una ventana que
 * nunca aparece.
 */
export async function openTerminal(cwd: string, command: string, configDir: string): Promise<void> {
  // Un cwd inexistente hace fallar el spawn con el mismo ENOENT que un wt.exe
  // ausente, así que el fallback se dispararía por algo que no puede arreglar.
  // Se chequea antes para dar un error que el usuario entienda: pasa seguido,
  // porque la carpeta de un proyecto viejo pudo haberse movido o borrado.
  const dir = await stat(cwd).catch(() => null);
  if (!dir?.isDirectory()) {
    throw new Error(`No se puede abrir la terminal: la carpeta ya no existe (${cwd}).`);
  }

  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  const options: SpawnOptions = { cwd, env, detached: true, stdio: 'ignore' };

  // wt.exe reparsea su propia línea de comandos: trata ';' como separador de
  // subcomandos (cada uno puede nombrar un ejecutable) y hace su propio
  // seguimiento de comillas. `cwd` sale del contenido de un .jsonl, así que no
  // es confiable, y ambos caracteres son legales en NTFS. Si aparece cualquiera
  // de los dos se va directo a PowerShell, que recibe el directorio por
  // `options.cwd` y nunca por la línea de comandos.
  if (!/[;"]/.test(cwd)) {
    try {
      await launch('wt.exe', ['-d', cwd, 'powershell.exe', '-NoExit', '-Command', command], options);
      return;
    } catch {
      // Windows Terminal no está instalado: se cae a PowerShell.
    }
  }

  await launch('powershell.exe', ['-NoExit', '-Command', command], options);
}
