// electron/terminal.test.ts
import { describe, it, expect } from 'vitest';
import { sessionEnv } from './terminal';

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
