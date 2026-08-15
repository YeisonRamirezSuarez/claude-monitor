// Empaqueta el instalador de Windows.
//
// Existe este script en vez de un `electron-builder --win` pelado porque la
// salida NO puede quedar dentro del proyecto: para armar el paquete,
// electron-builder extrae Electron en `win-unpacked.tmp` y despues renombra la
// carpeta, y en esta ruta renombrar directorios da EPERM (lo hace tambien un
// `mv` a mano, asi que es el filtro de OneDrive/antivirus sobre Documentos, no
// electron-builder). Se compila en el temporal del sistema, donde ese filtro no
// esta, y se avisa donde quedo el .exe.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const out = join(tmpdir(), 'claude-monitor-release');

// `shell: true` no es adorno: en Windows el binario es `electron-builder.cmd`,
// y desde Node 20 spawnear un .cmd sin shell falla en silencio.
const result = spawnSync(`npx electron-builder --win -c.directories.output="${out}"`, {
  stdio: 'inherit',
  shell: true
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const installer = readdirSync(out).find((f) => f.endsWith('.exe'));
console.log(`\nInstalador: ${installer ? join(out, installer) : out}`);
