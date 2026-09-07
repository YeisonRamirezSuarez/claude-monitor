/**
 * Todo lo específico de WSL vive acá.
 *
 * La regla que ordena el módulo: lo que se puede decidir con una cadena es una
 * función pura y tiene test; lo que necesita hablar con `wsl.exe` es un
 * envoltorio delgado que llama a una de ellas. Sin esa separación, nada de esto
 * se puede probar sin una distro instalada.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Ojo: `terminal.ts` importa de acá (`argsDeLanzamiento`, `posixAWindows`,
// `windowsAPosix`) y esto importa de allá — es un ciclo, a propósito. El cartel
// de la cuenta y el comillado POSIX son de la terminal y viven ahí; traducir
// rutas y armar el argv de `wsl.exe` es de WSL y vive acá. Un ciclo de ESM sólo
// es seguro si NINGUNO de los dos módulos usa un binding del otro en el nivel
// superior: sólo adentro del cuerpo de una función, que corre cuando los dos
// módulos ya terminaron de evaluarse. Nada de `const X = shQuote(...)` acá ni de
// `= WINDOWS` como default de parámetro allá.
import { bannerBash, shQuote } from './terminal';
import type { Entorno, EstadoRaiz } from '../shared/types';

const run = promisify(execFile);

/** El entorno de siempre. Existe para no repetir el literal en cada llamador. */
export const WINDOWS: Entorno = { tipo: 'windows' };

/**
 * Con qué cuenta se abre una sesión.
 *
 * Para Windows es la activa, como siempre: cuál usar es decisión del usuario y
 * `profileForWork` no elige por él. Para una sesión de WSL NO puede ser la
 * activa: el transcript vive en la raíz de esa distro y sólo esa cuenta sabe
 * llegar. Devuelve `null` si esa cuenta ya no existe, para poder explicarlo en
 * vez de abrir una terminal con la cuenta equivocada.
 *
 * La dirección espejo también devuelve `null`, y no es teórica: `visibleProfiles`
 * oculta la cuenta `default` en cuanto hay una propia, así que quien tiene una
 * sola cuenta propia y es de WSL la tiene ACTIVA. Reanudar con ella una sesión
 * de Windows abriría `claude` adentro de la distro con `CLAUDE_CONFIG_DIR`
 * apuntando a un `~/.claude` de Linux que no contiene ese transcript: la ruta
 * traduce bien, el `stat` da bien, y la sesión simplemente no aparece. Un fallo
 * mudo es peor que negarse con una explicación.
 */
export function cuentaParaSesion<T extends { id: string; entorno?: Entorno }>(
  sesion: { entorno: Entorno },
  cuentas: T[],
  activaId: string
): T | null {
  if (sesion.entorno.tipo !== 'wsl') {
    const activa = cuentas.find((c) => c.id === activaId) ?? null;
    return activa && esWsl(activa.entorno) ? null : activa;
  }
  const { distro } = sesion.entorno;
  return cuentas.find((c) => c.entorno?.tipo === 'wsl' && c.entorno.distro === distro) ?? null;
}

/**
 * Si esta cuenta vive en una distro.
 *
 * Centraliza el chequeo: cada punto de escritura por cuenta —el pozo de
 * `projects/`, los plugins, la marca de onboarding, el puente de Chrome— tiene
 * que saltear las cuentas WSL antes de tocar el disco. Medido en esta
 * máquina: tocar la UNC de una distro apagada la ENCIENDE (1,90 s, 345 MB de
 * `vmmemWSL` quedan corriendo), y lo que se escribiría ahí tiene forma de
 * Windows —un junction, un `.bat`, una marca de onboarding— así que además de
 * gastar memoria de más, ensuciaría el `~/.claude` real de esa persona en
 * Linux.
 *
 * Toma `Entorno` en vez de `Profile` completo para servir tanto a los bucles
 * (`esWsl(profile.entorno)`) como a las funciones de una sola cuenta que ya
 * reciben el entorno como parámetro (`esWsl(entorno)`).
 */
export function esWsl(entorno?: Entorno): boolean {
  return entorno?.tipo === 'wsl';
}

/** Si se puede mirar el disco de una raíz sin efectos. Windows: siempre.
 *  WSL: sólo si la distro YA está corriendo — tocar la UNC de una apagada
 *  la enciende (medido: 1,90 s, la distro queda Running con 345 MB). */
export function sePuedeLeer(entorno: Entorno | undefined, corriendo: string[]): boolean {
  if (!esWsl(entorno)) return true;
  return corriendo.includes((entorno as Extract<Entorno, { tipo: 'wsl' }>).distro);
}

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

/**
 * Techo para toda llamada a `wsl.exe`.
 *
 * Esto corre en el proceso main: una llamada que no vuelve congela el panel.
 * Medido: tocar la UNC de una distro apagada tarda 1,90 s, y una distro
 * enferma puede colgar indefinidamente. El resto del proyecto no tiene
 * timeouts y no se los agrega acá: es otro trabajo.
 */
export const TIMEOUT_WSL = 8000;

export function argsDeConsulta(que: 'instaladas' | 'corriendo'): string[] {
  return que === 'corriendo' ? ['-l', '-q', '--running'] : ['-l', '-q'];
}

/**
 * Decodifica lo que escupe `wsl.exe`, que no siempre usa la misma codificación.
 *
 * Medido: la salida propia de wsl.exe —la lista de distros y también sus
 * mensajes de error— viene en UTF-16LE ("Ubuntu" llega como 55 00 62 00 …).
 * La salida de un comando que corre DENTRO de la distro la relaya wsl.exe tal
 * cual, en los bytes del proceso de Linux, que son UTF-8. Decodificar a ciegas
 * cualquiera de las dos rompe la otra —un `$HOME` con acento leído como utf16le
 * queda ilegible, y la lista leída como utf8 queda con un NUL entre cada
 * letra—, así que se mira el dato: los NUL intercalados de UTF-16LE no aparecen
 * en un UTF-8 legítimo, donde 0x00 sólo puede ser el carácter NUL en sí.
 *
 * Alcanza con los primeros 16 bytes: en UTF-16LE, cualquier carácter ASCII
 * —y toda salida de `wsl.exe` empieza con uno— trae su NUL en el byte
 * siguiente, así que si la respuesta no está vacía el NUL aparece dentro de los
 * dos primeros bytes. Mirar el buffer entero sólo agregaría el riesgo de que un
 * NUL perdido en el medio de una salida larga de Linux la haga leer al revés.
 */
export function decodificarSalidaWsl(buf: Buffer): string {
  const asomar = buf.subarray(0, 16);
  return buf.toString(asomar.includes(0) ? 'utf16le' : 'utf8');
}

/** `wsl.exe` no siempre emite en la misma codificación. Con 'buffer' se
 *  decodifica acá, mirando los bytes, y no se depende de la codificación por
 *  defecto del proceso. Ver `decodificarSalidaWsl`. */
async function consultar(que: 'instaladas' | 'corriendo'): Promise<string[]> {
  const { stdout } = await run('wsl.exe', argsDeConsulta(que), {
    encoding: 'buffer',
    timeout: TIMEOUT_WSL,
    windowsHide: true
  }).catch(() => ({ stdout: Buffer.alloc(0) }));
  return parseDistros(decodificarSalidaWsl(Buffer.from(stdout)));
}

export const distrosInstaladas = (): Promise<string[]> => consultar('instaladas');
export const distrosCorriendo = (): Promise<string[]> => consultar('corriendo');

/** El `$HOME` de la distro. Se pregunta UNA vez, al dar de alta, y se persiste
 *  en `Entorno.home`: averiguarlo en cada arranque obligaría a encender la
 *  distro sólo para saber una ruta. */
export async function homeDe(distro: string): Promise<string> {
  const { stdout } = await run('wsl.exe', ['-d', distro, '--exec', 'bash', '-lc', 'echo $HOME'], {
    encoding: 'buffer',
    timeout: TIMEOUT_WSL,
    windowsHide: true
  });
  const home = decodificarSalidaWsl(Buffer.from(stdout)).trim();
  if (!home.startsWith('/')) throw new Error(`No se pudo leer el $HOME de ${distro}`);
  return home;
}

/** Si `claude` está en el PATH de login de la distro. `-l` porque nvm y
 *  compañía viven en el perfil de login. */
export async function hayCliEn(distro: string): Promise<boolean> {
  return run('wsl.exe', ['-d', distro, '--exec', 'bash', '-lc', 'command -v claude'], {
    encoding: 'buffer',
    timeout: TIMEOUT_WSL,
    windowsHide: true
  })
    .then(({ stdout }) => decodificarSalidaWsl(Buffer.from(stdout)).trim().length > 0)
    .catch(() => false);
}

/** Enciende una distro a propósito. Es el ÚNICO lugar del proyecto que lo hace,
 *  y sólo corre porque el usuario apretó el botón: todo el resto del código
 *  evita encenderlas. */
export async function encenderDistro(distro: string): Promise<void> {
  await run('wsl.exe', ['-d', distro, '--exec', 'true'], { timeout: TIMEOUT_WSL, windowsHide: true });
}

/**
 * Una ruta de la distro, vista desde Windows.
 *
 * `/mnt/<letra>/...` se mapea al volumen de Windows directo y NO por la UNC: es
 * literalmente la misma carpeta, y por NTFS se lee 16x más rápido (medido:
 * 0,06 s contra 0,94 s sobre los mismos 16,8 MB).
 *
 * Son funciones puras en vez de `wslpath` para no gastar un proceso —y una
 * distro encendida— cada vez que se muestra una fila de la lista.
 */
export function posixAWindows(distro: string, p: string): string {
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (mnt) {
    const letra = mnt[1].toUpperCase();
    const resto = (mnt[2] ?? '').split('/').filter(Boolean);
    // `['C:'].join('\\')` da 'C:', que es truthy: un `||` de respaldo nunca
    // dispara. Y en Windows 'C:' no es la raíz del volumen: es "el
    // directorio actual de C:", que es otra carpeta. Por eso la rama vacía
    // se decide aparte, no con un fallback.
    return resto.length > 0 ? [`${letra}:`, ...resto].join('\\') : `${letra}:\\`;
  }
  return ['\\\\wsl.localhost', distro, ...p.split('/').filter(Boolean)].join('\\');
}

/** La inversa. No es decorativa: `sessions:new` abre el diálogo de carpeta de
 *  Windows, que devuelve una ruta Windows, y hay que volverla POSIX antes de
 *  pasarla a `--cd`. */
export function windowsAPosix(distro: string, p: string): string {
  // Comparación de prefijo literal, sin distinguir mayúsculas (la UNC no las
  // distingue) — no una RegExp con el nombre de la distro interpolado sin
  // escapar: 'Ubuntu-22.04' ya tiene un punto, que en regex matchea cualquier
  // carácter, y la UNC de otra distro pasaría como si fuera de esta.
  //
  // La raíz pelada (sin barra final, `\\wsl.localhost\Ubuntu`) matchea
  // aparte y no con `startsWith(raiz)`: eso reintroduciría la misma colisión
  // de prefijos de arriba, porque 'Ubuntu' es prefijo de 'Ubuntu-22.04'. Hace
  // falta el chequeo exacto o el separador después de la raíz. La raíz
  // pelada es alcanzable: el diálogo de carpeta de Windows devuelve rutas
  // SIN barra final salvo en la raíz de un volumen.
  const raizUNC = `\\\\wsl.localhost\\${distro}`.toLowerCase();
  const pLower = p.toLowerCase();
  if (pLower === raizUNC || pLower.startsWith(raizUNC + '\\')) {
    const resto = p.slice(raizUNC.length).replace(/^\\/, '');
    return '/' + resto.split('\\').filter(Boolean).join('/');
  }
  const disco = /^([a-zA-Z]):\\?(.*)$/.exec(p);
  if (disco) {
    const resto = disco[2].split('\\').filter(Boolean);
    return ['/mnt', disco[1].toLowerCase(), ...resto].join('/');
  }
  throw new Error(`No sé traducir esta ruta a POSIX: ${p}`);
}

/**
 * El argv de `wsl.exe` para abrir una sesión adentro de la distro.
 *
 * Tres decisiones que valen la pena:
 *
 *   - El `--cd` va como ARGUMENTO, no por la línea del shell. El `cwd` sale de
 *     un `.jsonl` y no es confiable; así nunca lo parsea un shell.
 *   - `CLAUDE_CONFIG_DIR` va por `export` adentro del script y no por `WSLENV`.
 *     `WSLENV` funciona (medido) pero es una variable GLOBAL del proceso que
 *     habría que componer sin pisar lo que el usuario ya tenga: un merge frágil
 *     por una ganancia nula.
 *   - El separador es `--exec` (nunca `--`, ni su alias `-e`). `wsl.exe -- cmd`
 *     corre `cmd` a través del shell DE LOGIN de la distro, que lo re-expande y
 *     re-parsea antes de que llegue a nuestro `bash -lc` — por eso, medido,
 *     `wsl -d Ubuntu -- bash -lc 'X=1; echo "[$X]"'` imprimía `[]`: el `$X` de
 *     afuera ya se había expandido a vacío. `--exec` pasa el argv literal, sin
 *     esa ronda extra, y con ella el `export CLAUDE_CONFIG_DIR=…` de acá abajo
 *     SÍ le llega al script (medido: con `--` salía vacío, con `--exec` salía
 *     el valor). Sin `--exec` el `cwd` y la etiqueta —ninguno de los dos es
 *     confiable— también pasarían por esa ronda extra de shell, que es
 *     exactamente lo que se evita yendo por `--cd` en vez de por el script.
 *
 * `bash -lc` y no `bash -c`: el PATH con `claude` adentro suele venir del
 * perfil de login (nvm y compañía).
 */
export function argsDeLanzamiento(
  distro: string,
  cwdPosix: string,
  configDirPosix: string,
  command: string,
  label: string
): string[] {
  const script = [`export CLAUDE_CONFIG_DIR=${shQuote(configDirPosix)}`, bannerBash(command, label)].join(
    '\n'
  );
  return ['-d', distro, '--cd', cwdPosix, '--exec', 'bash', '-lc', script];
}
