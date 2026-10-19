import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { prepaintSource } from './src/theme.ts';

/**
 * Puts the pre-paint script first in `<head>`, so the stored theme is stamped before anything paints. It is the only
 * inline script in the bundle, and the content policy names its hash (`tauri.conf.json`).
 */
function prepaint(): Plugin {
  return {
    name: 'agent-comms-prepaint',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'script', children: prepaintSource(), injectTo: 'head-prepend' }],
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), prepaint()],
  clearScreen: false,
  build: { target: ['es2022', 'chrome105', 'safari15'] },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
