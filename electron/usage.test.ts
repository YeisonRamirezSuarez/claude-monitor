// electron/usage.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsage } from './usage';

/** Recorte real de un `.claude.json` de Claude Code. */
const CONFIG = {
  oauthAccount: { emailAddress: 'yo@ejemplo.com', organizationType: 'claude_pro' },
  cachedUsageUtilization: {
    fetchedAtMs: 1786729194161,
    utilization: {
      limits: [
        { kind: 'session', percent: 61.4, severity: 'normal', resets_at: '2026-08-14T21:30:00.276718+00:00' },
        { kind: 'weekly_all', percent: 40, severity: 'warning', resets_at: '2026-08-20T15:00:00.276744+00:00' },
        { kind: 'limite_nuevo', percent: 5, severity: 'normal', resets_at: null },
        { kind: 'roto' }
      ]
    }
  }
};

async function configDirWith(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  await writeFile(join(dir, '.claude.json'), JSON.stringify(contents), 'utf8');
  return dir;
}

describe('readUsage', () => {
  it('extrae los límites, traduce los conocidos y descarta los que no tienen porcentaje', async () => {
    const usage = await readUsage(await configDirWith(CONFIG));
    expect(usage?.email).toBe('yo@ejemplo.com');
    expect(usage?.plan).toBe('claude_pro');
    // Sin .credentials.json no hay consulta en vivo posible: cae a la caché y
    // lo dice, en vez de presentar números viejos como actuales.
    expect(usage?.live).toBe(false);
    expect(usage?.accountName).toBe('');
    expect(usage?.fetchedAtMs).toBe(1786729194161);
    expect(usage?.limits).toEqual([
      { kind: 'session', label: 'Sesión (5 h)', percent: 61, severity: 'normal', resetsAt: '2026-08-14T21:30:00.276718+00:00' },
      { kind: 'weekly_all', label: 'Semanal', percent: 40, severity: 'warning', resetsAt: '2026-08-20T15:00:00.276744+00:00' },
      // Un `kind` que no conocemos se muestra igual: un límite nuevo le importa
      // al usuario aunque la app no sepa cómo llamarlo.
      { kind: 'limite_nuevo', label: 'limite_nuevo', percent: 5, severity: 'normal', resetsAt: null }
    ]);
  });

  it('devuelve null cuando la cuenta nunca se usó', async () => {
    expect(await readUsage(await mkdtemp(join(tmpdir(), 'usage-')))).toBeNull();
    expect(await readUsage(await configDirWith({ firstStartTime: '2026-08-14T17:16:56.477Z' }))).toBeNull();
  });
});
