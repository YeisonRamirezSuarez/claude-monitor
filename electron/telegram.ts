/**
 * Lo mínimo de la Bot API de Telegram para el puente remoto (ver
 * `docs/superpowers/specs/2026-09-28-telegram-remoto-design.md`).
 *
 * Sin dependencias: `fetch` alcanza. El texto va plano, sin `parse_mode`: lo
 * que se manda es código y comandos, y un `_` o un `*` suelto hace que Telegram
 * rechace el mensaje entero si se lo interpreta como Markdown. La excepción es
 * lo que escribe el agente (`md`): se convierte a HTML con `mdAHtml` y, si
 * Telegram igual lo rechaza, se reenvía plano.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mdAHtml } from './telegram-md';

export const MAX_TEXTO = 4096;

export function recortar(texto: string, max = MAX_TEXTO): string {
  return texto.length <= max ? texto : `${texto.slice(0, max - 1)}…`;
}

export type Boton = { texto: string; dato: string };
export type Mensaje = {
  message_id: number;
  chat: { id: number; type?: string; is_forum?: boolean };
  from?: { id: number };
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number }>;
  media_group_id?: string;
};
export type Callback = { id: string; from: { id: number }; data?: string; message?: Mensaje };
export type Update = { update_id: number; message?: Mensaje; callback_query?: Callback };

export class TelegramError extends Error {
  /** `reintentarSeg`: lo que pide esperar un 429 (`parameters.retry_after`). */
  constructor(
    public codigo: number,
    mensaje: string,
    public reintentarSeg?: number
  ) {
    super(mensaje);
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Telegram {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  private async llamar<T>(metodo: string, params: Record<string, unknown>, señal?: AbortSignal): Promise<T> {
    const r = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      // Sin tope, una conexión colgada deja esperando para siempre a quien llamó (un envío, un "Retomado").
      // El long polling trae su propia señal y su propia espera.
      signal: señal ?? AbortSignal.timeout(60_000)
    });
    const j = (await r.json()) as {
      ok: boolean;
      result: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!j.ok) throw new TelegramError(j.error_code ?? 0, j.description ?? metodo, j.parameters?.retry_after);
    return j.result;
  }

  getMe(): Promise<{ username: string }> {
    return this.llamar('getMe', {});
  }

  actualizaciones(offset: number, esperaSeg = 50, señal?: AbortSignal): Promise<Update[]> {
    return this.llamar('getUpdates', { offset, timeout: esperaSeg, allowed_updates: ['message', 'callback_query'] }, señal);
  }

  /** `md`: el texto es Markdown del agente y va con formato; si Telegram no
   *  acepta el HTML resultante (400), se reenvía plano para no perderlo. */
  async enviar(chatId: number, texto: string, op: { tema?: number; botones?: Boton[][]; md?: boolean } = {}): Promise<number> {
    const base = {
      chat_id: chatId,
      ...(op.tema ? { message_thread_id: op.tema } : {}),
      ...(op.botones
        ? { reply_markup: { inline_keyboard: op.botones.map((f) => f.map((b) => ({ text: b.texto, callback_data: b.dato }))) } }
        : {})
    };
    if (op.md) {
      try {
        // Con margen: las etiquetas suman caracteres a lo que Telegram cuenta.
        const m = await this.llamar<{ message_id: number }>('sendMessage', {
          ...base,
          text: recortar(mdAHtml(recortar(texto, MAX_TEXTO - 600))),
          parse_mode: 'HTML'
        });
        return m.message_id;
      } catch (e) {
        // Un tema borrado también es 400: eso lo resuelve quien llama, no el formato.
        if (!(e instanceof TelegramError && e.codigo === 400) || /thread/i.test(e.message)) throw e;
      }
    }
    const m = await this.llamar<{ message_id: number }>('sendMessage', { ...base, text: recortar(texto) });
    return m.message_id;
  }

  /** Cambia el texto y, al no mandar `reply_markup`, le saca los botones. */
  async editar(chatId: number, messageId: number, texto: string): Promise<void> {
    await this.llamar('editMessageText', { chat_id: chatId, message_id: messageId, text: recortar(texto) });
  }

  async borrar(chatId: number, messageId: number): Promise<void> {
    await this.llamar('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  /** 👀 sobre el mensaje del usuario: "le llegó al agente". */
  async reaccionar(chatId: number, messageId: number, emoji = '👀'): Promise<void> {
    await this.llamar('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] });
  }

  /** "escribiendo…" en el tema. Telegram lo muestra unos 5 s: quien llama lo renueva. */
  async escribiendo(chatId: number, tema?: number): Promise<void> {
    await this.llamar('sendChatAction', { chat_id: chatId, action: 'typing', ...(tema ? { message_thread_id: tema } : {}) });
  }

  async contestarBoton(callbackId: string, texto?: string): Promise<void> {
    await this.llamar('answerCallbackQuery', { callback_query_id: callbackId, ...(texto ? { text: texto } : {}) });
  }

  async crearTema(chatId: number, nombre: string): Promise<number> {
    const t = await this.llamar<{ message_thread_id: number }>('createForumTopic', { chat_id: chatId, name: nombre.slice(0, 128) });
    return t.message_thread_id;
  }

  async descargar(fileId: string, destino: string): Promise<string> {
    const f = await this.llamar<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!f.file_path) throw new TelegramError(0, 'No se pudo descargar el archivo de Telegram.');
    const r = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${f.file_path}`);
    if (!r.ok) throw new TelegramError(r.status, 'No se pudo descargar el archivo de Telegram.');
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(destino, Buffer.from(await r.arrayBuffer()));
    return destino;
  }

  /**
   * Long polling hasta que se aborte `señal`. Un error de red espera y
   * reintenta con espera creciente (hasta 60 s); un 401 (token revocado) corta
   * el bucle lanzando, para que el puente se apague y avise.
   */
  async escuchar(
    offset: number,
    alRecibir: (u: Update) => Promise<void>,
    alOffset: (o: number) => void,
    señal: AbortSignal,
    alError?: (e: unknown, u: Update) => void
  ): Promise<void> {
    let espera = 1000;
    while (!señal.aborted) {
      let lote: Update[];
      try {
        lote = await this.actualizaciones(offset, 50, señal);
        espera = 1000;
      } catch (e) {
        if (señal.aborted) return;
        if (e instanceof TelegramError && e.codigo === 401) throw e;
        await esperar(espera);
        espera = Math.min(espera * 2, 60_000);
        continue;
      }
      for (const u of lote) {
        try {
          await alRecibir(u);
        } catch (e) {
          // no se reintenta para no trabar el bucle, pero se avisa
          if (alError) alError(e, u);
        }
        offset = u.update_id + 1;
      }
      if (lote.length) alOffset(offset);
    }
  }
}
