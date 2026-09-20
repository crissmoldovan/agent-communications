import { defineConfig } from 'tsdown';

// Bundled like the Gmail package, and for the same reason: `npx @agentcomms/slack` should install one package and
// start immediately. The optional native keychain module is the only thing left external, because it ships a
// binary per platform.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: { resolve: true },
  noExternal: [/.*/],
  external: ['@napi-rs/keyring'],
});
