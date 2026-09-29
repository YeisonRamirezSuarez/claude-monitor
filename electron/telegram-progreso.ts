/**
 * El mensaje "⏳ Trabajando…" que se ve en el tema de una sesión mientras hace
 * lo que se le pidió desde Telegram: sus últimos pasos (herramientas y lo que va
 * escribiendo), sacados del transcript. Se edita a medida que avanza y se borra
 * cuando termina, como hacen los bots que "escriben en vivo".
 *
 * El razonamiento interno del modelo no queda en el transcript: se ve lo que
 * hace y lo que dice, no lo que piensa.
 */

import type { ConversacionItem } from '../shared/types';

const MAX_PASOS = 8;
const MAX_TEXTO = 160;

const corto = (s: string) => {
  const una = s.replace(/\s+/g, ' ').trim();
  return una.length > MAX_TEXTO ? `${una.slice(0, MAX_TEXTO - 1)}…` : una;
};

function linea(i: ConversacionItem): string | null {
  if (i.tipo === 'herramienta') {
    const marca = i.resultado === null ? '⏳' : i.error ? '❌' : '✔️';
    return `${marca} ${i.nombre}${i.detalle ? ` — ${corto(i.detalle)}` : ''}`;
  }
  if (i.tipo === 'claude') return i.texto.trim() ? `💬 ${corto(i.texto)}` : null;
  if (i.tipo === 'subagente') return `👥 ${i.tipoAgente || 'subagente'}${i.descripcion ? ` — ${corto(i.descripcion)}` : ''}`;
  return null;
}

/** El texto del mensaje de progreso para el turno en curso. */
export function progresoDe(items: ConversacionItem[]): string {
  let desde = 0;
  items.forEach((i, n) => {
    if (i.tipo === 'usuario') desde = n + 1;
  });
  const pasos = items.slice(desde).map(linea).filter((l): l is string => l !== null);
  if (!pasos.length) return '⏳ Trabajando…';
  const ocultos = pasos.length - MAX_PASOS;
  const visibles = ocultos > 0 ? [`(+${ocultos} pasos antes)`, ...pasos.slice(-MAX_PASOS)] : pasos;
  return `⏳ Trabajando…\n\n${visibles.join('\n')}`;
}
