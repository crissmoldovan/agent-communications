import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareEventIdentities, EventsError, eventId, eventIdPreimage, utf8Encode } from '../src/index.ts';
import { PACKAGE_ROOT } from './support/realm.ts';

/**
 * Event identity exactly as D3 defines it (events phase A plan, decision 23). The vector file
 * (`test/vectors/event-id.json`) runs in Node, the bare realm and the browsers; this holds the same vectors to
 * `node:crypto` and to the tuple's own JSON, and covers what only Node can show. The root test
 * `test/events-identity.test.mjs` holds them to core's `canonicalJson` and `sha256Hex`.
 */

interface IdVector {
  kind: 'id';
  name: string;
  input: Parameters<typeof eventId>[0];
  preimage: string;
  preimageUtf8Hex: string;
  sha256: string;
  eventId: string;
}

const file = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'test', 'vectors', 'event-id.json'), 'utf8'));
const ids: IdVector[] = file.vectors.filter((vector: { kind: string }) => vector.kind === 'id');

test('CAT-j: event ids are D3’s, stable, and change with every tuple component', async () => {
  assert.ok(ids.length >= 10, 'too few vectors');
  for (const vector of ids) {
    const { installationId, accountId, eventType, typeVersion, dedupeKey } = vector.input;
    // A tuple of strings and one integer: its canonical JSON is JSON.stringify's, an oracle of its own.
    const tuple = ['agentcomms-event-v1', installationId, accountId, eventType, typeVersion, dedupeKey];
    assert.equal(vector.preimage, JSON.stringify(tuple), vector.name);
    assert.equal(eventIdPreimage(vector.input), vector.preimage, vector.name);
    assert.equal(Buffer.from(utf8Encode(vector.preimage)).toString('hex'), vector.preimageUtf8Hex, vector.name);
    assert.equal(createHash('sha256').update(vector.preimage, 'utf8').digest('hex'), vector.sha256, vector.name);
    assert.equal(await eventId(vector.input), vector.eventId, vector.name);
    assert.match(vector.eventId, /^[0-9a-f]{32}$/);
  }
  // Every component on its own changes the id, the same dedupe key under another account included.
  const [base, ...rest] = ids;
  assert.ok(base);
  const variants = rest.filter((vector) => (vector as { differsFrom?: string }).differsFrom === base.name);
  assert.equal(variants.length, 5, 'one variant per component: account, installation, type, version, dedupe key');
  for (const variant of variants) assert.notEqual(variant.eventId, base.eventId, variant.name);
  // typeVersion is the JSON integer, never a string.
  assert.match(base.preimage, /,"gmail\.message\.received",1,/);
  assert.equal(
    new Set(ids.filter((vector) => !('sameAs' in vector)).map((vector) => vector.eventId)).size,
    ids.length - 1,
  );
});

test('CAT-j: an unpaired surrogate in a dedupe key is hashed as its escape, so the preimage is well-formed UTF-8', async () => {
  const hostile = ids.find((vector) => vector.input.dedupeKey.includes('\uD800'));
  assert.ok(hostile, 'no vector with an unpaired surrogate');
  assert.ok(hostile.preimage.includes('\\ud800'), 'the surrogate is escaped in the preimage');
  assert.ok(
    hostile.preimage.includes('\\"') && hostile.preimage.includes('\\\\'),
    'the quote and backslash are escaped',
  );
  assert.ok(
    hostile.preimage.includes('é') && hostile.preimage.includes('\u{1F600}'),
    'é and the astral stay as they are',
  );
  assert.equal(await eventId(hostile.input), hostile.eventId);
});

test('CAT-j: eventIdPreimage refuses what D3 does not type: a non-integer version, an id that is not a string', () => {
  const [base] = ids;
  assert.ok(base);
  for (const typeVersion of ['1', 1.5, Number.NaN, 2 ** 53]) {
    assert.throws(
      () => eventIdPreimage({ ...base.input, typeVersion: typeVersion as number }),
      (error: unknown) =>
        error instanceof EventsError && error.code === 'IDENTITY_INVALID' && error.pointer === '/typeVersion',
      String(typeVersion),
    );
  }
  for (const field of ['installationId', 'accountId', 'eventType', 'dedupeKey'] as const) {
    assert.throws(
      () => eventIdPreimage({ ...base.input, [field]: 7 as unknown as string }),
      (error: unknown) =>
        error instanceof EventsError && error.code === 'IDENTITY_INVALID' && error.pointer === `/${field}`,
      field,
    );
  }
});

test('CAT-k: an injected SHA-256 collision is data, and is classified as a collision', async () => {
  const collision = file.vectors.find((vector: { kind: string }) => vector.kind === 'collision');
  assert.ok(collision);
  assert.match(collision.description, /phase B1/, 'the vector says the cursor stop is B1’s');
  const digest = Buffer.from(collision.digest, 'hex');
  const injected = { digest: async () => new Uint8Array(digest) };
  const first = { eventId: await eventId(collision.first, injected), preimage: eventIdPreimage(collision.first) };
  const second = { eventId: await eventId(collision.second, injected), preimage: eventIdPreimage(collision.second) };
  assert.equal(first.eventId, collision.eventId);
  assert.equal(second.eventId, collision.eventId);
  assert.notEqual(first.preimage, second.preimage);
  assert.equal(compareEventIdentities(first, second), 'collision');
  assert.equal(compareEventIdentities(first, { ...first }), 'same-occurrence');
  const real = { eventId: await eventId(collision.second), preimage: second.preimage };
  assert.equal(
    compareEventIdentities({ eventId: await eventId(collision.first), preimage: first.preimage }, real),
    'distinct',
  );
  // The digest may answer with an ArrayBuffer, as WebCrypto does, and must be SHA-256's 32 bytes.
  assert.equal(
    await eventId(collision.first, { digest: () => digest.buffer.slice(digest.byteOffset, digest.byteOffset + 32) }),
    collision.eventId,
  );
  await assert.rejects(
    eventId(collision.first, { digest: () => new Uint8Array(31) }),
    (error: unknown) => error instanceof EventsError && error.code === 'IDENTITY_INVALID',
  );
});

test('utf8Encode is UTF-8, and refuses an unpaired surrogate, which has no UTF-8', () => {
  for (const text of ['', 'a', 'é', 'ࠀ', '￿', '\u{10000}', '\u{1F600}', '\u{10FFFF}', 'a\u{1F600}é "\\']) {
    assert.deepEqual(Buffer.from(utf8Encode(text)), Buffer.from(text, 'utf8'), JSON.stringify(text));
  }
  for (const text of ['\uD800', 'a\uDC00', '\uDE00\uD83D']) {
    assert.throws(
      () => utf8Encode(text),
      (error: unknown) => error instanceof EventsError && error.code === 'NOT_WELL_FORMED',
      JSON.stringify(text),
    );
  }
});
