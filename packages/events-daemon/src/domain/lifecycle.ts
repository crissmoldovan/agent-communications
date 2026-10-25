/** Stable domain failures that daemon operations translate unchanged at their control boundary. */
export type EventDomainErrorCode =
  | 'E2_REQUIRED'
  | 'E2_EXTERNAL_REFERENCE_BLOCKED'
  | 'EVENT_TYPE_NOT_SELECTABLE'
  | 'EVENT_TYPE_UNKNOWN'
  | 'EVENT_VERSION_UNKNOWN'
  | 'JUDGE_KIND_DISABLED'
  | 'LAYA_MANIFEST_NOT_REVIEWED'
  | 'LAYA_PLATFORM_UNAVAILABLE'
  | 'LAYA_SANDBOX_UNAVAILABLE'
  | 'LAYA_TEMPLATE_BLOCKED'
  | 'QUEUE_MAPPING_INCOMPLETE'
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

export const JUDGE_KIND_TYPESAFE = 'typesafe' as const;
export const JUDGE_KIND_LAYA = 'laya' as const;
export const JUDGE_KIND_LOCAL_ENDPOINT = 'local-endpoint' as const;
export const JUDGE_KINDS: readonly [
  typeof JUDGE_KIND_TYPESAFE,
  typeof JUDGE_KIND_LAYA,
  typeof JUDGE_KIND_LOCAL_ENDPOINT,
] = [JUDGE_KIND_TYPESAFE, JUDGE_KIND_LAYA, JUDGE_KIND_LOCAL_ENDPOINT];
export type JudgeKind = (typeof JUDGE_KINDS)[number];

export function isJudgeKind(value: unknown): value is JudgeKind {
  return typeof value === 'string' && (JUDGE_KINDS as readonly string[]).includes(value);
}

export function assertJudgeKindEnabled(kind: JudgeKind, enabled: boolean): void {
  if (!enabled) {
    throw new EventDomainError('JUDGE_KIND_DISABLED', `the ${kind} judge kind is disabled`);
  }
}
