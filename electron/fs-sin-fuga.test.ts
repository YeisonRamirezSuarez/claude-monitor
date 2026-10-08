// electron/fs-sin-fuga.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Reemplaza `readFileSync` y `existsSync` en el `fs` compartido de todo el
// proceso: se guardan los originales y se restauran al terminar.
const { readFileSync, existsSync } = fs;
createRequire(import.meta.url)('../vendor/pixel-agents/fs-sin-fuga.cjs');
afterAll(() => Object.assign(fs, { readFileSync, existsSync }));

const dir = mkdtempSync(join(tmpdir(), 'fuga-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const archivo = join(dir, 'agent.meta.json');
writeFileSync(archivo, '{"agentType":"ñandú"}');

describe('fs-sin-fuga', () => {
  it('reemplaza las dos funciones que pierden memoria', () => {
    expect(fs.readFileSync).not.toBe(readFileSync);
    expect(fs.existsSync).not.toBe(existsSync);
  });

  it('readFileSync con utf8 devuelve el mismo texto, como sea que se pida', () => {
    expect(fs.readFileSync(archivo, 'utf8')).toBe('{"agentType":"ñandú"}');
    expect(fs.readFileSync(archivo, 'utf-8')).toBe('{"agentType":"ñandú"}');
    expect(fs.readFileSync(archivo, { encoding: 'utf-8', flag: 'r' })).toBe('{"agentType":"ñandú"}');
  });

  it('readFileSync sin utf8 se comporta como siempre', () => {
    expect(Buffer.isBuffer(fs.readFileSync(archivo))).toBe(true);
    expect(fs.readFileSync(archivo, 'base64')).toBe(readFileSync(archivo, 'base64'));
    expect(() => fs.readFileSync(join(dir, 'no-existe'), 'utf8')).toThrow(/ENOENT/);
  });

  it('existsSync dice lo mismo que el original', () => {
    expect(fs.existsSync(archivo)).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(join(dir, 'no-existe'))).toBe(false);
    expect(fs.existsSync(undefined as unknown as string)).toBe(false);
  });
});
