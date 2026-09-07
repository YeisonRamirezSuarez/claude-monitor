// electron/onboarding.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markAllOnboardingDone, markOnboardingDone, readOnboardingVersion, withOnboardingDone } from './onboarding';
import type { Profile } from '../shared/types';

const CUENTA = JSON.stringify({
  oauthAccount: { emailAddress: 'yo@ejemplo.com' },
  firstStartTime: '2026-08-15T06:04:07.236Z',
  projects: { 'C:/algo': { allowedTools: [] } }
});

describe('withOnboardingDone', () => {
  it('marca la presentación: sin esto el CLI pide elegir método de ingreso aunque haya credenciales', () => {
    const salida = JSON.parse(withOnboardingDone(CUENTA, '2.1.205')!);
    expect(salida.hasCompletedOnboarding).toBe(true);
    expect(salida.lastOnboardingVersion).toBe('2.1.205');
  });

  it('no toca el resto: ese archivo tiene decenas de claves de la cuenta', () => {
    const salida = JSON.parse(withOnboardingDone(CUENTA, '2.1.205')!);
    expect(salida.oauthAccount.emailAddress).toBe('yo@ejemplo.com');
    expect(salida.projects).toEqual({ 'C:/algo': { allowedTools: [] } });
    expect(salida.firstStartTime).toBe('2026-08-15T06:04:07.236Z');
  });

  it('no reescribe si ya estaba marcada', () => {
    expect(withOnboardingDone(JSON.stringify({ hasCompletedOnboarding: true }), '2.1.205')).toBeNull();
  });

  it('sin versión conocida igual marca: lo que decide el arranque es el booleano', () => {
    const salida = JSON.parse(withOnboardingDone(CUENTA)!);
    expect(salida.hasCompletedOnboarding).toBe(true);
    expect(salida.lastOnboardingVersion).toBeUndefined();
  });

  it('no pisa una versión que la cuenta ya tenía', () => {
    const propio = JSON.stringify({ lastOnboardingVersion: '1.0.0' });
    expect(JSON.parse(withOnboardingDone(propio, '2.1.205')!).lastOnboardingVersion).toBe('1.0.0');
  });

  it('un .claude.json ilegible no se sobreescribe con nada', () => {
    expect(withOnboardingDone('no es json', '2.1.205')).toBeNull();
  });
});

describe('readOnboardingVersion', () => {
  it('la saca del pozo', () => {
    expect(readOnboardingVersion(JSON.stringify({ lastOnboardingVersion: '2.1.205' }))).toBe('2.1.205');
  });

  it('devuelve vacío si no está o si el archivo está roto', () => {
    expect(readOnboardingVersion('{}')).toBe('');
    expect(readOnboardingVersion('roto')).toBe('');
  });
});

describe('markOnboardingDone', () => {
  it('marca la cuenta y toma la versión del pozo de al lado', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cm-onb-'));
    try {
      // El layout real del pozo: ~/.claude junto a ~/.claude.json.
      const pozo = join(base, '.claude');
      const cuenta = join(base, 'cuenta');
      await writeFile(join(base, '.claude.json'), JSON.stringify({ lastOnboardingVersion: '2.1.205' }));
      await mkdtemp(join(tmpdir(), 'x-')); // ruido
      await writeFile(join(base, 'marcador'), '');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(pozo, { recursive: true });
      await mkdir(cuenta, { recursive: true });
      await writeFile(join(cuenta, '.claude.json'), CUENTA);

      expect(await markOnboardingDone(cuenta, pozo)).toBe(true);
      const salida = JSON.parse(await readFile(join(cuenta, '.claude.json'), 'utf8'));
      expect(salida.hasCompletedOnboarding).toBe(true);
      expect(salida.lastOnboardingVersion).toBe('2.1.205');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('sin .claude.json todavía no hay nada que marcar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-onb-'));
    try {
      expect(await markOnboardingDone(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('markAllOnboardingDone', () => {
  it('marca la cuenta Windows y no toca la cuenta WSL', async () => {
    const cuentaWindows = await mkdtemp(join(tmpdir(), 'cm-cuenta-win-'));
    // Directorio temporal cualquiera: representa el configDir de una cuenta
    // WSL sin usar ninguna UNC ni ninguna distro real.
    const cuentaWsl = await mkdtemp(join(tmpdir(), 'cm-cuenta-wsl-'));
    try {
      await writeFile(join(cuentaWindows, '.claude.json'), CUENTA);
      await writeFile(join(cuentaWsl, '.claude.json'), CUENTA);

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

      await markAllOnboardingDone(perfiles);

      const win = JSON.parse(await readFile(join(cuentaWindows, '.claude.json'), 'utf8'));
      expect(win.hasCompletedOnboarding).toBe(true);
      // La cuenta WSL no se tocó: sigue exactamente como estaba.
      expect(await readFile(join(cuentaWsl, '.claude.json'), 'utf8')).toBe(CUENTA);
    } finally {
      await rm(cuentaWindows, { recursive: true, force: true });
      await rm(cuentaWsl, { recursive: true, force: true });
    }
  });
});
