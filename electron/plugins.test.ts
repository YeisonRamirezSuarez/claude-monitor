// electron/plugins.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeSettings, syncAll, syncPlugins } from './plugins';
import { unlinkShared } from './shared-projects';
import type { Profile } from '../shared/types';

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

/** Recortado del settings.json real del usuario. */
const POZO = JSON.stringify({
  model: 'opus',
  theme: 'dark',
  enabledPlugins: { 'ponytail@ponytail': true, 'caveman@caveman': true },
  extraKnownMarketplaces: { caveman: { source: { source: 'git', url: 'https://github.com/x/caveman.git' } } },
  statusLine: { type: 'command', command: 'powershell …caveman-statusline.ps1' },
  hooks: { SessionStart: [{ matcher: 'startup|resume|clear', hooks: [] }] }
});

describe('mergeSettings', () => {
  it('trae los plugins del pozo a una cuenta que no los tenía', () => {
    const salida = JSON.parse(mergeSettings(POZO, '{"theme":"dark"}')!);
    expect(salida.enabledPlugins).toEqual({ 'ponytail@ponytail': true, 'caveman@caveman': true });
    expect(salida.extraKnownMarketplaces.caveman.source.url).toBe('https://github.com/x/caveman.git');
    expect(salida.statusLine.type).toBe('command');
    expect(salida.hooks.SessionStart).toHaveLength(1);
  });

  it('no pisa lo que es de la cuenta', () => {
    const salida = JSON.parse(mergeSettings(POZO, '{"theme":"light","model":"sonnet"}')!);
    expect(salida.theme).toBe('light');
    expect(salida.model).toBe('sonnet');
  });

  it('apagar un plugin en el pozo lo apaga en la cuenta, no lo deja colgado', () => {
    const propio = JSON.stringify({ theme: 'dark', enabledPlugins: { 'viejo@viejo': true } }, null, 2);
    const salida = JSON.parse(mergeSettings('{}', propio)!);
    expect(salida.enabledPlugins).toBeUndefined();
    expect(salida.theme).toBe('dark');
  });

  it('devuelve null si no hay nada que cambiar, para no reescribir en cada arranque', () => {
    const yaHecho = mergeSettings(POZO, '{"theme":"dark"}')!;
    expect(mergeSettings(POZO, yaHecho)).toBeNull();
  });

  it('un settings.json roto no rompe la cuenta: se rearma con los plugins del pozo', () => {
    const salida = JSON.parse(mergeSettings(POZO, 'esto no es json')!);
    expect(salida.enabledPlugins['caveman@caveman']).toBe(true);
  });
});

describe('syncPlugins', () => {
  it('deja la cuenta viendo los plugins del pozo y con settings.json enganchado', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuenta = await tmp('cm-cuenta-');
    try {
      await mkdir(join(pozo, 'plugins', 'cache', 'caveman'), { recursive: true });
      await writeFile(join(pozo, 'plugins', 'cache', 'caveman', 'skill.md'), 'ugh');
      await writeFile(join(pozo, 'settings.json'), POZO);
      await writeFile(join(cuenta, 'settings.json'), '{"theme":"dark"}');

      await syncPlugins(cuenta, pozo);

      expect((await lstat(join(cuenta, 'plugins'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(cuenta, 'plugins', 'cache', 'caveman', 'skill.md'), 'utf8')).toBe('ugh');
      const settings = JSON.parse(await readFile(join(cuenta, 'settings.json'), 'utf8'));
      expect(settings.enabledPlugins['caveman@caveman']).toBe(true);
      expect(settings.theme).toBe('dark');
    } finally {
      await unlinkShared(cuenta);
      await rm(pozo, { recursive: true, force: true });
      await rm(cuenta, { recursive: true, force: true });
    }
  });

  it('las skills del pozo tambien se ven desde la cuenta', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuenta = await tmp('cm-cuenta-');
    try {
      await mkdir(join(pozo, 'skills', 'angular-dev'), { recursive: true });
      await writeFile(join(pozo, 'skills', 'angular-dev', 'SKILL.md'), 'ugh');

      await syncPlugins(cuenta, pozo);

      expect((await lstat(join(cuenta, 'skills'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(cuenta, 'skills', 'angular-dev', 'SKILL.md'), 'utf8')).toBe('ugh');
      for (const name of ['agents', 'commands']) {
        expect((await lstat(join(cuenta, name))).isSymbolicLink()).toBe(true);
      }
    } finally {
      await unlinkShared(cuenta);
      await rm(pozo, { recursive: true, force: true });
      await rm(cuenta, { recursive: true, force: true });
    }
  });

  it('no toca la cuenta que ES el pozo', async () => {
    const pozo = await tmp('cm-pozo-');
    try {
      await writeFile(join(pozo, 'settings.json'), POZO);
      await syncPlugins(pozo, pozo);
      await expect(lstat(join(pozo, 'plugins'))).rejects.toThrow();
      expect(await readFile(join(pozo, 'settings.json'), 'utf8')).toBe(POZO);
    } finally {
      await rm(pozo, { recursive: true, force: true });
    }
  });

  it('aparta —sin borrar— el plugins propio que la cuenta ya tenía', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuenta = await tmp('cm-cuenta-');
    try {
      await mkdir(join(cuenta, 'plugins', 'marketplaces'), { recursive: true });
      await writeFile(join(cuenta, 'plugins', 'known_marketplaces.json'), '{"propio":1}');

      await syncPlugins(cuenta, pozo);

      expect((await lstat(join(cuenta, 'plugins'))).isSymbolicLink()).toBe(true);
      const { readdir } = await import('node:fs/promises');
      const apartado = (await readdir(cuenta)).find((n) => n.startsWith('plugins.reemplazado-'));
      expect(apartado).toBeDefined();
      expect(await readFile(join(cuenta, apartado!, 'known_marketplaces.json'), 'utf8')).toBe('{"propio":1}');
    } finally {
      await unlinkShared(cuenta);
      await rm(pozo, { recursive: true, force: true });
      await rm(cuenta, { recursive: true, force: true });
    }
  });
});

describe('syncAll', () => {
  it('engancha la cuenta Windows a los plugins del pozo y no toca la cuenta WSL', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuentaWindows = await tmp('cm-cuenta-win-');
    // Directorio temporal cualquiera: representa el configDir de una cuenta
    // WSL sin usar ninguna UNC ni ninguna distro real.
    const cuentaWsl = await tmp('cm-cuenta-wsl-');
    try {
      await writeFile(join(pozo, 'settings.json'), POZO);

      const perfiles: Profile[] = [
        { id: 'w1', name: 'Windows', configDir: cuentaWindows, isDefault: false, entorno: { tipo: 'windows' } },
        {
          id: 'u1',
          name: 'Ubuntu',
          configDir: cuentaWsl,
          isDefault: false,
          entorno: { tipo: 'wsl', distro: 'Ubuntu', home: '/home/vos' }
        }
      ];

      await syncAll(perfiles, pozo);

      expect((await lstat(join(cuentaWindows, 'plugins'))).isSymbolicLink()).toBe(true);
      // La cuenta WSL no se tocó: no hay junction ni settings.json escrito.
      await expect(lstat(join(cuentaWsl, 'plugins'))).rejects.toThrow();
      await expect(readFile(join(cuentaWsl, 'settings.json'), 'utf8')).rejects.toThrow();
    } finally {
      await unlinkShared(cuentaWindows);
      await rm(pozo, { recursive: true, force: true });
      await rm(cuentaWindows, { recursive: true, force: true });
      await rm(cuentaWsl, { recursive: true, force: true });
    }
  });
});
