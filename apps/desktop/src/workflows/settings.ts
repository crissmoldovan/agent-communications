/**
 * Each step's settings, and the workflow's, as pure changes of the document (workflows design §11.3, W23, W24, W33,
 * W34, W36): the events a step may raise and which are ticked, where a workflow's events are named, its limits, its
 * chain and its shadow. Every event is off until ticked, and a tick is part of the document, so it is approved.
 *
 * Where events are named: the first tick writes `flow.events` — the namespace from the trigger account's organisation
 * (`acme` for `acme/slack`) when it fits the grammar, `me` otherwise, and the workflow's id when that is a segment. A
 * workflow whose id is not one (today's ids allow `.`, `:`, `@` and capitals) is given a name by the person first.
 */

import type { AccountNames } from '../account-aliases.ts';
import { aliasOf } from '../account-aliases.ts';
import { copyOf, isObject, type JsonObject } from '../rule-editor/model.ts';
import { applyEmit, applyFlow, targetOf } from './canvas.ts';
import {
  eventsFor,
  FLOW_LIMIT_CEILINGS,
  type FlowLimits,
  type FlowStep,
  isEventSegment,
  RESERVED_NAMESPACES,
  RUN_EVENTS,
  type StepKind,
  schemaOf,
} from './flow.ts';

/** Where a workflow's events are named: `<namespace>.<workflow>.<step>.<event>` (W24). */
export interface EventNames {
  readonly namespace: string;
  readonly workflow: string;
}

/**
 * The events a step of `kind` may raise (Appendix W.3), all off until ticked: its standard words, then its own. A
 * wait's narrow to what it waits for, and a deliver step's follow its target's kind; one whose target is not chosen
 * yet has none. A Raise step raises its one event whatever is ticked, so it has none to tick.
 */
export function ticks(kind: StepKind, step?: JsonObject, targetKind?: string): readonly string[] {
  if (kind === 'raise') return [];
  if (kind === 'deliver' && targetKind === undefined) return [];
  const stepLike = (step ?? { kind }) as unknown as FlowStep;
  try {
    return eventsFor(schemaOf(stepLike, targetKind), stepLike);
  } catch {
    return [];
  }
}

/** The events `step` of `document` may raise, its target's kind read from the document. */
export function ticksOf(document: JsonObject, step: JsonObject): readonly string[] {
  if (typeof step.kind !== 'string') return [];
  const kind = step.kind as StepKind;
  const target = kind === 'deliver' ? targetOf(document, step) : null;
  return ticks(kind, step, typeof target?.kind === 'string' ? target.kind : undefined);
}

/** The namespace a workflow's events take by default: its trigger account's organisation, or `me`. */
export function namespaceFor(alias: string | null): string {
  const organisation = alias?.split('/')[0] ?? '';
  return isEventSegment(organisation) && !(RESERVED_NAMESPACES as readonly string[]).includes(organisation)
    ? organisation
    : 'me';
}

/**
 * Where `document`'s events are named: its own `flow.events`, or the defaults its first tick would write. `workflow`
 * is null when the workflow's id is not a segment and no name has been given.
 */
export function eventNames(
  document: JsonObject,
  names: AccountNames,
): { namespace: string; workflow: string | null; written: boolean } {
  const flow = isObject(document.flow) ? document.flow : {};
  const events = isObject(flow.events) ? flow.events : null;
  if (events !== null && typeof events.namespace === 'string' && typeof events.workflow === 'string')
    return { namespace: events.namespace, workflow: events.workflow, written: true };
  const source = isObject(document.source) ? document.source : {};
  const account =
    Array.isArray(source.accountIds) && typeof source.accountIds[0] === 'string' ? source.accountIds[0] : null;
  const ruleId = typeof document.ruleId === 'string' ? document.ruleId : '';
  return {
    namespace: namespaceFor(account === null ? null : aliasOf(names, account)),
    workflow: isEventSegment(ruleId) ? ruleId : null,
    written: false,
  };
}

/** `document` with `flow.events` written as `names`, keeping the run's own events. */
export function setEventNames(document: JsonObject, names: EventNames): JsonObject {
  return applyFlow(document, (flow) => {
    const before = isObject(flow.events) ? flow.events : {};
    return { ...flow, events: { ...before, namespace: names.namespace, workflow: names.workflow } };
  });
}

/**
 * `document` with `word` ticked (`on`) or not on step `stepId`; the first tick writes where the events are named, as
 * `names` says. Null when it is the first and no name is known yet: the person names them first.
 */
export function tickEvent(
  document: JsonObject,
  stepId: string,
  word: string,
  on: boolean,
  names: { namespace: string; workflow: string | null },
): JsonObject | null {
  const flow = isObject(document.flow) ? document.flow : {};
  const written = isObject(flow.events);
  if (on && !written) {
    if (names.workflow === null) return null;
    return applyEmit(
      setEventNames(document, { namespace: names.namespace, workflow: names.workflow }),
      stepId,
      word,
      on,
    );
  }
  return applyEmit(document, stepId, word, on);
}

/** `document` with the run's own event `word` ticked or not (`flow.events.run`, W23), named as `names` the first time. */
export function tickRunEvent(
  document: JsonObject,
  word: (typeof RUN_EVENTS)[number],
  on: boolean,
  names: { namespace: string; workflow: string | null },
): JsonObject | null {
  const flow = isObject(document.flow) ? document.flow : {};
  if (on && !isObject(flow.events) && names.workflow === null) return null;
  const named =
    on && !isObject(flow.events) && names.workflow !== null
      ? setEventNames(document, { namespace: names.namespace, workflow: names.workflow })
      : document;
  return applyFlow(named, (written) => {
    const events = isObject(written.events) ? { ...written.events } : null;
    if (events === null) return written;
    const run = new Set(Array.isArray(events.run) ? events.run.filter((each) => typeof each === 'string') : []);
    if (on) run.add(word);
    else run.delete(word);
    if (run.size === 0) delete events.run;
    else events.run = RUN_EVENTS.filter((each) => run.has(each));
    return { ...written, events };
  });
}

/** The limits a flow may set, in the order the settings show them. */
export const LIMIT_KEYS: readonly (keyof FlowLimits)[] = [
  'runsPerHour',
  'concurrentRuns',
  'sessionsPerHour',
  'worktreesPerDay',
  'linearWritesPerHour',
  'eventsPerHour',
  'runMs',
];

/**
 * `document` with limit `key` at `value`, or the reason it is refused: a whole number from 1 to the limit's ceiling
 * (§7.5, W33). `runMs` is given in whole hours.
 */
export function setLimit(document: JsonObject, key: keyof FlowLimits, value: string): JsonObject | string {
  const ceiling = FLOW_LIMIT_CEILINGS[key];
  const hours = key === 'runMs';
  const number = Number(value);
  const most = hours ? ceiling / 3_600_000 : ceiling;
  if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(number) || number < 1) return 'A whole number, 1 or more.';
  if (number > most) return `At most ${most}${hours ? ' hours' : ''}.`;
  return applyFlow(document, (flow) => ({
    ...flow,
    limits: { ...(isObject(flow.limits) ? flow.limits : {}), [key]: hours ? number * 3_600_000 : number },
  }));
}

/** `document` as a chained workflow started by `patterns` within `withinMs` (W34), or not chained when empty. */
export function setChain(document: JsonObject, patterns: readonly string[], withinMs: number): JsonObject {
  return applyFlow(document, (flow) => {
    const next = copyOf(flow);
    if (patterns.length === 0) delete next.on;
    else next.on = { raised: [...new Set(patterns)].sort(), withinMs };
    return next;
  });
}

/** `document` in shadow, every effect a dry-run record (§7.7), or not. */
export function setShadow(document: JsonObject, on: boolean): JsonObject {
  return applyFlow(document, (flow) => {
    const next = copyOf(flow);
    if (on) next.shadow = true;
    else delete next.shadow;
    return next;
  });
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** A span in words: minutes under an hour, hours under a day, then days. */
export function spanWords(ms: number): string {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (ms % DAY === 0) return unit(ms / DAY, 'day');
  if (ms % HOUR === 0) return unit(ms / HOUR, 'hour');
  return unit(Math.round(ms / MINUTE), 'minute');
}
