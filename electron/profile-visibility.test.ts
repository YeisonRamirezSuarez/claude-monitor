// electron/profile-visibility.test.ts
import { describe, it, expect } from 'vitest';
import { visibleProfiles, effectiveActiveId } from './profile-visibility';
import type { Profile } from '../shared/types';

const pool: Profile = { id: 'default', name: 'Cuenta principal', configDir: 'C:/Users/x/.claude', isDefault: true };
const mia: Profile = { id: 'a1', name: 'super dev', configDir: 'C:/perfiles/a1', isDefault: false };
const otra: Profile = { id: 'b2', name: 'personal', configDir: 'C:/perfiles/b2', isDefault: false };
const enWsl: Profile = {
  id: 'w1',
  name: 'Pablo',
  configDir: '\\\\wsl.localhost\\Ubuntu\\home\\pablo\\.claude',
  isDefault: false,
  entorno: { tipo: 'wsl', distro: 'Ubuntu', home: '/home/pablo' }
};

describe('visibleProfiles', () => {
  it('esconde el pozo cuando ya hay cuentas propias', () => {
    expect(visibleProfiles([pool, mia, otra])).toEqual([mia, otra]);
  });

  it('lo muestra si no hay ninguna propia: si no, no quedaría con qué trabajar', () => {
    expect(visibleProfiles([pool])).toEqual([pool]);
  });

  // El caso de quien tiene el CLI sólo adentro de la distro y usa Desktop en
  // Windows: el pozo igual lista sus sesiones, y sin esta cuenta no habría
  // ninguna con la que reanudarlas.
  it('lo muestra si todas las propias viven en una distro', () => {
    expect(visibleProfiles([pool, enWsl])).toEqual([pool, enWsl]);
  });

  it('lo esconde apenas hay una propia de Windows, aunque también haya de WSL', () => {
    expect(visibleProfiles([pool, enWsl, mia])).toEqual([enWsl, mia]);
  });
});

describe('effectiveActiveId', () => {
  it('mueve la activa a la primera visible cuando apuntaba al pozo escondido', () => {
    expect(effectiveActiveId([pool, mia, otra], 'default')).toBe('a1');
  });

  it('respeta la activa si está visible', () => {
    expect(effectiveActiveId([pool, mia, otra], 'b2')).toBe('b2');
  });

  it('con el pozo solo, la activa sigue siendo el pozo', () => {
    expect(effectiveActiveId([pool], 'default')).toBe('default');
  });
});
