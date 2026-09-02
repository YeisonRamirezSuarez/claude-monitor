import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * El registro de lo que hace la app, para poder verlo desde la app.
 *
 * Existe porque lo que se rompe acá se rompe afuera del panel: en el
 * ejecutable que se lanzó, en el enlace que Windows entregó a otro lado, en la
 * ventana de Desktop que no era. Nada de eso se ve en la interfaz, y pedirle al
 * usuario que abra un `.log` enterrado en AppData para poder ayudarlo es
 * pedirle que haga de programador.
 *
 * Dos destinos, a propósito. En memoria para mostrarlo al toque, y en un
 * archivo para que sobreviva a un reinicio de la app — que es justo lo que pasa
 * cuando algo sale mal.
 */

const MAX = 400;
const enMemoria: string[] = [];

const carpeta = () =>
  join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'claude-monitor', 'logs');

export const archivoDeRegistro = () => join(carpeta(), 'panel.log');

/** La hora local en formato corto: esto se lee al lado de los logs de Desktop,
 *  que usan la hora local, y compararlos es la mitad del trabajo. */
function ahora(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Anota una línea. Nunca lanza: un registro que rompe la acción que estaba
 * registrando es peor que no tener registro.
 */
export function anotar(mensaje: string, detalle?: Record<string, unknown>): void {
  const extra = detalle
    ? ' ' +
      Object.entries(detalle)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
    : '';
  const linea = `${ahora()} ${mensaje}${extra}`;
  enMemoria.push(linea);
  if (enMemoria.length > MAX) enMemoria.splice(0, enMemoria.length - MAX);
  void mkdir(carpeta(), { recursive: true })
    .then(() => appendFile(archivoDeRegistro(), `${linea}\n`, 'utf8'))
    .catch(() => {});
}

export function leer(): string[] {
  return [...enMemoria];
}

/**
 * Las líneas que importan del log de una ventana de Claude Desktop.
 *
 * Ese archivo tiene miles de líneas por arranque —plugins, memoria, gráficos—
 * y las tres que sirven se pierden ahí. Se filtra por lo que decide el destino
 * de un login o de una conversación: a dónde fue la autorización, si el enlace
 * llegó, y si la importación falló.
 */
export function lineasUtiles(log: string, cuantas = 40): string[] {
  const interesa =
    /Auth\]|system browser|ASWebAuth|deep link|second-instance|import CLI session|Imported CLI session|PlantDetected|refused|sign-in/i;
  return log
    .split(/\r?\n/)
    .filter((l) => interesa.test(l))
    .slice(-cuantas);
}

/** El log de la ventana de Desktop de una cuenta, ya filtrado. */
export async function registroDeDesktop(userDataDir: string, cuantas = 40): Promise<string[]> {
  const raw = await readFile(join(userDataDir, 'logs', 'main.log'), 'utf8').catch(() => null);
  return raw === null ? [] : lineasUtiles(raw, cuantas);
}
