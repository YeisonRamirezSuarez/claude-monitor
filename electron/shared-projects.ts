import { lstat, mkdir, readdir, rename, rmdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entorno, Profile } from '../shared/types';

/**
 * Hace que todas las cuentas DE WINDOWS vean las mismas conversaciones.
 *
 * Cada cuenta es un CLAUDE_CONFIG_DIR propio, y Claude Code guarda los
 * transcripts en `<configDir>/projects/`. Sin esto, cambiar de cuenta significa
 * empezar de cero, y reanudar una sesión ajena obligaría a copiar el archivo —
 * duplicándolo. Apuntando el `projects` de cada cuenta al mismo directorio
 * real, la conversación es una sola: la cuenta sólo decide qué credenciales
 * (y qué consumo) se usan.
 *
 * Se usa un junction de Windows, que no necesita permisos de administrador.
 * Las credenciales, el consumo y el estado siguen siendo de cada cuenta: lo
 * único compartido es `projects/`.
 *
 * Las cuentas de WSL quedan afuera: su `projects` vive en ext4 y no hay forma
 * de enlazarlo que Windows sepa leer. Ver el spec de WSL, §2.
 */
export async function shareProjects(
  configDir: string,
  sharedRoot: string,
  entorno: Entorno = { tipo: 'windows' }
): Promise<void> {
  // Una cuenta WSL nunca entra al pozo. Medido: no se puede crear un junction
  // de Windows adentro de ext4 ("Función incorrecta"), y un symlink de Linux
  // hacia /mnt/c lo lee WSL pero NO lo lee Windows por la UNC (1 entrada de
  // 31). Intentarlo sólo deja basura.
  if (entorno.tipo === 'wsl') return;
  if (configDir === sharedRoot) return; // la cuenta dueña del pozo

  const link = join(configDir, 'projects');
  const target = join(sharedRoot, 'projects');
  await mkdir(target, { recursive: true });

  const current = await lstat(link).catch(() => null);
  if (current?.isSymbolicLink()) return; // ya apunta al pozo

  if (current?.isDirectory()) {
    // La cuenta ya tenía sesiones propias: se mudan al pozo antes de reemplazar
    // la carpeta. Ante un nombre repetido gana el pozo, porque es lo que el
    // resto de las cuentas ve — y lo repetido no se borra, se aparta.
    for (const slug of await readdir(link)) {
      const from = join(link, slug);
      const to = join(target, slug);
      if (!(await lstat(to).catch(() => null))) {
        await rename(from, to).catch(() => {});
        continue;
      }
      // El proyecto ya existe en el pozo: se mira sesión por sesión.
      for (const entry of await readdir(from).catch(() => [])) {
        if (await lstat(join(to, entry)).catch(() => null)) continue;
        await rename(join(from, entry), join(to, entry)).catch(() => {});
      }
      await rmdir(from).catch(() => {});
    }

    // Lo que sobró son duplicados de algo que el pozo ya tiene. No se borra:
    // se aparta con fecha, para que quede el enlace y el usuario decida.
    if ((await readdir(link).catch(() => [])).length > 0) {
      await rename(link, `${link}.reemplazado-${Date.now()}`);
    } else {
      await rmdir(link).catch(() => {});
    }
    if (await lstat(link).catch(() => null)) return;
  }

  await symlink(target, link, 'junction');
}

/**
 * Corta TODOS los enlaces de una cuenta, sin tocar lo que apuntan.
 *
 * `rmdir` sobre un junction borra el enlace y nada más; un `rm -rf` sobre la
 * carpeta de la cuenta sin hacer esto primero es la diferencia entre quitar una
 * cuenta y borrar el pozo entero.
 *
 * Barre el directorio en vez de mirar una lista de nombres a propósito: la
 * cuenta comparte `projects` y `plugins`, y el día que se comparta algo más,
 * olvidarse de agregarlo acá sería catastrófico y silencioso.
 */
export async function unlinkShared(configDir: string): Promise<void> {
  for (const entry of await readdir(configDir).catch(() => [])) {
    const path = join(configDir, entry);
    const current = await lstat(path).catch(() => null);
    if (current?.isSymbolicLink()) await rmdir(path).catch(() => {});
  }
}

export async function shareAll(profiles: Profile[], sharedRoot: string): Promise<void> {
  for (const profile of profiles) {
    await shareProjects(profile.configDir, sharedRoot).catch(() => {});
  }
}
