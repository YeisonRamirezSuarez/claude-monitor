import { describe, expect, it } from 'vitest';
import {
  desktopDir,
  esperandoEnlace,
  newSessionLink,
  newestAppDir,
  pareceClaudeDesktop,
  resumeLink,
  stripQuotes
} from './desktop';

describe('newestAppDir', () => {
  it('ordena por número y no por texto', () => {
    expect(newestAppDir(['app-1.9.0', 'app-1.10.0', 'app-1.2.3'])).toBe('app-1.10.0');
  });

  it('ignora lo que no es una carpeta de versión', () => {
    expect(newestAppDir(['Update.exe', 'packages', 'app-0.13.1'])).toBe('app-0.13.1');
    expect(newestAppDir(['Update.exe', 'packages'])).toBeNull();
  });
});

describe('stripQuotes', () => {
  it('saca las comillas del valor del registro', () => {
    expect(stripQuotes('"C:\\Users\\x\\claude.exe"')).toBe('C:\\Users\\x\\claude.exe');
  });
});

describe('desktopDir', () => {
  it('deja fuera lo que no sea de un id, para no salirse de la carpeta', () => {
    expect(desktopDir('../../otro')).not.toContain('..');
  });

  it('cada cuenta va a una carpeta aparte, la principal incluida', () => {
    expect(desktopDir('default')).not.toBe(desktopDir('f60d2449'));
    expect(desktopDir('f60d2449')).not.toBe(desktopDir('3f66b190'));
  });
});

describe('newSessionLink', () => {
  it('escapa la ruta entera: espacios y barras invertidas incluidas', () => {
    expect(newSessionLink('C:\\Users\\x\\mi repositorio\\app')).toBe(
      'claude://code/new?folder=C%3A%5CUsers%5Cx%5Cmi%20repositorio%5Capp'
    );
  });
});

describe('resumeLink', () => {
  it('arma el enlace que hace que Desktop adopte la sesión del CLI', () => {
    expect(resumeLink('5ce066d2-698d-48e4-b2e7-e607207cd185')).toBe(
      'claude://resume?session=5ce066d2-698d-48e4-b2e7-e607207cd185'
    );
  });

  it('rechaza lo que Desktop iba a descartar en silencio', () => {
    expect(() => resumeLink('no-es-un-uuid')).toThrow();
    expect(() => resumeLink('5ce066d2-698d-48e4-b2e7-e607207cd185 x')).toThrow();
  });
});

describe('pareceClaudeDesktop', () => {
  const propio = 'C:\\proy\\node_modules\\electron\\dist\\electron.exe';

  it('acepta el ejecutable de Desktop', () => {
    expect(pareceClaudeDesktop('C:\\Program Files\\WindowsApps\\Claude_1.0_x64\\app\\claude.exe', propio)).toBe(true);
  });

  it('rechaza lo que dejó el registro cuando el protocolo lo tomamos nosotros', () => {
    expect(pareceClaudeDesktop(propio, propio)).toBe(false);
    expect(pareceClaudeDesktop('C:\\otra\\cosa\\electron.exe', propio)).toBe(false);
  });

  it('no se deja engañar por el propio ejecutable con otras mayúsculas', () => {
    expect(pareceClaudeDesktop('C:\\App\\Claude.exe', 'c:\\app\\claude.exe')).toBe(false);
  });
});

describe('esperandoEnlace', () => {
  it('sin ninguna apertura no se inventa un destino', () => {
    expect(esperandoEnlace()).toBeNull();
  });
});
