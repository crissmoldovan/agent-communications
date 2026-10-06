/**
 * What the library reports with. Validators return a `Result`; evaluators take values that already validated and
 * throw `EventsError` only when they are misused. The daemon maps each issue code to its own error, so the set is
 * closed: a code is added here, deliberately, with the check that reports it.
 */

/** Every code an issue or an `EventsError` can carry. */
export type IssueCode =
  /** A value given as JSON is not: `undefined` where JSON has none, a non-finite number, a non-plain object, a cycle. */
  'NOT_JSON';

/** One thing wrong, where it is (an RFC 6901 pointer into the value checked), and any detail a caller can show. */
export interface Issue {
  code: IssueCode;
  pointer?: string;
  message: string;
  detail?: readonly string[];
}

/** A validator's answer: the value, or every issue found. */
export type Result<T> = { ok: true; value: T } | { ok: false; issues: readonly Issue[] };

/** A function of this library given what its contract refuses. */
export class EventsError extends Error {
  readonly code: IssueCode;
  readonly pointer?: string;

  constructor(code: IssueCode, message: string, pointer?: string) {
    super(message);
    this.name = 'EventsError';
    this.code = code;
    if (pointer !== undefined) this.pointer = pointer;
  }
}
