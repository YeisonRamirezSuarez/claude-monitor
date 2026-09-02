import { app } from 'electron';

/**
 * Quedarse con el protocolo `claude://` para que el login de Google funcione
 * cuenta por cuenta.
 *
 * El problema que resuelve: Desktop manda el login de Google al navegador del
 * sistema, y la respuesta vuelve por un enlace `claude://`. Ese enlace no lo
 * resuelve el navegador sino Windows, que se lo entrega al handler REGISTRADO
 * del protocolo. El registro es por usuario de Windows, no por
 * `--user-data-dir`, así que la respuesta aterriza siempre en la misma
 * instancia de Desktop — la de siempre — y la cuenta nueva queda guardada ahí,
 * mientras la ventana que la estaba pidiendo se queda vacía.
 *
 * Por qué tomar el protocolo lo arregla: el propio Desktop decide así.
 *
 *     app.isDefaultProtocolClient('claude')
 *       ? navegador del sistema
 *       : (log('Not the claude:// handler; keeping ASWebAuth'), quedarse adentro)
 *
 * Si Desktop no es el handler, ni siquiera sale al navegador: hace el login
 * dentro de su propia ventana, que es la de esa cuenta y nada más. El viaje de
 * ida y vuelta desaparece, y con él el problema.
 *
 * A cambio, los enlaces `claude://` del sistema llegan a esta app, así que hay
 * que reenviarlos — de eso se ocupa el llamador, con la cuenta activa. Y se
 * puede devolver cuando el usuario quiera: `soltar()` deshace el registro.
 *
 * Los enlaces que la app le pasa a Desktop para abrir una carpeta o reanudar
 * una sesión no pasan por acá: van como argumento de línea de comandos
 * directo al ejecutable, así que no dependen de quién tenga el protocolo.
 */

export const ESQUEMA = 'claude';

/**
 * Sólo la app EMPAQUETADA se registra. En desarrollo, nunca.
 *
 * En desarrollo el ejecutable es `electron.exe`, así que el registro tiene que
 * llevar además la ruta del proyecto como argumento aparte — es la única forma
 * de que Windows sepa qué app abrir. Esa ruta acá tiene un espacio
 * ("mi repositorio"), y aunque Electron la escribe entrecomillada, ese
 * mecanismo pasó por varios reinicios de `npm run dev` reescribiendo el
 * registro cada vez, y una invocación real terminó llegando con la ruta
 * partida en el espacio: Electron mostró su pantalla de "Unable to find
 * Electron app at …\mi" — la de bienvenida sin proyecto, no un error de esta
 * app. Es una fragilidad conocida de registrar protocolos en modo desarrollo
 * de Electron en Windows, no algo que se pueda blindar del todo con más
 * comillas: cada reinicio del dev server es un ejecutable con un pid distinto
 * disputándose el mismo registro.
 *
 * En empaquetado no hay ese problema: el registro es un único ejecutable fijo,
 * sin argumento de proyecto que se pueda partir.
 */
function podemosRegistrar(): boolean {
  return app.isPackaged;
}

export function tenemosElProtocolo(): boolean {
  return podemosRegistrar() && app.isDefaultProtocolClient(ESQUEMA);
}

export function tomar(): boolean {
  return podemosRegistrar() && app.setAsDefaultProtocolClient(ESQUEMA);
}

export function soltar(): boolean {
  if (!podemosRegistrar()) return true; // nada que soltar en desarrollo
  return app.removeAsDefaultProtocolClient(ESQUEMA);
}

/**
 * El enlace `claude://` que venga en una línea de comandos, o `null`.
 *
 * Windows entrega el enlace como un argumento más, mezclado con los del propio
 * Electron, y su posición cambia entre el arranque en frío y el aviso de
 * segunda instancia. Se busca por el esquema y no por el índice.
 *
 * Se ignora todo lo que no sea exactamente este esquema: la línea de comandos
 * de una segunda instancia la puede escribir cualquiera, y esto termina siendo
 * un argumento para un ejecutable.
 */
export function enlaceEn(argv: string[]): string | null {
  return argv.find((a) => a.toLowerCase().startsWith(`${ESQUEMA}://`)) ?? null;
}
