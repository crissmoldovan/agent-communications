import {
  type AnyEventDefinition,
  catalogueEntry,
  classifyMapped,
  compileMapping,
  evaluateCondition,
  evaluateMapping,
  type MappedClassification,
  type MappedValue,
} from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';

export interface EvaluatedProjection {
  readonly definition: AnyEventDefinition;
  readonly mapped: MappedValue;
  readonly classification: MappedClassification;
}

/** A mapping that refuses this event: a `reject` path it lacks, or a mapped result over D6's size limit. */
export interface RejectedProjection {
  readonly rejected: 'MAPPING_PATH_MISSING' | 'MAPPING_LIMIT_EXCEEDED';
}

/** The mandatory deterministic gate, deliberately usable without constructing a mapping or judge envelope. */
export function matchesRuleCondition(rule: CanonicalFullRuleDocument, event: Record<string, unknown>): boolean {
  const found = catalogueEntry(rule.event.type, rule.event.version);
  if (!found.ok) throw new Error(found.issues[0]?.message ?? 'the stored workflow event definition is unavailable');
  return evaluateCondition(found.value as never, rule.condition, event as never);
}

/** The two refusals that depend on the event, not the stored rule; the frozen events API names them by code only. */
function eventRejection(error: unknown): RejectedProjection['rejected'] | null {
  if (!(error instanceof Error) || error.name !== 'EventsError') return null;
  const code = (error as { code?: unknown }).code;
  return code === 'MAPPING_PATH_MISSING' || code === 'MAPPING_LIMIT_EXCEEDED' ? code : null;
}

/**
 * Evaluates only the deterministic Phase A condition; B1 deliberately has no judge execution path. A mapping that
 * rejects this event (D6's default `reject` policy, or the size limit) is a deterministic terminal outcome for the
 * rule — never a retry, which would hold the mailbox cursor on one message for good.
 */
export function evaluateRuleProjection(
  rule: CanonicalFullRuleDocument,
  event: Record<string, unknown>,
): EvaluatedProjection | RejectedProjection | null {
  const found = catalogueEntry(rule.event.type, rule.event.version);
  if (!found.ok) throw new Error(found.issues[0]?.message ?? 'the stored workflow event definition is unavailable');
  const definition = found.value;
  if (!matchesRuleCondition(rule, event)) return null;
  const compiled = compileMapping(definition as never, rule.mapping);
  if (!compiled.ok) throw new Error(compiled.issues[0]?.message ?? 'the stored workflow mapping is unavailable');
  let mapped: MappedValue;
  try {
    mapped = evaluateMapping(compiled.value, event);
  } catch (error) {
    const rejected = eventRejection(error);
    if (rejected === null) throw error;
    return { rejected };
  }
  return { definition, mapped, classification: classifyMapped(definition as never, event as never, mapped) };
}
