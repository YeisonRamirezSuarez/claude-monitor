// electron/equipo.test.ts
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { equipoDe } from './oficina';
import { leerNombres, nombrar } from './nombres';

const linea = (o: unknown) => JSON.stringify(o);
const SESION = '11111111-2222-3333-4444-555555555555';

async function subagente(dir: string, id: string, lineas: string[], meta: object, haceMs: number) {
  const ruta = join(dir, `agent-${id}.jsonl`);
  await writeFile(ruta, lineas.join('\n'));
  await writeFile(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
  const t = new Date(Date.now() - haceMs);
  await utimes(ruta, t, t);
}

describe('equipoDe', () => {
  it('lista a todos, primero los que corren, con su tarea y el tool_use que los lanzó', async () => {
    const raiz = await mkdtemp(join(tmpdir(), 'equipo-'));
    const dir = join(raiz, SESION, 'subagents');
    await mkdir(dir, { recursive: true });
    const trabajando = [linea({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }] } })];
    const termino = [linea({ type: 'assistant', message: { content: [{ type: 'text', text: 'Listo, todo pasa.' }] } })];
    await subagente(dir, 'viejo', termino, { agentType: 'Explore', description: 'Buscar usos', toolUseId: 'tu1' }, 10 * 60_000);
    await subagente(dir, 'activo', trabajando, { agentType: 'general-purpose', description: 'Correr tests', toolUseId: 'tu2' }, 1000);

    const equipo = await equipoDe(join(raiz, `${SESION}.jsonl`));

    expect(equipo.map((s) => [s.agentId, s.estado, s.descripcion, s.toolUseId])).toEqual([
      ['activo', 'escribiendo', 'Correr tests', 'tu2'],
      ['viejo', 'terminado', 'Buscar usos', 'tu1']
    ]);
  });

  it('suma los agentes de un Workflow, con su fase, y los da por terminados con su result', async () => {
    const raiz = await mkdtemp(join(tmpdir(), 'equipo-'));
    const run = join(raiz, SESION, 'subagents', 'workflows', 'wf_1');
    await mkdir(run, { recursive: true });
    const trabajando = [linea({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } })];
    await subagente(run, 'w1', trabajando, { agentType: 'workflow-subagent', description: 'inventory:sales', workflowPhase: 'Inventory' }, 60_000);
    await subagente(run, 'w2', trabajando, { agentType: 'workflow-subagent', description: 'audit:products', workflowPhase: 'Audit' }, 1000);
    await writeFile(join(run, 'journal.jsonl'), [linea({ type: 'started', agentId: 'w1' }), linea({ type: 'started', agentId: 'w2' }), linea({ type: 'result', agentId: 'w1', result: {} })].join('\n') + '\n');

    const equipo = await equipoDe(join(raiz, `${SESION}.jsonl`));

    expect(equipo.map((s) => [s.descripcion, s.estado, s.tipoAgente, s.toolUseId])).toEqual([
      ['audit:products', 'leyendo', 'workflow · Audit', 'wf:wf_1:w2'],
      ['inventory:sales', 'terminado', 'workflow · Inventory', 'wf:wf_1:w1']
    ]);
  });

  it('una sesión sin subagentes tiene el equipo vacío', async () => {
    const raiz = await mkdtemp(join(tmpdir(), 'equipo-'));
    expect(await equipoDe(join(raiz, `${SESION}.jsonl`))).toEqual([]);
  });
});

describe('nombres', () => {
  beforeEach(async () => {
    process.env.APPDATA = await mkdtemp(join(tmpdir(), 'nombres-'));
  });

  it('guarda, lee y borra el nombre de una sesión y de un subagente', async () => {
    await nombrar(SESION, '  Migración  ', 'Pasa la base a Postgres');
    await nombrar(`${SESION}/a4f2369`, 'Revisor', '');
    expect(await leerNombres()).toEqual({
      [SESION]: { nombre: 'Migración', nota: 'Pasa la base a Postgres' },
      [`${SESION}/a4f2369`]: { nombre: 'Revisor', nota: '' }
    });
    await nombrar(SESION, '', '');
    expect(Object.keys(await leerNombres())).toEqual([`${SESION}/a4f2369`]);
  });

  it('rechaza claves que no son de un agente', async () => {
    await expect(nombrar('../../etc', 'x', '')).rejects.toThrow();
  });
});
