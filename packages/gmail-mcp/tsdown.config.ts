import { defineConfig } from 'tsdown';

// A thin bin over @cloudpixel/gmail, which stays a real dependency pinned to the same version: the server and the
// `agent-gmail` command are then always the same code, rather than two copies that can drift.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  noExternal: [/.*/],
  external: ['@cloudpixel/gmail', '@napi-rs/keyring'],
});
