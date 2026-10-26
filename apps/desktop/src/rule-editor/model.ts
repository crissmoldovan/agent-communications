/**
 * The rule editor's model (0.33.0, design 2026-10-26-rules-that-act-0330 §3.1–§3.6): the canonical rule document is
 * the one thing the editor holds. The visual editor reads each of its five sections from the document and writes back
 * only the fields it has a control for; a part it has none for is "edited as text" and left exactly as it was. The text
 * editor prints and parses the same document (`rule-text.ts`). Nothing here runs a command or makes markup: what a
 * rule's author wrote stays text, and the screen shows it with the untrusted components.
 */
import { DAY_MS, HOUR_MS } from './time.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** A deep copy of a JSON value: the editor never changes a document in place. */
export function copyOf<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A JSON value with its keys in order, at every level: what two documents are compared by. */
export function canonical(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (isObject(node))
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [key, sort(node[key])]),
      );
    return node;
  };
  return JSON.stringify(sort(value)) ?? 'null';
}

/** The document as the Advanced tab shows it: its canonical JSON, keys in order, two spaces. */
export function prettyJson(document: JsonObject): string {
  return JSON.stringify(JSON.parse(canonical(document)), null, 2);
}

// ── Section 1: when ────────────────────────────────────────────────────────────────────────────────────────────────

/** The events the editor offers, by channel, in the rule text's own words (`GRAMMAR.md`, `when`). */
export const EVENTS: readonly { type: string; channel: string; words: string }[] = [
  { type: 'gmail.message.received', channel: 'gmail', words: 'a new message arrives' },
  { type: 'gmail.message.sent', channel: 'gmail', words: 'a message is sent' },
  { type: 'gmail.message.labelled', channel: 'gmail', words: 'a message is labelled' },
  { type: 'slack.message.posted', channel: 'slack', words: 'a Slack message is posted' },
  { type: 'resend.email.received', channel: 'resend', words: 'a Resend email arrives' },
  { type: 'resend.email.status_changed', channel: 'resend', words: 'a Resend email changes status' },
  { type: 'whatsapp.message.received', channel: 'whatsapp', words: 'a WhatsApp message arrives' },
];

/** What section 1 reads: the event, the account, and Gmail's folder, each null where it has no control. */
export interface WhenView {
  channel: string | null;
  eventType: string | null;
  /** The one account the rule watches; null when it watches several (edited as text). */
  accountId: string | null;
  /** Gmail's `inbox` or `any`; null for a list of labels or another channel's options (edited as text). */
  folder: 'inbox' | 'any' | null;
  /** Whether a part of the section has no control here. */
  asText: boolean;
}

export function whenView(document: JsonObject): WhenView {
  const source = isObject(document.source) ? document.source : {};
  const event = isObject(document.event) ? document.event : {};
  const channel = text(source.channel);
  const ids = Array.isArray(source.accountIds) ? source.accountIds.filter((id) => typeof id === 'string') : [];
  const options = isObject(source.options) ? source.options : {};
  const eventType = text(event.type);
  const known = EVENTS.some((each) => each.type === eventType) && event.version === 1;
  const folder =
    channel === 'gmail' && (options.labels === 'inbox' || options.labels === 'any') ? options.labels : null;
  const gmailExtras = channel === 'gmail' && options.includeSpamTrash === true;
  return {
    channel,
    eventType: known ? eventType : null,
    accountId: ids.length === 1 ? (ids[0] as string) : null,
    folder,
    asText: !known || ids.length !== 1 || (channel === 'gmail' ? folder === null || gmailExtras : true),
  };
}

/** The default options of a channel's source: Gmail's inbox; another channel's options are written as text. */
function defaultOptions(channel: string, before: Json | undefined): JsonObject {
  if (channel === 'gmail') return { channel, labels: 'inbox', includeSpamTrash: false };
  if (isObject(before) && before.channel === channel) return copyOf(before);
  if (channel === 'whatsapp') return { channel, chats: 'all-allowed' };
  if (channel === 'resend') return { channel, kinds: ['received'] };
  return { channel, conversations: [] };
}

/** The document watching `accountId` of `channel`: the event moves to that channel's first when it was another's. */
export function setAccount(document: JsonObject, accountId: string, channel: string): JsonObject {
  const next = copyOf(document);
  const source = isObject(next.source) ? next.source : {};
  const sameChannel = source.channel === channel;
  next.source = {
    ...source,
    channel,
    accountIds: [accountId],
    options: sameChannel && isObject(source.options) ? source.options : defaultOptions(channel, source.options),
  };
  const event = isObject(next.event) ? next.event : {};
  if (!sameChannel || !EVENTS.some((each) => each.type === event.type && each.channel === channel)) {
    const first = EVENTS.find((each) => each.channel === channel);
    if (first !== undefined) next.event = { type: first.type, version: 1 };
  }
  return next;
}

export function setEvent(document: JsonObject, type: string): JsonObject {
  const next = copyOf(document);
  next.event = { type, version: 1 };
  return next;
}

export function setFolder(document: JsonObject, folder: 'inbox' | 'any'): JsonObject {
  const next = copyOf(document);
  const source = isObject(next.source) ? next.source : {};
  const options = isObject(source.options) ? source.options : {};
  next.source = { ...source, options: { ...options, channel: 'gmail', labels: folder } };
  return next;
}

// ── Section 2: which messages ──────────────────────────────────────────────────────────────────────────────────────

/** The tests a condition's line offers, in the words the rule text uses for them. */
export const TESTS: readonly { op: string; words: string }[] = [
  { op: 'contains', words: 'mentions' },
  { op: 'equals', words: 'is' },
  { op: 'notEquals', words: 'is not' },
  { op: 'startsWith', words: 'starts with' },
  { op: 'endsWith', words: 'ends with' },
  { op: 'domainIs', words: 'has the domain' },
];

/** The fields a condition's line offers, by their pointer. */
export const FIELDS: readonly { path: string; words: string }[] = [
  { path: '/subject', words: 'Subject' },
  { path: '/from/address', words: "Sender's address" },
  { path: '/from/name', words: "Sender's name" },
  { path: '/snippet', words: 'First 300 characters' },
  { path: '/text', words: 'Text' },
];

/** One condition line: a field, a test and the text it tests for. */
export interface ConditionLine {
  path: string;
  op: string;
  value: string;
}

/** What section 2 reads: any or all, and its lines; or null when the condition has no control here. */
export interface WhichView {
  match: 'any' | 'all';
  lines: ConditionLine[];
}

function lineOf(node: unknown): ConditionLine | null {
  if (!isObject(node)) return null;
  const keys = Object.keys(node).sort().join();
  const op = text(node.op);
  if (op === null || !TESTS.some((test) => test.op === op) || typeof node.path !== 'string') return null;
  if (typeof node.value !== 'string') return null;
  // The shapes the visual line writes back exactly: a case-blind text test, or a domain without its subdomains, as the
  // rule text writes one (`includeSubdomains: false`).
  if (op === 'domainIs')
    return keys === 'includeSubdomains,op,path,value' && node.includeSubdomains === false
      ? { path: node.path, op, value: node.value }
      : null;
  if (keys !== 'caseSensitive,op,path,value' || node.caseSensitive !== false) return null;
  return { path: node.path, op, value: node.value };
}

export function whichView(document: JsonObject): WhichView | null {
  const condition = document.condition;
  const single = lineOf(condition);
  if (single !== null) return { match: 'all', lines: [single] };
  if (!isObject(condition)) return null;
  for (const match of ['any', 'all'] as const) {
    const members = condition[match];
    if (Object.keys(condition).length !== 1 || !Array.isArray(members) || members.length === 0) continue;
    const lines = members.map(lineOf);
    if (lines.every((line): line is ConditionLine => line !== null)) return { match, lines };
  }
  return null;
}

function nodeOf(line: ConditionLine): JsonObject {
  return line.op === 'domainIs'
    ? { path: line.path, op: line.op, value: line.value, includeSubdomains: false }
    : { path: line.path, op: line.op, value: line.value, caseSensitive: false };
}

/** The document with section 2 as `view` says: one line is that line; more are any or all of them. */
export function setWhich(document: JsonObject, view: WhichView): JsonObject {
  const next = copyOf(document);
  const [first] = view.lines;
  next.condition =
    view.lines.length === 1 && first !== undefined && view.match === 'all'
      ? nodeOf(first)
      : { [view.match]: view.lines.map(nodeOf) };
  return next;
}

/** A new line: the subject mentions nothing yet. */
export const NEW_LINE: ConditionLine = { path: '/subject', op: 'contains', value: '' };

// ── Section 3: ask a judge ─────────────────────────────────────────────────────────────────────────────────────────

/** The fields a judge may look at, by their pointer. */
export const JUDGE_INPUTS: readonly { path: string; words: string }[] = [
  { path: '/from/name', words: 'Sender' },
  { path: '/subject', words: 'Subject' },
  { path: '/snippet', words: 'First 300 characters' },
  { path: '/from/address', words: "Sender's address" },
];

/** What section 3 reads, when the rule asks a judge. */
export interface JudgeView {
  judgeId: string | null;
  judgeVersion: number | null;
  kind: string | null;
  provider: string | null;
  question: string;
  inputs: string[];
  threshold: number | null;
  onUncertain: 'no-match' | 'hold' | null;
  /** Its limits, which have no control here. */
  callsPerRollingHour: number | null;
}

export function judgeView(document: JsonObject): JudgeView | null {
  const agentic = document.agentic;
  if (!isObject(agentic)) return null;
  const judge = isObject(agentic.judge) ? agentic.judge : {};
  return {
    judgeId: text(judge.judgeId),
    judgeVersion: whole(judge.version),
    kind: text(judge.kind),
    provider: text(judge.provider),
    question: typeof agentic.question === 'string' ? agentic.question : '',
    inputs: Array.isArray(agentic.inputs) ? agentic.inputs.filter((each) => typeof each === 'string') : [],
    threshold: typeof agentic.threshold === 'number' ? agentic.threshold : null,
    onUncertain: agentic.onUncertain === 'hold' ? 'hold' : agentic.onUncertain === 'no-match' ? 'no-match' : null,
    callsPerRollingHour: whole(agentic.callsPerRollingHour),
  };
}

/** Whether the top-level `judges` list is the rule's own judge, as the editor keeps it; otherwise it is text's. */
function judgesFollow(document: JsonObject): boolean {
  const judges = document.judges;
  if (judges === undefined) return true;
  if (!Array.isArray(judges)) return false;
  if (judges.length === 0) return true;
  const agentic = isObject(document.agentic) ? document.agentic : null;
  return judges.length === 1 && agentic !== null && canonical(judges[0]) === canonical(agentic.judge);
}

/** The limits a newly asked judge starts with: the rule text's own example. */
export const NEW_JUDGE_LIMITS: JsonObject = {
  callsPerRollingHour: 60,
  inputTokensPerRolling30Days: 1_000_000,
  concurrency: 1,
  maxInputTokens: 2000,
  maxOutputTokens: 16,
};

/**
 * The document asking `judge` (a stored judge's whole document), or no judge at all. A rule that asked one keeps its
 * question, inputs, bar and limits; one that asked none starts with the subject, sender and first characters, a bar of
 * 0.70, and the limits above. The top-level `judges` follows, unless it was written as text.
 */
export function setJudge(document: JsonObject, judge: JsonObject | null): JsonObject {
  const next = copyOf(document);
  const follows = judgesFollow(document);
  if (judge === null) {
    delete next.agentic;
    if (follows) next.judges = [];
    return next;
  }
  const before = isObject(next.agentic) ? next.agentic : null;
  next.agentic =
    before === null
      ? {
          judge: copyOf(judge),
          question: '',
          inputs: ['/from/name', '/subject', '/snippet'],
          threshold: 0.7,
          onUncertain: 'no-match',
          ...copyOf(NEW_JUDGE_LIMITS),
        }
      : { ...before, judge: copyOf(judge) };
  if (follows) next.judges = [copyOf(judge)];
  return next;
}

/** The document with one of the judge's own fields set: its question, what it looks at, its bar, if it's unsure. */
export function setJudgeField(
  document: JsonObject,
  field: 'question' | 'inputs' | 'threshold' | 'onUncertain',
  value: Json,
): JsonObject {
  const next = copyOf(document);
  if (!isObject(next.agentic)) return next;
  next.agentic = { ...next.agentic, [field]: value };
  return next;
}

// ── Section 4: then do ─────────────────────────────────────────────────────────────────────────────────────────────

/** The kinds of action the editor adds, in the prototype's order. */
export const ACTION_KINDS = ['queue', 'session', 'linear', 'webhook', 'dry-run'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** A rule's targets, as the document holds them. */
export function targetsIn(document: JsonObject): JsonObject[] {
  return Array.isArray(document.targets) ? document.targets.filter(isObject) : [];
}

/** A target id no target of `taken` has: `<rule>-<kind>`, then `-2`, `-3`… */
export function freshTargetId(ruleId: string, kind: string, taken: ReadonlySet<string>): string {
  const base = `${ruleId}-${kind}`.slice(0, 120);
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base}-${index}`)) return `${base}-${index}`;
}

/** A new target of `kind`, as the editor makes one: version 1, with the defaults the prototype shows. */
export function newTarget(kind: Exclude<ActionKind, 'webhook'>, targetId: string): JsonObject {
  switch (kind) {
    case 'queue':
      return { targetId, version: 1, kind: 'queue', retentionMs: 7 * DAY_MS, show: 'summary' };
    case 'dry-run':
      return { targetId, version: 1, kind: 'dry-run', retentionMs: DAY_MS };
    case 'session':
      return {
        targetId,
        version: 1,
        kind: 'session',
        find: { folder: '' },
        ifNone: 'start',
        provider: 'claude',
        mode: 'manual',
        ifBusy: 'queue',
        context: [{ fields: ['/from', '/subject', '/snippet'] }],
      };
    case 'linear':
      return {
        targetId,
        version: 1,
        kind: 'linear',
        team: { id: '', key: '' },
        title: { text: '{{subject}}' },
        description: { text: '' },
        labels: [],
        assignee: 'me',
      };
  }
}

/** A rule's retention, kept as the event service binds it: `queueMs` exactly when the rule has a queue target. */
function withQueueRetention(document: JsonObject): JsonObject {
  if (!isObject(document.retention)) return document;
  const retention = { ...document.retention };
  const queue = targetsIn(document).find((target) => target.kind === 'queue');
  if (queue === undefined) delete retention.queueMs;
  else if (retention.queueMs === undefined)
    retention.queueMs = typeof queue.retentionMs === 'number' ? queue.retentionMs : 7 * DAY_MS;
  return { ...document, retention };
}

/** The document with its targets as `targets` say, its retention following. */
export function setTargets(document: JsonObject, targets: readonly JsonObject[]): JsonObject {
  return withQueueRetention({ ...copyOf(document), targets: copyOf(targets as JsonObject[]) });
}

/** The document with target `index` changed by `change`. */
export function changeTarget(
  document: JsonObject,
  index: number,
  change: (target: JsonObject) => JsonObject,
): JsonObject {
  const targets = targetsIn(document).map((target, at) => (at === index ? change(copyOf(target)) : target));
  return setTargets(document, targets);
}

// ── Section 5: what's kept, and the limit ──────────────────────────────────────────────────────────────────────────

/** The fields a rule may keep, as its mapping names them: each kept where it is (`{ key: { $path: '/key' } }`). */
export const KEPT_FIELDS: readonly { key: string; words: string }[] = [
  { key: 'from', words: 'Sender' },
  { key: 'subject', words: 'Subject' },
  { key: 'snippet', words: 'First 300 characters' },
  { key: 'messageId', words: 'Link to the message' },
  { key: 'attachments', words: "Attachments' names" },
];

/** The keys a mapping keeps, when every one is kept where it is; null when it is written as text. */
export function keptView(document: JsonObject): string[] | null {
  const mapping = document.mapping;
  if (!isObject(mapping)) return null;
  const keys = Object.keys(mapping);
  const simple = keys.every((key) => {
    const value = mapping[key];
    return (
      isObject(value) && Object.keys(value).length === 1 && value.$path === `/${key}` && /^[A-Za-z0-9_]+$/u.test(key)
    );
  });
  return simple ? keys : null;
}

export function setKept(document: JsonObject, keys: readonly string[]): JsonObject {
  const next = copyOf(document);
  const order = KEPT_FIELDS.map((each) => each.key);
  const sorted = [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  next.mapping = Object.fromEntries(sorted.map((key) => [key, { $path: `/${key}` }]));
  return next;
}

export function setRateCap(document: JsonObject, cap: number): JsonObject {
  return { ...copyOf(document), deliveryRateCap: cap };
}

// ── A new rule ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The retention a new rule is approved with: the owner's defaults (`RULE_RETENTION_DEFAULTS`), no queue yet. */
export const NEW_RETENTION: JsonObject = {
  ingestMs: 7 * DAY_MS,
  holdMs: 7 * DAY_MS,
  deliveryMs: 7 * DAY_MS,
  dryrunMs: DAY_MS,
  sseReplayMs: 7 * DAY_MS,
  deadLetterMs: 7 * DAY_MS,
  decisionMetadataMs: 90 * DAY_MS,
};

/**
 * A new rule, version 1: new mail in the account's inbox, a subject line to fill in, no judge, the dry-run log — so
 * nothing leaves this Mac until the person adds an action — and the sender, subject and first characters kept.
 */
export function newRule(ruleId: string, account: { id: string; channel: string } | null): JsonObject {
  const channel = account?.channel ?? 'gmail';
  const first = EVENTS.find((each) => each.channel === channel) ?? EVENTS[0];
  return {
    ruleId,
    version: 1,
    source: { channel, accountIds: account === null ? [] : [account.id], options: defaultOptions(channel, undefined) },
    event: { type: first?.type ?? 'gmail.message.received', version: 1 },
    condition: nodeOf({ ...NEW_LINE }),
    mapping: { from: { $path: '/from' }, subject: { $path: '/subject' }, snippet: { $path: '/snippet' } },
    targets: [newTarget('dry-run', `${ruleId}-log`)],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: copyOf(NEW_RETENTION),
  };
}

/** The next version of `document`, after `latest`: the editor saves a version past every one there is. */
export function nextVersion(document: JsonObject, latest: number): JsonObject {
  return { ...copyOf(document), version: latest + 1 };
}

// ── What the editor shows of time ──────────────────────────────────────────────────────────────────────────────────

/** A retention as the editor offers it: whole days, or hours under a day. */
export function keepWords(ms: number): string {
  if (ms % DAY_MS === 0) return ms === DAY_MS ? '1 day' : `${ms / DAY_MS} days`;
  const hours = Math.round(ms / HOUR_MS);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}
