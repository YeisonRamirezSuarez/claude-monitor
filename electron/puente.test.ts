import { describe, it, expect, vi } from 'vitest';
import { Puente, type DepsPuente } from './puente';
import type { AgenteOficina } from '../shared/types';

const CHAT = -100;
const YO = 42;
const agente = (sessionId: string, estado: AgenteOficina['estado'] = 'esperando'): AgenteOficina => ({
  sessionId, profileId: 'p', profileName: 'MAX', nombre: 'migracion', nombrePropio: '', nota: '', cwd: 'C:/repos/Vendig',
  origen: 'terminal', transcript: `C:/t/${sessionId}.jsonl`, estado, herramienta: '', detalle: '', subagentes: [], mensajes: []
});

function armar(extra: Partial<DepsPuente> = {}) {
  const enviados: Array<{ texto: string; tema?: number; botones?: unknown }> = [];
  const temas = new Map<string, number>();
  let fuera = true;
  let proximoTema = 900;
  const deps: DepsPuente = {
    canal: {
      enviar: vi.fn(async (_c: number, texto: string, op: { tema?: number; botones?: unknown } = {}) => {
        enviados.push({ texto, ...op });
        return enviados.length;
      }),
      editar: vi.fn(async () => {}),
      contestarBoton: vi.fn(async () => {}),
      crearTema: vi.fn(async () => ++proximoTema),
      descargar: vi.fn(async (_f: string, d: string) => d)
    },
    vinculo: () => ({ chatId: CHAT, userId: YO }),
    vincular: vi.fn(async () => {}),
    codigo: () => null,
    fuera: () => fuera,
    setManual: vi.fn(),
    sesiones: async () => [agente('s1'), agente('s2', 'escribiendo')],
    ultimoMensaje: async () => 'Listo, terminé.',
    temas: {
      leer: (s) => temas.get(s),
      guardar: async (s, t) => void temas.set(s, t),
      borrar: async (s) => void temas.delete(s),
      sesionDe: (t) => [...temas].find(([, v]) => v === t)?.[0]
    },
    carpetaImagenes: 'C:/img',
    tomar: vi.fn(async () => {}),
    cambiarModelo: vi.fn(async () => {}),
    esperaCambioMs: 0,
    esperaAlbumMs: 0,
    esperaReintentoMs: 0,
    ...extra
  };
  return { p: new Puente(deps), deps, enviados, temas, setFuera: (v: boolean) => (fuera = v) };
}

const texto = (t: string, tema?: number, de = YO) => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: CHAT }, from: { id: de }, message_thread_id: tema, is_topic_message: !!tema, text: t }
});
const boton = (dato: string, de = YO, chat = CHAT) => ({
  update_id: 2,
  callback_query: { id: 'cb', from: { id: de }, data: dato, message: { message_id: 1, chat: { id: chat } } }
});
const fotoEn = (tema: number, id: number, grupo = 'g') => ({
  update_id: id,
  message: {
    message_id: id, chat: { id: CHAT }, from: { id: YO }, message_thread_id: tema, is_topic_message: true,
    media_group_id: grupo, photo: [{ file_id: `f${id}` }]
  }
});
const vacio = (tema: number) => ({
  update_id: 3,
  message: { message_id: 3, chat: { id: CHAT }, from: { id: YO }, message_thread_id: tema, is_topic_message: true }
});
const enForo = <T extends { message: { chat: object } }>(u: T): T => ({
  ...u,
  message: { ...u.message, chat: { ...u.message.chat, type: 'supergroup', is_forum: true } }
});
const idDe = (botones: unknown) => ((botones as Array<Array<{ dato: string }>>)[0][0].dato).split(':')[0];
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Puente', () => {
  it('sin modo fuera contesta {} al instante', async () => {
    const { p, setFuera } = armar();
    setFuera(false);
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' })).toEqual({});
  });

  it('permiso: manda al tema de la sesión y aplica el botón', async () => {
    const { p, enviados, temas } = armar();
    const espera = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    await tick();
    expect(enviados[0].tema).toBe(temas.get('s1'));
    await p.atenderUpdate(boton(`${idDe(enviados[0].botones)}:si`));
    expect(await espera).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  it('permiso: permitir borra el mensaje y rechazar le saca los botones', async () => {
    const borrar = vi.fn(async () => {});
    const editar = vi.fn(async () => {});
    const { p, deps, enviados } = armar();
    Object.assign(deps.canal, { borrar, editar });
    const a = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    await p.atenderUpdate(boton(`${idDe(enviados[0].botones)}:si`));
    await a;
    expect(borrar).toHaveBeenCalledWith(CHAT, 1);
    const b = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    await p.atenderUpdate(boton(`${idDe(enviados[1].botones)}:no`));
    await b;
    expect(editar).toHaveBeenCalledTimes(1);
    expect(editar).toHaveBeenCalledWith(CHAT, 2, expect.stringContaining('Rechazado'));
  });

  it('avisa la entrega del mensaje (Stop, toma y guardado), y no si la sesión terminó', async () => {
    const alEntregar = vi.fn();
    const { p, temas } = armar({ alEntregar, sesiones: async () => [agente('s1'), agente('s2', 'escribiendo')] });
    const espera = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    await p.atenderUpdate(texto('seguí', temas.get('s1')));
    await espera;
    expect(alEntregar).toHaveBeenLastCalledWith('s1', 1, true);
    await p.atenderUpdate(texto('otra', temas.get('s1'))); // quieta, sin espera: se toma
    expect(alEntregar).toHaveBeenCalledTimes(2);
    temas.set('s2', 950);
    await p.atenderUpdate(texto('después', 950)); // trabajando: queda guardado
    expect(alEntregar).toHaveBeenLastCalledWith('s2', 1, true);
    temas.set('s9', 951);
    await p.atenderUpdate(texto('hola', 951)); // no existe
    expect(alEntregar).toHaveBeenCalledTimes(3);
  });

  it('stop: el texto en el tema es la instrucción siguiente', async () => {
    const { p, temas } = armar();
    const espera = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1', transcript_path: 'C:/t/s1.jsonl' });
    await tick();
    await p.atenderUpdate(texto('corré los tests', temas.get('s1')));
    expect(await espera).toMatchObject({ decision: 'block', reason: expect.stringContaining('corré los tests') });
  });

  it('pregunta: el botón da la opción y el texto libre cuenta como Otro', async () => {
    const { p, enviados, temas } = armar();
    const input = { questions: [{ question: '¿Color?', options: [{ label: 'Rojo' }, { label: 'Verde' }] }] };
    const e1 = p.atenderHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion', tool_input: input });
    await tick();
    await p.atenderUpdate(boton(`${idDe(enviados[0].botones)}:o1`));
    expect(await e1).toMatchObject({ hookSpecificOutput: { updatedInput: { answers: { '¿Color?': 'Verde' } } } });
    const e2 = p.atenderHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion', tool_input: input });
    await tick();
    await p.atenderUpdate(texto('Violeta', temas.get('s1')));
    expect(await e2).toMatchObject({ hookSpecificOutput: { updatedInput: { answers: { '¿Color?': 'Violeta' } } } });
  });

  it('pregunta con varias: se hacen de a una y el hook recibe todas las respuestas juntas', async () => {
    const { p, enviados, temas } = armar();
    const input = {
      questions: [
        { question: '¿Color?', options: [{ label: 'Rojo' }, { label: 'Verde' }] },
        { question: '¿Talla?', options: [{ label: 'S' }, { label: 'M' }] }
      ]
    };
    const e = p.atenderHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion', tool_input: input });
    await tick();
    const id = idDe(enviados[0].botones);
    await p.atenderUpdate(boton(`${id}:o1`));
    await tick();
    expect(enviados[1].texto).toContain('¿Talla?');
    await p.atenderUpdate(texto('XL', temas.get('s1')));
    expect(await e).toMatchObject({ hookSpecificOutput: { updatedInput: { answers: { '¿Color?': 'Verde', '¿Talla?': 'XL' } } } });
  });

  it('un botón de una espera que ya no existe (app reiniciada) deja el mensaje sin botones y lo dice', async () => {
    const { p, deps } = armar();
    const u = boton('dead0001:o0');
    u.callback_query.message = { ...u.callback_query.message, text: '❓ ¿Dónde?' } as typeof u.callback_query.message;
    await p.atenderUpdate(u);
    expect(deps.canal.editar).toHaveBeenCalledWith(CHAT, 1, expect.stringMatching(/^❓ ¿Dónde\?\n\n⌛ Ya no está vigente/));
    expect(deps.canal.contestarBoton).toHaveBeenCalledWith('cb', 'Ya no está vigente.');
  });

  it('pregunta con varias: el texto que llega mientras se pasa a la siguiente espera y responde a la siguiente', async () => {
    const { p, deps, enviados, temas } = armar();
    const input = {
      questions: [
        { question: '¿Color?', options: [{ label: 'Rojo' }] },
        { question: '¿Talla?', options: [{ label: 'S' }] }
      ]
    };
    // El enviar de la 2.ª pregunta tarda: mientras, llega un texto.
    let soltar: () => void = () => {};
    const original = deps.canal.enviar as ReturnType<typeof vi.fn>;
    original.mockImplementationOnce(async (_c: number, t: string, op: object = {}) => {
      enviados.push({ texto: t, ...op });
      return enviados.length;
    });
    const e = p.atenderHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion', tool_input: input });
    await tick();
    original.mockImplementationOnce(
      (_c: number, t: string, op: object = {}) =>
        new Promise<number>((ok) => {
          soltar = () => {
            enviados.push({ texto: t, ...op });
            ok(enviados.length);
          };
        })
    );
    const toque = p.atenderUpdate(boton(`${idDe(enviados[0].botones)}:o0`));
    await tick();
    const llegada = p.atenderUpdate(texto('XL', temas.get('s1')));
    await tick();
    expect(deps.tomar).not.toHaveBeenCalled();
    soltar();
    await Promise.all([toque, llegada]);
    expect(await e).toMatchObject({ hookSpecificOutput: { updatedInput: { answers: { '¿Color?': 'Rojo', '¿Talla?': 'XL' } } } });
  });

  it('volver a la PC suelta todo con {} y un botón viejo no toca la espera siguiente', async () => {
    const { p, enviados, deps } = armar();
    const e1 = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    const viejo = idDe(enviados[0].botones);
    await p.soltarTodo();
    expect(await e1).toEqual({});
    expect(deps.canal.editar).toHaveBeenCalledWith(CHAT, 1, expect.stringContaining('Retomado en la PC'));
    const e2 = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    await p.atenderUpdate(boton(`${viejo}:si`));
    expect(deps.canal.contestarBoton).toHaveBeenCalledWith('cb', 'Ya no está vigente.');
    await p.atenderUpdate(boton(`${idDe(enviados[1].botones)}:no`));
    expect(await e2).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  });

  it('mensajes de otro usuario u otro chat se ignoran', async () => {
    const { p, temas } = armar();
    const espera = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    await p.atenderUpdate(texto('rm -rf', temas.get('s1'), 999));
    let resuelta = false;
    espera.then(() => (resuelta = true));
    await tick();
    expect(resuelta).toBe(false);
    await p.soltarTodo();
  });

  it('un texto en General (sin tema) nunca va a una sesión: contesta la ayuda', async () => {
    const { p, enviados, deps } = armar();
    await p.atenderUpdate(texto('hola'));
    expect(deps.tomar).not.toHaveBeenCalled();
    expect(enviados.at(-1)!.texto).toContain('/estado');
  });

  it('a una sesión quieta sin espera se la toma; a una que trabaja se le guarda para su próximo Stop', async () => {
    const { p, deps, temas } = armar();
    await temas.set('s1', 901);
    await temas.set('s2', 902);
    await p.atenderUpdate(texto('seguí', 901));
    expect(deps.tomar).toHaveBeenCalledWith('s1', 'seguí');
    await p.atenderUpdate(texto('después esto', 902));
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' })).toMatchObject({
      reason: expect.stringContaining('después esto')
    });
  });

  it('dos sesiones con el mismo nombre tienen temas distintos', async () => {
    const { p, temas } = armar({ sesiones: async () => [agente('s1'), agente('s3')] });
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's3' });
    await tick();
    await tick();
    expect(temas.get('s1')).not.toBe(temas.get('s3'));
    await p.soltarTodo();
  });

  it('vincular: sólo con el código vigente', async () => {
    const vincular = vi.fn(async () => {});
    const { p } = armar({ vinculo: () => null, vincular, codigo: () => ({ codigo: '123456', vence: Date.now() + 60_000 }) });
    await p.atenderUpdate(enForo(texto('/vincular 000000')));
    expect(vincular).not.toHaveBeenCalled();
    await p.atenderUpdate(enForo(texto('/vincular 123456')));
    expect(vincular).toHaveBeenCalledWith({ chatId: CHAT, userId: YO });
  });

  // Final review M6: sin Temas no hay un hilo por sesión y todo se mezclaría en un solo chat.
  it('vincular: al quinto código equivocado se quema el vigente y se anota quién fue; el bueno ya no entra', async () => {
    const vincular = vi.fn(async () => {});
    const quemarCodigo = vi.fn();
    let c: { codigo: string; vence: number } | null = { codigo: '123456', vence: Date.now() + 60_000 };
    const { p, enviados } = armar({ vinculo: () => null, vincular, codigo: () => c, quemarCodigo });
    for (let i = 0; i < 4; i++) await p.atenderUpdate(enForo(texto(`/vincular 00000${i}`)));
    expect(quemarCodigo).not.toHaveBeenCalled();
    await p.atenderUpdate(enForo(texto('/vincular 000009')));
    expect(quemarCodigo).toHaveBeenCalledWith({ userId: YO, chatId: CHAT });
    c = null; // lo que hace la app al quemarlo
    await p.atenderUpdate(enForo(texto('/vincular 123456')));
    expect(vincular).not.toHaveBeenCalled();
    // Al que erró no se le contesta nada.
    expect(enviados).toHaveLength(0);
  });

  it('vincular: sólo desde un supergrupo con Temas; si no, lo pide', async () => {
    const vincular = vi.fn(async () => {});
    const { p, enviados } = armar({ vinculo: () => null, vincular, codigo: () => ({ codigo: '123456', vence: Date.now() + 60_000 }) });
    await p.atenderUpdate(texto('/vincular 123456'));
    expect(vincular).not.toHaveBeenCalled();
    expect(enviados.at(-1)!.texto).toBe('Usá un grupo con Temas activados.');
    const sinTemas = texto('/vincular 123456');
    (sinTemas.message.chat as Record<string, unknown>).type = 'supergroup';
    await p.atenderUpdate(sinTemas);
    expect(vincular).not.toHaveBeenCalled();
    await p.atenderUpdate(enForo(texto('/vincular 123456')));
    expect(vincular).toHaveBeenCalledTimes(1);
  });

  it('/fuera y /vuelvo fuerzan el modo', async () => {
    const { p, deps } = armar();
    await p.atenderUpdate(texto('/fuera'));
    await p.atenderUpdate(texto('/vuelvo'));
    expect(deps.setManual).toHaveBeenNthCalledWith(1, true);
    expect(deps.setManual).toHaveBeenNthCalledWith(2, false);
  });

  it('SessionStart devuelve el contexto siempre, esté o no fuera', async () => {
    const { p, setFuera } = armar();
    setFuera(false);
    expect(await p.atenderHook({ hook_event_name: 'SessionStart', session_id: 's1' })).toHaveProperty('hookSpecificOutput.additionalContext');
  });

  it('PostCompact avisa en la consola siempre y en el tema sólo si la sesión tiene uno', async () => {
    const { p, enviados, temas, setFuera } = armar();
    setFuera(false);
    const r = (await p.atenderHook({ hook_event_name: 'PostCompact', session_id: 's1' })) as { systemMessage: string };
    expect(r.systemMessage).toContain('Compactada');
    expect(enviados).toHaveLength(0);
    temas.set('s1', 555);
    await p.atenderHook({ hook_event_name: 'PostCompact', session_id: 's1' });
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatchObject({ tema: 555, texto: expect.stringContaining('Compactada') });
  });

  it('PreCompact pone un reloj que se edita, y PostCompact lo cierra con los tokens de antes y después', async () => {
    const compactacion = vi.fn(async () => ({ preTokens: 239497, postTokens: 21746, durationMs: 43803 }));
    const { p, deps, enviados, temas } = armar({ compactacion, relojCompactarMs: 5 });
    temas.set('s1', 555);
    expect(await p.atenderHook({ hook_event_name: 'PreCompact', session_id: 's1' })).toEqual({});
    expect(enviados).toEqual([{ texto: '🗜 Compactando la conversación… ⏱ 0:00', tema: 555 }]);
    await new Promise((r) => setTimeout(r, 30));
    const editar = deps.canal.editar as ReturnType<typeof vi.fn>;
    expect(editar.mock.calls.length).toBeGreaterThan(0);
    expect(editar.mock.calls[0][2]).toContain('🗜 Compactando');
    const r = (await p.atenderHook({ hook_event_name: 'PostCompact', session_id: 's1', transcript_path: 'C:/t/s1.jsonl' })) as {
      systemMessage: string;
    };
    expect(compactacion).toHaveBeenCalledWith('C:/t/s1.jsonl');
    expect(r.systemMessage).toBe('✅ Compactada en 0:44 · 239k → 22k tokens. Ya podés seguir escribiendo.');
    await new Promise((r) => setTimeout(r, 30));
    // El cierre edita el mismo mensaje (último en la fila) y el reloj ya no lo toca.
    const n = editar.mock.calls.length;
    expect(editar.mock.calls.at(-1)).toEqual([CHAT, 1, r.systemMessage]);
    await new Promise((r) => setTimeout(r, 30));
    expect(editar.mock.calls.length).toBe(n);
    expect(enviados).toHaveLength(1);
  });

  it('un tema borrado a mano se vuelve a crear', async () => {
    const { p, deps, temas, enviados } = armar();
    temas.set('s1', 555);
    const { TelegramError } = await import('./telegram');
    (deps.canal.enviar as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new TelegramError(400, 'Bad Request: message thread not found');
    });
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    expect(temas.get('s1')).not.toBe(555);
    expect(enviados.at(-1)!.tema).toBe(temas.get('s1'));
    await p.soltarTodo();
  });

  it('sin internet reintenta el envío hasta poder', async () => {
    const { p, deps, enviados } = armar();
    (deps.canal.enviar as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    await tick();
    expect(enviados).toHaveLength(1);
    await p.soltarTodo();
  });

  // Claude Code mata el hook cuando el usuario aprieta Esc o contesta en la terminal: la espera
  // tiene que morir con él, si no se traga el próximo texto del tema y un botón viejo la contesta.
  it('si Claude Code mata el hook, la espera se retoma y no se traga el texto siguiente', async () => {
    const { p, deps, temas } = armar();
    const ctl = new AbortController();
    const espera = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' }, ctl.signal);
    await tick();
    ctl.abort();
    expect(await espera).toEqual({});
    expect(deps.canal.editar).toHaveBeenCalledWith(CHAT, 1, expect.stringContaining('Retomado en la PC'));
    await p.atenderUpdate(texto('seguí', temas.get('s1')));
    expect(deps.tomar).toHaveBeenCalledWith('s1', 'seguí');
  });

  it('el botón de una espera abortada contesta que ya no está vigente', async () => {
    const { p, deps, enviados } = armar();
    const ctl = new AbortController();
    const espera = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} }, ctl.signal);
    await tick();
    const viejo = idDe(enviados[0].botones);
    ctl.abort();
    expect(await espera).toEqual({});
    await p.atenderUpdate(boton(`${viejo}:si`));
    expect(deps.canal.contestarBoton).toHaveBeenCalledWith('cb', 'Ya no está vigente.');
  });

  it('con la señal ya abortada no manda nada', async () => {
    const { p, deps, enviados } = armar();
    const ctl = new AbortController();
    ctl.abort();
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' }, ctl.signal)).toEqual({});
    expect(enviados).toHaveLength(0);
    expect(deps.canal.crearTema).not.toHaveBeenCalled();
  });

  it('si se aborta mientras se estaba enviando, el mensaje queda retomado y no queda espera', async () => {
    const ctl = new AbortController();
    const { p, deps, temas } = armar();
    const enviar = deps.canal.enviar as ReturnType<typeof vi.fn>;
    const original = enviar.getMockImplementation()!;
    enviar.mockImplementationOnce(async (...a: unknown[]) => {
      const id = await original(...a);
      ctl.abort();
      return id;
    });
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' }, ctl.signal)).toEqual({});
    expect(deps.canal.editar).toHaveBeenCalledWith(CHAT, 1, expect.stringContaining('Retomado en la PC'));
    await p.atenderUpdate(texto('seguí', temas.get('s1')));
    expect(deps.tomar).toHaveBeenCalledWith('s1', 'seguí');
  });

  it('las fotos de un álbum viajan juntas en un solo mensaje a la sesión', async () => {
    const { p, deps, temas } = armar();
    temas.set('s1', 901);
    await p.atenderUpdate(fotoEn(901, 1));
    await p.atenderUpdate(fotoEn(901, 2));
    await tick();
    expect(deps.tomar).toHaveBeenCalledTimes(1);
    expect((deps.tomar as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/Mirá las imágenes\.[\s\S]*-1\.jpg[\s\S]*-2\.jpg/);
  });

  // Fix round 1
  it('si el aviso del botón falla, la decisión igual se aplica', async () => {
    const { p, deps, enviados } = armar();
    const espera = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    (deps.canal.contestarBoton as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('red caída');
    });
    await p.atenderUpdate(boton(`${idDe(enviados[0].botones)}:si`));
    expect(await espera).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
  });

  // En la PC un Stop nunca recibe instrucción (spec §4.2 y §5.4): lo guardado se descarta con aviso, no se guarda para después.
  it('lo escrito mientras trabaja entra en su próximo paso (PostToolUse), con aviso en la consola, una sola vez', async () => {
    const { p, temas, deps } = armar();
    const borrar = vi.fn(async () => {});
    deps.canal.borrar = borrar;
    temas.set('s2', 902);
    await p.atenderUpdate(texto('después esto', 902));
    const r = (await p.atenderHook({ hook_event_name: 'PostToolUse', session_id: 's2' })) as {
      systemMessage: string;
      hookSpecificOutput: { additionalContext: string };
    };
    expect(r.systemMessage).toContain('después esto');
    expect(r.hookSpecificOutput.additionalContext).toContain('después esto');
    expect(borrar).toHaveBeenCalledTimes(1); // el aviso "Recibido" ya sobra
    expect(await p.atenderHook({ hook_event_name: 'PostToolUse', session_id: 's2' })).toEqual({});
  });

  it('lo guardado le llega en el Stop aunque esté en la PC (lo escribió a propósito), y no reaparece', async () => {
    const { p, temas, setFuera, enviados } = armar();
    temas.set('s2', 902);
    await p.atenderUpdate(texto('después esto', 902));
    setFuera(false);
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' })).toMatchObject({
      reason: expect.stringContaining('después esto')
    });
    // No reaparece: el Stop siguiente ya no trae ese texto (queda escuchando, como toda sesión con tema).
    let r: object | undefined;
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' }).then((x) => (r = x));
    await tick();
    expect(r).toBeUndefined();
    p.soltarTodo();
    await tick();
    expect(r).toEqual({});
    setFuera(true);
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' });
    await tick();
    expect(enviados.at(-1)!.texto).toContain('Terminó y te espera');
    await p.soltarTodo();
  });

  it('en la PC: sin tema el Stop no espera; con tema queda escuchando y un texto desde Telegram lo sigue', async () => {
    const { p, temas, setFuera } = armar();
    setFuera(false);
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' })).toEqual({});
    temas.set('s1', 901);
    const espera = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    await p.atenderUpdate(texto('seguí con esto', 901));
    expect(await espera).toMatchObject({ decision: 'block', reason: expect.stringContaining('seguí con esto') });
  });

  it('al volver de "fuera" se sueltan permisos pero las escuchas de sesiones con tema siguen', async () => {
    const { p, temas } = armar();
    temas.set('s1', 901);
    let stop: object | undefined;
    let permiso: object | undefined;
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' }).then((x) => (stop = x));
    void p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} }).then((x) => (permiso = x));
    await tick();
    p.soltarTodo(true);
    await tick();
    expect(permiso).toEqual({});
    expect(stop).toBeUndefined();
    p.soltarTodo();
    await tick();
    expect(stop).toEqual({});
  });

  it('en la PC, una sesión quieta se reabre en su consola con el mensaje (nunca se toma con -p)', async () => {
    const alEntregar = vi.fn();
    const { p, deps, temas, setFuera, enviados } = armar({ alEntregar });
    setFuera(false);
    temas.set('s1', 901);
    await p.atenderUpdate(texto('seguí', 901));
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.tomar).not.toHaveBeenCalled();
    expect(deps.cambiarModelo).toHaveBeenCalledWith('s1', { mensaje: 'seguí' });
    expect(alEntregar).toHaveBeenCalledWith('s1', 1, true);
    expect(enviados).toHaveLength(0);
  });

  it('en la PC, una sesión de Desktop quieta no se reabre: lo guarda y avisa que no escucha', async () => {
    const alEntregar = vi.fn();
    const { p, deps, temas, setFuera, enviados } = armar({
      alEntregar,
      sesiones: async () => [{ ...agente('s1'), origen: 'desktop' }]
    });
    setFuera(false);
    temas.set('s1', 901);
    await p.atenderUpdate(texto('seguí', 901));
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.cambiarModelo).not.toHaveBeenCalled();
    expect(alEntregar).toHaveBeenCalledWith('s1', 1, false);
    expect(enviados.at(-1)!.texto).toContain('todavía no escucha Telegram');
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' })).toMatchObject({ reason: expect.stringContaining('seguí') });
  });

  it('al terminar el turno avisa para borrar el progreso, antes de mandar la respuesta final', async () => {
    const orden: string[] = [];
    const { p, temas, deps } = armar({ alTerminarTurno: async (s) => void orden.push('terminar:' + s) });
    const enviar = deps.canal.enviar as ReturnType<typeof vi.fn>;
    const original = enviar.getMockImplementation()!;
    enviar.mockImplementation(async (...a: Parameters<typeof original>) => {
      orden.push('enviar');
      return original(...a);
    });
    temas.set('s1', 901);
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    expect(orden).toEqual(['terminar:s1', 'enviar']);
    p.soltarTodo();
  });

  it('/model con la sesión quieta la reabre ya, sin confirmar (la sesión contesta sola); nunca pasa como mensaje', async () => {
    const { p, deps, temas, enviados } = armar();
    temas.set('s1', 901);
    await p.atenderUpdate(texto('/model opus /effort high', 901));
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.cambiarModelo).toHaveBeenCalledWith('s1', { model: 'opus', effort: 'high' });
    expect(deps.tomar).not.toHaveBeenCalled();
    expect(enviados.some((e) => e.texto.includes('✅'))).toBe(false);
  });

  it('/compact la reabre compactando sin "Reabierta…": el reloj y el cierre los ponen PreCompact y PostCompact', async () => {
    const { p, deps, temas, enviados } = armar();
    temas.set('s1', 901);
    await p.atenderUpdate(texto('/compact', 901));
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.cambiarModelo).toHaveBeenCalledWith('s1', { compactar: '' });
    expect(enviados).toHaveLength(0);
  });

  it('/model con la sesión trabajando espera al Stop del turno, que se suelta sin escuchar', async () => {
    const { p, deps, temas, enviados } = armar();
    temas.set('s2', 902);
    await p.atenderUpdate(texto('/effort max', 902));
    expect(deps.cambiarModelo).not.toHaveBeenCalled();
    expect(enviados.at(-1)!.texto).toContain('cuando termine');
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' })).toEqual({});
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.cambiarModelo).toHaveBeenCalledWith('s2', { effort: 'max' });
  });

  it('/model escuchando en un Stop: suelta la espera y la reabre', async () => {
    const { p, deps, temas } = armar();
    temas.set('s1', 901);
    const stop = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    await p.atenderUpdate(texto('/model sonnet', 901));
    expect(await stop).toEqual({});
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.cambiarModelo).toHaveBeenCalledWith('s1', { model: 'sonnet' });
  });

  it('/model con un valor fuera de la lista explica el uso y no toca nada', async () => {
    const { p, deps, temas, enviados } = armar();
    temas.set('s1', 901);
    await p.atenderUpdate(texto('/model gpt', 901));
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.cambiarModelo).not.toHaveBeenCalled();
    expect(enviados.at(-1)!.texto).toContain('/effort low|medium');
  });

  it('un Stop con la señal ya abortada no consume lo guardado', async () => {
    const { p, temas } = armar();
    temas.set('s2', 902);
    await p.atenderUpdate(texto('después esto', 902));
    const ctl = new AbortController();
    ctl.abort();
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' }, ctl.signal)).toEqual({});
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' })).toMatchObject({
      reason: expect.stringContaining('después esto')
    });
  });

  it('un mensaje sin texto ni foto no responde la espera ni se guarda: contesta que no lo entiende', async () => {
    const { p, deps, enviados, temas } = armar();
    temas.set('s2', 902);
    const stop = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    let resuelta = false;
    stop.then(() => (resuelta = true));
    await p.atenderUpdate(vacio(902));
    await p.atenderUpdate(vacio(temas.get('s1')!));
    await tick();
    expect(resuelta).toBe(false);
    expect(deps.tomar).not.toHaveBeenCalled();
    expect(enviados.at(-1)!.texto).toBe('Por ahora sólo entiendo texto y fotos.');
    // Y a la sesión que trabaja no se le guardó nada: en su Stop hay que esperar, no responder al toque.
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' });
    await tick();
    expect(enviados.at(-1)!.texto).toContain('Terminó y te espera');
    await p.soltarTodo();
  });

  it('las fotos para una sesión que trabaja se guardan con sus rutas para el próximo Stop', async () => {
    const { p, temas } = armar();
    temas.set('s2', 902);
    await p.atenderUpdate(fotoEn(902, 1));
    await p.atenderUpdate(fotoEn(902, 2));
    await tick();
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' })).toMatchObject({
      reason: expect.stringMatching(/Imágenes adjuntas[\s\S]*-1\.jpg[\s\S]*-2\.jpg/)
    });
  });

  it('soltarTodo con un envío en vuelo: al terminar de enviar la espera se retoma', async () => {
    const { p, deps, temas, setFuera } = armar();
    temas.set('s1', 901);
    let termina!: (id: number) => void;
    (deps.canal.enviar as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<number>((r) => (termina = r)));
    const espera = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    setFuera(false);
    await p.soltarTodo();
    termina(7);
    expect(await espera).toEqual({});
    expect(deps.canal.editar).toHaveBeenCalledWith(CHAT, 7, expect.stringContaining('Retomado en la PC'));
  });

  it('si falla el álbum ya armado no hay rechazo sin atrapar y se avisa por alError', async () => {
    const alError = vi.fn();
    const error = new Error('no se pudo tomar');
    const { p, temas } = armar({ tomar: vi.fn(async () => Promise.reject(error)), alError });
    temas.set('s1', 901);
    await p.atenderUpdate(fotoEn(901, 1));
    await tick();
    await tick();
    expect(alError).toHaveBeenCalledWith(error);
  });

  it('un botón del usuario correcto pero de otro chat se ignora sin contestar', async () => {
    const { p, deps, enviados } = armar();
    const espera = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    let resuelta = false;
    espera.then(() => (resuelta = true));
    await p.atenderUpdate(boton(`${idDe(enviados[0].botones)}:si`, YO, -999));
    await tick();
    expect(resuelta).toBe(false);
    expect(deps.canal.contestarBoton).not.toHaveBeenCalled();
    await p.soltarTodo();
  });

  it('cada texto va a la espera de su propio tema', async () => {
    const { p, temas } = armar();
    const stop1 = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    const stop2 = p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' });
    await tick();
    await tick();
    let uno = false;
    stop1.then(() => (uno = true));
    await p.atenderUpdate(texto('para la dos', temas.get('s2')));
    expect(await stop2).toMatchObject({ reason: expect.stringContaining('para la dos') });
    expect(uno).toBe(false);
    await p.atenderUpdate(texto('para la uno', temas.get('s1')));
    expect(await stop1).toMatchObject({ reason: expect.stringContaining('para la uno') });
  });

  // Final review C1: `escuchar` espera cada update; si esperara el turno tomado, el bot entero se trabaría
  // y un PermissionRequest de ese mismo turno no tendría cómo contestarse.
  it('tomar no traba los updates: vuelve enseguida y el botón de un permiso de ese turno se atiende', async () => {
    const { p, temas, enviados } = armar({ tomar: vi.fn(() => new Promise<void>(() => {})) });
    temas.set('s1', 901);
    const r = await Promise.race([p.atenderUpdate(texto('seguí', 901)).then(() => 'listo'), tick().then(() => 'trabado')]);
    expect(r).toBe('listo');
    const permiso = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    await p.atenderUpdate(boton(`${idDe(enviados.at(-1)!.botones)}:si`));
    expect(await permiso).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
  });

  it('si tomar falla, se avisa por alError', async () => {
    const alError = vi.fn();
    const error = new Error('no');
    const { p, temas } = armar({ tomar: vi.fn(async () => Promise.reject(error)), alError });
    temas.set('s1', 901);
    await p.atenderUpdate(texto('seguí', 901));
    await tick();
    expect(alError).toHaveBeenCalledWith(error);
  });

  // Final review I3: un 429 es "esperá y probá de nuevo", no un error para tirarle al hook.
  it('un 429 de Telegram se reintenta como un error de red', async () => {
    const { p, deps, enviados } = armar();
    const { TelegramError } = await import('./telegram');
    (deps.canal.enviar as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new TelegramError(429, 'Too Many Requests: retry after 0');
    });
    const espera = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    await tick();
    expect(enviados).toHaveLength(1);
    p.soltarTodo();
    expect(await espera).toEqual({});
  });

  // Final review I4: volver a la PC suelta todas las esperas ya; los "Retomado" van después y sin esperarlos.
  it('soltarTodo suelta todas las esperas aunque editar no conteste nunca', async () => {
    const { p, deps } = armar();
    (deps.canal.editar as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const e1 = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    const e2 = p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' });
    await tick();
    await tick();
    void p.soltarTodo();
    const r = await Promise.race([Promise.all([e1, e2]), tick().then(() => 'trabado')]);
    expect(r).toEqual([{}, {}]);
    expect(deps.canal.editar).toHaveBeenCalledTimes(2);
  });

  // Final review M1: una sesión de Desktop no se cierra para seguirla con `claude -p`.
  it('una sesión de Desktop quieta no se toma: se avisa en el tema', async () => {
    const { p, deps, enviados, temas } = armar({ sesiones: async () => [{ ...agente('s1'), origen: 'desktop' }] });
    temas.set('s1', 901);
    await p.atenderUpdate(texto('seguí', 901));
    expect(deps.tomar).not.toHaveBeenCalled();
    expect(enviados.at(-1)).toMatchObject({ texto: 'Es una sesión de Desktop: contestala en Desktop.', tema: 901 });
  });
});
