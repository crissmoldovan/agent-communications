/**
 * The event service's deliveries, as Events → Deliveries reads them (owner feedback 0.32.0, §3.5): `deliveries list
 * --json`, content-free rows; `delivery show <delivery> --json`, one delivery with its decision, its event's ids and
 * times, and its target; and `dryrun show <delivery> --json`, the record a dry run would have delivered.
 *
 * A delivery's next try is a time only while it waits to be tried — queued or retryable — and only when it is a
 * positive moment: the event service writes 0 for "due now", and once kept 0 on delivered rows, which the app showed as
 * 1 January 1970. Nothing here makes markup: a dry-run record's fields stay strings, which the screen shows as text a
 * sender wrote.
 */
import { splitEnvelopes } from './envelope.ts';
import { isDeliveryId } from './grammar.ts';
import { openableLink } from './queue.ts';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** A time in epoch milliseconds: a positive whole number. Zero or less is no time at all. */
const moment = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/** One delivery, as `deliveries list` gives it. */
export interface DeliveryRow {
  id: string;
  /** Whether the id is one the allow-list takes, so the delivery can be opened, tried again or dropped. */
  openable: boolean;
  ruleId: string;
  ruleVersion: number | null;
  targetId: string;
  targetVersion: number | null;
  accountId: string;
  attempts: number;
  /** As the event service wrote it: a time, 0 for "due now", or null. Read it through `nextTry`. */
  nextAt: number | null;
  expiresAt: number | null;
  state: string;
  /** `dry-run`, `webhook`, `sse`, `queue`, or since 0.33.0 `linear` and `session`; null before 0.32.0. */
  targetKind: string | null;
  lastErrorCode: string | null;
  lastStatus: number | null;
  decisionId: string | null;
  eventId: string | null;
  deliveredAt: number | null;
  /** When it failed for good; null while it has not (and from an events service older than 0.32.0). */
  deadLetteredAt: number | null;
  /**
   * The Linear issue a Linear delivery added (0.33.0): its identifier, and its address when it is one the app opens in
   * the person's browser (`isLinearIssueLink`, as `links.rs` checks it); null for any other delivery.
   */
  linear: { identifier: string; url: string | null } | null;
}

/** A Linear issue's address as a delivery keeps it: `https://linear.app/[<workspace>/]issue/<TEAM-n>`, nothing else. */
const LINEAR_ISSUE_LINK = /^https:\/\/linear\.app\/(?:[A-Za-z0-9_-]{1,64}\/)?issue\/[A-Za-z0-9_]{1,32}-[0-9]{1,10}$/u;
const LINEAR_IDENTIFIER = /^[A-Za-z0-9_]{1,32}-[0-9]{1,10}$/u;

/** Whether the app opens `url`, a Linear issue's address, in the person's browser: Rust checks the same again. */
export function isLinearIssueLink(url: string): boolean {
  return LINEAR_ISSUE_LINK.test(url);
}

function linearOf(value: unknown): DeliveryRow['linear'] {
  if (!isRecord(value)) return null;
  const identifier = text(value.identifier);
  if (identifier === null || !LINEAR_IDENTIFIER.test(identifier)) return null;
  const url = text(value.url);
  return { identifier, url: url !== null && isLinearIssueLink(url) ? url : null };
}

function rowOf(value: unknown): DeliveryRow | null {
  if (!isRecord(value)) return null;
  const id = text(value.deliveryId);
  if (id === null) return null;
  return {
    id,
    openable: isDeliveryId(id),
    ruleId: text(value.ruleId) ?? '',
    ruleVersion: whole(value.ruleVersion),
    targetId: text(value.targetId) ?? '',
    targetVersion: whole(value.targetVersion),
    accountId: text(value.accountId) ?? '',
    attempts: whole(value.attempts) ?? 0,
    nextAt: typeof value.nextAt === 'number' && Number.isFinite(value.nextAt) ? value.nextAt : null,
    expiresAt: moment(value.expiresAt),
    state: text(value.state) ?? '',
    targetKind: text(value.targetKind),
    lastErrorCode: text(value.lastErrorCode),
    lastStatus: whole(value.lastStatus),
    decisionId: text(value.decisionId),
    eventId: text(value.eventId),
    deliveredAt: moment(value.deliveredAt),
    deadLetteredAt: moment(value.deadLetteredAt),
    linear: linearOf(value.linear),
  };
}

/** `deliveries list --json`, read: every row with an id. Null when it is not that answer at all. */
export function readDeliveries(value: unknown): DeliveryRow[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((each) => rowOf(each) ?? []);
}

/** The states a delivery waits to be tried in: only these have a next try. */
const WAITING: ReadonlySet<string> = new Set(['queued', 'retryable']);

/**
 * When a delivery is tried next: only while it is queued or will try again, and only a positive time. A delivered,
 * failed or cancelled delivery has none, and 0 ("due now") or less is never a date.
 */
export function nextTry(row: Pick<DeliveryRow, 'state' | 'nextAt'> & { lastErrorCode?: string | null }): number | null {
  if (!WAITING.has(row.state)) return null;
  // A match waiting for a busy session is due only at its expiry: it is passed on when the session's run ends.
  if (waitingForSession(row)) return null;
  return moment(row.nextAt);
}

/**
 * Whether a delivery waits for a busy agent session (0.33.0, design §3.5): the event service keeps it `retryable`,
 * its last answer the relay's 409 (`SESSION_BUSY`), in its busy queue until the session's run ends.
 */
export function waitingForSession(row: { state: string; lastErrorCode?: string | null }): boolean {
  return row.state === 'retryable' && row.lastErrorCode === 'SESSION_BUSY';
}

/**
 * The filters the list offers, and which states each holds. A match waiting for a busy session (0.33.0) is under
 * Waiting for a session, not Will try again: it is not tried until the session's run ends.
 */
export type DeliveryGroup = 'trying' | 'waiting' | 'failed' | 'done';

const GROUPS: Readonly<Record<string, DeliveryGroup>> = {
  queued: 'trying',
  retryable: 'trying',
  disclosing: 'trying',
  'dead-lettered': 'failed',
  'content-unreadable': 'failed',
  delivered: 'done',
  'retention-expired': 'done',
  cancelled: 'done',
  'in-flight-at-disable': 'done',
  'in-flight-at-account-removal': 'done',
};

/** Which filter a delivery is under; an unknown state is under none but All. */
export function deliveryGroup(
  row: Pick<DeliveryRow, 'state'> & { lastErrorCode?: string | null },
): DeliveryGroup | null {
  if (waitingForSession(row)) return 'waiting';
  return GROUPS[row.state] ?? null;
}

export type ChipTone = 'ok' | 'accent' | 'warn' | 'danger' | 'neutral' | 'busy';

/** A delivery's state in plain words, and its chip's tone. A delivered dry run is recorded: nothing was sent. */
export function stateWords(row: Pick<DeliveryRow, 'state' | 'targetKind'> & { lastErrorCode?: string | null }): {
  words: string;
  tone: ChipTone;
} {
  if (waitingForSession(row)) return { words: 'Waiting for a session', tone: 'neutral' };
  switch (row.state) {
    case 'delivered':
      return row.targetKind === 'dry-run' ? { words: 'Recorded', tone: 'accent' } : { words: 'Delivered', tone: 'ok' };
    case 'retryable':
      return { words: 'Will try again', tone: 'warn' };
    case 'queued':
      return { words: 'Waiting', tone: 'neutral' };
    case 'disclosing':
      return { words: 'Sending', tone: 'busy' };
    case 'dead-lettered':
    case 'content-unreadable':
      return { words: 'Failed', tone: 'danger' };
    case 'retention-expired':
      return { words: 'Expired', tone: 'neutral' };
    case 'cancelled':
    case 'in-flight-at-disable':
    case 'in-flight-at-account-removal':
      return { words: 'Cancelled', tone: 'neutral' };
    default:
      return { words: row.state === '' ? 'Unknown' : row.state, tone: 'neutral' };
  }
}

/**
 * When a delivery was made: when it was delivered, where the event service kept that; else its expiry less its rule's
 * delivery retention, since a delivery expires exactly that long after it is made. Null when neither is known.
 */
export function madeAt(row: Pick<DeliveryRow, 'deliveredAt' | 'expiresAt'>, retentionMs: number | null): number | null {
  if (row.deliveredAt !== null) return row.deliveredAt;
  if (row.expiresAt === null || retentionMs === null) return null;
  const made = row.expiresAt - retentionMs;
  return made > 0 ? made : null;
}

/** The longest the dry-run log keeps an entry (the event service's `MAX_DRYRUN_RETENTION_MS`): 24 hours. */
export const DRY_RUN_KEPT_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a dry-run delivery's log entry is gone (0.34.0 design B5): it was written longer ago than its target keeps one,
 * which is 24 hours at most. Its row stays in the list, folded. Only a delivered dry run, written at a known time; any
 * other delivery, or one whose time is not known, is not said to be gone.
 */
export function dryRunRemoved(
  row: Pick<DeliveryRow, 'state' | 'deliveredAt'> & { kind: string | null },
  retentionMs: number | null,
  now: number,
): boolean {
  if (row.kind !== 'dry-run' || row.state !== 'delivered' || row.deliveredAt === null) return false;
  const kept = retentionMs === null || retentionMs <= 0 ? DRY_RUN_KEPT_MS : Math.min(retentionMs, DRY_RUN_KEPT_MS);
  return row.deliveredAt + kept <= now;
}

/** What a delivery's last try got, in words to follow "Its last try:", or null when nothing is recorded. */
export function lastAnswer(row: Pick<DeliveryRow, 'lastErrorCode' | 'lastStatus' | 'targetKind'>): string | null {
  const who = row.targetKind === 'webhook' ? 'the webhook' : 'the target';
  if (row.lastErrorCode === 'SESSION_BUSY') return 'the session was busy';
  // `session-queue drop` (0.33.0) cancels a match that waited for a busy session, and says so in its last error.
  if (row.lastErrorCode === 'DROPPED_BY_PERSON') return 'the session was busy, and it was dropped while it waited';
  if (row.lastErrorCode === 'NETWORK') return `${who} could not be reached`;
  if (row.lastStatus !== null) {
    const unavailable = row.lastStatus === 503 ? ', it is unavailable' : '';
    return `${who} answered ${row.lastStatus}${unavailable}`;
  }
  if (row.lastErrorCode !== null) return `${who} failed: ${row.lastErrorCode}`;
  return null;
}

// ── The busy queue ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One match waiting for a busy agent session, as `session-queue list --json` gives it (0.33.0, design §3.5): its
 * delivery, when it was queued, whether the session's run has ended and let it go, and when it runs out of time. Ids
 * and times only: the queue holds no sender text.
 */
export interface SessionQueueItem {
  deliveryId: string;
  ruleId: string;
  /** The lane the target finds its session by; null for a session found by its folder. */
  lane: string | null;
  queuedAt: number;
  released: boolean;
  expiresAt: number | null;
}

const isoMoment = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > 0 ? at : null;
};

/** `{ items: [...] }`, oldest first; an item the app cannot read is left out, and an unreadable answer is null. */
export function readSessionQueue(value: unknown): SessionQueueItem[] | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items: SessionQueueItem[] = [];
  for (const each of value.items) {
    if (!isRecord(each)) continue;
    const deliveryId = text(each.deliveryId);
    const ruleId = text(each.ruleId);
    const queuedAt = isoMoment(each.queuedAt);
    if (deliveryId === null || ruleId === null || queuedAt === null || typeof each.released !== 'boolean') continue;
    items.push({
      deliveryId,
      ruleId,
      lane: text(each.lane),
      queuedAt,
      released: each.released,
      expiresAt: isoMoment(each.expiresAt),
    });
  }
  return items;
}

// ── One delivery ───────────────────────────────────────────────────────────────────────────────────────────────

/** A message's ids at its source, as `delivery show` reads them from the event (never any sender text). */
export type MessageSource =
  | { channel: 'gmail'; messageId: string }
  | { channel: 'slack'; channelId: string; ts: string }
  | { channel: 'whatsapp'; chatId: string; messageId: string }
  | { channel: 'resend'; emailId: string };

export interface DeliveryJudge {
  kind: string | null;
  answer: 'yes' | 'no' | null;
  confidence: number | null;
  calibrated: boolean | null;
}

export interface DeliveryDetail {
  delivery: DeliveryRow;
  decision: { outcome: string | null; decidedAt: number | null; judge: DeliveryJudge | null } | null;
  event: {
    eventId: string | null;
    type: string | null;
    accountId: string | null;
    occurredAt: number | null;
    observedAt: number | null;
    source: MessageSource | null;
  } | null;
  target: { kind: string | null; id: string | null; version: number | null; host: string | null; lane: string | null };
  /** A dry run's log entry and when it goes; null for any other target. Its `expiresAt` is null once it has gone. */
  dryRun: { expiresAt: number | null } | null;
}

/** An event's source ids, read from `{ channel, … }` (or by its event type's channel when no channel is given). */
function sourceOf(value: unknown, type: string | null): MessageSource | null {
  if (!isRecord(value)) return null;
  const channel = text(value.channel) ?? type?.slice(0, type.indexOf('.')) ?? null;
  switch (channel) {
    case 'gmail': {
      const messageId = text(value.messageId);
      return messageId === null ? null : { channel, messageId };
    }
    case 'slack': {
      const channelId = text(value.channelId);
      const ts = text(value.ts);
      return channelId === null || ts === null ? null : { channel, channelId, ts };
    }
    case 'whatsapp': {
      const chatId = text(value.chatId);
      const messageId = text(value.messageId);
      return chatId === null || messageId === null ? null : { channel, chatId, messageId };
    }
    case 'resend': {
      const emailId = text(value.emailId);
      return emailId === null ? null : { channel, emailId };
    }
    default:
      return null;
  }
}

function judgeOf(value: unknown): DeliveryJudge | null {
  if (!isRecord(value)) return null;
  const answer =
    value.answer === 'yes' || value.answer === true
      ? 'yes'
      : value.answer === 'no' || value.answer === false
        ? 'no'
        : null;
  return {
    kind: text(value.kind),
    answer,
    confidence: typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? value.confidence : null,
    calibrated: typeof value.calibrated === 'boolean' ? value.calibrated : null,
  };
}

/** `delivery show <delivery> --json`, read: null when it is not that answer at all. */
export function readDeliveryShow(value: unknown): DeliveryDetail | null {
  if (!isRecord(value)) return null;
  const delivery = rowOf(value.delivery);
  if (delivery === null) return null;
  const decision = isRecord(value.decision) ? value.decision : null;
  const event = isRecord(value.event) ? value.event : null;
  const target = isRecord(value.target) ? value.target : {};
  const type = text(event?.type);
  return {
    delivery,
    decision:
      decision === null
        ? null
        : { outcome: text(decision.outcome), decidedAt: moment(decision.decidedAt), judge: judgeOf(decision.judge) },
    event:
      event === null
        ? null
        : {
            eventId: text(event.eventId),
            type,
            accountId: text(event.accountId),
            occurredAt: moment(event.occurredAt),
            observedAt: moment(event.observedAt),
            source: sourceOf(event.source, type),
          },
    target: {
      kind: text(target.kind) ?? delivery.targetKind,
      id: text(target.id) ?? delivery.targetId,
      version: whole(target.version) ?? delivery.targetVersion,
      host: text(target.host),
      lane: text(target.lane),
    },
    dryRun: isRecord(value.dryRun) ? { expiresAt: moment(value.dryRun.expiresAt) } : null,
  };
}

/**
 * Who wrote one field of a dry-run record: the event service (`attribute`, the CloudEvent's own attributes), the
 * message's sender (`sender`, a field the record's `agentcommsuntrusted` names), or no one the record says (`unlisted`,
 * anything else in `data`), which the screen boxes as a sender's all the same.
 */
export type FieldSource = 'attribute' | 'sender' | 'unlisted';

/** One field of a dry-run record: where it is in the record, its value as text, and who wrote it. */
export interface RecordField {
  name: string;
  value: string;
  source: FieldSource;
}

/** The attributes of the CloudEvent envelope (`packages/events/src/wire/cloudevent.ts`): the event service writes them. */
const CLOUD_EVENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'specversion',
  'id',
  'source',
  'type',
  'time',
  'datacontenttype',
  'dataschema',
  'subject',
  'agentcommsrule',
  'agentcommsuntrusted',
]);

/**
 * The sender-written fields `agentcommsuntrusted` names: a comma list of JSON pointers into `data`, each
 * percent-encoded, as the event service writes it (`encodeUntrustedExtension`); `''` is the whole of `data`. A list that
 * cannot be read names nothing, and every field of `data` is boxed regardless.
 */
export function untrustedPointers(event: unknown): string[] {
  const extension = isRecord(event) ? event.agentcommsuntrusted : undefined;
  if (typeof extension !== 'string') return [];
  try {
    return extension.split(',').map((each) => decodeURIComponent(each));
  } catch {
    return [];
  }
}

/** A JSON pointer's token, escaped as RFC 6901 writes one. */
const token = (key: string | number): string => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

/** The would-be record: the event itself, or, where the answer still carries its bytes, those bytes read as JSON. */
function recordEvent(record: unknown): unknown {
  if (isRecord(record) && typeof record.cloudEventBytes === 'string') {
    try {
      return JSON.parse(record.cloudEventBytes) as unknown;
    } catch {
      return { event: record.cloudEventBytes };
    }
  }
  return record;
}

/**
 * Every value of a dry-run record, flattened to `data.from.name`-style names, in the record's order, each with who
 * wrote it: a CloudEvent attribute is the event service's; a field of `data` is the sender's when `agentcommsuntrusted`
 * names it (or a field above it), and unlisted otherwise.
 */
export function recordFields(record: unknown): RecordField[] {
  const event = recordEvent(record);
  const untrusted = untrustedPointers(event);
  const named = (pointer: string) =>
    untrusted.some((each) => each === '' || pointer === each || pointer.startsWith(`${each}/`));
  const fields: RecordField[] = [];
  // `pointer` is the field's JSON pointer into `data`, or null outside it.
  const walk = (node: unknown, name: string, pointer: string | null, top: boolean) => {
    const leaf = (value: string) => {
      const attribute = top && CLOUD_EVENT_ATTRIBUTES.has(name);
      const source: FieldSource = attribute ? 'attribute' : pointer !== null && named(pointer) ? 'sender' : 'unlisted';
      fields.push({ name: name === '' ? 'record' : name, value, source });
    };
    if (Array.isArray(node)) {
      if (node.length === 0) leaf('[]');
      for (const [index, each] of node.entries()) {
        walk(each, `${name}[${index}]`, pointer === null ? null : `${pointer}/${index}`, false);
      }
      return;
    }
    if (isRecord(node)) {
      const entries = Object.entries(node);
      if (entries.length === 0 && name !== '') leaf('{}');
      for (const [key, each] of entries) {
        const inData =
          name === '' ? (key === 'data' ? '' : null) : pointer === null ? null : `${pointer}/${token(key)}`;
        walk(each, name === '' ? key : `${name}.${key}`, inData, top && name === '');
      }
      return;
    }
    leaf(typeof node === 'string' ? node : JSON.stringify(node));
  };
  walk(event, '', null, true);
  return fields;
}

/** `dryrun show <delivery> --json`, read: when it was written, when it goes, and its record's fields. */
export function readDryrunShow(
  value: unknown,
): { deliveredAt: number | null; expiresAt: number | null; fields: RecordField[]; record: unknown } | null {
  if (!isRecord(value) || !('record' in value)) return null;
  return {
    deliveredAt: moment(value.deliveredAt),
    expiresAt: moment(value.expiresAt),
    fields: recordFields(value.record),
    record: recordEvent(value.record),
  };
}

/**
 * A sender-written field as the person reads it in a line: the CLI sends it inside the untrusted-content envelope
 * (`dryrun show --json`, review of 0.32.0, finding 2), so the envelope's content is taken out, to be boxed once, whole,
 * as From outside with the rest of the line it makes. Text with no envelope is as it came.
 */
const unwrapped = (value: unknown): string | null => {
  const raw = text(value);
  return raw === null
    ? null
    : text(
        splitEnvelopes(raw)
          .map((part) => part.text)
          .join(''),
      );
};

/** A sender's name and address, and the subject, where a dry-run record kept them. */
export function keptMessage(record: unknown): { from: string | null; subject: string | null } {
  const data = isRecord(record) && isRecord(record.data) ? record.data : isRecord(record) ? record : {};
  const from = data.from;
  let sender: string | null = null;
  if (typeof from === 'string') sender = unwrapped(from);
  else if (isRecord(from)) {
    const name = unwrapped(from.name);
    const address = unwrapped(from.address);
    sender = name !== null && address !== null ? `${name} <${address}>` : (name ?? address);
  }
  return { from: sender, subject: unwrapped(data.subject) };
}

/**
 * The message's own page, where the app may open it: a Gmail message in its mailbox (by the mailbox's address), or a
 * Slack message in its workspace (by its team id), each in the exact shape a queue item's link has, so Rust opens it
 * (`links.rs`, `queue_link`). Null for any other channel, or when the address or the team is not known.
 */
export function messageLink(
  source: MessageSource | null,
  account: { email: string | null; team: string | null } | undefined,
): { label: string; url: string } | null {
  if (source === null || account === undefined) return null;
  if (source.channel === 'gmail' && account.email !== null) {
    const url = `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#all/${encodeURIComponent(source.messageId)}`;
    return openableLink({ kind: 'gmail', url });
  }
  if (source.channel === 'slack' && account.team !== null) {
    const url = `https://app.slack.com/client/${account.team}/${source.channelId}/thread/${source.channelId}-${source.ts}`;
    return openableLink({ kind: 'slack', url });
  }
  return null;
}
