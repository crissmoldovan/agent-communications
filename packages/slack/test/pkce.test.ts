import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { newPkcePair, newState, sameState } from '../src/auth/pkce.ts';

/**
 * PKCE is what lets this package hold no client secret, so the properties below are the ones the whole install
 * story rests on: the challenge really is the hash of the verifier, the verifier is unguessable, and a redirect
 * carrying the wrong `state` is not believed.
 */

test('the challenge is the SHA-256 of the verifier, base64url, unpadded', () => {
  const { verifier, challenge, method } = newPkcePair();
  assert.equal(method, 'S256', 'Slack supports no other method, and plain would defeat the point');

  // Computed here independently rather than by calling the same helper, or this asserts only that a function is
  // deterministic.
  const expected = createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(challenge, expected);

  // RFC 4648 §5 alphabet, and no padding — a `+`, `/` or `=` would be mangled in a URL.
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test('the verifier is long enough to be worth hashing, and never repeats', () => {
  const { verifier } = newPkcePair();
  // RFC 7636 allows 43–128 characters; 32 random bytes is 43 and is the floor worth using.
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier was ${verifier.length} characters`);

  const seen = new Set(Array.from({ length: 200 }, () => newPkcePair().verifier));
  assert.equal(seen.size, 200, 'two verifiers collided, so they are not coming from the CSPRNG');
});

test('a challenge tells you nothing about its verifier', () => {
  // The challenge is public — it goes in a URL. The test is that the pair is not some reversible transform.
  const { verifier, challenge } = newPkcePair();
  assert.notEqual(challenge, verifier);
  assert.ok(!challenge.includes(verifier.slice(0, 8)));
});

test('state is compared for equality, and a wrong or absent one is refused', () => {
  const state = newState();
  assert.equal(sameState(state, state), true);
  assert.equal(sameState(null, state), false, 'a redirect with no state must not be believed');
  assert.equal(sameState('', state), false);
  assert.equal(sameState(`${state}x`, state), false, 'a longer value must not pass on a prefix');
  assert.equal(sameState(state.slice(0, -1), state), false, 'a prefix must not pass either');

  const other = newState();
  assert.equal(sameState(other, state), false);
  assert.notEqual(other, state, 'two states collided');
});
