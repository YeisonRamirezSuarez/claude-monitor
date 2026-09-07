import type { Entorno, Raiz } from '../shared/types';

/**
 * Si lo que la app afirma de una cuenta salió de mirar su disco, o de negarse a
 * mirarlo.
 *
 * `sinMirar` (`electron/profiles.ts`) devuelve `exists:false` y
 * `authenticated:false` para una cuenta a la que se NEGÓ a leerle el disco:
 * tocar la UNC de una distro apagada la enciende (1,90 s, 345 MB de
 * `vmmemWSL`). Leer esos `false` como hechos es afirmar cosas que nadie
 * verificó — "sin sesión", "(no disponible)"— sobre una cuenta que puede estar
 * perfectamente autorizada.
 *
 * Windows siempre se mira. En WSL depende del estado de la raíz: `apagada` y
 * `sin-distro` son exactamente los dos casos en que no se leyó nada;
 * `sin-config` y `sin-cli` significan que la distro estaba arriba y sí se miró.
 * Sin raíz todavía (el primer refresco, antes de que llegue la lista) tampoco
 * se miró nada.
 */
export function seLeMiroElDisco(entorno: Entorno | undefined, raiz: Raiz | undefined): boolean {
  if (entorno?.tipo !== 'wsl') return true;
  if (!raiz) return false;
  return raiz.estado.tipo !== 'apagada' && raiz.estado.tipo !== 'sin-distro';
}

/**
 * Qué se sabe de la sesión de una cuenta: cuatro estados, no tres.
 *
 * `sin-mirar` es el que faltaba, y es distinto de `sin-sesion` en lo único que
 * importa: uno es un dato y el otro es la ausencia de un dato. Ver
 * `seLeMiroElDisco`.
 */
export function estadoDeSesion(
  cuenta: { entorno?: Entorno; authenticated: boolean; authExpiresAt: number | null },
  raiz: Raiz | undefined
): 'sin-mirar' | 'sin-sesion' | 'suposicion' | 'viva' {
  if (!seLeMiroElDisco(cuenta.entorno, raiz)) return 'sin-mirar';
  if (!cuenta.authenticated) return 'sin-sesion';
  return cuenta.authExpiresAt === null ? 'suposicion' : 'viva';
}

/**
 * Si tiene sentido hablarle a esta cuenta de la extensión de Chrome.
 *
 * Nunca para una cuenta de WSL: `chrome.extension` y `chrome.loggedIn` no van a
 * ser `true` ahí jamás —el puente es un `.bat` de Windows que `ensureHostScript`
 * se niega a escribir, y el CLI corre en Linux—, así que el cartel "primero hay
 * que instalar la extensión…" no sólo es falso: es permanente. */
export const hablarDeChrome = (entorno: Entorno | undefined): boolean => entorno?.tipo !== 'wsl';

/** La marca de origen de una sesión. Vacía en Windows a propósito: son la
 *  mayoría, y marcarlas todas convierte la marca en ruido. */
export const etiquetaDeEntorno = (e: Entorno): string => (e.tipo === 'wsl' ? e.distro : '');

/** Por qué una acción sigue deshabilitada para una cuenta de WSL. Un botón
 *  deshabilitado sin motivo se lee como un bug; con motivo, como una
 *  frontera. Desde la Task 14, reanudar y crear en terminal ya funcionan
 *  desde el panel: lo que queda deshabilitado tiene dos motivos distintos,
 *  no uno solo:
 *  - Desktop es una app de Windows y no puede hospedar una sesión de la
 *    distro (permanente, spec §7).
 *  - Borrar sesiones de WSL no está habilitado en esta rebanada (decisión de
 *    producto, spec §9 — no una imposibilidad técnica). */
export const motivoDeshabilitado = (e: Entorno, contexto: 'desktop' | 'borrar' = 'desktop'): string => {
  if (e.tipo !== 'wsl') return '';
  return contexto === 'borrar'
    ? `Borrar sesiones de ${e.distro} no está disponible todavía`
    : `Claude Desktop no puede abrir sesiones de ${e.distro}`;
};

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

/** Los tokens llegan a las centenas de millones: escritos enteros no se leen.
 *  Lo compacta `Intl` —"1,2 M", "345 mil"— en castellano y sin tabla propia. */
const COMPACTO = new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 });
export const formatTokens = (n: number): string => COMPACTO.format(n);

/** Con separadores de miles, para el detalle donde el número exacto importa. */
const EXACTO = new Intl.NumberFormat('es');
export const formatExact = (n: number): string => EXACTO.format(n);

/** Nombre corto de un proyecto: la última carpeta de su ruta. */
export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** Las sesiones recién creadas pesan menos de 1 KB: redondearlas a "0 KB" se lee como un error. */
export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}
