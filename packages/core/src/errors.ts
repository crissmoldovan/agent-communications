/**
 * Every failure a user or an agent can act on carries a specific, stable code from this registry, a message, an
 * optional one-line hint and structured `details`. The code decides the process exit status; agents and skills branch
 * on the code, humans read the message. Exit statuses follow BSD sysexits where one fits; 10 and 11 are ours.
 */
export const EXIT_CODES = {
  OK: 0,
  UNEXPECTED: 1,
  APPROVAL: 10,
  /**
   * A command that did not run because a newer release is out and nobody at a terminal could be asked about it
   * (design 2026-09-28 §3). None of sysexits' codes means "run something else first", and a script that branches on
   * it has exactly two things to do — update, or put it off — so it has one of its own. 11, beside 10: both mean a
   * person has to decide before the command can go on.
   */
  UPDATE: 11,
  USAGE: 64,
  BAD_DATA: 65,
  NOT_FOUND: 66,
  UNAVAILABLE: 69,
  TRANSIENT: 75,
  AUTH: 77,
  CONFIG: 78,
} as const;

export interface ErrorSpec {
  exit: number;
  retryable: boolean;
  summary: string;
}

export type ErrorCode =
  | 'UNEXPECTED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_PENDING'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_VOID'
  | 'SEND_OUTCOME_UNKNOWN'
  | 'SEND_REFUSED'
  | 'POLICY_NEVER'
  | 'RATE_CAPPED'
  | 'UNSENDABLE_HTML'
  | 'LOOSENING_REFUSED'
  | 'UPDATE_REQUIRED'
  | 'USAGE'
  | 'CURSOR_MISMATCH'
  | 'BAD_DATA'
  | 'REPLY_INVALID'
  | 'NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE'
  | 'SOURCE_UNAVAILABLE'
  | 'SECRET_STORE_UNAVAILABLE'
  | 'TRANSIENT'
  | 'KEYCHAIN_APPROVAL_PENDING'
  | 'LOCK_TIMEOUT'
  | 'AUTH_REQUIRED'
  | 'SCOPE_MISSING'
  | 'WHATSAPP_VISIBILITY_SEAM_REQUIRED'
  | 'CONFIG';

export const ERROR_REGISTRY: Readonly<Record<ErrorCode, ErrorSpec>> = {
  UNEXPECTED: { exit: EXIT_CODES.UNEXPECTED, retryable: false, summary: 'an unexpected internal error' },
  APPROVAL_REQUIRED: {
    exit: EXIT_CODES.APPROVAL,
    retryable: false,
    summary: 'sending needs an approval it does not have',
  },
  APPROVAL_PENDING: {
    exit: EXIT_CODES.APPROVAL,
    retryable: true,
    summary: 'waiting for a human approval outside the chat',
  },
  APPROVAL_EXPIRED: {
    exit: EXIT_CODES.APPROVAL,
    retryable: false,
    summary: 'the approval window passed; prepare again',
  },
  APPROVAL_VOID: { exit: EXIT_CODES.APPROVAL, retryable: false, summary: 'the approval was voided; prepare again' },
  /*
   * Its own code, so nobody follows APPROVAL_VOID's "prepare again" after a send that may have gone out (design
   * 2026-10-05 §D2): the provider's answer was lost, or the claimant's lease ran out before it recorded one.
   */
  SEND_OUTCOME_UNKNOWN: {
    exit: EXIT_CODES.APPROVAL,
    retryable: false,
    summary: 'the send outcome is unknown; check before sending again',
  },
  SEND_REFUSED: {
    exit: EXIT_CODES.APPROVAL,
    retryable: false,
    summary: 'a send was attempted outside the one approved path',
  },
  POLICY_NEVER: { exit: EXIT_CODES.APPROVAL, retryable: false, summary: 'sending is turned off for this inbox' },
  RATE_CAPPED: { exit: EXIT_CODES.APPROVAL, retryable: true, summary: 'the send limit for this inbox is reached' },
  UNSENDABLE_HTML: { exit: EXIT_CODES.APPROVAL, retryable: false, summary: 'the draft has HTML an agent may not send' },
  LOOSENING_REFUSED: {
    exit: EXIT_CODES.APPROVAL,
    retryable: false,
    summary: 'a safety setting can only be loosened by a person',
  },
  UPDATE_REQUIRED: {
    exit: EXIT_CODES.UPDATE,
    retryable: false,
    summary: 'a newer release is out: update first, or put it off until tomorrow',
  },
  USAGE: { exit: EXIT_CODES.USAGE, retryable: false, summary: 'the command or arguments are wrong' },
  CURSOR_MISMATCH: { exit: EXIT_CODES.USAGE, retryable: false, summary: 'the cursor belongs to a different query' },
  BAD_DATA: { exit: EXIT_CODES.BAD_DATA, retryable: false, summary: 'the input is not acceptable' },
  REPLY_INVALID: { exit: EXIT_CODES.BAD_DATA, retryable: false, summary: 'the reply would not thread correctly' },
  NOT_FOUND: { exit: EXIT_CODES.NOT_FOUND, retryable: false, summary: 'not found' },
  PROVIDER_UNAVAILABLE: { exit: EXIT_CODES.UNAVAILABLE, retryable: true, summary: 'the mail provider is unavailable' },
  SOURCE_UNAVAILABLE: {
    exit: EXIT_CODES.UNAVAILABLE,
    retryable: false,
    summary: 'the selected local event source is unavailable',
  },
  SECRET_STORE_UNAVAILABLE: {
    exit: EXIT_CODES.UNAVAILABLE,
    retryable: false,
    summary: 'the secret store cannot be used',
  },
  TRANSIENT: { exit: EXIT_CODES.TRANSIENT, retryable: true, summary: 'a temporary failure; retry later' },
  KEYCHAIN_APPROVAL_PENDING: {
    exit: EXIT_CODES.TRANSIENT,
    retryable: true,
    summary: 'the system keychain is waiting for a person',
  },
  LOCK_TIMEOUT: { exit: EXIT_CODES.TRANSIENT, retryable: true, summary: 'another process is busy with the same file' },
  AUTH_REQUIRED: { exit: EXIT_CODES.AUTH, retryable: false, summary: 'the inbox must be authorised again' },
  SCOPE_MISSING: { exit: EXIT_CODES.AUTH, retryable: false, summary: 'the inbox was not granted this permission' },
  WHATSAPP_VISIBILITY_SEAM_REQUIRED: {
    exit: EXIT_CODES.CONFIG,
    retryable: false,
    summary: 'the WhatsApp event visibility fence is unavailable',
  },
  CONFIG: { exit: EXIT_CODES.CONFIG, retryable: false, summary: 'a configuration problem' },
};

export interface CommsErrorOptions {
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class CommsError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: CommsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CommsError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get exitCode(): number {
    return ERROR_REGISTRY[this.code].exit;
  }

  get retryable(): boolean {
    return ERROR_REGISTRY[this.code].retryable;
  }
}

export function isCommsError(value: unknown): value is CommsError {
  return value instanceof CommsError;
}

/** Wraps anything thrown into a CommsError without leaking internals: unknown errors keep only their message. */
export function toCommsError(value: unknown): CommsError {
  if (isCommsError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new CommsError('UNEXPECTED', message, { cause: value });
}
