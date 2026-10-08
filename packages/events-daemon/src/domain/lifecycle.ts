/** Stable domain failures that daemon operations translate unchanged at their control boundary. */
export type EventDomainErrorCode =
  | 'EVENT_TYPE_NOT_SELECTABLE'
  | 'EVENT_TYPE_UNKNOWN'
  | 'EVENT_VERSION_UNKNOWN'
  | 'JUDGE_KIND_DISABLED'
  | 'SOURCE_CHANNEL_UNSUPPORTED'
  | 'VERSION_DOCUMENT_INVALID';

/** A content-free domain refusal. No caller should substitute an arbitrary Error message at a control boundary. */
export class EventDomainError extends Error {
  readonly code: EventDomainErrorCode;

  constructor(code: EventDomainErrorCode, message: string) {
    super(message);
    this.name = 'EventDomainError';
    this.code = code;
  }
}

export const JUDGE_KINDS = ['typesafe', 'laya', 'local-endpoint'] as const;
export type JudgeKind = (typeof JUDGE_KINDS)[number];

export function isJudgeKind(value: unknown): value is JudgeKind {
  return typeof value === 'string' && (JUDGE_KINDS as readonly string[]).includes(value);
}

export function assertJudgeKindEnabled(kind: JudgeKind, enabled: boolean): void {
  if (!enabled) {
    throw new EventDomainError('JUDGE_KIND_DISABLED', `the ${kind} judge kind is disabled`);
  }
}
