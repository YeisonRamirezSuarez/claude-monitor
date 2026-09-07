import { describe, expect, it } from 'vitest';
import type { Raiz } from '../shared/types';
import {
  estadoDeSesion,
  etiquetaDeEntorno,
  hablarDeChrome,
  motivoDeshabilitado,
  seLeMiroElDisco
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
  it('motivo por defecto: Desktop no puede hospedar una sesión de la distro', () => {
    expect(motivoDeshabilitado({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' })).toBe(
      'Claude Desktop no puede abrir sesiones de Ubuntu'
    );
  });
  it('borrar tiene su propio motivo: no es que Desktop no pueda, es que no está habilitado todavía', () => {
    expect(motivoDeshabilitado({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' }, 'borrar')).toBe(
      'Borrar sesiones de Ubuntu no está disponible todavía'
    );
  });
  it('en Windows no hay motivo: el botón anda', () => {
    expect(motivoDeshabilitado({ tipo: 'windows' })).toBe('');
  });
});

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
