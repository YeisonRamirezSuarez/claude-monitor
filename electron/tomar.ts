/**
 * Tomar una sesión quieta (spec §6). Una sesión que terminó su turno antes del
 * modo fuera no está en ninguna espera de Stop, así que un mensaje desde
 * Telegram no tiene por dónde entrar. La app cierra el `claude` de su terminal
 * (quieto en el prompt: todo está en el transcript) y sigue con
 * `claude -p --resume`, un turno por mensaje, nunca dos a la vez.
 *
 * `CLAUDE_MONITOR_TOMADA=1` hace que el hook no espere en el Stop de estos
 * turnos: esperar trabaría el proceso `-p` (ver `hooks/remoto-hook.js`).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { iniciosDeProceso, mismoInicio } from './oficina';
import { sessionEnv } from './terminal';

/** Los ids de sesión de Claude Code son UUID (igual que en main.ts). Acá importa doble: con `shell: true` el id llega a `cmd.exe`. */
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Sin el mensaje: ése entra por stdin (ver `lanzarClaude`). */
export function argsTurno(sessionId: string): string[] {
  if (!SESSION_ID.test(sessionId)) throw new Error('Id de sesión inválido.');
  return ['-p', '--chrome', '--resume', sessionId, '--output-format', 'stream-json', '--verbose'];
}

export function textosDe(linea: string): string[] {
  try {
    const e = JSON.parse(linea) as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
    if (e.type !== 'assistant') return [];
    return (e.message?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text!);
  } catch {
    return [];
  }
}

/** `quieta`: la oficina la ve esperando en este instante (la fija quien arma el registro). */
export type Registro = { pid: number; procStart?: string; configDir: string; cwd: string; quieta: boolean };
type Lanzar = (
  args: string[],
  op: { cwd: string; env: NodeJS.ProcessEnv; entrada: string }
) => { stdout: NodeJS.ReadableStream; fin: Promise<number>; matar: () => void };

export class Tomador {
  private cola = new Map<string, Promise<void>>();
  private registros = new Map<string, Registro>();

  constructor(
    private d: {
      registro: (sessionId: string) => Promise<Registro | null>;
      matar: (pid: number, procStart?: string) => Promise<void>;
      lanzar: Lanzar;
      alTexto: (sessionId: string, texto: string) => void;
      alError: (sessionId: string, error: string) => void;
    }
  ) {}

  tomadas(): string[] {
    return [...this.registros.keys()];
  }

  /** Dónde vive una sesión tomada (para seguir listándola aunque ya no tenga terminal). */
  registroDe(sessionId: string): Registro | undefined {
    return this.registros.get(sessionId);
  }

  /** La sesión volvió a la terminal (Reabrir): deja de estar tomada. */
  soltar(sessionId: string): void {
    this.registros.delete(sessionId);
  }

  /** Hay un turno corriendo o en cola: reabrirla ahora pondría una terminal encima del `claude -p`. */
  ocupada(sessionId: string): boolean {
    return this.cola.has(sessionId);
  }

  enviar(sessionId: string, mensaje: string): Promise<void> {
    const antes = this.cola.get(sessionId) ?? Promise.resolve();
    const turno: Promise<void> = antes
      .then(() => this.turno(sessionId, mensaje))
      .catch((e) => this.d.alError(sessionId, String(e?.message ?? e)))
      // Sólo el último de la cola la libera: si atrás vino otro, sigue ocupada.
      .finally(() => {
        if (this.cola.get(sessionId) === turno) this.cola.delete(sessionId);
      });
    this.cola.set(sessionId, turno);
    return turno;
  }

  private async turno(sessionId: string, mensaje: string): Promise<void> {
    // Primero el id: uno inválido no debe llegar a cerrar la terminal de nadie.
    const args = argsTurno(sessionId);
    let reg = this.registros.get(sessionId);
    // Tomada, igual se mira: si alguien la reabrió afuera de la app hay otro pid vivo, y un `-p` encima
    // escribiría el mismo transcript a la vez. Se la trata como sin tomar: quieta se cierra, trabajando no.
    // El pid que se cerró al tomarla puede seguir figurando (su archivo queda hasta 5 min): ése no cuenta.
    const vivo = await this.d.registro(sessionId);
    if (reg && vivo && vivo.pid !== reg.pid) {
      this.registros.delete(sessionId);
      reg = undefined;
    }
    if (!reg) {
      if (!vivo) throw new Error('No encontré la sesión abierta para tomarla.');
      // El chequeo del puente puede haberle ganado de mano a una sesión que
      // justo reanudó: matarla ahí cortaría un turno en curso.
      if (!vivo.quieta) throw new Error('La sesión está trabajando: no la tomo.');
      await this.d.matar(vivo.pid, vivo.procStart);
      reg = vivo;
      this.registros.set(sessionId, reg);
    }
    const env = { ...sessionEnv(process.env, reg.configDir), CLAUDE_MONITOR_TOMADA: '1' };
    const { stdout, fin, matar } = this.d.lanzar(args, { cwd: reg.cwd, env, entrada: mensaje });
    try {
      for await (const linea of createInterface({ input: stdout })) {
        for (const t of textosDe(linea)) this.d.alTexto(sessionId, t);
      }
    } catch (e) {
      // Si algo tira a mitad del turno (p. ej. alTexto), el hijo seguiría vivo
      // mientras la cola arranca el próximo turno: dos a la vez. Se lo mata y
      // se espera a que salga de verdad antes de soltar la cola.
      matar();
      await fin;
      this.soltar(sessionId);
      throw e;
    }
    const codigo = await fin;
    // Un turno que falla suelta la toma (spec §10): no se sigue mandando turnos a ciegas a esa sesión.
    if (codigo !== 0) {
      this.soltar(sessionId);
      this.d.alError(sessionId, `claude -p terminó con código ${codigo}.`);
    }
  }
}

/**
 * Cierra el pid sólo si es el mismo proceso que anotó el registro. Los pid se
 * reciclan en Windows: sin `procStart` no hay forma de confirmarlo, y matar a
 * ciegas puede llevarse un proceso ajeno.
 */
export async function matarSiEsElMismo(pid: number, procStart?: string): Promise<void> {
  if (!procStart) throw new Error('No puedo confirmar el proceso de esa sesión.');
  // Fresco: el caché de 15 s es de la oficina y puede traer el inicio del dueño anterior del pid.
  const inicios = await iniciosDeProceso([pid], Date.now(), true);
  if (!mismoInicio(procStart, inicios.get(pid))) throw new Error('El proceso de esa sesión ya no es el que era.');
  process.kill(pid);
  // Claude Code borra su `sessions/<pid>.json` al cerrar bien; matado no, y ese
  // archivo sigue pareciendo vivo hasta TTL_LATIDO_MS (5 min). Por eso la
  // oficina tiene que ocultar las sesiones tomadas (Tarea 10).
}

/**
 * `shell: true` porque en Windows `claude` puede ser `claude.cmd` (npm) o
 * `claude.exe` (instalador nativo) y sin shell el `.cmd` no arranca. Es seguro
 * porque ningún argumento viene del usuario (el sessionId es un UUID ya
 * validado); el mensaje entra por stdin, donde `cmd.exe` no lo toca.
 */
export function lanzarClaude(args: string[], op: { cwd: string; env: NodeJS.ProcessEnv; entrada: string }) {
  const hijo = spawn('claude', args, { cwd: op.cwd, env: op.env, windowsHide: true, shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
  // Si `claude` muere antes de leer todo, escribir rompe el pipe (EPIPE): el código de salida ya avisa.
  hijo.stdin!.on('error', () => {});
  hijo.stdin!.end(op.entrada);
  const fin = new Promise<number>((ok) => {
    hijo.on('exit', (c) => ok(c ?? 1));
    hijo.on('error', () => ok(1));
  });
  // Con `shell: true` el pid es el de `cmd.exe`: `kill()` a secas lo mata a él y deja huérfano al `claude`. `taskkill /T` se lleva el árbol.
  const matar = () => {
    if (process.platform === 'win32' && hijo.pid) {
      spawn('taskkill', ['/pid', String(hijo.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => hijo.kill());
    } else {
      hijo.kill();
    }
  };
  return { stdout: hijo.stdout!, fin, matar };
}
