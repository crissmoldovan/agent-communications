import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import {
  type CanonicalFullRuleDocument,
  canonicalFullRuleDocument,
  canonicalTarget,
} from '../src/domain/activation-documents.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { canonicalSseSubscriber, sseDeliveryTarget } from '../src/domain/sse-subscriber.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { canonicalWebhookTarget, webhookDeliveryTarget } from '../src/domain/webhook-target.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const secretUrl = 'https://receiver.example.test/credential-path?access=fixture-value';
const secretFingerprint = 'ee8cd0a62bec50f824f461031e87d1e7f79854d3401c87857282e328248f18b5';

const plainWebhook = {
  targetId: 'webhook-plain',
  version: 1,
  kind: 'webhook',
  url: { kind: 'plain', value: 'HTTPS://Receiver.Example.Test:443/events%2fmail' },
  approvedAddressSet: ['8.8.8.8'],
  signing: 'standard-webhooks',
  ordering: 'strict',
  retryLimit: 20,
  representation: 'enveloped',
};

const secretWebhook = {
  ...plainWebhook,
  targetId: 'webhook-secret',
  url: {
    kind: 'secret',
    scheme: 'https',
    host: 'receiver.example.test',
    port: 443,
    sha256: secretFingerprint,
  },
};

const subscriber = {
  subscriberId: 'subscriber-1',
  version: 1,
  kind: 'sse',
  authority: { host: '127.0.0.1', port: 9443 },
  origins: ['https://app.example.test'],
  retentionMs: 604_800_000,
};

test('B2-T3: canonical webhook and subscriber documents bind only public authority and Task 2 delivery identities', () => {
  const plain = canonicalWebhookTarget(plainWebhook);
  const secret = canonicalWebhookTarget(secretWebhook);
  const stream = canonicalSseSubscriber(subscriber);

  assert.deepEqual(plain.url, { kind: 'plain', value: 'https://receiver.example.test:443/events%2Fmail' });
  assert.deepEqual(secret.url, {
    kind: 'secret',
    scheme: 'https',
    host: 'receiver.example.test',
    port: 443,
    sha256: secretFingerprint,
  });
  assert.deepEqual(webhookDeliveryTarget(secret), {
    kind: 'webhook',
    targetId: 'webhook-secret',
    targetVersion: 1,
    representation: 'enveloped',
  });
  assert.deepEqual(
    sseDeliveryTarget({ targetId: 'stream-target', version: 3, subscriber: stream, representation: 'plain' }),
    {
      kind: 'sse',
      targetId: 'stream-target',
      targetVersion: 3,
      subscriberId: 'subscriber-1',
      subscriberVersion: 1,
      representation: 'plain',
    },
  );
});

test('B2-T3: a secret URL is version-bound by fingerprint without appearing in canonical documents or refusals', () => {
  const first = canonicalWebhookTarget(secretWebhook);
  const changed = canonicalWebhookTarget({
    ...secretWebhook,
    version: 2,
    url: { ...secretWebhook.url, sha256: 'a'.repeat(64) },
  });
  assert.notDeepEqual(first, changed);
  const publicBytes = JSON.stringify(first);
  assert.equal(publicBytes.includes(secretUrl), false);
  assert.equal(publicBytes.includes('secret_ref'), false);
  assert.equal(publicBytes.includes('bearer'), false);

  assert.throws(
    () => canonicalWebhookTarget({ ...plainWebhook, url: { kind: 'plain', value: secretUrl } }),
    (error: unknown) => error instanceof Error && !error.message.includes(secretUrl),
  );
});

test('B2-T3: immutable network documents refuse invalid authority without reflecting secret input', () => {
  assert.throws(() =>
    canonicalWebhookTarget({
      ...plainWebhook,
      url: { kind: 'plain', value: 'http://localhost:8080/events' },
      approvedAddressSet: ['127.0.0.1'],
    }),
  );
  assert.throws(() => canonicalWebhookTarget({ ...plainWebhook, approvedAddressSet: ['not-an-address'] }));
  assert.throws(() => canonicalWebhookTarget({ ...plainWebhook, signing: 'other-signing' }));
  assert.throws(() =>
    canonicalWebhookTarget({
      ...secretWebhook,
      url: { ...secretWebhook.url, host: 'receiver.example.test:444' },
    }),
  );
  assert.throws(() => canonicalSseSubscriber({ ...subscriber, authority: { host: '::1', port: 65_536 } }));
});

test('B2-T3: activation documents embed exact stored webhook and SSE versions without inventing secret material', () => {
  const rule = canonicalFullRuleDocument({
    ruleId: 'rule-network',
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: ['account-1'],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { constant: 'safe' },
    targets: [
      secretWebhook,
      {
        targetId: 'stream-target',
        version: 1,
        kind: 'sse',
        subscriberId: 'subscriber-1',
        subscriberVersion: 1,
        representation: 'enveloped',
      },
    ],
    subscribers: [subscriber],
    judges: [],
    deliveryRateCap: 60,
    retention: {
      ingestMs: 604_800_000,
      holdMs: 604_800_000,
      deliveryMs: 604_800_000,
      dryrunMs: 86_400_000,
      sseReplayMs: 604_800_000,
      deadLetterMs: 604_800_000,
      decisionMetadataMs: 7_776_000_000,
    },
  });
  const target = canonicalTarget(secretWebhook);
  assert.deepEqual(rule.targets[0], target);
  assert.equal(JSON.stringify(rule as CanonicalFullRuleDocument).includes(secretUrl), false);
});

test('B2-T3: public capability inventory has no named secret or subscriber operation', async () => {
  const capabilities = JSON.parse(await readFile(new URL('../../../capabilities.json', import.meta.url), 'utf8')) as {
    capabilities: Array<{ id: string }>;
  };
  const rows = capabilities.capabilities.filter((row) => row.id.startsWith('events-daemon.')).map((row) => row.id);
  for (const forbidden of [
    'target.secret',
    'target.url',
    'subscriber',
    'secrets.migrate',
    'delivery.retry',
    'target.resume',
  ]) {
    assert.equal(
      rows.some((id) => id.includes(forbidden)),
      false,
      forbidden,
    );
  }
});

test('B2-T3: the existing paired target operation accepts plain webhooks but refuses secret completion material', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-network-documents-');
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const versions = new ImmutableVersions(opened.database);
      assert.equal(versions.createTarget(plainWebhook).document.kind, 'webhook');
      assert.throws(
        () => versions.createTarget(secretWebhook),
        (error: unknown) =>
          error instanceof EventDomainError &&
          error.code === 'VERSION_DOCUMENT_INVALID' &&
          !error.message.includes(secretFingerprint),
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
