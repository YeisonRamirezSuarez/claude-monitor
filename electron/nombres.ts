/**
 * Los nombres y notas que el usuario le pone a sus agentes en la oficina.
 *
 * Viven en `%APPDATA%\claude-monitor\nombres.json`, al lado de `profiles.json`,
 * porque Pixel Agents los lee de ahí para las etiquetas de los personajes (ver
 * `vendor/pixel-agents/claude-monitor.patch`). La clave es el `sessionId` de la
 * sesión, o `<sessionId>/<agentId>` para un subagente: un nombre por
 * conversación, no por carpeta, porque en la misma carpeta suele haber varias.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Nombre = { nombre: string; nota: string };
export type Nombres = Record<string, Nombre>;

const archivo = () =>
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'claude-monitor', 'nombres.json');

const CLAVE = /^[0-9a-fA-F-]{36}(\/[a-zA-Z0-9_-]+)?$/;
const MAX = 200;

export async function leerNombres(): Promise<Nombres> {
  try {
    const datos = JSON.parse(await readFile(archivo(), 'utf8'));
    return typeof datos === 'object' && datos !== null ? (datos as Nombres) : {};
  } catch {
    return {};
  }
}

/** Guarda o borra (con los dos campos vacíos) el nombre de un agente. */
export async function nombrar(clave: string, nombre: string, nota: string): Promise<Nombres> {
  if (typeof clave !== 'string' || !CLAVE.test(clave)) throw new Error(`Agente inválido: ${clave}`);
  const limpio = { nombre: String(nombre ?? '').trim().slice(0, MAX), nota: String(nota ?? '').trim().slice(0, MAX * 5) };
  const todos = await leerNombres();
  if (limpio.nombre || limpio.nota) todos[clave] = limpio;
  else delete todos[clave];
  const ruta = archivo();
  await mkdir(dirname(ruta), { recursive: true });
  // Se escribe al lado y se renombra: Pixel Agents lo lee en cualquier momento
  // y no puede agarrar un JSON a medio escribir.
  await writeFile(`${ruta}.tmp`, JSON.stringify(todos, null, 2), 'utf8');
  await rename(`${ruta}.tmp`, ruta);
  return todos;
}
