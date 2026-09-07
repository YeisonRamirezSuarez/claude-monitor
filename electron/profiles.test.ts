import { describe, expect, it } from 'vitest';
import { sePuedeBorrarDelDisco } from './profiles';

describe('sePuedeBorrarDelDisco', () => {
  const raiz = 'C:\\Users\\x\\AppData\\Roaming\\claude-monitor\\profiles';

  it('sí: la carpeta la creó la app', () => {
    expect(sePuedeBorrarDelDisco(`${raiz}\\a1b2c3d4`, raiz)).toBe(true);
  });

  it('NO: el ~/.claude real del usuario', () => {
    expect(sePuedeBorrarDelDisco('C:\\Users\\x\\.claude', raiz)).toBe(false);
  });

  it('NO: la instalación de Claude Code adentro de WSL', () => {
    // Este es el caso que destruye datos: configDir de una cuenta WSL apunta a
    // la instalación real de esa persona en Ubuntu, y el borrado por UNC
    // funciona. Verificado en la máquina de desarrollo.
    expect(sePuedeBorrarDelDisco('\\\\wsl.localhost\\Ubuntu\\home\\vos\\.claude', raiz)).toBe(
      false
    );
  });

  it('NO: un hermano cuyo nombre empieza igual', () => {
    expect(sePuedeBorrarDelDisco(`${raiz}-viejo\\a1`, raiz)).toBe(false);
  });

  it('NO: la raíz misma', () => {
    expect(sePuedeBorrarDelDisco(raiz, raiz)).toBe(false);
  });
});
