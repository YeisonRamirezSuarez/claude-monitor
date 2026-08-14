import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountUsage, UsageLimit } from '../shared/types';

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
 * Consulta el consumo real de la cuenta.
 *
 * Usa el token OAuth que el CLI ya dejó en `<configDir>/.credentials.json`,
 * porque la caché del CLI se refresca en su propio horario y puede estar horas
 * atrasada (visto: 61% cacheado contra 85% real). El token se lee, se manda en
 * el header a api.anthropic.com —el mismo destino al que lo manda el CLI— y no
 * se guarda ni se registra en ningún lado.
 *
 * Devuelve null ante cualquier problema: sin credenciales, token vencido, sin
 * red o respuesta rara. El llamador cae a la caché.
 */
async function fetchLive(configDir: string): Promise<Live | null> {
  const cached = liveCache.get(configDir);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached;

  const credentials = await readJson(join(configDir, '.credentials.json'));
  const token = (credentials?.claudeAiOauth as { accessToken?: unknown } | undefined)?.accessToken;
  if (typeof token !== 'string' || !token) return null;

  const get = async (url: string) => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  };

  try {
    const [usage, profile] = await Promise.all([get(USAGE_URL), get(PROFILE_URL)]);
    const limits = toLimits(usage);
    if (!limits.length) return null;
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
    return live;
  } catch {
    return null; // sin red, timeout, o respuesta ilegible
  }
}

/**
 * Consumo de una cuenta: en vivo si se puede, con la caché del CLI como
 * respaldo. `live` distingue las dos, porque un número viejo presentado como
 * actual es peor que no mostrarlo.
 */
export async function readUsage(configDir: string): Promise<AccountUsage | null> {
  const config = await readJson(join(configDir, '.claude.json'));
  const account = config?.oauthAccount as Record<string, unknown> | undefined;
  const cached = config?.cachedUsageUtilization as Record<string, unknown> | undefined;

  const plan = typeof account?.organizationType === 'string' ? account.organizationType : '';

  const live = await fetchLive(configDir);
  const limits = live ? live.limits : toLimits(cached?.utilization);
  const email = live?.email || (typeof account?.emailAddress === 'string' ? account.emailAddress : '');
  if (!limits.length && !email) return null;

  return {
    email,
    accountName: live?.accountName ?? '',
    plan,
    live: live !== null,
    fetchedAtMs: live ? Date.now() : typeof cached?.fetchedAtMs === 'number' ? cached.fetchedAtMs : 0,
    limits
  };
}
