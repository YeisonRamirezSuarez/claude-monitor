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
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { anotar } from './registro';

let proceso: ChildProcess | null = null;
let url: Promise<string> | null = null;

const cli = () =>
  app.isPackaged
    ? join(process.resourcesPath, 'pixel-agents', 'dist', 'cli.js')
    : join(app.getAppPath(), 'vendor', 'pixel-agents', 'dist', 'cli.js');

/** La URL de la oficina, arrancando el servidor la primera vez. La URL lleva
 *  el token que habilita, adentro de la oficina, instalar los hooks. */
export function urlOficina(): Promise<string> {
  url ??= new Promise<string>((ok, mal) => {
    const hijo = spawn(process.execPath, [cli()], {
      cwd: homedir(),
      // Con el pid de la app, el servidor se cierra solo si la app muere sin
      // pasar por `detenerOficina` (crash, Administrador de tareas).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PIXEL_AGENTS_PARENT_PID: String(process.pid) },
      windowsHide: true
    });
    proceso = hijo;
    const plazo = setTimeout(() => mal(new Error('Pixel Agents no arrancó en 30 s. Mirá el registro.')), 30_000);
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
    hijo.on('exit', (code) => {
      clearTimeout(plazo);
      anotar(`[pixel-agents] terminó con código ${code}`);
      proceso = null;
      url = null;
      mal(new Error(`Pixel Agents se cerró (código ${code}). Mirá el registro.`));
    });
  });
  return url;
}

export function detenerOficina(): void {
  proceso?.kill();
  proceso = null;
  url = null;
}
