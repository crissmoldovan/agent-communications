import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { GmailReplacementDrains } from '../src/runtime/replacements.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { type GmailSourceRule, GmailSourceWorker } from '../src/sources/source-worker.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'ibx_ABCDEFGHIJKLMNOP';
const target = { targetId: 'target-replacement', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };

function rule(version: number) {
  return {
    ruleId: 'rule-replacement',
    version,
    source: {
      channel: 'gmail' as const,
      accountIds: [ACCOUNT],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { constant: 'safe' },
    targets: [target],
    subscribers: [],
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
  };
}

function history(id: string) {
  return {
    id,
    messagesAdded: [{ message: { id: `message-${id}`, threadId: 'thread' } }],
    labelsAdded: [],
    labelsRemoved: [],
  };
}

function sourceRule(version: number): GmailSourceRule {
  return {
    ruleId: 'rule-replacement',
    ruleVersion: version,
    eventType: 'gmail.message.received',
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    ingestRetentionMs: 604_800_000,
  };
}

test('APR-B1: a real Gmail worker drains old work through persisted P and releases after-P staging only after the atomic swap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-replacement-');
  const store = await openEventDatabase({ stateDir });
  try {
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createRule(rule(1));
    versions.createRule(rule(2));
    store.database.exec(
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_root', authorization_activation_id = 'act_old', activated_at = 1 WHERE id = 'rule-replacement@1'",
    );
    store.database.exec(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-replacement', 1, 'act_old', 1); INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at) VALUES ('act_old', 'rule-replacement', 1, 'gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', X'7B22686973746F72794964223A22313030227D', 1)",
    );
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, replacement_of_version, required_points, acquisition_scopes, status, claimed_at, completion_deadline, created_at, updated_at)
         VALUES ('act_replacement', 'rule', '{}', 'digest', '{}', 'rule-replacement@1', '[]', '[]', 'pending-completion', 1, 3600001, 1, 1)`,
      )
      .run();
    store.database
      .prepare(
        `INSERT INTO activation_baselines (intent_id, source, account_id, position_scope, encrypted_position, response_at)
         VALUES ('act_replacement', 'gmail', ?, 'mailbox', ?, 1)`,
      )
      .run(ACCOUNT, Buffer.from('{"historyId":"101"}'));
    store.database
      .prepare(
        `INSERT INTO replacement_drains (intent_id, source, account_id, position_scope, old_in_scope, new_in_scope)
         VALUES ('act_replacement', 'gmail', ?, 'mailbox', 1, 1)`,
      )
      .run(ACCOUNT);
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', '100', 0)",
      )
      .run(ACCOUNT);

    const drains = new GmailReplacementDrains({
      database: store.database,
      decryptPosition: async ({ record }) => JSON.parse(Buffer.from(record).toString('utf8')),
      now: () => 10,
    });
    const admitted: string[] = [];
    const mailboxLock = new MailboxLock();
    const worker = (rules: () => readonly GmailSourceRule[]) =>
      new GmailSourceWorker({
        store,
        source: {
          async listHistory() {
            return { historyId: '102', nextPageToken: undefined, history: [history('101'), history('102')] };
          },
          async getMessageMetadata(messageId: string) {
            return {
              id: messageId,
              threadId: 'thread',
              labelIds: ['INBOX'],
              internalDate: '1760000000000',
              payload: { headers: [{ name: 'Subject', value: 'subject' }] },
            };
          },
        },
        mailbox: { accountId: ACCOUNT, name: 'Events inbox' },
        mailboxLock,
        rules,
        assertDisclosable: async () => undefined,
        admit: async (occurrence) => {
          admitted.push(`${occurrence.rule.ruleVersion}:${String(occurrence.event.messageId)}`);
          return 'terminal';
        },
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
        replacementDrains: drains,
      });

    assert.deepEqual(await worker(() => [sourceRule(1)]).scan(), { cursor: '100', pending: true });
    assert.deepEqual(admitted, ['1:message-101'], 'P is inclusive for the old version');
    assert.equal(
      (
        store.database
          .prepare("SELECT drained_at FROM replacement_drains WHERE intent_id = 'act_replacement'")
          .get() as {
          drained_at: number | null;
        }
      ).drained_at,
      10,
      'the actual page worker, rather than an activation test double, completes the drain',
    );

    store.immediate(() => {
      store.database.exec(
        "UPDATE rule_versions SET state = 'superseded', superseded_at = 11 WHERE id = 'rule-replacement@1'; UPDATE rule_versions SET state = 'active', approval_id = 'ap_root', authorization_activation_id = 'act_replacement', activated_at = 11 WHERE id = 'rule-replacement@2'; INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at) VALUES ('act_replacement', 'rule-replacement', 2, 'gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', X'7B22686973746F72794964223A22313031227D', 11); UPDATE active_versions SET version = 2, current_cutover_id = 'act_replacement' WHERE kind = 'rule' AND object_id = 'rule-replacement'; DELETE FROM replacement_drains WHERE intent_id = 'act_replacement'",
      );
    });
    assert.deepEqual(await worker(() => [sourceRule(2)]).scan(), { cursor: '102', pending: false });
    assert.deepEqual(admitted, ['1:message-101', '2:message-102']);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('APR-B1: an active version with no cut-over point admits nothing, rather than everything', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-nopoint-');
  const store = await openEventDatabase({ stateDir });
  try {
    const drains = new GmailReplacementDrains({
      database: store.database,
      decryptPosition: async ({ record }) => JSON.parse(Buffer.from(record).toString('utf8')),
    });
    assert.equal(
      await drains.isAfterActivePoint({
        accountId: 'ibx_ABCDEFGHIJKLMNOP',
        ruleId: 'rule-none',
        ruleVersion: 1,
        historyRecordId: '999',
      }),
      false,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
