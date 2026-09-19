import { defineConfig } from 'tsdown';

// Both entries are fully bundled — Google client libraries, the MCP SDK, commander and comms-core included — so
// `npx @agentcomms/gmail` installs one package and starts in a fraction of a second. The only exception is the
// optional native keychain module, which ships a binary per platform.
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
