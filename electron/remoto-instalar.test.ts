import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { conHook, sinHook, instalarHook, sacarHook, hayNode } from './remoto-instalar';

const CMD = 'node "C:/x/remoto-hook.js"';

describe('conHook / sinHook', () => {
  it('agrega los cuatro eventos sin tocar los hooks ajenos', () => {
    const raw = JSON.stringify({ model: 'opus', hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'otro' }] }] } });
    const s = JSON.parse(conHook(raw, CMD)!);
    expect(s.model).toBe('opus');
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('otro');
    expect(s.hooks.PreToolUse).toEqual([{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CMD, timeout: 86400 }] }]);
    expect(Object.keys(s.hooks).sort()).toEqual(['PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  });
  it('es idempotente', () => {
    const una = conHook('{}', CMD)!;
    expect(conHook(una, CMD)).toBeNull();
  });
  it('sacarlo deja sólo lo ajeno y borra los eventos vacíos', () => {
    const raw = conHook(JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'otro' }] }] } }), CMD)!;
    const s = JSON.parse(sinHook(raw)!);
    expect(s.hooks).toEqual({ Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'otro' }] }] });
  });
  it('un settings.json ilegible no se toca', () => {
    expect(conHook('{roto', CMD)).toBeNull();
    expect(sinHook('{roto')).toBeNull();
  });
  it('elimina solo nuestro comando dentro de un grupo, no el grupo entero', () => {
    // Primero instalar el hook
    const installed = conHook('{}', CMD)!;
    // Luego agregar otro comando ajeno al mismo grupo
    const parsed = JSON.parse(installed);
    // Agregar otro comando ajeno dentro del MISMO matcher group
    parsed.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'otro' });
    const raw = JSON.stringify(parsed);

    // Al sacarlo, debe quedar solo el hook ajeno
    const result = sinHook(raw);
    expect(result).not.toBeNull();
    const s = JSON.parse(result!);
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('otro');
  });
  it('strip BOM antes de parsear', () => {
    const bom = '\ufeff';
    const raw = bom + JSON.stringify({ model: 'opus' });
    const s = JSON.parse(conHook(raw, CMD)!);
    expect(s.model).toBe('opus');
  });
  it('shapefile malformado sin lanzar TypeError', () => {
    // Hooks no es array - conHook lanza error sobre configuración inválida, no TypeError
    const raw1 = JSON.stringify({ hooks: { Stop: 'not an array' } });
    expect(() => conHook(raw1, CMD)).toThrow('No pude leer settings.json');

    // Entry sin hooks - OK, se ignora la entrada
    const raw2 = JSON.stringify({ hooks: { Stop: [{ matcher: '*' }] } });
    expect(() => conHook(raw2, CMD)).not.toThrow();

    // hooks no es array en entrada - sinHook lo ignora sin error
    const raw3 = JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: 'not array' }] } });
    expect(() => sinHook(raw3)).not.toThrow();
  });
  it('camino con espacios en instalarHook', () => {
    const pathWithSpaces = 'C:\\Program Files\\My App\\remoto-hook.js';
    const cmd = `node "${pathWithSpaces.split('\\').join('/')}"`;
    const raw = conHook('{}', cmd)!;
    const s = JSON.parse(raw);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain('remoto-hook.js');
  });
});

describe('editarPozo / instalarHook / sacarHook', () => {
  let tmpDir: string;
  let poolDir: string;
  let syncCalled: boolean;

  beforeEach(async () => {
    const time = Date.now();
    tmpDir = join(tmpdir(), `remoto-test-${time}`);
    poolDir = join(tmpDir, 'pool');
    await mkdir(poolDir, { recursive: true });
    syncCalled = false;
  });

  afterEach(async () => {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('archivo faltante crea uno nuevo', async () => {
    const hookDest = join(tmpDir, 'my-remoto-hook.js');
    const hookSrc = join(__dirname, 'hooks', 'remoto-hook.js');
    await instalarHook(
      hookSrc,
      hookDest,
      () => Promise.resolve(poolDir),
      () => {
        syncCalled = true;
        return Promise.resolve();
      }
    );
    const content = await readFile(join(poolDir, 'settings.json'), 'utf8');
    expect(content).toContain('remoto-hook.js');
    expect(syncCalled).toBe(true);
  });

  it('escritura atómica: no toca el archivo si hay error de lectura (EACCES)', async () => {
    const settingsPath = join(poolDir, 'settings.json');
    await writeFile(settingsPath, '{"model":"opus"}', 'utf8');
    // Mock un error que no sea ENOENT
    const mockRead = async () => {
      const e = new Error('Permission denied');
      (e as any).code = 'EACCES';
      throw e;
    };
    const hookDest = join(tmpDir, 'dest-hook.js');
    await expect(
      (instalarHook as any)(
        'electron/hooks/remoto-hook.js',
        hookDest,
        () => Promise.resolve(poolDir),
        () => Promise.resolve(),
        mockRead
      )
    ).rejects.toThrow('Permission denied');
    // El archivo debe quedar igual
    const content = await readFile(settingsPath, 'utf8');
    expect(content).toBe('{"model":"opus"}');
  });

  it('JSON no parseable lanza con mensaje claro', async () => {
    const settingsPath = join(poolDir, 'settings.json');
    await writeFile(settingsPath, '{roto', 'utf8');
    await expect(
      sacarHook(
        () => Promise.resolve(poolDir),
        () => Promise.resolve()
      )
    ).rejects.toThrow('No pude leer settings.json');
    // El archivo debe quedar igual
    const content = await readFile(settingsPath, 'utf8');
    expect(content).toBe('{roto');
  });

  it('BOM + válido se instala sin problemas', async () => {
    const settingsPath = join(poolDir, 'settings.json');
    const bom = '\ufeff';
    await writeFile(settingsPath, bom + JSON.stringify({ model: 'opus' }), 'utf8');
    await instalarHook(
      'electron/hooks/remoto-hook.js',
      join(tmpDir, 'dest-hook.js'),
      () => Promise.resolve(poolDir),
      () => Promise.resolve()
    );
    const content = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(content.replace(/^\ufeff/, ''));
    expect(parsed.hooks.PreToolUse).toBeDefined();
  });

  it('null entry en hooks no lanza TypeError', () => {
    const raw = JSON.stringify({ hooks: { Stop: [null] } });
    expect(() => sinHook(raw)).not.toThrow();
    expect(() => conHook(raw, CMD)).not.toThrow();
  });

  it('null inner hook no lanza TypeError', () => {
    const raw = JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [null] }] } });
    expect(() => sinHook(raw)).not.toThrow();
  });

  it('foreign string event value se preserva o lanza error', async () => {
    const settingsPath = join(poolDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ hooks: { Stop: 'custom-value' } }), 'utf8');
    
    const hookSrc = join(__dirname, 'hooks', 'remoto-hook.js');
    await expect(
      instalarHook(
        hookSrc,
        join(tmpDir, 'dest-hook.js'),
        () => Promise.resolve(poolDir),
        () => Promise.resolve()
      )
    ).rejects.toThrow('No pude leer settings.json');
    
    const content = await readFile(settingsPath, 'utf8');
    expect(content).toBe(JSON.stringify({ hooks: { Stop: 'custom-value' } }));
  });

  it('hooks como array/string lanza error', async () => {
    const settingsPath = join(poolDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ hooks: [] }), 'utf8');
    const hookSrc = join(__dirname, 'hooks', 'remoto-hook.js');
    await expect(
      instalarHook(
        hookSrc,
        join(tmpDir, 'dest-hook.js'),
        () => Promise.resolve(poolDir),
        () => Promise.resolve()
      )
    ).rejects.toThrow('No pude leer settings.json');
    
    const content = await readFile(settingsPath, 'utf8');
    expect(content).toBe(JSON.stringify({ hooks: [] }));
  });
});

// Final review M10: el hook es `node "…"`; sin Node en el PATH, Claude Code lo corre y falla en cada evento.
describe('hayNode', () => {
  it('ve el node del PATH y no ve un comando que no existe', async () => {
    expect(await hayNode()).toBe(true);
    expect(await hayNode('no-existe-este-comando-xyz')).toBe(false);
  });
});
