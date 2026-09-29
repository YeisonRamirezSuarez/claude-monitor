import { describe, expect, it } from 'vitest';
import type { AgenteOficina } from '../shared/types';
import { aTipear, acotarUmbral, atiendeUpdates, GRACIA_TIPEO_MS, MAX_TIPEO_MS, conTomadas, elegirEntrada, registroDe, temasTrasVincular } from './remoto';

describe('elegirEntrada', () => {
  it('elige la del procStart más grande (BigInt) entre las de la misma sesión', () => {
    const e = [
      { sessionId: 'a', pid: 1, procStart: '9' },
      { sessionId: 'a', pid: 2, procStart: '133000000000000010' },
      { sessionId: 'b', pid: 3, procStart: '999999999999999999999' },
      { sessionId: 'a', pid: 4, procStart: 'basura' }
    ];
    expect(elegirEntrada(e, 'a')?.pid).toBe(2);
    expect(elegirEntrada(e, 'z')).toBeUndefined();
  });
});

describe('conTomadas', () => {
  const viva = { sessionId: 'v', nombre: 'viva' } as AgenteOficina;
  const t = (sessionId: string) => ({ sessionId, cwd: 'C:\\code\\mi-app', profileId: 'p', profileName: 'Principal' });
  it('agrega las tomadas que faltan como esperando, con nombre de nombres.json o de la carpeta', () => {
    const r = conTomadas([viva], [t('x'), t('y'), t('v')], { x: { nombre: 'Bruno' } });
    expect(r.map((a) => a.sessionId)).toEqual(['v', 'x', 'y']);
    expect(r[1]).toMatchObject({ estado: 'esperando', nombre: 'Bruno', cwd: 'C:\\code\\mi-app' });
    expect(r[2].nombre).toBe('mi-app');
  });
  it('una tomada que agentesVivos sí ve queda como esperando aunque esté trabajando', () => {
    const r = conTomadas([{ ...viva, estado: 'pensando' } as AgenteOficina], [t('v')], {});
    expect(r).toHaveLength(1);
    expect(r[0].estado).toBe('esperando');
    expect(r[0].nombre).toBe('viva');
  });
});

describe('atiendeUpdates', () => {
  it('apagado sólo deja pasar el emparejado', () => {
    expect(atiendeUpdates(false, null)).toBe(true);
    expect(atiendeUpdates(false, 5)).toBe(false);
    expect(atiendeUpdates(true, 5)).toBe(true);
  });
});

describe('acotarUmbral', () => {
  it('acota a 1..240, redondea y usa 10 si no es un número', () => {
    expect(acotarUmbral(0.2)).toBe(1);
    expect(acotarUmbral(9999)).toBe(240);
    expect(acotarUmbral(7.6)).toBe(8);
    expect(acotarUmbral('abc')).toBe(10);
  });
});

describe('temasTrasVincular', () => {
  const temas = { a: 5 };
  it('conserva los temas si es el mismo chat', () => {
    expect(temasTrasVincular(temas, 1, 1)).toBe(temas);
  });
  it('los borra si cambia el chat o era el primero', () => {
    expect(temasTrasVincular(temas, 1, 2)).toEqual({});
    expect(temasTrasVincular(temas, null, 2)).toEqual({});
  });
});

describe('registroDe', () => {
  it('pasa procStart como texto y respeta quieta', () => {
    expect(registroDe({ pid: 4, procStart: 123 }, 'C:/cfg', 'C:/p', true)).toEqual({
      pid: 4,
      procStart: '123',
      configDir: 'C:/cfg',
      cwd: 'C:/p',
      quieta: true
    });
    expect(registroDe({ pid: 4 }, 'c', 'p', false).procStart).toBeUndefined();
  });
});

describe('aTipear', () => {
  const ahora = 1_000_000;
  const nada = () => false;

  it('recién entregado: escribe aunque el registro todavía diga que espera', () => {
    const t = new Map([['s', ahora - 1000]]);
    expect(aTipear(t, new Map([['s', 'esperando']]), nada, ahora)).toEqual(['s']);
  });

  it('pasada la gracia: trabajando sigue, quieta o pidiendo permiso sale', () => {
    const t = new Map([
      ['a', ahora - GRACIA_TIPEO_MS - 1],
      ['b', ahora - GRACIA_TIPEO_MS - 1],
      ['c', ahora - GRACIA_TIPEO_MS - 1],
      ['d', ahora - GRACIA_TIPEO_MS - 1]
    ]);
    const estados = new Map([['a', 'escribiendo'], ['b', 'esperando'], ['c', 'permiso']] as const);
    expect(aTipear(t, new Map(estados), nada, ahora)).toEqual(['a']);
    expect([...t.keys()]).toEqual(['a']);
  });

  it('una sesión tomada con turno en curso escribe aunque figure como quieta', () => {
    const t = new Map([['s', ahora - GRACIA_TIPEO_MS - 1]]);
    expect(aTipear(t, new Map([['s', 'esperando']]), (id) => id === 's', ahora)).toEqual(['s']);
  });

  it('tiene tope', () => {
    const t = new Map([['s', ahora - MAX_TIPEO_MS - 1]]);
    expect(aTipear(t, new Map([['s', 'escribiendo']]), () => true, ahora)).toEqual([]);
    expect(t.size).toBe(0);
  });
});
