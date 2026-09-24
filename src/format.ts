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

/**
 * Por qué "Borrar" sigue deshabilitado en una sesión de la distro. Un botón
 * deshabilitado sin motivo se lee como un bug; con motivo, como una frontera.
 *
 * Es el ÚNICO que queda. Antes también cubría los botones de Desktop, sobre la
 * premisa de que "Desktop es una app de Windows y no puede hospedar una sesión
 * de la distro" — falsa: Desktop tiene su propio selector Local / Nube /
 * Control remoto / WSL / SSH. Reanudar y crear en Desktop ya andan con una
 * cuenta de la distro, así que esa rama se fue con ellos.
 *
 * Borrar no es una imposibilidad técnica —por la UNC funcionaría— sino una
 * decisión de producto: spec §9.
 */
export const motivoDeshabilitado = (e: Entorno): string =>
  e.tipo === 'wsl' ? `Borrar sesiones de ${e.distro} no está disponible todavía` : '';

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

/**
 * Qué contarle al usuario de cada motivo por el que no se pudo consultar en
 * vivo. Dice qué hacer cuando hay algo que hacer: nombrar el problema y nada
 * más deja al usuario igual de trabado que el silencio que había antes.
 *
 * Un motivo desconocido —uno nuevo del lado de `electron/usage.ts`— se muestra
 * tal cual en vez de desaparecer, por el mismo criterio que un `kind` de límite
 * que no conocemos.
 */
const MOTIVOS: Record<string, string> = {
  'sin-credenciales': 'esta cuenta no tiene la sesión iniciada',
  'token-vencido': 'el token venció; usá la cuenta una vez y se renueva solo',
  'sin-limites': 'la API respondió sin límites',
  'api-rechazo': 'la API rechazó la consulta',
  'sin-respuesta': 'sin respuesta de la API (red o demora)'
};

export const textoDeMotivo = (motivo: string): string => MOTIVOS[motivo] ?? motivo;

/**
 * La línea al pie del consumo: de cuándo son los números y, si no son de ahora,
 * por qué.
 *
 * Antes decía sólo "en vivo" o "caché del CLI", así que cuando el panel se
 * quedaba sin números no había nada que mirar. El motivo es la mitad del
 * arreglo: "el token venció" y "sin respuesta de la API" se ven igual en
 * pantalla y se resuelven distinto.
 */
export function procedenciaDeConsumo(u: {
  origen: 'vivo' | 'guardado' | 'cli';
  motivo: string;
  fetchedAtMs: number;
}): string {
  if (u.origen === 'vivo') return 'en vivo';
  const cuando =
    u.fetchedAtMs > 0
      ? `${u.origen === 'cli' ? 'caché del CLI' : 'último dato'}, de ${relativeDate(u.fetchedAtMs)}`
      : u.origen === 'cli'
        ? 'caché del CLI'
        : 'último dato';
  return u.motivo ? `${cuando} · ${textoDeMotivo(u.motivo)}` : cuando;
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

/**
 * Las raíces cuyas sesiones NO están en la lista, y por qué.
 *
 * Existe porque la lista de sesiones no puede quedarse muda cuando le faltan
 * las de una distro. El pozo de Windows se lee siempre, así que sus sesiones
 * están siempre; las de una distro apagada no, y la lista se ve exactamente
 * igual que si esa persona nunca hubiera trabajado adentro de Ubuntu. Es el
 * síntoma de "no carga el historial de WSL, el de Windows sí": la explicación
 * existía sólo en la tarjeta de la cuenta, en la barra lateral, a un panel de
 * distancia de donde se nota que faltan.
 *
 * Devuelve la distro además del mensaje para poder ofrecer el botón de
 * encender ahí mismo: decir "Distro apagada" sin la salida al lado obliga a ir
 * a buscarla.
 */
export function raicesMudas(raices: Raiz[]): Array<{ distro: string; mensaje: string; apagada: boolean }> {
  const vistas = new Set<string>();
  return raices
    .filter((r) => r.entorno.tipo === 'wsl' && r.estado.tipo !== 'ok')
    .map((r) => ({
      distro: (r.entorno as Extract<Entorno, { tipo: 'wsl' }>).distro,
      mensaje: r.estado.tipo !== 'ok' ? r.estado.mensaje : '',
      apagada: r.estado.tipo === 'apagada'
    }))
    // Una por distro, no una por cuenta: dos cuentas en la misma distro miran
    // el mismo `~/.claude`, así que dirían dos veces lo mismo — y con la misma
    // `key` de React, que además es un bug de renderizado.
    .filter(({ distro }) => !vistas.has(distro) && vistas.add(distro));
}
