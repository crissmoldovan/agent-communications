import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Crockford-style alphabet without I, L, O and U, so ids and challenges survive being read aloud or retyped. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[(bytes[i] ?? 0) & 31];
  return out;
}

/** `ap_` + 26 characters: 130 random bits. Validated before an id ever names a file. */
export const APPROVAL_ID_PATTERN: RegExp = /^ap_[0-9A-HJKMNP-TV-Z]{26}$/;
export const PLAN_TOKEN_PATTERN: RegExp = /^pl_[0-9A-HJKMNP-TV-Z]{26}$/;

export function newApprovalId(): string {
  return `ap_${randomString(26)}`;
}

export function newPlanToken(): string {
  return `pl_${randomString(26)}`;
}

const CHALLENGE_LETTERS = 'ABCDEFGHJKMNPQRSTVWXYZ';

/** A short challenge a human types back to approve: letters only, no look-alikes. */
export function newChallenge(length = 4): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CHALLENGE_LETTERS[randomInt(CHALLENGE_LETTERS.length)];
  return out;
}

/** Challenges are stored only as hashes, so no listing or tool result can reveal one. */
export function hashChallenge(challenge: string): string {
  return createHash('sha256').update(challenge.trim().toUpperCase()).digest('hex');
}

/** Case-insensitive, constant-time comparison of an answer with a stored challenge hash. */
export function challengeMatches(answer: string, storedHash: string): boolean {
  const a = Buffer.from(hashChallenge(answer), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
