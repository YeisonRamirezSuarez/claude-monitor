import { describe, it, expect } from 'vitest';
import { evaluar, Presencia } from './presencia';

describe('evaluar', () => {
  const base = { manual: null, tapaCerrada: null, inactivoSeg: 0 };
  it('lo manual manda sobre todo', () => {
    expect(evaluar({ ...base, manual: false, tapaCerrada: true }, 10)).toEqual({ fuera: false, motivo: 'manual' });
    expect(evaluar({ ...base, manual: true }, 10)).toEqual({ fuera: true, motivo: 'manual' });
  });
  // Final review I1 (spec §7): usar teclado o mouse es estar, aunque la tapa diga cerrada (un monitor externo,
  // o un ayudante que quedó en "cerrada"). La tapa sólo adelanta el umbral a un minuto sin tocar nada.
  it('tapa cerrada es fuera tras un minuto sin teclado ni mouse, no antes', () => {
    expect(evaluar({ ...base, tapaCerrada: true, inactivoSeg: 5 }, 10)).toEqual({ fuera: false, motivo: null });
    expect(evaluar({ ...base, tapaCerrada: true, inactivoSeg: 60 }, 10)).toEqual({ fuera: true, motivo: 'tapa' });
  });
  it('inactividad a partir del umbral', () => {
    expect(evaluar({ ...base, inactivoSeg: 599 }, 10).fuera).toBe(false);
    expect(evaluar({ ...base, inactivoSeg: 600 }, 10)).toEqual({ fuera: true, motivo: 'inactividad' });
  });
  it('tapa abierta y actividad: presente', () => {
    expect(evaluar({ ...base, tapaCerrada: false, inactivoSeg: 5 }, 10)).toEqual({ fuera: false, motivo: null });
  });
});

describe('Presencia', () => {
  it('avisa sólo los cambios y abrir la tapa borra lo manual', () => {
    let idle = 0;
    const cambios: boolean[] = [];
    const p = new Presencia(() => idle, 10, (e) => cambios.push(e.fuera));
    p.revisar();
    p.setManual(true);
    p.revisar();
    p.setTapa(true);
    p.setTapa(false);
    expect(cambios).toEqual([true, false]);
    idle = 700;
    p.revisar();
    expect(p.estado()).toEqual({ fuera: true, motivo: 'inactividad' });
  });

  it('repetir el mismo estado de tapa no borra manual', () => {
    const cambios: boolean[] = [];
    const p = new Presencia(() => 0, 10, (e) => cambios.push(e.fuera));
    p.setManual(true);
    p.setTapa(false);
    const estadoAntesDeRepetir = p.estado();
    p.setTapa(false); // Repetir el mismo estado
    expect(p.estado()).toEqual(estadoAntesDeRepetir);
    expect(cambios).toEqual([true]); // Solo uno: del setManual
  });

  it('el primer setTapa (null → false) no borra manual', () => {
    const cambios: boolean[] = [];
    const p = new Presencia(() => 0, 10, (e) => cambios.push(e.fuera));
    p.setManual(true);
    expect(cambios).toEqual([true]);
    p.setTapa(false); // Primera vez: null → false
    expect(p.estado()).toEqual({ fuera: true, motivo: 'manual' });
    expect(cambios).toEqual([true]); // Sin cambio en fuera
  });

  it('un cambio real de tapa (true ↔ false) borra manual', () => {
    const cambios: boolean[] = [];
    const p = new Presencia(() => 60, 10, (e) => cambios.push(e.fuera));
    p.setTapa(false); // Primera vez: null → false
    p.setManual(true);
    expect(cambios).toEqual([true]);
    p.setTapa(true); // Cambio real, pero sigue fuera (motivo cambió, no fuera)
    expect(cambios).toEqual([true]); // Sin notificación
    expect(p.estado().motivo).toEqual('tapa'); // Manual fue borrado, ahora es por tapa
    p.setTapa(false); // Cambio real
    expect(cambios).toEqual([true, false]);
    expect(p.estado()).toEqual({ fuera: false, motivo: null });
  });
});
