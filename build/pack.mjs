// Empaqueta el instalador y el portable de Windows.
//
// Existe este script en vez de un `electron-builder --win` pelado porque la
// salida NO puede ARMARSE dentro del proyecto: para armar el paquete,
// electron-builder extrae Electron en `win-unpacked.tmp` y despues renombra la
// carpeta, y en esta ruta renombrar directorios da EPERM (lo hace tambien un
// `mv` a mano, asi que es el filtro de OneDrive/antivirus sobre Documentos, no
// electron-builder). Se compila en el temporal del sistema, donde ese filtro no
// esta, y despues se copian los .exe a `release/` del proyecto: copiar un
// archivo suelto si funciona, lo que falla es renombrar directorios.
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = join(tmpdir(), 'claude-monitor-release');
const out = join(process.cwd(), 'release');

// Limpiar el temporal para no copiar exe viejos de builds anteriores.
rmSync(tmp, { recursive: true, force: true });

// `shell: true` no es adorno: en Windows el binario es `electron-builder.cmd`,
// y desde Node 20 spawnear un .cmd sin shell falla en silencio.
const result = spawnSync(`npx electron-builder --win -c.directories.output="${tmp}"`, {
  stdio: 'inherit',
  shell: true
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const exes = readdirSync(tmp).filter((f) => f.endsWith('.exe'));
if (exes.length === 0) {
  console.error(`No se genero ningun .exe en ${tmp}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
console.log('');
for (const exe of exes) {
  const destino = join(out, exe);
  copyFileSync(join(tmp, exe), destino);
  console.log(`${exe.includes('Setup') ? 'Instalador' : 'Portable  '}: ${destino}`);
}
