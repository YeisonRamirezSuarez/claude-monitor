import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { build: { lib: { entry: 'electron/main.ts' } } },
  // El preload se emite como CommonJS a propósito. Con "type": "module" la
  // salida por defecto es preload.mjs, y Electron sólo carga un preload ESM si
  // se apaga el sandbox — que es justo lo que no queremos apagar. En CJS el
  // preload corre con el sandbox activo.
  preload: {
    build: {
      lib: { entry: 'electron/preload.ts' },
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'preload.cjs' } }
    }
  },
  renderer: {
    root: '.',
    plugins: [react()],
    build: { rollupOptions: { input: 'index.html' } }
  }
});
