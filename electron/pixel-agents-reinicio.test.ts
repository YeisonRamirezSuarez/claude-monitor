// electron/pixel-agents-reinicio.test.ts
// El servidor de Pixel Agents que se cae solo (falta de memoria a las 34 h) se
// relanza; el que se para a propósito, no; y nunca hay dos a la vez.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Un servidor de mentira: lo que `spawn` devuelve, más `listo` para imprimir lo que imprime el real al servir la página. */
type Hijo = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; listo(puerto: number): void };
const { hijos } = vi.hoisted(() => ({ hijos: [] as unknown[] }));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const h = new EventEmitter() as Hijo;
    Object.assign(h, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => {
        queueMicrotask(() => h.emit('exit', null));
        return true;
      }),
      listo: (puerto: number) => h.stdout.emit('data', Buffer.from(`server running at http://127.0.0.1:${puerto}/?token=t`))
    });
    hijos.push(h);
    return h;
  })
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'C:/app' } }));
vi.mock('./registro', () => ({ anotar: vi.fn() }));

const servidores = () => hijos as Hijo[];
const soltar = () => vi.advanceTimersByTimeAsync(0);

async function modulo() {
  vi.resetModules();
  return import('./pixel-agents');
}

beforeEach(() => {
  hijos.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** Arranca el servidor y lo deja sirviendo en el puerto 1000. */
async function arrancado() {
  const m = await modulo();
  const p = m.urlOficina();
  await soltar();
  servidores()[0].listo(1000);
  expect(await p).toContain(':1000/');
  return m;
}

describe('servidor de Pixel Agents', () => {
  it('si se cae solo, se relanza a los 3 s y la URL nueva es la del servidor nuevo', async () => {
    const m = await arrancado();
    servidores()[0].emit('exit', 3758096392);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(servidores()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(servidores()).toHaveLength(2);
    servidores()[1].listo(2000);
    expect(await m.urlOficina()).toContain(':2000/');
  });

  it('mientras espera el reinicio, pedir la URL no lanza otro servidor', async () => {
    // La oficina pregunta cada 1,5 s: si cada pregunta relanzara, un servidor
    // que muere al arrancar giraría sin freno y sin respetar la espera.
    const m = await arrancado();
    servidores()[0].emit('exit', 1);
    await expect(m.urlOficina()).rejects.toThrow(/reinicia/);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(m.urlOficina()).rejects.toThrow();
    expect(servidores()).toHaveLength(1);
  });

  it('si vuelve a caer enseguida, espera más: 6 s la segunda vez', async () => {
    const m = await arrancado();
    servidores()[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(servidores()).toHaveLength(2);
    servidores()[1].emit('exit', 1); // murió al arrancar
    await vi.advanceTimersByTimeAsync(5_999);
    expect(servidores()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(servidores()).toHaveLength(3);
    servidores()[2].listo(3000);
    expect(await m.urlOficina()).toContain(':3000/');
  });

  it('el que para la app a propósito no se relanza', async () => {
    const m = await arrancado();
    m.detenerOficina();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(servidores()[0].kill).toHaveBeenCalled();
    expect(servidores()).toHaveLength(1);
  });

  it('parar la app durante la espera cancela el reinicio', async () => {
    const m = await arrancado();
    servidores()[0].emit('exit', 1);
    m.detenerOficina();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(servidores()).toHaveLength(1);
  });

  it('uno que nunca dice que está listo se mata a los 30 s y se relanza', async () => {
    const m = await modulo();
    const p = m.urlOficina();
    p.catch(() => {});
    await soltar();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).rejects.toThrow(/30 s/);
    expect(servidores()[0].kill).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(servidores()).toHaveLength(2);
  });

  it('si no se pudo ni lanzar (error sin exit) tambien se relanza', async () => {
    await arrancado();
    servidores()[0].emit('error', new Error('ENOENT'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(servidores()).toHaveLength(2);
  });
});
