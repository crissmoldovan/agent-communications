/**
 * The event service's rules, as Events → Rules reads them (owner feedback 0.32.0, §3.4): `rules list --json`, one row
 * per version, grouped into one rule each; and `rule show <rule> --json`, each version's document, times, sentence and
 * counts. From the document come the six panels of a rule's page, in plain words.
 *
 * Nothing here makes markup. A rule's author is an agent, so what it wrote — a condition's operand, the judge's
 * question, a label's name — comes back as an `untrusted` part, which the screen shows as text and nothing else.
 */
import { productLabel } from './components/ApprovalCard.tsx';
import { isRuleId } from './grammar.ts';

/** One part of a sentence about a rule (`describeRule`, in `packages/events`): plain words, a value, or author text. */
export interface RulePart {
  text: string;
  kind: 'plain' | 'value' | 'untrusted';
}

/** A version's state as the event service records it; null is a version never switched on (design D2). */
export type VersionState = 'active' | 'superseded' | 'revoked' | null;

/** Where a rule stands, in the words the screen says it: on, not switched on yet, or off. */
export type RuleStatus = 'on' | 'not-switched-on' | 'off';

/** `counts7d`: what a version did in the last 7 days, content-free. */
export interface RuleCounts {
  matched: number;
  judgedYes: number;
  judgedNo: number;
  held: number;
  delivered: number;
  failed: number;
}

/** One version, as `rule show` gives it. The document is read loosely: each panel says only what it can read. */
export interface RuleVersionView {
  version: number;
  state: VersionState;
  digest: string | null;
  approvalId: string | null;
  activationId: string | null;
  activatedAt: number | null;
  supersededAt: number | null;
  revokedAt: number | null;
  /** The sentence, from the event service; null from an events service older than 0.32.0. */
  summary: RulePart[] | null;
  counts7d: RuleCounts | null;
  document: Record<string, unknown> | null;
}

/** One rule, as the list groups its versions: its id, the state of each version, and whether the app may open it. */
export interface RuleRow {
  id: string;
  /** Whether the id is one the allow-list takes, so that the rule can be read, turned off and removed. */
  openable: boolean;
  versions: { version: number; state: VersionState }[];
  status: RuleStatus;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** A time in epoch milliseconds: a positive whole number. Zero or less is no time at all. */
export const moment = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

const STATES: readonly Exclude<VersionState, null>[] = ['active', 'superseded', 'revoked'];
const stateOf = (value: unknown): VersionState => STATES.find((state) => state === value) ?? null;

/** Where a rule stands: on while a version is active; else not switched on when its newest version never was; else off. */
export function ruleStatus(versions: readonly { version: number; state: VersionState }[]): RuleStatus {
  if (versions.some((each) => each.state === 'active')) return 'on';
  const newest = [...versions].sort((a, b) => b.version - a.version)[0];
  return newest === undefined || newest.state === null ? 'not-switched-on' : 'off';
}

/** The order the list shows rules in: on first, then those not switched on, then off; each by id. */
const STATUS_ORDER: Readonly<Record<RuleStatus, number>> = { on: 0, 'not-switched-on': 1, off: 2 };

/** `rules list --json`, read: one rule per id, its versions in order. Null when it is not that answer at all. */
export function readRulesList(value: unknown): RuleRow[] | null {
  if (!Array.isArray(value)) return null;
  const rules = new Map<string, { version: number; state: VersionState }[]>();
  for (const row of value) {
    if (!isRecord(row)) continue;
    const id = text(row.rule_id);
    const version = whole(row.version);
    if (id === null || version === null) continue;
    const versions = rules.get(id) ?? [];
    versions.push({ version, state: stateOf(row.state) });
    rules.set(id, versions);
  }
  return [...rules.entries()]
    .map(([id, versions]) => {
      const sorted = versions.sort((a, b) => a.version - b.version);
      return { id, openable: isRuleId(id), versions: sorted, status: ruleStatus(sorted) };
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id));
}

function partsOf(value: unknown): RulePart[] | null {
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((part): RulePart[] => {
    if (!isRecord(part) || typeof part.text !== 'string') return [];
    const kind = part.kind === 'value' || part.kind === 'plain' ? part.kind : 'untrusted';
    return [{ text: part.text, kind }];
  });
  return parts.length === 0 ? null : parts;
}

function countsOf(value: unknown): RuleCounts | null {
  if (!isRecord(value)) return null;
  const read = (name: keyof RuleCounts) => whole(value[name]) ?? 0;
  return {
    matched: read('matched'),
    judgedYes: read('judgedYes'),
    judgedNo: read('judgedNo'),
    held: read('held'),
    delivered: read('delivered'),
    failed: read('failed'),
  };
}

/** `rule show <rule> --json`, read: its versions, oldest first. Null when it is not that answer at all. */
export function readRuleShow(value: unknown): RuleVersionView[] | null {
  if (!Array.isArray(value)) return null;
  const versions = value.flatMap((entry): RuleVersionView[] => {
    if (!isRecord(entry)) return [];
    const document = isRecord(entry.document) ? entry.document : null;
    const version = whole(document?.version) ?? whole(entry.version);
    if (version === null) return [];
    return [
      {
        version,
        state: stateOf(entry.state),
        digest: text(entry.digest),
        approvalId: text(entry.approval_id),
        activationId: text(entry.authorization_activation_id),
        activatedAt: moment(entry.activatedAt),
        supersededAt: moment(entry.supersededAt),
        revokedAt: moment(entry.revokedAt),
        summary: partsOf(entry.summary),
        counts7d: countsOf(entry.counts7d),
        document,
      },
    ];
  });
  return versions.sort((a, b) => a.version - b.version);
}

/** The version a rule is described by: its active one, else its newest. */
export function currentVersion(versions: readonly RuleVersionView[]): RuleVersionView | null {
  return versions.find((each) => each.state === 'active') ?? versions.at(-1) ?? null;
}

/** Every version's counts of the last 7 days, added up; null when no version has them. */
export function weekCounts(versions: readonly RuleVersionView[]): RuleCounts | null {
  const counted = versions.flatMap((each) => (each.counts7d === null ? [] : [each.counts7d]));
  if (counted.length === 0) return null;
  return counted.reduce((sum, each) => ({
    matched: sum.matched + each.matched,
    judgedYes: sum.judgedYes + each.judgedYes,
    judgedNo: sum.judgedNo + each.judgedNo,
    held: sum.held + each.held,
    delivered: sum.delivered + each.delivered,
    failed: sum.failed + each.failed,
  }));
}

// ── The document, in plain words ───────────────────────────────────────────────────────────────────────────────

/** A target of a rule, as much of it as the screen says. */
export interface TargetView {
  kind: 'dry-run' | 'queue' | 'webhook' | 'sse' | 'linear' | 'session' | 'other';
  id: string | null;
  version: number | null;
  lane: string | null;
  /** A webhook's host: a plain URL's, or a secret URL's stored host. Never its path or query. */
  host: string | null;
  retentionMs: number | null;
  /** A queue's `summary` or `minimal`. */
  show: string | null;
  retryLimit: number | null;
  /** A Linear issue's team, by its key (0.33.0). */
  team: string | null;
  /** An agent session's folder, or the lane it is bound to (0.33.0). */
  folder: string | null;
  /** Whether the session runs Codex rather than Claude Code. */
  codex: boolean;
}

/** A webhook URL's host, as the person approved it, or null. */
function hostOf(url: unknown): string | null {
  if (!isRecord(url)) return null;
  if (url.kind === 'secret') return text(url.host);
  const value = text(url.value);
  if (url.kind !== 'plain' || value === null) return null;
  try {
    return text(new URL(value).hostname);
  } catch {
    return null;
  }
}

const TARGET_KINDS: readonly TargetView['kind'][] = ['dry-run', 'queue', 'webhook', 'sse', 'linear', 'session'];

/** A rule document's targets. */
export function targetsOf(document: Json | null): TargetView[] {
  const targets = Array.isArray(document?.targets) ? document.targets : [];
  return targets.filter(isRecord).map((target) => ({
    kind: TARGET_KINDS.find((kind) => kind === target.kind) ?? 'other',
    id: text(target.targetId),
    version: whole(target.version),
    lane: isRecord(target.lane) ? text(target.lane.name) : null,
    host: target.kind === 'webhook' ? hostOf(target.url) : null,
    retentionMs: whole(target.retentionMs),
    show: text(target.show),
    retryLimit: whole(target.retryLimit),
    team: isRecord(target.team) ? (text(target.team.key) ?? text(target.team.id)) : null,
    folder: isRecord(target.find) ? (text(target.find.folder) ?? text(target.find.lane)) : null,
    codex: target.provider === 'codex',
  }));
}

/** Whether every target of the document is the dry-run log: nothing it matches leaves this Mac. */
export function dryRunOnly(document: Json | null): boolean {
  const targets = targetsOf(document);
  return targets.length > 0 && targets.every((target) => target.kind === 'dry-run');
}

/** The channel a document watches (`gmail`, `slack`…), or null. */
export function channelOf(document: Json | null): string | null {
  return isRecord(document?.source) ? text(document.source.channel) : null;
}

/** The accounts a document watches, as ids. */
export function accountIdsOf(document: Json | null): string[] {
  const ids = isRecord(document?.source) && Array.isArray(document.source.accountIds) ? document.source.accountIds : [];
  return ids.flatMap((id) => (typeof id === 'string' && id !== '' ? [id] : []));
}

/** A rule's delivery retention, in milliseconds: how long after a delivery is made it expires. */
export function deliveryRetentionOf(document: Json | null): number | null {
  return isRecord(document?.retention) ? whole(document.retention.deliveryMs) : null;
}

/** How a sentence's parts are made: plain words, a value, an author's text. */
const plain = (value: string): RulePart => ({ text: value, kind: 'plain' });
const value = (value: string): RulePart => ({ text: value, kind: 'value' });
const authored = (value: string): RulePart => ({ text: value, kind: 'untrusted' });

/**
 * What the screen calls a field of a message, by its pointer in the event catalogue: the fields rules use most. Any
 * other is named by its pointer.
 */
const FIELD_NAMES: Readonly<Record<string, string>> = {
  '/subject': 'the subject',
  '/snippet': 'the preview',
  '/body': 'the body',
  '/text': 'the text',
  '/from': 'the sender',
  '/from/address': "the sender's address",
  '/from/name': "the sender's name",
  '/replyTo': 'the reply-to address',
  '/to': 'the recipients',
  '/cc': 'the copied',
  '/labels': 'the labels',
  '/user': 'who wrote it',
  '/author/userId': 'who wrote it',
  '/author/name': "the author's name",
  '/channel': 'the channel',
  '/channel/id': 'the channel',
  '/workspaceId': 'the workspace',
  '/messageId': 'the message id',
  '/threadId': 'the thread',
  '/ts': 'when it was written',
  '/date': 'the date',
  '/attachments': 'the attachments',
  '/hasAttachments': 'whether it has attachments',
};

/** A field by its pointer: its name in words, or the pointer itself as a value. */
function field(pointer: unknown): RulePart {
  if (typeof pointer !== 'string') return value('a field');
  const name = FIELD_NAMES[pointer];
  return name === undefined ? value(pointer) : plain(name);
}

/** The same with its first letter capitalised, to start a line. */
function opening(part: RulePart): RulePart {
  return part.kind === 'plain' ? { ...part, text: part.text.charAt(0).toUpperCase() + part.text.slice(1) } : part;
}

/** A condition's operand: a string is its author's text; a number, a boolean or null a value. */
function operand(given: unknown): RulePart {
  return typeof given === 'string' ? authored(given) : value(JSON.stringify(given) ?? 'nothing');
}

const OP_WORDS: Readonly<Record<string, string>> = {
  equals: 'is',
  notEquals: 'is not',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  domainIs: 'is at',
};

/** One leaf of a condition: the field, what it is tested for, and its operand. */
function leaf(condition: Json, start: boolean): RulePart[] {
  const name = start ? opening(field(condition.path)) : field(condition.path);
  const op = typeof condition.op === 'string' ? condition.op : '';
  if (op === 'exists') return [name, plain(' is there')];
  if (op === 'in') {
    const values = Array.isArray(condition.values) ? condition.values : [];
    return [
      name,
      plain(' is one of '),
      ...joined(
        values.map((each) => [operand(each)]),
        ', ',
      ),
    ];
  }
  const words = OP_WORDS[op];
  if (words === undefined) return [name, plain(' matches '), value(op || 'a test')];
  const parts = [name, plain(` ${words} `), operand(condition.value)];
  if (op === 'domainIs' && condition.includeSubdomains === true) parts.push(plain(' or a domain under it'));
  if (condition.caseSensitive === true) parts.push(plain(' (exact case)'));
  return parts;
}

function joined(groups: RulePart[][], between: string): RulePart[] {
  return groups.flatMap((group, index) => (index === 0 ? group : [plain(between), ...group]));
}

/** Leaves of one `any` that test one field the same way: said once, their operands joined by "or". */
function sameTest(children: unknown[]): Json[] | null {
  const leaves = children.filter(isRecord);
  if (leaves.length !== children.length || leaves.length < 2) return null;
  const first = leaves[0];
  if (first === undefined || typeof first.path !== 'string' || !(first.op as string) || !('value' in first))
    return null;
  const same = leaves.every(
    (each) =>
      each.path === first.path &&
      each.op === first.op &&
      each.caseSensitive === first.caseSensitive &&
      'value' in each &&
      !('all' in each || 'any' in each || 'not' in each),
  );
  return same && typeof first.op === 'string' && OP_WORDS[first.op] !== undefined && first.op !== 'domainIs'
    ? leaves
    : null;
}

/** A condition tree, as a line of words: "The subject contains invoice or payment". */
export function describeCondition(condition: unknown, start = true): RulePart[] {
  if (!isRecord(condition)) return [plain(start ? 'Any message' : 'any message')];
  if (Array.isArray(condition.all)) {
    return joined(
      condition.all.map((child, index) => describeCondition(child, start && index === 0)),
      ', and ',
    );
  }
  if (Array.isArray(condition.any)) {
    const same = sameTest(condition.any);
    if (same !== null) {
      const [first] = same;
      const head = leaf(first as Json, start);
      const tail = same.slice(1).flatMap((each) => [plain(' or '), operand(each.value)]);
      const exact = head.at(-1)?.text === ' (exact case)';
      return exact ? [...head.slice(0, -1), ...tail, plain(' (exact case)')] : [...head, ...tail];
    }
    return joined(
      condition.any.map((child, index) => describeCondition(child, start && index === 0)),
      ', or ',
    );
  }
  if ('not' in condition) return [plain(start ? 'Not: ' : 'not: '), ...describeCondition(condition.not, false)];
  return leaf(condition, start);
}

/** A line of a panel: what it says, and a quieter line beneath. */
export interface PanelLine {
  main: RulePart[];
  detail: RulePart[];
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A length of time in whole hours or days: "24 hours", "30 days". */
export function span(ms: number): string {
  if (ms % DAY === 0 && ms >= DAY && ms !== DAY) return `${ms / DAY} days`;
  const hours = Math.round(ms / HOUR);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** What a rule watches: its channel and accounts, then which of their events. */
export function watches(document: Json | null, alias: (id: string) => string): PanelLine {
  const channel = channelOf(document);
  const accounts = accountIdsOf(document).map((id) => [value(alias(id))]);
  const main: RulePart[] = [plain(channel === null ? 'An account' : productLabel(channel))];
  if (accounts.length > 0) main.push(plain(' · '), ...joined(accounts, ', '));
  const type = isRecord(document?.event) ? text(document.event.type) : null;
  const options = isRecord(document?.source) && isRecord(document.source.options) ? document.source.options : {};
  return { main, detail: eventWords(type, options) };
}

function eventWords(type: string | null, options: Json): RulePart[] {
  switch (type) {
    case 'gmail.message.received': {
      const parts = [plain('New mail')];
      if (options.labels === 'inbox') parts.push(plain(' in the inbox'));
      else if (options.labels === 'any') parts.push(plain(' with any label'));
      else if (Array.isArray(options.labels) && options.labels.length > 0) {
        parts.push(
          plain(options.labels.length === 1 ? ' with the label ' : ' with the labels '),
          ...joined(
            options.labels.map((label) => [operand(label)]),
            ', ',
          ),
        );
      }
      if (options.includeSpamTrash === true) parts.push(plain(', spam and trash too'));
      return parts;
    }
    case 'gmail.message.sent':
      return [plain('Mail you send')];
    case 'gmail.message.labelled':
      return [plain('Labels added to mail or taken off it')];
    default:
      break;
  }
  const channel = type?.slice(0, type.indexOf('.')) ?? '';
  if (channel === 'slack') {
    const count = Array.isArray(options.conversations) ? options.conversations.length : 0;
    return [
      plain(
        count === 0 ? 'New messages' : `New messages in ${count === 1 ? '1 conversation' : `${count} conversations`}`,
      ),
    ];
  }
  if (channel === 'whatsapp') {
    if (options.chats === 'all-allowed') return [plain('New messages in every chat it may read')];
    const count = Array.isArray(options.chats) ? options.chats.length : 0;
    return [plain(`New messages in ${count === 1 ? '1 chat' : `${count} chats`}`)];
  }
  if (channel === 'resend') {
    const kinds = Array.isArray(options.kinds) ? options.kinds : [];
    const words = [
      kinds.includes('received') ? 'Mail received' : null,
      kinds.includes('status') ? 'delivery updates' : null,
    ]
      .filter(Boolean)
      .join(' and ');
    return [plain(words === '' ? 'Resend events' : words.charAt(0).toUpperCase() + words.slice(1))];
  }
  return type === null ? [] : [plain('Events of type '), value(type)];
}

/** Which messages a rule picks out: its condition, in words. */
export function whichMessages(document: Json | null): PanelLine {
  return { main: describeCondition(document?.condition), detail: [] };
}

/** A judge's kind, as the Judges tab names it. */
export function judgeName(kind: unknown): string {
  switch (kind) {
    case 'typesafe':
      return 'Jev';
    case 'laya':
      return 'Laya';
    case 'local-endpoint':
      return 'A local model server';
    default:
      return typeof kind === 'string' && kind !== '' ? kind : 'A judge';
  }
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = { openrouter: 'OpenRouter', typesafe: 'TypeSafe' };

/** The judge a rule asks, and what it asks; or that it asks none. */
export function judgeLine(document: Json | null): PanelLine {
  const agentic = isRecord(document?.agentic) ? document.agentic : null;
  if (agentic === null)
    return { main: [plain('No judge')], detail: [plain('Every message that matches is passed on.')] };
  const judge = isRecord(agentic.judge) ? agentic.judge : {};
  const provider = text(judge.provider);
  const main: RulePart[] = [value(judgeName(judge.kind))];
  if (provider !== null && provider !== judge.kind)
    main.push(plain(', through '), value(PROVIDER_NAMES[provider] ?? provider));
  const detail: RulePart[] = [];
  const question = text(agentic.question);
  if (question !== null) detail.push(plain('Asks: '), authored(question));
  if (typeof agentic.threshold === 'number') {
    if (detail.length > 0) detail.push(plain(' · '));
    detail.push(
      plain(
        judge.kind === 'local-endpoint'
          ? `yes at a score of ${agentic.threshold.toFixed(2)} or more`
          : `yes when ${agentic.threshold.toFixed(2)} sure or more`,
      ),
    );
  }
  if (agentic.onUncertain === 'hold') {
    if (detail.length > 0) detail.push(plain(' · '));
    detail.push(plain("when it can't tell, the message waits for you"));
  }
  return { main, detail };
}

/** Where a target sends what a rule matches, as a line of words: "Queue, lane billing". */
export function targetWords(target: TargetView): RulePart[] {
  switch (target.kind) {
    case 'dry-run':
      return [value('Dry-run log')];
    case 'queue':
      return target.lane === null ? [value('Queue')] : [value('Queue'), plain(', lane '), value(target.lane)];
    case 'webhook':
      return target.host === null ? [value('Webhook')] : [value('Webhook'), plain(', '), value(target.host)];
    case 'sse':
      return [value('Live stream')];
    case 'linear':
      return target.team === null
        ? [value('Linear issue')]
        : [value('Linear issue'), plain(', team '), value(target.team)];
    case 'session':
      return target.folder === null
        ? [value('Agent session')]
        : [value('Agent session'), plain(', '), authored(target.folder)];
    default:
      return [value(target.id ?? 'A target')];
  }
}

/** Where a rule's matches go: each target, and a line on what it does. */
export function whereTheyGo(document: Json | null): PanelLine[] {
  const targets = targetsOf(document);
  if (targets.length === 0) return [{ main: [plain('Nowhere')], detail: [] }];
  return targets.map((target) => {
    switch (target.kind) {
      case 'dry-run':
        return { main: [value('Dry-run log'), plain(' on this Mac')], detail: [plain('Nothing is sent anywhere.')] };
      case 'queue':
        return {
          main: targetWords(target),
          detail: [plain(target.lane === null ? 'Your list in this app' : 'Wakes the agent window bound to that lane')],
        };
      case 'webhook':
        return {
          main: targetWords(target),
          detail: [
            plain(
              target.retryLimit === null
                ? 'Signed with the target’s key'
                : `Signed with the target’s key · tries up to ${target.retryLimit} times`,
            ),
          ],
        };
      case 'sse':
        return { main: targetWords(target), detail: [plain('To the apps that subscribe to it')] };
      case 'linear':
        return { main: targetWords(target), detail: [plain('Adds an issue, through your Linear key')] };
      case 'session':
        return {
          main: targetWords(target),
          detail: [plain(target.codex ? 'Hands it to a Codex session' : 'Hands it to a Claude Code session')],
        };
      default:
        return { main: targetWords(target), detail: [] };
    }
  });
}

/** The fields a mapping passes on, by their pointers, in the order it names them. */
export function mappedFields(mapping: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (isRecord(node)) {
      if (typeof node.$path === 'string') {
        if (!found.includes(node.$path)) found.push(node.$path);
      } else Object.values(node).forEach(walk);
    }
  };
  walk(mapping);
  return found;
}

/** What a rule keeps of a message, and for how long. */
export function whatsKept(document: Json | null): PanelLine {
  const fields = mappedFields(document?.mapping).map((pointer) => [field(pointer)]);
  const main: RulePart[] =
    fields.length === 0 ? [plain('Nothing of the message')] : [plain('It keeps '), ...joined(fields, ', ')];
  const detail: RulePart[] = [];
  for (const target of targetsOf(document)) {
    if (detail.length > 0) detail.push(plain(' · '));
    if (target.kind === 'queue' && target.retentionMs !== null) {
      detail.push(plain(`In the Queue for ${span(target.retentionMs)}, then deleted`));
      if (target.show === 'minimal') detail.push(plain(', without its first words or a link'));
    } else if (target.kind === 'dry-run' && target.retentionMs !== null) {
      detail.push(plain(`The dry-run log keeps each entry for ${span(target.retentionMs)}`));
    } else {
      const retention = deliveryRetentionOf(document);
      detail.push(
        plain(
          retention === null ? 'Kept until it is delivered' : `Kept until it is delivered, ${span(retention)} at most`,
        ),
      );
    }
  }
  return { main, detail };
}

/** A rule's limit: how many it passes on in an hour, and how often its judge may be asked. */
export function limitLine(document: Json | null): PanelLine {
  const cap = whole(document?.deliveryRateCap);
  const agentic = isRecord(document?.agentic) ? document.agentic : null;
  const calls = whole(agentic?.callsPerRollingHour);
  const detail: RulePart[] = [plain('The limit you approved with the rule')];
  if (calls !== null) detail.push(plain(` · its judge is asked at most ${calls} times an hour`));
  return { main: [plain(cap === null ? 'No limit is recorded' : `At most ${cap} an hour`)], detail };
}

/** The parts of a document two versions may differ in, in the words the panels use. */
const SECTIONS: readonly [string, (document: Json) => unknown][] = [
  ['what it watches', (document) => [document.source, document.event]],
  ['which messages', (document) => document.condition],
  ['the judge', (document) => document.agentic ?? null],
  ['where they go', (document) => [document.targets, document.subscribers]],
  ["what's kept", (document) => [document.mapping, document.retention, document.cloudEventType ?? null]],
  ['the limit', (document) => document.deliveryRateCap],
];

/** What changed from one version's document to the next's, as the panels name them; empty when nothing did. */
export function changedSections(before: Json | null, after: Json | null): string[] {
  if (before === null || after === null) return [];
  return SECTIONS.filter(([, read]) => JSON.stringify(read(before)) !== JSON.stringify(read(after))).map(
    ([name]) => name,
  );
}
