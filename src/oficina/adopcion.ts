/** Cada cuánto se le vuelve a pedir a Pixel Agents una sesión que sigue sin personaje. */
export const REINTENTO_ADOPCION_MS = 60_000;

/**
 * Las sesiones abiertas que la oficina todavía no tiene y a las que toca pedirles
 * que entren. Cada una se reintenta a lo sumo una vez por `REINTENTO_ADOPCION_MS`:
 * un motor de Desktop que se pausó y volvió, o un personaje que Pixel Agents soltó,
 * tienen que poder reentrar; y una que Pixel Agents no quiere tomar (Watch All
 * Sessions apagado) no se le pide en cada refresco.
 *
 * No anota nada: quien llama registra el intento en `intentos`.
 */
export function sesionesAAdoptar<T extends { sessionId: string; transcript: string }>(
  agentes: T[],
  enPixel: Set<string>,
  intentos: Map<string, number>,
  ahoraMs: number
): T[] {
  return agentes.filter(
    (a) => a.transcript && !enPixel.has(a.sessionId) && ahoraMs - (intentos.get(a.sessionId) ?? -Infinity) >= REINTENTO_ADOPCION_MS
  );
}
