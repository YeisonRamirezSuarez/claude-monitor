import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iniciarServidor } from './remoto-servidor';

const HOOK = join(__dirname, 'hooks', 'remoto-hook.js');
let dir = '';
afterEach(async () => dir && rm(dir, { recursive: true, force: true }));

/** Corre el hook como lo haría Claude Code: evento por stdin, respuesta por stdout. */
function correrHook(appdata: string, evento: object, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((ok, mal) => {
    const h = execFile(process.execPath, [HOOK], { env: { ...process.env, APPDATA: appdata, ...extraEnv } }, (err, out) =>
      err ? mal(err) : ok(out)
    );
    h.stdin!.end(JSON.stringify(evento));
  });
}

describe('endpoint y hook', () => {
  it('el hook manda el evento y escribe lo que contesta el puente', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const archivo = join(dir, 'claude-monitor', 'remoto.json');
    const vistos: string[] = [];
    const srv = await iniciarServidor(archivo, async (ev, _señal) => {
      vistos.push(ev.hook_event_name);
      return { decision: 'block', reason: 'hola' };
    });
    expect(JSON.parse(await readFile(archivo, 'utf8'))).toEqual({ port: srv.port, token: srv.token });
    const out = await correrHook(dir, { hook_event_name: 'Stop', session_id: 's' });
    expect(JSON.parse(out)).toEqual({ decision: 'block', reason: 'hola' });
    expect(vistos).toEqual(['Stop']);
    await srv.cerrar();
    expect(existsSync(archivo)).toBe(false);
  });

  it('sin la app corriendo, el hook escribe {} y no traba nada', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    expect(JSON.parse(await correrHook(dir, { hook_event_name: 'Stop', session_id: 's' }))).toEqual({});
  });

  it('una sesión tomada no espera en su Stop', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const srv = await iniciarServidor(join(dir, 'claude-monitor', 'remoto.json'), async (_ev, _señal) => ({ decision: 'block', reason: 'x' }));
    const out = await correrHook(dir, { hook_event_name: 'Stop', session_id: 's' }, { CLAUDE_MONITOR_TOMADA: '1' });
    expect(JSON.parse(out)).toEqual({});
    await srv.cerrar();
  });

  // Final review M5: si otro servidor ya escribió su remoto.json, cerrar el viejo no se lo puede borrar.
  it('cerrar no borra el remoto.json de otro servidor', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const archivo = join(dir, 'remoto.json');
    const viejo = await iniciarServidor(archivo, async () => ({}));
    const nuevo = await iniciarServidor(archivo, async () => ({}));
    await viejo.cerrar();
    expect(JSON.parse(await readFile(archivo, 'utf8'))).toEqual({ port: nuevo.port, token: nuevo.token });
    await nuevo.cerrar();
    expect(existsSync(archivo)).toBe(false);
  });

  it('rechaza un token equivocado', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const srv = await iniciarServidor(join(dir, 'r.json'), async (_ev, _señal) => ({ x: 1 }));
    const r = await fetch(`http://127.0.0.1:${srv.port}/hook`, { method: 'POST', headers: { Authorization: 'Bearer otro' }, body: '{}' });
    expect(r.status).toBe(401);
    await srv.cerrar();
  });

  it('no corta esperas largas: requestTimeout en 0', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const srv = await iniciarServidor(join(dir, 'r.json'), async (_ev, _señal) => ({}));
    expect(srv.servidor.requestTimeout).toBe(0);
    expect(srv.servidor.headersTimeout).toBeGreaterThan(0);
    await srv.cerrar();
  });

  it('el hook funciona como CommonJS en un directorio sin package.json', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const archivo = join(dir, 'claude-monitor', 'remoto.json');
    const srv = await iniciarServidor(archivo, async (ev) => ({ ok: true }));

    // Copiar el hook a un subdirectorio sin package.json (como en %APPDATA%)
    const hooksDir = join(dir, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hookCopy = join(hooksDir, 'remoto-hook.js');
    await copyFile(HOOK, hookCopy);

    // Correr el hook copiado, con --no-experimental-detect-module si está disponible
    const args: string[] = [];
    if (process.allowedNodeEnvironmentFlags.has('--no-experimental-detect-module')) {
      args.push('--no-experimental-detect-module');
    }
    args.push(hookCopy);

    const out = await new Promise<string>((ok, mal) => {
      const h = execFile(process.execPath, args, { env: { ...process.env, APPDATA: dir } }, (err, out) =>
        err ? mal(err) : ok(out)
      );
      h.stdin!.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }));
    });

    expect(JSON.parse(out)).toEqual({ ok: true });
    await srv.cerrar();
  });

  it('abortSignal se activa cuando el cliente cierra la conexión', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    let abortado = false;
    const srv = await iniciarServidor(join(dir, 'r.json'), async (ev, señal) => {
      // Esperar hasta que la señal se aborte o timeout
      return new Promise((ok) => {
        if (señal.aborted) {
          abortado = true;
          return ok({});
        }
        const cleanup = () => {
          abortado = true;
          ok({});
        };
        señal.addEventListener('abort', cleanup);
        // Timeout para que no cuelgue el test si el abort no llega
        const timeout = setTimeout(() => {
          señal.removeEventListener('abort', cleanup);
          ok({});
        }, 1000);
        señal.addEventListener('abort', () => {
          clearTimeout(timeout);
          cleanup();
        });
      });
    });

    const controller = new AbortController();
    const req = fetch(`http://127.0.0.1:${srv.port}/hook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal
    });

    // Esperar un poco y abortar del lado del cliente
    await new Promise((ok) => setTimeout(ok, 50));
    controller.abort();

    // Esperar a que se resuelva (aunque el cliente lo haya abortado)
    try {
      await req;
    } catch {
      // Se espera que falle, pero no nos importa
    }

    // Dar tiempo para que el servidor procese el abort
    await new Promise((ok) => setTimeout(ok, 50));
    expect(abortado).toBe(true);

    await srv.cerrar();
  });
});
