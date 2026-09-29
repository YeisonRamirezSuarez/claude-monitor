/**
 * Si el usuario está fuera de la PC (spec §7). En orden: lo manual (`/fuera`,
 * `/vuelvo` o el interruptor de la app), la tapa cerrada, y la inactividad de
 * teclado y mouse. La tapa importa porque el portátil queda prendido con la tapa
 * cerrada y nunca se bloquea: sin eso habría que esperar todo el umbral. Pero
 * no le gana al teclado ni al mouse (con un monitor externo se trabaja con la
 * tapa cerrada): sólo adelanta el umbral a un minuto sin tocar nada.
 */

import { spawn } from 'node:child_process';

export type Motivo = 'manual' | 'tapa' | 'inactividad';
export type EstadoPresencia = { fuera: boolean; motivo: Motivo | null };

const TAPA_SEG = 60;

export function evaluar(
  e: { manual: boolean | null; tapaCerrada: boolean | null; inactivoSeg: number },
  umbralMin: number
): EstadoPresencia {
  if (e.manual !== null) return { fuera: e.manual, motivo: 'manual' };
  if (e.tapaCerrada === true && e.inactivoSeg >= TAPA_SEG) return { fuera: true, motivo: 'tapa' };
  if (e.inactivoSeg >= umbralMin * 60) return { fuera: true, motivo: 'inactividad' };
  return { fuera: false, motivo: null };
}

export class Presencia {
  private manual: boolean | null = null;
  private tapaCerrada: boolean | null = null;
  private actual: EstadoPresencia = { fuera: false, motivo: null };

  constructor(
    private inactivoSeg: () => number,
    private umbralMin: number,
    private alCambiar: (e: EstadoPresencia) => void
  ) {}

  estado(): EstadoPresencia {
    return this.actual;
  }

  setManual(v: boolean | null): void {
    this.manual = v;
    this.revisar();
  }

  /**
   * Un cambio de la tapa gana sobre lo manual: abrirla es volver, cerrarla es irse.
   * Windows manda el estado actual al registrarse y puede repetirlo; eso no es cambiar la tapa.
   */
  setTapa(cerrada: boolean): void {
    if (cerrada === this.tapaCerrada) return; // Sin cambio real
    const esPrimeraVez = this.tapaCerrada === null;
    this.tapaCerrada = cerrada;
    if (!esPrimeraVez) this.manual = null; // Solo borra lo manual en cambios reales
    this.revisar();
  }

  setUmbral(min: number): void {
    this.umbralMin = min;
    this.revisar();
  }

  revisar(): void {
    const nuevo = evaluar({ manual: this.manual, tapaCerrada: this.tapaCerrada, inactivoSeg: this.inactivoSeg() }, this.umbralMin);
    if (nuevo.fuera === this.actual.fuera && nuevo.motivo === this.actual.motivo) return;
    const cambioFuera = nuevo.fuera !== this.actual.fuera;
    this.actual = nuevo;
    if (cambioFuera) this.alCambiar(nuevo);
  }
}

/** Lanza `tapa.ps1` y avisa cada cambio. Si no arranca, no pasa nada: queda la inactividad. */
export function lanzarAyudanteTapa(ruta: string, alCambiar: (cerrada: boolean) => void): () => void {
  const hijo = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ruta], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  });
  let resto = '';
  hijo.stdout?.on('data', (d: Buffer) => {
    resto += d.toString();
    const lineas = resto.split(/\r?\n/);
    resto = lineas.pop() ?? '';
    for (const l of lineas) {
      const m = /^lid ([01])$/.exec(l.trim());
      if (m) alCambiar(m[1] === '0');
    }
  });
  hijo.on('error', () => {});
  return () => {
    hijo.stdin?.end();
    hijo.kill();
  };
}
