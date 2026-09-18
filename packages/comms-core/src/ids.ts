import { randomBytes, randomInt } from 'node:crypto';

/** Crockford-style alphabet without I, L, O and U, so ids and challenges survive being read aloud or retyped. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[(bytes[i] ?? 0) & 31];
  return out;
}

export const APPROVAL_ID_PATTERN: RegExp = /^ap_[0-9A-HJKMNP-TV-Z]{16}$/;
export const PLAN_TOKEN_PATTERN: RegExp = /^pl_[0-9A-HJKMNP-TV-Z]{16}$/;

/** An approval id: `ap_` + 16 characters (80 random bits). */
export function newApprovalId(): string {
  return `ap_${randomString(16)}`;
}

/** A bulk-operation plan token: `pl_` + 16 characters. */
export function newPlanToken(): string {
  return `pl_${randomString(16)}`;
}

/** A short challenge a human types back to approve: letters only, no look-alikes. */
export function newChallenge(length = 4): string {
  const letters = 'ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < length; i += 1) out += letters[randomInt(letters.length)];
  return out;
}
