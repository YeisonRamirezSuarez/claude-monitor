// electron/credentials.test.ts
import { describe, it, expect } from 'vitest';
import { canCallApi, isLoggedIn } from './credentials';

const AHORA = Date.parse('2026-08-14T22:37:00Z');
const HORA = 3600_000;
const DIA = 24 * HORA;

const creds = (o: Record<string, unknown>) => ({ claudeAiOauth: { accessToken: 'tok', ...o } });

describe('isLoggedIn', () => {
  it('sigue logueada con el token de acceso vencido: el CLI lo renueva solo (regresión: pedía login tras 8 h)', () => {
    // El caso real medido: acceso vencido hace media hora, refresh hasta septiembre.
    const c = creds({ expiresAt: AHORA - HORA / 2, refreshToken: 'r', refreshTokenExpiresAt: AHORA + 30 * DIA });
    expect(isLoggedIn(c, AHORA)).toBe(true);
  });

  it('deslogueada cuando el token de renovación también venció', () => {
    const c = creds({ expiresAt: AHORA - 30 * DIA, refreshToken: 'r', refreshTokenExpiresAt: AHORA - DIA });
    expect(isLoggedIn(c, AHORA)).toBe(false);
  });

  it('sin vencimiento del refresh, tenerlo alcanza: mejor eso que ofrecer un login de más', () => {
    expect(isLoggedIn(creds({ expiresAt: AHORA - HORA, refreshToken: 'r' }), AHORA)).toBe(true);
  });

  it('sin refresh, decide el token de acceso', () => {
    expect(isLoggedIn(creds({ expiresAt: AHORA + HORA }), AHORA)).toBe(true);
    expect(isLoggedIn(creds({ expiresAt: AHORA - HORA }), AHORA)).toBe(false);
  });

  it('sin credenciales, no hay sesión', () => {
    expect(isLoggedIn(null, AHORA)).toBe(false);
    expect(isLoggedIn({}, AHORA)).toBe(false);
    expect(isLoggedIn({ claudeAiOauth: 'roto' }, AHORA)).toBe(false);
  });
});

describe('canCallApi', () => {
  it('es más estricto: con el acceso vencido el consumo en vivo da 401', () => {
    const c = creds({ expiresAt: AHORA - HORA, refreshToken: 'r', refreshTokenExpiresAt: AHORA + 30 * DIA });
    expect(isLoggedIn(c, AHORA)).toBe(true);
    expect(canCallApi(c, AHORA)).toBe(false);
  });

  it('con el acceso vivo, se puede llamar', () => {
    expect(canCallApi(creds({ expiresAt: AHORA + HORA }), AHORA)).toBe(true);
  });

  it('sin token no se llama, aunque la fecha diga que falta', () => {
    expect(canCallApi({ claudeAiOauth: { expiresAt: AHORA + HORA } }, AHORA)).toBe(false);
  });
});
