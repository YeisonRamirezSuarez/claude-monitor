// electron/telegram-progreso.test.ts
import { describe, it, expect } from 'vitest';
import type { ConversacionItem } from '../shared/types';
import { progresoDe } from './telegram-progreso';

const usuario = (texto: string): ConversacionItem => ({ tipo: 'usuario', texto, ts: '' });
const claude = (texto: string): ConversacionItem => ({ tipo: 'claude', texto, ts: '' });
const herramienta = (nombre: string, detalle: string, resultado: string | null = 'ok', error = false): ConversacionItem => ({
  tipo: 'herramienta',
  toolId: nombre + detalle,
  nombre,
  detalle,
  entrada: '',
  resultado,
  error,
  ts: ''
});

describe('progresoDe', () => {
  it('muestra sólo lo del turno actual: lo posterior al último mensaje del usuario', () => {
    const t = progresoDe([usuario('antes'), claude('viejo'), usuario('corré los tests'), herramienta('Bash', 'npm test', null)]);
    expect(t).toBe('⏳ Trabajando…\n\n⏳ Bash — npm test');
    expect(t).not.toContain('viejo');
  });

  it('marca lo terminado, lo fallido, y resume el texto', () => {
    const largo = 'x'.repeat(300);
    const t = progresoDe([usuario('u'), herramienta('Read', 'a.ts'), herramienta('Bash', 'mal', 'boom', true), claude(largo)]);
    expect(t.split('\n').slice(2)).toEqual(['✔️ Read — a.ts', '❌ Bash — mal', `💬 ${'x'.repeat(159)}…`]);
  });

  it('con muchos pasos muestra los últimos y cuántos hubo antes', () => {
    const pasos = Array.from({ length: 12 }, (_, i) => herramienta('Edit', `f${i}.ts`));
    const t = progresoDe([usuario('u'), ...pasos]);
    expect(t).toContain('(+4 pasos antes)');
    expect(t).toContain('f11.ts');
    expect(t).not.toContain('f3.ts');
  });

  it('sin actividad todavía', () => {
    expect(progresoDe([usuario('hola')])).toBe('⏳ Trabajando…');
  });
});
