import { defineConfig } from 'tsdown';

// Third-party code is bundled, as the channels do. The workspace packages the service depends on stay real runtime
// dependencies pinned to its version — core, the events library and Gmail, whose event source it calls — so the
// daemon and `agent-gmail` are always the same code rather than two copies that drift. The native keychain module
// ships a binary per platform and must never be inlined: core loads it, optionally, where it is installed.
export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: { resolve: true },
  noExternal: [/.*/],
  external: [
    '@agentcomms/core',
    '@agentcomms/events',
    '@agentcomms/gmail',
    '@agentcomms/resend',
    '@agentcomms/slack',
    '@agentcomms/whatsapp',
    '@napi-rs/keyring',
  ],
});
