/**
 * La configuración del puente de Telegram en `%APPDATA%\claude-monitor\telegram.json`.
 * El token del bot va cifrado (en la app, con `safeStorage` de Electron): quien
 * tenga el token puede mandar mensajes como el bot y leer lo que le llega.
 */

import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ConfigRemoto = {
  activo: boolean;
  token: string;
  chatId: number | null;
  userId: number | null;
  umbralMin: number;
  offset: number;
  temas: Record<string, number>;
};
export type Cifrador = { cifrar: (t: string) => Buffer; descifrar: (b: Buffer) => string };

export const CONFIG_INICIAL: ConfigRemoto = { activo: false, token: '', chatId: null, userId: null, umbralMin: 10, offset: 0, temas: {} };

function esNumero(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function validarTemas(t: unknown): Record<string, number> {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return {};
  const resultado: Record<string, number> = {};
  for (const [k, v] of Object.entries(t)) {
    if (esNumero(v)) resultado[k] = v;
  }
  return resultado;
}

export async function leerConfig(archivo: string, c: Cifrador): Promise<ConfigRemoto> {
  try {
    const raw = JSON.parse(await readFile(archivo, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return { ...CONFIG_INICIAL, temas: {} };

    const d = raw as Record<string, unknown>;

    // Decodificar el token en su propio try (perfil movido a otro usuario de Windows:
    // hay que volver a pegar el token, no perder los temas).
    let token = '';
    try {
      token = typeof d.tokenCifrado === 'string' ? c.descifrar(Buffer.from(d.tokenCifrado, 'base64')) : '';
    } catch {
      // Si el descifrado falla, dejamos token vacío.
    }
    const activo = token !== '' && d.activo === true;

    // Validar cada campo.
    const chatId = esNumero(d.chatId) ? d.chatId : null;
    const userId = esNumero(d.userId) ? d.userId : null;
    const umbralMin = esNumero(d.umbralMin) ? Math.max(1, Math.min(240, d.umbralMin as number)) : 10;
    const offset = typeof d.offset === 'number' && Number.isFinite(d.offset) && d.offset >= 0 ? Math.floor(d.offset) : 0;
    const temas = validarTemas(d.temas);

    return { activo, token, chatId, userId, umbralMin, offset, temas };
  } catch {
    return { ...CONFIG_INICIAL, temas: {} };
  }
}

export async function guardarConfig(archivo: string, cfg: ConfigRemoto, c: Cifrador): Promise<void> {
  const { token, ...resto } = cfg;
  const datos = { ...resto, tokenCifrado: token ? c.cifrar(token).toString('base64') : '' };
  await mkdir(dirname(archivo), { recursive: true });
  const tmp = `${archivo}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(datos, null, 2), 'utf8');
  try {
    await rename(tmp, archivo);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export const nuevoCodigo = (ahora = Date.now()) => ({
  codigo: String(randomInt(0, 1_000_000)).padStart(6, '0'),
  vence: ahora + 10 * 60_000
});

/** Las imágenes que llegaron por Telegram no se guardan para siempre (spec §8: 7 días). */
export async function borrarViejas(carpeta: string, maxMs: number, ahora = Date.now()): Promise<number> {
  let borradas = 0;
  for (const sub of await readdir(carpeta).catch(() => [] as string[])) {
    for (const f of await readdir(join(carpeta, sub)).catch(() => [] as string[])) {
      const ruta = join(carpeta, sub, f);
      const s = await stat(ruta).catch(() => null);
      if (s?.isFile() && ahora - s.mtimeMs > maxMs) {
        await rm(ruta, { force: true });
        borradas++;
      }
    }
  }
  return borradas;
}
