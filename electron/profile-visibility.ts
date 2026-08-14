import type { Profile } from '../shared/types';

/**
 * Las cuentas que se muestran y se pueden elegir.
 *
 * La cuenta `default` es `~/.claude`: la instalación real del CLI y el pozo
 * donde viven todas las conversaciones. En cuanto hay al menos una cuenta
 * propia deja de listarse — sigue guardando las sesiones, pero no es una cuenta
 * más para administrar. Si no queda ninguna propia vuelve a aparecer, porque si
 * no la app se quedaría sin cuenta con la que trabajar.
 */
export function visibleProfiles(profiles: Profile[]): Profile[] {
  const own = profiles.filter((p) => p.id !== 'default');
  return own.length > 0 ? own : profiles;
}

/** La activa, corregida: si apunta a una cuenta que ya no se lista, pasa a la
 *  primera visible. Sin esto, ocultar el pozo dejaría la app trabajando con una
 *  cuenta que el usuario no ve por ningún lado. */
export function effectiveActiveId(profiles: Profile[], activeProfileId: string): string {
  const visible = visibleProfiles(profiles);
  return visible.some((p) => p.id === activeProfileId) ? activeProfileId : visible[0].id;
}
