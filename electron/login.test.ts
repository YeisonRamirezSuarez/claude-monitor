// electron/login.test.ts
import { describe, it, expect } from 'vitest';
import { comandoDeLogin, looksSuccessful, parseAuthUrl } from './login';

const URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&' +
  'redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=81eQmg';

describe('parseAuthUrl', () => {
  it('saca la URL de lo que imprime el CLI', () => {
    const salida = `Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\n`;
    expect(parseAuthUrl(salida)).toBe(URL);
  });

  it('no la devuelve duplicada cuando viene como hipervínculo de terminal', () => {
    // Formato real: la secuencia OSC 8 pone la dirección dos veces seguidas.
    const salida = `visit: ]8;;${URL}\\${URL}]8;;\\\n`;
    expect(parseAuthUrl(salida)).toBe(URL);
  });

  it('aguanta que la salida llegue cortada, que es como llega por stdout', () => {
    expect(parseAuthUrl('Opening browser to sign i')).toBeNull();
    expect(parseAuthUrl('')).toBeNull();
  });

  it('ignora los colores de la terminal', () => {
    expect(parseAuthUrl(`[32mvisit:[0m ${URL}`)).toBe(URL);
  });
});

describe('looksSuccessful', () => {
  it('reconoce que entró', () => {
    expect(looksSuccessful('Successfully logged in as yeison@ejemplo.com')).toBe(true);
  });

  it('no confunde el pedido del código con haber entrado', () => {
    expect(looksSuccessful('Paste code here if prompted > ')).toBe(false);
  });
});

describe('comandoDeLogin', () => {
  it('en Windows, como hoy: un .cmd que necesita shell', () => {
    expect(comandoDeLogin({ tipo: 'windows' })).toEqual({
      command: 'claude',
      args: ['auth', 'login'],
      shell: true
    });
  });

  it('en WSL corre adentro de la distro, no el CLI de Windows', () => {
    const { command, args, shell } = comandoDeLogin(
      { tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' },
      '/home/v/.claude-monitor/aaa11111'
    );
    expect(command).toBe('wsl.exe');
    expect(shell).toBe(false);
    // --exec, no --: con -- el comando pasa por el shell de login de la
    // distro, que lo re-parsea antes de llegar a este bash -lc.
    expect(args.slice(0, 7)).toEqual(['-d', 'Ubuntu', '--cd', '/home/v', '--exec', 'bash', '-lc']);
    expect(args[7]).toContain('claude auth login');
  });

  // Sin esto el token caía en $HOME/.claude y la app lo buscaba en la carpeta
  // de la cuenta: "Configurar Claude" en bucle para toda cuenta WSL nueva.
  it('en WSL el CLAUDE_CONFIG_DIR de la cuenta entra por export, como en la terminal', () => {
    const { args } = comandoDeLogin(
      { tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' },
      '/home/v/.claude-monitor/aaa11111'
    );
    expect(args[args.length - 1]).toMatch(/^export CLAUDE_CONFIG_DIR='\/home\/v\/.claude-monitor\/aaa11111'\n/);
  });
});
