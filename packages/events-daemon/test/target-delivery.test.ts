import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCloudEvent,
  cloudEventBytes,
  gmailMessageReceivedV1,
  type MappedClassification,
} from '@agentcomms/events';
import { type CanonicalFullRuleDocument, canonicalTarget } from '../src/domain/activation-documents.ts';
import { prepareDeliveries } from '../src/runtime/deliveries.ts';
import { constructTargetDelivery, type DeliveryTarget } from '../src/runtime/target-delivery.ts';

const event = {
  ...gmailMessageReceivedV1.examples[1],
  id: '11111111111111111111111111111111',
  account: { name: 'Inbox', id: 'account-1', channel: 'gmail' as const },
  subject: 'sender subject',
};

const classification: MappedClassification = {
  untrusted: [{ pointer: '/subject', text: 'sender subject' }],
  addresses: [],
  handles: [],
};

const rule = {
  ruleId: 'rule-1',
  version: 1,
  cloudEventType: undefined,
  retention: { deliveryMs: 60_000 },
} as unknown as CanonicalFullRuleDocument;

function construct(target: DeliveryTarget, deliveryId: string) {
  return constructTargetDelivery({
    definition: gmailMessageReceivedV1,
    event,
    target,
    deliveryId,
    installationId: 'installation-1',
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    data: { subject: 'sender subject' },
    classification,
  });
}

test('B2-T2: every private delivery target has its exact non-colliding key and bound versions', () => {
  const dryrun: DeliveryTarget = {
    kind: 'dry-run',
    targetId: 'target-1',
    targetVersion: 1,
    representation: 'plain',
  };
  const webhook: DeliveryTarget = {
    kind: 'webhook',
    targetId: 'target-1',
    targetVersion: 1,
    representation: 'enveloped',
  };
  const firstStream: DeliveryTarget = {
    kind: 'sse',
    targetId: 'target-1',
    targetVersion: 1,
    subscriberId: 'subscriber-1',
    subscriberVersion: 1,
    representation: 'enveloped',
  };
  const replacementStream: DeliveryTarget = { ...firstStream, targetVersion: 2 };

  const prepared = [
    construct(dryrun, 'delivery-dryrun'),
    construct(webhook, 'delivery-webhook'),
    construct(firstStream, 'delivery-sse-1'),
    construct(replacementStream, 'delivery-sse-2'),
  ];

  assert.deepEqual(
    prepared.map((delivery) => delivery.targetKey),
    ['dryrun:target-1:1', 'webhook:target-1:1', 'sse:target-1:1:subscriber-1:1', 'sse:target-1:2:subscriber-1:1'],
  );
  assert.equal(prepared[0]?.representation, 'plain');
  assert.equal(prepared[1]?.representation, 'enveloped');
  const stream = prepared[2];
  assert.ok(stream !== undefined && stream.target.kind === 'sse');
  assert.equal(stream.target.subscriberVersion, 1);
  assert.notEqual(prepared[2]?.targetKey, prepared[3]?.targetKey);
});

test('B2-T2: preparation encrypts one canonical CloudEvent byte string at each target representation boundary', async () => {
  const targets: readonly DeliveryTarget[] = [
    { kind: 'dry-run', targetId: 'target-1', targetVersion: 1, representation: 'plain' },
    { kind: 'webhook', targetId: 'target-2', targetVersion: 1, representation: 'enveloped' },
    {
      kind: 'sse',
      targetId: 'target-3',
      targetVersion: 1,
      subscriberId: 'subscriber-1',
      subscriberVersion: 1,
      representation: 'enveloped',
    },
  ];
  const stored: Buffer[] = [];
  let next = 0;
  const deliveries = await prepareDeliveries({
    cipher: {
      async encrypt(_location, bytes) {
        const copy = Buffer.from(bytes);
        stored.push(copy);
        return copy;
      },
      async decrypt() {
        throw new Error('target preparation never decrypts');
      },
    },
    definition: gmailMessageReceivedV1,
    event,
    rule,
    classification,
    installationId: 'installation-1',
    createdAt: 1_000,
    newId: () => `delivery-${++next}`,
    data: { subject: 'sender subject' },
    targets,
  });

  assert.deepEqual(
    deliveries.map((delivery) => delivery.targetKey),
    ['dryrun:target-1:1', 'webhook:target-2:1', 'sse:target-3:1:subscriber-1:1'],
  );
  const b1DryRunBytes = cloudEventBytes(
    buildCloudEvent(gmailMessageReceivedV1, event as never, {
      deliveryId: 'delivery-1',
      installationId: 'installation-1',
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      targetId: 'target-1',
      targetVersion: 1,
      data: { subject: 'sender subject' },
      untrusted: ['/subject'],
    }),
  );
  assert.equal(deliveries[0]?.cloudEventBytes, b1DryRunBytes, 'the B1 dry-run vector is byte-for-byte unchanged');
  for (const [index, delivery] of deliveries.entries()) {
    const record = JSON.parse((stored[index] as Buffer).toString('utf8')) as {
      cloudEventBytes: string;
      representation: string;
    };
    assert.equal(record.cloudEventBytes, delivery.cloudEventBytes, 'the stored bytes are selected, not rebuilt later');
    assert.equal(record.representation, delivery.representation);
    assert.match(record.cloudEventBytes, new RegExp(`\\"id\\":\\"${delivery.id}\\"`));
  }
  assert.equal(deliveries[0]?.cloudEventBytes.includes('<untrusted-content'), false, 'the B1 dry-run form stays plain');
  assert.equal(deliveries[1]?.cloudEventBytes.includes('<untrusted-content'), true);
  assert.equal(deliveries[2]?.cloudEventBytes.includes('<untrusted-content'), true);
});

test('B2-T2: target construction preserves the approved rule CloudEvent type in every representation', () => {
  const delivery = constructTargetDelivery({
    definition: gmailMessageReceivedV1,
    event,
    target: { kind: 'webhook', targetId: 'target-1', targetVersion: 1, representation: 'plain' },
    deliveryId: 'delivery-override',
    installationId: 'installation-1',
    ruleId: 'rule-1',
    ruleVersion: 1,
    cloudEventType: 'com.example.mail.received',
    data: { subject: 'sender subject' },
    classification,
  });

  assert.equal(JSON.parse(delivery.cloudEventBytes).type, 'com.example.mail.received');
});

test('B2-T2: public target documents still reject B2 webhook and SSE forms', () => {
  assert.throws(
    () => canonicalTarget({ targetId: 'target-1', version: 1, kind: 'webhook', retentionMs: 60_000 }),
    /B1 supports only dry-run target documents/,
  );
  assert.throws(
    () => canonicalTarget({ targetId: 'target-1', version: 1, kind: 'sse', retentionMs: 60_000 }),
    /B1 supports only dry-run target documents/,
  );
});
