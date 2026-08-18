// electron/tokens.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addLine, readTokens, tokensFor } from './tokens';

const vacio = () => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, requests: 0, models: [] as string[] });

/** Una línea de respuesta del modelo como la escribe Claude Code. */
const respuesta = (id: string, usage: Record<string, number>, model = 'claude-opus-5') =>
  JSON.stringify({
    type: 'assistant',
    requestId: `req_${id}`,
    message: { id, model, usage: { server_tool_use: { web_search_requests: 0 }, ...usage } }
  });

const USO = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 };

describe('addLine', () => {
  it('suma los cuatro tipos de token por separado', () => {
    const acc = vacio();
    addLine(acc, new Set(), respuesta('msg_1', USO));
    expect(acc).toMatchObject({ input: 10, output: 5, cacheCreate: 100, cacheRead: 1000, requests: 1 });
    expect(acc.models).toEqual(['claude-opus-5']);
  });

  it('cuenta una sola vez la respuesta partida en varias líneas (regresión: el doble de tokens)', () => {
    // Una respuesta larga deja una línea por bloque y TODAS repiten el mismo
    // usage. Sumando línea por línea, una sesión real daba 412 M de caché
    // leída contra 212 M verdaderos.
    const acc = vacio();
    const vistas = new Set<string>();
    for (let i = 0; i < 5; i++) addLine(acc, vistas, respuesta('msg_1', USO));
    expect(acc.requests).toBe(1);
    expect(acc.cacheRead).toBe(1000);
  });

  it('el id repetido no tiene que estar pegado: una sesión reanudada reescribe mensajes viejos', () => {
    const acc = vacio();
    const vistas = new Set<string>();
    addLine(acc, vistas, respuesta('msg_1', USO));
    addLine(acc, vistas, respuesta('msg_2', USO));
    addLine(acc, vistas, respuesta('msg_1', USO));
    expect(acc.requests).toBe(2);
  });

  it('ignora lo que no es consumo, sin romperse', () => {
    const acc = vacio();
    const vistas = new Set<string>();
    addLine(acc, vistas, '');
    addLine(acc, vistas, '{ esto no es json');
    addLine(acc, vistas, JSON.stringify({ type: 'user', message: { content: 'hablemos de usage' } }));
    addLine(acc, vistas, JSON.stringify({ type: 'assistant', message: { id: 'x', usage: null } }));
    expect(acc).toEqual(vacio());
  });

  it('anota cada modelo una vez: sirve para saber a qué precio se consumió', () => {
    const acc = vacio();
    const vistas = new Set<string>();
    addLine(acc, vistas, respuesta('a', USO, 'claude-opus-5'));
    addLine(acc, vistas, respuesta('b', USO, 'claude-sonnet-5'));
    addLine(acc, vistas, respuesta('c', USO, 'claude-opus-5'));
    expect(acc.models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('descarta números imposibles en vez de arrastrarlos al total', () => {
    const acc = vacio();
    addLine(acc, new Set(), respuesta('m', { ...USO, input_tokens: -5, output_tokens: Number.NaN } as never));
    expect(acc).toMatchObject({ input: 0, output: 0, cacheRead: 1000, requests: 1 });
  });

  it('no cuenta las respuestas que nunca llegaron a la API', () => {
    // Claude Code fabrica un mensaje `<synthetic>` con el consumo en cero
    // cuando la llamada se interrumpe. En este equipo eran 82.
    const acc = vacio();
    const cero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    addLine(acc, new Set(), respuesta('msg_x', cero, '<synthetic>'));
    expect(acc).toEqual(vacio());
  });
});

describe('readTokens / tokensFor', () => {
  it('lee un transcript entero y sirve la caché mientras el archivo no cambie', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-tokens-'));
    try {
      const path = join(dir, 'sesion.jsonl');
      await writeFile(
        path,
        [
          JSON.stringify({ type: 'user', message: { content: 'hola' } }),
          respuesta('msg_1', USO),
          respuesta('msg_1', USO), // el mismo bloque otra vez
          respuesta('msg_2', USO)
        ].join('\n') + '\n'
      );

      expect(await readTokens(path)).toMatchObject({ requests: 2, cacheRead: 2000, output: 10 });

      const uno = await tokensFor([{ id: 'sesion', path }]);
      expect(uno.sesion.requests).toBe(2);

      // El archivo crece: el total tiene que crecer con él.
      await writeFile(path, respuesta('msg_3', USO) + '\n', { flag: 'a' });
      const dos = await tokensFor([{ id: 'sesion', path }]);
      expect(dos.sesion.requests).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('un archivo que no está cuenta como sin consumo, no como un error', async () => {
    const salida = await tokensFor([{ id: 'fantasma', path: join(tmpdir(), 'no-existe-cm.jsonl') }]);
    expect(salida.fantasma).toMatchObject({ requests: 0, input: 0 });
  });
});
