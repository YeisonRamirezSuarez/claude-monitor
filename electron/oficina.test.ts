// electron/oficina.test.ts
import { describe, it, expect } from 'vitest';
import { actividadDe, estadoDe, mensajesRecientes, mismoInicio, parseConversacion, rutaSubagente, slugDe } from './oficina';

const linea = (o: unknown) => JSON.stringify(o);
const usuario = (content: unknown, extra: Record<string, unknown> = {}) =>
  linea({ type: 'user', cwd: 'C:/proyecto', timestamp: '2026-09-24T12:00:00Z', message: { content }, ...extra });
const asistente = (content: unknown, extra: Record<string, unknown> = {}) =>
  linea({ type: 'assistant', timestamp: '2026-09-24T12:00:01Z', message: { content }, ...extra });

describe('actividadDe', () => {
  it('una herramienta sin resultado es lo que está corriendo', () => {
    const a = actividadDe([
      usuario('arregla el login'),
      asistente([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Corre los tests' } }])
    ]);
    expect(a).toEqual({ tipo: 'escribiendo', herramienta: 'Bash', detalle: 'Corre los tests' });
  });

  it('distingue leer y delegar', () => {
    expect(actividadDe([asistente([{ type: 'tool_use', id: 't', name: 'Grep', input: { pattern: 'x' } }])]).tipo).toBe('leyendo');
    expect(actividadDe([asistente([{ type: 'tool_use', id: 't', name: 'Agent', input: {} }])]).tipo).toBe('delegando');
  });

  it('con el resultado devuelto le toca pensar a Claude; con su texto, terminó', () => {
    const pedido = asistente([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/a/b.ts' } }]);
    const vuelta = usuario([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
    expect(actividadDe([pedido, vuelta]).tipo).toBe('pensando');
    expect(actividadDe([pedido, vuelta, asistente([{ type: 'text', text: 'Listo.' }])]).tipo).toBe('listo');
  });

  it('ignora líneas cortadas', () => {
    expect(actividadDe(['{"type":"assis', usuario('hola')]).tipo).toBe('pensando');
  });
});

describe('estadoDe', () => {
  const herramienta = { tipo: 'escribiendo' as const, herramienta: 'Bash', detalle: '' };
  const listo = { tipo: 'listo' as const, herramienta: '', detalle: '' };
  it('quieta con una herramienta pendiente es un pedido de permiso', () => {
    expect(estadoDe('idle', herramienta)).toBe('permiso');
  });
  it('quieta y sin nada pendiente te está esperando', () => {
    expect(estadoDe('idle', listo)).toBe('esperando');
  });
  it('ocupada sin herramienta está pensando', () => {
    expect(estadoDe('busy', listo)).toBe('pensando');
    expect(estadoDe('busy', herramienta)).toBe('escribiendo');
  });
});

describe('parseConversacion', () => {
  it('cuelga cada resultado de su herramienta', () => {
    const c = parseConversacion([
      usuario('mirá el archivo'),
      asistente([
        { type: 'text', text: 'Lo leo.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/a/app.ts' } }
      ]),
      usuario([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'contenido' }] }])
    ]);
    expect(c.cwd).toBe('C:/proyecto');
    expect(c.items.map((i) => i.tipo)).toEqual(['usuario', 'claude', 'herramienta']);
    const h = c.items[2];
    expect(h.tipo === 'herramienta' && [h.nombre, h.detalle, h.resultado, h.error]).toEqual(['Read', 'app.ts', 'contenido', false]);
  });

  it('una herramienta sin resultado queda en curso', () => {
    const c = parseConversacion([asistente([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }])]);
    expect(c.items[0].tipo === 'herramienta' && c.items[0].resultado).toBeNull();
  });

  it('un subagente lleva su id, su pedido y lo que devolvió', () => {
    const c = parseConversacion([
      asistente([
        {
          type: 'tool_use',
          id: 't1',
          name: 'Agent',
          input: { description: 'Revisar Task 1', subagent_type: 'Explore', prompt: 'Revisá esto' }
        }
      ]),
      usuario([{ type: 'tool_result', tool_use_id: 't1', content: 'Todo bien' }], {
        toolUseResult: { agentId: 'a4f2369' }
      })
    ]);
    expect(c.items).toEqual([
      {
        tipo: 'subagente',
        toolId: 't1',
        agentId: 'a4f2369',
        tipoAgente: 'Explore',
        descripcion: 'Revisar Task 1',
        prompt: 'Revisá esto',
        resultado: 'Todo bien',
        ts: '2026-09-24T12:00:01Z'
      }
    ]);
  });

  it('muestra los mensajes entre agentes en los dos sentidos', () => {
    const c = parseConversacion([
      asistente([{ type: 'tool_use', id: 't1', name: 'SendMessage', input: { to: 'acc35', message: 'Arreglá el README' } }]),
      usuario('Another Claude session sent a message:\n<agent-message from="acc35">\nYa está.\n</agent-message>', {
        isMeta: true
      })
    ]);
    expect(c.items.map((i) => (i.tipo === 'mensaje' ? [i.de, i.para, i.texto] : i.tipo))).toEqual([
      ['', 'acc35', 'Arreglá el README'],
      ['acc35', '', 'Ya está.']
    ]);
  });

  it('descarta lo que inyecta Claude Code y resume las notificaciones de tareas', () => {
    const c = parseConversacion([
      usuario('<system-reminder>x</system-reminder>'),
      usuario('<command-name>/clear</command-name>'),
      usuario('<task-notification>\n<status>completed</status>\n<summary>Terminó el build</summary>\n</task-notification>')
    ]);
    expect(c.items).toEqual([{ tipo: 'aviso', texto: 'Terminó el build', ts: '2026-09-24T12:00:00Z' }]);
  });
});

describe('parseConversacion: compactación', () => {
  it('el resumen de compactación es un aviso, no un mensaje tuyo', () => {
    const c = parseConversacion([usuario('This session is being continued…', { isCompactSummary: true })]);
    expect(c.items.map((i) => i.tipo)).toEqual(['aviso']);
  });
});

describe('mensajesRecientes', () => {
  it('sólo cuenta los de los últimos segundos', () => {
    const ahora = Date.parse('2026-09-24T12:00:05Z');
    const viejo = linea({
      type: 'assistant',
      timestamp: '2026-09-24T11:00:00Z',
      message: { content: [{ type: 'tool_use', id: 'x', name: 'SendMessage', input: { to: 'b' } }] }
    });
    const nuevo = asistente([{ type: 'tool_use', id: 'y', name: 'SendMessage', input: { to: 'c' } }]);
    expect(mensajesRecientes([viejo, nuevo], ahora)).toEqual([{ de: '', para: 'c' }]);
  });
});

describe('rutas', () => {
  it('arma el slug como Claude Code', () => {
    expect(slugDe('C:\\Users\\WPOSS\\Downloads\\Remoto')).toBe('C--Users-WPOSS-Downloads-Remoto');
  });
  it('rechaza un id de subagente que se sale de la carpeta', () => {
    expect(() => rutaSubagente('C:/p/s.jsonl', '../../x')).toThrow();
  });
});

describe('mismoInicio', () => {
  it('confirma el pid sólo si arrancó cuando dice el registro', () => {
    expect(mismoInicio('134347402767412292', '134347402767410000')).toBe(true); // redondeo de CIM
    expect(mismoInicio('134347402767412292', '134347502767412292')).toBe(false); // pid reciclado
    expect(mismoInicio(undefined, '1')).toBe(false);
    expect(mismoInicio('basura', '1')).toBe(false);
  });
});
