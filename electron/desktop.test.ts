import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  desktopDir,
  esperandoEnlace,
  newSessionLink,
  newestAppDir,
  pareceClaudeDesktop,
  resumeLink,
  sesionesDeDesktop,
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

describe('sesionesDeDesktop', () => {
  let raiz = '';
  afterEach(async () => raiz && rm(raiz, { recursive: true, force: true }));

  /** Un archivo `local_*.json` con la forma que deja Desktop (medida en esta máquina). */
  async function guardar(perfil: string, archivo: string, datos: Record<string, unknown> | string) {
    const dir = join(raiz, perfil, 'claude-code-sessions', 'cuenta', 'org');
    await mkdir(dir, { recursive: true });
    const ruta = join(dir, archivo);
    await writeFile(ruta, typeof datos === 'string' ? datos : JSON.stringify(datos));
    return ruta;
  }
  const sesion = (cli: string, extra: Record<string, unknown> = {}) => ({
    sessionId: `local_${cli}`,
    cliSessionId: cli,
    cwd: 'C:\\proy',
    title: 'Una tarea',
    isArchived: false,
    lastActivityAt: 1000,
    ...extra
  });
  const nueva = async () => (raiz = await mkdtemp(join(tmpdir(), 'desktop-')));

  it('dice de qué cuenta es cada sesión por su cliSessionId', async () => {
    await nueva();
    await guardar('aaaa1111', 'local_x.json', sesion('id-x', { title: 'Migrar Angular', cwd: 'C:\\front' }));
    await guardar('bbbb2222', 'local_y.json', sesion('id-y', { isArchived: true }));
    const mapa = await sesionesDeDesktop(raiz);
    expect(mapa.get('id-x')).toMatchObject({ profileId: 'aaaa1111', title: 'Migrar Angular', cwd: 'C:\\front', archivada: false });
    expect(mapa.get('id-y')).toMatchObject({ profileId: 'bbbb2222', archivada: true });
    expect(mapa.size).toBe(2);
  });

  it('si el mismo cliSessionId está en varias cuentas gana la de actividad más reciente', async () => {
    // Medido: el pozo es compartido y una sesión adoptada queda anotada en el
    // almacén de cada Desktop que la abrió.
    await nueva();
    await guardar('aaaa1111', 'local_a.json', sesion('id', { lastActivityAt: 1000 }));
    await guardar('bbbb2222', 'local_b.json', sesion('id', { lastActivityAt: 5000 }));
    await guardar('cccc3333', 'local_c.json', sesion('id', { lastActivityAt: 3000 }));
    expect((await sesionesDeDesktop(raiz)).get('id')?.profileId).toBe('bbbb2222');
  });

  it('una copia archivada no le gana a una abierta, por más reciente que sea', async () => {
    await nueva();
    await guardar('aaaa1111', 'local_a.json', sesion('id', { lastActivityAt: 1000 }));
    await guardar('bbbb2222', 'local_b.json', sesion('id', { lastActivityAt: 5000, isArchived: true }));
    const s = (await sesionesDeDesktop(raiz)).get('id');
    expect(s).toMatchObject({ profileId: 'aaaa1111', archivada: false });
  });

  it('ignora lo que no se entiende: JSON roto, sin cliSessionId, otros archivos', async () => {
    await nueva();
    await guardar('aaaa1111', 'local_roto.json', '{"cliSessionId": "a');
    await guardar('aaaa1111', 'local_sin.json', { sessionId: 'local_z' });
    await guardar('aaaa1111', 'otro.json', sesion('id-otro'));
    await guardar('aaaa1111', 'local_ok.json', sesion('id-ok'));
    expect([...(await sesionesDeDesktop(raiz)).keys()]).toEqual(['id-ok']);
  });

  it('sin la carpeta de Desktop devuelve un mapa vacío', async () => {
    await nueva();
    expect((await sesionesDeDesktop(join(raiz, 'no-existe'))).size).toBe(0);
  });

  it('ve los cambios (archivar) y las bajas sin que haya que reiniciar nada', async () => {
    await nueva();
    const ruta = await guardar('aaaa1111', 'local_a.json', sesion('id-a'));
    await guardar('aaaa1111', 'local_b.json', sesion('id-b'));
    expect((await sesionesDeDesktop(raiz)).get('id-a')?.archivada).toBe(false);
    await writeFile(ruta, JSON.stringify(sesion('id-a', { isArchived: true })));
    // El tamaño cambia pero igual se fuerza la fecha: en algunos discos el mtime tiene resolución de segundos.
    await utimes(ruta, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect((await sesionesDeDesktop(raiz)).get('id-a')?.archivada).toBe(true);
    await rm(join(raiz, 'aaaa1111', 'claude-code-sessions', 'cuenta', 'org', 'local_b.json'));
    expect((await sesionesDeDesktop(raiz)).has('id-b')).toBe(false);
  });
});
