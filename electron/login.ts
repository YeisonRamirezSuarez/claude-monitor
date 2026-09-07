import { spawn, type ChildProcess } from 'node:child_process';
import { sessionEnv } from './terminal';
import { WINDOWS } from './wsl';
import type { Entorno } from '../shared/types';

/**
 * El login de una cuenta, conducido desde la app.
 *
 * `claude auth login` no pide contraseña en la terminal: imprime una URL de
 * OAuth, espera a que el usuario autorice en un navegador, y después le pide
 * pegar un código. Corriéndolo en una terminal suelta, esa URL la abre el
 * navegador POR DEFECTO — el Chrome normal, con la sesión de claude.ai que haya
 * ahí. Eso hace dos cosas mal: obliga a un login aparte para el Chrome de la
 * cuenta, y si el navegador por defecto está logueado con OTRA cuenta, autoriza
 * la cuenta equivocada sin avisar.
 *
 * Acá el proceso se lanza con stdio conectado a la app: se lee la URL, se abre
 * en el Chrome de ESA cuenta, y el código que el usuario copia se manda por
 * stdin. Un solo recorrido, en la ventana correcta.
 *
 * El código pasa de la interfaz al stdin del proceso y no se guarda ni se
 * registra en ningún lado.
 */

/** Cuánto esperar la URL antes de dar el intento por fallido. */
const URL_TIMEOUT_MS = 20_000;

type Pending = { child: ChildProcess; output: string };
const pending = new Map<string, Pending>();

/**
 * Saca la URL de autorización de lo que imprime el CLI.
 *
 * La terminal la escribe como hipervínculo (secuencia OSC 8), que mete la
 * dirección DOS veces seguidas: una como destino del enlace y otra como texto
 * visible. Sin cortar en la segunda, la URL sale duplicada y no sirve.
 */
export function parseAuthUrl(output: string): string | null {
  const clean = output.replace(/\[[0-9;]*[a-zA-Z]/g, '');
  const match = clean.match(/https:\/\/[^\s\]]+/);
  if (!match) return null;
  const url = match[0];
  const repetida = url.indexOf('https://', 1);
  return repetida > 0 ? url.slice(0, repetida) : url;
}

/** Si el CLI ya terminó bien. Se mira el texto porque el código de salida llega
 *  después y la interfaz tiene que poder confirmar apenas pasa. */
export function looksSuccessful(output: string): boolean {
  return /logged in|login success|signed in|sesión iniciada/i.test(output);
}

/*
 * `claude auth login` abre la URL por su cuenta en el navegador por defecto, y
 * NO hay forma de impedírselo: no tiene una opción para eso —las únicas son
 * --claudeai, --console, --email y --sso— y pasarle un `BROWSER` que no abre
 * nada tampoco sirve. Medido con Chrome cerrado: con `BROWSER` apuntando a un
 * script mudo, igual levantó 8 procesos de Chrome. Coincide con lo que hace el
 * binario, que pisa o borra esa variable por su cuenta.
 *
 * Por eso la pestaña del CLI cae en el Chrome por defecto y la de la app en el
 * de la cuenta. Se prefiere que sobre una pestaña antes que autorizar en el
 * navegador equivocado, que era el problema original.
 */

/** Con qué se lanza el login. En Windows es un `.cmd`, que desde Node 20 no se
 *  puede spawnear sin shell; en WSL es el CLI de la distro, y ahí no hace falta
 *  shell porque `wsl.exe` es un ejecutable de verdad. */
export function comandoDeLogin(entorno: Entorno): {
  command: string;
  args: string[];
  shell: boolean;
} {
  if (entorno.tipo === 'wsl') {
    return {
      command: 'wsl.exe',
      args: ['-d', entorno.distro, '--', 'bash', '-lc', 'claude auth login'],
      shell: false
    };
  }
  return { command: 'claude', args: ['auth', 'login'], shell: true };
}

/**
 * Arranca el login y devuelve la URL a abrir.
 *
 * El proceso queda vivo esperando el código: hay que llamar a `submitCode` o a
 * `cancelLogin`. Un intento anterior de la misma cuenta se cancela, para no
 * dejar procesos colgados si el usuario le da dos veces.
 *
 * En una cuenta WSL, `env` (con el `CLAUDE_CONFIG_DIR` de esta cuenta) queda
 * puesto en el proceso `wsl.exe` de WINDOWS y no cruza a la distro —a
 * propósito, no se usa `WSLENV`, ver el comentario de `argsDeLanzamiento` en
 * `wsl.ts`—, así que el `claude` de adentro arranca sin esa variable y usa su
 * default, `$HOME/.claude`. Eso SÍ coincide con el `configDir` que la app
 * tiene registrado para la cuenta: `configDirUNC(distro, home)` en `wsl.ts` es
 * justamente la vista UNC de `$HOME/.claude`, con el mismo `home` que se le
 * preguntó a la distro una sola vez al darla de alta (`homeDe`, en `wsl.ts`).
 * No es casualidad — es la misma cuenta ($HOME) preguntada dos veces por el
 * mismo medio (`bash -lc`) — pero si el perfil de shell del usuario exporta un
 * `CLAUDE_CONFIG_DIR` propio en `.bashrc`/`.profile`, ese override gana y deja
 * de coincidir; ese riesgo ya existía antes de esta tarea (lo mismo le pasa a
 * `hayCliEn`) y no se resuelve acá.
 */
export async function startLogin(id: string, configDir: string, entorno: Entorno = WINDOWS): Promise<string> {
  cancelLogin(id);

  const env = sessionEnv(process.env, configDir);

  return new Promise((resolve, reject) => {
    const { command, args, shell } = comandoDeLogin(entorno);
    const child = spawn(command, args, { env, shell });
    const state: Pending = { child, output: '' };
    pending.set(id, state);

    const timer = setTimeout(() => {
      cancelLogin(id);
      reject(new Error('El login no devolvió una dirección para autorizar. Probá desde una terminal.'));
    }, URL_TIMEOUT_MS);

    // `String(chunk)` decodifica el Buffer como UTF-8 (default de
    // `Buffer.prototype.toString`). Con `wsl.exe` de por medio esto sigue
    // siendo correcto para el caso feliz: la salida del `claude` que corre
    // ADENTRO de la distro —la URL, "logged in"— la relaya tal cual, en los
    // bytes del proceso de Linux, que son UTF-8 (ver `decodificarSalidaWsl` en
    // `wsl.ts`). Donde esto se rompe es en un error de `wsl.exe` MISMO —distro
    // apagada que no llega a levantar, nombre de distro que ya no existe—, que
    // viene en UTF-16LE: decodificado como UTF-8 sale ilegible. El efecto es
    // sólo cosmético (el mensaje de error queda con mojibake en vez de texto
    // claro; `parseAuthUrl` igual da `null` y el flujo cae en el timeout o en
    // el `reject` de siempre) y es un caso de borde -la distro se cae DESPUÉS
    // de dada de alta la cuenta-, así que se deja así: no hace falta tocar
    // nada más para esta tarea.
    const listo = (chunk: unknown) => {
      state.output += String(chunk);
      const url = parseAuthUrl(state.output);
      if (!url) return;
      clearTimeout(timer);
      resolve(url);
    };
    child.stdout?.on('data', listo);
    child.stderr?.on('data', listo);

    child.once('error', (error) => {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      // Si salió sin haber dado la URL, el `reject` del timeout no llegó todavía.
      if (!parseAuthUrl(state.output)) reject(new Error(state.output.trim() || 'El login terminó sin decir nada.'));
    });
  });
}

/**
 * Manda el código que copió el usuario y espera el veredicto del CLI.
 *
 * Resuelve cuando el proceso termina bien; rechaza con lo que haya impreso, que
 * es lo único que explica por qué no entró.
 */
export function submitCode(id: string, code: string): Promise<void> {
  const state = pending.get(id);
  if (!state) throw new Error('No hay un login en curso para esta cuenta.');

  return new Promise((resolve, reject) => {
    state.child.once('exit', (status) => {
      pending.delete(id);
      if (status === 0 || looksSuccessful(state.output)) resolve();
      else reject(new Error(state.output.trim().split('\n').slice(-4).join(' ') || 'El login no se completó.'));
    });
    state.child.stdin?.write(`${code.trim()}\n`);
  });
}

export function cancelLogin(id: string): void {
  const state = pending.get(id);
  if (!state) return;
  pending.delete(id);
  state.child.kill();
}

/** Si esta cuenta tiene un login esperando el código. */
export const loginPending = (id: string) => pending.has(id);
