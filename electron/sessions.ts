import { createReadStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { ParsedSession, SessionMeta } from '../shared/types';

const PREVIEW_MAX = 140;

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
      if (text) preview = text.slice(0, PREVIEW_MAX);
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
 * Se reconstruye por completo en cada `listSessions` a partir de lo que el
 * recorrido efectivamente vio, así que un archivo borrado o un cambio de
 * perfil no dejan entradas colgadas creciendo sin límite.
 */
type FileCacheEntry = { mtimeMs: number; size: number; meta: SessionMeta };
let cache = new Map<string, FileCacheEntry>();

export async function listSessions(configDir: string): Promise<SessionMeta[]> {
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
            sizeBytes: stats.size
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
  cache = nextCache;
  return sessions;
}

/**
 * `child` está estrictamente dentro de `parent` (no es el mismo directorio,
 * y no es un directorio hermano que solo comparte el prefijo del nombre,
 * p.ej. "projects-backup" no cuenta como estar dentro de "projects").
 */
function isStrictlyInside(parent: string, child: string): boolean {
  return child.startsWith(parent + sep);
}

export async function deleteSession(configDir: string, projectSlug: string, id: string): Promise<void> {
  // basename() sigue siendo útil (evita separadores embebidos en el input),
  // pero NO es lo que impide escapar de <configDir>/projects/: basename('..')
  // devuelve '..' sin cambios, así que un projectSlug o id de '..' resuelve a
  // un directorio ancestro real. Lo que realmente contiene el borrado es la
  // aserción de contención de abajo, que compara rutas ya resueltas contra
  // sus raíces esperadas. No quitar esa aserción pensando que basename() ya
  // alcanza.
  const projectsRoot = resolve(configDir, 'projects');
  const projectDir = resolve(projectsRoot, basename(projectSlug));
  const jsonlPath = resolve(projectDir, `${basename(id)}.jsonl`);
  const sidecarPath = resolve(projectDir, basename(id));

  if (!isStrictlyInside(projectsRoot, projectDir)) {
    throw new Error('No se puede borrar la sesión: el proyecto está fuera del directorio de sesiones.');
  }
  if (!isStrictlyInside(projectDir, jsonlPath) || !isStrictlyInside(projectDir, sidecarPath)) {
    throw new Error('No se puede borrar la sesión: el id de sesión es inválido.');
  }

  await rm(jsonlPath, { force: true });
  await rm(sidecarPath, { recursive: true, force: true });
  cache.delete(jsonlPath);
}
