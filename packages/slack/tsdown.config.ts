import { defineConfig } from 'tsdown';

// Both entries are fully bundled — commander and comms-core included — for the same reason the Gmail package is:
// `npx @agentcomms/slack` should install one package and start immediately. The optional native keychain module
// is the only thing left external, because it ships a binary per platform.
export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: { resolve: true },
  noExternal: [/.*/],
  external: ['@napi-rs/keyring'],
});
