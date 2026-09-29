// electron/tomar.test.ts
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { argsTurno, matarSiEsElMismo, textosDe, Tomador } from './tomar';
import { iniciosDeProceso } from './oficina';

// Sólo se pisa la consulta a PowerShell: `mismoInicio` es la de verdad.
vi.mock('./oficina', async (original) => ({ ...(await original<typeof import('./oficina')>()), iniciosDeProceso: vi.fn() }));

const ID = '3f2b8c1e-9a4d-4e7b-8c55-0d1f2a3b4c5d';
const tick = () => new Promise((r) => setTimeout(r, 0));
const lineaTexto = (texto: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: texto }] } }) + '\n';

describe('argsTurno', () => {
  it('reanuda sin terminal, con Chrome y salida por líneas; el mensaje no va en los args', () => {
    expect(argsTurno(ID)).toEqual(['-p', '--chrome', '--resume', ID, '--output-format', 'stream-json', '--verbose']);
  });
  it('rechaza un id que no es UUID: con shell:true iría directo a cmd.exe', () => {
    expect(() => argsTurno('x & calc')).toThrow('Id de sesión inválido.');
    expect(() => argsTurno('abc')).toThrow('Id de sesión inválido.');
    expect(() => argsTurno(`${ID} & calc`)).toThrow('Id de sesión inválido.');
  });
});

describe('textosDe', () => {
  it('saca el texto del asistente y nada más', () => {
    const l = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hola' }, { type: 'tool_use', name: 'Bash' }] } });
    expect(textosDe(l)).toEqual(['Hola']);
    expect(textosDe(JSON.stringify({ type: 'system' }))).toEqual([]);
    expect(textosDe('no es json')).toEqual([]);
  });
});

describe('Tomador', () => {
  function armar(quieta = true) {
    const lanzados: Array<{
      args: string[];
      env: NodeJS.ProcessEnv;
      entrada: string;
      salida: PassThrough;
      terminar: (c: number) => void;
      matar: ReturnType<typeof vi.fn>;
    }> = [];
    const d = {
      registro: vi.fn(async () => ({ pid: 77, procStart: '1', configDir: 'C:/cfg', cwd: 'C:/repo', quieta })),
      matar: vi.fn(async () => {}),
      lanzar: vi.fn((args: string[], op: { cwd: string; env: NodeJS.ProcessEnv; entrada: string }) => {
        const salida = new PassThrough();
        let terminar!: (c: number) => void;
        const fin = new Promise<number>((r) => (terminar = r));
        const matar = vi.fn();
        lanzados.push({ args, env: op.env, entrada: op.entrada, salida, terminar, matar });
        return { stdout: salida, fin, matar };
      }),
      alTexto: vi.fn(),
      alError: vi.fn()
    };
    return { t: new Tomador(d), d, lanzados };
  }

  it('la primera vez cierra el claude de la terminal; después sólo manda turnos', async () => {
    const { t, d, lanzados } = armar();
    const p1 = t.enviar(ID, 'uno');
    await tick();
    expect(d.matar).toHaveBeenCalledWith(77, '1');
    expect(lanzados[0].env.CLAUDE_MONITOR_TOMADA).toBe('1');
    expect(lanzados[0].env.CLAUDE_CONFIG_DIR).toBe('C:/cfg');
    lanzados[0].salida.end(lineaTexto('Hecho'));
    lanzados[0].terminar(0);
    await p1;
    expect(d.alTexto).toHaveBeenCalledWith(ID, 'Hecho');
    await Promise.all([t.enviar(ID, 'dos'), (async () => {
      await tick();
      lanzados[1].salida.end();
      lanzados[1].terminar(0);
    })()]);
    expect(d.matar).toHaveBeenCalledTimes(1);
    expect(t.tomadas()).toEqual([ID]);
  });

  it('el mensaje viaja por stdin (entrada) y nunca en los args', async () => {
    const { t, lanzados } = armar();
    const p = t.enviar(ID, 'corré "npm test" & echo %PATH% | más');
    await tick();
    expect(lanzados[0].entrada).toBe('corré "npm test" & echo %PATH% | más');
    expect(lanzados[0].args).toEqual(argsTurno(ID));
    lanzados[0].salida.end();
    lanzados[0].terminar(0);
    await p;
  });

  it('no corre dos turnos a la vez sobre la misma sesión', async () => {
    const { t, lanzados } = armar();
    const p1 = t.enviar(ID, 'uno');
    const p2 = t.enviar(ID, 'dos');
    await tick();
    expect(lanzados).toHaveLength(1);
    lanzados[0].salida.end();
    lanzados[0].terminar(0);
    await p1;
    await tick();
    expect(lanzados).toHaveLength(2);
    lanzados[1].salida.end();
    lanzados[1].terminar(0);
    await p2;
  });

  // Final review M3 (spec §10): un turno que falla suelta la toma; la sesión no se toca más.
  it('un turno que sale con error se avisa y suelta la toma', async () => {
    const { t, d, lanzados } = armar();
    const p = t.enviar(ID, 'uno');
    await tick();
    lanzados[0].salida.end();
    lanzados[0].terminar(1);
    await p;
    expect(d.alError).toHaveBeenCalledWith(ID, expect.stringContaining('1'));
    expect(t.tomadas()).toEqual([]);
  });

  // Final review I2: ocupada mientras la cola de la sesión no terminó (Reanudar/Reabrir se niegan).
  it('ocupada mientras hay un turno en curso o en cola', async () => {
    const { t, lanzados } = armar();
    expect(t.ocupada(ID)).toBe(false);
    const p = t.enviar(ID, 'uno');
    expect(t.ocupada(ID)).toBe(true);
    await tick();
    lanzados[0].salida.end();
    lanzados[0].terminar(0);
    await p;
    await tick();
    expect(t.ocupada(ID)).toBe(false);
  });

  // Final review I2: la tomada volvió a correr afuera (otro pid): nunca un `-p` encima de un proceso vivo.
  it('si la tomada corre de nuevo afuera, pasa por la toma normal: quieta se cierra, trabajando no se toca', async () => {
    const { t, d, lanzados } = armar();
    const p1 = t.enviar(ID, 'uno');
    await tick();
    lanzados[0].salida.end();
    lanzados[0].terminar(0);
    await p1;
    d.registro.mockResolvedValueOnce({ pid: 88, procStart: '2', configDir: 'C:/cfg', cwd: 'C:/repo', quieta: false });
    await t.enviar(ID, 'dos');
    expect(d.alError).toHaveBeenCalledWith(ID, 'La sesión está trabajando: no la tomo.');
    expect(lanzados).toHaveLength(1);
    expect(t.tomadas()).toEqual([]);
    d.registro.mockResolvedValueOnce({ pid: 88, procStart: '2', configDir: 'C:/cfg', cwd: 'C:/repo', quieta: true });
    const p3 = t.enviar(ID, 'tres');
    await tick();
    expect(d.matar).toHaveBeenLastCalledWith(88, '2');
    lanzados[1].salida.end();
    lanzados[1].terminar(0);
    await p3;
  });

  it('si la tomada sigue con el mismo pid (el que se cerró) no se vuelve a matar', async () => {
    const { t, d, lanzados } = armar();
    for (const m of ['uno', 'dos']) {
      const p = t.enviar(ID, m);
      await tick();
      lanzados.at(-1)!.salida.end();
      lanzados.at(-1)!.terminar(0);
      await p;
    }
    expect(d.registro).toHaveBeenCalledTimes(2);
    expect(d.matar).toHaveBeenCalledTimes(1);
  });

  it('una sesión que no está quieta no se toma: ni se mata ni se lanza', async () => {
    const { t, d } = armar(false);
    await t.enviar(ID, 'uno');
    expect(d.matar).not.toHaveBeenCalled();
    expect(d.lanzar).not.toHaveBeenCalled();
    expect(d.alError).toHaveBeenCalledWith(ID, 'La sesión está trabajando: no la tomo.');
    expect(t.tomadas()).toEqual([]);
  });

  it('un id que no es UUID no llega a lanzar (ni a matar la terminal)', async () => {
    const { t, d } = armar();
    await t.enviar('x & calc', 'uno');
    expect(d.registro).not.toHaveBeenCalled();
    expect(d.matar).not.toHaveBeenCalled();
    expect(d.lanzar).not.toHaveBeenCalled();
    expect(d.alError).toHaveBeenCalledWith('x & calc', 'Id de sesión inválido.');
  });

  it('si alTexto tira, mata al hijo y el turno siguiente espera a que termine de verdad', async () => {
    const { t, d, lanzados } = armar();
    d.alTexto.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const p1 = t.enviar(ID, 'uno');
    const p2 = t.enviar(ID, 'dos');
    await tick();
    lanzados[0].salida.write(lineaTexto('Hola'));
    await tick();
    expect(lanzados[0].matar).toHaveBeenCalledTimes(1);
    // El hijo todavía no salió (`fin` sin resolver): el turno 2 no puede arrancar.
    expect(lanzados).toHaveLength(1);
    lanzados[0].terminar(1);
    await p1;
    expect(d.alError).toHaveBeenCalledTimes(1);
    expect(d.alError).toHaveBeenCalledWith(ID, 'boom');
    await tick();
    expect(lanzados).toHaveLength(2);
    lanzados[1].salida.end();
    lanzados[1].terminar(0);
    await p2;
  });
});

describe('matarSiEsElMismo', () => {
  const INICIO = '133000000000000000';
  const kill = () => vi.spyOn(process, 'kill').mockImplementation(() => true);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(iniciosDeProceso).mockReset();
  });

  it('sin procStart no hay forma de confirmar el proceso: no consulta ni mata', async () => {
    const k = kill();
    await expect(matarSiEsElMismo(77)).rejects.toThrow('No puedo confirmar el proceso de esa sesión.');
    expect(iniciosDeProceso).not.toHaveBeenCalled();
    expect(k).not.toHaveBeenCalled();
  });

  it('si el pid ahora es otro proceso (otro inicio), no mata', async () => {
    const k = kill();
    vi.mocked(iniciosDeProceso).mockResolvedValue(new Map([[77, '133000000050000000']]));
    await expect(matarSiEsElMismo(77, INICIO)).rejects.toThrow('El proceso de esa sesión ya no es el que era.');
    expect(k).not.toHaveBeenCalled();
  });

  it('si el pid ya no existe, no mata', async () => {
    const k = kill();
    vi.mocked(iniciosDeProceso).mockResolvedValue(new Map());
    await expect(matarSiEsElMismo(77, INICIO)).rejects.toThrow('El proceso de esa sesión ya no es el que era.');
    expect(k).not.toHaveBeenCalled();
  });

  it('si el inicio coincide mata el pid, y lo confirma con una consulta fresca (sin caché)', async () => {
    const k = kill();
    vi.mocked(iniciosDeProceso).mockResolvedValue(new Map([[77, INICIO]]));
    await matarSiEsElMismo(77, INICIO);
    expect(iniciosDeProceso).toHaveBeenCalledWith([77], expect.any(Number), true);
    expect(k).toHaveBeenCalledTimes(1);
    expect(k).toHaveBeenCalledWith(77);
  });
});
