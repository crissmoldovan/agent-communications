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
  build: {
    target: ['es2022', 'chrome105', 'safari15'],
    // A font is always a file of its own: inlined as a `data:` URI it would be refused, since the content policy has no
    // `font-src` and its `default-src 'self'` allows no `data:`. Anything else keeps Vite's own limit.
    assetsInlineLimit: (file) => (/\.(?:woff2?|ttf|otf)$/i.test(file) ? false : undefined),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Vitest's 5 s is too short on CI's slower macOS Intel runner: a different screen test passed it on each of 0.29.0's
    // dry runs (Settings, Activity, Doctor). 15 s keeps a hang a failure without failing a slow machine.
    testTimeout: 15_000,
  },
});
