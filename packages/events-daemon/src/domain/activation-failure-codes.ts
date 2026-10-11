/** Codes persisted by the activation writers. Database rows from older or damaged state are not trusted as codes. */
export const ACTIVATION_FAILURE = {
  ACCOUNT_REMOVED: 'ACCOUNT_REMOVED',
  APPROVAL_ABSENT: 'APPROVAL_ABSENT',
  APPROVAL_BINDING_DRIFT: 'APPROVAL_BINDING_DRIFT',
  AUTHORIZATION_REVOKED: 'AUTHORIZATION_REVOKED',
  COMPLETION_TIMEOUT: 'COMPLETION_TIMEOUT',
  STALE_GENERATION: 'STALE_GENERATION',
  STALE_POINTER: 'STALE_POINTER',
} as const;

export type ActivationFailureCode = (typeof ACTIVATION_FAILURE)[keyof typeof ACTIVATION_FAILURE];

export const ACTIVATION_FAILURE_CODES: readonly ActivationFailureCode[] = Object.values(ACTIVATION_FAILURE);

const ACTIVATION_FAILURE_CODE_SET = new Set<string>(ACTIVATION_FAILURE_CODES);

export function isActivationFailureCode(value: unknown): value is ActivationFailureCode {
  return typeof value === 'string' && ACTIVATION_FAILURE_CODE_SET.has(value);
}
