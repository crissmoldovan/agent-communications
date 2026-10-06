import type { Runner } from './types.ts';

interface CanonicalJsonVector {
  readonly name: string;
  readonly input: unknown;
  /** Key paths set to `undefined` before the value is written: JSON cannot hold `undefined` itself. */
  readonly undefinedMembers?: readonly (readonly string[])[];
  readonly canonical: string;
}

/** The vector's input, with its `undefined` members put in. The input is freshly parsed, so it is changed in place. */
function revive(vector: CanonicalJsonVector): unknown {
  for (const path of vector.undefinedMembers ?? []) {
    let at = vector.input as Record<string, unknown>;
    for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
    at[path[path.length - 1] as string] = undefined;
  }
  return vector.input;
}

/** `canonicalJson` over every vector: the exact string, or what it threw. */
export const canonicalJsonRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  for (const vector of file.vectors as readonly CanonicalJsonVector[]) {
    let canonical: string;
    try {
      canonical = library.canonicalJson(revive(vector));
    } catch (error) {
      results.push({ name: vector.name, threw: String(error) });
      failures.push(`${vector.name}: threw ${String(error)}`);
      continue;
    }
    results.push({ name: vector.name, canonical });
    if (canonical !== vector.canonical) failures.push(`${vector.name}: ${canonical} is not ${vector.canonical}`);
  }
  return { results, failures };
};
