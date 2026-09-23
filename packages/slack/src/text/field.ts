import { neutralise } from '@agentcomms/core';
import { type DecodedText, decodeSlackText, type ReferenceNames } from './decode.ts';

/**
 * The one door every sender-controlled string leaves through.
 *
 * Slack has far more of these than mail does, and several are editable by anyone in the workspace at any moment:
 * display name, real name, status text and status emoji, channel name, topic and purpose, file names, bot names,
 * and the label half of a link. The Gmail release shipped three read paths — attachments, contacts, follow-ups —
 * that returned a subject, a filename or a display name as a bare string beside a carefully enveloped body, and
 * the suite was green because no test fed a hostile value through them. The lesson taken here is not "remember
 * the new field" but "there is one function, and a field that does not call it is visible in review".
 *
 * Decode, then cut, then neutralise. Each order is load-bearing and
 * `docs/superpowers/specs/2026-09-19-slack-design.md` §D5.4 says why: cutting before decoding can split an entity
 * or a span in half, and neutralising before decoding sees nothing to defuse in `&lt;/untrusted-email-content&gt;`.
 */

/** How much of a short field is worth carrying. A name or a topic longer than this is somebody making a point. */
export const FIELD_LIMIT = 512;

export interface SenderField {
  /** Safe to hand to a model or print: decoded, cut, neutralised. */
  readonly text: string;
  /** True when the value was longer than the limit and was cut. */
  readonly truncated: boolean;
  /** Control tokens, role markers and envelope-shaped runs that were defused. */
  readonly tokensNeutralised: number;
}

/**
 * One sender-controlled field, made safe without being made unreadable.
 *
 * `undefined` in, `undefined` out — so a caller can pass an optional field straight through rather than writing
 * `field ? senderField(field) : undefined` at each of the dozens of call sites, which is the shape that gets one
 * of them wrong.
 */
export function senderField(raw: string, names?: ReferenceNames, limit?: number): SenderField;
export function senderField(raw: undefined, names?: ReferenceNames, limit?: number): undefined;
export function senderField(raw: string | undefined, names?: ReferenceNames, limit?: number): SenderField | undefined;
export function senderField(
  raw: string | undefined,
  names: ReferenceNames = {},
  limit: number = FIELD_LIMIT,
): SenderField | undefined {
  if (raw === undefined) return undefined;
  const { text: decoded } = decodeSlackText(raw, names);
  const truncated = decoded.length > limit;
  const cut = truncated ? decoded.slice(0, limit) : decoded;
  const { text, tokensNeutralised } = neutralise(cut);
  return { text, truncated, tokensNeutralised };
}

/** The same, for a message body: decoded with its references kept, cut at a body-sized limit, then neutralised. */
export interface SenderBody extends SenderField {
  readonly references: DecodedText['references'];
}

export function senderBody(raw: string, names: ReferenceNames = {}, limit = 16_000): SenderBody {
  const { text: decoded, references } = decodeSlackText(raw, names);
  const truncated = decoded.length > limit;
  const cut = truncated ? decoded.slice(0, limit) : decoded;
  const { text, tokensNeutralised } = neutralise(cut);
  return { text, truncated, tokensNeutralised, references };
}
