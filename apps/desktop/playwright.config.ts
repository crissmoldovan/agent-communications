import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the built UI, served by Vite's preview, with Tauri's IPC mocked (`e2e/support/mock-ipc.ts`):
 * nothing reaches Rust, a CLI or the network. Run `pnpm run build` first.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: { baseURL: 'http://localhost:4173', viewport: { width: 1200, height: 800 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 800 } } }],
  webServer: {
    command: 'pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    // Never one already running on the port: it may be another build of the app, or not this app at all.
    reuseExistingServer: false,
  },
});
