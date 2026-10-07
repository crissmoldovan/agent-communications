import type { Runner } from './types.ts';

/** `isFormat` (and `isInstant` for `date-time`), `compareInstants` and `canonicalEmail` over `test/vectors/formats.json`. */

interface FormatVector {
  readonly kind: 'format';
  readonly name: string;
  readonly format: 'email' | 'domain' | 'date-time' | 'uri' | 'uuid';
  readonly value: unknown;
  readonly valid: boolean;
}

interface CompareVector {
  readonly kind: 'compare';
  readonly name: string;
  readonly a: string;
  readonly b: string;
  readonly order: -1 | 0 | 1;
}

interface CanonicalEmailVector {
  readonly kind: 'canonicalEmail';
  readonly name: string;
  readonly input: string;
  readonly expected?: string;
  readonly refused?: string;
}

/** A call that must throw `EventsError` with `code`: `compareInstants(a, b)`, or `isFormat(format, value)`. */
interface ThrowsVector {
  readonly kind: 'throws';
  readonly name: string;
  readonly a?: string;
  readonly b?: string;
  readonly format?: string;
  readonly value?: unknown;
  readonly code: string;
}

type FormatsVector = FormatVector | CompareVector | CanonicalEmailVector | ThrowsVector;

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : `not an EventsError: ${String(error)}`;

export const formatsRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  for (const vector of file.vectors as readonly FormatsVector[]) {
    const fail = (why: string) => failures.push(`${vector.name}: ${why}`);
    if (vector.kind === 'format') {
      const valid = library.isFormat(vector.format, vector.value);
      results.push({ name: vector.name, valid });
      if (valid !== vector.valid) fail(`isFormat('${vector.format}') is ${valid}`);
      if (vector.format === 'date-time' && library.isInstant(vector.value) !== vector.valid) {
        fail(`isInstant is ${!vector.valid}`);
      }
    } else if (vector.kind === 'compare') {
      const forward = library.compareInstants(vector.a, vector.b);
      const backward = library.compareInstants(vector.b, vector.a);
      results.push({ name: vector.name, forward, backward });
      if (forward !== vector.order) fail(`compareInstants gave ${forward}, not ${vector.order}`);
      if (backward !== -vector.order && !(vector.order === 0 && backward === 0)) fail(`reversed, it gave ${backward}`);
    } else if (vector.kind === 'canonicalEmail') {
      const result = library.canonicalEmail(vector.input);
      if (result.ok) {
        results.push({ name: vector.name, value: result.value });
        if (vector.expected === undefined) fail(`accepted as ${result.value}`);
        else if (result.value !== vector.expected) fail(`gave ${result.value}, not ${vector.expected}`);
      } else {
        const codes = result.issues.map((issue) => issue.code);
        results.push({ name: vector.name, codes });
        if (vector.refused === undefined) fail(`refused with ${codes.join(', ')}`);
        else if (codes.join(',') !== vector.refused) fail(`refused with ${codes.join(', ')}, not ${vector.refused}`);
      }
    } else if (vector.kind === 'throws') {
      let code = 'returned';
      try {
        if (vector.format !== undefined) library.isFormat(vector.format as 'uri', vector.value);
        else library.compareInstants(vector.a as string, vector.b as string);
      } catch (error) {
        code = codeOf(error);
      }
      results.push({ name: vector.name, code });
      if (code !== vector.code) fail(`gave ${code}, not ${vector.code}`);
    } else {
      fail(`unknown kind ${String((vector as { kind?: unknown }).kind)}`);
    }
  }
  return { results, failures };
};
