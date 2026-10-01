// electron/oficina.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Profile } from '../shared/types';
import { actividadDe, agentesVivos, estadoDe, mensajesRecientes, iniciosEnCache, mismoInicio, parseConversacion, rutaSubagente, slugDe, statusEfectivo, transcriptReciente } from './oficina';

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
    expect(a).toEqual({ tipo: 'escribiendo', herramienta: 'Bash', detalle: 'Corre los tests', estresado: false });
  });

  it('estresado: 3 herramientas fallando seguidas, o un error de la API; se le pasa con la primera que anda', () => {
    const intento = (id: string, error: boolean) => [
      asistente([{ type: 'tool_use', id, name: 'Bash', input: {} }]),
      usuario([{ type: 'tool_result', tool_use_id: id, content: error ? 'Exit code 1' : 'ok', is_error: error }])
    ];
    const dos = [...intento('a', true), ...intento('b', true)];
    expect(actividadDe(dos).estresado).toBe(false);
    expect(actividadDe([...dos, ...intento('c', true)]).estresado).toBe(true);
    expect(actividadDe([...dos, ...intento('c', true), ...intento('d', false)]).estresado).toBe(false);
    const api = asistente([{ type: 'text', text: 'API Error: 529 Overloaded' }], { isApiErrorMessage: true });
    expect(actividadDe([usuario('seguí'), api]).estresado).toBe(true);
    expect(actividadDe([usuario('seguí'), api, usuario('otra vez')]).estresado).toBe(false);
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

describe('statusEfectivo', () => {
  const ahora = 1_000_000;
  it('respeta el status del registro si lo hay', () => {
    expect(statusEfectivo('busy', ahora - 60_000, ahora)).toBe('busy');
    expect(statusEfectivo('idle', ahora, ahora)).toBe('idle');
  });
  it('sin status (motor de Desktop): callado 15 s o más es idle, si no busy', () => {
    expect(statusEfectivo(undefined, ahora - 15_000, ahora)).toBe('idle');
    expect(statusEfectivo(undefined, ahora - 14_999, ahora)).toBe('busy');
  });
  it('sin status ni transcript no se inventa nada', () => {
    expect(statusEfectivo(undefined, null, ahora)).toBeUndefined();
  });
  it('con una herramienta pendiente espera 3 min antes de darla por quieta (un build largo no es un permiso)', () => {
    expect(statusEfectivo(undefined, ahora - 60_000, ahora, true)).toBe('busy');
    expect(statusEfectivo(undefined, ahora - 179_999, ahora, true)).toBe('busy');
    expect(statusEfectivo(undefined, ahora - 180_000, ahora, true)).toBe('idle');
    expect(statusEfectivo(undefined, ahora - 60_000, ahora, false)).toBe('idle');
  });
});

describe('transcriptReciente', () => {
  it('corta a los 7 días', () => {
    const ahora = 10 * 86_400_000;
    expect(transcriptReciente(ahora - 6 * 86_400_000, ahora)).toBe(true);
    expect(transcriptReciente(ahora - 8 * 86_400_000, ahora)).toBe(false);
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

// De punta a punta sobre carpetas de mentira: el registro de sesiones vivas del
// pozo, el almacén de Desktop (LOCALAPPDATA) y los transcripts.
describe('agentesVivos: sesiones de Desktop', () => {
  let tmp = '';
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const ahora = Date.now();
  const CWD = 'C:\\proy\\app';
  const ID = '11111111-1111-4111-8111-111111111111';

  async function armar() {
    tmp = await mkdtemp(join(tmpdir(), 'oficina-'));
    vi.stubEnv('LOCALAPPDATA', join(tmp, 'local'));
    const perfiles: Profile[] = [
      { id: 'default', name: 'Cuenta principal', configDir: join(tmp, 'pozo'), isDefault: true },
      { id: 'aaaa1111', name: 'personal', configDir: join(tmp, 'personal'), isDefault: false }
    ];
    await mkdir(join(tmp, 'pozo', 'sessions'), { recursive: true });
    return perfiles;
  }
  /** La entrada que deja el motor de Desktop: vive en el `sessions/` del pozo y no trae `status`. */
  const registrar = (pid: number, extra: Record<string, unknown> = {}) =>
    writeFile(
      join(tmp, 'pozo', 'sessions', `${pid}.json`),
      JSON.stringify({ pid, sessionId: ID, cwd: CWD, entrypoint: 'claude-desktop', updatedAt: ahora - 1000, ...extra })
    );
  async function transcript(sessionId = ID, edadMs = 60_000) {
    const dir = join(tmp, 'pozo', 'projects', slugDe(CWD));
    await mkdir(dir, { recursive: true });
    const ruta = join(dir, `${sessionId}.jsonl`);
    await writeFile(ruta, [usuario('hola'), asistente([{ type: 'text', text: 'Listo.' }])].join('\n'));
    const t = new Date(ahora - edadMs);
    await utimes(ruta, t, t);
    return ruta;
  }
  async function enAlmacen(perfil: string, cli: string, extra: Record<string, unknown> = {}) {
    const dir = join(tmp, 'local', 'claude-monitor', 'desktop', perfil, 'claude-code-sessions', 'cta', 'org');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `local_${cli}.json`),
      JSON.stringify({ sessionId: `local_${cli}`, cliSessionId: cli, cwd: CWD, title: 'Migrar Angular', isArchived: false, ...extra })
    );
  }

  it('una sesión de Desktop es de la cuenta dueña de su almacén, no de la que tiene el registro', async () => {
    const perfiles = await armar();
    await registrar(101);
    await transcript();
    await enAlmacen('aaaa1111', ID);
    const [a, ...resto] = await agentesVivos(perfiles, ahora);
    expect(resto).toEqual([]);
    expect(a).toMatchObject({ sessionId: ID, profileId: 'aaaa1111', profileName: 'personal', origen: 'desktop' });
  });

  it('el título de Desktop es el nombre si el registro no trae ninguno, y si trae, gana el del registro', async () => {
    const perfiles = await armar();
    await registrar(101);
    await transcript();
    await enAlmacen('aaaa1111', ID);
    expect((await agentesVivos(perfiles, ahora))[0].nombre).toBe('Migrar Angular');
    await registrar(101, { name: 'del registro' });
    expect((await agentesVivos(perfiles, ahora))[0].nombre).toBe('del registro');
  });

  it('si Desktop no la conoce queda como hasta ahora, en la cuenta del registro', async () => {
    const perfiles = await armar();
    await registrar(101);
    await transcript();
    expect((await agentesVivos(perfiles, ahora))[0]).toMatchObject({ profileId: 'default', nombre: 'app', origen: 'desktop' });
  });

  it('una sesión de terminal no cambia de cuenta aunque su id figure en un almacén', async () => {
    const perfiles = await armar();
    await registrar(101, { entrypoint: 'cli' });
    await transcript();
    await enAlmacen('aaaa1111', ID);
    expect((await agentesVivos(perfiles, ahora))[0]).toMatchObject({ profileId: 'default', origen: 'terminal' });
  });

  it('sin status en el registro el estado sale de cuánto hace que se escribió el transcript', async () => {
    const perfiles = await armar();
    await registrar(101);
    await transcript(ID, 60_000);
    expect((await agentesVivos(perfiles, ahora))[0].estado).toBe('esperando');
    await transcript(ID, 2_000);
    expect((await agentesVivos(perfiles, ahora))[0].estado).toBe('pensando');
  });

  it('el motor pausado por inactividad sigue en la oficina, esperando', async () => {
    const perfiles = await armar();
    const ruta = await transcript(ID, 40 * 60_000); // sin registro: Desktop pausó el motor
    await enAlmacen('aaaa1111', ID);
    const [a, ...resto] = await agentesVivos(perfiles, ahora);
    expect(resto).toEqual([]);
    expect(a).toMatchObject({
      sessionId: ID,
      profileId: 'aaaa1111',
      profileName: 'personal',
      nombre: 'Migrar Angular',
      cwd: CWD,
      origen: 'desktop',
      estado: 'esperando',
      transcript: ruta,
      subagentes: [],
      mensajes: []
    });
  });

  it('sin registro pero escrita hace segundos no está pausada: trabaja (no descansa en la oficina)', async () => {
    const perfiles = await armar();
    await transcript(ID, 3_000); // el motor anota en un sessions/ que la app no mira
    await enAlmacen('aaaa1111', ID);
    expect((await agentesVivos(perfiles, ahora))[0]).toMatchObject({ origen: 'desktop', estado: 'pensando' });
  });

  it('la que tiene motor vivo no se duplica como pausada', async () => {
    const perfiles = await armar();
    await registrar(101);
    await transcript();
    await enAlmacen('aaaa1111', ID);
    expect(await agentesVivos(perfiles, ahora)).toHaveLength(1);
  });

  it('no muestra las archivadas, las viejas, las sin transcript ni las de una cuenta que el panel no tiene', async () => {
    const perfiles = await armar();
    const [B, C, D, E] = ['2', '3', '4', '5'].map((n) => n.repeat(8) + `-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`);
    await transcript(ID, 60_000);
    await transcript(B, 60_000);
    await transcript(C, 30 * 24 * 3600_000);
    await transcript(E, 60_000);
    await enAlmacen('aaaa1111', ID, { isArchived: true });
    await enAlmacen('aaaa1111', B, { title: 'Sí' });
    await enAlmacen('aaaa1111', C);
    await enAlmacen('aaaa1111', D); // sin transcript
    await enAlmacen('zzzz9999', E); // no hay cuenta con ese id
    expect((await agentesVivos(perfiles, ahora)).map((a) => a.nombre)).toEqual(['Sí']);
  });

  it('una cuenta de WSL no aporta sesiones pausadas', async () => {
    const perfiles = await armar();
    perfiles[1].entorno = { tipo: 'wsl', distro: 'Ubuntu', home: '/home/u' };
    await transcript();
    await enAlmacen('aaaa1111', ID);
    expect(await agentesVivos(perfiles, ahora)).toEqual([]);
  });
});

describe('iniciosEnCache', () => {
  const mapa = new Map([[7, '133000000000000000']]);
  const cache = { en: 1_000, pids: '7', mapa };

  it('devuelve el mapa cacheado dentro del TTL para la misma clave', () => {
    expect(iniciosEnCache(cache, '7', 2_000, false)).toBe(mapa);
  });
  it('ni otra clave ni un TTL vencido ni un caché vacío lo reusan', () => {
    expect(iniciosEnCache(cache, '7,8', 2_000, false)).toBeNull();
    expect(iniciosEnCache(cache, '7', 1_000 + 15_000, false)).toBeNull();
    expect(iniciosEnCache(null, '7', 2_000, false)).toBeNull();
  });
  it('sinCache se salta el caché aunque esté vigente (matar necesita el inicio de ahora)', () => {
    expect(iniciosEnCache(cache, '7', 2_000, true)).toBeNull();
  });
});
