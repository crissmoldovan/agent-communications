/**
 * Analyse (0.33.0, design 2026-10-26-rules-that-act-0330 §3.3), as `rule analyse <rule> [--draft -] --json` answers:
 *
 *   { suggestions: [{ part, before, after, why, evidence }], provider?, model? }
 *
 * `part` is read as a JSON Pointer into the rule document, and `before` and `after` as the values there, so that an
 * applied suggestion goes into the editor exactly; `provider` and `model` name where the model's suggestions ran. Each
 * of those readings is the app's while the event service's builder settles the shape. Nothing is applied by Analyse:
 * the person applies or skips each, and approves the version that results.
 */
import { describeCondition, type RulePart } from '../events-rules.ts';
import { canonical, copyOf, isObject, type Json, type JsonObject } from './model.ts';

export interface Suggestion {
  part: string;
  before: Json;
  after: Json;
  why: string;
  evidence: Json;
}

export interface AnalyseResult {
  suggestions: Suggestion[];
  provider: string | null;
  model: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export function readAnalyse(value: unknown): AnalyseResult | null {
  if (!isObject(value) || !Array.isArray(value.suggestions)) return null;
  const suggestions = value.suggestions.flatMap((entry): Suggestion[] => {
    if (!isObject(entry) || typeof entry.part !== 'string' || !('after' in entry)) return [];
    return [
      {
        part: entry.part,
        before: entry.before ?? null,
        after: entry.after ?? null,
        why: typeof entry.why === 'string' ? entry.why : '',
        evidence: entry.evidence ?? null,
      },
    ];
  });
  const ranOn = isObject(value.ranOn) ? value.ranOn : value;
  return { suggestions, provider: text(ranOn.provider), model: text(ranOn.model) };
}

/** A JSON Pointer's tokens (RFC 6901), or null when it is not one. */
export function pointerTokens(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return null;
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** The value at `pointer` in `document`, or undefined when there is none. */
export function valueAt(document: Json, pointer: string): Json | undefined {
  const tokens = pointerTokens(pointer);
  if (tokens === null) return undefined;
  let node: Json | undefined = document;
  for (const token of tokens) {
    if (Array.isArray(node)) node = /^(?:0|[1-9][0-9]*)$/u.test(token) ? node[Number(token)] : undefined;
    else if (isObject(node)) node = Object.hasOwn(node, token) ? node[token] : undefined;
    else return undefined;
  }
  return node;
}

/** `document` with `value` at `pointer`, when the pointer's parent is there; otherwise null. */
function setAt(document: JsonObject, pointer: string, value: Json): JsonObject | null {
  const tokens = pointerTokens(pointer);
  if (tokens === null || tokens.length === 0) return null;
  const next = copyOf(document);
  let node: Json = next;
  for (const token of tokens.slice(0, -1)) {
    const child: Json | undefined = Array.isArray(node)
      ? node[Number(token)]
      : isObject(node)
        ? node[token]
        : undefined;
    if (child === undefined || child === null || typeof child !== 'object') return null;
    node = child;
  }
  const last = tokens.at(-1) as string;
  if (Array.isArray(node)) {
    const index = Number(last);
    if (!Number.isSafeInteger(index) || index < 0 || index > node.length) return null;
    node[index] = copyOf(value);
  } else if (isObject(node)) node[last] = copyOf(value);
  else return null;
  return next;
}

/**
 * The document with each applied suggestion's `after` in its place. One whose part no longer holds its `before` — the
 * person changed it since — is not applied, and is given back, so the screen can say so.
 */
export function applySuggestions(
  document: JsonObject,
  applied: readonly Suggestion[],
): { document: JsonObject; notApplied: Suggestion[] } {
  let next = document;
  const notApplied: Suggestion[] = [];
  for (const suggestion of applied) {
    const current = valueAt(next, suggestion.part);
    const was = suggestion.before === null && current === undefined ? null : current;
    const set = canonical(was) === canonical(suggestion.before) ? setAt(next, suggestion.part, suggestion.after) : null;
    if (set === null) notApplied.push(suggestion);
    else next = set;
  }
  return { document: next, notApplied };
}

/** Where a suggestion is, in the prototype's words. */
export function partWords(part: string): string {
  if (part === '/agentic/question') return 'The judge’s question';
  if (part === '/agentic/inputs') return 'What the judge looks at';
  if (part === '/agentic/threshold') return 'The judge’s bar';
  if (part === '/agentic/onUncertain') return 'If the judge is unsure';
  if (part === '/condition' || part.startsWith('/condition/')) return 'Which messages';
  if (/^\/targets\/\d+\/context(?:\/|$)/u.test(part)) return 'What the session is told';
  if (/^\/targets\/\d+\/title$/u.test(part)) return 'The Linear issue’s title';
  if (/^\/targets\/\d+\/description$/u.test(part)) return 'The Linear issue’s description';
  if (part === '/mapping') return "What's kept";
  if (part === '/deliveryRateCap') return 'The limit';
  return part;
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  '/from/name': 'Sender',
  '/from': 'Sender',
  '/from/address': 'Sender’s address',
  '/subject': 'Subject',
  '/snippet': 'First 300 characters',
};

/** A suggestion's before or after, as text parts: a condition in words, fields by name, text as its author's. */
export function valueParts(part: string, value: Json): RulePart[] {
  if (value === null) return [{ text: 'Nothing', kind: 'plain' }];
  if (part === '/condition') return describeCondition(value);
  if (typeof value === 'string') return [{ text: value, kind: 'untrusted' }];
  if (typeof value === 'number' && part === '/agentic/threshold')
    return [{ text: `Yes at ${value.toFixed(2)}`, kind: 'plain' }];
  if (Array.isArray(value) && value.every((each) => typeof each === 'string'))
    return [{ text: value.map((each) => FIELD_WORDS[each as string] ?? (each as string)).join(', '), kind: 'plain' }];
  return [{ text: canonical(value), kind: 'untrusted' }];
}
