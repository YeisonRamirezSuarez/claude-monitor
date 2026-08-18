import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { SessionTokens } from '../shared/types';

/**
 * Cuántos tokens consumió cada sesión, leídos del transcript.
 *
 * Claude Code anota el consumo real en cada respuesta del modelo: la línea
 * `type: "assistant"` trae `message.usage` con lo que facturó esa llamada. Es
 * la única fuente que hay por sesión — el CLI cachea los límites de la cuenta
 * (ver `usage.ts`), pero eso es el total de la cuenta y no dice qué sesión se
 * lo comió.
 *
 * Los cuatro números son distintos y ninguno sobra: la entrada normal, la
 * escritura de caché, la lectura de caché —que es baratísima y suele ser el
 * 95% del volumen— y la salida. Sumarlos en uno solo haría creer que una
 * sesión larga consumió una fortuna cuando casi todo fue caché releída.
 */

/** El consumo de una respuesta se repite en varias líneas.
 *
 * Una respuesta que llega en varios bloques deja una línea `assistant` por
 * bloque, y TODAS repiten el mismo `message.usage` — no es el consumo de cada
 * pedazo, es el de la llamada entera copiado tal cual. Sumando línea por línea,
 * una sesión de esta máquina daba 412.658.076 tokens de caché leída contra
 * 212.200.149 reales: casi el doble.
 *
 * Por eso se cuenta una vez por `message.id`. Y con el archivo entero a la
 * vista, no sólo contra la línea anterior: en un transcript de esta máquina
 * había 196 ids que reaparecían después de haber cambiado —una sesión
 * reanudada reescribe mensajes previos— así que mirar sólo la última no
 * alcanza.
 */
type Acumulador = {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  requests: number;
  models: string[];
};

const vacio = (): Acumulador => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, requests: 0, models: [] });

/** Sin consumo: una sesión que nunca llamó al modelo. */
export const SIN_CONSUMO: SessionTokens = vacio();

const numero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Suma una línea del `.jsonl` al acumulador. `vistas` lleva los ids ya
 * contados; hay que pasar el mismo Set durante todo el archivo.
 *
 * El descarte por texto antes de parsear no es una micro-optimización: las
 * líneas con consumo son una minoría y el resto incluye adjuntos y snapshots
 * de archivos enteros. Con el filtro, los 558 MB de transcripts de esta
 * máquina se recorren en 2,5 s; parseando todo, la app se quedaría colgada.
 */
export function addLine(acc: Acumulador, vistas: Set<string>, line: string): void {
  if (!line.includes('"usage"')) return;

  let entry: { message?: { usage?: unknown; id?: unknown; model?: unknown }; requestId?: unknown };
  try {
    entry = JSON.parse(line);
  } catch {
    return; // línea a medio escribir: la sesión activa se está grabando ahora
  }

  const message = entry?.message;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return;

  const input = numero(usage.input_tokens);
  const output = numero(usage.output_tokens);
  const cacheCreate = numero(usage.cache_creation_input_tokens);
  const cacheRead = numero(usage.cache_read_input_tokens);

  // Una respuesta en cero nunca llegó a la API: son los mensajes que Claude
  // Code fabrica cuando la llamada se interrumpe o falla, marcados con el
  // modelo `<synthetic>`. Contarlas sumaba 82 "respuestas" inexistentes en los
  // transcripts de esta máquina y metía `<synthetic>` en la lista de modelos.
  if (input + output + cacheCreate + cacheRead === 0) return;

  const id = typeof message?.id === 'string' ? message.id : typeof entry.requestId === 'string' ? entry.requestId : '';
  if (id) {
    if (vistas.has(id)) return;
    vistas.add(id);
  }

  acc.input += input;
  acc.output += output;
  acc.cacheCreate += cacheCreate;
  acc.cacheRead += cacheRead;
  acc.requests += 1;
  if (typeof message?.model === 'string' && !acc.models.includes(message.model)) acc.models.push(message.model);
}

/** El consumo de un transcript entero. Un archivo ilegible cuenta como sin
 *  consumo: no saber cuánto gastó una sesión no puede romper la lista. */
export async function readTokens(filePath: string): Promise<SessionTokens> {
  const acc = vacio();
  const vistas = new Set<string>();
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) addLine(acc, vistas, line);
  } catch {
    return acc; // lo que se alcanzó a leer, que es mejor que nada
  } finally {
    rl.close();
    // Igual que en `sessions.ts`: rl.close() no cierra el ReadStream de abajo.
    input.destroy();
  }
  acc.models.sort();
  return acc;
}

/**
 * Caché por archivo, con la misma llave que `sessions.ts`: (mtime, size).
 *
 * Un transcript sólo crece, y el que crece es el de la sesión abierta. Todos
 * los demás quedan idénticos entre refrescos, así que el recorrido completo se
 * paga una vez por arranque y después sólo se relee lo que cambió.
 */
const cache = new Map<string, { mtimeMs: number; size: number; tokens: SessionTokens }>();

/**
 * El consumo de un lote de sesiones, por id.
 *
 * ponytail: cuando un archivo cambia se relee entero, no desde donde quedó. El
 * único que cambia es el de la sesión en curso y el más grande de esta máquina
 * son 20 MB (~90 ms). Si alguna vez pesa, leer desde el `size` anterior — pero
 * hace falta guardarse también los ids vistos.
 */
export async function tokensFor(files: { id: string; path: string }[]): Promise<Record<string, SessionTokens>> {
  const salida: Record<string, SessionTokens> = {};
  const vigentes = new Set<string>();

  for (const { id, path } of files) {
    vigentes.add(path);
    const stats = await stat(path).catch(() => null);
    if (!stats) {
      salida[id] = SIN_CONSUMO;
      continue;
    }
    const previo = cache.get(path);
    const tokens =
      previo && previo.mtimeMs === stats.mtimeMs && previo.size === stats.size
        ? previo.tokens
        : await readTokens(path);
    cache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, tokens });
    salida[id] = tokens;
  }

  for (const key of [...cache.keys()]) if (!vigentes.has(key)) cache.delete(key);
  return salida;
}
