/**
 * Quién tiene una conversación abierta en este momento.
 *
 * Claude Code —el CLI y también Desktop— anota cada sesión viva en
 * `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`, y la refresca cada tanto. Ese es
 * el registro que Desktop consulta antes de adoptar una sesión: si la ve viva,
 * se niega. Verificado en su bundle:
 *
 *   sessionsDirPath() { return join(this.claudeConfigDir ?? …, "sessions") }
 *   …readdir(e).filter(e => /^\d+\.json$/.test(e.name))…
 *   now - (updatedAt ?? startedAt ?? 0) >= TTL || (pid válido && proceso vivo)
 *
 * y su negativa:
 *
 *   liveOwnershipRefusal(…) -> WT.Running
 *   "imported transcript … may be in use by a running Claude Code process"
 *
 * La negativa está bien: dos procesos escribiendo el mismo transcript lo
 * rompen. Lo que estaba mal era que el usuario no se enteraba — abría Desktop,
 * la conversación llegaba incompleta y nadie decía por qué. Leyendo el mismo
 * registro se puede decir exactamente quién la tiene y dónde cerrarla.
 *
 * La regla se copia de Desktop, no se inventa: hace falta latido fresco Y
 * proceso vivo. Un `.json` que quedó de un proceso muerto no cuenta — hay
 * varios así en cualquier máquina con uso real.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Entorno } from '../shared/types';
import { TIMEOUT_WSL } from './wsl';

const run = promisify(execFile);

/** Lo que hace falta de una entrada del registro. Los demás campos que trae
 *  —`bridgeSessionId`, `peerProtocol`, `name`…— no se usan acá. */
export type SesionViva = {
  sessionId: string;
  pid: number;
  /** `cli` o `claude-desktop`. Es lo que permite decirle al usuario DÓNDE
   *  cerrarla, en vez de un "está en uso" que no lleva a ningún lado. */
  entrypoint?: string;
  kind?: string;
  cwd?: string;
  /** El espacio de nombres del pid: `win32:<host>` en Windows. Adentro de una
   *  distro es otro, y un pid de Linux comparado contra los de Windows daría
   *  cualquier cosa. */
  pidDomain?: string;
  startedAt?: number;
  updatedAt?: number;
};

/**
 * Cuánto puede hacer que no late una sesión para seguir contando como viva.
 *
 * Desktop tiene su propia constante y no está a la vista en su bundle, así que
 * esto es una aproximación. Lo que la hace segura es algo que sí se midió acá:
 * al cerrar bien una sesión, Claude Code BORRA su `<pid>.json` —se vio
 * desaparecer uno entre dos lecturas—. O sea que cerrar la otra ventana
 * destraba al instante y el TTL no entra en juego; sólo cubre al proceso que
 * murió de mala manera y dejó el archivo. Esos, en una máquina con uso real,
 * llevan HORAS sin latir (medidos: 15.907 s y 78.770 s), no minutos.
 */
export const TTL_LATIDO_MS = 5 * 60 * 1000;

/**
 * Valida una entrada del registro. Devuelve `null` en vez de lanzar: un
 * archivo raro adentro de `sessions/` no puede tumbar el panel, y lo que
 * corresponde con uno que no se entiende es ignorarlo.
 */
export function parseSesionViva(texto: string): SesionViva | null {
  let entrada: unknown;
  try {
    entrada = JSON.parse(texto);
  } catch {
    return null;
  }
  if (typeof entrada !== 'object' || entrada === null) return null;
  const e = entrada as Record<string, unknown>;
  if (typeof e.sessionId !== 'string' || !e.sessionId) return null;
  if (typeof e.pid !== 'number' || !Number.isInteger(e.pid) || e.pid <= 0) return null;
  return {
    sessionId: e.sessionId,
    pid: e.pid,
    entrypoint: typeof e.entrypoint === 'string' ? e.entrypoint : undefined,
    kind: typeof e.kind === 'string' ? e.kind : undefined,
    cwd: typeof e.cwd === 'string' ? e.cwd : undefined,
    pidDomain: typeof e.pidDomain === 'string' ? e.pidDomain : undefined,
    startedAt: typeof e.startedAt === 'number' ? e.startedAt : undefined,
    updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : undefined
  };
}

/** Si el latido todavía sirve. `updatedAt` y si no `startedAt`, igual que
 *  Desktop; sin ninguno de los dos la entrada no dice nada y no cuenta. */
export function lateTodavia(e: SesionViva, ahoraMs: number, ttlMs = TTL_LATIDO_MS): boolean {
  const ultimo = e.updatedAt ?? e.startedAt;
  return ultimo !== undefined && ahoraMs - ultimo < ttlMs;
}

/** Cómo nombrarle al usuario lo que tiene tomada la conversación. Nada de
 *  `entrypoint` crudo: lo que necesita saber es qué ventana cerrar. */
export function dondeEstaAbierta(e: SesionViva): string {
  if (e.entrypoint === 'claude-desktop') return 'Claude Desktop';
  if (e.entrypoint === 'cli') return 'una terminal';
  return 'otro Claude Code';
}

/**
 * Si ese pid sigue corriendo. En Windows contesta el SO con la señal 0;
 * adentro de una distro hay que preguntar AHÍ, porque el pid es de Linux y de
 * este lado no significa nada.
 *
 * Ojo con cuánto vale esta respuesta en Windows: los pid se reciclan, y en la
 * prueba contra el registro real de esta máquina las SIETE entradas —incluidas
 * las de procesos muertos hace 21 horas— daban "vivo", porque otros procesos
 * habían heredado esos números. Desktop se cubre guardando además `procStart`
 * y comparándolo. Acá no: el que decide de verdad es el latido, y esto es el
 * chequeo barato que lo acompaña.
 */
async function procesoVivo(pid: number, entorno: Entorno): Promise<boolean> {
  if (entorno.tipo === 'wsl') {
    return run('wsl.exe', ['-d', entorno.distro, '--exec', 'kill', '-0', String(pid)], {
      timeout: TIMEOUT_WSL,
      windowsHide: true
    })
      .then(() => true)
      .catch(() => false);
  }
  try {
    // No mata nada: la señal 0 sólo pregunta. EPERM significa que existe pero
    // es de otro usuario, y para lo que se decide acá eso es "vivo".
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Quién tiene abierta esta conversación, si es que alguien.
 *
 * Mira el `sessions/` de VARIAS carpetas, no de una: el registro vive en
 * `<CLAUDE_CONFIG_DIR>/sessions`, y cada cuenta del panel es su propio
 * CLAUDE_CONFIG_DIR. Comparten el `projects/` —el transcript es uno solo—
 * pero cada una anota sus sesiones vivas en SU carpeta. Medido en esta
 * máquina: `~/.claude/sessions` sin ningún `<pid>.json`, y seis vivos en el
 * `sessions` de la cuenta con la que se estaba trabajando. Mirando sólo la
 * raíz, una conversación abierta en la terminal de cualquier cuenta que no
 * sea la principal parecía libre, Desktop la adoptaba y la reescribía mientras
 * el CLI la seguía escribiendo. Por eso el llamador pasa la raíz Y las
 * carpetas de todas las cuentas que la comparten (ver `registrosDe` en
 * main.ts).
 *
 * Esto es también lo que ni el CLI ni Desktop pueden hacer solos: cada uno
 * mira únicamente su propio `sessions/`, así que el guard de "running in
 * another terminal" del CLI no ve a Desktop, ni Desktop a una terminal de
 * otra cuenta. El panel es el único que conoce todas las carpetas.
 *
 * Nunca lanza: no poder mirar un registro no puede impedir abrir nada, que en
 * el peor caso se negará el otro programa y ahí sí no se sabrá por qué.
 */
export async function quienLaTiene(
  configDirs: string[],
  sessionId: string,
  entorno: Entorno,
  ahoraMs = Date.now()
): Promise<SesionViva | null> {
  for (const configDir of new Set(configDirs)) {
    const dir = join(configDir, 'sessions');
    const archivos = await readdir(dir).catch(() => [] as string[]);
    for (const nombre of archivos) {
      // El mismo filtro que Desktop: sólo `<pid>.json`. Adentro de esa carpeta
      // también viven los `.key`, que no son entradas de sesión.
      if (!/^\d+\.json$/.test(nombre)) continue;
      const ruta = join(dir, nombre);
      // Un archivo enorme no se lee entero para sacarle cuatro campos.
      const tam = await stat(ruta).catch(() => null);
      if (!tam || tam.size > 64 * 1024) continue;
      const texto = await readFile(ruta, 'utf8').catch(() => null);
      if (texto === null) continue;
      const entrada = parseSesionViva(texto);
      if (!entrada || entrada.sessionId !== sessionId) continue;
      if (!lateTodavia(entrada, ahoraMs)) continue;
      if (!(await procesoVivo(entrada.pid, entorno))) continue;
      return entrada;
    }
  }
  return null;
}
