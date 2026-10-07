import type { Runner } from './types.ts';

/**
 * UTS #46 ToASCII and the canonical domain, through `toAsciiDomain` alone: by hand vectors (`test/vectors/idna.json`)
 * and by every line of IdnaTestV2.txt 15.1, derived from its pinned source (`test/support/conformance-sources.ts`).
 */

/** An input `toAsciiDomain` accepts, and the domain it gives. */
interface AcceptedVector {
  readonly kind: 'domain';
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}

/**
 * An input it refuses: exactly the UTS #46 status codes `refused` (sorted), and whether it also refuses a root dot
 * that UTS #46 lets through (decision 13).
 */
interface RefusedVector {
  readonly kind: 'domain';
  readonly name: string;
  readonly input: string;
  readonly refused: readonly string[];
  readonly rootLabel?: boolean;
}

/** IdnaTestV2.txt lines: `[line, source, toAsciiN, statuses, unassigned]`, strings as code points. */
interface IdnaTestVector {
  readonly kind: 'idnaTestV2';
  readonly name: string;
  readonly lines: readonly (readonly [number, readonly number[], readonly number[], readonly string[], boolean])[];
}

type IdnaVector = AcceptedVector | RefusedVector | IdnaTestVector;

interface Issue {
  readonly code: string;
  readonly detail?: readonly string[];
}

const text = (points: readonly number[]): string => {
  let out = '';
  for (const point of points) out += String.fromCodePoint(point);
  return out;
};

/** What `toAsciiDomain` answered, reduced to what a vector states: the value, or the UTS #46 codes and the root dot. */
function outcome(library: Parameters<Runner>[0], input: string) {
  const result = library.toAsciiDomain(input);
  if (result.ok) return { ok: true as const, value: result.value };
  const issues = result.issues as readonly Issue[];
  const codes = issues.filter((issue) => issue.detail?.[0] !== 'ROOT_LABEL').flatMap((issue) => issue.detail ?? []);
  const rootLabel = issues.some((issue) => issue.detail?.length === 1 && issue.detail[0] === 'ROOT_LABEL');
  const allDomainInvalid = issues.every((issue) => issue.code === 'DOMAIN_INVALID');
  return { ok: false as const, codes: [...codes].sort(), rootLabel, allDomainInvalid };
}

const NAMED = 10;
const isBidi = (code: string) => code.length === 2 && code.startsWith('B');

export const idnaRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  for (const vector of file.vectors as readonly IdnaVector[]) {
    let wrong = 0;
    const fail = (why: string) => {
      wrong += 1;
      if (wrong <= NAMED) failures.push(`${vector.name}: ${why}`);
    };
    if (vector.kind === 'domain') {
      const got = outcome(library, vector.input);
      results.push({ name: vector.name, ...got });
      if ('expected' in vector) {
        if (!got.ok) fail(`refused with ${got.codes.join(', ')}${got.rootLabel ? ' and a root dot' : ''}`);
        else if (got.value !== vector.expected) fail(`gave ${got.value}, not ${vector.expected}`);
      } else if (got.ok) {
        fail(`accepted as ${got.value}`);
      } else {
        if (got.codes.join(',') !== [...vector.refused].sort().join(',')) {
          fail(`refused with [${got.codes.join(', ')}], not [${[...vector.refused].sort().join(', ')}]`);
        }
        if (got.rootLabel !== (vector.rootLabel === true)) fail(`root dot refusal is ${got.rootLabel}`);
        if (!got.allDomainInvalid) fail('an issue is not DOMAIN_INVALID');
      }
    } else if (vector.kind === 'idnaTestV2') {
      let accepted = 0;
      let refused = 0;
      let bidiUnknown = 0;
      for (const [line, source, ascii, statuses, unassigned] of vector.lines) {
        const got = outcome(library, text(source));
        const expectedAscii = text(ascii);
        const labels = expectedAscii.split('.');
        const rootLabel = labels.length > 1 && labels[labels.length - 1] === '';
        const expected = [...statuses].sort();
        if (expected.length === 0 && !rootLabel) {
          if (!got.ok) fail(`line ${line}: refused with [${got.codes.join(', ')}]`);
          else if (got.value !== expectedAscii) fail(`line ${line}: gave ${got.value}, not ${expectedAscii}`);
          else accepted += 1;
          continue;
        }
        if (got.ok) {
          fail(`line ${line}: accepted as ${got.value}, not refused with [${expected.join(', ')}]`);
          continue;
        }
        refused += 1;
        if (got.rootLabel !== rootLabel) fail(`line ${line}: root dot refusal is ${got.rootLabel}`);
        if (!unassigned) {
          if (got.codes.join(',') !== expected.join(',')) {
            fail(`line ${line}: refused with [${got.codes.join(', ')}], not [${expected.join(', ')}]`);
          }
          continue;
        }
        // A code point no pinned source gives a Bidi_Class: everything but the B codes exactly, and V6 present.
        const rest = (codes: readonly string[]) => codes.filter((code) => !isBidi(code)).join(',');
        if (rest(got.codes) !== rest(expected) || !got.codes.includes('V6')) {
          fail(`line ${line}: refused with [${got.codes.join(', ')}], not [${expected.join(', ')}] (B codes aside)`);
        }
        if (got.codes.filter(isBidi).join(',') !== expected.filter(isBidi).join(',')) bidiUnknown += 1;
      }
      results.push({ name: vector.name, lines: vector.lines.length, accepted, refused, bidiUnknown, wrong });
    } else {
      fail(`unknown kind ${String((vector as { kind?: unknown }).kind)}`);
    }
    if (wrong > NAMED) failures.push(`${vector.name}: ${wrong - NAMED} more`);
  }
  return { results, failures };
};
