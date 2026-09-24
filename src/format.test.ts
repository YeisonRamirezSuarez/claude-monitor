import { describe, expect, it } from 'vitest';
import type { Raiz } from '../shared/types';
import {
  estadoDeSesion,
  etiquetaDeEntorno,
  hablarDeChrome,
  motivoDeshabilitado,
  procedenciaDeConsumo,
  raicesMudas,
  seLeMiroElDisco,
  textoDeMotivo
} from './format';

const WSL = { tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' } as const;
const raizCon = (estado: Raiz['estado']): Raiz => ({
  configDir: '\\\\wsl.localhost\\Ubuntu\\home\\v\\.claude',
  entorno: WSL,
  estado
});

describe('etiquetaDeEntorno', () => {
  it('las de Windows no llevan marca: son la mayoría y la marca sería ruido', () => {
    expect(etiquetaDeEntorno({ tipo: 'windows' })).toBe('');
  });
  it('las de WSL llevan la distro', () => {
    expect(etiquetaDeEntorno({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' })).toBe('Ubuntu');
  });
});

describe('motivoDeshabilitado', () => {
  // Quedó uno solo: borrar. Los de Desktop se fueron cuando reanudar y crear
  // en Desktop empezaron a andar con una cuenta de la distro.
  it('borrar es una decisión de producto, no una imposibilidad', () => {
    expect(motivoDeshabilitado({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' })).toBe(
      'Borrar sesiones de Ubuntu no está disponible todavía'
    );
  });

  it('en Windows no hay motivo: el botón anda', () => {
    expect(motivoDeshabilitado({ tipo: 'windows' })).toBe('');
  });
});
;

describe('seLeMiroElDisco', () => {
  it('una cuenta de Windows siempre se mira', () => {
    expect(seLeMiroElDisco({ tipo: 'windows' }, undefined)).toBe(true);
    expect(seLeMiroElDisco(undefined, undefined)).toBe(true);
  });

  it('con la distro apagada no se miró nada: tocar la UNC la encendería', () => {
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'apagada', mensaje: 'Distro apagada' }))).toBe(false);
  });

  it('sin la distro instalada tampoco', () => {
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'sin-distro', mensaje: 'La distro Ubuntu ya no está' }))).toBe(
      false
    );
  });

  it('con la distro corriendo sí se miró, aunque falte algo adentro', () => {
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'ok' }))).toBe(true);
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'sin-config', mensaje: 'x' }))).toBe(true);
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'sin-cli', mensaje: 'x' }))).toBe(true);
  });

  it('sin raíz todavía no se miró nada: no es lo mismo que no haber encontrado nada', () => {
    expect(seLeMiroElDisco(WSL, undefined)).toBe(false);
  });
});

describe('estadoDeSesion', () => {
  it('una cuenta WSL con la distro apagada no está "sin sesión": no se sabe', () => {
    // Es el hallazgo: `sinMirar` devuelve authenticated:false porque se NEGÓ a
    // leer, no porque haya leído un archivo vacío.
    const cuenta = { entorno: WSL, authenticated: false, authExpiresAt: null };
    expect(estadoDeSesion(cuenta, raizCon({ tipo: 'apagada', mensaje: 'Distro apagada' }))).toBe('sin-mirar');
  });

  it('con la distro corriendo y sin credenciales sí está sin sesión', () => {
    const cuenta = { entorno: WSL, authenticated: false, authExpiresAt: null };
    expect(estadoDeSesion(cuenta, raizCon({ tipo: 'ok' }))).toBe('sin-sesion');
  });

  it('los tres estados de siempre en Windows no cambian', () => {
    const base = { entorno: { tipo: 'windows' } as const };
    expect(estadoDeSesion({ ...base, authenticated: false, authExpiresAt: null }, undefined)).toBe('sin-sesion');
    expect(estadoDeSesion({ ...base, authenticated: true, authExpiresAt: null }, undefined)).toBe('suposicion');
    expect(estadoDeSesion({ ...base, authenticated: true, authExpiresAt: 1 }, undefined)).toBe('viva');
  });
});

describe('hablarDeChrome', () => {
  it('a una cuenta de WSL nunca: la extensión no llega a la distro', () => {
    expect(hablarDeChrome(WSL)).toBe(false);
  });
  it('en Windows sí, que es donde el puente existe', () => {
    expect(hablarDeChrome({ tipo: 'windows' })).toBe(true);
    expect(hablarDeChrome(undefined)).toBe(true);
  });
});


describe('procedenciaDeConsumo', () => {
  it('en vivo no necesita explicaciones', () => {
    expect(procedenciaDeConsumo({ origen: 'vivo', motivo: '', fetchedAtMs: Date.now() })).toBe('en vivo');
  });

  it('lo guardado dice de cuándo es Y por qué no es de ahora', () => {
    // Las dos mitades importan: la antigüedad para saber cuánto confiar, y el
    // motivo porque "el token venció" y "no hay red" se ven igual en pantalla
    // pero se arreglan distinto.
    const texto = procedenciaDeConsumo({
      origen: 'guardado',
      motivo: 'token-vencido',
      fetchedAtMs: Date.now() - 3 * 3600_000
    });
    expect(texto).toContain('último dato, de hace 3 horas');
    expect(texto).toContain('el token venció');
  });

  it('la caché del CLI se nombra como lo que es', () => {
    expect(
      procedenciaDeConsumo({ origen: 'cli', motivo: 'sin-respuesta', fetchedAtMs: Date.now() - 86400_000 })
    ).toBe('caché del CLI, de ayer · sin respuesta de la API (red o demora)');
  });

  it('sin fecha no se inventa una', () => {
    expect(procedenciaDeConsumo({ origen: 'cli', motivo: '', fetchedAtMs: 0 })).toBe('caché del CLI');
  });

  it('un motivo que la interfaz no conoce se muestra igual, no desaparece', () => {
    expect(textoDeMotivo('motivo-nuevo')).toBe('motivo-nuevo');
  });
});

describe('raicesMudas', () => {
  const pozo: Raiz = { configDir: 'C:/Users/x/.claude', entorno: { tipo: 'windows' }, estado: { tipo: 'ok' } };
  const wsl = (estado: Raiz['estado']): Raiz => ({
    configDir: '\\wsl.localhost\Ubuntu\home\p\.claude',
    entorno: { tipo: 'wsl', distro: 'Ubuntu', home: '/home/p' },
    estado
  });

  it('no dice nada cuando todo se pudo leer', () => {
    expect(raicesMudas([pozo, wsl({ tipo: 'ok' })])).toEqual([]);
  });

  // El caso real: WSL se apaga solo por inactividad, así que la lista se queda
  // sin las sesiones de Ubuntu y con todas las de Windows.
  it('delata la distro apagada y ofrece encenderla', () => {
    expect(raicesMudas([pozo, wsl({ tipo: 'apagada', mensaje: 'Distro apagada' })])).toEqual([
      { distro: 'Ubuntu', mensaje: 'Distro apagada', apagada: true }
    ]);
  });

  it('también delata las que no se arreglan encendiendo', () => {
    expect(raicesMudas([wsl({ tipo: 'sin-config', mensaje: 'No hay Claude Code configurado ahí' })])).toEqual([
      { distro: 'Ubuntu', mensaje: 'No hay Claude Code configurado ahí', apagada: false }
    ]);
  });

  it('el pozo de Windows nunca entra: se lee siempre', () => {
    expect(raicesMudas([pozo])).toEqual([]);
  });

  // Dos cuentas en la misma distro miran el mismo ~/.claude: el aviso es de la
  // distro, no de la cuenta, y repetirlo sería además dos `key` de React iguales.
  it('una sola vez por distro aunque haya dos raíces de la misma', () => {
    const apagada = wsl({ tipo: 'apagada', mensaje: 'Distro apagada' });
    expect(raicesMudas([apagada, apagada, pozo])).toEqual([
      { distro: 'Ubuntu', mensaje: 'Distro apagada', apagada: true }
    ]);
  });

  // El mensaje se muestra tal cual: bajarlo a minúscula escribía "el cli en
  // ubuntu" y "la distro ubuntu ya no está".
  it('no toca el texto del mensaje: adentro hay nombres propios', () => {
    expect(raicesMudas([wsl({ tipo: 'sin-cli', mensaje: 'Falta el CLI en Ubuntu' })])[0].mensaje).toBe(
      'Falta el CLI en Ubuntu'
    );
  });
});
