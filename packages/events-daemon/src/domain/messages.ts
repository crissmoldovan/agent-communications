import type { QueueState } from './queue-target.ts';

/**
 * A story per message (0.32.0 spec §3.6): for each event the event service observed, what each rule decided, where
 * each delivery went, and the queue item it became, with that item's history. Ids, times and closed words only — but
 * for `kept`, the sender and subject an item's queue target keeps (`show: summary`), which are sender text and arrive
 * inside the untrusted-content envelope, as `queue show` gives them. The person's read: the CLI and the app, never MCP.
 */

/** How many messages a page holds by default, and at most. */
export const MESSAGES_LIST_DEFAULT_LIMIT = 100;
export const MESSAGES_LIST_MAX_LIMIT = 500;
/** How far back `messages list` looks when no `since` is given: 30 days. */
export const MESSAGES_LIST_DEFAULT_SPAN_MS: number = 30 * 86_400_000;

/** A decision's outcome, as the decisions table keeps it. */
export const MESSAGE_DECISION_OUTCOMES: readonly [
  'matched',
  'no-match',
  'mapping-rejected',
  'retention-expired',
  'hold',
] = Object.freeze(['matched', 'no-match', 'mapping-rejected', 'retention-expired', 'hold'] as const);
export type MessageDecisionOutcome = (typeof MESSAGE_DECISION_OUTCOMES)[number];

/** A delivery's target kind, as the deliveries table keeps it. */
export const MESSAGE_TARGET_KINDS: readonly ['dry-run', 'webhook', 'sse', 'queue', 'linear', 'session'] = Object.freeze(
  ['dry-run', 'webhook', 'sse', 'queue', 'linear', 'session'] as const,
);
export type MessageTargetKind = (typeof MESSAGE_TARGET_KINDS)[number];

/** A delivery's state, as the deliveries table keeps it (`store/schema-v1.ts`). */
export const MESSAGE_DELIVERY_STATES: readonly [
  'queued',
  'retryable',
  'disclosing',
  'delivered',
  'dead-lettered',
  'retention-expired',
  'cancelled',
  'content-unreadable',
  'in-flight-at-disable',
  'in-flight-at-account-removal',
] = Object.freeze([
  'queued',
  'retryable',
  'disclosing',
  'delivered',
  'dead-lettered',
  'retention-expired',
  'cancelled',
  'content-unreadable',
  'in-flight-at-disable',
  'in-flight-at-account-removal',
] as const);
export type MessageDeliveryState = (typeof MESSAGE_DELIVERY_STATES)[number];

/** An event id: the first 16 bytes of its identity's SHA-256, in lowercase hex. */
const EVENT_ID = /^[0-9a-f]{32}$/u;

export function isEventId(value: unknown): value is string {
  return typeof value === 'string' && EVENT_ID.test(value);
}

/**
 * Where a page ended, for `--before`: `<observedAt ms>:<eventId>`. Events observed in the same millisecond — one poll's
 * worth — are ordered by id, so a page boundary between two of them loses neither.
 */
const CURSOR = /^([0-9]{1,16}):([0-9a-f]{32})$/u;

export function isMessagesCursor(value: unknown): value is string {
  return typeof value === 'string' && CURSOR.test(value) && Number.isSafeInteger(Number(CURSOR.exec(value)?.[1]));
}

export function messagesCursor(observedAt: number, eventId: string): string {
  return `${observedAt}:${eventId}`;
}

export function parseMessagesCursor(value: string): { readonly observedAt: number; readonly eventId: string } | null {
  const match = CURSOR.exec(value);
  if (match === null) return null;
  const observedAt = Number(match[1]);
  return Number.isSafeInteger(observedAt) ? { observedAt, eventId: match[2] as string } : null;
}

/** The source's own ids, read from the event's dedupe key (`runtime/event-source.ts`). */
export type MessageSourceV1 =
  | { readonly channel: 'gmail'; readonly messageId: string }
  | { readonly channel: 'slack'; readonly channelId: string; readonly ts: string }
  | { readonly channel: 'whatsapp'; readonly chatId: string; readonly messageId: string }
  | { readonly channel: 'resend'; readonly emailId: string };

/** The judge's answer, read from the decision while its metadata is kept (action queue Q3); null otherwise. */
export interface MessageJudgeV1 {
  readonly kind: string;
  readonly answer: 'yes' | 'no';
  readonly confidence: number;
  /** Whether the judge's number is a probability; false for an uncalibrated score. */
  readonly calibrated: boolean;
}

export interface MessageDecisionV1 {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly outcome: MessageDecisionOutcome;
  readonly judge: MessageJudgeV1 | null;
}

export interface MessageDeliveryV1 {
  readonly deliveryId: string;
  readonly targetKind: MessageTargetKind;
  readonly targetId: string;
  /** The lane of a queue target, as the person approved it (routing B2); null for any other target. */
  readonly lane: string | null;
  readonly state: MessageDeliveryState;
}

export type MessageHistoryKind = 'woken' | 'read' | 'done' | 'dismissed' | 'reopened';

/** One line of a queue item's history: its time in milliseconds, and the window's activity session key or null. */
export interface MessageHistoryLineV1 {
  readonly at: number;
  readonly kind: MessageHistoryKind;
  readonly actor: 'person' | 'window';
  readonly windowKey: string | null;
}

export interface MessageQueueItemV1 {
  readonly itemId: string;
  readonly state: QueueState;
  readonly stateAt: number;
  readonly lane: string | null;
  /**
   * In `messages list`, the newest line of each kind the item has, oldest first — enough to say who last read it and
   * who last marked it. In `message show`, every line it keeps.
   */
  readonly history: readonly MessageHistoryLineV1[];
}

/** What the queue item keeps of its sender and subject, enveloped: sender text, data and never instructions. */
export interface MessageKeptV1 {
  readonly from: { readonly name?: string; readonly address?: string };
  readonly subject?: string;
}

export interface MessageEntryV1 {
  readonly eventId: string;
  readonly type: string;
  readonly channel: string;
  readonly accountId: string;
  readonly occurredAt: number;
  readonly observedAt: number;
  readonly source: MessageSourceV1 | null;
  readonly decisions: readonly MessageDecisionV1[];
  readonly deliveries: readonly MessageDeliveryV1[];
  readonly queueItem: MessageQueueItemV1 | null;
  readonly kept: MessageKeptV1 | null;
}

export interface MessagesListResultV1 {
  readonly messages: readonly MessageEntryV1[];
  /** `--before` this to read the next page, older; null when there is none. */
  readonly next: string | null;
}

export interface MessageShowResultV1 {
  readonly message: MessageEntryV1;
}
