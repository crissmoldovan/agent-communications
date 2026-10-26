import { isDangerous } from '@agentcomms/core';
import { catalogueEntry, type JsonValue, printRuleText } from '@agentcomms/events';
import { MESSAGE_DECISION_OUTCOMES, type MessageDecisionOutcome } from './messages.ts';
import { isKeptSenderDomain } from './sender-domain.ts';

/**
 * Analyse (0.33.0 design §3.3): suggestions for one rule, or a draft of it, each with what the part says now, what it
 * could say, why, and what that rests on. It reads the rule's own document and content-free counts of what the rule
 * did on this Mac in the last 30 days — never a subject, a body, a snippet or a full address — and it never applies
 * anything: the app puts a suggestion into the editor, and the person approves the new version as any other.
 *
 * This module is pure: the counts, the three suggestions made from them with no model, the parts a model may improve
 * and the strict reading of what a model answers. The model's fixed briefs are `analyse-prompts.ts`; its wire is
 * `analyse-model.ts`; the owner's reads and calls are `runtime/rule-analyse.ts`.
 */

/** How far back Analyse counts: 30 days. */
export const ANALYSE_WINDOW_DAYS = 30;
export const ANALYSE_WINDOW_MS: number = ANALYSE_WINDOW_DAYS * 86_400_000;

/** The parts of a rule a suggestion can be about. */
export const RULE_ANALYSE_PARTS: readonly [
  'judge.question',
  'judge.inputs',
  'judge.threshold',
  'condition',
  'session.context',
  'linear.title',
  'general',
] = Object.freeze([
  'judge.question',
  'judge.inputs',
  'judge.threshold',
  'condition',
  'session.context',
  'linear.title',
  'general',
] as const);
export type RuleAnalysePart = (typeof RULE_ANALYSE_PARTS)[number];

/** The parts a model improves, each through its own fixed brief. */
export const MODEL_PARTS: readonly ['judge.question', 'session.context', 'linear.title'] = Object.freeze([
  'judge.question',
  'session.context',
  'linear.title',
] as const);
export type ModelPart = (typeof MODEL_PARTS)[number];

/**
 * One suggestion. `before` and `after` are what the part says now and could say: for the judge's question, a
 * session's context text and a Linear title, the text itself; for the condition and the judge's bar, the rule text of
 * that part (GRAMMAR.md), as the text editor shows it. A `general` note has neither. `evidence` is what it rests on:
 * counts, and `by` — `counts`, or `model` with the provider and model that wrote it.
 */
export interface RuleSuggestionV1 {
  readonly part: RuleAnalysePart;
  readonly before: string | null;
  readonly after: string | null;
  readonly why: string;
  readonly evidence: Readonly<Record<string, JsonValue>>;
}

/** One judged decision, as the owner reads it from the decision's metadata: its number, its answer and its domain. */
export interface JudgedFact {
  readonly value: number;
  readonly yes: boolean;
  readonly held: boolean;
  /** The sending domain the decision kept, or null when it kept none. */
  readonly senderDomain: string | null;
}

/** One queue item the rule made, with the judge's number for it when the decision still keeps one. */
export interface QueueFact {
  readonly state: 'open' | 'done' | 'dismissed';
  readonly score: number | null;
}

/** Everything Analyse reads of the rule's last 30 days: counts and numbers, and no message content. */
export interface RuleAnalyseFacts {
  readonly since: number;
  readonly decisions: number;
  readonly outcomes: Readonly<Record<MessageDecisionOutcome, number>>;
  readonly judged: readonly JudgedFact[];
  readonly queue: readonly QueueFact[];
}

/** The judge's answers, and their spread in ten bands of 0.1 (the last includes 1). */
export interface RuleAnalyseJudgeCountsV1 {
  readonly answered: number;
  readonly yes: number;
  readonly no: number;
  readonly held: number;
  readonly spread: readonly number[];
  readonly lowest: number | null;
  readonly highest: number | null;
}

/** Per sending domain: how often the judge was asked, and what it said. */
export interface RuleAnalyseDomainCountV1 {
  readonly domain: string;
  readonly judged: number;
  readonly yes: number;
  readonly no: number;
}

export interface RuleAnalyseQueueCountsV1 {
  readonly open: number;
  readonly done: number;
  readonly dismissed: number;
  /** The lowest judge's number of an item the person kept (done), and the highest of one they dismissed. */
  readonly lowestDone: number | null;
  readonly highestDismissed: number | null;
}

/** What Analyse counted, as the result gives it. Domains are sender-chosen: the result wraps each in the envelope. */
export interface RuleAnalyseCountsV1 {
  readonly windowDays: typeof ANALYSE_WINDOW_DAYS;
  readonly since: number;
  readonly decisions: number;
  readonly outcomes: Readonly<Record<MessageDecisionOutcome, number>>;
  readonly judge: RuleAnalyseJudgeCountsV1 | null;
  /** The judged decisions that kept their sender's domain; the domains, most judged first, at most this many. */
  readonly domainsKnown: number;
  readonly domains: readonly RuleAnalyseDomainCountV1[];
  readonly queue: RuleAnalyseQueueCountsV1;
}

/** At most this many domains are listed, and at most this many excluded by one suggestion. */
export const ANALYSE_LISTED_DOMAINS = 10;
export const ANALYSE_EXCLUDED_DOMAINS = 5;
/** A domain is left out only when the judge said no to it this many times or more, and never yes. */
export const ANALYSE_EXCLUSION_MINIMUM = 3;

function finite(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function band(value: number): number {
  return Math.min(9, Math.max(0, Math.floor(value * 10)));
}

function domainCounts(judged: readonly JudgedFact[]): RuleAnalyseDomainCountV1[] {
  const by = new Map<string, { judged: number; yes: number; no: number }>();
  for (const fact of judged) {
    if (fact.senderDomain === null || !isKeptSenderDomain(fact.senderDomain)) continue;
    const entry = by.get(fact.senderDomain) ?? { judged: 0, yes: 0, no: 0 };
    entry.judged += 1;
    if (fact.yes) entry.yes += 1;
    else entry.no += 1;
    by.set(fact.senderDomain, entry);
  }
  return [...by.entries()]
    .map(([domain, entry]) => ({ domain, ...entry }))
    .sort((left, right) => right.judged - left.judged || (left.domain < right.domain ? -1 : 1));
}

/** The counts the result carries. `wrapDomain` puts each sender-chosen domain in the untrusted-content envelope. */
export function summariseAnalyseFacts(
  facts: RuleAnalyseFacts,
  wrapDomain: (domain: string) => string,
): RuleAnalyseCountsV1 {
  const values = facts.judged.map((fact) => fact.value);
  const spread = new Array<number>(10).fill(0);
  for (const value of values) spread[band(value)] = (spread[band(value)] ?? 0) + 1;
  const done = facts.queue.filter((item) => item.state === 'done');
  const dismissed = facts.queue.filter((item) => item.state === 'dismissed');
  const doneScores = done.flatMap((item) => (item.score === null ? [] : [item.score]));
  const dismissedScores = dismissed.flatMap((item) => (item.score === null ? [] : [item.score]));
  const domains = domainCounts(facts.judged);
  return {
    windowDays: ANALYSE_WINDOW_DAYS,
    since: facts.since,
    decisions: facts.decisions,
    outcomes: Object.fromEntries(
      MESSAGE_DECISION_OUTCOMES.map((outcome) => [outcome, facts.outcomes[outcome] ?? 0]),
    ) as Record<MessageDecisionOutcome, number>,
    judge:
      facts.judged.length === 0
        ? null
        : {
            answered: facts.judged.length,
            yes: facts.judged.filter((fact) => fact.yes).length,
            no: facts.judged.filter((fact) => !fact.yes).length,
            held: facts.judged.filter((fact) => fact.held).length,
            spread,
            lowest: finite(Math.min(...values)),
            highest: finite(Math.max(...values)),
          },
    domainsKnown: facts.judged.filter((fact) => fact.senderDomain !== null && isKeptSenderDomain(fact.senderDomain))
      .length,
    domains: domains.slice(0, ANALYSE_LISTED_DOMAINS).map((entry) => ({ ...entry, domain: wrapDomain(entry.domain) })),
    queue: {
      open: facts.queue.filter((item) => item.state === 'open').length,
      done: done.length,
      dismissed: dismissed.length,
      lowestDone: doneScores.length === 0 ? null : finite(Math.min(...doneScores)),
      highestDismissed: dismissedScores.length === 0 ? null : finite(Math.max(...dismissedScores)),
    },
  };
}

/**
 * The counts a model is given: the same numbers, without the domains. A domain is the sender's choice, not the rule's
 * text, so no domain is ever sent: the model sees how many judged decisions kept one, and nothing of which.
 */
export function modelCounts(counts: RuleAnalyseCountsV1): Readonly<Record<string, JsonValue>> {
  const { domains: _domains, ...rest } = counts;
  return rest as unknown as Readonly<Record<string, JsonValue>>;
}

type Doc = Readonly<Record<string, unknown>>;

function record(value: unknown): Doc | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : null;
}

/** The lines of one left-margin section of the rule text: `match …` and the lines under it. */
function section(text: string, keyword: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === keyword || line.startsWith(`${keyword} `));
  if (start === -1) return null;
  const taken = [lines[start] as string];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(' ')) break;
    taken.push(line);
  }
  return taken.join('\n');
}

/** The `yes at …` line of the rule text's `ask` section, without its indent. */
function yesLine(text: string): string | null {
  const ask = section(text, 'ask');
  const line = ask?.split('\n').find((candidate) => candidate.startsWith('  yes at '));
  return line === undefined ? null : line.trim();
}

/** Whether the rule's event has a From address a condition can test by its domain. */
function hasSenderAddress(doc: Doc): boolean {
  const event = record(doc.event);
  if (event === null || typeof event.type !== 'string' || typeof event.version !== 'number') return false;
  const definition = catalogueEntry(event.type, event.version);
  return (
    definition.ok &&
    definition.value.addresses.some(
      (pattern) => pattern.length === 2 && pattern[0] === 'from' && pattern[1] === 'address',
    )
  );
}

function excluding(condition: unknown, domains: readonly string[]): JsonValue {
  const nots = domains.map((domain) => ({
    not: { path: '/from/address', op: 'domainIs', value: domain, includeSubdomains: false },
  }));
  const current = record(condition);
  if (current !== null && Array.isArray(current.all))
    return { ...current, all: [...current.all, ...nots] } as JsonValue;
  return { all: [condition as JsonValue, ...nots] };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A sender domain the judge always said no to, three times or more → leave it out before the judge is asked. */
function exclusionSuggestion(
  doc: Doc,
  facts: RuleAnalyseFacts,
  wrapDomain: (domain: string) => string,
): RuleSuggestionV1 | null {
  if (doc.condition === undefined || record(doc.agentic) === null || !hasSenderAddress(doc)) return null;
  const refused = domainCounts(facts.judged)
    .filter((entry) => entry.yes === 0 && entry.no >= ANALYSE_EXCLUSION_MINIMUM)
    .sort((left, right) => right.no - left.no || (left.domain < right.domain ? -1 : 1))
    .slice(0, ANALYSE_EXCLUDED_DOMAINS);
  if (refused.length === 0) return null;
  const before = section(printRuleText(doc), 'match');
  const after = section(
    printRuleText({
      ...doc,
      condition: excluding(
        doc.condition,
        refused.map((entry) => entry.domain),
      ),
    }),
    'match',
  );
  if (before === null || after === null) return null;
  const calls = refused.reduce((sum, entry) => sum + entry.no, 0);
  return {
    part: 'condition',
    before,
    after,
    why: `The judge said no to all ${plural(calls, 'message', 'messages')} from ${
      refused.length === 1 ? 'this sending domain' : `these ${refused.length} sending domains`
    } in the last ${ANALYSE_WINDOW_DAYS} days, and yes to none. Leaving ${
      refused.length === 1 ? 'it' : 'them'
    } out before the judge is asked saves about ${plural(calls, 'judge call', 'judge calls')} a month.`,
    evidence: {
      by: 'counts',
      windowDays: ANALYSE_WINDOW_DAYS,
      judgedNo: calls,
      domains: refused.map((entry) => ({ domain: wrapDomain(entry.domain), judgedNo: entry.no, judgedYes: 0 })),
    },
  };
}

/** The bar between the highest dismissed and the lowest kept number, as short as it can be written and still between. */
function barBetween(highestDismissed: number, lowestKept: number): number {
  const middle = (highestDismissed + lowestKept) / 2;
  for (const digits of [2, 3, 4]) {
    const rounded = Number(middle.toFixed(digits));
    if (rounded > highestDismissed && rounded <= lowestKept) return rounded;
  }
  return middle;
}

/** Kept against dismissed numbers → a judge bar between them, only when they separate. */
function barSuggestion(doc: Doc, facts: RuleAnalyseFacts): RuleSuggestionV1 | null {
  const agentic = record(doc.agentic);
  if (agentic === null || typeof agentic.threshold !== 'number') return null;
  const kept = facts.queue.flatMap((item) => (item.state === 'done' && item.score !== null ? [item.score] : []));
  const dismissed = facts.queue.flatMap((item) =>
    item.state === 'dismissed' && item.score !== null ? [item.score] : [],
  );
  if (kept.length === 0 || dismissed.length === 0) return null;
  const lowestKept = Math.min(...kept);
  const highestDismissed = Math.max(...dismissed);
  if (!(highestDismissed < lowestKept)) return null;
  const threshold = agentic.threshold;
  // A bar already between them keeps every kept item and drops every dismissed one: there is nothing to suggest.
  if (threshold > highestDismissed && threshold <= lowestKept) return null;
  const bar = barBetween(highestDismissed, lowestKept);
  if (bar < 0 || bar > 1) return null;
  const before = yesLine(printRuleText(doc));
  const after = yesLine(printRuleText({ ...doc, agentic: { ...agentic, threshold: bar } }));
  if (before === null || after === null) return null;
  return {
    part: 'judge.threshold',
    before,
    after,
    why: `${kept.length === 1 ? 'The one message you kept' : `Every one of the ${kept.length} messages you kept`} scored ${finite(
      lowestKept,
    )} or more, and ${dismissed.length === 1 ? 'the one' : `the ${dismissed.length}`} you dismissed scored ${finite(
      highestDismissed,
    )} at most. A bar of ${bar}, between them, keeps the first and leaves out the second.`,
    evidence: {
      by: 'counts',
      windowDays: ANALYSE_WINDOW_DAYS,
      kept: kept.length,
      dismissed: dismissed.length,
      lowestKept: finite(lowestKept),
      highestDismissed: finite(highestDismissed),
      threshold,
    },
  };
}

/** No match in 30 days → say so. */
function quietSuggestion(facts: RuleAnalyseFacts, hasHistory: boolean): RuleSuggestionV1 | null {
  const passed = (facts.outcomes.matched ?? 0) + (facts.outcomes.hold ?? 0);
  if (passed > 0) return null;
  const evidence = { by: 'counts', windowDays: ANALYSE_WINDOW_DAYS, decisions: facts.decisions, matched: 0 } as const;
  if (!hasHistory)
    return {
      part: 'general',
      before: null,
      after: null,
      why: 'This rule has no history on this Mac yet, so there is nothing to count: the suggestions come from its text alone.',
      evidence,
    };
  if (facts.decisions === 0)
    return {
      part: 'general',
      before: null,
      after: null,
      why: `No message reached this rule in the last ${ANALYSE_WINDOW_DAYS} days. Check that it watches the account and the messages you mean.`,
      evidence,
    };
  return {
    part: 'general',
    before: null,
    after: null,
    why: `Nothing passed this rule in the last ${ANALYSE_WINDOW_DAYS} days: ${plural(
      facts.decisions,
      'message',
      'messages',
    )} reached it and none matched${facts.judged.length > 0 ? ', or the judge said no' : ''}. Its condition may be narrower than you mean.`,
    evidence,
  };
}

/** The suggestions made from the counts alone, with no model, in this order: condition, bar, a note. */
export function deterministicSuggestions(
  doc: Doc,
  facts: RuleAnalyseFacts,
  input: { readonly hasHistory: boolean; readonly wrapDomain: (domain: string) => string },
): readonly RuleSuggestionV1[] {
  return [
    exclusionSuggestion(doc, facts, input.wrapDomain),
    barSuggestion(doc, facts),
    quietSuggestion(facts, input.hasHistory),
  ].filter((suggestion): suggestion is RuleSuggestionV1 => suggestion !== null);
}

/** One part a model is asked to improve: where it is, what it says now, and the rule's own words around it. */
export interface ModelPartRequest {
  readonly part: ModelPart;
  readonly current: string;
  /** Where in the rule the part is, for the app: the target and the context part, when it is a target's. */
  readonly at: Readonly<Record<string, JsonValue>>;
  /** The `{{slot}}` names a Linear title may use: the rule's mapped fields. */
  readonly slots: readonly string[];
}

/** At most this many model calls one Analyse makes. */
export const ANALYSE_MAX_MODEL_PARTS = 6;

/** The output paths a mapping copies a field to, dotted: the names the rule's mapped fields have. */
export function mappedFieldNames(mapping: unknown): readonly string[] {
  const found: string[] = [];
  const visit = (node: unknown, path: readonly string[]) => {
    const object = record(node);
    if (object === null) return;
    if (typeof object.$path === 'string') {
      if (path.length > 0) found.push(path.join('.'));
      return;
    }
    for (const [key, value] of Object.entries(object)) visit(value, [...path, key]);
  };
  visit(mapping, []);
  return found.filter((name) => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(name)).slice(0, 40);
}

/** A target's text, when it is plain text: a string, or `{ text }`. A generator or anything else is not a model's. */
function plainText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const object = record(value);
  return object !== null && typeof object.text === 'string' && Object.keys(object).length === 1 ? object.text : null;
}

/** The parts of this rule a model may improve: the judge's question, each session's text context, each Linear title. */
export function modelPartsOf(doc: Doc): readonly ModelPartRequest[] {
  const parts: ModelPartRequest[] = [];
  const slots = mappedFieldNames(doc.mapping);
  const agentic = record(doc.agentic);
  if (agentic !== null && typeof agentic.question === 'string' && agentic.question.trim() !== '')
    parts.push({ part: 'judge.question', current: agentic.question, at: {}, slots });
  for (const target of Array.isArray(doc.targets) ? doc.targets : []) {
    const entry = record(target);
    if (entry === null || typeof entry.targetId !== 'string') continue;
    if (entry.kind === 'session' && Array.isArray(entry.context))
      entry.context.forEach((part, index) => {
        const object = record(part);
        if (object !== null && typeof object.text === 'string' && object.text.trim() !== '')
          parts.push({
            part: 'session.context',
            current: object.text,
            at: { targetId: entry.targetId as string, contextIndex: index },
            slots,
          });
      });
    if (entry.kind === 'linear') {
      const title = plainText(entry.title);
      if (title !== null && title.trim() !== '')
        parts.push({ part: 'linear.title', current: title, at: { targetId: entry.targetId }, slots });
    }
  }
  return parts.slice(0, ANALYSE_MAX_MODEL_PARTS);
}

/** The longest `after` a model may give for each part, and the longest `why`. */
export const MODEL_AFTER_LIMITS: Readonly<Record<ModelPart, number>> = Object.freeze({
  'judge.question': 300,
  'session.context': 2000,
  'linear.title': 200,
});
export const MODEL_WHY_LIMIT = 400;

/** Why a model's answer was refused: closed words, never any of its text. */
export type ModelAnswerRefusal =
  | 'MODEL_OUTPUT_NOT_JSON'
  | 'MODEL_OUTPUT_SHAPE'
  | 'MODEL_OUTPUT_TOO_LONG'
  | 'MODEL_OUTPUT_CHARACTERS'
  | 'MODEL_OUTPUT_SLOTS';

const SLOT = /\{\{([^{}]*)\}\}/gu;

function textProblem(value: string, multiline: boolean): ModelAnswerRefusal | null {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (isDangerous(code)) return 'MODEL_OUTPUT_CHARACTERS';
    if (!multiline && (code === 0x0a || code === 0x09)) return 'MODEL_OUTPUT_CHARACTERS';
  }
  // A model may not write text that looks like the envelope sender material arrives in.
  if (/<\/?untrusted-content/iu.test(value)) return 'MODEL_OUTPUT_CHARACTERS';
  return null;
}

/**
 * A model's answer, read strictly: exactly one JSON object `{ "after": string, "why": string }`, each within its
 * limit, with no control, invisible or bidi character and no envelope tag; a Linear title's `{{slots}}` only the
 * rule's mapped fields. Anything else is refused with its closed reason. An answer that changes nothing is `null`.
 * What passes is rule-author text from then on: the person reads it in the editor and approves it with the rule.
 */
export function readModelAnswer(
  request: ModelPartRequest,
  text: string,
): { readonly after: string; readonly why: string } | { readonly refused: ModelAnswerRefusal } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { refused: 'MODEL_OUTPUT_NOT_JSON' };
  }
  const object = record(parsed);
  if (
    object === null ||
    Object.keys(object).length !== 2 ||
    typeof object.after !== 'string' ||
    typeof object.why !== 'string'
  )
    return { refused: 'MODEL_OUTPUT_SHAPE' };
  const after = object.after.trim();
  const why = object.why.trim();
  if (after === '' || why === '') return { refused: 'MODEL_OUTPUT_SHAPE' };
  if (after.length > MODEL_AFTER_LIMITS[request.part] || why.length > MODEL_WHY_LIMIT)
    return { refused: 'MODEL_OUTPUT_TOO_LONG' };
  const problem = textProblem(after, request.part === 'session.context') ?? textProblem(why, false);
  if (problem !== null) return { refused: problem };
  if (request.part === 'linear.title') {
    const withoutSlots = after.replaceAll(SLOT, '');
    if (withoutSlots.includes('{{') || withoutSlots.includes('}}')) return { refused: 'MODEL_OUTPUT_SLOTS' };
    for (const [, name] of after.matchAll(SLOT))
      if (!request.slots.some((slot) => name === slot || name?.startsWith(`${slot}.`)))
        return { refused: 'MODEL_OUTPUT_SLOTS' };
  }
  if (after === request.current.trim()) return null;
  return { after, why };
}

/**
 * The user turn of one model call: the rule's own text around the part, the part as it is now, and the counts without
 * any domain. Nothing a sender wrote is in it, and no account: only what the person wrote and numbers.
 */
export function modelInput(doc: Doc, request: ModelPartRequest, counts: RuleAnalyseCountsV1): string {
  const event = record(doc.event);
  const agentic = record(doc.agentic);
  const unsure = agentic?.onUncertain === 'hold' ? 'hold for the person' : 'leave it out';
  return JSON.stringify({
    part: request.part,
    rule: {
      ruleId: typeof doc.ruleId === 'string' ? doc.ruleId : null,
      watches:
        event !== null && typeof event.type === 'string' && typeof event.version === 'number'
          ? `${event.type}@${event.version}`
          : null,
      condition: section(printRuleText(doc), 'match'),
      judge:
        agentic === null
          ? null
          : {
              question: typeof agentic.question === 'string' ? agentic.question : null,
              looksAt: Array.isArray(agentic.inputs)
                ? agentic.inputs.filter((input): input is string => typeof input === 'string')
                : [],
              yesAt: typeof agentic.threshold === 'number' ? agentic.threshold : null,
              ifUnsure: unsure,
            },
      mappedFields: request.slots,
    },
    now: request.current,
    counts: modelCounts(counts),
  });
}

/** What the model part of an Analyse did: where it ran, or why it did not, and what came of each part. */
export interface RuleAnalyseModelV1 {
  /** The provider and model used, or that would have been: null when no provider has a key and none was named. */
  readonly provider: 'openrouter' | 'anthropic' | null;
  readonly name: string | null;
  readonly model: string | null;
  readonly ran: boolean;
  /** Why it did not run: no key for the provider (`noKey` says which), or nothing in the rule for a model to improve. */
  readonly reason: 'NO_KEY' | 'NO_MODEL_PARTS' | null;
  /** Analyse's providers that have no key. */
  readonly noKey: readonly ('openrouter' | 'anthropic')[];
  /** What was sent, in plain words: the same every time. */
  readonly sent: string;
  readonly parts: readonly {
    readonly part: ModelPart;
    readonly at: Readonly<Record<string, JsonValue>>;
    readonly outcome: 'suggested' | 'unchanged' | 'not-run' | ModelAnswerRefusal | string;
  }[];
}

/** `rule analyse`'s result: what was analysed, what was counted, the suggestions, and what the model did. */
export interface RuleAnalyseResultV1 {
  readonly ruleId: string;
  readonly analysed: { readonly source: 'stored'; readonly version: number } | { readonly source: 'draft' };
  readonly counts: RuleAnalyseCountsV1;
  readonly suggestions: readonly RuleSuggestionV1[];
  readonly model: RuleAnalyseModelV1;
}

/** The plain words for what a model is sent, as the result and the screen give them. */
export const ANALYSE_SENT =
  "The rule's own text and content-free counts of its last 30 days: never a message, a sender, a subject, a body or an address.";
