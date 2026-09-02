import { describe, expect, it } from 'vitest';
import { enlaceEn } from './protocol';

describe('enlaceEn', () => {
  it('encuentra el enlace donde sea que Windows lo haya puesto', () => {
    const argv = ['C:\\app\\claude-monitor.exe', '--allow-file-access', 'claude://resume?session=abc'];
    expect(enlaceEn(argv)).toBe('claude://resume?session=abc');
  });

  it('acepta el esquema en mayúsculas, que es como llega a veces', () => {
    expect(enlaceEn(['x', 'Claude://code/new?folder=C%3A%5Cx'])).toBe('Claude://code/new?folder=C%3A%5Cx');
  });

  it('sin enlace no inventa nada', () => {
    expect(enlaceEn(['C:\\app\\claude-monitor.exe', '.'])).toBeNull();
  });

  it('ignora otros esquemas: esto termina siendo argumento de un ejecutable', () => {
    expect(enlaceEn(['https://claude.ai', 'file:///c/x', 'claudex://algo'])).toBeNull();
  });
});
