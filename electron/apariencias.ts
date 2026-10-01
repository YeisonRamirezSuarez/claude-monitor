/**
 * Cómo se ve cada agente en la oficina ("Personalizar", parche de Pixel Agents
 * en `vendor/pixel-agents`): el cuerpo, los colores, el peinado, la ropa…
 *
 * Viven en `%APPDATA%\claude-monitor\apariencias.json`: una por sesión
 * (`sesiones[sessionId]`) y una por cuenta (`cuentas[profileId]`), que es la de
 * todas sus sesiones que no tienen la suya. La oficina valida cada valor otra
 * vez al dibujarlo (`cleanLook`); acá sólo se deja pasar la forma.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Apariencia, Apariencias } from '../shared/types';

const archivo = () =>
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'claude-monitor', 'apariencias.json');

const SESION = /^[0-9a-fA-F-]{36}$/;
const CUENTA = /^[a-zA-Z0-9_-]{1,64}$/;
const CAMPOS = new Set(['base', 'skin', 'hair', 'top', 'bottom', 'shoes', 'hatColor', 'hairStyle', 'hat', 'glasses', 'beard', 'outfit', 'build']);

/** Sólo campos conocidos con valores cortos; `null` si no es una apariencia. */
export function limpiar(v: unknown): Apariencia | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const base = (v as Record<string, unknown>).base;
  if (!Number.isInteger(base) || (base as number) < 0 || (base as number) > 5) return null;
  const out: Apariencia = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!CAMPOS.has(k)) continue;
    if (k === 'base') out.base = x as number;
    else if (typeof x === 'string' && /^[#a-z0-9]{1,16}$/i.test(x)) out[k] = x;
  }
  return out;
}

export async function leerApariencias(): Promise<Apariencias> {
  try {
    const d = JSON.parse(await readFile(archivo(), 'utf8')) as Partial<Apariencias>;
    return { sesiones: d.sesiones ?? {}, cuentas: d.cuentas ?? {} };
  } catch {
    return { sesiones: {}, cuentas: {} };
  }
}

/**
 * Guarda (o borra, con `null`) la apariencia de una sesión o de una cuenta.
 * Guardar la de la cuenta también le saca a esa sesión la suya: si no, la
 * sesión desde la que se eligió seguiría con la vieja.
 */
export async function guardarApariencia(
  alcance: 'sesion' | 'cuenta',
  sessionId: string,
  profileId: string,
  apariencia: unknown
): Promise<Apariencias> {
  if (!SESION.test(sessionId)) throw new Error(`Sesión inválida: ${sessionId}`);
  if (alcance === 'cuenta' && !CUENTA.test(profileId)) throw new Error(`Cuenta inválida: ${profileId}`);
  const limpia = apariencia === null ? null : limpiar(apariencia);
  if (apariencia !== null && !limpia) throw new Error('Apariencia inválida.');
  const todas = await leerApariencias();
  if (alcance === 'cuenta') {
    if (limpia) todas.cuentas[profileId] = limpia;
    else delete todas.cuentas[profileId];
    delete todas.sesiones[sessionId];
  } else if (limpia) todas.sesiones[sessionId] = limpia;
  else delete todas.sesiones[sessionId];
  const ruta = archivo();
  await mkdir(dirname(ruta), { recursive: true });
  await writeFile(`${ruta}.tmp`, JSON.stringify(todas, null, 2), 'utf8');
  await rename(`${ruta}.tmp`, ruta);
  return todas;
}

/** La que se ve: la de la sesión, si no la de su cuenta, si no ninguna. */
export const aparienciaDe = (a: Apariencias, sessionId: string, profileId: string): Apariencia | null =>
  a.sesiones[sessionId] ?? a.cuentas[profileId] ?? null;
