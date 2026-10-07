import { EventsError } from '../result.ts';
import { codePointLength, compareUtf8, isWellFormed } from '../text.ts';
import { RISK_FLAGS } from './definitions/shared.ts';
import type { RiskFlagV1 } from './types.ts';

export const RESEND_BODY_MAX_CODE_POINTS = 20_000;

/** The safe normalisation required at the existing Resend read boundary, not a catalogue invariant. */
export function normaliseResendBody(input: { readonly text: string; readonly truncated: boolean }): {
  body: string;
  bodyTruncated: boolean;
} {
  let body = input.text;
  const last = body.charCodeAt(body.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) body = body.slice(0, -1);
  if (!isWellFormed(body)) throw new EventsError('NOT_WELL_FORMED', 'the Resend body has an unpaired surrogate');
  if (codePointLength(body) > RESEND_BODY_MAX_CODE_POINTS) {
    throw new EventsError('EVENT_INVALID', `the Resend body has more than ${RESEND_BODY_MAX_CODE_POINTS} code points`);
  }
  return { body, bodyTruncated: input.truncated };
}

/** Resend attachment risks in their Appendix A canonical UTF-8 order. */
export function canonicalRiskFlags(flags: readonly string[]): readonly RiskFlagV1[] {
  for (const flag of flags) {
    if (!(RISK_FLAGS as readonly string[]).includes(flag)) {
      throw new EventsError('RISK_FLAG_UNKNOWN', 'a Resend attachment risk flag is not in Appendix A');
    }
  }
  return [...new Set(flags)].sort(compareUtf8) as RiskFlagV1[];
}
