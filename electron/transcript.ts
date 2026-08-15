import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Transcript, TranscriptMessage } from '../shared/types';

/** Tope de mensajes. Ninguna conversación real se acerca, pero un `.jsonl`
 *  corrupto o gigante no puede tumbar la ventana. */
const MAX_MESSAGES = 8000;
/** Tope por mensaje: un archivo pegado entero se lleva megas de RAM al
 *  renderizarlo, y nadie lo lee completo dentro de una burbuja. */
const MAX_TEXT = 20000;

/** Lo que Claude Code inyecta como si fuera el usuario: slash commands,
 *  recordatorios y avisos. No es lo que se habló. Ver `sessions.ts`. */
const NOT_A_PROMPT = /^(<(command-|local-command-|system-reminder|user-prompt-submit)|Caveat: The messages below)/;

type Block = { type?: string; text?: string };

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Block => typeof b === 'object' && b !== null);
}

/**
 * Arma la conversación a partir de las líneas del `.jsonl`.
 *
 * Se queda con lo que se dijo y descarta la maquinaria: resultados de
 * herramientas, líneas meta, y las ramas de subagentes (`isSidechain`), que son
 * conversaciones aparte y romperían el hilo. De cada turno del asistente se
 * guarda además cuántas herramientas usó, porque un turno que sólo ejecutó
 * comandos queda sin texto y, sin ese dato, se vería como un hueco.
 */
export function parseTranscriptLines(lines: Iterable<string>): Transcript {
  const messages: TranscriptMessage[] = [];
  let cwd = '';
  let truncated = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
    if (entry.isSidechain === true || entry.isMeta === true) continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const message = entry.message as { content?: unknown } | undefined;
    const parts = blocks(message?.content);
    if (parts.some((b) => b.type === 'tool_result')) continue; // devolución de una herramienta

    const text = parts
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n\n')
      .trim();
    const tools = parts.filter((b) => b.type === 'tool_use').length;

    if (entry.type === 'user' && (!text || NOT_A_PROMPT.test(text))) continue;
    if (!text && !tools) continue;

    if (messages.length >= MAX_MESSAGES) {
      truncated = true;
      break;
    }

    messages.push({
      role: entry.type,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n… (mensaje recortado)` : text,
      tools,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : ''
    });
  }

  return { cwd, messages, truncated };
}

/** Lee el archivo entero en streaming: son hasta 20 MB y no entran cómodos de
 *  una sola vez en memoria como string. */
export async function readTranscript(filePath: string): Promise<Transcript> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines: string[] = [];
  try {
    for await (const line of rl) lines.push(line);
  } finally {
    rl.close();
    input.destroy();
  }
  return parseTranscriptLines(lines);
}
