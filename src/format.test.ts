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
  it('explica por qué no se puede, en vez de un botón muerto', () => {
    expect(motivoDeshabilitado({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' })).toBe(
      'Se reanuda desde Ubuntu'
    );
  });
  it('en Windows no hay motivo: el botón anda', () => {
    expect(motivoDeshabilitado({ tipo: 'windows' })).toBe('');
  });
});
