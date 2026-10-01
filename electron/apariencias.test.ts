import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aparienciaDe, guardarApariencia, leerApariencias, limpiar } from './apariencias';

const S1 = '14f25b46-3c07-4d4d-bddf-981a9a55c561';
const S2 = '2ff89687-92cc-475b-a851-a1ba90576bac';

describe('apariencias', () => {
  let dir = '';
  let antes: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'apariencias-'));
    antes = process.env.APPDATA;
    process.env.APPDATA = dir;
  });
  afterEach(async () => {
    process.env.APPDATA = antes;
    await rm(dir, { recursive: true, force: true });
  });

  it('sólo deja pasar campos conocidos y valores cortos', () => {
    expect(limpiar({ base: 2, hair: '#abcdef', raro: 'x', hat: 'gorra', top: '<script>' })).toEqual({ base: 2, hair: '#abcdef', hat: 'gorra' });
    expect(limpiar({ base: 7 })).toBeNull();
    expect(limpiar('x')).toBeNull();
  });

  it('la de la sesión gana; sin ella, la de la cuenta; guardar la de la cuenta le saca a la sesión la suya', async () => {
    await guardarApariencia('sesion', S1, 'p1', { base: 1, hairStyle: 'afro' });
    await guardarApariencia('cuenta', S2, 'p1', { base: 3 });
    let a = await leerApariencias();
    expect(aparienciaDe(a, S1, 'p1')).toEqual({ base: 1, hairStyle: 'afro' });
    expect(aparienciaDe(a, S2, 'p1')).toEqual({ base: 3 });
    expect(aparienciaDe(a, S2, 'otra')).toBeNull();
    a = await guardarApariencia('cuenta', S1, 'p1', { base: 4 });
    expect(aparienciaDe(a, S1, 'p1')).toEqual({ base: 4 });
    a = await guardarApariencia('cuenta', S1, 'p1', null);
    expect(aparienciaDe(a, S1, 'p1')).toBeNull();
  });

  it('rechaza sesiones y apariencias inválidas', async () => {
    await expect(guardarApariencia('sesion', '../x', 'p1', { base: 1 })).rejects.toThrow();
    await expect(guardarApariencia('sesion', S1, 'p1', { base: 'x' })).rejects.toThrow();
  });
});
