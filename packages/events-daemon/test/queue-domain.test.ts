import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { RULE_RETENTION_DEFAULTS } from '@agentcomms/events';
import {
  activationDocumentDigest,
  canonicalFullRuleDocument,
  canonicalTarget,
} from '../src/domain/activation-documents.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import {
  isQueueItemId,
  newQueueItemId,
  QUEUE_RETENTION_DEFAULT_MS,
  QUEUE_RETENTION_MAX_MS,
  QUEUE_RETENTION_MIN_MS,
} from '../src/domain/queue-target.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { tighteningKind } from '../src/runtime/replacements.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const DAY = 86_400_000;

const retention = {
  ingestMs: 7 * DAY,
  holdMs: 7 * DAY,
  deliveryMs: 7 * DAY,
  dryrunMs: DAY,
  sseReplayMs: 7 * DAY,
  deadLetterMs: 7 * DAY,
  decisionMetadataMs: 90 * DAY,
};

const queueTarget = { targetId: 'queue-a', version: 1, kind: 'queue', retentionMs: 7 * DAY, show: 'summary' };

function gmailQueueRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: 'rule-queue',
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: ['ibx_AAAAAAAAAAAAAAAA'],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { from: { $path: '/from' }, subject: { $path: '/subject' }, id: { $path: '/messageId' } },
    targets: [queueTarget],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: { ...retention, queueMs: 7 * DAY },
    ...overrides,
  };
}

function refusedWith(pattern: RegExp, code = 'VERSION_DOCUMENT_INVALID') {
  return (error: unknown) => {
    assert.ok(error instanceof EventDomainError, String(error));
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  };
}

test('QUEUE-A: a queue target document is local, secretless and bounded to 1–30 days, defaulting to 7 and summary', () => {
  assert.deepEqual(canonicalTarget(queueTarget), queueTarget);
  assert.deepEqual(canonicalTarget({ targetId: 'queue-a', version: 1, kind: 'queue' }), {
    targetId: 'queue-a',
    version: 1,
    kind: 'queue',
    retentionMs: QUEUE_RETENTION_DEFAULT_MS,
    show: 'summary',
  });
  assert.equal(QUEUE_RETENTION_DEFAULT_MS, 7 * DAY);
  assert.equal(QUEUE_RETENTION_DEFAULT_MS, RULE_RETENTION_DEFAULTS.queueMs, 'one owner: @agentcomms/events');
  assert.equal(QUEUE_RETENTION_MIN_MS, DAY);
  assert.equal(QUEUE_RETENTION_MAX_MS, 30 * DAY);
  assert.equal(canonicalTarget({ ...queueTarget, show: 'minimal' }).kind, 'queue');
  assert.equal(canonicalTarget({ ...queueTarget, retentionMs: DAY }).kind, 'queue');
  assert.equal(canonicalTarget({ ...queueTarget, retentionMs: 30 * DAY }).kind, 'queue');
  for (const bad of [
    { ...queueTarget, retentionMs: DAY - 1 },
    { ...queueTarget, retentionMs: 30 * DAY + 1 },
    { ...queueTarget, retentionMs: 1.5 },
    { ...queueTarget, show: 'everything' },
    { ...queueTarget, url: 'https://example.invalid/' },
    { ...queueTarget, representation: 'plain' },
    { ...queueTarget, targetId: '' },
  ])
    assert.throws(() => canonicalTarget(bad), EventDomainError, JSON.stringify(bad));
});

test('QUEUE-A: the rule binds queueMs exactly when it has a queue target, bounded to 1–30 days (Q2)', () => {
  const canonical = canonicalFullRuleDocument(gmailQueueRule());
  assert.equal(canonical.retention.queueMs, 7 * DAY);
  assert.throws(() => canonicalFullRuleDocument(gmailQueueRule({ retention })), refusedWith(/queueMs/));
  for (const queueMs of [DAY - 1, 30 * DAY + 1, 0])
    assert.throws(
      () => canonicalFullRuleDocument(gmailQueueRule({ retention: { ...retention, queueMs } })),
      EventDomainError,
    );
  const dryRun = { targetId: 'dry-a', version: 1, kind: 'dry-run', retentionMs: DAY };
  assert.throws(
    () => canonicalFullRuleDocument(gmailQueueRule({ targets: [dryRun] })),
    refusedWith(/queueMs/),
    'a rule with no queue target has no queue retention to bind',
  );
  assert.equal(
    canonicalFullRuleDocument(gmailQueueRule({ targets: [dryRun], retention })).retention.queueMs,
    undefined,
  );
});

test('QUEUE-A: the canonical form omits an absent queueMs, so every stored rule and its digest are unchanged (Q2)', () => {
  const dryRun = { targetId: 'dry-a', version: 1, kind: 'dry-run', retentionMs: DAY };
  const rule = canonicalFullRuleDocument(gmailQueueRule({ targets: [dryRun], retention }));
  assert.equal(Object.hasOwn(rule.retention, 'queueMs'), false);
  assert.doesNotMatch(canonicalJson(rule), /queueMs/);
  const document = { documentVersion: 1, kind: 'rule', rule: gmailQueueRule() } as const;
  const shorter = {
    ...document,
    rule: gmailQueueRule({ retention: { ...retention, queueMs: 6 * DAY } }),
  } as const;
  assert.notEqual(
    activationDocumentDigest(document as never),
    activationDocumentDigest(shorter as never),
    'queueMs is bound into a queue rule digest',
  );
});

test('QUEUE-A: a queue rule whose mapping lacks the fields it shows is refused, naming each missing field (Q4)', () => {
  assert.throws(
    () => canonicalFullRuleDocument(gmailQueueRule({ mapping: { id: { $path: '/messageId' } } })),
    refusedWith(/from\.address.*subject/, 'QUEUE_MAPPING_INCOMPLETE'),
  );
  assert.throws(
    () => canonicalFullRuleDocument(gmailQueueRule({ mapping: { subject: { $path: '/subject' } } })),
    (error: unknown) =>
      refusedWith(/from\.address/, 'QUEUE_MAPPING_INCOMPLETE')(error) && !(error as Error).message.includes('subject,'),
  );
  // A parent reference keeps the referenced subtree, so `/from` supplies the sender; the root supplies everything.
  assert.ok(
    canonicalFullRuleDocument(gmailQueueRule({ mapping: { from: { $path: '/from' }, s: { $path: '/subject' } } })),
  );
  assert.ok(canonicalFullRuleDocument(gmailQueueRule({ mapping: { event: { $path: '' } } })));
  const slack = {
    source: {
      channel: 'slack',
      accountIds: ['acc_AAAAAAAAAAAAAAAA'],
      options: { channel: 'slack', conversations: ['C1'] },
    },
    event: { type: 'slack.message.posted', version: 1 },
    condition: { path: '/text', op: 'exists' },
  };
  assert.throws(
    () => canonicalFullRuleDocument(gmailQueueRule({ ...slack, mapping: { who: { $path: '/author/name' } } })),
    refusedWith(/text/, 'QUEUE_MAPPING_INCOMPLETE'),
  );
  assert.ok(
    canonicalFullRuleDocument(
      gmailQueueRule({ ...slack, mapping: { who: { $path: '/author/name' }, text: { $path: '/text' } } }),
    ),
  );
  const whatsapp = {
    source: {
      channel: 'whatsapp',
      accountIds: ['acc_AAAAAAAAAAAAAAAA'],
      options: { channel: 'whatsapp', chats: 'all-allowed' },
    },
    event: { type: 'whatsapp.message.received', version: 1 },
    condition: { path: '/messageId', op: 'exists' },
  };
  assert.throws(
    () => canonicalFullRuleDocument(gmailQueueRule({ ...whatsapp, mapping: { text: { $path: '/text' } } })),
    refusedWith(/sender/, 'QUEUE_MAPPING_INCOMPLETE'),
  );
  assert.ok(
    canonicalFullRuleDocument(
      gmailQueueRule({ ...whatsapp, mapping: { who: { $path: '/sender/id' }, text: { $path: '/text' } } }),
    ),
  );
  const resend = {
    source: {
      channel: 'resend',
      accountIds: ['acc_AAAAAAAAAAAAAAAA'],
      options: { channel: 'resend', kinds: ['received'] },
    },
    event: { type: 'resend.email.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
  };
  assert.throws(
    () => canonicalFullRuleDocument(gmailQueueRule({ ...resend, mapping: { from: { $path: '/from' } } })),
    refusedWith(/subject or body/, 'QUEUE_MAPPING_INCOMPLETE'),
  );
  assert.ok(
    canonicalFullRuleDocument(
      gmailQueueRule({ ...resend, mapping: { from: { $path: '/from/address' }, body: { $path: '/body' } } }),
    ),
  );
  // A rule with no queue target keeps every mapping it could have before.
  const dryRun = { targetId: 'dry-a', version: 1, kind: 'dry-run', retentionMs: DAY };
  assert.ok(canonicalFullRuleDocument(gmailQueueRule({ targets: [dryRun], retention, mapping: { constant: 'safe' } })));
});

test('QUEUE-A: creating or activating a queue rule whose mapping lacks a shown field is refused (Q4)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-queue-domain-');
  const store = await openEventDatabase({ stateDir });
  try {
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(queueTarget);
    assert.throws(
      () => versions.createRule(gmailQueueRule({ mapping: { subject: { $path: '/subject' } } })),
      refusedWith(/from\.address/, 'QUEUE_MAPPING_INCOMPLETE'),
    );
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM rule_versions').get() as { count: number }).count,
      0,
      'a refused create stores nothing',
    );
    // A version that reached storage another way still cannot be prepared for activation.
    const stored = canonicalJson(gmailQueueRule({ mapping: { subject: { $path: '/subject' } } }));
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
      .run('rule-queue@1', 'rule-queue', 1, stored, sha256Hex(stored));
    assert.throws(
      () => versions.prepareRule('rule-queue', 1),
      refusedWith(/from\.address/, 'QUEUE_MAPPING_INCOMPLETE'),
    );
    assert.ok(versions.createRule(gmailQueueRule({ version: 2 })));
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('QUEUE-A: item ids are qi_ and 26 Crockford base32 characters, distinct and time-ordered', () => {
  const first = newQueueItemId(1_000);
  const second = newQueueItemId(2_000);
  for (const id of [first, second, newQueueItemId()]) {
    assert.match(id, /^qi_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(isQueueItemId(id), true);
  }
  assert.ok(first < second, 'a later item sorts after an earlier one');
  assert.notEqual(newQueueItemId(1_000), newQueueItemId(1_000));
  for (const bad of [
    'qi_',
    `qi_${'I'.repeat(26)}`,
    `qi_${'0'.repeat(25)}`,
    `QI_${'0'.repeat(26)}`,
    `qi_${'0'.repeat(27)}`,
  ])
    assert.equal(isQueueItemId(bad), false, bad);
});

test('QUEUE-A: shortening queueMs is a whitelisted tightening, and removing the last queue target takes queueMs with it', () => {
  const parent = canonicalFullRuleDocument(gmailQueueRule());
  const shorter = canonicalFullRuleDocument(
    gmailQueueRule({ version: 2, retention: { ...retention, queueMs: 3 * DAY } }),
  );
  assert.equal(tighteningKind(parent, shorter), 'shorten-retention');
  const longer = canonicalFullRuleDocument(
    gmailQueueRule({ version: 2, retention: { ...retention, queueMs: 10 * DAY } }),
  );
  assert.equal(tighteningKind(parent, longer), null, 'a longer queue retention is a loosening');

  const dryRun = { targetId: 'dry-a', version: 1, kind: 'dry-run', retentionMs: DAY };
  const both = canonicalFullRuleDocument(gmailQueueRule({ targets: [dryRun, queueTarget] }));
  const withoutQueue = canonicalFullRuleDocument(gmailQueueRule({ version: 2, targets: [dryRun], retention }));
  assert.equal(tighteningKind(both, withoutQueue), 'remove-target');
  const withoutDryRun = canonicalFullRuleDocument(gmailQueueRule({ version: 2, targets: [queueTarget] }));
  assert.equal(tighteningKind(both, withoutDryRun), 'remove-target');
  const shortenedToo = canonicalFullRuleDocument(
    gmailQueueRule({ version: 2, targets: [queueTarget], retention: { ...retention, queueMs: DAY } }),
  );
  assert.equal(tighteningKind(both, shortenedToo), null, 'one whitelisted edit at a time');
});
