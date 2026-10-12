import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { bundleGraphPlugin } from './scripts/bundle-content-graph.mjs';

export default defineConfig({
  plugins: [react(), bundleGraphPlugin()],
  build: {
    outDir: process.env.DESKTOP_DIST_DIR ?? 'dist',
    rollupOptions: {
      input: {
        settings: resolve(import.meta.dirname, 'settings.html'),
        secrets: resolve(import.meta.dirname, 'secrets.html'),
      },
    },
  },
});
