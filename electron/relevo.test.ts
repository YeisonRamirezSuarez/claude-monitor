import { describe, expect, it } from 'vitest';
import type { AccountUsage } from '../shared/types';
import { avisoDeCupo, tope, type Candidato } from './relevo';

const usoDe = (...percents: number[]): AccountUsage => ({
  email: '',
  accountName: '',
  plan: '',
  live: true,
  fetchedAtMs: 1,
  limits: percents.map((percent, i) => ({
    kind: `k${i}`,
    label: `l${i}`,
    percent,
    severity: 'ok',
    resetsAt: null
  }))
});

const cuenta = (id: string, usage: AccountUsage | null, authenticated = true): Candidato => ({
  id,
  name: id,
  authenticated,
  usage
});

describe('tope', () => {
  it('devuelve el límite más apretado, que es el que frena', () => {
    expect(tope(usoDe(3, 99))).toBe(99);
  });

  it('sin datos no es lo mismo que vacía', () => {
    expect(tope(null)).toBe(-1);
    expect(tope(usoDe())).toBe(-1);
  });
});

describe('avisoDeCupo', () => {
  it('con cupo no dice nada: no hay nada que avisar', () => {
    expect(avisoDeCupo([cuenta('a', usoDe(40)), cuenta('b', usoDe(2))], 'a')).toBeNull();
  });

  it('sin cupo nombra la más libre de las medidas', () => {
    const aviso = avisoDeCupo([cuenta('a', usoDe(99)), cuenta('b', usoDe(60)), cuenta('c', usoDe(10))], 'a');
    expect(aviso).toContain('"a" está al 99%');
    expect(aviso).toContain('"c" tiene cupo (al 10%)');
  });

  it('el umbral corta antes del 100: al 97 ya avisa', () => {
    expect(avisoDeCupo([cuenta('a', usoDe(97)), cuenta('b', usoDe(5))], 'a')).toContain('"b"');
  });

  it('no recomienda una cuenta sin sesión iniciada', () => {
    const aviso = avisoDeCupo([cuenta('a', usoDe(99)), cuenta('b', usoDe(1), false)], 'a');
    expect(aviso).toContain('ninguna otra cuenta tiene cupo');
  });

  it('prefiere una medida antes que una sin datos', () => {
    const aviso = avisoDeCupo([cuenta('a', usoDe(99)), cuenta('sin-datos', null), cuenta('c', usoDe(80))], 'a');
    expect(aviso).toContain('"c"');
  });

  it('nombra una sin datos si no hay ninguna medida: no saber no es estar lleno', () => {
    const aviso = avisoDeCupo([cuenta('a', usoDe(99)), cuenta('sin-datos', null)], 'a');
    expect(aviso).toContain('"sin-datos"');
    expect(aviso).toContain('sin datos de consumo');
  });

  it('también avisa cuando la activa perdió la sesión, no sólo por consumo', () => {
    const aviso = avisoDeCupo([cuenta('a', usoDe(1), false), cuenta('b', usoDe(50))], 'a');
    expect(aviso).toContain('no tiene la sesión iniciada');
    expect(aviso).toContain('"b"');
  });
});
