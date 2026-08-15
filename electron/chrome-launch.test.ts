// electron/chrome-launch.test.ts
import { describe, it, expect } from 'vitest';
import {
  chromeProfileName,
  declaresExtension,
  displayName,
  hasSessionCookie,
  nextStepUrl,
  parseRegistryPath,
  withInfoCacheName,
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

describe('chromeProfileName', () => {
  it('deriva el nombre del id, que no cambia', () => {
    expect(chromeProfileName('88eabab9')).toBe('Claude-88eabab9');
  });

  it('descarta lo que una carpeta no aguanta', () => {
    expect(chromeProfileName('a b/c:d\\e')).toBe('Claude-abcde');
  });

  it('cuentas distintas nunca comparten perfil: compartirlo compartiría la sesión', () => {
    expect(chromeProfileName('0cd7b804')).not.toBe(chromeProfileName('204db0cb'));
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

describe('withInfoCacheName', () => {
  it('renombra la entrada del selector', () => {
    const state = JSON.stringify({
      profile: { info_cache: { 'Claude-a1': { name: 'Persona 2', otro: 1 }, Default: { name: 'Tu Chrome' } } }
    });
    const salida = JSON.parse(withInfoCacheName(state, 'Claude-a1', 'Claude · personal')!);
    expect(salida.profile.info_cache['Claude-a1'].name).toBe('Claude · personal');
    expect(salida.profile.info_cache['Claude-a1'].otro).toBe(1);
    expect(salida.profile.info_cache.Default.name).toBe('Tu Chrome');
  });

  it('no da de alta perfiles que Chrome no conoce: inventar entradas rompe el selector', () => {
    const state = JSON.stringify({ profile: { info_cache: { Default: { name: 'Tu Chrome' } } } });
    expect(withInfoCacheName(state, 'Claude-nuevo', 'X')).toBeNull();
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

describe('nextStepUrl', () => {
  const estado = (loggedIn: boolean, extension: boolean) => ({ profileExists: true, loggedIn, extension });

  it('sin sesión manda a claude.ai: la extensión no sirve hasta que haya sesión', () => {
    expect(nextStepUrl(estado(false, false))).toBe('https://claude.ai');
    expect(nextStepUrl(estado(false, true))).toBe('https://claude.ai');
  });

  it('con sesión y sin extensión manda a la tienda', () => {
    expect(nextStepUrl(estado(true, false))).toContain('chromewebstore.google.com');
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
