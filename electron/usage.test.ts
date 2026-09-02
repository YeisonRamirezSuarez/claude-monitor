// electron/usage.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheDeLaCuenta, readUsage, vigentes } from './usage';

/** Fechas relativas a hoy: un límite se muestra sólo mientras su ventana no se
 *  haya restablecido, así que fijarlas en el calendario haría fallar el test
 *  solo con el paso del tiempo. */
const enHoras = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

/** Recorte real de un `.claude.json` de Claude Code. */
const CONFIG = {
  oauthAccount: { accountUuid: 'cuenta-1', emailAddress: 'yo@ejemplo.com', organizationType: 'claude_pro' },
  cachedUsageUtilization: {
    accountUuid: 'cuenta-1',
    fetchedAtMs: 1786729194161,
    utilization: {
      limits: [
        { kind: 'session', percent: 61.4, severity: 'normal', resets_at: enHoras(2) },
        { kind: 'weekly_all', percent: 40, severity: 'warning', resets_at: enHoras(72) },
        { kind: 'limite_nuevo', percent: 5, severity: 'normal', resets_at: null },
        { kind: 'roto' }
      ]
    }
  }
};

async function configDirWith(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  await writeFile(join(dir, '.claude.json'), JSON.stringify(contents), 'utf8');
  return dir;
}

describe('cacheDeLaCuenta', () => {
  it('sin uuid de alguno de los dos lados no hay con qué desmentirla', () => {
    expect(cacheDeLaCuenta({ accountUuid: 'a' }, {})).toBe(true);
    expect(cacheDeLaCuenta(undefined, { accountUuid: 'a' })).toBe(true);
  });

  it('con uuid distinto, la caché es de otra cuenta', () => {
    expect(cacheDeLaCuenta({ accountUuid: 'a' }, { accountUuid: 'b' })).toBe(false);
  });
});

describe('vigentes', () => {
  it('un límite sin fecha se queda: no se puede probar que venció', () => {
    const sinFecha = { kind: 'x', label: 'x', percent: 1, severity: 'normal', resetsAt: null };
    expect(vigentes([sinFecha])).toEqual([sinFecha]);
  });
});

describe('readUsage', () => {
  it('extrae los límites, traduce los conocidos y descarta los que no tienen porcentaje', async () => {
    const usage = await readUsage(await configDirWith(CONFIG));
    expect(usage?.email).toBe('yo@ejemplo.com');
    expect(usage?.plan).toBe('claude_pro');
    // Sin .credentials.json no hay consulta en vivo posible: cae a la caché y
    // lo dice, en vez de presentar números viejos como actuales.
    expect(usage?.live).toBe(false);
    expect(usage?.accountName).toBe('');
    expect(usage?.fetchedAtMs).toBe(1786729194161);
    expect(usage?.limits).toEqual([
      { kind: 'session', label: 'Sesión (5 h)', percent: 61, severity: 'normal', resetsAt: CONFIG.cachedUsageUtilization.utilization.limits[0].resets_at },
      { kind: 'weekly_all', label: 'Semanal', percent: 40, severity: 'warning', resetsAt: CONFIG.cachedUsageUtilization.utilization.limits[1].resets_at },
      // Un `kind` que no conocemos se muestra igual: un límite nuevo le importa
      // al usuario aunque la app no sepa cómo llamarlo.
      { kind: 'limite_nuevo', label: 'limite_nuevo', percent: 5, severity: 'normal', resetsAt: null }
    ]);
  });

  it('no muestra la caché de otra cuenta', async () => {
    const ajena = {
      ...CONFIG,
      cachedUsageUtilization: { ...CONFIG.cachedUsageUtilization, accountUuid: 'otra-cuenta' }
    };
    const usage = await readUsage(await configDirWith(ajena));
    // La cuenta sigue estando —su correo se muestra— pero sin números que no
    // son suyos: es lo que pasaba en la cuenta de trabajo, con el consumo de
    // la personal debajo.
    expect(usage?.email).toBe('yo@ejemplo.com');
    expect(usage?.limits).toEqual([]);
  });

  it('descarta los límites cuya ventana ya se restableció', async () => {
    const viejo = {
      ...CONFIG,
      cachedUsageUtilization: {
        ...CONFIG.cachedUsageUtilization,
        utilization: { limits: [{ kind: 'session', percent: 56, severity: 'normal', resets_at: enHoras(-24) }] }
      }
    };
    expect((await readUsage(await configDirWith(viejo)))?.limits).toEqual([]);
  });

  it('devuelve null cuando la cuenta nunca se usó', async () => {
    expect(await readUsage(await mkdtemp(join(tmpdir(), 'usage-')))).toBeNull();
    expect(await readUsage(await configDirWith({ firstStartTime: '2026-08-14T17:16:56.477Z' }))).toBeNull();
  });
});
