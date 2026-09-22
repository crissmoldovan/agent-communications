import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * PKCE, which is why this package needs no client secret.
 *
 * The first draft of S2 assumed Slack could not redirect to a local process, because the research said a redirect
 * URI "must be HTTPS". That is true of the confidential-client flow and false here: an app that opts into PKCE
 * may redirect to `http://localhost`, and the exchange then carries no `client_secret` at all. So the only value
 * a person pastes is the app's Client ID, which is not a secret, and nothing secret is ever distributed.
 *
 * The mechanism, in one sentence: a random `verifier` stays in this process, its SHA-256 hash goes to Slack as
 * the `challenge`, and the exchange presents the verifier — so a `code` intercepted on the way back is useless
 * to whoever took it, because they cannot produce the verifier it was bound to.
 *
 * Source: <https://docs.slack.dev/authentication/using-pkce/> — "The only supported hashing algorithm for now is
 * SHA-256", output in "URL-Safe Base64 format (RFC 4648 §5)".
 */

/**
 * 32 bytes, base64url — 43 characters, comfortably inside RFC 7636's 43–128 and well above its 32-octet floor.
 *
 * `randomBytes` rather than anything seeded: this value is the only thing standing between an intercepted code
 * and a token, so it has to come from the CSPRNG.
 */
export interface PkcePair {
  /** Never leaves this process, never logged, never written to disk. */
  readonly verifier: string;
  /** Sent to Slack in the authorisation URL. Safe to log. */
  readonly challenge: string;
  /** Always `S256`. Slack supports no other, and `plain` would defeat the point. */
  readonly method: 'S256';
}

/** RFC 4648 §5: base64 with `-` and `_` for `+` and `/`, and no padding. */
function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()), method: 'S256' };
}

/**
 * The `state` that ties a redirect back to the request that started it.
 *
 * PKCE proves the code belongs to this process; `state` proves the *redirect* does. Without it a browser that
 * happens to hit the listener with somebody else's code would be taken at its word.
 */
export function newState(): string {
  return base64Url(randomBytes(24));
}

/**
 * Compares a returned `state` against the expected one without leaking where they diverge.
 *
 * The attacker would already be on this machine, so this is tidiness rather than a fix — but a plain `!==` on a
 * secret is the kind of thing that stays right until the secret gets shorter, and the Gmail loopback made the
 * same choice for the same reason.
 */
export function sameState(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
