// electron/usage-store.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivoDe, leerUltimoBueno, guardarUltimoBueno } from './usage-store';
import type { UsageLimit } from '../shared/types';

const LIMITES: UsageLimit[] = [
  { kind: 'session', label: 'Sesión (5 h)', percent: 25, severity: 'normal', resetsAt: null }
];

/** La carpeta de una cuenta WSL es una UNC: barras invertidas y todo. Es el
 *  caso que obliga a que la clave del archivo pase por un hash. */
const UNC = String.raw`\\wsl.localhost\Ubuntu\home\wposs\.claude`;
const UNA = String.raw`C:\una`;
const OTRA = String.raw`C:\otra`;

describe('archivoDe', () => {
  it('una ruta UNC de WSL también da un nombre de archivo válido', () => {
    expect(archivoDe('/base', UNC)).toMatch(/[/\\][0-9a-f]{16}\.json$/);
  });

  it('dos carpetas distintas no comparten archivo', () => {
    expect(archivoDe('/base', UNA)).not.toBe(archivoDe('/base', OTRA));
  });

  it('la misma carpeta siempre da el mismo archivo', () => {
    expect(archivoDe('/base', UNA)).toBe(archivoDe('/base', UNA));
  });
});

describe('guardarUltimoBueno / leerUltimoBueno', () => {
  it('devuelve lo guardado para esa carpeta', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-store-'));
    await guardarUltimoBueno(base, UNA, { limits: LIMITES, email: 'yo@x.com', accountName: 'Yo' }, 1000);
    expect(await leerUltimoBueno(base, UNA)).toEqual({
      limits: LIMITES,
      email: 'yo@x.com',
      accountName: 'Yo',
      savedAt: 1000
    });
  });

  it('sin nada guardado devuelve null, no rompe', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-store-'));
    expect(await leerUltimoBueno(base, OTRA)).toBeNull();
  });

  it('no mezcla cuentas: lo de una carpeta no sale por la otra', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-store-'));
    await guardarUltimoBueno(base, UNA, { limits: LIMITES, email: 'una@x.com', accountName: '' }, 1);
    expect(await leerUltimoBueno(base, OTRA)).toBeNull();
  });

  it('no poder escribir no rompe: guardar en una ruta imposible no lanza', async () => {
    await expect(
      guardarUltimoBueno('\0invalida', UNA, { limits: LIMITES, email: '', accountName: '' })
    ).resolves.toBeUndefined();
  });
});
