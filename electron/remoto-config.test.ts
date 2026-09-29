import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { borrarViejas, CONFIG_INICIAL, guardarConfig, leerConfig, nuevoCodigo } from './remoto-config';

const falso = { cifrar: (t: string) => Buffer.from(`X${t}`), descifrar: (b: Buffer) => b.toString().slice(1) };
let dir = '';
afterEach(async () => dir && rm(dir, { recursive: true, force: true }));

describe('remoto-config', () => {
  it('sin archivo da la configuración inicial, apagada', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    expect(await leerConfig(join(dir, 't.json'), falso)).toEqual(CONFIG_INICIAL);
    expect(CONFIG_INICIAL.activo).toBe(false);
  });
  it('el token no queda en claro en disco y vuelve igual', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const f = join(dir, 't.json');
    await guardarConfig(f, { ...CONFIG_INICIAL, token: '123:ABC', chatId: -5, userId: 9, temas: { s: 3 } }, falso);
    expect(await readFile(f, 'utf8')).not.toContain('123:ABC');
    expect(await leerConfig(f, falso)).toMatchObject({ token: '123:ABC', chatId: -5, userId: 9, temas: { s: 3 } });
  });
  it('el código es de 6 dígitos y vence a los 10 minutos', () => {
    const c = nuevoCodigo(1000);
    expect(c.codigo).toMatch(/^\d{6}$/);
    expect(c.vence).toBe(1000 + 10 * 60_000);
  });
  it('borra sólo las imágenes viejas', async () => {
    dir = await mkdtemp(join(tmpdir(), 'img-'));
    await mkdir(join(dir, 's1'));
    const vieja = join(dir, 's1', 'a.jpg');
    const nueva = join(dir, 's1', 'b.jpg');
    await writeFile(vieja, 'x');
    await writeFile(nueva, 'x');
    const hace8dias = new Date(Date.now() - 8 * 86_400_000);
    await utimes(vieja, hace8dias, hace8dias);
    expect(await borrarViejas(dir, 7 * 86_400_000)).toBe(1);
    expect(existsSync(vieja)).toBe(false);
    expect(existsSync(nueva)).toBe(true);
  });

  it('JSON corrupto devuelve CONFIG_INICIAL sin tirar error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const f = join(dir, 't.json');
    await writeFile(f, '{invalid json', 'utf8');
    expect(await leerConfig(f, falso)).toEqual(CONFIG_INICIAL);
  });

  it('el objeto devuelto no tiene tokenCifrado', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const f = join(dir, 't.json');
    await guardarConfig(f, { ...CONFIG_INICIAL, token: '123:ABC' }, falso);
    const cfg = await leerConfig(f, falso);
    expect(Object.keys(cfg)).not.toContain('tokenCifrado');
  });

  it('descifrar que falla: token vacío, activo false, otros campos se mantienen', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const f = join(dir, 't.json');
    const fallador = { cifrar: falso.cifrar, descifrar: () => { throw new Error('nope'); } };
    // Guardamos primero con el cifrador funcional
    await guardarConfig(f, { ...CONFIG_INICIAL, token: '123:ABC', umbralMin: 50, offset: 5, temas: { x: 2 } }, falso);
    // Pero leemos con uno que falla
    const cfg = await leerConfig(f, fallador);
    expect(cfg.token).toBe('');
    expect(cfg.activo).toBe(false);
    expect(cfg.umbralMin).toBe(50);
    expect(cfg.offset).toBe(5);
    expect(cfg.temas).toEqual({ x: 2 });
  });

  it('campos con tipos incorrectos se validan y corrigen', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const f = join(dir, 't.json');
    const dato = {
      activo: 'no es boolean',
      token: '',
      chatId: 'string en lugar de number',
      userId: NaN,
      umbralMin: 500,
      offset: -10,
      temas: { a: 'string', b: 2, c: NaN }
    };
    await writeFile(f, JSON.stringify(dato), 'utf8');
    const cfg = await leerConfig(f, falso);
    expect(cfg.activo).toBe(false); // token vacío → activo forzado a false
    expect(cfg.chatId).toBe(null);
    expect(cfg.userId).toBe(null);
    expect(cfg.umbralMin).toBe(240); // clamped a max, 500 → 240
    expect(cfg.offset).toBe(0); // < 0 → default
    expect(cfg.temas).toEqual({ b: 2 }); // solo valores finitos
  });

  it('umbralMin se clampea entre 1 y 240', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const f = join(dir, 't.json');

    // Demasiado bajo
    await writeFile(f, JSON.stringify({ umbralMin: 0 }), 'utf8');
    expect((await leerConfig(f, falso)).umbralMin).toBe(1);

    // Demasiado alto
    await writeFile(f, JSON.stringify({ umbralMin: 500 }), 'utf8');
    expect((await leerConfig(f, falso)).umbralMin).toBe(240);

    // Válido
    await writeFile(f, JSON.stringify({ umbralMin: 100 }), 'utf8');
    expect((await leerConfig(f, falso)).umbralMin).toBe(100);
  });

  it('mutar el resultado de una lectura no corrompe CONFIG_INICIAL', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const cfg1 = await leerConfig(join(dir, 'noexiste.json'), falso);
    cfg1.temas.test = 999;
    cfg1.offset = 77;

    const cfg2 = await leerConfig(join(dir, 'noexiste.json'), falso);
    expect(cfg2.temas).toEqual({});
    expect(cfg2.offset).toBe(0);
  });

  it('activo true con token vacío: se guarda y lee como activo false', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const f = join(dir, 't.json');
    await guardarConfig(f, { ...CONFIG_INICIAL, activo: true, token: '' }, falso);
    const cfg = await leerConfig(f, falso);
    expect(cfg.activo).toBe(false); // token vacío → activo forced false
  });
});
