/**
 * Analyse (0.33.0, design 2026-10-26-rules-that-act-0330 §3.3), as `rule analyse <rule> [--draft -] [--provider <p>]
 * --json` answers (the event service's `RuleAnalyseResultV1`):
 *
 *   { ruleId, analysed, counts: { windowDays, decisions, …, domains: [{ domain, judged, yes, no }] },
 *     suggestions: [{ part, before, after, why, evidence: { by, provider?, model?, targetId?, contextIndex? } }],
 *     model: { provider, name, model, noKey, sent, ran, reason, parts } }
 *
 * A part is `judge.question`, `session.context` or `linear.title`, whose before and after are the text itself;
 * `condition`, `judge.threshold` or `judge.inputs`, whose before and after are that part of the rule text, as the text
 * editor shows it; or `general`, a note with neither. Each sending domain arrives inside the untrusted-content
 * envelope. Analyse applies nothing: the person applies or skips each, and approves the version that results.
 */
import type { RulePart } from '../events-rules.ts';
import { ANALYSE_PROVIDERS, type AnalyseProvider } from '../ipc.ts';
import { parseRuleText, printRuleText } from '../rule-text.ts';
import { copyOf, isObject, type Json, type JsonObject, targetsIn } from './model.ts';

export interface Suggestion {
  part: string;
  before: string | null;
  after: string | null;
  why: string;
  evidence: JsonObject;
}

export interface AnalyseModel {
  provider: AnalyseProvider | null;
  name: string | null;
  model: string | null;
  ran: boolean;
  /** Why no model ran: `NO_KEY`, `NO_MODEL_PARTS`, or null. */
  reason: string | null;
  noKey: AnalyseProvider[];
  /** What was sent, in the event service's own words: shown as they are. */
  sent: string | null;
}

export interface AnalyseCounts {
  windowDays: number | null;
  decisions: number | null;
  /** Each sending domain inside its untrusted-content envelope, as the event service wrapped it. */
  domains: { domain: string; judged: number; yes: number; no: number }[];
}

export interface AnalyseResult {
  suggestions: Suggestion[];
  model: AnalyseModel;
  counts: AnalyseCounts;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) ? value : 0);
const provider = (value: unknown): AnalyseProvider | null =>
  (ANALYSE_PROVIDERS as readonly unknown[]).includes(value) ? (value as AnalyseProvider) : null;

export function readAnalyse(value: unknown): AnalyseResult | null {
  if (!isObject(value) || !Array.isArray(value.suggestions)) return null;
  const suggestions = value.suggestions.flatMap((entry): Suggestion[] => {
    if (!isObject(entry) || typeof entry.part !== 'string') return [];
    return [
      {
        part: entry.part,
        before: typeof entry.before === 'string' ? entry.before : null,
        after: typeof entry.after === 'string' ? entry.after : null,
        why: typeof entry.why === 'string' ? entry.why : '',
        evidence: isObject(entry.evidence) ? entry.evidence : {},
      },
    ];
  });
  const model = isObject(value.model) ? value.model : {};
  const counts = isObject(value.counts) ? value.counts : {};
  return {
    suggestions,
    model: {
      provider: provider(model.provider),
      name: text(model.name),
      model: text(model.model),
      ran: model.ran === true,
      reason: text(model.reason),
      noKey: Array.isArray(model.noKey) ? model.noKey.flatMap((each) => provider(each) ?? []) : [],
      sent: text(model.sent),
    },
    counts: {
      windowDays: typeof counts.windowDays === 'number' ? counts.windowDays : null,
      decisions: typeof counts.decisions === 'number' ? counts.decisions : null,
      domains: Array.isArray(counts.domains)
        ? counts.domains.flatMap((entry) =>
            isObject(entry) && typeof entry.domain === 'string'
              ? [{ domain: entry.domain, judged: count(entry.judged), yes: count(entry.yes), no: count(entry.no) }]
              : [],
          )
        : [],
    },
  };
}

/** The parts whose before and after are a part of the rule text, rather than the text of one field. */
const TEXT_PARTS = new Set(['condition', 'judge.threshold', 'judge.inputs']);

/** Whether a suggestion is one to apply or skip: a `general` note, or one with no after, is only to read. */
export function applicable(suggestion: Suggestion): boolean {
  return suggestion.part !== 'general' && suggestion.before !== null && suggestion.after !== null;
}

/** The rule text with `before` — a section at the left margin, or one indented line — in place of `after`. */
function replacedText(document: JsonObject, before: string, after: string): string | null {
  const lines = printRuleText(document).split('\n');
  const wanted = before.split('\n');
  const found: number[] = [];
  for (let at = 0; at + wanted.length <= lines.length; at += 1) {
    const indent = wanted.length === 1 ? (lines[at]?.match(/^ */u)?.[0] ?? '') : '';
    if (wanted.every((line, index) => lines[at + index] === `${index === 0 ? indent : ''}${line}`)) found.push(at);
  }
  const [at] = found;
  if (found.length !== 1 || at === undefined) return null;
  const indent = wanted.length === 1 ? (lines[at]?.match(/^ */u)?.[0] ?? '') : '';
  const replacement = after.split('\n').map((line, index) => (index === 0 ? `${indent}${line}` : line));
  return [...lines.slice(0, at), ...replacement, ...lines.slice(at + wanted.length)].join('\n');
}

/** One suggestion applied to `document`, or null when its part no longer holds its before. */
function applyOne(document: JsonObject, suggestion: Suggestion): JsonObject | null {
  const { before, after } = suggestion;
  if (before === null || after === null) return null;
  const next = copyOf(document);
  if (TEXT_PARTS.has(suggestion.part)) {
    const changed = replacedText(document, before, after);
    const parsed = changed === null ? null : parseRuleText(changed);
    if (parsed === null || !parsed.ok) return null;
    const doc = parsed.doc as JsonObject;
    // Only the part it names is taken from the text: everything else stays exactly as it was.
    if (suggestion.part === 'condition') next.condition = copyOf(doc.condition as Json);
    else if (isObject(next.agentic) && isObject(doc.agentic)) {
      const fields = suggestion.part === 'judge.inputs' ? ['inputs'] : ['threshold', 'onUncertain'];
      for (const field of fields)
        if (doc.agentic[field] !== undefined) next.agentic[field] = copyOf(doc.agentic[field]);
    } else return null;
    return next;
  }
  if (suggestion.part === 'judge.question') {
    if (!isObject(next.agentic) || next.agentic.question !== before) return null;
    next.agentic.question = after;
    return next;
  }
  const targetId = suggestion.evidence.targetId;
  const target = targetsIn(next).find((each) => each.targetId === targetId);
  if (target === undefined) return null;
  if (suggestion.part === 'session.context') {
    const index = suggestion.evidence.contextIndex;
    const context = Array.isArray(target.context) ? target.context : [];
    const part = typeof index === 'number' ? context[index] : undefined;
    if (!isObject(part) || part.text !== before) return null;
    part.text = after;
    return next;
  }
  if (suggestion.part === 'linear.title') {
    if (target.title === before) target.title = after;
    else if (isObject(target.title) && target.title.text === before && Object.keys(target.title).length === 1)
      target.title = { text: after };
    else return null;
    return next;
  }
  return null;
}

/**
 * The document with each applied suggestion's after in its place. One whose part no longer holds its before — the
 * person changed it since — is not applied, and is given back, so the screen can say so.
 */
export function applySuggestions(
  document: JsonObject,
  applied: readonly Suggestion[],
): { document: JsonObject; notApplied: Suggestion[] } {
  let next = document;
  const notApplied: Suggestion[] = [];
  for (const suggestion of applied) {
    const changed = applyOne(next, suggestion);
    if (changed === null) notApplied.push(suggestion);
    else next = changed;
  }
  return { document: next, notApplied };
}

/** Where a suggestion is, in the prototype's words. */
export function partWords(part: string): string {
  switch (part) {
    case 'judge.question':
      return 'The judge’s question';
    case 'judge.inputs':
      return 'What the judge looks at';
    case 'judge.threshold':
      return 'The judge’s bar';
    case 'condition':
      return 'Which messages';
    case 'session.context':
      return 'What the session is told';
    case 'linear.title':
      return 'The Linear issue’s title';
    case 'general':
      return 'About this rule';
    default:
      return part;
  }
}

/** A before or after as text parts: the rule's own words, or a model's, as text and never markup. */
export function valueParts(value: string | null): RulePart[] {
  return value === null ? [{ text: 'Nothing', kind: 'plain' }] : [{ text: value, kind: 'untrusted' }];
}

/** Whether a part's before and after are rule text, which the screen shows in the text editor's type. */
export function isRuleTextPart(part: string): boolean {
  return TEXT_PARTS.has(part);
}
