import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { applyDerivedTightening } from '../src/runtime/replacements.ts';
import { type DSourceRetentionParticipant, RetainedContentHooks } from '../src/runtime/retained-content-hooks.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const input = {
  ruleId: 'rule-retention',
  affectedVersionIds: ['rule-retention@2', 'rule-retention@1'],
  revokedVersionId: 'rule-retention@1',
  at: '1970-01-01T00:00:01.000Z',
  changes: [{ retention: 'sse-replay' as const, durationMs: 1_000 }],
};

const target = { targetId: 'target-retention', version: 1, kind: 'dry-run' as const, retentionMs: 1_000 };
const parent: CanonicalFullRuleDocument = {
  ruleId: 'rule-retention',
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: ['account-1'],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { subject: { $path: '/subject' } },
  targets: [target],
  subscribers: [],
  judges: [],
  deliveryRateCap: 1,
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

test('D4a: a retained-content participant shares the derived-tightening transaction and receives exact D authority', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-retained-hooks-');
  const store = await openEventDatabase({ stateDir });
  try {
    const hooks = new RetainedContentHooks();
    let received: unknown;
    hooks.registerRetentionTighteningParticipant({
      shortenOrPurgeInTransaction(tx, participantInput) {
        received = participantInput;
        tx.prepare("INSERT INTO meta (key, value) VALUES ('retained-hook', 'inside')").run();
      },
    });

    store.immediate(() => {
      hooks.dispatchRetentionTighteningInTransaction(store.database, input);
      assert.equal(
        (store.database.prepare("SELECT value FROM meta WHERE key = 'retained-hook'").get() as { value: string }).value,
        'inside',
        'the participant runs before this outer transaction commits',
      );
    });
    assert.deepEqual(received, input);
    assert.equal(
      (store.database.prepare("SELECT value FROM meta WHERE key = 'retained-hook'").get() as { value: string }).value,
      'inside',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4a: an asynchronous or failing retained-content participant rolls back the shared transaction', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-retained-hooks-');
  const store = await openEventDatabase({ stateDir });
  try {
    const hooks = new RetainedContentHooks();
    const asyncParticipant: DSourceRetentionParticipant = {
      shortenOrPurgeInTransaction(tx) {
        tx.prepare("INSERT INTO meta (key, value) VALUES ('retained-hook-rollback', 'written')").run();
        return Promise.resolve() as never;
      },
    };
    hooks.registerRetentionTighteningParticipant(asyncParticipant);
    assert.throws(
      () => store.immediate(() => hooks.dispatchRetentionTighteningInTransaction(store.database, input)),
      /synchronous/u,
    );
    assert.equal(
      store.database.prepare("SELECT 1 FROM meta WHERE key = 'retained-hook-rollback'").get(),
      undefined,
      'a rejected asynchronous callback cannot leave a post-commit write',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4a: a list participant sees only canonical WhatsApp ids and runs in the D-owned transaction', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-retained-list-');
  const store = await openEventDatabase({ stateDir });
  try {
    const hooks = new RetainedContentHooks();
    const messageId = '["wa-msg","chat","sender","stanza"]';
    let received: unknown;
    hooks.registerWhatsAppListChangeParticipant({
      purgeNewlyHiddenInTransaction(tx, participantInput) {
        received = participantInput;
        tx.prepare("INSERT INTO meta (key, value) VALUES ('list-hook', 'inside')").run();
      },
    });
    store.immediate(() => {
      hooks.dispatchWhatsAppListChangeInTransaction(store.database, {
        accountId: 'account-1',
        newlyHiddenMessageIds: [messageId],
        visibilityVersion: 1,
        changedAt: '1970-01-01T00:00:01.000Z',
      });
    });
    assert.deepEqual(received, {
      accountId: 'account-1',
      newlyHiddenMessageIds: [messageId],
      visibilityVersion: 1,
      changedAt: '1970-01-01T00:00:01.000Z',
    });
    assert.throws(
      () =>
        store.immediate(() =>
          hooks.dispatchWhatsAppListChangeInTransaction(store.database, {
            accountId: 'account-1',
            newlyHiddenMessageIds: ['["wa-msg", "chat", "sender", "stanza"]'],
            visibilityVersion: 2,
            changedAt: '1970-01-01T00:00:02.000Z',
          }),
        ),
      /non-canonical/u,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4a: an actual derived retention tightening invokes its participant before it revokes the displaced version', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-retained-derived-');
  const store = await openEventDatabase({ stateDir });
  try {
    const child: CanonicalFullRuleDocument = {
      ...parent,
      version: 2,
      retention: { ...parent.retention, ingestMs: 900, holdMs: 900 },
    };
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createRule(parent);
    versions.createRule(child);
    store.database.exec(`
      UPDATE rule_versions
      SET state = 'active', approval_id = 'approval-root', authorization_activation_id = 'activation-root', activated_at = 1
      WHERE id = 'rule-retention@1';
      INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
      VALUES ('rule', 'rule-retention', 1, 'activation-root', 1);
      INSERT INTO rule_activation_points
        (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
      VALUES ('activation-root', 'rule-retention', 1, 'gmail', 'account-1', 'mailbox', X'01', 1);
    `);
    const hooks = new RetainedContentHooks();
    let observed: unknown;
    hooks.registerRetentionTighteningParticipant({
      shortenOrPurgeInTransaction(tx, participantInput) {
        observed = participantInput;
        assert.equal(
          (tx.prepare("SELECT state FROM rule_versions WHERE id = 'rule-retention@1'").get() as { state: string })
            .state,
          'active',
          'the participant is inside the pointer transaction before its displaced version is revoked',
        );
      },
    });

    await applyDerivedTightening({
      database: store.database,
      parent,
      child,
      now: 10,
      retainedContentHooks: hooks,
      decryptPoint: async () => ({ historyId: '1' }),
      encryptPoint: async () => Buffer.from('point'),
    });

    assert.deepEqual(observed, {
      ...input,
      changes: [
        { retention: 'ingest', durationMs: 900 },
        { retention: 'hold', durationMs: 900 },
      ],
      at: '1970-01-01T00:00:00.010Z',
    });
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4a: a retained-content participant failure rolls back the actual derived pointer and all D shortening', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-retained-rollback-');
  const store = await openEventDatabase({ stateDir });
  try {
    const child: CanonicalFullRuleDocument = {
      ...parent,
      version: 2,
      retention: { ...parent.retention, ingestMs: 900, holdMs: 900 },
    };
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createRule(parent);
    versions.createRule(child);
    store.database.exec(`
      UPDATE rule_versions
      SET state = 'active', approval_id = 'approval-root', authorization_activation_id = 'activation-root', activated_at = 1
      WHERE id = 'rule-retention@1';
      INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
      VALUES ('rule', 'rule-retention', 1, 'activation-root', 1);
      INSERT INTO rule_activation_points
        (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
      VALUES ('activation-root', 'rule-retention', 1, 'gmail', 'account-1', 'mailbox', X'01', 1);
      INSERT INTO source_scan_state
        (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
      VALUES ('stage-rollback', 'gmail', 'account-1', 'mailbox', 10, 1_010, X'01', 10);
      INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version)
      VALUES ('stage-rollback', 'rule-retention', 1);
    `);
    const hooks = new RetainedContentHooks();
    hooks.registerRetentionTighteningParticipant({
      shortenOrPurgeInTransaction() {
        throw new Error('participant failure');
      },
    });
    await assert.rejects(
      () =>
        applyDerivedTightening({
          database: store.database,
          parent,
          child,
          now: 10,
          retainedContentHooks: hooks,
          decryptPoint: async () => ({ historyId: '1' }),
          encryptPoint: async () => Buffer.from('point'),
        }),
      /participant failure/u,
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT version FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-retention'")
          .get() as Record<string, unknown>),
      },
      { version: 1 },
    );
    assert.deepEqual(
      {
        ...(store.database.prepare("SELECT state FROM rule_versions WHERE id = 'rule-retention@2'").get() as Record<
          string,
          unknown
        >),
      },
      { state: null },
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT stage_expires_at FROM source_scan_state WHERE id = 'stage-rollback'")
          .get() as Record<string, unknown>),
      },
      { stage_expires_at: 1_010 },
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
