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

/** Lo que un metacaracter de RegExp significa adentro de una ruta: nada. La
 *  ruta viene del `.jsonl` y puede traer paréntesis, puntos o `+`. */
const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Cambia la carpeta de trabajo grabada en un transcript, sin tocar nada más.
 *
 * Existe por Claude Desktop. Su enlace de reanudar acepta UN solo parámetro
 * —`session`, verificado en su bundle: el handler hace `searchParams.get(
 * "session")` y nada más— así que la carpeta la saca del `cwd` del `.jsonl`.
 * El de una sesión de la distro es POSIX (`/home/…`), Desktop lo busca del
 * lado de Windows, no existe, y muestra "La carpeta de trabajo ya no existe".
 * Con la UNC sí la encuentra: es la forma en que Desktop mismo arma las rutas
 * de una distro.
 *
 * Tres cuidados que valen la pena:
 *
 *   - Reemplaza SÓLO el valor de la clave `cwd`. Esa misma ruta puede estar
 *     adentro de un mensaje —alguien la pegó en la conversación— y ahí
 *     cambiarla sería reescribir lo que se dijo.
 *   - No re-serializa el JSON. Parsear y volver a `stringify` cada línea
 *     normalizaría el archivo entero —orden de claves, formato de números—
 *     por un campo, y el archivo es del usuario.
 *   - El valor se compara ya escapado como JSON (`JSON.stringify`), no crudo:
 *     una ruta puede traer comillas o barras invertidas, y la UNC trae de las
 *     segundas a montones.
 *
 * Idempotente: si el `cwd` ya es el nuevo, no hay nada que cambiar.
 */
export function reescribirCwd(contenido: string, viejo: string, nuevo: string): string {
  if (viejo === nuevo) return contenido;
  const patron = new RegExp(`("cwd"\\s*:\\s*)${literal(JSON.stringify(viejo))}`, 'g');
  const valorNuevo = JSON.stringify(nuevo);
  // Reemplazo por función y no por cadena: en un reemplazo de texto `$` es un
  // metacaracter, y un nombre de distro puede traerlo (`\\wsl$`).
  return contenido.replace(patron, (_m, clave: string) => clave + valorNuevo);
}
