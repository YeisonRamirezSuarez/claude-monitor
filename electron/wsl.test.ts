import { describe, expect, it } from 'vitest';
import { configDirUNC, esWsl, parseDistros, estadoDeRaiz } from './wsl';

describe('parseDistros', () => {
  it('lee la salida de wsl -l -q', () => {
    expect(parseDistros('Ubuntu\r\nDebian\r\n')).toEqual(['Ubuntu', 'Debian']);
  });

  it('aguanta los NUL de una decodificación equivocada (regresión: UTF-16LE)', () => {
    // Si alguien decodifica como utf8 lo que wsl.exe emite en utf16le, cada
    // carácter llega seguido de un \0. Medido: 55 00 62 00 75 00 6E 00 …
    expect(parseDistros('U\0b\0u\0n\0t\0u\0\r\0\n\0')).toEqual(['Ubuntu']);
  });

  it('sin nada corriendo, wsl -l -q --running devuelve vacío', () => {
    expect(parseDistros('')).toEqual([]);
    expect(parseDistros('\r\n\r\n')).toEqual([]);
  });

  it('conserva los nombres con espacios', () => {
    expect(parseDistros('Ubuntu 22.04\r\n')).toEqual(['Ubuntu 22.04']);
  });
});

describe('configDirUNC', () => {
  it('arma la ruta desde el $HOME POSIX de la distro', () => {
    expect(configDirUNC('Ubuntu', '/home/vos')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\vos\\.claude'
    );
  });

  it('el usuario de Linux no tiene por qué ser el de Windows', () => {
    expect(configDirUNC('Ubuntu', '/home/otro')).toContain('\\home\\otro\\');
  });

  it('rechaza un $HOME que no sea absoluto, en vez de armar una ruta rara', () => {
    expect(() => configDirUNC('Ubuntu', 'home/vos')).toThrow();
  });
});

describe('estadoDeRaiz', () => {
  const base = { distro: 'Ubuntu', corriendo: ['Ubuntu'], hayConfig: true, hayCli: true };

  it('todo bien', () => {
    expect(estadoDeRaiz(base)).toEqual({ tipo: 'ok' });
  });

  it('la distro ya no está instalada', () => {
    expect(estadoDeRaiz({ ...base, distro: 'Debian', instaladas: ['Ubuntu'] })).toEqual({
      tipo: 'sin-distro',
      mensaje: 'La distro Debian ya no está'
    });
  });

  it('apagada: se avisa y se ofrece encender, no se enciende sola', () => {
    expect(estadoDeRaiz({ ...base, corriendo: [] })).toEqual({
      tipo: 'apagada',
      mensaje: 'Distro apagada'
    });
  });

  it('corriendo pero sin ~/.claude', () => {
    expect(estadoDeRaiz({ ...base, hayConfig: false })).toEqual({
      tipo: 'sin-config',
      mensaje: 'No hay Claude Code configurado ahí'
    });
  });

  it('corriendo pero sin el CLI en el PATH', () => {
    expect(estadoDeRaiz({ ...base, hayCli: false })).toEqual({
      tipo: 'sin-cli',
      mensaje: 'Falta el CLI en Ubuntu'
    });
  });

  it('apagada gana sobre lo que no se pudo mirar: no se puede saber sin encenderla', () => {
    expect(estadoDeRaiz({ ...base, corriendo: [], hayConfig: false, hayCli: false }).tipo).toBe(
      'apagada'
    );
  });
});

describe('esWsl', () => {
  it('true para el entorno de una distro', () => {
    expect(esWsl({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/vos' })).toBe(true);
  });

  it('false para Windows explícito', () => {
    expect(esWsl({ tipo: 'windows' })).toBe(false);
  });

  it('false sin entorno: su ausencia significa Windows', () => {
    expect(esWsl(undefined)).toBe(false);
  });
});
