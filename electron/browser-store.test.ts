// electron/browser-store.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { merge, readRecord, recordPath, vale, writeRecord, type BrowserRecord } from './browser-store';

const AHORA = Date.parse('2026-08-15T00:00:00Z');
const ANTES = AHORA - 3600_000;

const datos = { id: '88eabab9', userDataDir: 'C:\\datos\\88eabab9', displayName: 'Claude · prueba' };
const previo = (session: boolean, extension: boolean): BrowserRecord => ({
  ...datos,
  createdAt: ANTES,
  session: { ok: session, seenAt: ANTES },
  extension: { ok: extension, seenAt: ANTES }
});

describe('merge', () => {
  it('no degrada un estado bueno cuando no se pudo leer (regresión: "falta iniciar sesión" con la sesión puesta)', () => {
    const r = merge(previo(true, true), datos, { ok: false, readable: false }, { ok: false, readable: false }, AHORA);
    expect(vale(r.session)).toBe(true);
    expect(vale(r.extension)).toBe(true);
    expect(r.session?.seenAt).toBe(ANTES); // sigue siendo lo último que se supo
  });

  it('sí cree lo negativo cuando de verdad se pudo mirar: una sesión cerrada tiene que verse', () => {
    const r = merge(previo(true, true), datos, { ok: false, readable: true }, { ok: true, readable: true }, AHORA);
    expect(vale(r.session)).toBe(false);
    expect(r.session?.seenAt).toBe(AHORA);
    expect(vale(r.extension)).toBe(true);
  });

  it('una observación afirmativa actualiza el estado y la fecha', () => {
    const r = merge(previo(false, false), datos, { ok: true, readable: true }, { ok: true, readable: true }, AHORA);
    expect(vale(r.session)).toBe(true);
    expect(r.extension?.seenAt).toBe(AHORA);
  });

  it('sin registro previo y sin poder leer, no inventa nada bueno', () => {
    const r = merge(null, datos, { ok: false, readable: false }, { ok: false, readable: false }, AHORA);
    expect(r.session).toBeNull();
    expect(vale(r.session)).toBe(false);
    expect(r.createdAt).toBe(AHORA);
  });

  it('conserva cuándo se creó la cuenta', () => {
    const r = merge(previo(true, true), datos, { ok: true, readable: true }, { ok: true, readable: true }, AHORA);
    expect(r.createdAt).toBe(ANTES);
  });

  it('anota a qué navegador pertenece la cuenta, para no tener que deducirlo', () => {
    const r = merge(null, datos, { ok: true, readable: true }, { ok: true, readable: true }, AHORA);
    expect(r.userDataDir).toBe('C:\\datos\\88eabab9');
  });
});

describe('readRecord / writeRecord', () => {
  it('guarda y recupera', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-store-'));
    try {
      const r = merge(null, datos, { ok: true, readable: true }, { ok: false, readable: true }, AHORA);
      await writeRecord(dir, r);
      expect(await readRecord(dir, datos.id)).toEqual(r);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('un archivo por cuenta: uno corrupto no se lleva puestas las demás', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-store-'));
    try {
      await writeRecord(dir, merge(null, datos, { ok: true, readable: true }, { ok: true, readable: true }, AHORA));
      await writeFile(recordPath(dir, 'otra'), 'no es json');

      expect(await readRecord(dir, 'otra')).toBeNull();
      expect(vale((await readRecord(dir, datos.id))!.session)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('una cuenta sin registro devuelve null, no un error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-store-'));
    try {
      expect(await readRecord(dir, 'nunca-vista')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
