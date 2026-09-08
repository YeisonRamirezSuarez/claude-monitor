// electron/usage.test.ts
import { beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheDeLaCuenta, readUsage, vigentes } from './usage';
import { guardarUltimoBueno, storeDeConsumo } from './usage-store';

/** El almacén del último dato bueno vive en LOCALAPPDATA. Se lo manda a un
 *  temporal para que los tests no lean ni escriban el de la máquina real. */
beforeEach(async () => {
  process.env.LOCALAPPDATA = await mkdtemp(join(tmpdir(), 'usage-local-'));
});

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
    expect(usage?.origen).toBe('cli');
    expect(usage?.motivo).toBe('sin-credenciales');
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


describe('readUsage: el último dato bueno antes que la caché del CLI', () => {
  const guardado = [
    { kind: 'session', label: 'Sesión (5 h)', percent: 25, severity: 'normal', resetsAt: enHoras(3) }
  ];

  it('con la consulta en vivo caída, muestra lo último que contestó la API y no la caché del CLI', async () => {
    // Este es el bug que se arregló: antes, cualquier tropiezo —un timeout de
    // 6 s en una máquina cargada alcanzaba— caía directo a la caché del CLI,
    // que en la práctica está días atrasada, así que `vigentes()` la descartaba
    // entera y las barras desaparecían de una cuenta que estaba perfecta.
    const dir = await configDirWith(CONFIG);
    await guardarUltimoBueno(storeDeConsumo(), dir, { limits: guardado, email: 'yo@ejemplo.com', accountName: 'Yo' }, 5000);

    const usage = await readUsage(dir);
    expect(usage?.origen).toBe('guardado');
    expect(usage?.limits).toEqual(guardado);
    expect(usage?.fetchedAtMs).toBe(5000);
    // Y sigue diciendo por qué no es de ahora, que es la otra mitad del arreglo.
    expect(usage?.motivo).toBe('sin-credenciales');
  });

  it('lo guardado también vence: un porcentaje de una ventana ya restablecida no se muestra', async () => {
    const vencido = [{ ...guardado[0], resetsAt: enHoras(-1) }];
    const dir = await configDirWith(CONFIG);
    await guardarUltimoBueno(storeDeConsumo(), dir, { limits: vencido, email: '', accountName: '' }, 5000);

    // Cae al escalón siguiente, la caché del CLI, en vez de mostrar un número
    // que dejó de describir nada.
    expect((await readUsage(dir))?.origen).toBe('cli');
  });

  it('el nombre de la cuenta sobrevive a la caída: se conserva el que trajo la API', async () => {
    const dir = await configDirWith(CONFIG);
    await guardarUltimoBueno(storeDeConsumo(), dir, { limits: guardado, email: 'api@ejemplo.com', accountName: 'Yo' }, 5000);
    const usage = await readUsage(dir);
    expect(usage?.accountName).toBe('Yo');
    expect(usage?.email).toBe('api@ejemplo.com');
  });
});
