/**
 * What a vector runner is: a plain ECMAScript module that takes the library's namespace and one parsed vector file,
 * and returns what every vector produced and which did not match. Node imports the runners directly; the bare realm
 * and the browsers get them bundled with the library (`../entry.ts`). They run where nothing but ECMAScript exists, so
 * they use nothing else either.
 */
import type * as Library from '../../../src/index.ts';

export type EventsLibrary = typeof Library;

/** A file under `test/vectors/`: the family names its runner. */
export interface VectorFile {
  readonly family: string;
  readonly description?: string;
  readonly vectors: readonly unknown[];
}

/** Every vector's result, in order, and one sentence per vector that did not match. */
export interface RunnerResult {
  readonly results: readonly unknown[];
  readonly failures: readonly string[];
}

export type Runner = (library: EventsLibrary, file: VectorFile) => RunnerResult;
