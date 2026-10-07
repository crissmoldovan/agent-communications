/**
 * What the library reports with. Validators return a `Result`; evaluators take values that already validated and
 * throw `EventsError` only when they are misused. The daemon maps each issue code to its own error, so the set is
 * closed: a code is added here, deliberately, with the check that reports it.
 */

/** Every code an issue or an `EventsError` can carry. */
export type IssueCode =
  /** A value given as JSON is not: `undefined` where JSON has none, a non-finite number, a non-plain object, a cycle. */
  | 'NOT_JSON'
  /** Text that has to be UTF-8 holds a surrogate without its partner, which UTF-8 cannot encode. */
  | 'NOT_WELL_FORMED'
  /** An event identity's tuple is not D3's: an id that is not a string, a type version that is not an integer. */
  | 'IDENTITY_INVALID'
  /** A schema description the compilers cannot compile faithfully: an empty enum, a pattern without exactly `u`. */
  | 'SCHEMA_DESCRIPTION_INVALID'
  /** A path the schema does not declare: an undeclared key, an index on an object, a key on an array, a step too far. */
  | 'POINTER_NOT_IN_SCHEMA'
  /** Not an RFC 6901 pointer (an escape other than `~0` or `~1`, no leading `/`), or not a D3 pointer pattern. */
  | 'POINTER_MALFORMED'
  /** A domain is not one UTS #46 ToASCII accepts under D5's flags, or it ends in a root dot (decision 13). */
  | 'DOMAIN_INVALID'
  /** A value is not in its semantic format: an address's local part, an instant given to `compareInstants`. */
  | 'FORMAT_INVALID'
  /** A name is not one of the five semantic formats. */
  | 'FORMAT_UNKNOWN'
  /** A value does not satisfy a catalogue definition's generated schema. */
  | 'EVENT_INVALID'
  /** A value passes the generated schema but breaks one of Appendix A's named cross-field rules. */
  | 'EVENT_INVARIANT_INVALID'
  /** A source event type beginning `agentcomms.` is never selectable. */
  | 'EVENT_TYPE_NOT_SELECTABLE'
  /** No catalogue definition has this source event type. */
  | 'EVENT_TYPE_UNKNOWN'
  /** A known source event type has no definition at this version. */
  | 'EVENT_VERSION_UNKNOWN'
  /** A catalogue declaration is inconsistent with its schema. */
  | 'DEFINITION_INVALID'
  /** A Resend risk flag is outside the closed Appendix A vocabulary. */
  | 'RISK_FLAG_UNKNOWN'
  /** A mapping template is not D6's JSON-template grammar. */
  | 'MAPPING_INVALID'
  /** A mapping reference was absent while its policy was `reject`. */
  | 'MAPPING_PATH_MISSING'
  /** A mapping constant, leaf count or mapped JSON byte length exceeds D6's limit. */
  | 'MAPPING_LIMIT_EXCEEDED'
  /** A CloudEvents field is absent or has the wrong D6 type. */
  | 'CLOUD_EVENT_INVALID'
  /** A rule-defined CloudEvent type is not a non-empty string. */
  | 'CLOUD_EVENT_TYPE_INVALID'
  /** An untrusted extension pointer is not present in data as a string. */
  | 'UNTRUSTED_POINTER_INVALID';

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
