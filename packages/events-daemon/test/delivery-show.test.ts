import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { DeliveryReader } from '../src/runtime/delivery-show.ts';
import { parseEventSource } from '../src/runtime/event-source.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * 0.32.0, owner feedback §3.5: `delivery show <id>` is the person's view of one delivery — the list row, the decision
 * and its judge's answer, the event with the source's own ids, the target and, for a dry run, how long its entry is
 * kept. Content-free: ids, times and the judge's yes or no.
 */

test('0.32 B3: an event source is read back from its dedupe key, per channel, and a malformed key gives null', () => {
  assert.deepEqual(parseEventSource('gmail.message.received', '["4417","g-0001","received"]'), {
    channel: 'gmail',
    messageId: 'g-0001',
  });
  assert.deepEqual(parseEventSource('gmail.message.sent', '["4418","g-0002","sent"]'), {
    channel: 'gmail',
    messageId: 'g-0002',
  });
  assert.deepEqual(parseEventSource('gmail.message.labelled', '["4419","g-0003","labelled"]'), {
    channel: 'gmail',
    messageId: 'g-0003',
  });
  assert.deepEqual(parseEventSource('slack.message.posted', 'C0123ABCD/1699999999.123456'), {
    channel: 'slack',
    channelId: 'C0123ABCD',
    ts: '1699999999.123456',
  });
  assert.deepEqual(parseEventSource('whatsapp.message.received', '447700900001@s.whatsapp.net/3EB0FAKE01'), {
    channel: 'whatsapp',
    chatId: '447700900001@s.whatsapp.net',
    messageId: '3EB0FAKE01',
  });
  assert.deepEqual(parseEventSource('resend.email.received', 'fake-email-0001'), {
    channel: 'resend',
    emailId: 'fake-email-0001',
  });
  assert.deepEqual(
    parseEventSource('resend.email.status_changed', '["fake-email-0002","sent","delivered","2026-10-26T08:00:00Z"]'),
    { channel: 'resend', emailId: 'fake-email-0002' },
  );
  for (const [type, key] of [
    ['gmail.message.received', 'g-0001'],
    ['gmail.message.received', '["4417"]'],
    ['gmail.message.received', '["4417",7,"received"]'],
    ['slack.message.posted', 'C0123ABCD'],
    ['slack.message.posted', '/1699999999.123456'],
    ['slack.message.posted', 'C0123ABCD/not-a-ts'],
    ['whatsapp.message.received', 'no-slash'],
    ['whatsapp.message.received', 'chat/'],
    ['resend.email.received', ''],
    ['agentcomms.delivery.told', 'anything'],
    ['unknown', 'anything'],
  ] as const)
    assert.equal(parseEventSource(type, key), null, `${type} ${key}`);
});

const ACCOUNT = 'ibx_DELIVERYSHOW0001';
const SLACK_ACCOUNT = 'acc_DELIVERYSHOWSLK1';

type Store = Awaited<ReturnType<typeof openEventDatabase>>;

const judgedRule = {
  ruleId: 'invoices',
  version: 2,
  source: { channel: 'gmail', accountIds: [ACCOUNT] },
  event: { type: 'gmail.message.received', version: 1 },
  agentic: {
    judge: { judgeId: 'jev', version: 1, kind: 'typesafe', provider: 'typesafe', model: 'jev-1.13.0' },
    question: 'Is this an invoice?',
    threshold: 0.5,
  },
  targets: [
    { targetId: 'dry-invoices', version: 1, kind: 'dry-run', retentionMs: 86_400_000 },
    {
      targetId: 'billing',
      version: 3,
      kind: 'queue',
      retentionMs: 86_400_000,
      show: 'summary',
      lane: { name: 'billing' },
    },
  ],
};
const slackRule = {
  ruleId: 'ops-alerts',
  version: 1,
  source: { channel: 'slack', accountIds: [SLACK_ACCOUNT] },
  event: { type: 'slack.message.posted', version: 1 },
  targets: [
    {
      targetId: 'ops-hook',
      version: 1,
      kind: 'webhook',
      url: { kind: 'plain', value: 'https://hooks.example.test/agentcomms?token=fake-path-part' },
    },
    {
      targetId: 'secret-hook',
      version: 1,
      kind: 'webhook',
      url: { kind: 'secret', scheme: 'https', host: 'private.example.test', port: 443, sha256: 'a'.repeat(64) },
    },
  ],
};

function seed(store: Store): void {
  const db = store.database;
  const version = db.prepare(
    `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
     VALUES (?, ?, ?, ?, 'digest', 'active', 'approval', 'activation', 1)`,
  );
  for (const rule of [judgedRule, slackRule]) {
    version.run(`${rule.ruleId}@${rule.version}`, rule.ruleId, rule.version, JSON.stringify(rule));
    for (const target of rule.targets)
      db.prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)').run(
        `${target.targetId}@${target.version}`,
        target.targetId,
        target.version,
        JSON.stringify(target),
        'digest',
      );
  }
  const ingest = db.prepare(
    `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  );
  ingest.run(
    'event-mail',
    store.installationId,
    'gmail.message.received',
    ACCOUNT,
    '["4417","g-0001","received"]',
    1_000,
    1_100,
    1_100,
  );
  ingest.run(
    'event-slack',
    store.installationId,
    'slack.message.posted',
    SLACK_ACCOUNT,
    'C0123ABCD/1699999999.123456',
    2_000,
    2_100,
    2_100,
  );
  const decision = db.prepare(
    `INSERT INTO decisions
       (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, encrypted_record)
     VALUES (?, ?, ?, ?, ?, 'matched', 999999, 'retained', ?)`,
  );
  // The test cipher is the identity: the decision's metadata is the judge's answer as the coordinator wrote it.
  const metadata = {
    judgeId: 'jev',
    judgeVersion: 1,
    provider: 'typesafe',
    model: 'jev-1.13.0',
    threshold: 0.5,
    value: 0.92,
    valueLabel: 'probability',
  };
  decision.run('decision-mail', 'event-mail', ACCOUNT, 'invoices', 2, Buffer.from(JSON.stringify(metadata)));
  decision.run('decision-slack', 'event-slack', SLACK_ACCOUNT, 'ops-alerts', 1, null);
  const delivery = db.prepare(
    `INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        encrypted_record, attempts, next_at, expires_at, state, switch_generation, last_error_code, last_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 90000, ?, 4, ?, ?)`,
  );
  delivery.run(
    'delivery-dry',
    'decision-mail',
    ACCOUNT,
    'invoices',
    2,
    'dryrun:dry-invoices:1',
    'dry-invoices',
    1,
    'dry-run',
    null,
    1,
    null,
    'delivered',
    null,
    null,
  );
  delivery.run(
    'delivery-lane',
    'decision-mail',
    ACCOUNT,
    'invoices',
    2,
    'queue:billing:3',
    'billing',
    3,
    'queue',
    null,
    1,
    null,
    'delivered',
    null,
    null,
  );
  delivery.run(
    'delivery-hook',
    'decision-slack',
    SLACK_ACCOUNT,
    'ops-alerts',
    1,
    'webhook:ops-hook:1',
    'ops-hook',
    1,
    'webhook',
    Buffer.from('x'),
    3,
    5_000,
    'retryable',
    'WEBHOOK_STATUS',
    503,
  );
  delivery.run(
    'delivery-secret',
    'decision-slack',
    SLACK_ACCOUNT,
    'ops-alerts',
    1,
    'webhook:secret-hook:1',
    'secret-hook',
    1,
    'webhook',
    null,
    5,
    null,
    'dead-lettered',
    'WEBHOOK_STATUS',
    500,
  );
  db.prepare(
    `INSERT INTO dryrun_log
       (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record,
        delivered_at, expires_at)
     VALUES ('delivery-dry', 'invoices', 2, 'dry-invoices', 1, 'event-mail', ?, X'01', 1200, 50000)`,
  ).run(ACCOUNT);
}

async function withReader(work: (store: Store, reader: DeliveryReader, clock: { now: number }) => Promise<void>) {
  const stateDir = await shortTempDir('aev-delivery-show-');
  try {
    const store = await openEventDatabase({ stateDir });
    const clock = { now: 10_000 };
    try {
      seed(store);
      const cipher = { decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes) };
      await work(store, new DeliveryReader({ store, cipher, now: () => clock.now }), clock);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('0.32 B3: a dry-run delivery shows its decision with the judge’s answer, its Gmail source and its log entry', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReader(async (_store, reader) => {
    const shown = await reader.show('delivery-dry');
    assert.deepEqual(shown, {
      delivery: {
        deliveryId: 'delivery-dry',
        accountId: ACCOUNT,
        ruleId: 'invoices',
        ruleVersion: 2,
        targetId: 'dry-invoices',
        targetVersion: 1,
        subscriberId: null,
        subscriberVersion: null,
        attempts: 1,
        nextAt: null,
        expiresAt: 90000,
        state: 'delivered',
        switchGeneration: 4,
        deadLetterExpiresAt: null,
        targetKind: 'dry-run',
        lastErrorCode: null,
        lastStatus: null,
        decisionId: 'decision-mail',
        eventId: 'event-mail',
        deliveredAt: 1200,
      },
      decision: {
        outcome: 'matched',
        decidedAt: null,
        judge: { kind: 'typesafe', answer: 'yes', confidence: 0.92, calibrated: true },
      },
      event: {
        eventId: 'event-mail',
        type: 'gmail.message.received',
        accountId: ACCOUNT,
        occurredAt: 1000,
        observedAt: 1100,
        source: { channel: 'gmail', messageId: 'g-0001' },
      },
      target: { kind: 'dry-run', id: 'dry-invoices', version: 1 },
      dryRun: { expiresAt: 50000 },
    });
  });
});

test('0.32 B3: the decision time is the judge’s settlement, the target names its lane, and a past entry is gone', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReader(async (store, reader, clock) => {
    // The judge's reservation settles in the decision's own transaction, so its time is the decision's.
    store.database.exec('PRAGMA foreign_keys = OFF');
    store.database
      .prepare(
        `INSERT INTO judge_budget_reservations
           (id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
            judge_kind, budget_version, provider, global_ledger_key, state, estimated_input_tokens, actual_input_tokens,
            concurrency_owned, reserved_at, in_flight_at, settled_at, switch_generation)
         VALUES ('reservation-1', 'work-1', 'source-owned', 'gmail', ?, 'event-mail', 'invoices', 2, 'jev', 1,
                 'typesafe', 1, 'typesafe', 'installation', 'settled', 10, 10, 0, 1150, 1160, 1180, 4)`,
      )
      .run(ACCOUNT);
    store.database.exec('PRAGMA foreign_keys = ON');
    const lane = await reader.show('delivery-lane');
    assert.equal(lane.decision?.decidedAt, 1180);
    assert.deepEqual(lane.target, { kind: 'queue', id: 'billing', version: 3, lane: 'billing' });
    assert.equal(lane.dryRun, null, 'only a dry run has a log entry');
    clock.now = 50_000;
    assert.deepEqual((await reader.show('delivery-dry')).dryRun, { expiresAt: null }, 'a dry-run entry past its time');
  });
});

test('0.32 B3: a webhook delivery shows its host, never its URL, its last answer, and no judge for a rule without one', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReader(async (_store, reader) => {
    const hook = await reader.show('delivery-hook');
    assert.deepEqual(hook.decision, { outcome: 'matched', decidedAt: null, judge: null });
    assert.deepEqual(hook.event?.source, { channel: 'slack', channelId: 'C0123ABCD', ts: '1699999999.123456' });
    assert.deepEqual(hook.target, { kind: 'webhook', id: 'ops-hook', version: 1, host: 'hooks.example.test' });
    assert.equal(hook.delivery.state, 'retryable');
    assert.equal(hook.delivery.nextAt, 5_000);
    assert.equal(hook.delivery.lastErrorCode, 'WEBHOOK_STATUS');
    assert.equal(hook.delivery.lastStatus, 503);
    assert.doesNotMatch(JSON.stringify(hook), /fake-path-part|agentcomms\?/u, 'the path and query stay out');
    const secret = await reader.show('delivery-secret');
    assert.deepEqual(secret.target, { kind: 'webhook', id: 'secret-hook', version: 1, host: 'private.example.test' });
    assert.doesNotMatch(JSON.stringify(secret), /a{64}/u, 'a secret URL’s digest stays out');
  });
});

test('0.32 B3: a judge whose answer is no longer kept, and an unknown delivery', { skip: WINDOWS_SKIP }, async () => {
  await withReader(async (store, reader) => {
    store.database.exec(
      "UPDATE decisions SET encrypted_record = NULL, metadata_state = 'purged' WHERE id = 'decision-mail'",
    );
    assert.deepEqual((await reader.show('delivery-dry')).decision?.judge, {
      kind: 'typesafe',
      answer: null,
      confidence: null,
      calibrated: null,
    });
    await assert.rejects(
      () => reader.show('delivery-missing'),
      (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
    );
  });
});
