import { spawn, type ChildProcess } from 'node:child_process';
import { sessionEnv } from './terminal';

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

/**
 * Arranca el login y devuelve la URL a abrir.
 *
 * El proceso queda vivo esperando el código: hay que llamar a `submitCode` o a
 * `cancelLogin`. Un intento anterior de la misma cuenta se cancela, para no
 * dejar procesos colgados si el usuario le da dos veces.
 */
export function startLogin(id: string, configDir: string): Promise<string> {
  cancelLogin(id);

  return new Promise((resolve, reject) => {
    // `shell: true` porque en Windows `claude` se resuelve por PATH y puede ser
    // un .cmd, que desde Node 20 no se puede spawnear sin shell.
    const child = spawn('claude', ['auth', 'login'], {
      env: sessionEnv(process.env, configDir),
      shell: true
    });
    const state: Pending = { child, output: '' };
    pending.set(id, state);

    const timer = setTimeout(() => {
      cancelLogin(id);
      reject(new Error('El login no devolvió una dirección para autorizar. Probá desde una terminal.'));
    }, URL_TIMEOUT_MS);

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
