import { describe, it, expect, vi, afterEach } from 'vitest';
import { MAX_TEXTO, recortar, Telegram, TelegramError } from './telegram';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

const respuesta = (result: unknown, ok = true, error_code = 0) =>
  ({ json: async () => ({ ok, result, error_code, description: 'mal' }) }) as Response;

describe('recortar', () => {
  it('deja igual lo que entra', () => expect(recortar('hola')).toBe('hola'));
  it('corta lo que no entra y avisa con …', () => {
    const t = recortar('x'.repeat(MAX_TEXTO + 50));
    expect(t.length).toBe(MAX_TEXTO);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('Telegram', () => {
  it('con md manda el Markdown del agente como HTML', async () => {
    const f = vi.fn(async () => respuesta({ message_id: 3 }));
    const tg = new Telegram('T', f as unknown as typeof fetch);
    await tg.enviar(1, '**listo**', { md: true });
    const cuerpo = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(cuerpo).toMatchObject({ text: '<b>listo</b>', parse_mode: 'HTML' });
  });

  it('si Telegram rechaza el HTML (400), lo reenvía plano', async () => {
    const f = vi.fn().mockResolvedValueOnce(respuesta(null, false, 400)).mockResolvedValueOnce(respuesta({ message_id: 4 }));
    const tg = new Telegram('T', f as unknown as typeof fetch);
    expect(await tg.enviar(1, '**listo**', { md: true })).toBe(4);
    const segundo = JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(segundo.text).toBe('**listo**');
    expect(segundo.parse_mode).toBeUndefined();
  });

  it('manda texto plano, sin parse_mode, en el tema y con botones', async () => {
    const f = vi.fn(async () => respuesta({ message_id: 7 }));
    const tg = new Telegram('TOKEN', f as unknown as typeof fetch);
    const id = await tg.enviar(10, 'a_b*c', { tema: 3, botones: [[{ texto: 'Sí', dato: 'x:si' }]] });
    expect(id).toBe(7);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const cuerpo = JSON.parse(String(init.body));
    expect(cuerpo).toEqual({
      chat_id: 10,
      text: 'a_b*c',
      message_thread_id: 3,
      reply_markup: { inline_keyboard: [[{ text: 'Sí', callback_data: 'x:si' }]] }
    });
    expect(cuerpo.parse_mode).toBeUndefined();
  });

  it('un error de la API es un TelegramError con su código', async () => {
    const tg = new Telegram('T', (async () => respuesta(null, false, 401)) as unknown as typeof fetch);
    await expect(tg.getMe()).rejects.toMatchObject({ codigo: 401 });
    await expect(tg.getMe()).rejects.toBeInstanceOf(TelegramError);
  });

  // Final review I4 e I3: una llamada común no puede colgar para siempre, y un 429 trae cuánto esperar.
  it('las llamadas comunes llevan tope de tiempo; el 429 trae retry_after', async () => {
    const f = vi.fn(async () => ({ json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }) }) as Response);
    const tg = new Telegram('T', f as unknown as typeof fetch);
    await expect(tg.enviar(1, 'x')).rejects.toMatchObject({ codigo: 429, reintentarSeg: 3 });
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('escuchar avanza el offset y entrega cada update', async () => {
    const lotes = [[{ update_id: 5 }, { update_id: 6 }], []];
    const ctrl = new AbortController();
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const { offset } = JSON.parse(String(init.body));
      if (lotes.length === 1) ctrl.abort();
      return respuesta(lotes.shift() ?? [], true);
    });
    const tg = new Telegram('T', f as unknown as typeof fetch);
    const vistos: number[] = [];
    const offsets: number[] = [];
    await tg.escuchar(0, async (u) => void vistos.push(u.update_id), (o) => void offsets.push(o), ctrl.signal);
    expect(vistos).toEqual([5, 6]);
    expect(offsets).toEqual([7]);
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body)).offset).toBe(7);
  });

  it('escuchar rechaza un 401 de getUpdates', async () => {
    const f = vi.fn(async () => respuesta(null, false, 401));
    const tg = new Telegram('T', f as unknown as typeof fetch);
    const ctrl = new AbortController();
    const p = tg.escuchar(0, async () => {}, () => {}, ctrl.signal);
    await expect(p).rejects.toMatchObject({ codigo: 401 });
  });

  it('escuchar espera 1000 ms antes de reintentar en error de red', async () => {
    vi.useFakeTimers();
    try {
      let llamadas = 0;
      const entregas: number[] = [];
      const f = vi.fn(async () => {
        llamadas++;
        if (llamadas === 1) throw new TypeError('network error');
        return respuesta([{ update_id: 1 }], true);
      });
      const tg = new Telegram('T', f as unknown as typeof fetch);
      const ctrl = new AbortController();
      const p = tg.escuchar(
        0,
        async (u) => {
          entregas.push(u.update_id);
          ctrl.abort();
        },
        () => {},
        ctrl.signal
      );
      // Avanzar 999 ms: debe haber solo 1 llamada (esperando)
      await vi.advanceTimersByTimeAsync(999);
      expect(f).toHaveBeenCalledTimes(1);
      // Avanzar 1 ms más: ya pasaron los 1000 ms, ahora debe reintentar
      await vi.advanceTimersByTimeAsync(1);
      expect(f).toHaveBeenCalledTimes(2);
      await p;
      expect(entregas).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('escuchar llama alError cuando alRecibir falla y avanza el offset', async () => {
    const lotes = [[{ update_id: 5 }], []];
    const ctrl = new AbortController();
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      if (lotes.length === 1) ctrl.abort();
      return respuesta(lotes.shift() ?? [], true);
    });
    const tg = new Telegram('T', f as unknown as typeof fetch);
    const errores: { e: unknown; u: number }[] = [];
    const vistos: number[] = [];
    const offsetRecibidos: number[] = [];
    await tg.escuchar(
      0,
      async (u) => {
        vistos.push(u.update_id);
        throw new Error('fallo');
      },
      (o) => offsetRecibidos.push(o),
      ctrl.signal,
      (e, u) => errores.push({ e, u: u.update_id })
    );
    expect(vistos).toEqual([5]);
    expect(errores).toHaveLength(1);
    expect(errores[0].e).toBeInstanceOf(Error);
    expect(errores[0].u).toBe(5);
    // El offset debe avanzar a 6 (update_id + 1) aunque alRecibir falle
    expect(offsetRecibidos).toEqual([6]);
  });

  describe('descargar', () => {
    let tempDir: string;
    afterEach(async () => {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    });

    it('rechaza si no hay file_path', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'telegram-test-'));
      const destino = join(tempDir, 'file.txt');
      const f = vi.fn(async () => respuesta({ file_path: undefined }, true));
      const tg = new Telegram('T', f as unknown as typeof fetch);
      await expect(tg.descargar('id', destino)).rejects.toBeInstanceOf(TelegramError);
      expect(existsSync(destino)).toBe(false);
    });

    it('rechaza si el archivo responde !ok', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'telegram-test-'));
      const destino = join(tempDir, 'file.txt');
      const f = vi.fn(async (url: string) => {
        if (url.includes('getFile')) return respuesta({ file_path: 'path/to/file' }, true);
        return {
          ok: false,
          status: 404,
          arrayBuffer: async () => new ArrayBuffer(100),
          json: async () => ({})
        } as Response;
      });
      const tg = new Telegram('T', f as unknown as typeof fetch);
      await expect(tg.descargar('id', destino)).rejects.toBeInstanceOf(TelegramError);
      expect(existsSync(destino)).toBe(false);
    });
  });
});
