import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dirActual = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dirActual,
  plugins: [react()],
  resolve: {
    alias: {
      '@mis-cuentas/core': path.resolve(dirActual, '../../packages/core/src/index.ts'),
    },
  },
  build: {
    outDir: path.resolve(dirActual, 'dist'),
    emptyOutDir: true,
  },
});
