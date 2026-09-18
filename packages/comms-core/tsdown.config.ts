import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  // The keyring ships a native binary per platform; it stays an optional runtime import.
  external: ['@napi-rs/keyring'],
});
