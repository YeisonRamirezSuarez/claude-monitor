import { describe, expect, it } from 'vitest';
import {
  TIMEOUT_WSL,
  argsDeConsulta,
  configDirUNC,
  decodificarSalidaWsl,
  esWsl,
  parseDistros,
  estadoDeRaiz,
  posixAWindows,
  sePuedeLeer,
  windowsAPosix
} from './wsl';

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

describe('decodificarSalidaWsl', () => {
  it('la lista de distros sale en UTF-16LE y se decodifica bien', () => {
    // Medido: "Ubuntu" llega como 55 00 62 00 75 00 6e 00 74 00 75 00.
    const buf = Buffer.from('Ubuntu\r\nDebian\r\n', 'utf16le');
    expect(decodificarSalidaWsl(buf)).toBe('Ubuntu\r\nDebian\r\n');
  });

  it('los mensajes de error de wsl.exe también son UTF-16LE', () => {
    expect(decodificarSalidaWsl(Buffer.from('Error catastrófico\r\n', 'utf16le'))).toBe(
      'Error catastrófico\r\n'
    );
  });

  it('la salida de un comando de adentro de la distro es UTF-8', () => {
    // `echo $HOME` lo corre Linux; wsl.exe relaya esos bytes tal cual.
    expect(decodificarSalidaWsl(Buffer.from('/home/vos\n', 'utf8'))).toBe('/home/vos\n');
  });

  it('un $HOME con acento no queda con caracteres de reemplazo', () => {
    // Forzar utf16le acá daría basura: es el caso que obliga a detectar.
    const decodificado = decodificarSalidaWsl(Buffer.from('/home/josé\n', 'utf8'));
    expect(decodificado).toBe('/home/josé\n');
    expect(decodificado).not.toContain('�');
  });

  it('sin nada corriendo la salida es de cero bytes', () => {
    expect(decodificarSalidaWsl(Buffer.alloc(0))).toBe('');
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

describe('sePuedeLeer', () => {
  it('Windows siempre se puede leer', () => {
    expect(sePuedeLeer({ tipo: 'windows' }, [])).toBe(true);
  });

  it('sin entorno se puede leer: su ausencia significa Windows', () => {
    expect(sePuedeLeer(undefined, [])).toBe(true);
  });

  it('WSL con la distro corriendo se puede leer', () => {
    expect(sePuedeLeer({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/vos' }, ['Ubuntu'])).toBe(true);
  });

  it('WSL con la distro apagada NO se puede leer: tocar la UNC la encendería', () => {
    expect(sePuedeLeer({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/vos' }, ['Debian'])).toBe(false);
  });

  it('WSL sin nada corriendo NO se puede leer', () => {
    expect(sePuedeLeer({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/vos' }, [])).toBe(false);
  });
});

describe('llamadas a wsl.exe', () => {
  it('toda consulta lleva timeout: una distro enferma no puede congelar el panel', () => {
    // Corre en el proceso main. Medido: tocar la UNC de una distro apagada
    // tarda 1,90 s; una distro enferma puede no volver nunca.
    expect(TIMEOUT_WSL).toBeGreaterThan(0);
    expect(TIMEOUT_WSL).toBeLessThanOrEqual(10000);
  });

  it('la consulta de lo que corre no enciende nada', () => {
    // `wsl -l -q --running` es la única forma barata de preguntar sin efecto.
    // Verificado: 0,12 s, y la distro sigue apagada después.
    expect(argsDeConsulta('corriendo')).toEqual(['-l', '-q', '--running']);
    expect(argsDeConsulta('instaladas')).toEqual(['-l', '-q']);
  });
});

describe('posixAWindows', () => {
  it('el home de la distro va por la UNC', () => {
    expect(posixAWindows('Ubuntu', '/home/vos/proy')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\vos\\proy'
    );
  });

  it('/mnt/c va a C:\\ directo, no por la UNC: es la misma carpeta y es 16x más rápido', () => {
    expect(posixAWindows('Ubuntu', '/mnt/c/Users/x/proy')).toBe('C:\\Users\\x\\proy');
    expect(posixAWindows('Ubuntu', '/mnt/d/datos')).toBe('D:\\datos');
  });

  it('/mnt/c solo, sin resto, es la raíz del volumen y no el directorio actual', () => {
    // ['C:'].join('\\') da 'C:', que es truthy: el `||` del literal nunca
    // dispara. Y en Windows 'C:' no es la raíz de C:, es "el directorio
    // actual de C:", que es otra carpeta.
    expect(posixAWindows('Ubuntu', '/mnt/c')).toBe('C:\\');
  });
});

describe('windowsAPosix', () => {
  it('inversa de la UNC', () => {
    expect(windowsAPosix('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\vos\\proy')).toBe(
      '/home/vos/proy'
    );
  });

  it('una carpeta de Windows elegida en el diálogo se ve desde la distro por /mnt', () => {
    expect(windowsAPosix('Ubuntu', 'C:\\Users\\x\\proy')).toBe('/mnt/c/Users/x/proy');
  });

  it('ida y vuelta', () => {
    const p = '/home/vos/un proyecto';
    expect(windowsAPosix('Ubuntu', posixAWindows('Ubuntu', p))).toBe(p);
  });

  it('no confunde una UNC de otra distro cuyo nombre es prefijo del propio', () => {
    // Interpolar el nombre de la distro en una RegExp sin escapar es un bug
    // real, no hipotético: 'Ubuntu-22.04' ya tiene un punto, que en regex
    // matchea cualquier carácter. Sin escapar, la UNC de 'Ubuntu-22X04'
    // pasaría como si fuera de 'Ubuntu-22.04'.
    expect(() =>
      windowsAPosix('Ubuntu-22.04', '\\\\wsl.localhost\\Ubuntu-22X04\\home\\vos')
    ).toThrow();
  });

  it('una ruta que no es ni la UNC de la distro ni un disco no se sabe traducir', () => {
    expect(() => windowsAPosix('Ubuntu', 'algo/que/no/es/una/ruta/windows')).toThrow();
  });
});
