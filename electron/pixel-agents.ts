/**
 * El servidor de Pixel Agents que se ve en la pestaña Oficina.
 *
 * Pixel Agents (MIT, `vendor/pixel-agents`) trae la oficina completa: editor
 * de layout, muebles, mascotas, ampliar la oficina, la animación al entrar un
 * agente. Se embebe compilado en vez de portarlo; lo único propio es un parche
 * para que lea las carpetas de todas las cuentas (ver
 * `vendor/pixel-agents/claude-monitor.patch`).
 *
 * Corre con el Node que trae Electron (`ELECTRON_RUN_AS_NODE`), así la app
 * instalada no depende de que haya Node en la máquina. Guarda su layout y su
 * configuración en `~/.pixel-agents`, igual que si se corriera a mano: lo que
 * ya se había armado ahí aparece tal cual.
 *
 * La portable se descomprime en `%TEMP%`, y el Sensor de almacenamiento de
 * Windows borra de ahí lo que no está abierto: con la app andando desde el día
 * anterior, `resources\pixel-agents` quedó con 0 archivos y la oficina daba 404
 * (el servidor seguía vivo, pero la página ya no existía). Por eso, empaquetada,
 * corre desde una copia en `%LOCALAPPDATA%`, que esa limpieza no toca.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { anotar } from './registro';

let proceso: ChildProcess | null = null;
let url: Promise<string> | null = null;
let reinicio: NodeJS.Timeout | null = null;
let espera: number | null = null;

/**
 * Cuánto esperar antes de relanzar el servidor tras una caída. Arranca en 3 s y
 * se duplica si cae de nuevo enseguida (tope 60 s, para no girar en falso si
 * está roto de verdad); si había corrido 5 min o más, la caída es cosa nueva.
 * Motivo: el servidor murió por falta de memoria tras 34 h y la oficina quedó
 * congelada hasta reiniciar la app.
 */
export function esperaReinicio(previa: number | null, corrioMs: number): number {
  if (previa === null || corrioMs >= 5 * 60_000) return 3000;
  return Math.min(previa * 2, 60_000);
}

/** Lo que tiene que estar para que el servidor arranque y sirva la página. */
const completa = (dir: string) =>
  ['.completa', 'fs-sin-fuga.cjs', join('dist', 'cli.js'), join('dist', 'webview', 'index.html')].every((f) =>
    existsSync(join(dir, f))
  );

/**
 * Deja `origen` copiado en `<base>/<versión>` y devuelve esa carpeta. No copia
 * de nuevo si ya está completa; la rehace si le falta algo (una copia a medias,
 * o archivos que alguien borró). Las copias de otras versiones se borran: quedan
 * de actualizaciones anteriores y la app corre de a una instancia por vez.
 */
export async function prepararCopia(origen: string, base: string, version: string): Promise<string> {
  const destino = join(base, version);
  if (!completa(destino)) {
    await rm(destino, { recursive: true, force: true });
    await cp(origen, destino, { recursive: true });
    await writeFile(join(destino, '.completa'), '');
  }
  for (const otra of await readdir(base).catch(() => [] as string[])) {
    if (otra !== version) await rm(join(base, otra), { recursive: true, force: true }).catch(() => {});
  }
  return destino;
}

async function cli(): Promise<string> {
  if (!app.isPackaged) return join(app.getAppPath(), 'vendor', 'pixel-agents', 'dist', 'cli.js');
  const base = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'claude-monitor', 'pixel-agents');
  const dir = await prepararCopia(join(process.resourcesPath, 'pixel-agents'), base, app.getVersion());
  return join(dir, 'dist', 'cli.js');
}

/** La URL de la oficina, arrancando el servidor la primera vez. La URL lleva
 *  el token que habilita, adentro de la oficina, instalar los hooks. */
export function urlOficina(): Promise<string> {
  if (!url) {
    // Si falló la copia, el próximo pedido la reintenta. Si falla el servidor
    // se ocupa su `exit`: soltarlo acá antes lanzaría un segundo servidor.
    const p: Promise<string> = cli()
      .catch((e) => {
        if (url === p) url = null;
        throw e;
      })
      .then(arrancar);
    url = p;
  }
  return url;
}

function arrancar(ruta: string): Promise<string> {
  return new Promise<string>((ok, mal) => {
    // `fs-sin-fuga.cjs` tapa una fuga de memoria del Node de Electron (ver ahí).
    const hijo = spawn(process.execPath, ['--require', join(ruta, '..', '..', 'fs-sin-fuga.cjs'), ruta], {
      cwd: homedir(),
      // Con el pid de la app, el servidor se cierra solo si la app muere sin
      // pasar por `detenerOficina` (crash, Administrador de tareas).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PIXEL_AGENTS_PARENT_PID: String(process.pid) },
      windowsHide: true
    });
    proceso = hijo;
    const desde = Date.now();
    const plazo = setTimeout(() => {
      mal(new Error('Pixel Agents no arrancó en 30 s. Mirá el registro.'));
      // Colgado no sirve de nada y su promesa ya quedó rechazada: se lo mata y
      // el `exit` de abajo lo relanza.
      hijo.kill();
    }, 30_000);
    let salida = '';
    hijo.stdout?.on('data', (d: Buffer) => {
      salida += d.toString();
      const m = /server running at (http:\/\/\S+)/.exec(salida);
      if (m) {
        clearTimeout(plazo);
        ok(m[1]);
      }
    });
    hijo.stderr?.on('data', (d: Buffer) => anotar(`[pixel-agents] ${d.toString().trim()}`));
    const cayo = (code: number | null | string) => {
      clearTimeout(plazo);
      anotar(`[pixel-agents] terminó con código ${code}`);
      mal(new Error(`Pixel Agents se cerró (código ${code}). Mirá el registro.`));
      // Si `detenerOficina` lo paró a propósito, `proceso` ya no es este y no
      // se relanza nada.
      if (proceso !== hijo) return;
      proceso = null;
      espera = esperaReinicio(espera, Date.now() - desde);
      anotar(`[pixel-agents] se reinicia en ${espera / 1000} s`);
      // Mientras espera, quien pida la URL recibe este error en vez de lanzar un
      // segundo servidor: la oficina pregunta cada pocos segundos y, sin esto,
      // uno que muere al arrancar giraría sin respetar la espera.
      const cerrado: Promise<string> = Promise.reject(new Error(`Pixel Agents se cerró (código ${code}); se reinicia en ${espera / 1000} s.`));
      cerrado.catch(() => {});
      url = cerrado;
      reinicio = setTimeout(() => {
        if (url === cerrado) url = null;
        urlOficina().catch((e) => anotar('pixel-agents: no reinició', { error: String(e) }));
      }, espera);
    };
    hijo.on('exit', cayo);
    // Si no se pudo ni lanzar (ENOENT) no hay `exit`: mismo camino. Si llegan los
    // dos, el segundo no hace nada porque `proceso` ya no es este.
    hijo.on('error', (e) => cayo(String(e)));
  });
}

export function detenerOficina(): void {
  espera = null;
  if (reinicio) clearTimeout(reinicio);
  proceso?.kill();
  proceso = null;
  url = null;
}
