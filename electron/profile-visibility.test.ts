// electron/profile-visibility.test.ts
import { describe, it, expect } from 'vitest';
import { visibleProfiles, effectiveActiveId } from './profile-visibility';
import type { Profile } from '../shared/types';

const pool: Profile = { id: 'default', name: 'Cuenta principal', configDir: 'C:/Users/x/.claude', isDefault: true };
const mia: Profile = { id: 'a1', name: 'super dev', configDir: 'C:/perfiles/a1', isDefault: false };
const otra: Profile = { id: 'b2', name: 'personal', configDir: 'C:/perfiles/b2', isDefault: false };

describe('visibleProfiles', () => {
  it('esconde el pozo cuando ya hay cuentas propias', () => {
    expect(visibleProfiles([pool, mia, otra])).toEqual([mia, otra]);
  });

  it('lo muestra si no hay ninguna propia: si no, no quedaría con qué trabajar', () => {
    expect(visibleProfiles([pool])).toEqual([pool]);
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
