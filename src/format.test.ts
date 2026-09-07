import { describe, expect, it } from 'vitest';
import { etiquetaDeEntorno, motivoDeshabilitado } from './format';

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
