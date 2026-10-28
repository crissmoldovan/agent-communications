import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signStandardWebhook } from '../src/runtime/webhook-signing.ts';

const BODY = '{"test":true}';
const CURRENT = 'whsec_c3VwZXJzZWNyZXQ=';
const PREVIOUS = 'whsec_b2xkLXNlY3JldA==';

test('B2-T6: Standard Webhooks signs the exact persisted bytes with fixed id and timestamp', () => {
  assert.deepEqual(
    signStandardWebhook({
      id: 'msg_123',
      timestamp: 1_700_000_000,
      body: BODY,
      current: CURRENT,
      overlap: [],
    }),
    {
      'webhook-id': 'msg_123',
      'webhook-timestamp': '1700000000',
      'webhook-signature': 'v1,Rx9VEoI34ehMOtoMjYymIRRZMTD48w3k94BSv+KnqB4=',
    },
  );
});

test('B2-T6: Standard Webhooks emits one signature for the current generation and one for its overlap', () => {
  const headers = signStandardWebhook({
    id: 'msg_123',
    timestamp: 1_700_000_001,
    body: BODY,
    current: CURRENT,
    overlap: [PREVIOUS],
  });
  assert.equal(headers['webhook-id'], 'msg_123');
  assert.equal(headers['webhook-timestamp'], '1700000001');
  assert.match(headers['webhook-signature'] ?? '', /^v1,[A-Za-z0-9+/]+=* v1,[A-Za-z0-9+/]+=*$/);
  assert.doesNotMatch(JSON.stringify(headers), /whsec_|supersecret|old-secret/);
});

test('B2-T6: a retry preserves the delivery id and persisted bytes while changing only its time-bound signature', () => {
  const first = signStandardWebhook({
    id: 'msg_123',
    timestamp: 1_700_000_000,
    body: BODY,
    current: CURRENT,
    overlap: [],
  });
  const retry = signStandardWebhook({
    id: 'msg_123',
    timestamp: 1_700_000_001,
    body: BODY,
    current: CURRENT,
    overlap: [],
  });
  const changedId = signStandardWebhook({
    id: 'msg_456',
    timestamp: 1_700_000_000,
    body: BODY,
    current: CURRENT,
    overlap: [],
  });
  const changedBody = signStandardWebhook({
    id: 'msg_123',
    timestamp: 1_700_000_000,
    body: '{"test":false}',
    current: CURRENT,
    overlap: [],
  });
  assert.equal(retry['webhook-id'], first['webhook-id']);
  assert.notEqual(retry['webhook-timestamp'], first['webhook-timestamp']);
  assert.notEqual(retry['webhook-signature'], first['webhook-signature']);
  assert.notEqual(changedId['webhook-signature'], first['webhook-signature']);
  assert.notEqual(changedBody['webhook-signature'], first['webhook-signature']);
  assert.doesNotMatch(JSON.stringify(retry), /whsec_|\{"test":true\}/);
});

test('B2-T6: an invalid Standard Webhooks secret refuses without echoing its material', () => {
  assert.throws(
    () =>
      signStandardWebhook({
        id: 'msg_123',
        timestamp: 1_700_000_000,
        body: BODY,
        current: 'not-a-webhook-secret',
        overlap: [],
      }),
    (error: unknown) => error instanceof Error && !error.message.includes('not-a-webhook-secret'),
  );
});

test('a previous secret made before 0.36.0 (base64url, which never signed) is left out, so a rotation signs at once', () => {
  // Before 0.36.0 every generated secret was base64url, which this signer refuses: rotating to a standard one must not
  // keep failing for the five-minute overlap because the old generation is still in it.
  const BEFORE_036 = 'whsec_7nYv-Pq1_s9KQ0sF4cDgYb2xkLXNlY3JldA0aXo9Rk3Lw';
  const rotated = signStandardWebhook({
    id: 'msg_123',
    timestamp: 1_700_000_000,
    body: BODY,
    current: CURRENT,
    overlap: [BEFORE_036],
  });
  const alone = signStandardWebhook({
    id: 'msg_123',
    timestamp: 1_700_000_000,
    body: BODY,
    current: CURRENT,
    overlap: [],
  });
  assert.deepEqual(rotated, alone);
  assert.throws(
    () =>
      signStandardWebhook({ id: 'msg_123', timestamp: 1_700_000_000, body: BODY, current: BEFORE_036, overlap: [] }),
    (error: unknown) => error instanceof Error && !error.message.includes(BEFORE_036),
  );
});
