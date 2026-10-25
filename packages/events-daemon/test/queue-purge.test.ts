import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson } from '@agentcomms/core';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { JudgeKinds } from '../src/runtime/judge-kinds.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { createB2RetainedContentParticipants } from '../src/runtime/phase-d-b2-retention.ts';
import { createPhaseDWhatsAppOwnerComposition } from '../src/runtime/phase-d-whatsapp-owner-composition.ts';
import { tighteningPreviewFor } from '../src/runtime/queue-tightening.ts';
import { applyDerivedTightening } from '../src/runtime/replacements.ts';
import { disableRule, removeTarget } from '../src/runtime/revocations.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const GMAIL = 'ibx_QUEUEPURGE00000';
const OTHER = 'ibx_QUEUEPURGEOTHER';
const WHATSAPP = 'acc_QUEUEPURGEWHATS';

const queueTarget = { targetId: 'queue-purge', version: 1, kind: 'queue', retentionMs: 30 * DAY, show: 'summary' };
const judge = {
  judgeId: 'judge-queue-purge',
  version: 1,
  kind: 'local-endpoint',
  provider: 'ollama',
  model: 'queue-purge-model',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'],
  promptTemplate: 'local-noul-v1',
  protocol: 'noul',
};

const retention = {
  ingestMs: 7 * DAY,
  holdMs: 7 * DAY,
  deliveryMs: 7 * DAY,
  dryrunMs: DAY,
  sseReplayMs: 7 * DAY,
  deadLetterMs: 7 * DAY,
  decisionMetadataMs: 90 * DAY,
  queueMs: 10 * DAY,
};

function rule(input: {
  readonly ruleId: string;
  readonly version?: number;
  readonly accountIds?: readonly string[];
  readonly judged?: boolean;
  readonly queueMs?: number;
}): CanonicalFullRuleDocument {
  return {
    ruleId: input.ruleId,
    version: input.version ?? 1,
    source: {
      channel: 'gmail',
      accountIds: [...(input.accountIds ?? [GMAIL])],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    ...(input.judged
      ? {
          agentic: {
            judge,
            question: 'Does this need me?',
            inputs: ['/subject'],
            threshold: 0.5,
            onUncertain: 'no-match',
            callsPerRollingHour: 10,
            inputTokensPerRolling30Days: 10_000,
            concurrency: 1,
            maxInputTokens: 256,
            maxOutputTokens: 16,
          },
        }
      : {}),
    mapping: { from: { $path: '/from' }, subject: { $path: '/subject' } },
    targets: [queueTarget],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: { ...retention, queueMs: input.queueMs ?? retention.queueMs },
  } as unknown as CanonicalFullRuleDocument;
}

function activate(store: EventDatabase, document: CanonicalFullRuleDocument, state = 'active'): void {
  const versions = new ImmutableVersions(store.database);
  versions.createRule(document);
  const id = `${document.ruleId}@${document.version}`;
  store.database
    .prepare(
      `UPDATE rule_versions SET state = ?, approval_id = 'ap_queue', authorization_activation_id = ?, activated_at = 1
       WHERE id = ?`,
    )
    .run(state, `act_${id}`, id);
  if (state === 'active')
    store.database
      .prepare(
        `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
         VALUES ('rule', ?, ?, ?, 1)
         ON CONFLICT(kind, object_id) DO UPDATE SET version = excluded.version, current_cutover_id = excluded.current_cutover_id`,
      )
      .run(document.ruleId, document.version, `act_${id}`);
}

let sequence = 0;

/** Seeds one appended item as the queue boundary leaves it: a delivered delivery and its encrypted item row. */
function seedItem(
  store: EventDatabase,
  input: {
    readonly ruleId: string;
    readonly ruleVersion?: number;
    readonly accountId?: string;
    readonly channel?: 'gmail' | 'whatsapp';
    readonly whatsappMessageId?: string;
    readonly state?: 'open' | 'done' | 'dismissed';
    readonly appendedAt?: number;
    readonly retentionMs?: number;
  },
): string {
  sequence += 1;
  const tag = String(sequence).padStart(4, '0');
  const id = `qi_000000000000000000000${tag.padStart(5, '0')}`;
  const accountId = input.accountId ?? GMAIL;
  const appendedAt = input.appendedAt ?? NOW - DAY;
  const retentionMs = input.retentionMs ?? 10 * DAY;
  const eventId = `event-${tag}`;
  store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      store.installationId,
      input.channel === 'whatsapp' ? 'whatsapp.message.received' : 'gmail.message.received',
      accountId,
      eventId,
      appendedAt,
      appendedAt,
      appendedAt,
    );
  store.database
    .prepare(
      `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, whatsapp_message_id)
       VALUES (?, ?, ?, ?, ?, 'matched', ?, 'retained', ?)`,
    )
    .run(
      `decision-${tag}`,
      eventId,
      accountId,
      input.ruleId,
      input.ruleVersion ?? 1,
      NOW + 90 * DAY,
      input.whatsappMessageId ?? null,
    );
  store.database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, expires_at, state, switch_generation, whatsapp_message_id, whatsapp_visibility_version)
       VALUES (?, ?, ?, ?, ?, 'queue:queue-purge:1', 'queue-purge', 1, 'queue', NULL, ?, 'delivered', 0, ?, ?)`,
    )
    .run(
      `delivery-${tag}`,
      `decision-${tag}`,
      accountId,
      input.ruleId,
      input.ruleVersion ?? 1,
      NOW + 7 * DAY,
      input.whatsappMessageId ?? null,
      input.whatsappMessageId === undefined ? null : 1,
    );
  store.database
    .prepare(
      `INSERT INTO queue_items
         (id, delivery_id, decision_id, event_id, rule_id, rule_version, target_id, target_version, account_id, channel,
          whatsapp_message_id, state, state_at, arrived_at, appended_at, retention_ms, expires_at, row_expires_at,
          released, encrypted_record)
       VALUES (?, ?, ?, ?, ?, ?, 'queue-purge', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, X'0102')`,
    )
    .run(
      id,
      `delivery-${tag}`,
      `decision-${tag}`,
      eventId,
      input.ruleId,
      input.ruleVersion ?? 1,
      accountId,
      input.channel ?? 'gmail',
      input.whatsappMessageId ?? null,
      input.state ?? 'open',
      appendedAt,
      appendedAt,
      appendedAt,
      retentionMs,
      appendedAt + retentionMs,
      appendedAt + 2 * retentionMs,
    );
  return id;
}

function items(store: EventDatabase, ruleId?: string): number {
  return (
    (ruleId === undefined
      ? store.database.prepare('SELECT COUNT(*) AS count FROM queue_items').get()
      : store.database.prepare('SELECT COUNT(*) AS count FROM queue_items WHERE rule_id = ?').get(ruleId)) as {
      count: number;
    }
  ).count;
}

async function withStore(work: (store: EventDatabase) => Promise<void>): Promise<void> {
  const stateDir = await shortTempDir('events-queue-purge-');
  const store = await openEventDatabase({ stateDir });
  try {
    new ImmutableVersions(store.database).createTarget(queueTarget);
    await work(store);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('QUEUE-A: expiry purges an item’s content at its deadline, whatever its state, then the content-free row', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore(async (store) => {
    activate(store, rule({ ruleId: 'rule-expiry' }));
    const due = seedItem(store, { ruleId: 'rule-expiry', state: 'done', appendedAt: NOW - 10 * DAY });
    const fresh = seedItem(store, { ruleId: 'rule-expiry', appendedAt: NOW - DAY });
    let clock = NOW;
    const expiry = new EventExpiry(store, () => clock);
    const swept = expiry.sweep();
    assert.equal(swept.queueContent, 1);
    const row = (id: string) =>
      store.database.prepare('SELECT state, encrypted_record FROM queue_items WHERE id = ?').get(id) as
        | { state: string; encrypted_record: Uint8Array | null }
        | undefined;
    assert.deepEqual({ ...row(due) }, { state: 'done', encrypted_record: null }, 'content goes; the row stays');
    assert.ok(row(fresh)?.encrypted_record, 'an unexpired item keeps its content');
    clock = NOW + 10 * DAY;
    const later = expiry.sweep();
    assert.equal(later.queueRows, 1, 'the content-free row goes one retention after its content');
    assert.equal(row(due), undefined);
    assert.equal(row(fresh)?.encrypted_record, null, 'the later item’s content has expired by now too');
  });
});

test('QUEUE-A: a rule disable and a target removal purge their queue items with the dry-run rows they purge', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore(async (store) => {
    activate(store, rule({ ruleId: 'rule-disabled' }));
    activate(store, rule({ ruleId: 'rule-kept' }));
    seedItem(store, { ruleId: 'rule-disabled' });
    seedItem(store, { ruleId: 'rule-kept' });
    await disableRule(store, { cancelForRevocation: async () => undefined }, 'rule-disabled');
    assert.equal(items(store, 'rule-disabled'), 0, 'a rule disable purges its items');
    assert.equal(items(store, 'rule-kept'), 1, 'another rule keeps its own');
    await removeTarget(store, { cancelForRevocation: async () => undefined }, 'queue-purge');
    assert.equal(items(store), 0, 'removing the target revokes every rule bound to it and purges their items');
  });
});

test('QUEUE-A: a judge removal and a judge-kind disable purge the items of every rule bound to them', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore(async (store) => {
    const versions = new ImmutableVersions(store.database);
    versions.createJudge(judge);
    versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
    store.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-kind', 'local-endpoint', 1, NULL, 1)",
      )
      .run();
    activate(store, rule({ ruleId: 'rule-judged-a', judged: true }));
    activate(store, rule({ ruleId: 'rule-plain' }));
    seedItem(store, { ruleId: 'rule-judged-a' });
    seedItem(store, { ruleId: 'rule-plain' });
    await new JudgeKinds({ store, now: () => NOW }).disableKind('local-endpoint');
    assert.equal(items(store, 'rule-judged-a'), 0, 'a judge-kind disable purges the items of rules that need it');
    assert.equal(items(store, 'rule-plain'), 1);

    activate(store, rule({ ruleId: 'rule-judged-b', judged: true }));
    seedItem(store, { ruleId: 'rule-judged-b' });
    const control = new B3OperatorControl({
      store,
      ports: { quiescer: { withShared: async (work: () => unknown) => work() } } as never,
      activations: { cancelForRevocation: async () => undefined, cancelForRevocationInTransaction: () => 0 } as never,
      now: () => NOW,
    });
    await control.handle({ operation: 'removeJudge', args: { judgeId: judge.judgeId } });
    assert.equal(items(store, 'rule-judged-b'), 0, 'a judge removal purges the items of rules bound to it');
    assert.equal(items(store, 'rule-plain'), 1);
  });
});

test('QUEUE-A: disable-all purges every queue item', { skip: WINDOWS_SKIP }, async () => {
  await withStore(async (store) => {
    activate(store, rule({ ruleId: 'rule-all-a' }));
    activate(store, rule({ ruleId: 'rule-all-b' }));
    seedItem(store, { ruleId: 'rule-all-a' });
    seedItem(store, { ruleId: 'rule-all-b', state: 'dismissed' });
    await new EventLifecycle(store, () => NOW).disableAll();
    assert.equal(items(store), 0);
  });
});

test('QUEUE-A: an account removal purges that account’s items, and the single-account rule it revokes', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore(async (store) => {
    activate(store, rule({ ruleId: 'rule-shared', accountIds: [GMAIL, OTHER] }));
    activate(store, rule({ ruleId: 'rule-only' }));
    seedItem(store, { ruleId: 'rule-shared', accountId: GMAIL });
    seedItem(store, { ruleId: 'rule-shared', accountId: OTHER });
    seedItem(store, { ruleId: 'rule-only', accountId: GMAIL });
    store.immediate(() => purgeRemovedAccountWork(store.database, { source: 'gmail', accountId: GMAIL }, NOW));
    assert.equal(
      (
        store.database.prepare('SELECT COUNT(*) AS count FROM queue_items WHERE account_id = ?').get(GMAIL) as {
          count: number;
        }
      ).count,
      0,
      'the removed account’s items are gone',
    );
    assert.equal(items(store, 'rule-shared'), 1, 'the other account’s item under a shared rule stays');
    assert.equal(items(store, 'rule-only'), 0);
  });
});

test('QUEUE-A: a WhatsApp chat newly hidden by the person’s lists purges its queue items (the visibility seam)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore(async (store) => {
    const hiddenId = canonicalJson(['wa-msg', 'chat-hidden@g.us', 'sender@s.whatsapp.net', 'stanza-1']);
    const shownId = canonicalJson(['wa-msg', 'chat-shown@g.us', 'sender@s.whatsapp.net', 'stanza-2']);
    const whatsappRule = {
      ...rule({ ruleId: 'rule-whatsapp' }),
      source: {
        channel: 'whatsapp',
        accountIds: [WHATSAPP],
        options: { channel: 'whatsapp', chats: 'all-allowed' },
      },
      event: { type: 'whatsapp.message.received', version: 1 },
      condition: { path: '/messageId', op: 'exists' },
      mapping: { sender: { $path: '/sender' }, text: { $path: '/text' } },
    } as unknown as CanonicalFullRuleDocument;
    activate(store, whatsappRule);
    store.database
      .prepare("INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, 1, ?, '1')")
      .run(WHATSAPP, 'a'.repeat(64));
    for (const messageId of [hiddenId, shownId])
      store.database
        .prepare(
          `INSERT INTO whatsapp_occurrences (account_id, message_id, first_seen_generation, first_seen_at, visibility_version)
           VALUES (?, ?, 1, 1, 1)`,
        )
        .run(WHATSAPP, messageId);
    seedItem(store, { ruleId: 'rule-whatsapp', accountId: WHATSAPP, channel: 'whatsapp', whatsappMessageId: hiddenId });
    seedItem(store, { ruleId: 'rule-whatsapp', accountId: WHATSAPP, channel: 'whatsapp', whatsappMessageId: shownId });
    const composition = createPhaseDWhatsAppOwnerComposition({
      database: store,
      now: () => NOW,
      eventOperations: {
        withCurrentEventVisibility: async (_input, work) =>
          work({
            version: 1,
            digest: 'b'.repeat(64),
            seesMessage: (chatJid: string) => chatJid !== 'chat-hidden@g.us',
          }),
      },
      createRetainedContentParticipants: createB2RetainedContentParticipants,
    });
    await composition.visibilityFence.withCurrentVisibility({ accountId: WHATSAPP }, () => undefined);
    const remaining = store.database.prepare('SELECT whatsapp_message_id FROM queue_items').all() as Array<{
      whatsapp_message_id: string;
    }>;
    assert.deepEqual(
      remaining.map((row) => row.whatsapp_message_id),
      [shownId],
      'only the newly hidden item is purged',
    );
  });
});

test('QUEUE-A: a queueMs tightening revokes the wider version and its items, and shortens a superseded version’s', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore(async (store) => {
    const superseded = rule({ ruleId: 'rule-tighten', version: 1, queueMs: 20 * DAY });
    const parent = rule({ ruleId: 'rule-tighten', version: 2, queueMs: 20 * DAY });
    const child = rule({ ruleId: 'rule-tighten', version: 3, queueMs: 2 * DAY });
    activate(store, superseded, 'superseded');
    activate(store, parent);
    new ImmutableVersions(store.database).createRule(child);
    const old = seedItem(store, {
      ruleId: 'rule-tighten',
      ruleVersion: 1,
      appendedAt: NOW - DAY,
      retentionMs: 20 * DAY,
    });
    const gone = seedItem(store, {
      ruleId: 'rule-tighten',
      ruleVersion: 1,
      appendedAt: NOW - 3 * DAY,
      retentionMs: 20 * DAY,
    });
    seedItem(store, { ruleId: 'rule-tighten', ruleVersion: 2, retentionMs: 20 * DAY });
    await applyDerivedTightening({
      database: store.database,
      parent,
      child,
      now: NOW,
      decryptPoint: async () => ({ historyId: '1' }),
      encryptPoint: async ({ position }) => Buffer.from(JSON.stringify(position)),
    });
    assert.equal(
      (
        store.database.prepare('SELECT COUNT(*) AS count FROM queue_items WHERE rule_version = 2').get() as {
          count: number;
        }
      ).count,
      0,
      'the revoked version’s items are removed with it (Q6)',
    );
    const shortened = store.database
      .prepare('SELECT retention_ms, expires_at, row_expires_at, encrypted_record FROM queue_items WHERE id = ?')
      .get(old) as { retention_ms: number; expires_at: number; row_expires_at: number; encrypted_record: unknown };
    assert.deepEqual(
      { retention: shortened.retention_ms, expires: shortened.expires_at, row: shortened.row_expires_at },
      { retention: 2 * DAY, expires: NOW - DAY + 2 * DAY, row: NOW - DAY + 4 * DAY },
      'a superseded version’s deadlines are shortened, never lengthened',
    );
    assert.ok(shortened.encrypted_record, 'an item still inside its shorter retention keeps its content');
    const due = store.database
      .prepare('SELECT encrypted_record, expires_at FROM queue_items WHERE id = ?')
      .get(gone) as { encrypted_record: unknown; expires_at: number };
    assert.equal(due.encrypted_record, null, 'an item already past its shorter deadline loses its content at once');
    assert.equal(due.expires_at, NOW - 3 * DAY + 2 * DAY);
  });
});

test('QUEUE-A: a tightening’s preview names the count of open queue items its enablement will remove (Q6)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore(async (store) => {
    const active = rule({ ruleId: 'rule-preview', version: 1, queueMs: 20 * DAY });
    activate(store, active);
    seedItem(store, { ruleId: 'rule-preview', ruleVersion: 1 });
    seedItem(store, { ruleId: 'rule-preview', ruleVersion: 1 });
    seedItem(store, { ruleId: 'rule-preview', ruleVersion: 1, state: 'done' });
    seedItem(store, { ruleId: 'rule-elsewhere' });
    const versions = new ImmutableVersions(store.database);
    const tighter = versions.createRule(rule({ ruleId: 'rule-preview', version: 2, queueMs: 2 * DAY }));
    assert.deepEqual(tighteningPreviewFor(store.database, tighter.document), {
      editKind: 'shorten-retention',
      appliesWhen: 'rule enable',
      openQueueItemsRemoved: 2,
      notice: '2 open queue items under this rule will be removed',
    });
    const looser = versions.createRule(rule({ ruleId: 'rule-preview', version: 3, queueMs: 25 * DAY }));
    assert.equal(tighteningPreviewFor(store.database, looser.document), undefined, 'a loosening waits for approval');
    const first = versions.createRule(rule({ ruleId: 'rule-new', version: 1 }));
    assert.equal(tighteningPreviewFor(store.database, first.document), undefined, 'no active version, no tightening');
    store.database.prepare("UPDATE queue_items SET state = 'dismissed' WHERE rule_id = 'rule-preview'").run();
    assert.deepEqual(tighteningPreviewFor(store.database, tighter.document), {
      editKind: 'shorten-retention',
      appliesWhen: 'rule enable',
      openQueueItemsRemoved: 0,
    });
  });
});
