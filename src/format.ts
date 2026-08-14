const RELATIVE = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000000],
  ['month', 2592000000],
  ['day', 86400000],
  ['hour', 3600000],
  ['minute', 60000]
];

/** "hace 3 horas" / "en 2 días", a partir de un timestamp en ms. */
export function relativeDate(ms: number): string {
  const diff = ms - Date.now();
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return RELATIVE.format(Math.round(diff / size), unit);
  }
  return 'hace un momento';
}

/** Las sesiones recién creadas pesan menos de 1 KB: redondearlas a "0 KB" se lee como un error. */
export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}
