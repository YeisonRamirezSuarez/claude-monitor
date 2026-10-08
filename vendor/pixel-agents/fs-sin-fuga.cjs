// Propio de claude-monitor (no es de Pixel Agents): se carga con `--require`
// antes de `dist/cli.js` (ver `electron/pixel-agents.ts`).
//
// El Node de Electron 33 (20.18.3) pierde memoria nativa en dos llamadas:
// `readFileSync(p, 'utf8')` (~500 B cada una) y `existsSync` de un archivo que
// existe (~500 B). El servidor relee los `.meta.json` de los subagentes de cada
// sesión cada 3 s: ~350 lecturas por segundo, ~10 MB por minuto. En un día y
// medio llegaba a 12 GB, casi todo en el archivo de paginación, hasta que se
// caía sin memoria. El heap de JS se mantenía en ~20 MB.
// Leer como Buffer y `statSync` no pierden; el Node 22 de la PC tampoco.
// ponytail: sacarlo cuando Electron traiga un Node sin la fuga; medirlo con
// `readFileSync(p, 'utf8')` en un bucle y la memoria privada del proceso.
const fs = require('fs');

const leer = fs.readFileSync;
fs.readFileSync = function readFileSync(ruta, opciones) {
  const codificacion = typeof opciones === 'string' ? opciones : opciones?.encoding;
  if (codificacion !== 'utf8' && codificacion !== 'utf-8') return leer.apply(this, arguments);
  const resto = typeof opciones === 'object' ? { ...opciones, encoding: null } : undefined;
  return leer.call(this, ruta, resto).toString('utf8');
};

fs.existsSync = function existsSync(ruta) {
  try {
    return fs.statSync(ruta, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
};
