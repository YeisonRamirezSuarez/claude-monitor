import { describe, expect, it } from 'vitest';
import { sesionesAAdoptar } from './adopcion';

const agente = (sessionId: string, transcript = `C:/t/${sessionId}.jsonl`) => ({ sessionId, transcript });

describe('sesionesAAdoptar', () => {
  it('pide las que la oficina no tiene y todavía no se intentaron', () => {
    const r = sesionesAAdoptar([agente('a'), agente('b')], new Set(['a']), new Map(), 1000);
    expect(r.map((x) => x.sessionId)).toEqual(['b']);
  });

  it('no repite un intento antes de 60 s', () => {
    const intentos = new Map([['b', 1000]]);
    expect(sesionesAAdoptar([agente('b')], new Set(), intentos, 60_999)).toEqual([]);
  });

  it('a los 60 s la vuelve a pedir: un motor de Desktop que reapareció, o un personaje que Pixel soltó', () => {
    const intentos = new Map([['b', 1000]]);
    expect(sesionesAAdoptar([agente('b')], new Set(), intentos, 61_000).map((x) => x.sessionId)).toEqual(['b']);
  });

  it('sin transcript no hay qué adoptar', () => {
    expect(sesionesAAdoptar([agente('a', '')], new Set(), new Map(), 1000)).toEqual([]);
  });

  it('las que ya están en la oficina no se piden nunca', () => {
    expect(sesionesAAdoptar([agente('a')], new Set(['a']), new Map(), 10 ** 9)).toEqual([]);
  });
});
