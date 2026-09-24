import { describe, expect, it } from 'vitest';
import { dondeEstaAbierta, lateTodavia, parseSesionViva, TTL_LATIDO_MS } from './liveness';

// Una entrada real de `~/.claude/sessions/<pid>.json`, recortada a los campos
// que se usan. Trae bastantes más (`bridgeSessionId`, `peerProtocol`, `name`…).
const REAL = JSON.stringify({
  sessionId: '7b1af19f-9259-4a5a-bc85-7caf9ebccd95',
  pid: 19512,
  kind: 'interactive',
  entrypoint: 'cli',
  cwd: 'C:\\Users\\WPOSS\\proy',
  pidDomain: 'win32:wpobuc259',
  procStart: 134332910978356756,
  startedAt: 1788817500565,
  updatedAt: 1788818080684,
  status: 'idle',
  name: 'algo'
});

describe('parseSesionViva', () => {
  it('saca lo que hace falta de una entrada real', () => {
    const e = parseSesionViva(REAL);
    expect(e).toMatchObject({
      sessionId: '7b1af19f-9259-4a5a-bc85-7caf9ebccd95',
      pid: 19512,
      entrypoint: 'cli',
      pidDomain: 'win32:wpobuc259'
    });
  });

  // Adentro de `sessions/` hay `.key` y lo que el día de mañana se les ocurra:
  // un archivo que no se entiende se ignora, no tumba el panel.
  it('lo que no se entiende devuelve null, no lanza', () => {
    expect(parseSesionViva('no soy json')).toBeNull();
    expect(parseSesionViva('null')).toBeNull();
    expect(parseSesionViva('[]')).toBeNull();
    expect(parseSesionViva('{"pid":123}')).toBeNull();
    expect(parseSesionViva('{"sessionId":"x"}')).toBeNull();
  });

  it('un pid que no es un pid no cuenta', () => {
    expect(parseSesionViva('{"sessionId":"x","pid":0}')).toBeNull();
    expect(parseSesionViva('{"sessionId":"x","pid":-3}')).toBeNull();
    expect(parseSesionViva('{"sessionId":"x","pid":"19512"}')).toBeNull();
  });
});

describe('lateTodavia', () => {
  const base = { sessionId: 'x', pid: 1 };

  it('un latido reciente cuenta', () => {
    expect(lateTodavia({ ...base, updatedAt: 1000 }, 1000 + TTL_LATIDO_MS - 1)).toBe(true);
  });

  it('pasado el TTL ya no', () => {
    expect(lateTodavia({ ...base, updatedAt: 1000 }, 1000 + TTL_LATIDO_MS)).toBe(false);
  });

  // Caso real: una entrada de un proceso que murió hace 78.500 s. En una
  // máquina con uso hay varias así, y contarlas como vivas bloquearía todo.
  it('la entrada de un proceso muerto hace horas no cuenta', () => {
    expect(lateTodavia({ ...base, updatedAt: 1788818080684 }, 1788896580684)).toBe(false);
  });

  it('sin updatedAt vale startedAt, igual que en Desktop', () => {
    expect(lateTodavia({ ...base, startedAt: 5000 }, 5000 + 1000)).toBe(true);
    expect(lateTodavia({ ...base, startedAt: 5000 }, 5000 + TTL_LATIDO_MS)).toBe(false);
  });

  it('sin ninguno de los dos la entrada no dice nada', () => {
    expect(lateTodavia(base, Date.now())).toBe(false);
  });
});

describe('dondeEstaAbierta', () => {
  // El punto del mensaje es que el usuario sepa QUÉ cerrar.
  it('nombra la ventana, no el entrypoint crudo', () => {
    expect(dondeEstaAbierta({ sessionId: 'x', pid: 1, entrypoint: 'claude-desktop' })).toBe(
      'Claude Desktop'
    );
    expect(dondeEstaAbierta({ sessionId: 'x', pid: 1, entrypoint: 'cli' })).toBe('una terminal');
  });

  it('un entrypoint nuevo no rompe el mensaje', () => {
    expect(dondeEstaAbierta({ sessionId: 'x', pid: 1, entrypoint: 'lo-que-venga' })).toBe(
      'otro Claude Code'
    );
    expect(dondeEstaAbierta({ sessionId: 'x', pid: 1 })).toBe('otro Claude Code');
  });
});
