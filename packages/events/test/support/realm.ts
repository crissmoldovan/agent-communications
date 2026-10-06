/**
 * A bare ECMAScript realm to run the library in (events phase A plan, decision 3, layer 3).
 *
 * The library, its vector runners and zod are bundled into one browser-platform IIFE, in memory, from
 * `test/realm/entry.ts` — the way `scripts/third-party-licenses.mjs` builds its graphs — and evaluated in a `node:vm`
 * context created with no globals but ECMAScript's own, and with code generation from strings refused, as the desktop
 * app's CSP refuses `'unsafe-eval'`. Nothing of Node's or the web's is there: no `process`, `require`, `Buffer`,
 * timers, `fetch`, `URL`, `TextEncoder` or `console`. So a vector family that passes here and in Node passes without any
 * host, and the same bundle is what `pnpm verify:browser` hands to real browsers.
 *
 * Only strings cross the boundary: a family's name and a vector file's text go in, JSON text comes back.
 */
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'tsdown';

/** The package's own directory. */
export const PACKAGE_ROOT: string = fileURLToPath(new URL('../..', import.meta.url));

/** The IIFE's global: the one name the bundle defines in whatever realm runs it. */
export const REALM_GLOBAL = 'AgentcommsEventsRealm';

/**
 * The browser-platform IIFE bundle of `test/realm/entry.ts`, with everything it imports inlined, as text. Built in
 * memory: nothing is written, and the package's own `tsdown.config.ts` is ignored.
 */
export async function realmBundle(): Promise<string> {
  const handle = await build({
    config: false,
    cwd: PACKAGE_ROOT,
    entry: { realm: 'test/realm/entry.ts' },
    format: 'iife',
    globalName: REALM_GLOBAL,
    platform: 'browser',
    target: 'es2023',
    noExternal: [/.*/],
    write: false,
    dts: false,
    clean: false,
    logLevel: 'silent',
  });
  const chunks = handle.bundles.flatMap((bundle) => bundle.chunks).filter((chunk) => chunk.type === 'chunk');
  if (chunks.length !== 1) throw new Error(`the realm bundle should be one script, and is ${chunks.length}`);
  const [chunk] = chunks;
  if (chunk === undefined || chunk.type !== 'chunk') throw new Error('the realm bundle has no script');
  return chunk.code;
}

/** A realm with the bundle loaded: `run` a vector family in it, or `evaluate` an expression there. */
export interface Realm {
  run(family: string, vectorsJson: string): string;
  evaluate(source: string): unknown;
}

/** A fresh context with ECMAScript's globals and nothing else, code generation off, and the bundle evaluated in it. */
export function createRealm(code: string): Realm {
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  // V8 gives every context a `console` of its own. ECMAScript has none, and the library must not lean on one.
  runInContext('delete globalThis.console;', context);
  runInContext(code, context);
  return {
    run(family, vectorsJson) {
      const result = runInContext(
        `${REALM_GLOBAL}.run(${JSON.stringify(family)}, ${JSON.stringify(vectorsJson)})`,
        context,
      );
      if (typeof result !== 'string') throw new Error(`the realm's run returned ${typeof result}, not text`);
      return result;
    },
    evaluate(source) {
      return runInContext(source, context);
    },
  };
}
