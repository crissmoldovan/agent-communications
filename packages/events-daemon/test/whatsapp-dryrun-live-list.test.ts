import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { commitDecisionOutbox } from '../src/runtime/decisions.ts';
import { DryRunDispatcher } from '../src/runtime/dispatcher.ts';
import { WhatsAppVisibilityFence } from '../src/runtime/whatsapp-visibility.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const accountId = 'acc_whatsapp_dryrun';
const deliveryId = 'whatsapp-dryrun-delivery';
const messageId = '["wa-msg","chat@example.test","sender@example.test","one"]';
const plaintext = Buffer.from(
  JSON.stringify({ cloudEventBytes: '{"subject":"untrusted"}', untrusted: ['/subject'], representation: 'plain' }),
);

const rule = {
  ruleId: 'whatsapp-dryrun-rule',
  version: 1,
  source: {
    channel: 'whatsapp',
    accountIds: [accountId],
    options: { channel: 'whatsapp', chats: ['chat@example.test'] },
  },
  event: { type: 'whatsapp.message.received', version: 1 },
  condition: { op: 'exists', path: '/id' },
  mapping: { constant: 'safe' },
  targets: [{ targetId: 'dry-target', version: 1, kind: 'dry-run' as const, retentionMs: 1_000 }],
  subscribers: [],
  judges: [],
  deliveryRateCap: 10,
  retention: {
    ingestMs: 1_000,
    holdMs: 1_000,
    deliveryMs: 1_000,
    dryrunMs: 1_000,
    sseReplayMs: 1_000,
    deadLetterMs: 1_000,
    decisionMetadataMs: 1_000,
  },
};

async function fixture() {
  const stateDir = await shortTempDir('events-whatsapp-dryrun-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(rule.targets[0]);
  versions.createRule(rule);
  store.database.exec(
    `UPDATE rule_versions
        SET state = 'active', approval_id = 'whatsapp-dryrun-approval', authorization_activation_id = 'whatsapp-dryrun-activation', activated_at = 1
      WHERE id = 'whatsapp-dryrun-rule@1';
     INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
     VALUES ('rule', 'whatsapp-dryrun-rule', 1, 'whatsapp-dryrun-activation', 1);`,
  );
  store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('whatsapp-dryrun-event', ?, 'whatsapp.message.received', 1, ?, 'dedupe', 1, 1, 1)`,
    )
    .run(store.installationId, accountId);
  store.database
    .prepare('INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, 1, ?, 1)')
    .run(accountId, 'b'.repeat(64));
  store.database
    .prepare(
      `INSERT INTO whatsapp_occurrences
        (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, event_id)
       VALUES (?, ?, 1, 1, 1, 'whatsapp-dryrun-event')`,
    )
    .run(accountId, messageId);
  store.database
    .prepare(
      `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('whatsapp-dryrun-decision', 'whatsapp-dryrun-event', ?, ?, 1, 'delivered', 10_000, 'retained')`,
    )
    .run(accountId, rule.ruleId);
  store.database
    .prepare(
      `INSERT INTO deliveries
        (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
         encrypted_record, expires_at, state, switch_generation, whatsapp_visibility_version, whatsapp_message_id)
       VALUES (?, 'whatsapp-dryrun-decision', ?, ?, 1, 'dryrun:dry-target:1', 'dry-target', 1, ?, 10_000,
               'queued', 7, 1, ?)`,
    )
    .run(deliveryId, accountId, rule.ruleId, plaintext, messageId);
  let visible = false;
  let digest = 'a'.repeat(64);
  let unreadable = false;
  let accountPresent = true;
  let removeWhenListAcquired = false;
  const hiddenFence = new WhatsAppVisibilityFence({
    store,
    withCurrentEventVisibility: async (_input, work) => {
      if (unreadable) throw new Error('the list is unreadable');
      if (removeWhenListAcquired) accountPresent = false;
      return work({ version: 1, digest, seesMessage: () => visible });
    },
  });
  const dispatcher = new DryRunDispatcher({
    store,
    cipher: {
      encrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
      decrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
    },
    approvals: { get: async () => null },
    config: {
      load: async () => ({
        inboxes: {},
        accounts: accountPresent ? { whatsapp: { id: accountId, platform: 'whatsapp' } } : {},
      }),
    },
    fence: async () => ({
      switchGeneration: 7,
      approvalId: 'approval',
      authorizationActivationId: 'activation',
      usedAt: 'now',
    }),
    now: () => 2,
    whatsappVisibilityFence: hiddenFence,
  } as never);
  return {
    stateDir,
    store,
    dispatcher,
    showEverything: () => {
      visible = true;
      digest = 'b'.repeat(64);
    },
    hideEverything: () => {
      visible = false;
      digest = 'c'.repeat(64);
    },
    makeListUnreadable: () => {
      unreadable = true;
    },
    removeAtNextListAcquire: () => {
      removeWhenListAcquired = true;
    },
  };
}

test('D9: a WhatsApp dry-run append rechecks the live list after encryption and never appends a newly hidden row', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    assert.deepEqual(await setup.dispatcher.dispatch(deliveryId), { state: 'terminal', deliveryId });
    assert.equal(setup.store.database.prepare('SELECT 1 FROM dryrun_log').get(), undefined);
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare('SELECT state, encrypted_record FROM deliveries WHERE id = ?')
          .get(deliveryId) as Record<string, unknown>),
      },
      { state: 'cancelled', encrypted_record: null },
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('P1: dry-run append and show re-read a removed WhatsApp account while the list lock is held', {
  skip: WINDOWS_SKIP,
}, async () => {
  const append = await fixture();
  try {
    append.showEverything();
    append.removeAtNextListAcquire();
    assert.deepEqual(await append.dispatcher.dispatch(deliveryId), { state: 'terminal', deliveryId });
    assert.equal(append.store.database.prepare('SELECT 1 FROM dryrun_log').get(), undefined);
  } finally {
    append.store.close();
    await rm(append.stateDir, { recursive: true, force: true });
  }

  const show = await fixture();
  try {
    show.showEverything();
    assert.deepEqual(await show.dispatcher.dispatch(deliveryId), { state: 'delivered', deliveryId });
    show.removeAtNextListAcquire();
    await assert.rejects(
      () => show.dispatcher.read(deliveryId),
      (error: unknown) => {
        return (
          error instanceof Error &&
          'details' in error &&
          (error as { details?: { reason?: string } }).details?.reason === 'ACCOUNT_REMOVED'
        );
      },
    );
    assert.equal(show.store.database.prepare('SELECT 1 FROM dryrun_log').get(), undefined);
  } finally {
    show.store.close();
    await rm(show.stateDir, { recursive: true, force: true });
  }
});

test('D9: a WhatsApp dry-run append consults the live list even before an occurrence row exists to purge', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.store.database.prepare('DELETE FROM whatsapp_occurrences').run();
    assert.deepEqual(await setup.dispatcher.dispatch(deliveryId), { state: 'terminal', deliveryId });
    assert.equal(setup.store.database.prepare('SELECT 1 FROM dryrun_log').get(), undefined);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('D9: a WhatsApp dry-run show rechecks the live list and purges a row newly hidden after append', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.showEverything();
    assert.deepEqual(await setup.dispatcher.dispatch(deliveryId), { state: 'delivered', deliveryId });
    setup.hideEverything();
    await assert.rejects(() => setup.dispatcher.read(deliveryId), { code: 'NOT_FOUND' });
    assert.equal(setup.store.database.prepare('SELECT 1 FROM dryrun_log').get(), undefined);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('D9: an unreadable WhatsApp list hides a dry-run show without purging retained content', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.showEverything();
    assert.deepEqual(await setup.dispatcher.dispatch(deliveryId), { state: 'delivered', deliveryId });
    setup.makeListUnreadable();
    await assert.rejects(() => setup.dispatcher.read(deliveryId), /unreadable/u);
    assert.ok(setup.store.database.prepare('SELECT 1 FROM dryrun_log').get());
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('D9: the WhatsApp tuple follows a candidate projection into the decision and dry-run delivery rows', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-delivery-metadata-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
    store.database
      .prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES ('metadata-event', ?, 'whatsapp.message.received', 1, ?, 'metadata', 1, 1, 1)`,
      )
      .run(store.installationId, accountId);
    store.database
      .prepare(
        `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
         VALUES ('metadata-event', 'metadata-rule', 1, 10_000, X'01')`,
      )
      .run();
    commitDecisionOutbox(store, {
      id: 'metadata-decision',
      eventId: 'metadata-event',
      accountId,
      ruleId: 'metadata-rule',
      ruleVersion: 1,
      outcome: 'matched',
      metadataExpiresAt: 10_000,
      switchGeneration: 7,
      whatsapp: { messageId, visibilityVersion: 1 },
      deliveries: [
        {
          id: 'metadata-delivery',
          targetKey: 'dryrun:dry-target:1',
          target: { targetId: 'dry-target', targetVersion: 1, kind: 'dry-run', representation: 'plain' },
          representation: 'plain',
          encryptedRecord: plaintext,
          expiresAt: 10_000,
        },
      ],
    } as never);
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            `SELECT decision.whatsapp_message_id AS decision_message_id,
                    delivery.whatsapp_message_id AS delivery_message_id,
                    delivery.whatsapp_visibility_version AS delivery_visibility_version
               FROM decisions AS decision JOIN deliveries AS delivery ON delivery.decision_id = decision.id`,
          )
          .get() as Record<string, unknown>),
      },
      {
        decision_message_id: messageId,
        delivery_message_id: messageId,
        delivery_visibility_version: 1,
      },
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
