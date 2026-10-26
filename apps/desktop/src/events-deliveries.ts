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
  /** `dry-run`, `webhook`, `sse` or `queue`; null from an events service older than 0.32.0. */
  targetKind: string | null;
  lastErrorCode: string | null;
  lastStatus: number | null;
  decisionId: string | null;
  eventId: string | null;
  deliveredAt: number | null;
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
export function nextTry(row: Pick<DeliveryRow, 'state' | 'nextAt'>): number | null {
  if (!WAITING.has(row.state)) return null;
  return moment(row.nextAt);
}

/** The filters the list offers, and which states each holds. */
export type DeliveryGroup = 'trying' | 'failed' | 'done';

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
export function deliveryGroup(row: Pick<DeliveryRow, 'state'>): DeliveryGroup | null {
  return GROUPS[row.state] ?? null;
}

export type ChipTone = 'ok' | 'accent' | 'warn' | 'danger' | 'neutral' | 'busy';

/** A delivery's state in plain words, and its chip's tone. A delivered dry run is recorded: nothing was sent. */
export function stateWords(row: Pick<DeliveryRow, 'state' | 'targetKind'>): { words: string; tone: ChipTone } {
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

/** What a delivery's last try got, in words, or null when nothing is recorded. */
export function lastAnswer(row: Pick<DeliveryRow, 'lastErrorCode' | 'lastStatus' | 'targetKind'>): string | null {
  const who = row.targetKind === 'webhook' ? 'The webhook' : 'The target';
  if (row.lastErrorCode === 'NETWORK') return `${who} could not be reached`;
  if (row.lastStatus !== null) {
    const unavailable = row.lastStatus === 503 ? ', it is unavailable' : '';
    return `${who} answered ${row.lastStatus}${unavailable}`;
  }
  if (row.lastErrorCode !== null) return `${who} failed: ${row.lastErrorCode}`;
  return null;
}

// ── One delivery ───────────────────────────────────────────────────────────────────────────────────────────────

/** A message's ids at its source, as `delivery show` reads them from the event (never any sender text). */
export type EventSource =
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
    source: EventSource | null;
  } | null;
  target: { kind: string | null; id: string | null; version: number | null; host: string | null; lane: string | null };
  /** A dry run's log entry and when it goes; null for any other target. Its `expiresAt` is null once it has gone. */
  dryRun: { expiresAt: number | null } | null;
}

/** An event's source ids, read from `{ channel, … }` (or by its event type's channel when no channel is given). */
function sourceOf(value: unknown, type: string | null): EventSource | null {
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

/** One field of a dry-run record: where it is in the record, and its value as text. */
export interface RecordField {
  name: string;
  value: string;
  /** Whether the event service wrote it (the CloudEvent's own attributes), rather than the message's sender. */
  service: boolean;
}

/** The attributes of the CloudEvent envelope, which the event service writes, never a sender. */
const CLOUD_EVENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'specversion',
  'id',
  'type',
  'time',
  'datacontenttype',
  'dataschema',
]);

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

/** Every value of a dry-run record, flattened to `data.from.name`-style names, in the record's order. */
export function recordFields(record: unknown): RecordField[] {
  const fields: RecordField[] = [];
  const walk = (node: unknown, name: string, top: boolean) => {
    if (Array.isArray(node)) {
      if (node.length === 0) fields.push({ name, value: '[]', service: false });
      for (const [index, each] of node.entries()) walk(each, `${name}[${index}]`, false);
      return;
    }
    if (isRecord(node)) {
      const entries = Object.entries(node);
      if (entries.length === 0 && name !== '') fields.push({ name, value: '{}', service: false });
      for (const [key, each] of entries) walk(each, name === '' ? key : `${name}.${key}`, top && name === '');
      return;
    }
    const service = top && CLOUD_EVENT_ATTRIBUTES.has(name);
    fields.push({
      name: name === '' ? 'record' : name,
      value: typeof node === 'string' ? node : JSON.stringify(node),
      service,
    });
  };
  walk(recordEvent(record), '', true);
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

/** A sender's name and address, and the subject, where a dry-run record kept them. */
export function keptMessage(record: unknown): { from: string | null; subject: string | null } {
  const data = isRecord(record) && isRecord(record.data) ? record.data : isRecord(record) ? record : {};
  const from = data.from;
  let sender: string | null = null;
  if (typeof from === 'string') sender = text(from);
  else if (isRecord(from)) {
    const name = text(from.name);
    const address = text(from.address);
    sender = name !== null && address !== null ? `${name} <${address}>` : (name ?? address);
  }
  return { from: sender, subject: text(data.subject) };
}

/**
 * The message's own page, where the app may open it: a Gmail message in its mailbox (by the mailbox's address), or a
 * Slack message in its workspace (by its team id), each in the exact shape a queue item's link has, so Rust opens it
 * (`links.rs`, `queue_link`). Null for any other channel, or when the address or the team is not known.
 */
export function messageLink(
  source: EventSource | null,
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
