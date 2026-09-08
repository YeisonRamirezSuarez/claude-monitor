import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountUsage, UsageLimit } from '../shared/types';
import { canCallApi } from './credentials';
import { anotar } from './registro';
import { guardarUltimoBueno, leerUltimoBueno, storeDeConsumo } from './usage-store';

/** Los mismos endpoints que usa el CLI: consumo y dueño del token. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TIMEOUT_MS = 6000;
/** `listProfiles` corre en cada refresco y al volver el foco a la ventana. Sin
 *  esta ventana mínima, cada cuenta se llevaría una request por cada uno. */
const LIVE_TTL_MS = 30_000;

/** Claude Code nombra los límites por `kind`; acá sólo se traducen los que
 *  conocemos. Uno desconocido se muestra con su propio nombre en vez de
 *  desaparecer: un límite nuevo del que no sabemos nada igual le importa
 *  al usuario. */
const LABELS: Record<string, string> = {
  session: 'Sesión (5 h)',
  weekly_all: 'Semanal',
  weekly_opus: 'Semanal · Opus',
  opus: 'Opus'
};

type Live = { limits: UsageLimit[]; email: string; accountName: string };
const liveCache = new Map<string, Live & { at: number }>();

function toLimit(raw: unknown): UsageLimit | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.kind !== 'string' || typeof l.percent !== 'number') return null;
  return {
    kind: l.kind,
    label: LABELS[l.kind] ?? l.kind,
    percent: Math.max(0, Math.min(100, Math.round(l.percent))),
    severity: typeof l.severity === 'string' ? l.severity : 'normal',
    resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null
  };
}

function toLimits(utilization: unknown): UsageLimit[] {
  const raw = (utilization as { limits?: unknown } | undefined)?.limits;
  if (!Array.isArray(raw)) return [];
  return raw.map(toLimit).filter((l): l is UsageLimit => l !== null);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * El porqué de una consulta en vivo que no salió.
 *
 * Antes esto era un `null` pelado y la falla era invisible: el panel mostraba
 * números viejos —o ninguno— sin decir por qué, y en el registro de la app no
 * quedaba nada. Se revisó un `panel.log` de 24 kB y no tenía UNA sola línea
 * sobre el consumo. Sin el motivo no hay forma de distinguir "el token venció"
 * de "no hay red", que se arreglan de maneras distintas.
 */
export type MotivoFalla =
  | 'sin-credenciales'
  | 'token-vencido'
  | 'sin-limites'
  | 'api-rechazo'
  | 'sin-respuesta';

// El texto que ve el usuario para cada motivo vive en `src/format.ts`: acá el
// motivo viaja como código, que es lo que sirve para el registro y para que la
// interfaz decida cómo decirlo.

type Consulta = { live: Live | null; motivo: MotivoFalla | null };

/**
 * Consulta el consumo real de la cuenta.
 *
 * Usa el token OAuth que el CLI ya dejó en `<configDir>/.credentials.json`,
 * porque la caché del CLI se refresca en su propio horario y puede estar horas
 * atrasada (visto: 61% cacheado contra 85% real). El token se lee, se manda en
 * el header a api.anthropic.com —el mismo destino al que lo manda el CLI— y no
 * se guarda ni se registra en ningún lado.
 *
 * Cuando sale bien se anota en disco, para que el próximo tropiezo no borre
 * los números. Ver `usage-store.ts`.
 */
async function fetchLive(configDir: string): Promise<Consulta> {
  const cached = liveCache.get(configDir);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return { live: cached, motivo: null };

  const credentials = await readJson(join(configDir, '.credentials.json'));
  const token = (credentials?.claudeAiOauth as { accessToken?: unknown } | undefined)?.accessToken;
  if (typeof token !== 'string' || !token) return { live: null, motivo: 'sin-credenciales' };
  // Un token de acceso vencido devuelve 401. La cuenta sigue logueada —el CLI
  // lo renueva solo, ver `credentials.ts`— pero hasta que eso pase el consumo
  // sale de lo guardado. Se chequea antes para no gastar un timeout por cuenta
  // en cada refresco pidiendo algo que ya se sabe que va a fallar.
  if (!canCallApi(credentials)) return { live: null, motivo: 'token-vencido' };

  const get = async (url: string) => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  };

  try {
    const [usage, profile] = await Promise.all([get(USAGE_URL), get(PROFILE_URL)]);
    // `usage` en null es la API contestando algo que no es 2xx; sin límites en
    // una respuesta buena es otra cosa, y se distinguen porque se arreglan
    // distinto.
    if (usage === null) return { live: null, motivo: 'api-rechazo' };
    const limits = toLimits(usage);
    if (!limits.length) return { live: null, motivo: 'sin-limites' };
    // La cuenta se resuelve preguntando de quién es el token, no leyendo el
    // `.claude.json`: ese archivo guarda la última cuenta que el CLI escribió
    // ahí y queda desactualizado si otro login pisó las credenciales. Cuando
    // pasa, la carpeta dice una cuenta y el consumo es de otra.
    const account = profile?.account as Record<string, unknown> | undefined;
    const live: Live = {
      limits,
      email: typeof account?.email === 'string' ? account.email : '',
      accountName: typeof account?.display_name === 'string' ? account.display_name : ''
    };
    liveCache.set(configDir, { ...live, at: Date.now() });
    await guardarUltimoBueno(storeDeConsumo(), configDir, live);
    return { live, motivo: null };
  } catch {
    return { live: null, motivo: 'sin-respuesta' }; // sin red, timeout, o respuesta ilegible
  }
}

/** El último motivo anotado por cuenta, para no repetir la misma línea en cada
 *  refresco: el panel se refresca al volver el foco a la ventana, y un registro
 *  con mil líneas iguales no se lee. */
const ultimoMotivo = new Map<string, MotivoFalla | null>();

function anotarSiCambio(configDir: string, motivo: MotivoFalla | null): void {
  if (ultimoMotivo.get(configDir) === motivo) return;
  ultimoMotivo.set(configDir, motivo);
  if (motivo) anotar('consumo: no se pudo consultar en vivo', { configDir, motivo });
  else anotar('consumo: en vivo de nuevo', { configDir });
}

/**
 * ¿La caché que hay en esta carpeta es de esta cuenta?
 *
 * `cachedUsageUtilization` la escribe el CLI con el `accountUuid` del token que
 * tenía en ese momento. Si después se autorizó otra cuenta sobre la misma
 * carpeta —o la carpeta se copió para arrancar una cuenta nueva— la caché
 * queda ahí, de la cuenta anterior, y sin este chequeo se muestra como si
 * fuera del dueño actual: visto en la cuenta de trabajo mostrando el consumo
 * de la cuenta personal.
 *
 * Sin `accountUuid` de alguno de los dos lados no hay con qué desmentirla, y
 * se acepta: un CLI viejo que no lo escribía no es motivo para dejar a la
 * cuenta sin datos.
 */
export function cacheDeLaCuenta(account: unknown, cached: unknown): boolean {
  const suyo = (account as { accountUuid?: unknown } | undefined)?.accountUuid;
  const deLaCache = (cached as { accountUuid?: unknown } | undefined)?.accountUuid;
  if (typeof suyo !== 'string' || typeof deLaCache !== 'string') return true;
  return suyo === deLaCache;
}

/**
 * Los límites que todavía significan algo: los que aún no se restablecieron.
 *
 * Un porcentaje es de una ventana de tiempo. Pasado su `resets_at` la ventana
 * arrancó de cero y ese número dejó de describir nada — la caché de una cuenta
 * que hace una semana no se usa mostraba "56%" sobre una sesión de 5 h que se
 * reinició seis veces desde entonces, con un "se restablece hace 7 días"
 * abajo. Mejor no decir nada que decir eso.
 *
 * Los que no traen fecha se quedan: no se puede probar que vencieron.
 */
export function vigentes(limits: UsageLimit[], now = Date.now()): UsageLimit[] {
  return limits.filter((l) => !l.resetsAt || Date.parse(l.resetsAt) > now);
}

/**
 * Consumo de una cuenta, por orden de confianza: en vivo, lo último que la API
 * contestó, y recién ahí la caché del CLI.
 *
 * El escalón del medio es nuevo y es el que arregla el bug que se veía: sin él,
 * cualquier tropiezo de la consulta en vivo caía directo a la caché del CLI, y
 * esa caché en la práctica está muerta —se midieron 5, 13 y 25 días de atraso
 * en las cuentas de esta máquina, y una sin caché—, así que `vigentes()` la
 * descartaba entera y las barras desaparecían. Un timeout de 6 s en una máquina
 * cargada alcanzaba para vaciar el panel de una cuenta que estaba perfecta.
 *
 * `origen` dice de dónde salió cada número y `motivo` por qué no se pudo mejor:
 * un número viejo presentado como actual es peor que no mostrarlo, y un panel
 * vacío sin explicación es peor que las dos cosas.
 */
export async function readUsage(configDir: string): Promise<AccountUsage | null> {
  const config = await readJson(join(configDir, '.claude.json'));
  const account = config?.oauthAccount as Record<string, unknown> | undefined;
  const cached = config?.cachedUsageUtilization as Record<string, unknown> | undefined;

  const plan = typeof account?.organizationType === 'string' ? account.organizationType : '';

  const { live, motivo } = await fetchLive(configDir);
  anotarSiCambio(configDir, motivo);

  // Lo guardado sólo se lee cuando hace falta, y pasa por `vigentes` igual que
  // la caché del CLI: guardado o no, un porcentaje de una ventana que ya se
  // restableció dejó de describir nada.
  const guardado = live ? null : await leerUltimoBueno(storeDeConsumo(), configDir);
  const delGuardado = vigentes(guardado?.limits ?? []);
  // La caché del CLI sólo entra si es de esta cuenta y si lo que dice sigue en pie.
  const deRespaldo = cacheDeLaCuenta(account, cached) ? vigentes(toLimits(cached?.utilization)) : [];

  const elegido = live
    ? { limits: live.limits, origen: 'vivo' as const, fetchedAtMs: Date.now() }
    : delGuardado.length
      ? { limits: delGuardado, origen: 'guardado' as const, fetchedAtMs: guardado?.savedAt ?? 0 }
      : {
          limits: deRespaldo,
          origen: 'cli' as const,
          fetchedAtMs: typeof cached?.fetchedAtMs === 'number' ? cached.fetchedAtMs : 0
        };

  const email =
    live?.email || guardado?.email || (typeof account?.emailAddress === 'string' ? account.emailAddress : '');
  if (!elegido.limits.length && !email) return null;

  return {
    email,
    accountName: live?.accountName || guardado?.accountName || '',
    plan,
    origen: elegido.origen,
    motivo: motivo ?? '',
    fetchedAtMs: elegido.fetchedAtMs,
    limits: elegido.limits
  };
}
