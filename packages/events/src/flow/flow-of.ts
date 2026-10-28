/**
 * Every workflow as a graph (workflows design W2, W22): a workflow with a `flow` is drawn as that flow, and one
 * without — today's straight line — as the graph it already is: one deliver step per target, side by side under a
 * split when there are several. The gate (its trigger, condition and judge) stays before any run (W3), so it is not a
 * step. The drawing is derived, never stored: `flowOf` reads the document and writes nothing into it, so opening and
 * saving a straight-line workflow makes no new version and no approval.
 */
import { FLOW_BOUNDS, FLOW_LIMIT_DEFAULTS, type FlowDocumentV1, type FlowStep, type StepId } from './types.ts';

/** The longest a target's id may be in its step's id, `deliver-<id>`, so the step id stays within 32 characters. */
const FOLDED_MAX = 24;

/**
 * A target's id folded to a step id's characters: ASCII letters lower-cased with no host locale, every run of anything
 * else but digits and `-` made one `-`, and no `-` at either end. An id with nothing left is `target`.
 */
function folded(targetId: string): string {
  let out = '';
  for (const character of targetId) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 65 && code <= 90) out += String.fromCharCode(code + 32);
    else if (character.length === 1 && ((code >= 97 && code <= 122) || (code >= 48 && code <= 57))) out += character;
    else if (!out.endsWith('-')) out += '-';
  }
  const trimmed = out.replace(/^-+|-+$/gu, '');
  return trimmed === '' ? 'target' : trimmed;
}

/** `deliver-<folded id>`, at most 24 characters of it, with `-2`, `-3`… inside those 24 when the id is taken. */
function stepIdFor(targetId: string, taken: ReadonlySet<StepId>): StepId {
  const base = folded(targetId).slice(0, FOLDED_MAX).replace(/-+$/u, '');
  if (!taken.has(`deliver-${base}`)) return `deliver-${base}`;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const id = `deliver-${base.slice(0, FOLDED_MAX - tail.length).replace(/-+$/u, '')}${tail}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * A workflow as the graph the designer draws: its own `flow` (`derived: false`), or, for a straight line, one deliver
 * step per target, in the targets' order, under a split when there are several (`derived: true`). A split starts at
 * most 8 branches, so a ninth target and on hang under a split in the eighth branch's place. Limits are the defaults.
 * A document with no targets, which the event service refuses, is drawn with no steps.
 */
export function flowOf(rule: {
  readonly targets: readonly { readonly targetId: string; readonly version: number; readonly kind: string }[];
  readonly flow?: FlowDocumentV1;
}): { flow: FlowDocumentV1; derived: boolean } {
  if (rule.flow !== undefined) return { flow: rule.flow, derived: false };
  const taken = new Set<StepId>();
  const steps: Record<StepId, FlowStep> = {};
  const delivers: StepId[] = [];
  for (const target of rule.targets) {
    const id = stepIdFor(target.targetId, taken);
    taken.add(id);
    delivers.push(id);
    Object.defineProperty(steps, id, {
      value: { kind: 'deliver', target: { targetId: target.targetId, version: target.version }, next: {} },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  let start: StepId = delivers[0] ?? '';
  if (delivers.length > 1) {
    // Each split holds up to 8 branches; while more targets are left than fit, its eighth is the next split.
    let rest = [...delivers];
    const splits: { id: StepId; branches: StepId[] }[] = [];
    while (rest.length > 0) {
      const room = rest.length > FLOW_BOUNDS.splitMax ? FLOW_BOUNDS.splitMax - 1 : rest.length;
      splits.push({ id: splits.length === 0 ? 'split' : `split-${splits.length + 1}`, branches: rest.slice(0, room) });
      rest = rest.slice(room);
    }
    for (const [index, split] of splits.entries()) {
      const following = splits[index + 1];
      steps[split.id] = {
        kind: 'split',
        branches: following === undefined ? split.branches : [...split.branches, following.id],
      };
    }
    start = 'split';
  }
  return { flow: { flowVersion: 1, start, steps, limits: { ...FLOW_LIMIT_DEFAULTS } }, derived: true };
}
