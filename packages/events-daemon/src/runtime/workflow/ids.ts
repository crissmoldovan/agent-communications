import { randomBytes } from 'node:crypto';

/**
 * Run and event ids (workflows design §4.3, W26, Appendix W.2): `wfr_` or `wfe_` and 26 lowercase Crockford base-32
 * characters, from the operating system's random source. Run ids are not `run_`: that is claude-stream's turn id.
 */

/** Lowercase Crockford base-32: digits and letters without i, l, o and u. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function id(prefix: 'wfr_' | 'wfe_'): string {
  // 256 is a multiple of 32, so the low five bits of each random byte pick a character uniformly.
  let text = prefix;
  for (const byte of randomBytes(26)) text += ALPHABET[byte & 31];
  return text;
}

/** A workflow run's id: `wfr_` and 26 characters. */
export function newRunId(): string {
  return id('wfr_');
}

/** A raised event's id, the same on every try and for every subscriber: `wfe_` and 26 characters. */
export function newEventId(): string {
  return id('wfe_');
}
