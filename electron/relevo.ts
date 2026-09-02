import type { AccountUsage } from '../shared/types';

/**
 * Avisar cuando la cuenta en uso se quedó sin cupo, y con cuál seguir.
 *
 * Los límites de Claude son por cuenta y por ventana de tiempo: uno de sesión
 * (5 h) y uno semanal. Cuando cualquiera de los dos se llena, esa cuenta deja
 * de responder hasta que se restablece — y el usuario tiene otras cuentas
 * cargadas en la app, con cupo, sin usar.
 *
 * Hasta ahora había que darse cuenta a mano: abrir la terminal, chocarse con el
 * rechazo, volver a la app, cambiar de cuenta, reabrir. Peor en la terminal que
 * en Desktop, porque Desktop al menos lo dice en pantalla mientras que el CLI a
 * veces sólo se queda sin contestar.
 *
 * Esto NO cambia de cuenta. Lo dice y nada más. Cambiarla sola movería el gasto
 * a otra cuenta sin que nadie lo pidiera, y cuál usar es una decisión del
 * usuario —puede haber una cuenta de trabajo que no quiere tocar para algo
 * personal, o al revés—. La app señala; el usuario elige.
 *
 * Las conversaciones ya son compartidas por todas las cuentas —el `projects` de
 * cada una apunta al mismo pozo— así que cambiar de cuenta y reabrir sigue la
 * misma conversación, sin perder nada.
 */

export type Candidato = {
  id: string;
  name: string;
  /** Tiene credenciales del CLI vivas. Sin esto no puede abrir nada. */
  authenticated: boolean;
  usage: AccountUsage | null;
};

/**
 * El límite MÁS APRETADO de una cuenta, que es el que la frena: con el semanal
 * al 99% no importa que el de sesión esté en 3%.
 *
 * `-1` significa que no se sabe —cuenta nueva, sin datos, sin red—. Se
 * distingue de 0 a propósito: una cuenta sin datos no es una cuenta vacía, y
 * tratarla como la más libre la recomendaría primera sin fundamento.
 */
export function tope(usage: AccountUsage | null): number {
  if (!usage || usage.limits.length === 0) return -1;
  return Math.max(...usage.limits.map((l) => l.percent));
}

/**
 * El aviso para mostrar, o `null` si no hay nada que decir.
 *
 * El umbral es 95 y no 100 a propósito: un porcentaje que ya se leyó puede
 * tener hasta 30 s (`readUsage` cachea) y una respuesta larga consume mientras
 * tanto. Avisar recién al 100% es avisar cuando ya se chocó.
 *
 * Entre las cuentas con cupo recomienda la MÁS LIBRE de las que sabemos cómo
 * están. Una sin datos se nombra sólo si no hay ninguna medida: no saber no es
 * lo mismo que estar lleno, pero tampoco es una recomendación firme.
 */
export function avisoDeCupo(candidatos: Candidato[], activaId: string, umbral = 95): string | null {
  const activa = candidatos.find((c) => c.id === activaId);
  if (!activa) return null;

  const conCupo = (c: Candidato) => c.authenticated && tope(c.usage) < umbral;
  if (conCupo(activa)) return null;

  const porQue = activa.authenticated
    ? `La cuenta "${activa.name}" está al ${tope(activa.usage)}%`
    : `La cuenta "${activa.name}" no tiene la sesión iniciada`;

  const otras = candidatos.filter((c) => c.id !== activa.id && conCupo(c));
  const medidas = otras.filter((c) => tope(c.usage) >= 0).sort((a, b) => tope(a.usage) - tope(b.usage));
  const sugerida = medidas[0] ?? otras[0];

  if (!sugerida) return `${porQue}, y ninguna otra cuenta tiene cupo para reemplazarla.`;

  const cupo = tope(sugerida.usage) >= 0 ? `al ${tope(sugerida.usage)}%` : 'sin datos de consumo';
  return (
    `${porQue}. "${sugerida.name}" tiene cupo (${cupo}): cambiá de cuenta en el panel y reabrí, ` +
    'que la conversación es la misma para todas.'
  );
}
