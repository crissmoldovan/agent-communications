import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        settings: resolve(import.meta.dirname, 'settings.html'),
        secrets: resolve(import.meta.dirname, 'secrets.html'),
      },
    },
  },
});
