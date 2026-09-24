/**
 * La oficina: quién está trabajando ahora, en qué, y qué se dijo.
 *
 * Todo sale de lo que Claude Code ya escribe en disco, sin hooks:
 *
 * - `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` dice qué sesiones están vivas en
 *   cada cuenta y si están `busy` o `idle` (ver `liveness.ts`).
 * - El final del transcript dice qué está haciendo: una herramienta pedida y
 *   todavía sin resultado es lo que está corriendo en este momento.
 * - `<sesión>/subagents/agent-<id>.jsonl` + `.meta.json` son los subagentes,
 *   cada uno con su propia conversación.
 * - Los mensajes entre agentes quedan en los dos lados: quien manda usa la
 *   herramienta `SendMessage`; a quien recibe le llega un turno meta con
 *   `<agent-message from="…">`.
 */

import { execFile } from 'node:child_process';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  ActividadAgente,
  AgenteOficina,
  ConversacionItem,
  Conversacion,
  EstadoAgente,
  Profile,
  SubagenteOficina
} from '../shared/types';
import { lateTodavia, parseSesionViva, type SesionViva } from './liveness';

const run = promisify(execFile);

/** Cuánto del final del transcript hace falta para saber qué está haciendo.
 *  Un resultado de herramienta gigante puede no entrar; en ese caso se ve la
 *  herramienta como terminada, que es lo que casi seguro pasó. */
const COLA_BYTES = 256 * 1024;
/** Claude Code no deja una marca de "terminó" en el archivo del subagente: se
 *  deduce de su último turno. Uno que escribió hace menos de esto cuenta
 *  como trabajando pase lo que pase. */
const SUBAGENTE_ACTIVO_MS = 30_000;
/** Cuánto sigue a la vista con el ✓ después de terminar. */
const SUBAGENTE_TERMINADO_MS = 2 * 60_000;
/** Un subagente con una herramienta pendiente puede estar callado mucho rato
 *  (un build, un test largo); más que esto sin escribir se da por muerto.
 *  ponytail: tope por mtime; cruzar con el `tool_result` del padre si falla. */
const SUBAGENTE_VISIBLE_MS = 15 * 60_000;
/** Ventana en la que un mensaje entre agentes se anima en la oficina. */
const MENSAJE_RECIENTE_MS = 15_000;
const MAX_ITEMS = 6000;
const MAX_TEXTO = 20_000;
const MAX_DETALLE = 4000;

const LECTURA = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead', 'LS']);
const DELEGA = new Set(['Agent', 'Task']);
/** Lo que Claude Code inyecta como si fuera el usuario. Ver `transcript.ts`. */
const NO_ES_PROMPT = /^(<(command-|local-command-|system-reminder|user-prompt-submit)|Caveat: The messages below)/;

type Bloque = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type Entrada = Record<string, unknown>;

function bloques(content: unknown): Bloque[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Bloque => typeof b === 'object' && b !== null);
}

function parsear(lineas: Iterable<string>): Entrada[] {
  const out: Entrada[] = [];
  for (const l of lineas) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* línea cortada por la cola o corrupta */
    }
  }
  return out;
}

const recortar = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (recortado)` : s);

function textoDe(content: unknown): string {
  return bloques(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n\n')
    .trim();
}

/** Una línea que diga sobre qué trabaja la herramienta, sin el JSON entero. */
export function detalleHerramienta(nombre: string, input: Record<string, unknown> = {}): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (nombre) {
    case 'Bash':
    case 'PowerShell':
      return s('description') || s('command');
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return basename(s('file_path') || s('notebook_path'));
    case 'Grep':
    case 'Glob':
      return s('pattern');
    case 'Agent':
    case 'Task':
      return s('description');
    case 'SendMessage':
      return `a ${s('to')}`;
    case 'WebFetch':
      return s('url');
    case 'WebSearch':
      return s('query');
    case 'Skill':
      return s('skill');
    default:
      return '';
  }
}

/**
 * Qué está haciendo el agente según el final de su transcript.
 *
 * Una herramienta pedida sin resultado es lo que está corriendo. Si no hay
 * ninguna, manda el último turno: si habló el usuario (o volvió un resultado)
 * le toca a Claude, que está pensando; si habló Claude, terminó su turno.
 */
export function actividadDe(lineas: Iterable<string>): ActividadAgente {
  const pendientes = new Map<string, { nombre: string; input: Record<string, unknown> }>();
  let ultimo: 'usuario' | 'claude' | null = null;

  for (const e of parsear(lineas)) {
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const partes = bloques((e.message as { content?: unknown } | undefined)?.content);
    for (const b of partes) {
      if (b.type === 'tool_use' && b.id) pendientes.set(b.id, { nombre: b.name ?? '', input: b.input ?? {} });
      if (b.type === 'tool_result' && b.tool_use_id) pendientes.delete(b.tool_use_id);
    }
    if (e.type === 'assistant') ultimo = 'claude';
    else if (e.isMeta !== true) ultimo = 'usuario';
  }

  const enCurso = [...pendientes.values()].pop();
  if (enCurso) {
    const tipo = DELEGA.has(enCurso.nombre) ? 'delegando' : LECTURA.has(enCurso.nombre) ? 'leyendo' : 'escribiendo';
    return { tipo, herramienta: enCurso.nombre, detalle: detalleHerramienta(enCurso.nombre, enCurso.input) };
  }
  return { tipo: ultimo === 'usuario' ? 'pensando' : 'listo', herramienta: '', detalle: '' };
}

/**
 * El estado que se muestra, cruzando la actividad con lo que dice el registro
 * de sesiones vivas. `idle` con una herramienta pendiente es casi siempre un
 * pedido de permiso: Claude pidió correr algo y está esperando tu OK.
 */
export function estadoDe(status: string | undefined, act: ActividadAgente): EstadoAgente {
  if (status === 'idle') return act.tipo === 'listo' || act.tipo === 'pensando' ? 'esperando' : 'permiso';
  if (act.tipo === 'listo') return 'pensando';
  return act.tipo;
}

/** Los mensajes entre agentes que pasaron hace poco, para animarlos. */
export function mensajesRecientes(lineas: Iterable<string>, ahoraMs: number): Array<{ de: string; para: string }> {
  const out: Array<{ de: string; para: string }> = [];
  for (const e of parsear(lineas)) {
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (!(ahoraMs - ts < MENSAJE_RECIENTE_MS)) continue;
    const partes = bloques((e.message as { content?: unknown } | undefined)?.content);
    for (const b of partes) {
      if (b.type === 'tool_use' && b.name === 'SendMessage' && typeof b.input?.to === 'string') {
        out.push({ de: '', para: b.input.to });
      }
    }
    const de = /<agent-message from="([^"]+)"/.exec(textoDe((e.message as { content?: unknown })?.content))?.[1];
    if (de) out.push({ de, para: '' });
  }
  return out;
}

function textoResultado(content: unknown): string {
  if (typeof content === 'string') return content;
  return bloques(content)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[imagen]' : ''))
    .join('\n')
    .trim();
}

/**
 * La conversación con todo lo que pasó: lo que se dijo, cada herramienta con
 * su entrada y su resultado, los subagentes que se lanzaron y lo que
 * devolvieron, y los mensajes que se mandaron entre agentes.
 *
 * A diferencia de `parseTranscriptLines`, acá la maquinaria ES lo que se quiere
 * ver.
 */
export function parseConversacion(lineas: Iterable<string>): Conversacion {
  const items: ConversacionItem[] = [];
  const porToolId = new Map<string, ConversacionItem>();
  let cwd = '';
  let truncada = false;

  for (const e of parsear(lineas)) {
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (items.length >= MAX_ITEMS) {
      truncada = true;
      break;
    }
    const ts = typeof e.timestamp === 'string' ? e.timestamp : '';
    const content = (e.message as { content?: unknown } | undefined)?.content;
    const partes = bloques(content);

    if (e.type === 'user') {
      // Resultados de herramientas: se cuelgan de la llamada que los pidió.
      for (const b of partes) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const item = porToolId.get(b.tool_use_id);
        if (!item) continue;
        const res = recortar(textoResultado(b.content), MAX_DETALLE);
        if (item.tipo === 'herramienta') {
          item.resultado = res;
          item.error = b.is_error === true;
        } else if (item.tipo === 'subagente') {
          item.resultado = res;
          const r = e.toolUseResult as { agentId?: unknown } | undefined;
          if (typeof r?.agentId === 'string') item.agentId = r.agentId;
        }
      }
      if (partes.some((b) => b.type === 'tool_result')) continue;

      const texto = textoDe(content);
      if (!texto) continue;
      // El resumen que deja la compactación entra como turno del usuario, pero
      // no lo escribiste vos: es el contexto con el que siguió la sesión.
      if (e.isCompactSummary === true) {
        items.push({ tipo: 'aviso', texto: 'La conversación se compactó: desde acá Claude siguió con un resumen de lo anterior.', ts });
        continue;
      }
      const de = /<agent-message from="([^"]+)">([\s\S]*?)(<\/agent-message>|$)/.exec(texto);
      if (de) {
        items.push({ tipo: 'mensaje', de: de[1], para: '', texto: recortar(de[2].trim(), MAX_TEXTO), ts });
        continue;
      }
      const aviso = /<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>/.exec(texto);
      if (aviso) {
        items.push({ tipo: 'aviso', texto: aviso[1].trim(), ts });
        continue;
      }
      if (e.isMeta === true || NO_ES_PROMPT.test(texto)) continue;
      items.push({ tipo: 'usuario', texto: recortar(texto, MAX_TEXTO), ts });
      continue;
    }

    for (const b of partes) {
      if (b.type === 'text' && b.text?.trim()) {
        items.push({ tipo: 'claude', texto: recortar(b.text.trim(), MAX_TEXTO), ts });
      } else if (b.type === 'tool_use' && b.id) {
        const input = b.input ?? {};
        const nombre = b.name ?? '';
        let item: ConversacionItem;
        if (DELEGA.has(nombre)) {
          item = {
            tipo: 'subagente',
            toolId: b.id,
            agentId: '',
            tipoAgente: typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose',
            descripcion: typeof input.description === 'string' ? input.description : '',
            prompt: recortar(typeof input.prompt === 'string' ? input.prompt : '', MAX_TEXTO),
            resultado: '',
            ts
          };
        } else if (nombre === 'SendMessage') {
          const msg = input.message;
          item = {
            tipo: 'mensaje',
            de: '',
            para: typeof input.to === 'string' ? input.to : '',
            texto: recortar(typeof msg === 'string' ? msg : JSON.stringify(msg ?? '', null, 2), MAX_TEXTO),
            ts
          };
        } else {
          item = {
            tipo: 'herramienta',
            toolId: b.id,
            nombre,
            detalle: detalleHerramienta(nombre, input),
            entrada: recortar(JSON.stringify(input, null, 2), MAX_DETALLE),
            resultado: null,
            error: false,
            ts
          };
        }
        items.push(item);
        porToolId.set(b.id, item);
      }
    }
  }
  return { cwd, items, truncada };
}

/** Las últimas líneas completas de un archivo, sin leerlo entero. */
async function cola(ruta: string, bytes = COLA_BYTES): Promise<string[]> {
  const fh = await open(ruta, 'r');
  try {
    const { size } = await fh.stat();
    const desde = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - desde);
    await fh.read(buf, 0, buf.length, desde);
    const lineas = buf.toString('utf8').split('\n');
    if (desde > 0) lineas.shift(); // la primera quedó cortada al medio
    return lineas;
  } finally {
    await fh.close();
  }
}

/** Cómo nombra Claude Code la carpeta de un proyecto a partir del cwd. */
export const slugDe = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** El transcript de una sesión viva, por su cwd. `null` si no está donde se
 *  espera (el llamador puede buscarlo por las raíces). */
export async function rutaViva(configDir: string, cwd: string, sessionId: string): Promise<string | null> {
  const ruta = join(configDir, 'projects', slugDe(cwd), `${sessionId}.jsonl`);
  return stat(ruta).then(
    () => ruta,
    () => null
  );
}

const AGENT_ID = /^[a-zA-Z0-9_-]+$/;

/** El transcript de un subagente, al lado del de su sesión. */
export function rutaSubagente(rutaSesion: string, agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new Error(`Id de subagente inválido: ${agentId}`);
  return join(dirname(rutaSesion), basename(rutaSesion, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`);
}

/**
 * Dónde está el transcript de un subagente: al lado de la sesión, o —si es un
 * agente de un Workflow— una carpeta más adentro, en
 * `subagents/workflows/<runId>/`.
 */
async function buscarSubagente(rutaSesion: string, agentId: string): Promise<string> {
  const directa = rutaSubagente(rutaSesion, agentId);
  if (await stat(directa).then(() => true, () => false)) return directa;
  const raiz = join(dirname(directa), 'workflows');
  for (const run of await readdir(raiz).catch(() => [] as string[])) {
    const ruta = join(raiz, run, `agent-${agentId}.jsonl`);
    if (await stat(ruta).then(() => true, () => false)) return ruta;
  }
  return directa;
}

/** Lo que dice el `journal.jsonl` de un Workflow: qué agentes terminaron (su
 *  `result`). Se lee sólo lo agregado desde la vez anterior: los resultados
 *  traen informes enteros y el archivo crece rápido. */
const journales = new Map<string, { offset: number; resto: string; hechos: Set<string> }>();
async function terminadosDelWorkflow(ruta: string): Promise<Set<string>> {
  let j = journales.get(ruta);
  if (!j) {
    j = { offset: 0, resto: '', hechos: new Set() };
    journales.set(ruta, j);
  }
  const info = await stat(ruta).catch(() => null);
  if (!info || info.size === j.offset) return j.hechos;
  if (info.size < j.offset) Object.assign(j, { offset: 0, resto: '', hechos: new Set<string>() });
  const fh = await open(ruta, 'r');
  try {
    const buf = Buffer.alloc(info.size - j.offset);
    await fh.read(buf, 0, buf.length, j.offset);
    j.offset = info.size;
    const lineas = (j.resto + buf.toString('utf8')).split('\n');
    j.resto = lineas.pop() ?? '';
    for (const l of lineas) {
      if (!l.includes('"type":"result"')) continue;
      const id = /"agentId":"([^"]+)"/.exec(l)?.[1];
      if (id) j.hechos.add(id);
    }
  } finally {
    await fh.close();
  }
  return j.hechos;
}

/** Cuántos subagentes muestra la sala de una sesión. Hay sesiones con más de
 *  cien; los que importan son los que corren y los últimos que terminaron. */
const MAX_EQUIPO = 40;

/**
 * Los subagentes de una sesión. Sin `todos`, sólo los que se ven en la oficina
 * general: los que corren y los que terminaron hace un momento. Con `todos`, el
 * equipo entero para la sala de la sesión, primero los que corren.
 */
async function leerSubagentes(rutaSesion: string, ahoraMs: number, todos = false): Promise<SubagenteOficina[]> {
  const dir = join(dirname(rutaSesion), basename(rutaSesion, '.jsonl'), 'subagents');
  type Archivo = { id: string; ruta: string; mtime: number; run?: string; hechos?: Set<string> };
  const conFecha: Archivo[] = [];
  const juntar = async (carpeta: string, run?: string, hechos?: Set<string>) => {
    for (const f of await readdir(carpeta).catch(() => [] as string[])) {
      const m = /^agent-(.+)\.jsonl$/.exec(f);
      if (!m) continue;
      const ruta = join(carpeta, f);
      const info = await stat(ruta).catch(() => null);
      if (info) conFecha.push({ id: m[1], ruta, mtime: info.mtimeMs, run, hechos });
    }
  };
  await juntar(dir);
  // Los agentes de un Workflow (code-review, auditorías…) no son spawns del
  // Agent: viven en subagents/workflows/<runId>/, y su journal dice cuándo
  // entregó cada uno.
  const workflows = join(dir, 'workflows');
  for (const run of await readdir(workflows).catch(() => [] as string[])) {
    await juntar(join(workflows, run), run, await terminadosDelWorkflow(join(workflows, run, 'journal.jsonl')));
  }
  conFecha.sort((a, b) => b.mtime - a.mtime);

  const out: SubagenteOficina[] = [];
  for (const { id, ruta, mtime, run, hechos } of todos ? conFecha.slice(0, MAX_EQUIPO) : conFecha) {
    const edad = ahoraMs - mtime;
    if (!todos && edad > SUBAGENTE_VISIBLE_MS) break; // ordenados: los que siguen son más viejos
    const act = actividadDe(await cola(ruta).catch(() => []));
    // Terminó cuando su último turno es texto de Claude: ese es el informe que
    // devuelve. Uno con algo pendiente que lleva demasiado callado también se
    // da por terminado: murió o lo cortaron. Un agente de Workflow terminó
    // cuando su journal tiene el result, y hasta entonces no (puede esperar
    // callado a que termine otra fase).
    const termino = hechos
      ? hechos.has(id) || edad > SUBAGENTE_VISIBLE_MS
      : (act.tipo === 'listo' && edad > SUBAGENTE_ACTIVO_MS) || edad > SUBAGENTE_VISIBLE_MS;
    if (!todos && termino && edad > SUBAGENTE_TERMINADO_MS) continue;
    type Meta = { agentType?: string; description?: string; toolUseId?: string; workflowPhase?: string };
    const meta = await readFile(join(dirname(ruta), `agent-${id}.meta.json`), 'utf8')
      .then((t) => JSON.parse(t) as Meta)
      .catch(() => ({}) as Meta);
    out.push({
      agentId: id,
      // Mismo id que le da el parche de Pixel Agents a su personaje.
      toolUseId: run ? `wf:${run}:${id}` : (meta.toolUseId ?? ''),
      tipoAgente: run ? `workflow · ${meta.workflowPhase ?? run}` : (meta.agentType ?? 'subagente'),
      descripcion: meta.description ?? '',
      nombrePropio: '',
      nota: '',
      estado: termino ? 'terminado' : act.tipo === 'listo' ? 'pensando' : act.tipo,
      herramienta: termino ? '' : act.herramienta,
      detalle: termino ? '' : act.detalle,
      ultimaActividad: mtime
    });
  }
  return todos ? out.sort((a, b) => Number(a.estado === 'terminado') - Number(b.estado === 'terminado')) : out;
}

/** El equipo entero de una sesión, para su sala. */
export function equipoDe(rutaSesion: string, ahoraMs = Date.now()): Promise<SubagenteOficina[]> {
  return leerSubagentes(rutaSesion, ahoraMs, true);
}

/** `procStart` es un FILETIME (100 ns desde 1601, UTC), igual que lo que
 *  devuelve Windows. Se tolera un segundo: CIM redondea a microsegundos. */
export function mismoInicio(procStart: string | undefined, real: string | undefined): boolean {
  if (!procStart || !real) return false;
  try {
    const d = BigInt(procStart) - BigInt(real);
    return (d < 0n ? -d : d) < 10_000_000n;
  } catch {
    return false;
  }
}

const INICIOS_TTL_MS = 15_000;
let iniciosCache: { en: number; pids: string; mapa: Map<number, string> } | null = null;

/**
 * Cuándo arrancó cada pid, como FILETIME. Una sola consulta CIM por lote y
 * cacheada: lanzar PowerShell cuesta medio segundo y la oficina pregunta cada
 * 1,5 s. Nunca lanza: sin respuesta, la sesión que no late no se muestra.
 * ponytail: PowerShell por lote cada 15 s; pasar a una llamada nativa si pesa.
 */
async function iniciosDeProceso(pids: number[], ahoraMs: number): Promise<Map<number, string>> {
  if (pids.length === 0 || process.platform !== 'win32') return new Map();
  const clave = [...new Set(pids)].sort((a, b) => a - b).join(',');
  if (iniciosCache && iniciosCache.pids === clave && ahoraMs - iniciosCache.en < INICIOS_TTL_MS) return iniciosCache.mapa;
  const filtro = clave
    .split(',')
    .map((p) => `ProcessId=${Number(p)}`)
    .join(' OR ');
  const mapa = new Map<number, string>();
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter '${filtro}' | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())" }`
      ],
      { timeout: 10_000, windowsHide: true }
    );
    for (const l of stdout.split(/\r?\n/)) {
      const [pid, ft] = l.trim().split(' ');
      if (pid && ft) mapa.set(Number(pid), ft);
    }
  } catch {
    /* sin PowerShell o CIM: se queda con las que laten */
  }
  iniciosCache = { en: ahoraMs, pids: clave, mapa };
  return mapa;
}

/**
 * Los agentes que están trabajando ahora en todas las cuentas.
 *
 * Una cuenta de WSL se saltea: su `sessions/` vive adentro de la distro y
 * leerlo obliga a encenderla, que es justo lo que el panel no hace solo.
 * ponytail: sólo Windows; sumar WSL leyendo por `\\wsl.localhost` si se pide.
 */
export async function agentesVivos(profiles: Profile[], ahoraMs = Date.now()): Promise<AgenteOficina[]> {
  type Candidata = { p: Profile; viva: SesionViva; crudo: { status?: string; name?: string; procStart?: string } };
  const candidatas: Candidata[] = [];
  for (const p of profiles) {
    if (p.entorno?.tipo === 'wsl') continue;
    const dir = join(p.configDir, 'sessions');
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!/^\d+\.json$/.test(f)) continue;
      const texto = await readFile(join(dir, f), 'utf8').catch(() => '');
      const viva = parseSesionViva(texto);
      if (viva?.cwd) candidatas.push({ p, viva, crudo: JSON.parse(texto) });
    }
  }

  // El latido no alcanza: Claude Code reescribe `updatedAt` sólo cuando la
  // sesión cambia de estado, así que una terminal abierta y quieta desde ayer
  // "no late" y está viva. La que no late se confirma como Desktop: el pid
  // tiene que existir Y haber arrancado cuando dice `procStart`, porque los
  // pid se reciclan (ver `procesoVivo` en `liveness.ts`).
  const dudosas = candidatas.filter((c) => !lateTodavia(c.viva, ahoraMs) && c.crudo.procStart);
  const inicios = await iniciosDeProceso(dudosas.map((c) => c.viva.pid), ahoraMs);

  const out: AgenteOficina[] = [];
  const vistos = new Set<string>();
  for (const { p, viva, crudo } of candidatas) {
    const confirmada = lateTodavia(viva, ahoraMs) || mismoInicio(crudo.procStart, inicios.get(viva.pid));
    if (!confirmada || vistos.has(viva.sessionId) || !viva.cwd) continue;
    vistos.add(viva.sessionId);
    {
      const ruta = await rutaViva(p.configDir, viva.cwd, viva.sessionId);
      const lineas = ruta ? await cola(ruta).catch(() => [] as string[]) : [];
      const act = actividadDe(lineas);
      out.push({
        sessionId: viva.sessionId,
        profileId: p.id,
        profileName: p.name,
        nombre: crudo.name || basename(viva.cwd),
        nombrePropio: '',
        nota: '',
        cwd: viva.cwd,
        origen: viva.entrypoint === 'claude-desktop' ? 'desktop' : 'terminal',
        estado: estadoDe(crudo.status, act),
        herramienta: act.herramienta,
        detalle: act.detalle,
        subagentes: ruta ? await leerSubagentes(ruta, ahoraMs) : [],
        mensajes: mensajesRecientes(lineas, ahoraMs)
      });
    }
  }
  return out;
}

/** La conversación de una sesión viva o de uno de sus subagentes. */
export async function conversacionDe(rutaSesion: string, agentId?: string): Promise<Conversacion> {
  const ruta = agentId ? await buscarSubagente(rutaSesion, agentId) : rutaSesion;
  const texto = await readFile(ruta, 'utf8');
  return parseConversacion(texto.split('\n'));
}
