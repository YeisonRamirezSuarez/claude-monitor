// electron/terminal.test.ts
import { describe, it, expect } from 'vitest';
import { bannerBash, bannerCommand, psQuote, sessionEnv, shQuote, tabTitle } from './terminal';

describe('sessionEnv', () => {
  it('borra los marcadores heredados de Claude Code (regresión: transcript saving off)', () => {
    const env = sessionEnv(
      {
        PATH: 'C:\\Windows',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'abc',
        CLAUDE_PID: '123',
        claude_code_entrypoint: 'cli'
      },
      'C:\\perfiles\\a1'
    );
    expect(Object.keys(env).filter((k) => /^CLAUDE/i.test(k))).toEqual(['CLAUDE_CONFIG_DIR']);
    expect(env.PATH).toBe('C:\\Windows');
  });

  it('manda el configDir con barras normales: wt.exe se come las invertidas', () => {
    expect(sessionEnv({}, 'C:\\Users\\x\\perfil').CLAUDE_CONFIG_DIR).toBe('C:/Users/x/perfil');
  });
});

describe('psQuote', () => {
  it('duplica la comilla simple, que es lo único que escapa adentro', () => {
    expect(psQuote("cuenta d'algo")).toBe("'cuenta d''algo'");
  });

  it('no deja escapar de las comillas: el nombre de la cuenta lo escribe el usuario', () => {
    // Sin escapar, esto cerraría la cadena y `Remove-Item` sería una sentencia.
    const salida = psQuote("x'; Remove-Item C:\\ -Recurse #");
    expect(salida).toBe("'x''; Remove-Item C:\\ -Recurse #'");
    expect(salida.slice(1, -1)).not.toMatch(/(^|[^'])'([^']|$)/);
  });
});

describe('bannerCommand', () => {
  it('anuncia la cuenta antes de arrancar claude', () => {
    const salida = bannerCommand('claude --resume abc', 'personal · yo@ejemplo.com');
    expect(salida).toContain("Write-Host '  Cuenta: personal · yo@ejemplo.com' -ForegroundColor Cyan");
    expect(salida.split('\n').at(-1)).toBe('claude --resume abc');
  });

  it('separa con salto de línea y nunca con ";" (regresión: wt.exe corta ahí y pierde el resto)', () => {
    expect(bannerCommand('claude', 'personal')).not.toContain(';');
  });

  it('sin cuenta que anunciar, deja el comando intacto', () => {
    expect(bannerCommand('claude', '   ')).toBe('claude');
  });

  it('aplasta los saltos de línea del nombre: romperían el cartel en dos sentencias', () => {
    expect(bannerCommand('claude', 'mala\nidea')).toContain("'  Cuenta: mala idea'");
  });
});

describe('tabTitle', () => {
  it('saca lo que wt.exe reparsea', () => {
    expect(tabTitle('personal; algo "raro"')).toBe('personal algo raro');
  });
});

describe('shQuote', () => {
  it("cierra, escapa y reabre: es la unica forma de meter ' en comillas simples", () => {
    expect(shQuote("cuenta d'algo")).toBe("'cuenta d'\\''algo'");
  });
  it('el resto queda literal, que es el punto de la comilla simple', () => {
    expect(shQuote('$HOME `id` "x"')).toBe('\'$HOME `id` "x"\'');
  });
  it('cadena vacía: queda un par de comillas vacío', () => {
    expect(shQuote('')).toBe("''");
  });
});

describe('bannerBash', () => {
  it('dice con qué cuenta se entra, igual que el de PowerShell', () => {
    expect(bannerBash('claude', 'Cuenta A')).toContain('Cuenta A');
    expect(bannerBash('claude', 'Cuenta A')).toContain('claude');
  });
  it('sin etiqueta, el comando va solo', () => {
    expect(bannerBash('claude', '')).toBe('claude');
  });
});
