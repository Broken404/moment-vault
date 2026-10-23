import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'apps/extension',
  base: './',
  plugins: [react()],
  define: {
    __MV_OWNED_CAPTURE_LAB__: JSON.stringify(process.env.MOMENT_VAULT_OWNED_CAPTURE_LAB === '1'),
  },
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./packages/shared/src', import.meta.url)) },
  },
  build: {
    outDir: '../../dist/extension',
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: {
        manage: fileURLToPath(new URL('./apps/extension/manage.html', import.meta.url)),
        offscreen: fileURLToPath(new URL('./apps/extension/offscreen.html', import.meta.url)),
        worker: fileURLToPath(new URL('./apps/extension/src/background.ts', import.meta.url)),
      },
      output: { entryFileNames: '[name].js' },
    },
  },
});
