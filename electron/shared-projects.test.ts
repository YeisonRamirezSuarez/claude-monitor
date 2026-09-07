// electron/shared-projects.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shareAll, shareProjects, unlinkShared } from './shared-projects';
import { syncPlugins } from './plugins';
import type { Profile } from '../shared/types';

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('shareProjects', () => {
  it('deja el projects de la cuenta apuntando al pozo: lo que escribe una, lo ven todas', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuenta = await tmp('cm-cuenta-');
    try {
      await mkdir(join(pozo, 'projects', 'slug'), { recursive: true });
      await writeFile(join(pozo, 'projects', 'slug', 'a.jsonl'), 'del pozo');

      await shareProjects(cuenta, pozo);

      expect((await lstat(join(cuenta, 'projects'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(cuenta, 'projects', 'slug', 'a.jsonl'), 'utf8')).toBe('del pozo');
    } finally {
      await unlinkShared(cuenta);
      await rm(pozo, { recursive: true, force: true });
      await rm(cuenta, { recursive: true, force: true });
    }
  });

  it('muda al pozo las sesiones que la cuenta ya tenía propias', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuenta = await tmp('cm-cuenta-');
    try {
      await mkdir(join(cuenta, 'projects', 'viejo'), { recursive: true });
      await writeFile(join(cuenta, 'projects', 'viejo', 'b.jsonl'), 'de la cuenta');

      await shareProjects(cuenta, pozo);

      expect(await readFile(join(pozo, 'projects', 'viejo', 'b.jsonl'), 'utf8')).toBe('de la cuenta');
      expect((await lstat(join(cuenta, 'projects'))).isSymbolicLink()).toBe(true);
    } finally {
      await unlinkShared(cuenta);
      await rm(pozo, { recursive: true, force: true });
      await rm(cuenta, { recursive: true, force: true });
    }
  });

  it('fusiona proyecto por proyecto y aparta —sin borrar— lo que el pozo ya tiene', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuenta = await tmp('cm-cuenta-');
    try {
      await mkdir(join(pozo, 'projects', 'compartido'), { recursive: true });
      await writeFile(join(pozo, 'projects', 'compartido', 'vieja.jsonl'), 'la del pozo');
      await mkdir(join(cuenta, 'projects', 'compartido'), { recursive: true });
      await writeFile(join(cuenta, 'projects', 'compartido', 'vieja.jsonl'), 'duplicado');
      await writeFile(join(cuenta, 'projects', 'compartido', 'nueva.jsonl'), 'sólo de la cuenta');

      await shareProjects(cuenta, pozo);

      // La que sólo tenía la cuenta se mudó; la repetida no pisó la del pozo.
      expect(await readFile(join(pozo, 'projects', 'compartido', 'nueva.jsonl'), 'utf8')).toBe('sólo de la cuenta');
      expect(await readFile(join(pozo, 'projects', 'compartido', 'vieja.jsonl'), 'utf8')).toBe('la del pozo');
      expect((await lstat(join(cuenta, 'projects'))).isSymbolicLink()).toBe(true);

      // El duplicado sigue existiendo, apartado con fecha.
      const apartado = (await readdir(cuenta)).find((n) => n.startsWith('projects.reemplazado-'));
      expect(apartado).toBeDefined();
      expect(await readFile(join(cuenta, apartado!, 'compartido', 'vieja.jsonl'), 'utf8')).toBe('duplicado');
    } finally {
      await unlinkShared(cuenta);
      await rm(pozo, { recursive: true, force: true });
      await rm(cuenta, { recursive: true, force: true });
    }
  });

  it('no toca la cuenta que ES el pozo', async () => {
    const pozo = await tmp('cm-pozo-');
    try {
      await shareProjects(pozo, pozo);
      await expect(lstat(join(pozo, 'projects'))).rejects.toThrow();
    } finally {
      await rm(pozo, { recursive: true, force: true });
    }
  });

  it('una cuenta WSL nunca entra al pozo: no crea el junction', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuenta = await tmp('cm-cuenta-');
    try {
      await shareProjects(cuenta, pozo, { tipo: 'wsl', distro: 'Ubuntu', home: '/home/vos' });
      await expect(lstat(join(cuenta, 'projects'))).rejects.toThrow();
    } finally {
      await rm(pozo, { recursive: true, force: true });
      await rm(cuenta, { recursive: true, force: true });
    }
  });
});

describe('unlinkShared', () => {
  it('quitar una cuenta borra el enlace, no las sesiones de todas (regresión: rm -rf siguiendo el junction)', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuenta = await tmp('cm-cuenta-');
    try {
      await mkdir(join(pozo, 'projects', 'slug'), { recursive: true });
      await writeFile(join(pozo, 'projects', 'slug', 'a.jsonl'), 'no se toca');
      await shareProjects(cuenta, pozo);

      // El orden real de deleteProfile: primero el enlace, después la carpeta.
      await unlinkShared(cuenta);
      await rm(cuenta, { recursive: true, force: true });

      expect(await readdir(join(pozo, 'projects', 'slug'))).toEqual(['a.jsonl']);
      expect(await readFile(join(pozo, 'projects', 'slug', 'a.jsonl'), 'utf8')).toBe('no se toca');
    } finally {
      await rm(pozo, { recursive: true, force: true });
      await rm(cuenta, { recursive: true, force: true });
    }
  });

  it('corta cualquier enlace, no sólo el de projects: plugins también apunta al pozo', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuenta = await tmp('cm-cuenta-');
    try {
      await mkdir(join(pozo, 'plugins', 'cache'), { recursive: true });
      await writeFile(join(pozo, 'plugins', 'cache', 'caveman.txt'), '27 MB de plugins');
      await syncPlugins(cuenta, pozo);
      expect((await lstat(join(cuenta, 'plugins'))).isSymbolicLink()).toBe(true);

      await unlinkShared(cuenta);
      await rm(cuenta, { recursive: true, force: true });

      expect(await readFile(join(pozo, 'plugins', 'cache', 'caveman.txt'), 'utf8')).toBe('27 MB de plugins');
    } finally {
      await rm(pozo, { recursive: true, force: true });
      await rm(cuenta, { recursive: true, force: true });
    }
  });
});

describe('shareAll', () => {
  it('engancha la cuenta Windows al pozo y no toca la cuenta WSL', async () => {
    const pozo = await tmp('cm-pozo-');
    const cuentaWindows = await tmp('cm-cuenta-win-');
    const cuentaWsl = await tmp('cm-cuenta-wsl-'); // representa un configDir cualquiera marcado WSL
    try {
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

      await shareAll(perfiles, pozo);

      expect((await lstat(join(cuentaWindows, 'projects'))).isSymbolicLink()).toBe(true);
      // La cuenta WSL no se tocó: la app nunca escribió nada adentro.
      await expect(lstat(join(cuentaWsl, 'projects'))).rejects.toThrow();
    } finally {
      await unlinkShared(cuentaWindows);
      await rm(pozo, { recursive: true, force: true });
      await rm(cuentaWindows, { recursive: true, force: true });
      await rm(cuentaWsl, { recursive: true, force: true });
    }
  });
});
