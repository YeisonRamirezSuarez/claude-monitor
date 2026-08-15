/**
 * Si la sesión de una cuenta sigue viva.
 *
 * Hay dos tokens con vidas muy distintas. El de acceso (`expiresAt`) dura unas
 * 8 horas; el de renovación (`refreshTokenExpiresAt`), un mes. Cuando el de
 * acceso vence, Claude Code lo renueva solo con el otro — sin pedir nada.
 *
 * La versión anterior miraba únicamente `expiresAt`, así que bastaba dejar la
 * app un rato sin usar para que declarara deslogueadas cuentas que no lo
 * estaban y ofreciera un login innecesario. Lo que decide es el token de
 * renovación: mientras viva, la sesión vive.
 */
export function isLoggedIn(credentials: unknown, now = Date.now()): boolean {
  const oauth = (credentials as { claudeAiOauth?: unknown } | null | undefined)?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return false;
  const { expiresAt, refreshToken, refreshTokenExpiresAt } = oauth as Record<string, unknown>;

  if (typeof refreshTokenExpiresAt === 'number') return refreshTokenExpiresAt > now;
  // Sin fecha de vencimiento del refresh no se puede saber cuándo caduca, pero
  // tenerlo ya significa que la sesión se puede renovar. Se prefiere no ofrecer
  // un login de más: si de verdad venció, el CLI lo dice al abrir la terminal.
  if (typeof refreshToken === 'string' && refreshToken) return true;

  return typeof expiresAt === 'number' && expiresAt > now;
}

/**
 * Si el token de acceso sirve AHORA para llamar a la API.
 *
 * Es más estricto que `isLoggedIn` a propósito: el consumo en vivo se pide con
 * este token, y uno vencido devuelve 401. La cuenta sigue logueada, pero los
 * números van a salir de la caché hasta que el CLI lo renueve.
 */
export function canCallApi(credentials: unknown, now = Date.now()): boolean {
  const oauth = (credentials as { claudeAiOauth?: unknown } | null | undefined)?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return false;
  const { accessToken, expiresAt } = oauth as Record<string, unknown>;
  if (typeof accessToken !== 'string' || !accessToken) return false;
  return typeof expiresAt === 'number' ? expiresAt > now : true;
}
