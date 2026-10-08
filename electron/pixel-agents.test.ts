// electron/pixel-agents.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { esperaReinicio, prepararCopia } from './pixel-agents';

let dir = '';
afterEach(async () => dir && rm(dir, { recursive: true, force: true }));

/** Un `resources/pixel-agents` mínimo: lo que el servidor necesita para arrancar y servir la página. */
async function armar() {
  dir = await mkdtemp(join(tmpdir(), 'pixel-'));
  const origen = join(dir, 'resources', 'pixel-agents');
  await mkdir(join(origen, 'dist', 'webview'), { recursive: true });
  await writeFile(join(origen, 'dist', 'cli.js'), 'cli');
  await writeFile(join(origen, 'fs-sin-fuga.cjs'), '');
  await writeFile(join(origen, 'dist', 'webview', 'index.html'), 'v1');
  return { origen, base: join(dir, 'local', 'pixel-agents') };
}

describe('prepararCopia', () => {
  it('copia Pixel Agents fuera de Temp, en una carpeta por versión', async () => {
    const { origen, base } = await armar();
    const destino = await prepararCopia(origen, base, '0.22.1');
    expect(destino).toBe(join(base, '0.22.1'));
    expect(await readFile(join(destino, 'dist', 'webview', 'index.html'), 'utf8')).toBe('v1');
  });

  it('no vuelve a copiar si ya está completa', async () => {
    const { origen, base } = await armar();
    await prepararCopia(origen, base, '0.22.1');
    await writeFile(join(origen, 'dist', 'webview', 'index.html'), 'cambiado');
    const destino = await prepararCopia(origen, base, '0.22.1');
    expect(await readFile(join(destino, 'dist', 'webview', 'index.html'), 'utf8')).toBe('v1');
  });

  it('rehace una copia a la que le falta la página (se la borraron)', async () => {
    const { origen, base } = await armar();
    const destino = await prepararCopia(origen, base, '0.22.1');
    await rm(join(destino, 'dist', 'webview', 'index.html'));
    await prepararCopia(origen, base, '0.22.1');
    expect(existsSync(join(destino, 'dist', 'webview', 'index.html'))).toBe(true);
  });

  it('borra las copias de otras versiones', async () => {
    const { origen, base } = await armar();
    await prepararCopia(origen, base, '0.22.0');
    await prepararCopia(origen, base, '0.22.1');
    expect(existsSync(join(base, '0.22.0'))).toBe(false);
    expect(existsSync(join(base, '0.22.1'))).toBe(true);
  });
});

describe('esperaReinicio', () => {
  it('la primera caída reinicia a los 3 s', () => {
    expect(esperaReinicio(null, 1000)).toBe(3000);
  });
  it('si cae de nuevo enseguida, la espera crece hasta 60 s', () => {
    expect(esperaReinicio(3000, 1000)).toBe(6000);
    expect(esperaReinicio(40_000, 1000)).toBe(60_000);
    expect(esperaReinicio(60_000, 1000)).toBe(60_000);
  });
  it('si había corrido 5 min o más, vuelve a empezar', () => {
    expect(esperaReinicio(60_000, 5 * 60_000)).toBe(3000);
  });
});
