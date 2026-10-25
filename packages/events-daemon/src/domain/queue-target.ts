import { randomBytes } from 'node:crypto';
import { canonicalJson } from '@agentcomms/core';
import { getPointer, type JsonValue, relatePointers } from '@agentcomms/events';
import { EventDomainError } from './lifecycle.ts';

/**
 * The action queue's target (action queue design §4.1, §7 Q2 and Q4). A queue target is local and secretless: a match
 * becomes one encrypted item in the person's list, read only at a terminal or in the app, never through MCP (Q1).
 */

const DAY_MS = 86_400_000;

/** A queue retention is 1 to 30 days and defaults to 7, on the target version and on the rule's `queueMs` alike. */
export const QUEUE_RETENTION_MIN_MS: number = DAY_MS;
export const QUEUE_RETENTION_MAX_MS: number = 30 * DAY_MS;
export const QUEUE_RETENTION_DEFAULT_MS: number = 7 * DAY_MS;

/** What an item shows: `summary` (from whom, subject or first words, and a link) or `minimal` (no first words, no link). */
export const QUEUE_SHOW_VALUES: readonly ['summary', 'minimal'] = Object.freeze(['summary', 'minimal'] as const);
export type QueueShow = (typeof QUEUE_SHOW_VALUES)[number];

export interface QueueTargetDocument {
  readonly targetId: string;
  readonly version: number;
  readonly kind: 'queue';
  readonly retentionMs: number;
  readonly show: QueueShow;
}

function fail(message: string, code: EventDomainError['code'] = 'VERSION_DOCUMENT_INVALID'): never {
  throw new EventDomainError(code, message);
}

/** Whether `value` is a whole number of milliseconds within a queue retention's bounds. */
export function isQueueRetention(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= QUEUE_RETENTION_MIN_MS &&
    (value as number) <= QUEUE_RETENTION_MAX_MS
  );
}

/** The canonical immutable queue target: exact keys, its defaults written out, so the digest binds what applies. */
export function canonicalQueueTarget(target: Record<string, unknown>): QueueTargetDocument {
  for (const key of Object.keys(target))
    if (!['targetId', 'version', 'kind', 'retentionMs', 'show'].includes(key))
      return fail(`a queue target has no ${key} field`);
  if (typeof target.targetId !== 'string' || target.targetId.length === 0)
    return fail('a target id is a non-empty string');
  if (!Number.isSafeInteger(target.version) || (target.version as number) < 1)
    return fail('a target version is a positive safe integer');
  const retentionMs = target.retentionMs ?? QUEUE_RETENTION_DEFAULT_MS;
  if (!isQueueRetention(retentionMs)) return fail('a queue retention is 1 to 30 days, in milliseconds');
  const show = target.show ?? 'summary';
  if (!(QUEUE_SHOW_VALUES as readonly unknown[]).includes(show)) return fail('a queue target shows summary or minimal');
  return {
    targetId: target.targetId,
    version: target.version as number,
    kind: 'queue',
    retentionMs,
    show: show as QueueShow,
  };
}

/** The action queue's closed vocabularies (the §8 CLI contract). */
export const QUEUE_STATES: readonly ['open', 'done', 'dismissed'] = Object.freeze([
  'open',
  'done',
  'dismissed',
] as const);
export type QueueState = (typeof QUEUE_STATES)[number];
export const QUEUE_CHANNELS: readonly ['gmail', 'slack', 'resend', 'whatsapp'] = Object.freeze([
  'gmail',
  'slack',
  'resend',
  'whatsapp',
] as const);
export type QueueChannel = (typeof QUEUE_CHANNELS)[number];

/** `--state` takes an item state or `all`. */
export const QUEUE_STATE_FILTERS: readonly ['open', 'done', 'dismissed', 'all'] = Object.freeze([
  'open',
  'done',
  'dismissed',
  'all',
] as const);
export type QueueStateFilter = (typeof QUEUE_STATE_FILTERS)[number];
export const QUEUE_JUDGE_STATES: readonly ['answered', 'expired', 'released', 'none'] = Object.freeze([
  'answered',
  'expired',
  'released',
  'none',
] as const);
export type QueueJudgeState = (typeof QUEUE_JUDGE_STATES)[number];
export const QUEUE_JUDGE_ANSWERS: readonly ['yes', 'no'] = Object.freeze(['yes', 'no'] as const);
export type QueueJudgeAnswer = (typeof QUEUE_JUDGE_ANSWERS)[number];
export const QUEUE_LINK_KINDS: readonly ['gmail', 'slack'] = Object.freeze(['gmail', 'slack'] as const);
export type QueueLinkKind = (typeof QUEUE_LINK_KINDS)[number];

// Item ids (the CLI contract): `qi_` and 26 Crockford base32 characters, a 48-bit time and 80 random bits.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const QUEUE_ITEM_ID = /^qi_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A new item id. Ids made later sort after earlier ones; two made in the same millisecond still differ. */
export function newQueueItemId(now: number = Date.now()): string {
  let time = '';
  let remaining = Math.max(0, Math.floor(now));
  for (let index = 0; index < 10; index += 1) {
    time = `${CROCKFORD[remaining % 32]}${time}`;
    remaining = Math.floor(remaining / 32);
  }
  const random = randomBytes(10);
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let tail = '';
  for (let index = 0; index < 16; index += 1) {
    tail = `${CROCKFORD[Number(bits & 31n)]}${tail}`;
    bits >>= 5n;
  }
  return `qi_${time}${tail}`;
}

/** The item id grammar every surface checks before it asks the owner anything. */
export function isQueueItemId(value: unknown): value is string {
  return typeof value === 'string' && QUEUE_ITEM_ID.test(value);
}

/**
 * What an item can show for one event type, as source pointers (Q4). Each `required` entry is satisfied when the rule's
 * mapping includes one of its pointers; `label` is how a refusal names it. Fields not listed are never read.
 */
interface QueueFieldPlan {
  readonly required: readonly { readonly label: string; readonly anyOf: readonly string[] }[];
  readonly fromName?: string;
  readonly fromAddress?: string;
  readonly subject?: string;
  /** The first words come from the first of these the mapping includes; nothing is fetched to fill them. */
  readonly text: readonly string[];
  /** Whether the channel has a subject; without one, the first words stand in for it, as Q4 says. */
  readonly hasSubject: boolean;
  readonly link?: 'gmail' | 'slack';
}

const GMAIL_MESSAGE: QueueFieldPlan = {
  required: [
    { label: 'from.address', anyOf: ['/from/address'] },
    { label: 'subject', anyOf: ['/subject'] },
  ],
  fromName: '/from/name',
  fromAddress: '/from/address',
  subject: '/subject',
  text: ['/body', '/snippet'],
  hasSubject: true,
  link: 'gmail',
};

const QUEUE_FIELD_PLANS: Readonly<Record<string, QueueFieldPlan>> = Object.freeze({
  'gmail.message.received': GMAIL_MESSAGE,
  'gmail.message.sent': GMAIL_MESSAGE,
  // A label change carries no sender or subject, so a queue target cannot show it (Q4 refuses it by name).
  'gmail.message.labelled': {
    required: GMAIL_MESSAGE.required,
    text: [],
    hasSubject: true,
  },
  'slack.message.posted': {
    required: [
      { label: 'author.name', anyOf: ['/author/name'] },
      { label: 'text', anyOf: ['/text'] },
    ],
    fromName: '/author/name',
    text: ['/text'],
    hasSubject: false,
    link: 'slack',
  },
  'resend.email.received': {
    required: [
      { label: 'from.address', anyOf: ['/from/address'] },
      { label: 'subject or body', anyOf: ['/subject', '/body'] },
    ],
    fromName: '/from/name',
    fromAddress: '/from/address',
    subject: '/subject',
    text: ['/body'],
    hasSubject: true,
  },
  'resend.email.status_changed': {
    required: [
      { label: 'from.address', anyOf: ['/from/address'] },
      { label: 'subject', anyOf: ['/subject'] },
    ],
    fromName: '/from/name',
    fromAddress: '/from/address',
    subject: '/subject',
    text: [],
    hasSubject: true,
  },
  'whatsapp.message.received': {
    required: [
      { label: 'sender.name or sender.id', anyOf: ['/sender/name', '/sender/id'] },
      { label: 'text', anyOf: ['/text'] },
    ],
    fromName: '/sender/name',
    fromAddress: '/sender/id',
    text: ['/text'],
    hasSubject: false,
  },
});

function planFor(eventType: string): QueueFieldPlan {
  return QUEUE_FIELD_PLANS[eventType] ?? fail('a queue target shows only a catalogued message event');
}

/** Every source pointer a mapping template references (`{ "$path": … }`), in template order. */
export function mappedSourcePointers(template: JsonValue): readonly string[] {
  const pointers: string[] = [];
  const walk = (value: JsonValue): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const object = value as Readonly<Record<string, JsonValue>>;
    if (Object.hasOwn(object, '$path') && typeof object.$path === 'string') {
      pointers.push(object.$path);
      return;
    }
    for (const member of Object.values(object)) walk(member);
  };
  walk(template);
  return pointers;
}

/** A mapping includes a field when it references that field or a parent of it (a parent keeps its whole subtree). */
function covers(mapped: readonly string[], pointer: string): boolean {
  return mapped.some((reference) => {
    const relation = relatePointers(reference, pointer);
    return relation === 'equal' || relation === 'ancestor';
  });
}

/** The fields a queue target needs that this mapping does not include, by their refusal labels (Q4). */
export function missingQueueFields(eventType: string, mapping: JsonValue): readonly string[] {
  const plan = planFor(eventType);
  const mapped = mappedSourcePointers(mapping);
  return plan.required
    .filter((requirement) => !requirement.anyOf.some((pointer) => covers(mapped, pointer)))
    .map((requirement) => requirement.label);
}

/** Refuses a rule with a queue target unless its mapping includes every field the item shows, naming the rest. */
export function assertQueueMapping(eventType: string, mapping: JsonValue): void {
  const missing = missingQueueFields(eventType, mapping);
  if (missing.length > 0)
    fail(`a queue target needs the rule's mapping to include ${missing.join(', ')}`, 'QUEUE_MAPPING_INCOMPLETE');
}

/** An item's encrypted content: sender-written text as the source sanitised it, never wrapped, never fetched. */
export interface QueueItemContent {
  readonly from: { readonly name?: string; readonly address?: string };
  readonly subject?: string;
  readonly text?: string;
  /** The ids a link needs, kept only when the mapping includes them; the link itself is made when it is read. */
  readonly link?:
    | { readonly kind: 'gmail'; readonly messageId: string }
    | {
        readonly kind: 'slack';
        readonly workspaceId: string;
        readonly channelId: string;
        readonly threadTs?: string;
      };
}

/** "First 140 characters": counted in code points, so an astral character is never split. */
export const QUEUE_TEXT_LIMIT: number = 140;

function firstCharacters(text: string): string {
  const characters = Array.from(text);
  return characters.length <= QUEUE_TEXT_LIMIT ? text : characters.slice(0, QUEUE_TEXT_LIMIT).join('');
}

function mappedText(event: JsonValue, mapped: readonly string[], pointer: string | undefined): string | undefined {
  if (pointer === undefined || !covers(mapped, pointer)) return undefined;
  const found = getPointer(event, pointer);
  return found.found && typeof found.value === 'string' ? found.value : undefined;
}

/**
 * Builds an item's content from the matched event's projection, reading only fields the rule's mapping includes (Q4,
 * D8's "keep only what the rule uses"). `minimal` keeps from whom and the subject; a channel with no subject keeps its
 * first words in the subject's place. Links appear only for `summary`, and only when their ids are mapped.
 */
export function queueItemContent(input: {
  readonly eventType: string;
  readonly mapping: JsonValue;
  readonly event: JsonValue;
  readonly show: QueueShow;
}): QueueItemContent {
  const plan = planFor(input.eventType);
  const mapped = mappedSourcePointers(input.mapping);
  const name = mappedText(input.event, mapped, plan.fromName);
  const address = mappedText(input.event, mapped, plan.fromAddress);
  const subject = mappedText(input.event, mapped, plan.subject);
  const words = plan.text
    .map((pointer) => mappedText(input.event, mapped, pointer))
    .find((value) => value !== undefined);
  const showWords = input.show === 'summary' || !plan.hasSubject;
  const link = input.show === 'summary' ? linkIds(plan, input.event, mapped) : undefined;
  return {
    from: {
      ...(name === undefined || name.length === 0 ? {} : { name }),
      ...(address === undefined || address.length === 0 ? {} : { address }),
    },
    ...(subject === undefined ? {} : { subject }),
    ...(words === undefined || !showWords ? {} : { text: firstCharacters(words) }),
    ...(link === undefined ? {} : { link }),
  };
}

const GMAIL_ID = /^[0-9A-Za-z_-]{1,128}$/;
const SLACK_ID = /^[0-9A-Z]{1,32}$/;
const SLACK_TS = /^[0-9]+\.[0-9]{6}$/;

function linkIds(plan: QueueFieldPlan, event: JsonValue, mapped: readonly string[]): QueueItemContent['link'] {
  if (plan.link === 'gmail') {
    const messageId = mappedText(event, mapped, '/messageId');
    return messageId !== undefined && GMAIL_ID.test(messageId) ? { kind: 'gmail', messageId } : undefined;
  }
  if (plan.link === 'slack') {
    const workspaceId = mappedText(event, mapped, '/workspaceId');
    const channelId = mappedText(event, mapped, '/channel/id');
    if (workspaceId === undefined || channelId === undefined) return undefined;
    if (!SLACK_ID.test(workspaceId) || !SLACK_ID.test(channelId)) return undefined;
    const threadTs = mappedText(event, mapped, '/threadTs');
    return {
      kind: 'slack',
      workspaceId,
      channelId,
      ...(threadTs === undefined || !SLACK_TS.test(threadTs) ? {} : { threadTs }),
    };
  }
  return undefined;
}

/** Reads back stored content; anything malformed is unreadable, never shown in part. */
export function parseQueueItemContent(value: unknown): QueueItemContent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (field: unknown) => field === undefined || typeof field === 'string';
  const from = record.from as Record<string, unknown> | undefined;
  if (typeof from !== 'object' || from === null || Array.isArray(from)) return null;
  if (!text(from.name) || !text(from.address) || !text(record.subject) || !text(record.text)) return null;
  const link = record.link as Record<string, unknown> | undefined;
  if (link !== undefined) {
    if (typeof link !== 'object' || link === null) return null;
    if (link.kind === 'gmail') {
      if (typeof link.messageId !== 'string' || !GMAIL_ID.test(link.messageId)) return null;
    } else if (link.kind === 'slack') {
      if (typeof link.workspaceId !== 'string' || !SLACK_ID.test(link.workspaceId)) return null;
      if (typeof link.channelId !== 'string' || !SLACK_ID.test(link.channelId)) return null;
      if (link.threadTs !== undefined && (typeof link.threadTs !== 'string' || !SLACK_TS.test(link.threadTs)))
        return null;
    } else return null;
  }
  return JSON.parse(canonicalJson(value)) as QueueItemContent;
}

/**
 * The link an item opens, only on its provider's own web host (design §8 Task B's allow-list): Gmail's web link for the
 * account the message arrived in, or Slack's web client for the conversation (and its thread, when there is one).
 */
export function queueItemLink(
  link: QueueItemContent['link'],
  gmailAccountEmail?: string | undefined,
): { readonly kind: 'gmail' | 'slack'; readonly url: string } | undefined {
  if (link === undefined) return undefined;
  if (link.kind === 'gmail') {
    const account = gmailAccountEmail === undefined ? 'u/0/' : `?authuser=${encodeURIComponent(gmailAccountEmail)}`;
    return {
      kind: 'gmail',
      url: `https://mail.google.com/mail/${account}#all/${encodeURIComponent(link.messageId)}`,
    };
  }
  const base = `https://app.slack.com/client/${link.workspaceId}/${link.channelId}`;
  return {
    kind: 'slack',
    url: link.threadTs === undefined ? base : `${base}/thread/${link.channelId}-${link.threadTs}`,
  };
}
