import type { Profile } from '../shared/types';

/**
 * Las cuentas que se muestran y se pueden elegir.
 *
 * La cuenta `default` es `~/.claude`: la instalación real del CLI y el pozo
 * donde viven todas las conversaciones. En cuanto hay al menos una cuenta
 * propia deja de listarse — sigue guardando las sesiones, pero no es una cuenta
 * más para administrar. Si no queda ninguna propia vuelve a aparecer, porque si
 * no la app se quedaría sin cuenta con la que trabajar.
 *
 * "Propia" no alcanza: tiene que poder hospedar las sesiones de Windows. El
 * pozo de Windows SIEMPRE se lista (ver `raices`), así que sus sesiones siempre
 * están en pantalla — las del CLI y también las que deja Claude Desktop cuando
 * trabaja en modo Local, que caen del lado de Windows. Una cuenta WSL no puede
 * reanudar ninguna de ellas: su `~/.claude` es el de adentro de la distro.
 * Ocultando el `default` cuando la única cuenta propia es de WSL, esas
 * sesiones quedan sin ninguna cuenta con la
 * que abrirse y el error de `sessions:resume` manda a elegir una cuenta de
 * Windows que no existe en la lista. Es el caso de quien tiene el CLI sólo
 * adentro de la distro y usa Desktop en Windows.
 */
export function visibleProfiles(profiles: Profile[]): Profile[] {
  const own = profiles.filter((p) => p.id !== 'default');
  return own.some((p) => p.entorno?.tipo !== 'wsl') ? own : profiles;
}

/** La activa, corregida: si apunta a una cuenta que ya no se lista, pasa a la
 *  primera visible. Sin esto, ocultar el pozo dejaría la app trabajando con una
 *  cuenta que el usuario no ve por ningún lado. */
export function effectiveActiveId(profiles: Profile[], activeProfileId: string): string {
  const visible = visibleProfiles(profiles);
  return visible.some((p) => p.id === activeProfileId) ? activeProfileId : visible[0].id;
}
