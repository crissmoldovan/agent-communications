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
  | 'LANE_NAME_IN_USE'
  // A Linear target whose team key or label name is not, in Linear, the one its id names (second look of 0.33.0).
  | 'LINEAR_LABEL_MISMATCH'
  // A Linear change's state that is not, in Linear, one of its team's states by that id, name and type (workflows §4.2).
  | 'LINEAR_STATE_MISMATCH'
  | 'LINEAR_TEAM_MISMATCH'
  // A route step's candidate that is no longer the person's project as it is now: gone, or its folders moved (0.36).
  | 'PROJECT_CHANGED'
  | 'QUEUE_MAPPING_INCOMPLETE'
  | 'SOURCE_CHANNEL_UNSUPPORTED'
  // A target template (0.33.0 design §3.4, §3.6): a slot that names a field the rule does not map, and a model-written
  // part, which arrives with the session target's context.
  | 'TEMPLATE_FIELD_NOT_MAPPED'
  | 'TEMPLATE_GENERATE_NOT_YET'
  | 'VERSION_DOCUMENT_INVALID'
  // A workflow's flow (workflows design §4.1, W6, W24, W34, W36): what the event service refuses beyond checkFlow.
  | FlowRefusalCode;

/**
 * Why the event service refuses a workflow's flow (workflows design §4.1): `checkFlow`'s problems (`FLOW_INVALID`, each
 * listed in `details.problems`), and what needs the event service — its targets, its other active workflows, its
 * folders — to say. Content-free, as every domain refusal is.
 */
export const FLOW_REFUSAL_CODES: readonly [
  'FLOW_INVALID',
  'ACCEPT_EDITS_OUTSIDE_RUN_WORKTREE',
  'EVENT_NAME_IN_USE',
  'CHAIN_SELF',
  'CHAIN_NOT_AVAILABLE',
  'FLOW_TARGET_UNUSED',
  'FLOW_TARGET_UNKNOWN',
  'FLOW_TO_KIND',
  'REPORT_NEEDS_CLAUDE',
  'DOCUMENT_TOO_LARGE',
  'FLOW_ONLY_TARGET',
  'FIND_THREAD_NEEDS_CLAUDE',
] = Object.freeze([
  'FLOW_INVALID',
  'ACCEPT_EDITS_OUTSIDE_RUN_WORKTREE',
  'EVENT_NAME_IN_USE',
  'CHAIN_SELF',
  'CHAIN_NOT_AVAILABLE',
  'FLOW_TARGET_UNUSED',
  'FLOW_TARGET_UNKNOWN',
  'FLOW_TO_KIND',
  'REPORT_NEEDS_CLAUDE',
  'DOCUMENT_TOO_LARGE',
  'FLOW_ONLY_TARGET',
  'FIND_THREAD_NEEDS_CLAUDE',
] as const);

export type FlowRefusalCode = (typeof FLOW_REFUSAL_CODES)[number];

/** A content-free domain refusal. No caller should substitute an arbitrary Error message at a control boundary. */
export class EventDomainError extends Error {
  readonly code: EventDomainErrorCode;
  /** Closed, content-free detail a refusal carries to its caller beside its code: `FLOW_INVALID`'s problems. */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: EventDomainErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'EventDomainError';
    this.code = code;
    this.details = details;
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
