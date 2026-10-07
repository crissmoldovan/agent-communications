/** D5's golden canonical bytes, evaluation cases and deterministic sentences. */

import type { JsonValue } from '../../../src/json.ts';
import type { Runner } from './types.ts';

interface Vector {
  readonly kind: 'canonical' | 'evaluate' | 'describe' | 'agentic';
  readonly name: string;
  readonly type?: string;
  readonly condition?: unknown;
  readonly prefilter?: unknown;
  readonly agentic?: unknown;
  readonly event?: Record<string, unknown>;
  readonly expected: unknown;
}

function merged(base: unknown, patch: unknown): unknown {
  if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    result[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value) ? merged(result[key], value) : value;
  }
  return result;
}

/** The portable conditions vector runner, used by Node, the bare realm and real browsers. */
export const conditionsRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  for (const vector of file.vectors as readonly Vector[]) {
    const fail = (why: string) => failures.push(`${vector.name}: ${why}`);
    const type = vector.type ?? 'gmail.message.received';
    const definition = library.CATALOGUE.find((candidate) => candidate.type === type);
    if (definition === undefined) {
      fail(`no catalogue definition for ${type}`);
      continue;
    }
    if (vector.kind === 'canonical') {
      const canonical = library.canonicaliseCondition(definition, vector.condition);
      if (!canonical.ok) {
        fail(`canonicalisation refused: ${canonical.issues[0]?.code}`);
        continue;
      }
      const actual = library.canonicalJson(canonical.value);
      results.push({ name: vector.name, actual });
      if (actual !== vector.expected) fail(`canonical bytes are ${actual}`);
    } else if (vector.kind === 'evaluate') {
      const canonical = library.canonicaliseCondition(definition, vector.condition);
      if (!canonical.ok) {
        fail(`canonicalisation refused: ${canonical.issues[0]?.code}`);
        continue;
      }
      const event = merged(definition.examples[0], vector.event) as JsonValue;
      const actual = library.evaluateCondition(definition, canonical.value, event);
      results.push({ name: vector.name, actual });
      if (actual !== vector.expected) fail(`evaluation is ${actual}`);
    } else if (vector.kind === 'describe') {
      const canonical = library.canonicaliseCondition(definition, vector.condition);
      if (!canonical.ok) {
        fail(`canonicalisation refused: ${canonical.issues[0]?.code}`);
        continue;
      }
      const actual = library.describeCondition(canonical.value);
      results.push({ name: vector.name, actual });
      if (actual !== vector.expected) fail(`sentence is ${actual}`);
    } else {
      const prefilter = library.canonicaliseCondition(definition, vector.prefilter);
      if (!prefilter.ok) {
        fail(`prefilter refused: ${prefilter.issues[0]?.code}`);
        continue;
      }
      const agentic = library.canonicaliseAgenticCondition(definition, prefilter.value, vector.agentic);
      if (!agentic.ok) {
        fail(`agentic condition refused: ${agentic.issues[0]?.code}`);
        continue;
      }
      const actual = library.canonicalJson(agentic.value);
      results.push({ name: vector.name, actual });
      if (actual !== vector.expected) fail(`agentic bytes are ${actual}`);
    }
  }
  return { results, failures };
};
