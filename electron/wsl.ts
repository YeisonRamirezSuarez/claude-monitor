/**
 * Todo lo específico de WSL vive acá.
 *
 * La regla que ordena el módulo: lo que se puede decidir con una cadena es una
 * función pura y tiene test; lo que necesita hablar con `wsl.exe` es un
 * envoltorio delgado que llama a una de ellas. Sin esa separación, nada de esto
 * se puede probar sin una distro instalada.
 */

import type { EstadoRaiz } from '../shared/types';

/**
 * Los nombres de distro que salen de `wsl -l -q` (o `wsl -l -q --running`).
 *
 * `wsl.exe` emite UTF-16LE, no UTF-8. Medido en esta máquina:
 *
 *   55 00 62 00 75 00 6E 00 74 00 75 00 0D 00 0A 00   →  "Ubuntu\r\n"
 *
 * El llamador tiene que decodificar con `utf16le`. Igual se limpian los NUL
 * acá: si alguien decodifica mal, el síntoma sería un nombre de distro con
 * NUL adentro que no matchea nada y falla de forma muda — y un fallo mudo en
 * una lista de cuentas es lo peor que puede pasar.
 *
 * Con `--running` y nada corriendo la salida es de CERO bytes, así que la
 * lista vacía es un resultado normal y no un error.
 */
export function parseDistros(stdout: string): string[] {
  return stdout
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0);
}

/**
 * La carpeta de configuración de Claude Code de una distro, vista desde
 * Windows.
 *
 * Se guarda en forma UNC y no POSIX a propósito: `credentials.ts`, `usage.ts`,
 * `onboarding.ts` y `sessions.ts` ya reciben un `configDir` y lo leen con
 * `node:fs`, y está verificado que `node:fs` lee, escribe y borra sobre
 * `\\wsl.localhost\...`. Con la UNC esos cuatro módulos no se tocan.
 *
 * El `home` viene de preguntarle a la distro (`echo $HOME`) UNA vez, al dar de
 * alta la cuenta: el usuario de Linux no tiene por qué ser el de Windows, y
 * averiguarlo en cada arranque obligaría a encender la distro sólo para eso.
 */
export function configDirUNC(distro: string, home: string): string {
  if (!home.startsWith('/')) {
    throw new Error(`El $HOME de ${distro} tiene que ser una ruta absoluta: ${home}`);
  }
  const partes = home.split('/').filter(Boolean);
  return ['\\\\wsl.localhost', distro, ...partes, '.claude'].join('\\');
}

/**
 * En qué estado está la raíz de una cuenta WSL.
 *
 * Es pura y recibe lo ya averiguado, para poder probar la tabla entera sin una
 * distro. El orden de los casos importa: `apagada` va ANTES que `sin-config` y
 * `sin-cli` porque con la distro apagada esas dos cosas no se pueden mirar sin
 * encenderla, y encenderla de rebote es exactamente lo que no se hace.
 */
export function estadoDeRaiz(args: {
  distro: string;
  /** Lo que devolvió `wsl -l -q --running`. */
  corriendo: string[];
  /** Lo que devolvió `wsl -l -q`. Si no se pasa, no se chequea. */
  instaladas?: string[];
  hayConfig: boolean;
  hayCli: boolean;
}): EstadoRaiz {
  const { distro, corriendo, instaladas, hayConfig, hayCli } = args;

  if (instaladas && !instaladas.includes(distro)) {
    return { tipo: 'sin-distro', mensaje: `La distro ${distro} ya no está` };
  }
  if (!corriendo.includes(distro)) {
    return { tipo: 'apagada', mensaje: 'Distro apagada' };
  }
  if (!hayConfig) {
    return { tipo: 'sin-config', mensaje: 'No hay Claude Code configurado ahí' };
  }
  if (!hayCli) {
    return { tipo: 'sin-cli', mensaje: `Falta el CLI en ${distro}` };
  }
  return { tipo: 'ok' };
}
