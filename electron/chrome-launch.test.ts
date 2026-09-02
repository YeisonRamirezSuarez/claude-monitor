// electron/chrome-launch.test.ts
import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserDir,
  EXTENSION_ID,
  pruneStalePairing,
  declaresExtension,
  setupBrowserDone,
  displayName,
  hasSessionCookie,
  nextStepUrl,
  observadoEn,
  parseRegistryPath,
  withProfileName
} from './chrome-launch';

describe('parseRegistryPath', () => {
  it('saca la ruta de una salida en español', () => {
    const salida = [
      '',
      'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
      '    (Predeterminado)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      ''
    ].join('\r\n');
    expect(parseRegistryPath(salida)).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  });

  it('y de una en inglés: el nombre del valor está traducido, el tipo no', () => {
    const salida = '    (Default)    REG_SZ    C:\\Chrome\\chrome.exe\r\n';
    expect(parseRegistryPath(salida)).toBe('C:\\Chrome\\chrome.exe');
  });

  it('devuelve null si la clave no está, en vez de inventar una ruta', () => {
    expect(parseRegistryPath('ERROR: El sistema no puede encontrar la clave')).toBeNull();
  });
});

describe('browserDir', () => {
  it('cada cuenta tiene su propia carpeta de datos: compartirla compartiria la sesion', () => {
    expect(browserDir('0cd7b804')).not.toBe(browserDir('204db0cb'));
  });

  it('descarta lo que una carpeta no aguanta', () => {
    expect(browserDir('a b/c:d')).toContain('abcd');
  });

  it('no cuelga del Chrome del usuario: es una instancia aparte (regresion: siempre abria el mismo perfil)', () => {
    expect(browserDir('a1').toLowerCase()).not.toContain('google');
  });
});

describe('declaresExtension', () => {
  it('reconoce la extensión instalada', () => {
    const prefs = JSON.stringify({ extensions: { settings: { fcoeoabgfenejglbffodgkkbkcdhcgfn: { state: 1 } } } });
    expect(declaresExtension(prefs)).toBe(true);
  });

  it('un perfil recién creado no la tiene: las extensiones son por perfil (regresión: "not connected")', () => {
    const prefs = JSON.stringify({ extensions: { settings: { otraextensioncualquieraaaaaaaaaa: {} } } });
    expect(declaresExtension(prefs)).toBe(false);
    expect(declaresExtension('{}')).toBe(false);
  });

  it('preferencias ilegibles cuentan como sin extensión, para ofrecer instalarla y no dar por hecho que está', () => {
    expect(declaresExtension('no es json')).toBe(false);
  });
});

describe('displayName', () => {
  it('identifica la cuenta en el selector de Chrome, que si no dice "Persona 1"', () => {
    expect(displayName('generate prueba 5')).toBe('Claude · generate prueba 5');
  });

  it('aplasta espacios de más', () => {
    expect(displayName('  super   dev  ')).toBe('Claude · super dev');
  });
});

describe('withProfileName', () => {
  it('cambia el nombre y no toca el resto de las preferencias', () => {
    const prefs = JSON.stringify({ profile: { name: 'Persona 1', avatar_index: 7 }, extensions: { settings: {} } });
    const salida = JSON.parse(withProfileName(prefs, 'Claude · personal')!);
    expect(salida.profile.name).toBe('Claude · personal');
    expect(salida.profile.avatar_index).toBe(7);
    expect(salida.extensions).toEqual({ settings: {} });
  });

  it('no reescribe si ya se llama así', () => {
    expect(withProfileName(JSON.stringify({ profile: { name: 'X' } }), 'X')).toBeNull();
  });

  it('preferencias ilegibles no se pisan', () => {
    expect(withProfileName('no es json', 'X')).toBeNull();
  });
});

describe('hasSessionCookie', () => {
  it('reconoce la sesión de claude.ai', () => {
    expect(hasSessionCookie(Buffer.from('...claude.aisessionKey...'))).toBe(true);
  });

  it('un perfil con la extensión pero sin login no cuenta (regresión: "no estás logueado")', () => {
    expect(hasSessionCookie(Buffer.from('...claude.ailastActiveOrg...'))).toBe(false);
  });
});

describe('observadoEn', () => {
  it('devuelve la observación más vieja, que es la antigüedad real de lo que se afirma', () => {
    expect(observadoEn({ ok: true, seenAt: 500 }, { ok: true, seenAt: 100 })).toBe(100);
  });

  it('con algo nunca observado no hay antigüedad que dar', () => {
    expect(observadoEn({ ok: true, seenAt: 500 }, null)).toBe(0);
  });
});

describe('setupBrowserDone', () => {
  const cuenta = (authenticated: boolean, extension: boolean, loggedIn: boolean) => ({
    authenticated,
    chrome: { profileExists: true, extension, loggedIn, verified: true, seenAt: 1 }
  });

  it('con la extensión y la sesión listas, la ventana de configuración ya no hace falta', () => {
    expect(setupBrowserDone(cuenta(false, true, true), false)).toBe(true);
  });

  it('con un paso a medias no se cierra: es la ventana donde hay que hacerlo', () => {
    expect(setupBrowserDone(cuenta(false, false, true), false)).toBe(false);
    expect(setupBrowserDone(cuenta(false, true, false), false)).toBe(false);
  });

  it('con el login del CLI hecho la ventana es del usuario, no de la app', () => {
    expect(setupBrowserDone(cuenta(true, true, true), false)).toBe(false);
  });

  it('nunca durante la autorización: se está mostrando en esa misma ventana', () => {
    expect(setupBrowserDone(cuenta(false, true, true), true)).toBe(false);
  });
});

describe('nextStepUrl', () => {
  const estado = (loggedIn: boolean, extension: boolean) => ({
    profileExists: true,
    loggedIn,
    extension,
    verified: true,
    seenAt: 1
  });

  it('sin extensión manda a la tienda, aunque falte todo lo demás: es el primer paso', () => {
    expect(nextStepUrl(estado(false, false))).toContain('chromewebstore.google.com');
    expect(nextStepUrl(estado(true, false))).toContain('chromewebstore.google.com');
  });

  it('con la extensión puesta y sin sesión manda a claude.ai', () => {
    expect(nextStepUrl(estado(false, true))).toBe('https://claude.ai');
  });

  it('con todo listo abre claude.ai, para ver con qué cuenta quedó', () => {
    expect(nextStepUrl(estado(true, true))).toBe('https://claude.ai');
  });

  it('nunca devuelve dos destinos: una pestaña por vez (regresión: se abrían tres)', () => {
    for (const s of [estado(false, false), estado(true, false), estado(true, true)]) {
      expect(nextStepUrl(s).split(' ')).toHaveLength(1);
    }
  });
});

describe('pruneStalePairing', () => {
  const conPareja = (id: string) =>
    JSON.stringify({ oauthAccount: { emailAddress: 'yo@x.com' }, chromeExtension: { pairedDeviceId: id } });

  it('borra el emparejamiento que apunta a un navegador que este no conoce (regresión: "Browser 1" fantasma)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-pair-'));
    try {
      const id = 'cuenta-de-prueba';
      // El almacén de la extensión existe pero no menciona ese dispositivo.
      const store = join(browserDir(id), 'Default', 'Local Extension Settings', EXTENSION_ID);
      await mkdir(store, { recursive: true });
      await writeFile(join(store, '000003.log'), 'otro-dispositivo-cualquiera');
      await writeFile(join(dir, '.claude.json'), conPareja('7ef9c3cc-fantasma'));

      expect(await pruneStalePairing(dir, id)).toBe(true);
      const salida = JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8'));
      expect(salida.chromeExtension).toBeUndefined();
      expect(salida.oauthAccount.emailAddress).toBe('yo@x.com'); // el resto intacto
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(browserDir('cuenta-de-prueba'), { recursive: true, force: true });
    }
  });

  it('respeta el emparejamiento que SÍ es de su navegador', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-pair-'));
    try {
      const id = 'cuenta-buena';
      const store = join(browserDir(id), 'Default', 'Local Extension Settings', EXTENSION_ID);
      await mkdir(store, { recursive: true });
      await writeFile(join(store, '000003.log'), 'ruido mi-dispositivo mas ruido');
      await writeFile(join(dir, '.claude.json'), conPareja('mi-dispositivo'));

      expect(await pruneStalePairing(dir, id)).toBe(false);
      expect(JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8')).chromeExtension).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(browserDir('cuenta-buena'), { recursive: true, force: true });
    }
  });

  it('sin poder mirar el almacén no borra nada: uno bueno borrado obliga a rehacerlo a mano', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-pair-'));
    try {
      await writeFile(join(dir, '.claude.json'), conPareja('quien-sabe'));
      expect(await pruneStalePairing(dir, 'cuenta-sin-navegador')).toBe(false);
      expect(JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8')).chromeExtension).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
