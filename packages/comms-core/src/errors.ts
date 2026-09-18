/**
 * Every failure a user or an agent can act on carries a stable code, a message, an optional one-line hint, and the
 * process exit code the CLI uses for it. Exit codes follow BSD sysexits where one fits; 10 is ours.
 */
export const EXIT_CODES = {
  OK: 0,
  UNEXPECTED: 1,
  APPROVAL_REQUIRED: 10,
  USAGE: 64,
  BAD_DATA: 65,
  NOT_FOUND: 66,
  PROVIDER_UNAVAILABLE: 69,
  TRANSIENT: 75,
  AUTH_REQUIRED: 77,
  CONFIG: 78,
} as const;

export type ErrorCode = Exclude<keyof typeof EXIT_CODES, 'OK'>;

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
    return EXIT_CODES[this.code];
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
