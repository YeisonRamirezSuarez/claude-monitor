import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Lo que la app sabe del navegador de cada cuenta, guardado en disco.
 *
 * Antes esto se deducía en cada lectura hurgando en los archivos de Chrome. Y
 * hurgar sale mal: mientras Chrome escribe, o mientras se copia un perfil, lo
 * que se lee no refleja la realidad. Dos veces la app llegó a decir "falta
 * iniciar sesión" sobre una cuenta que la tenía perfectamente.
 *
 * La diferencia clave está en `merge`: una observación afirmativa siempre vale,
 * pero una negativa sólo se cree si de verdad se pudo leer. Si no se pudo, se
 * conserva lo último que se supo. Nunca se degrada un estado bueno por no haber
 * podido mirar.
 *
 * Un archivo por cuenta, para que un archivo corrupto se lleve puesta una sola.
 */

export type Visto = { ok: boolean; seenAt: number };

export type BrowserRecord = {
  id: string;
  /** La carpeta de datos de Chrome de esta cuenta, anotada al crearla. Que hoy
   *  se pueda derivar del id no la hace prescindible: queda explícito a qué
   *  navegador pertenece la cuenta, aunque mañana cambie cómo se arman. */
  userDataDir: string;
  displayName: string;
  createdAt: number;
  session: Visto | null;
  extension: Visto | null;
};

/** Lo que se acaba de mirar. `readable` distingue "miré y no está" de "no pude
 *  mirar", que es justo lo que antes se confundía. */
export type Observacion = { ok: boolean; readable: boolean };

export const recordPath = (baseDir: string, id: string) => join(baseDir, `${id.replace(/[^A-Za-z0-9-]/g, '')}.json`);

export async function readRecord(baseDir: string, id: string): Promise<BrowserRecord | null> {
  const raw = await readFile(recordPath(baseDir, id), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw) as BrowserRecord;
    return typeof o?.id === 'string' ? o : null;
  } catch {
    return null; // corrupto: se rearma solo en la próxima escritura
  }
}

export async function writeRecord(baseDir: string, record: BrowserRecord): Promise<void> {
  const path = recordPath(baseDir, record.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * Combina lo guardado con lo recién observado.
 *
 * `null` como registro previo es una cuenta que nunca se anotó: se arma uno.
 */
export function merge(
  previo: BrowserRecord | null,
  datos: { id: string; userDataDir: string; displayName: string },
  session: Observacion,
  extension: Observacion,
  ahora = Date.now()
): BrowserRecord {
  return {
    id: datos.id,
    userDataDir: datos.userDataDir,
    displayName: datos.displayName,
    createdAt: previo?.createdAt ?? ahora,
    session: mergeVisto(previo?.session ?? null, session, ahora),
    extension: mergeVisto(previo?.extension ?? null, extension, ahora)
  };
}

function mergeVisto(previo: Visto | null, ahoraVisto: Observacion, ahora: number): Visto | null {
  // Se pudo mirar: lo que se vio es la verdad, para bien o para mal.
  if (ahoraVisto.readable) return { ok: ahoraVisto.ok, seenAt: ahora };
  // No se pudo mirar: se conserva lo último que se supo. Inventar un "no" acá
  // es lo que hacía aparecer avisos falsos de "falta iniciar sesión".
  return previo;
}

/** Lo que hay que mostrar: lo último que se supo, o `false` si nunca se supo
 *  nada — una cuenta sin registro todavía no configuró su navegador. */
export const vale = (v: Visto | null): boolean => v?.ok ?? false;
