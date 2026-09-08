import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageLimit } from '../shared/types';

/**
 * Lo último que la API contestó de verdad sobre una cuenta, guardado en disco.
 *
 * Existe por el mismo motivo que `browser-store.ts`: no degradar un estado
 * bueno por no haber podido mirar. Antes, cualquier tropiezo de la consulta en
 * vivo —el token de acceso vencido, un timeout, la red— dejaba al panel con lo
 * único que quedaba, la caché que escribe el CLI. Y esa caché en la práctica
 * está muerta: en esta máquina se midieron 5, 13 y 25 días de atraso, y una
 * cuenta directamente sin caché. Como `vigentes()` descarta con razón un
 * porcentaje cuya ventana ya se restableció, el resultado visible era que las
 * barras desaparecían y aparecía "Sin datos de consumo al día" en una cuenta
 * que estaba perfecta.
 *
 * Con esto, un tropiezo pasa de borrar los números a envejecerlos, y el panel
 * puede decir de cuándo son.
 *
 * Vive en LOCALAPPDATA y NO adentro del `configDir`: el de una cuenta WSL es
 * una UNC, y escribir ahí encendería la distro además de ensuciarle el
 * `~/.claude` real al usuario.
 */

export type UltimoBueno = {
  limits: UsageLimit[];
  email: string;
  accountName: string;
  /** Cuándo lo contestó la API. */
  savedAt: number;
};

const localAppData = () => process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');

/** Dónde se anota lo último bueno de cada cuenta. */
export const storeDeConsumo = () => join(localAppData(), 'claude-monitor', 'usage');

/**
 * El archivo de una cuenta.
 *
 * La clave es el `configDir` porque es lo único que `readUsage` recibe, y se
 * pasa por un hash porque una carpeta no es un nombre de archivo: la de una
 * cuenta WSL es `\wsl.localhost\Ubuntu\home\...`, con barras y dos puntos.
 */
export const archivoDe = (baseDir: string, configDir: string): string =>
  join(baseDir, `${createHash('sha1').update(configDir).digest('hex').slice(0, 16)}.json`);

export async function leerUltimoBueno(baseDir: string, configDir: string): Promise<UltimoBueno | null> {
  const raw = await readFile(archivoDe(baseDir, configDir), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw) as UltimoBueno & { configDir?: string };
    return Array.isArray(o?.limits) && typeof o?.savedAt === 'number'
      ? { limits: o.limits, email: o.email ?? '', accountName: o.accountName ?? '', savedAt: o.savedAt }
      : null;
  } catch {
    return null; // corrupto: se rearma solo en la próxima consulta que salga bien
  }
}

/** Nunca lanza: no poder anotar el consumo no puede romper el refresco que lo
 *  estaba mostrando. */
export async function guardarUltimoBueno(
  baseDir: string,
  configDir: string,
  datos: { limits: UsageLimit[]; email: string; accountName: string },
  ahora = Date.now()
): Promise<void> {
  const contenido = { configDir, ...datos, savedAt: ahora };
  await mkdir(baseDir, { recursive: true })
    .then(() => writeFile(archivoDe(baseDir, configDir), `${JSON.stringify(contenido, null, 2)}\n`, 'utf8'))
    .catch(() => {});
}
