import { defineConfig } from 'tsdown';

// One output, `dist/index.mjs` with its declarations, for Node and for a browser bundler alike.
//
// `platform: 'neutral'`, not `node`: the library runs in a browser's webview as well as in Node, so the build adds no
// Node resolution, no Node shims and nothing a browser would lack — the isomorphism guard
// (`test/isomorphic.test.ts`) refuses a `node:` import or a host global in this output as it does in the source.
// zod is left external, a dependency rather than inlined code, because an event definition's schema is a zod schema
// (design 2026-10-05, D3) and a consumer that validates with it must share one zod with this package.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'neutral',
  target: 'es2023',
  fixedExtension: true,
  dts: true,
  clean: true,
});
