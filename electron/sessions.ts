import { createReadStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Entorno, ParsedSession, SessionMeta } from '../shared/types';

const PREVIEW_MAX = 140;

/** El primer `type: "user"` de una sesión suele no ser algo que el usuario
 *  escribió: los slash commands, el texto que Claude Code inyecta al reanudar
 *  y los recordatorios del sistema viajan por el mismo canal. Usarlos de
 *  preview llena la lista de "<command-message>…" y esconde de qué trata la
 *  sesión, así que se saltean y se sigue buscando el primer mensaje real. */
const NOT_A_PROMPT = /^(<(command-|local-command-|system-reminder|user-prompt-submit)|Caveat: The messages below)/;

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const block = content.find(
    (b): b is { type: string; text: string } =>
      typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text' && typeof (b as any).text === 'string'
  );
  return block ? block.text : '';
}

/**
 * Recorre las líneas de un .jsonl y devuelve los metadatos de la sesión.
 * Se puede cortar la iteración apenas devuelve un objeto con preview: el
 * lector incremental (`readSessionFile`) hace justo eso.
 */
export function parseSessionLines(lines: Iterable<string>): ParsedSession | null {
  let cwd = '';
  let gitBranch = '';
  let preview = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!cwd && typeof entry.cwd === 'string') {
      cwd = entry.cwd;
      if (typeof entry.gitBranch === 'string') gitBranch = entry.gitBranch;
    }

    if (!preview && entry.type === 'user') {
      const message = entry.message as { content?: unknown } | undefined;
      const text = extractText(message?.content).replace(/\s+/g, ' ').trim();
      if (text && !NOT_A_PROMPT.test(text)) preview = text.slice(0, PREVIEW_MAX);
    }

    if (cwd && preview) break;
  }

  if (!cwd) return null;
  return { cwd, gitBranch, preview };
}

/** Lee el .jsonl línea a línea y corta apenas el parser tiene lo que necesita. */
async function readSessionFile(filePath: string): Promise<ParsedSession | null> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines: string[] = [];
  try {
    for await (const line of rl) {
      lines.push(line);
      const parsed = parseSessionLines(lines);
      if (parsed && parsed.preview) return parsed;
    }
  } catch {
    return null;
  } finally {
    rl.close();
    // rl.close() no cierra el fs.ReadStream subyacente (verificado): sin este
    // destroy() explícito, cada corte anticipado deja el file handle abierto
    // hasta que el GC lo recolecte, y esto se ejecuta una vez por sesión.
    input.destroy();
  }
  return parseSessionLines(lines);
}

/**
 * Caché por archivo: la clave es la ruta completa del `.jsonl`, el valor
 * guarda el (mtimeMs, size) con el que se parseó junto al `SessionMeta`
 * resultante. Se indexa por identidad de archivo (mtime + tamaño) y no por
 * mtime de directorio porque un directorio no cambia de mtime cuando un
 * `.jsonl` YA EXISTENTE crece — que es exactamente lo que hace una sesión
 * activa al seguir agregando líneas. Comparar mtime+size del archivo mismo
 * hace que cualquier cambio real (o su borrado, al desaparecer del
 * recorrido) sea imposible de perder.
 *
 * Se poda por cuenta, no entera: `listSessions` corre una vez por perfil para
 * armar la lista unificada, y vaciar el mapa en cada llamada dejaría cacheada
 * sólo la última cuenta recorrida. Se borran nada más las entradas de ESTE
 * configDir que el recorrido ya no vio (archivos borrados), así que tampoco
 * quedan entradas colgadas creciendo sin límite.
 */
type FileCacheEntry = { mtimeMs: number; size: number; meta: SessionMeta };
const cache = new Map<string, FileCacheEntry>();

export async function listSessions(configDir: string, entorno: Entorno): Promise<SessionMeta[]> {
  const projectsDir = join(configDir, 'projects');

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return []; // el perfil todavía no tiene sesiones
  }
  const projectDirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const sessions: SessionMeta[] = [];
  const nextCache = new Map<string, FileCacheEntry>();

  for (const name of projectDirNames) {
    const projectDir = join(projectsDir, name);
    let files: string[];
    try {
      files = await readdir(projectDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(projectDir, file);
      try {
        const stats = await stat(filePath);
        const cached = cache.get(filePath);

        let meta: SessionMeta;
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
          meta = cached.meta; // archivo sin cambios: nos ahorramos volver a leerlo
        } else {
          const parsed = await readSessionFile(filePath);
          if (!parsed) continue;
          meta = {
            ...parsed,
            // El nombre del archivo, siempre. El `sessionId` de adentro puede ser
            // el de la sesión padre si este .jsonl es un fork, y usarlo haría que
            // borrar esta sesión apuntara al archivo de la otra.
            id: file.replace(/\.jsonl$/, ''),
            projectSlug: name,
            mtime: stats.mtimeMs,
            sizeBytes: stats.size,
            // Adentro del objeto cacheado, no puesto al salir: la caché guarda
            // este mismo objeto y la segunda llamada lo devuelve tal cual.
            raiz: configDir,
            entorno
          };
        }

        sessions.push(meta);
        nextCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, meta });
      } catch {
        continue; // archivo ilegible: se omite sin romper el escaneo
      }
    }
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  for (const key of [...cache.keys()]) {
    if (key.startsWith(projectsDir + sep) && !nextCache.has(key)) cache.delete(key);
  }
  for (const [key, entry] of nextCache) cache.set(key, entry);
  return sessions;
}

/**
 * Cuenta las compactaciones del transcript. Claude Code marca cada una con una
 * línea `subtype: "compact_boundary"`, y al reanudar arranca desde la última:
 * todo lo anterior queda reemplazado por el resumen. Es la razón por la que
 * una sesión reanudada "no carga completa", así que se avisa antes de abrirla.
 *
 * Lee el archivo entero (pueden ser 20 MB), por eso se llama sólo al reanudar
 * una sesión concreta y nunca durante el listado.
 */
export async function countCompactions(filePath: string): Promise<number> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of rl) {
      if (line.includes('"compact_boundary"')) count += 1;
    }
  } catch {
    return 0; // ilegible: no vale la pena romper el reanudar por el aviso
  } finally {
    rl.close();
    input.destroy();
  }
  return count;
}

/**
 * `child` está estrictamente dentro de `parent` (no es el mismo directorio,
 * y no es un directorio hermano que solo comparte el prefijo del nombre,
 * p.ej. "projects-backup" no cuenta como estar dentro de "projects").
 */
function isStrictlyInside(parent: string, child: string): boolean {
  return child.startsWith(parent + sep);
}

/** Rutas de una sesión dentro de un configDir, ya contenidas. Lanza si el slug
 *  o el id intentan salirse de `<configDir>/projects/`. */
function sessionPaths(configDir: string, projectSlug: string, id: string) {
  const projectsRoot = resolve(configDir, 'projects');
  const projectDir = resolve(projectsRoot, basename(projectSlug));
  const jsonl = resolve(projectDir, `${basename(id)}.jsonl`);
  const sidecar = resolve(projectDir, basename(id));
  if (!isStrictlyInside(projectsRoot, projectDir)) {
    throw new Error('El proyecto está fuera del directorio de sesiones.');
  }
  if (!isStrictlyInside(projectDir, jsonl) || !isStrictlyInside(projectDir, sidecar)) {
    throw new Error('El id de sesión es inválido.');
  }
  return { projectDir, jsonl, sidecar };
}

export async function deleteSession(configDir: string, projectSlug: string, id: string): Promise<void> {
  // basename() sigue siendo útil (evita separadores embebidos en el input),
  // pero NO es lo que impide escapar de <configDir>/projects/: basename('..')
  // devuelve '..' sin cambios, así que un projectSlug o id de '..' resuelve a
  // un directorio ancestro real. Lo que realmente contiene el borrado es la
  // aserción de contención que hace `sessionPaths`, que compara rutas ya
  // resueltas contra sus raíces esperadas. No quitarla pensando que
  // basename() ya alcanza.
  const { jsonl: jsonlPath, sidecar: sidecarPath } = sessionPaths(configDir, projectSlug, id);

  await rm(jsonlPath, { force: true });
  await rm(sidecarPath, { recursive: true, force: true });
  cache.delete(jsonlPath);
}
