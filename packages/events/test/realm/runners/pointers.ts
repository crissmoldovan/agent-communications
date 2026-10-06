import type { Runner } from './types.ts';

type Pattern = readonly (string | { readonly any: true })[];

/** One vector of `test/vectors/pointers.json`: what goes in, and what must come out, or the code that refuses it. */
type PointerVector = { readonly name: string; readonly refused?: string } & (
  | { readonly kind: 'parse'; readonly pointer: string; readonly tokens?: readonly string[] }
  | { readonly kind: 'format'; readonly tokens: readonly (string | number)[]; readonly pointer?: string }
  | {
      readonly kind: 'get';
      readonly document: unknown;
      readonly pointer: string;
      readonly found?: boolean;
      readonly value?: unknown;
    }
  | { readonly kind: 'relate'; readonly a: string; readonly b: string; readonly relation?: string }
  | {
      readonly kind: 'expand';
      readonly pattern: Pattern;
      readonly document: unknown;
      readonly pointers?: readonly string[];
    }
  | { readonly kind: 'match'; readonly pattern: Pattern; readonly pointer: string; readonly matches?: boolean }
);

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : `not an EventsError: ${String(error)}`;

/** `parsePointer`, `formatPointer`, `getPointer`, `relatePointers`, `expandPattern` and `matchesPattern`. */
export const pointersRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  // Values are compared as canonical JSON, which reads own properties only, as the pointers do.
  const same = (a: unknown, b: unknown) => library.canonicalJson(a) === library.canonicalJson(b);
  for (const vector of file.vectors as readonly PointerVector[]) {
    const fail = (why: string) => failures.push(`${vector.name}: ${why}`);
    let outcome: unknown;
    try {
      switch (vector.kind) {
        case 'parse': {
          const parsed = library.parsePointer(vector.pointer);
          outcome = parsed.ok ? { tokens: parsed.value } : { refused: parsed.issues.map((issue) => issue.code).join() };
          break;
        }
        case 'format':
          outcome = { pointer: library.formatPointer(vector.tokens) };
          break;
        case 'get':
          outcome = library.getPointer(vector.document as never, vector.pointer);
          break;
        case 'relate':
          outcome = { relation: library.relatePointers(vector.a, vector.b) };
          break;
        case 'expand':
          outcome = { pointers: library.expandPattern(vector.pattern, vector.document as never) };
          break;
        case 'match':
          outcome = { matches: library.matchesPattern(vector.pattern, vector.pointer) };
          break;
        default:
          fail(`unknown kind ${String((vector as { kind?: unknown }).kind)}`);
          continue;
      }
    } catch (error) {
      outcome = { refused: codeOf(error) };
    }
    results.push({ name: vector.name, ...(outcome as object) });
    const {
      name: _name,
      kind: _kind,
      document: _document,
      a: _a,
      b: _b,
      pattern: _pattern,
      ...expected
    } = vector as unknown as Record<string, unknown>;
    // What the vector expects is what it holds beside its inputs: a parse's or a format's input is not its output.
    if (vector.kind === 'parse') delete expected.pointer;
    if (vector.kind === 'format') delete expected.tokens;
    if (vector.kind === 'get' || vector.kind === 'match') delete expected.pointer;
    if (!same(outcome, expected)) {
      fail(`gave ${library.canonicalJson(outcome)}, not ${library.canonicalJson(expected)}`);
    }
  }
  return { results, failures };
};
