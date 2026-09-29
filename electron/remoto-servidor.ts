/**
 * El endpoint local al que le habla `hooks/remoto-hook.js`. Sólo en 127.0.0.1 y
 * con un token que se guarda en `remoto.json`, igual que hace Pixel Agents con
 * `server.json`. Una espera puede durar horas (un permiso que se contesta desde
 * el celular), así que el servidor no corta pedidos largos: Node trae
 * `requestTimeout` en 300 s por defecto, y con eso cada espera se soltaría sola
 * a los 5 minutos.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type EventoHook = {
  hook_event_name: string;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
};

export async function iniciarServidor(
  archivo: string,
  atender: (ev: EventoHook, señal: AbortSignal) => Promise<object>
): Promise<{ port: number; token: string; servidor: Server; cerrar: () => Promise<void> }> {
  const token = randomUUID();
  const servidor = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const controller = new AbortController();
    res.on('close', () => {
      // Si Claude Code mató el hook, abortamos la espera del puente.
      if (!res.writableEnded) controller.abort();
    });
    let cuerpo = '';
    req.on('data', (d) => (cuerpo += d));
    req.on('end', async () => {
      let salida: object = {};
      try {
        salida = await atender(JSON.parse(cuerpo) as EventoHook, controller.signal);
      } catch {
        salida = {};
      }
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(salida));
      }
    });
  });
  servidor.requestTimeout = 0;
  servidor.headersTimeout = 60_000;
  servidor.keepAliveTimeout = 5_000;
  servidor.timeout = 0;
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const port = (servidor.address() as { port: number }).port;
  await mkdir(dirname(archivo), { recursive: true });
  await writeFile(archivo, JSON.stringify({ port, token }), 'utf8');
  return {
    port,
    token,
    servidor,
    cerrar: async () => {
      servidor.closeAllConnections();
      await new Promise<void>((ok) => servidor.close(() => ok()));
      // Un puente que arrancó después ya escribió el suyo: borrarlo dejaría a los hooks sin a quién hablarle.
      const actual = await readFile(archivo, 'utf8').catch(() => '');
      if (actual === JSON.stringify({ port, token })) await rm(archivo, { force: true });
    }
  };
}
