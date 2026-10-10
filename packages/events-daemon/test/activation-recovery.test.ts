import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, CommsError, ConfigStore, canonicalJson, emptyConfig } from '@agentcomms/core';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { ActivationRuntime, type PreparedActivation } from '../src/runtime/activations.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { GmailReplacementDrains } from '../src/runtime/replacements.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { type GmailSourceRule, GmailSourceWorker } from '../src/sources/source-worker.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const target = { targetId: 'target-1', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const rule = {
  ruleId: 'rule-1',
  version: 1,
  source: {
    channel: 'gmail' as const,
    accountIds: ['ibx_AAAAAAAAAAAAAAAA'],
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

function clock(start = Date.parse('2026-10-08T10:00:00.000Z')) {
  let value = start;
  return { now: () => value, advance: (milliseconds: number) => (value += milliseconds) };
}

async function fixture(
  options: {
    readonly encryptBaseline?: (intentId: string, accountId: string, position: unknown) => Promise<Uint8Array>;
    readonly decryptBaseline?: (intentId: string, accountId: string, stored: Uint8Array) => Promise<unknown>;
    /** Runs inside the baseline's profile call, between the authority check and the baseline write. */
    readonly onProfile?: (store: Awaited<ReturnType<typeof openEventDatabase>>) => void;
    readonly encryptPoint?: (input: {
      readonly activationId: string;
      readonly ruleId: string;
      readonly ruleVersion: number;
      readonly accountId: string;
      readonly position: unknown;
    }) => Promise<Uint8Array>;
    /** Fails selected baseline provider calls after the activation has durably claimed its approval. */
    readonly failProfileCalls?: readonly number[];
  } = {},
) {
  const root = await shortTempDir('events-act-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes['events/gmail'] = {
    id: 'ibx_AAAAAAAAAAAAAAAA',
    provider: 'gmail',
    email: 'events@example.test',
    identity: 'oidc',
    client: 'client-1',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: 'gmail:none:ibx_AAAAAAAAAAAAAAAA',
    internalDomains: [],
    createdAt: '2026-10-08T10:00:00.000Z',
  };
  config.inboxes['events/gmail-secondary'] = {
    ...config.inboxes['events/gmail'],
    id: 'ibx_BBBBBBBBBBBBBBBB',
    email: 'events-secondary@example.test',
    secretRef: 'gmail:none:ibx_BBBBBBBBBBBBBBBB',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const time = clock();
  const store = await openEventDatabase({ stateDir });
  const configStore = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), {
    now: () => new Date(time.now()),
    loadConfig: () => configStore.load(),
  });
  let profileCalls = 0;
  let intentOrdinal = 0;
  const mailboxLock = new MailboxLock();
  const runtime = new ActivationRuntime({
    store,
    approvals,
    config: configStore,
    now: time.now,
    newIntentId: () =>
      intentOrdinal++ === 0 ? 'act_01HZZZZZZZZZZZZZZZZZZZZZZZ' : `act_02HZZZZZZZZZZZZZZZZZZZZZZ${intentOrdinal}`,
    gmailSourceFor: async () => ({
      getProfile: async () => {
        profileCalls += 1;
        options.onProfile?.(store);
        if (options.failProfileCalls?.includes(profileCalls)) throw new Error(`profile failure ${profileCalls}`);
        return { emailAddress: 'events@example.test', messagesTotal: 1, threadsTotal: 1, historyId: '202' };
      },
      listHistory: async () => {
        throw new Error('activation baselines must not scan history');
      },
      getMessageMetadata: async () => {
        throw new Error('activation baselines must not read message metadata');
      },
    }),
    encryptBaseline:
      options.encryptBaseline ?? (async (_intentId, _accountId, position) => Buffer.from(JSON.stringify(position))),
    decryptBaseline:
      options.decryptBaseline ??
      (async (_intentId, _accountId, stored) => JSON.parse(Buffer.from(stored).toString('utf8'))),
    encryptPoint: options.encryptPoint ?? (async (_input) => Buffer.from(JSON.stringify(_input.position))),
    decryptPoint: async ({ stored }) => JSON.parse(Buffer.from(stored).toString('utf8')),
    mailboxLock,
  });
  return { root, store, approvals, configStore, runtime, time, mailboxLock, profileCalls: () => profileCalls };
}

test('APR-B1: first Gmail activation creates and claims authority before one profile baseline and one pointer commit', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);

    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    assert.equal(setup.profileCalls(), 0, 'preparing does not call a provider before authority is used');
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    const complete = await setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge });

    assert.equal(complete.status, 'completed');
    assert.equal(setup.profileCalls(), 1, 'one Gmail profile baseline is sampled after claim');
    const intent = setup.store.database
      .prepare('SELECT status, claimed_at, completion_deadline FROM activation_intents WHERE id = ?')
      .get(prepared.intentId) as { status: string; claimed_at: number; completion_deadline: number };
    assert.equal(intent.status, 'completed');
    assert.equal(intent.claimed_at, Date.parse(complete.usedAt));
    assert.equal(intent.completion_deadline, Date.parse(complete.usedAt) + 3_600_000);
    assert.deepEqual(versions.activeVersion('rule', rule.ruleId), { version: 1, currentCutoverId: prepared.intentId });
    const point = setup.store.database
      .prepare('SELECT encrypted_position FROM rule_activation_points WHERE activation_id = ?')
      .get(prepared.intentId) as { encrypted_position: Uint8Array } | undefined;
    assert.ok(point, 'finalisation writes an immutable per-rule point');
    assert.equal(Buffer.from(point.encrypted_position).toString('utf8'), '{"historyId":"202"}');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('P1-B1: an activation decrypts its baseline and re-encrypts the rule point for its destination row', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({
    encryptBaseline: async (_intentId, _accountId, position) => Buffer.from(`baseline:${JSON.stringify(position)}`),
    decryptBaseline: async (_intentId, _accountId, stored) =>
      JSON.parse(Buffer.from(stored).toString('utf8').replace('baseline:', '')) as { readonly historyId: string },
    encryptPoint: async ({ activationId, ruleId, ruleVersion, accountId, position }) =>
      Buffer.from(`point:${activationId}:${ruleId}:${ruleVersion}:${accountId}:${JSON.stringify(position)}`),
  });
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    const answer = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.runtime.approve({ approvalId: prepared.approvalId, answer });
    const point = setup.store.database
      .prepare('SELECT encrypted_position FROM rule_activation_points WHERE activation_id = ?')
      .get(prepared.intentId) as { encrypted_position: Uint8Array };
    assert.equal(
      Buffer.from(point.encrypted_position).toString('utf8'),
      `point:${prepared.intentId}:rule-1:1:ibx_AAAAAAAAAAAAAAAA:{"historyId":"202"}`,
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('P1-B1: one enabled scheduler tick polls an active Gmail rule, evaluates it, and dispatches its queued delivery', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    const answer = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.runtime.approve({ approvalId: prepared.approvalId, answer });
    setup.store.database.prepare('UPDATE event_settings SET enabled = 1').run();

    const dispatched: string[] = [];
    const cipher = {
      encrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
      decrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
    };
    const scheduler = new EventScheduler({
      store: setup.store,
      lifecycle: new EventLifecycle(setup.store),
      activations: setup.runtime,
      dispatcher: {
        recoverLeases: async () => undefined,
        dispatch: async (deliveryId: string) => {
          dispatched.push(deliveryId);
          return { state: 'delivered' as const, deliveryId };
        },
      } as never,
      expiry: new EventExpiry(setup.store, setup.time.now),
      cipher: cipher as never,
      approvals: setup.approvals,
      config: setup.configStore,
      taint: { record: async () => undefined } as never,
      gmailSourceFor: async () =>
        ({
          getProfile: async () => ({
            emailAddress: 'events@example.test',
            messagesTotal: 1,
            threadsTotal: 1,
            historyId: '202',
          }),
          listHistory: async () => ({
            historyId: '203',
            nextPageToken: undefined,
            history: [
              {
                id: '203',
                messagesAdded: [{ message: { id: 'message-203', threadId: 'thread-203' } }],
                labelsAdded: [],
                labelsRemoved: [],
              },
            ],
          }),
          getMessageMetadata: async () => ({
            id: 'message-203',
            threadId: 'thread-203',
            labelIds: ['INBOX'],
            internalDate: '1760000000000',
            payload: { headers: [{ name: 'Subject', value: 'scheduled' }] },
          }),
        }) as never,
      mailboxLock: setup.mailboxLock,
      now: setup.time.now,
    });

    await scheduler.tick();
    const queued = setup.store.database.prepare('SELECT id FROM deliveries').get() as { id: string } | undefined;
    assert.ok(queued, 'the scheduler evaluates the acquired occurrence into a local delivery');
    assert.deepEqual(dispatched, [queued.id], 'the same tick dispatches due queued local delivery work');
    assert.equal(
      (setup.store.database.prepare("SELECT cursor FROM cursors WHERE source = 'gmail'").get() as { cursor: string })
        .cursor,
      '203',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a first activation voids before claim if another pointer appears after preparation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    setup.store.database
      .prepare(
        "UPDATE rule_versions SET state = 'active', approval_id = 'ap_other', authorization_activation_id = 'act_other', activated_at = 1 WHERE rule_id = ? AND version = ?",
      )
      .run(rule.ruleId, rule.version);
    setup.store.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, ?, 'act_other', 1)",
      )
      .run(rule.ruleId, rule.version);

    await assert.rejects(
      () => setup.runtime.issueChallenge(prepared.approvalId),
      (error: unknown) => (error as { code?: string }).code === 'APPROVAL_VOID',
    );
    assert.equal(setup.profileCalls(), 0);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: an exact Gmail replacement fixes its old pointer and union scope before the disclosure claim', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    const oldRule = {
      ...rule,
      source: {
        ...rule.source,
        accountIds: ['ibx_AAAAAAAAAAAAAAAA', 'ibx_BBBBBBBBBBBBBBBB'],
      },
    };
    versions.createRule(oldRule);
    versions.createRule({ ...rule, version: 2, mapping: { constant: 'safer' } });
    const original = (await setup.runtime.prepareRule({ ruleId: 'rule-1', version: 1 })) as PreparedActivation;
    const originalChallenge = await setup.runtime.issueChallenge(original.approvalId);
    await setup.runtime.approve({ approvalId: original.approvalId, answer: originalChallenge });

    // An enabled replacement drains its old version through P; a disabled one is drained at P at once (D4).
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    const prepared = (await setup.runtime.prepareRule({ ruleId: 'rule-1', version: 2 })) as PreparedActivation;
    assert.equal(prepared.replacementOfVersion, 'rule-1@1');
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare('SELECT replacement_of_version, required_points FROM activation_intents WHERE id = ?')
          .get(prepared.intentId) as Record<string, unknown>),
      },
      {
        replacement_of_version: 'rule-1@1',
        required_points: canonicalJson([
          {
            ruleId: 'rule-1',
            ruleVersion: 1,
            accountId: 'ibx_AAAAAAAAAAAAAAAA',
            source: 'gmail',
            positionScope: 'mailbox',
          },
          {
            ruleId: 'rule-1',
            ruleVersion: 1,
            accountId: 'ibx_BBBBBBBBBBBBBBBB',
            source: 'gmail',
            positionScope: 'mailbox',
          },
          {
            ruleId: 'rule-1',
            ruleVersion: 2,
            accountId: 'ibx_AAAAAAAAAAAAAAAA',
            source: 'gmail',
            positionScope: 'mailbox',
          },
        ]),
      },
      'the replacement plan is immutable before a person can approve it',
    );
    const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    assert.deepEqual(
      setup.store.database
        .prepare('SELECT account_id FROM activation_baselines WHERE intent_id = ? ORDER BY account_id')
        .all(prepared.intentId)
        .map((row) => (row as { account_id: string }).account_id),
      ['ibx_AAAAAAAAAAAAAAAA', 'ibx_BBBBBBBBBBBBBBBB'],
      'the immutable union plan, rather than a post-claim re-plan, owns every replacement P',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('P1-B1: the next owner tick resumes a claimed replacement after the real mailbox worker drains P', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    versions.createRule({ ...rule, version: 2, mapping: { constant: 'safer' } });
    setup.store.database.exec(
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_old', authorization_activation_id = 'act_old', activated_at = 1 WHERE id = 'rule-1@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-1', 1, 'act_old', 1); INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_AAAAAAAAAAAAAAAA', 'mailbox', '201', 1)",
    );
    // A real activation always leaves its cut-over point; an active version without one admits nothing.
    setup.store.database
      .prepare(
        "INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at) VALUES ('act_old', 'rule-1', 1, 'gmail', 'ibx_AAAAAAAAAAAAAAAA', 'mailbox', ?, 1)",
      )
      .run(Buffer.from(JSON.stringify({ historyId: '200' })));
    // An enabled replacement drains its old version through P; a disabled one is drained at P at once (D4).
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    const prepared = (await setup.runtime.prepareRule({ ruleId: 'rule-1', version: 2 })) as PreparedActivation;
    const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    assert.deepEqual(versions.activeVersion('rule', 'rule-1'), { version: 1, currentCutoverId: 'act_old' });
    assert.equal(setup.profileCalls(), 1, 'P is persisted by the claimed activation before the worker drains it');

    let activeVersion = 1;
    const rules = (): readonly GmailSourceRule[] => [
      {
        ruleId: 'rule-1',
        ruleVersion: activeVersion,
        eventType: 'gmail.message.received',
        options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
        ingestRetentionMs: rule.retention.ingestMs,
      },
    ];
    const admitted: string[] = [];
    const worker = new GmailSourceWorker({
      store: setup.store,
      source: {
        async listHistory({ historyId }: { readonly historyId: string }) {
          const id = historyId === '201' ? '202' : '203';
          return {
            historyId: id,
            nextPageToken: undefined,
            history: [
              {
                id,
                messagesAdded: [{ message: { id: `message-${id}`, threadId: 'thread-1' } }],
                labelsAdded: [],
                labelsRemoved: [],
              },
            ],
          };
        },
        async getMessageMetadata(messageId: string) {
          return {
            id: messageId,
            threadId: 'thread-1',
            labelIds: ['INBOX'],
            internalDate: '1760000000000',
            payload: { headers: [{ name: 'Subject', value: 'subject' }] },
          };
        },
      },
      mailbox: { accountId: 'ibx_AAAAAAAAAAAAAAAA', name: 'Events inbox' },
      mailboxLock: setup.mailboxLock,
      rules,
      assertDisclosable: async () => undefined,
      admit: async (occurrence) => {
        admitted.push(`${occurrence.rule.ruleVersion}:${String(occurrence.event.messageId)}`);
        return 'terminal';
      },
      encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      replacementDrains: new GmailReplacementDrains({
        database: setup.store.database,
        decryptPosition: async ({ record }) => JSON.parse(Buffer.from(record).toString('utf8')),
        now: setup.time.now,
      }),
    });

    assert.deepEqual(await worker.scan(), { cursor: '202', pending: false });
    assert.deepEqual(admitted, ['1:message-202'], 'the old version owns P inclusively');
    assert.deepEqual(await worker.scan(), { cursor: '202', pending: true });
    assert.deepEqual(admitted, ['1:message-202'], 'post-P work remains encrypted in its stage before the swap');
    const scheduler = new EventScheduler({
      store: setup.store,
      lifecycle: new EventLifecycle(setup.store),
      activations: setup.runtime,
      dispatcher: {} as never,
      expiry: new EventExpiry(setup.store),
      cipher: {} as never,
      approvals: setup.approvals,
      config: setup.configStore,
      taint: {} as never,
      gmailSourceFor: async () => {
        throw new Error('a disabled scheduler must not start a source poll');
      },
      mailboxLock: setup.mailboxLock,
      now: setup.time.now,
    });
    await scheduler.tick();
    assert.deepEqual(versions.activeVersion('rule', 'rule-1'), {
      version: 2,
      currentCutoverId: prepared.intentId,
    });

    activeVersion = 2;
    assert.deepEqual(await worker.scan(), { cursor: '203', pending: false });
    assert.deepEqual(admitted, ['1:message-202', '2:message-203']);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: only one exact replacement may drain, and its one-hour failure leaves the old pointer effective', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    versions.createRule({ ...rule, version: 2, mapping: { constant: 'safer' } });
    versions.createRule({ ...rule, version: 3, mapping: { constant: 'safest' } });
    setup.store.database.exec(
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_old', authorization_activation_id = 'act_old', activated_at = 1 WHERE id = 'rule-1@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-1', 1, 'act_old', 1); INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at) VALUES ('act_old', 'rule-1', 1, 'gmail', 'ibx_AAAAAAAAAAAAAAAA', 'mailbox', CAST('{\"historyId\":\"100\"}' AS BLOB), 1)",
    );
    // An enabled replacement drains its old version through P; a disabled one is drained at P at once (D4).
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    const first = (await setup.runtime.prepareRule({ ruleId: 'rule-1', version: 2 })) as PreparedActivation;
    await assert.rejects(
      () => setup.runtime.prepareRule({ ruleId: 'rule-1', version: 3 }),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_PENDING',
    );
    const challenge = await setup.runtime.issueChallenge(first.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: first.approvalId, answer: challenge }),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    setup.time.advance(3_600_001);
    await setup.runtime.recover();
    assert.deepEqual(versions.activeVersion('rule', 'rule-1'), { version: 1, currentCutoverId: 'act_old' });
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
          .get(first.intentId) as Record<string, unknown>),
      },
      { status: 'failed', failure_code: 'COMPLETION_TIMEOUT' },
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a revocation cancels a draining replacement before it can move its old pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    versions.createRule({ ...rule, version: 2, mapping: { constant: 'safer' } });
    setup.store.database.exec(
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_old', authorization_activation_id = 'act_old', activated_at = 1 WHERE id = 'rule-1@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-1', 1, 'act_old', 1); INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at) VALUES ('act_old', 'rule-1', 1, 'gmail', 'ibx_AAAAAAAAAAAAAAAA', 'mailbox', CAST('{\"historyId\":\"100\"}' AS BLOB), 1)",
    );
    // An enabled replacement drains its old version through P; a disabled one is drained at P at once (D4).
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    const prepared = (await setup.runtime.prepareRule({ ruleId: 'rule-1', version: 2 })) as PreparedActivation;
    const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );

    await setup.runtime.cancelForRevocation({ ruleId: 'rule-1' });
    await setup.runtime.recover();

    assert.deepEqual(versions.activeVersion('rule', 'rule-1'), { version: 1, currentCutoverId: 'act_old' });
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
          .get(prepared.intentId) as Record<string, unknown>),
      },
      { status: 'cancelled', failure_code: 'AUTHORIZATION_REVOKED' },
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: recovery uses the original core usedAt and fails an expired completion before another provider call', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.approvals.approveDisclosure(prepared.approvalId, prepared.binding, challenge, 'terminal');
    const used = await setup.approvals.claimForDisclosure(prepared.approvalId, prepared.binding);
    assert.ok(used.usedAt);
    setup.time.advance(3_600_001);

    await setup.runtime.recover();

    const intent = setup.store.database
      .prepare('SELECT status, claimed_at, completion_deadline, failure_code FROM activation_intents WHERE id = ?')
      .get(prepared.intentId) as {
      status: string;
      claimed_at: number;
      completion_deadline: number;
      failure_code: string;
    };
    assert.equal(intent.status, 'failed');
    assert.equal(intent.claimed_at, Date.parse(used.usedAt));
    assert.equal(intent.completion_deadline, Date.parse(used.usedAt) + 3_600_000);
    assert.equal(intent.failure_code, 'COMPLETION_TIMEOUT');
    assert.equal(setup.profileCalls(), 0, 'recovery does not call Gmail after the one-hour completion deadline');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: recovery claims a terminal-approved disclosure left between approval and claim', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.approvals.approveDisclosure(prepared.approvalId, prepared.binding, challenge, 'terminal');

    await setup.runtime.recover();

    const intent = setup.store.database
      .prepare('SELECT status FROM activation_intents WHERE id = ?')
      .get(prepared.intentId) as { status: string };
    assert.equal(intent.status, 'completed');
    assert.equal(setup.profileCalls(), 1);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a target revocation cancels its claimed completion before it can take a baseline or install a pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.approvals.approveDisclosure(prepared.approvalId, prepared.binding, challenge, 'terminal');
    await setup.approvals.claimForDisclosure(prepared.approvalId, prepared.binding);
    await setup.runtime.cancelForRevocation({ targetId: target.targetId });

    await setup.runtime.recover();

    const intent = setup.store.database
      .prepare('SELECT status FROM activation_intents WHERE id = ?')
      .get(prepared.intentId) as { status: string };
    assert.equal(intent.status, 'cancelled');
    assert.equal(setup.profileCalls(), 0);
    assert.equal(versions.activeVersion('rule', rule.ruleId), null);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a non-revoking pointer mutation is fenced while a used intent is completing', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.approvals.approveDisclosure(prepared.approvalId, prepared.binding, challenge, 'terminal');
    const used = await setup.approvals.claimForDisclosure(prepared.approvalId, prepared.binding);
    assert.ok(used.usedAt);
    setup.store.database
      .prepare("UPDATE activation_intents SET status = 'pending-completion', claimed_at = ? WHERE id = ?")
      .run(Date.parse(used.usedAt), prepared.intentId);

    await assert.rejects(
      () => setup.runtime.assertNoCompletingMutation(),
      (error: unknown) =>
        (error as { code?: string; details?: { reason?: string } }).code === 'TRANSIENT' &&
        (error as { details?: { reason?: string } }).details?.reason === 'ACTIVATION_COMPLETING',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('P1-B1: a mailbox cursor starts at the oldest active point, and each rule admits only what follows its own', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    const second = { ...rule, ruleId: 'rule-2' };
    versions.createRule(rule);
    versions.createRule(second);
    for (const each of [rule, second]) {
      const prepared = (await setup.runtime.prepareRule({
        ruleId: each.ruleId,
        version: each.version,
      })) as PreparedActivation;
      const answer = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
      await setup.runtime.approve({ approvalId: prepared.approvalId, answer });
    }
    // rule-1 was activated at history 202, rule-2 later at 210 (this fixture's cipher is a plaintext stand-in).
    setup.store.database
      .prepare("UPDATE rule_activation_points SET encrypted_position = ? WHERE rule_id = 'rule-2'")
      .run(Buffer.from(JSON.stringify({ historyId: '210' })));
    setup.store.database.prepare('UPDATE event_settings SET enabled = 1').run();
    const listed: string[] = [];
    const admitted: string[] = [];
    const plain = {
      encrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
      decrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
    };
    const added = (id: string) => ({
      id,
      messagesAdded: [{ message: { id: `message-${id}`, threadId: 'thread' } }],
      labelsAdded: [],
      labelsRemoved: [],
    });
    const scheduler = new EventScheduler({
      store: setup.store,
      lifecycle: new EventLifecycle(setup.store),
      activations: setup.runtime,
      dispatcher: {
        recoverLeases: async () => undefined,
        dispatch: async (id: string) => ({ state: 'delivered' as const, deliveryId: id }),
      } as never,
      expiry: new EventExpiry(setup.store, setup.time.now),
      cipher: plain as never,
      approvals: setup.approvals,
      config: setup.configStore,
      taint: { record: async () => undefined } as never,
      gmailSourceFor: async () =>
        ({
          getProfile: async () => ({
            emailAddress: 'events@example.test',
            messagesTotal: 1,
            threadsTotal: 1,
            historyId: '220',
          }),
          listHistory: async ({ historyId }: { historyId: string }) => {
            listed.push(historyId);
            return { historyId: '215', nextPageToken: undefined, history: [added('205'), added('215')] };
          },
          getMessageMetadata: async (id: string) => ({
            id,
            threadId: 'thread',
            labelIds: ['INBOX'],
            internalDate: '1760000000000',
            payload: { headers: [{ name: 'Subject', value: 'seeded' }] },
          }),
        }) as never,
      mailboxLock: setup.mailboxLock,
      now: setup.time.now,
    });
    await scheduler.tick();
    assert.deepEqual(listed, ['202'], 'the cursor starts at the oldest active point, never a later one');
    for (const row of setup.store.database
      .prepare('SELECT d.rule_id, i.dedupe_key FROM decisions d JOIN ingest i ON i.event_id = d.event_id ORDER BY 1, 2')
      .all() as Array<{ rule_id: string; dedupe_key: string }>)
      admitted.push(`${row.rule_id}:${row.dedupe_key}`);
    assert.equal(admitted.filter((entry) => entry.startsWith('rule-1:')).length, 2, 'rule-1 admits 205 and 215');
    assert.equal(
      admitted.filter((entry) => entry.startsWith('rule-2:')).length,
      1,
      'rule-2 admits only 215, after its point',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: no rule-pointer mutation may move a pointer a claimed completion binds, and a drifted completion settles', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    versions.createRule({ ...rule, version: 2, mapping: { constant: 'safer' } });
    versions.createRule({ ...rule, version: 3, deliveryRateCap: 30 });
    setup.store.database.exec(
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_old', authorization_activation_id = 'act_old', activated_at = 1 WHERE id = 'rule-1@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-1', 1, 'act_old', 1); INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_AAAAAAAAAAAAAAAA', 'mailbox', '201', 1)",
    );
    setup.store.database
      .prepare(
        "INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at) VALUES ('act_old', 'rule-1', 1, 'gmail', 'ibx_AAAAAAAAAAAAAAAA', 'mailbox', ?, 1)",
      )
      .run(Buffer.from(JSON.stringify({ historyId: '200' })));
    // An exact replacement (v2) is claimed and left draining.
    // An enabled replacement drains its old version through P; a disabled one is drained at P at once (D4).
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    const replacement = (await setup.runtime.prepareRule({ ruleId: 'rule-1', version: 2 })) as PreparedActivation;
    const challenge = await setup.runtime.issueChallenge(replacement.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: replacement.approvalId, answer: challenge }),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    // A whitelisted tightening (v3, lower cap) would swap the pointer under the drain: refused.
    await assert.rejects(
      () => setup.runtime.prepareRule({ ruleId: 'rule-1', version: 3 }),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'ACTIVATION_COMPLETING',
    );
    assert.deepEqual(versions.activeVersion('rule', 'rule-1'), { version: 1, currentCutoverId: 'act_old' });

    // Had a stray mutation moved the pointer anyway, the completion settles instead of throwing on every tick and at startup.
    setup.store.database.exec(
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_old', authorization_activation_id = 'rule-1@3', activated_at = 2 WHERE id = 'rule-1@3'; UPDATE active_versions SET version = 3, current_cutover_id = 'rule-1@3' WHERE object_id = 'rule-1'",
    );
    await setup.runtime.resumeClaimedCompletions();
    const settled = setup.store.database
      .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
      .get(replacement.intentId) as { status: string; failure_code: string };
    assert.deepEqual({ ...settled }, { status: 'cancelled', failure_code: 'APPROVAL_BINDING_DRIFT' });
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM replacement_drains').get() as { count: number })
        .count,
      0,
      'its drain no longer holds the mailbox',
    );
    await setup.runtime.recover();
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a baseline that returns after a disable-all cancelled its activation recreates no baseline or drain', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({
    onProfile: (store) => void new EventLifecycle(store).disableAll(),
  });
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    const answer = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await assert.rejects(() => setup.runtime.approve({ approvalId: prepared.approvalId, answer }));
    const count = (table: string) =>
      (setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    assert.equal(count('activation_baselines'), 0, 'the purged baseline is not recreated');
    assert.equal(count('replacement_drains'), 0);
    assert.equal(versions.activeVersion('rule', rule.ruleId), null, 'and no pointer is installed');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

/** Removes the primary events mailbox from core's configuration on disk, as `inbox remove` would. */
async function removeAccount(root: string): Promise<void> {
  const path = join(root, 'config', 'config.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as { inboxes: Record<string, unknown> };
  delete config.inboxes['events/gmail'];
  await writeFile(path, `${JSON.stringify(config)}\n`);
}

test('APR-B1: an account removed from the configuration during the baseline or the point encryption installs nothing (D9)', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const stage of ['baseline', 'point'] as const) {
    let root = '';
    let pointEncrypts = 0;
    const setup = await fixture(
      stage === 'baseline'
        ? {
            encryptBaseline: async (_intentId, _accountId, position) => {
              await removeAccount(root);
              return Buffer.from(JSON.stringify(position));
            },
            encryptPoint: async (input) => {
              pointEncrypts += 1;
              return Buffer.from(JSON.stringify(input.position));
            },
          }
        : {
            encryptPoint: async (input) => {
              await removeAccount(root);
              return Buffer.from(JSON.stringify(input.position));
            },
          },
    );
    root = setup.root;
    try {
      const versions = new ImmutableVersions(setup.store.database);
      versions.createTarget(target);
      versions.createRule(rule);
      const prepared = (await setup.runtime.prepareRule({
        ruleId: rule.ruleId,
        version: rule.version,
      })) as PreparedActivation;
      const answer = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
      await assert.rejects(
        () => setup.runtime.approve({ approvalId: prepared.approvalId, answer }),
        (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
        `${stage}: the removal refuses the activation`,
      );
      const count = (table: string) =>
        (setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      assert.equal(count('activation_baselines'), 0, `${stage}: no baseline is kept for a removed account`);
      assert.equal(count('rule_activation_points'), 0, `${stage}: no activation point is installed`);
      assert.equal(count('cursors'), 0, `${stage}: no cursor is installed`);
      assert.equal(versions.activeVersion('rule', rule.ruleId), null, `${stage}: and no pointer`);
      assert.equal(
        (
          setup.store.database.prepare('SELECT status FROM activation_intents WHERE id = ?').get(prepared.intentId) as {
            status: string;
          }
        ).status,
        'cancelled',
        `${stage}: the intent is cancelled, never retried`,
      );
      assert.equal(count('account_revocations'), 1, `${stage}: the removal is recorded`);
      if (stage === 'baseline') assert.equal(pointEncrypts, 0, 'the baseline refuses before any point is prepared');
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});

test('P1-B1: an account removed from the configuration while its activation point decrypts gets no initial cursor (D9)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    const answer = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.runtime.approve({ approvalId: prepared.approvalId, answer });
    setup.store.database.prepare('UPDATE event_settings SET enabled = 1').run();
    let removed = false;
    let sources = 0;
    const scheduler = new EventScheduler({
      store: setup.store,
      lifecycle: new EventLifecycle(setup.store),
      activations: setup.runtime,
      dispatcher: { recoverLeases: async () => undefined, dispatch: async () => undefined } as never,
      expiry: new EventExpiry(setup.store, setup.time.now),
      cipher: {
        encrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
        decrypt: async (_location: unknown, value: Uint8Array) => {
          if (!removed) {
            removed = true;
            await removeAccount(setup.root);
          }
          return Buffer.from(value);
        },
      } as never,
      approvals: setup.approvals,
      config: setup.configStore,
      taint: { record: async () => undefined } as never,
      gmailSourceFor: async () => {
        sources += 1;
        throw new Error('a removed account must not reach its provider');
      },
      mailboxLock: setup.mailboxLock,
      now: setup.time.now,
    });
    await scheduler.tick();
    const count = (table: string) =>
      (setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    assert.equal(removed, true, 'the point was decrypted');
    assert.equal(count('cursors'), 0, 'no cursor is installed for the removed account');
    assert.equal(sources, 0, 'and its provider is never opened');
    assert.equal(count('account_revocations'), 1, 'the removal is recorded');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

const A = 'ibx_AAAAAAAAAAAAAAAA';
const B = 'ibx_BBBBBBBBBBBBBBBB';
const multi = { ...rule, ruleId: 'rule-multi', source: { ...rule.source, accountIds: [A, B] } };

/** Adds the primary events mailbox back with the same stable id, as a person re-adding it would. */
async function readdAccount(root: string, inbox: unknown): Promise<void> {
  const path = join(root, 'config', 'config.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as { inboxes: Record<string, unknown> };
  config.inboxes['events/gmail'] = inbox;
  await writeFile(path, `${JSON.stringify(config)}\n`);
}

async function primaryInbox(root: string): Promise<unknown> {
  const config = JSON.parse(await readFile(join(root, 'config', 'config.json'), 'utf8')) as {
    inboxes: Record<string, unknown>;
  };
  return config.inboxes['events/gmail'];
}

/** Activates the two-account rule through the real approval path, then removes A and lets one tick purge it. */
async function multiWithARemoved(setup: Awaited<ReturnType<typeof fixture>>, sources: string[]) {
  const versions = new ImmutableVersions(setup.store.database);
  versions.createTarget(target);
  versions.createRule(multi);
  const prepared = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 1 })) as PreparedActivation;
  await setup.runtime.approve({
    approvalId: prepared.approvalId,
    answer: await setup.approvals.issueDisclosureChallenge(prepared.approvalId),
  });
  const inbox = await primaryInbox(setup.root);
  await removeAccount(setup.root);
  const scheduler = new EventScheduler({
    store: setup.store,
    lifecycle: new EventLifecycle(setup.store),
    activations: setup.runtime,
    dispatcher: { recoverLeases: async () => undefined, dispatch: async () => undefined } as never,
    expiry: new EventExpiry(setup.store, setup.time.now),
    cipher: {
      encrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
      decrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
    } as never,
    approvals: setup.approvals,
    config: setup.configStore,
    taint: { record: async () => undefined } as never,
    gmailSourceFor: async (accountId: string) => {
      sources.push(accountId);
      return {
        getProfile: async () => ({
          emailAddress: 'x@example.test',
          messagesTotal: 1,
          threadsTotal: 1,
          historyId: '300',
        }),
        listHistory: async () => ({ historyId: '300', nextPageToken: undefined, history: [] }),
        getMessageMetadata: async () => {
          throw new Error('no metadata read is expected');
        },
      } as never;
    },
    mailboxLock: setup.mailboxLock,
    now: setup.time.now,
  });
  await scheduler.tick();
  return { versions, inbox, scheduler };
}

const count = (setup: Awaited<ReturnType<typeof fixture>>, sql: string, ...values: unknown[]) =>
  (
    setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${sql}`).get(...(values as string[])) as {
      count: number;
    }
  ).count;

test('P1/K6: removing a planned account cancels a used completion before recovery, resume, or a scheduler turn can revive it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const cases = [
    { name: 'first activation recovery', kind: 'first' as const, resume: 'recover' as const, failsAt: 1 },
    { name: 'multi-account replacement resume', kind: 'replacement' as const, resume: 'claimed' as const, failsAt: 3 },
    { name: 'enable-all scheduler turn', kind: 'enable-all' as const, resume: 'scheduler' as const, failsAt: 3 },
  ];
  for (const entry of cases) {
    const setup = await fixture({ failProfileCalls: [entry.failsAt] });
    try {
      const versions = new ImmutableVersions(setup.store.database);
      versions.createTarget(target);
      let planned: PreparedActivation;
      if (entry.kind === 'first') {
        versions.createRule(rule);
        planned = (await setup.runtime.prepareRule({
          ruleId: rule.ruleId,
          version: rule.version,
        })) as PreparedActivation;
      } else {
        versions.createRule(multi);
        const original = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 1 })) as PreparedActivation;
        await setup.runtime.approve({
          approvalId: original.approvalId,
          answer: await setup.approvals.issueDisclosureChallenge(original.approvalId),
        });
        if (entry.kind === 'replacement') {
          setup.store.database.prepare('UPDATE event_settings SET enabled = 1').run();
          versions.createRule({ ...multi, version: 2, mapping: { constant: 'new cut-over' } });
          planned = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 2 })) as PreparedActivation;
        } else {
          planned = await setup.runtime.prepareEnableAll();
        }
      }
      const answer = await setup.approvals.issueDisclosureChallenge(planned.approvalId);
      await assert.rejects(
        () => setup.runtime.approve({ approvalId: planned.approvalId, answer }),
        /profile failure/u,
        `${entry.name}: the claimed baseline remains recoverable until account removal`,
      );
      assert.equal(
        (
          setup.store.database.prepare('SELECT status FROM activation_intents WHERE id = ?').get(planned.intentId) as {
            status: string;
          }
        ).status,
        'pending-completion',
        `${entry.name}: the approval is used and its completion is pending`,
      );

      const configPath = join(setup.root, 'config', 'config.json');
      const beforeRemoval = JSON.parse(await readFile(configPath, 'utf8')) as { inboxes: Record<string, unknown> };
      const inbox = beforeRemoval.inboxes['events/gmail'];
      await removeAccount(setup.root);
      setup.store.immediate(() =>
        purgeRemovedAccountWork(setup.store.database, { source: 'gmail', accountId: A }, setup.time.now()),
      );
      assert.deepEqual(
        {
          ...(setup.store.database
            .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
            .get(planned.intentId) as Record<string, unknown>),
        },
        { status: 'cancelled', failure_code: 'ACCOUNT_REMOVED' },
        `${entry.name}: removal cancels its planned completion in the purge transaction`,
      );
      await readdAccount(setup.root, inbox);
      setup.time.advance(60_000);

      if (entry.resume === 'recover') await setup.runtime.recover();
      else if (entry.resume === 'claimed') await setup.runtime.resumeClaimedCompletions();
      else await stubScheduler(setup, []).tick();

      assert.deepEqual(
        {
          ...(setup.store.database
            .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
            .get(planned.intentId) as Record<string, unknown>),
        },
        { status: 'cancelled', failure_code: 'ACCOUNT_REMOVED' },
        `${entry.name}: a re-add cannot revive work approved before removal`,
      );
      assert.equal(
        count(setup, 'activation_baselines WHERE intent_id = ?', planned.intentId),
        0,
        `${entry.name}: cancellation drops its baseline`,
      );
      assert.equal(
        count(setup, 'replacement_drains WHERE intent_id = ?', planned.intentId),
        0,
        `${entry.name}: cancellation drops its drain`,
      );
      assert.equal(
        count(setup, 'rule_activation_points WHERE activation_id = ?', planned.intentId),
        0,
        `${entry.name}: no new cut-over point is installed`,
      );
      assert.equal(
        setup.profileCalls(),
        entry.failsAt,
        `${entry.name}: no later provider call reaches the re-added id`,
      );
      if (entry.kind === 'first')
        assert.equal(versions.activeVersion('rule', rule.ruleId), null, 'the first activation never gains a pointer');
      else
        assert.equal(
          versions.activeVersion('rule', multi.ruleId)?.version,
          1,
          `${entry.name}: no replacement or global re-enable changes the active version`,
        );
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});

test('P1: a later account revocation refuses a claimed completion even after that stable id is configured again', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({ failProfileCalls: [1] });
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const planned = (await setup.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    const answer = await setup.approvals.issueDisclosureChallenge(planned.approvalId);
    await assert.rejects(() => setup.runtime.approve({ approvalId: planned.approvalId, answer }), /profile failure 1/u);
    setup.store.immediate(() => {
      setup.store.database
        .prepare('INSERT INTO account_revocations (account_id, revoked_at) VALUES (?, ?)')
        .run(A, setup.time.now());
    });
    setup.time.advance(60_000);
    await setup.runtime.resumeClaimedCompletions();
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
          .get(planned.intentId) as Record<string, unknown>),
      },
      { status: 'cancelled', failure_code: 'ACCOUNT_REMOVED' },
    );
    assert.equal(setup.profileCalls(), 1, 'the revocation is checked before another provider boundary');
    assert.equal(versions.activeVersion('rule', rule.ruleId), null);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('K6: an account re-added after its removal stays dark for a multi-account version until an approval re-samples it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const sources: string[] = [];
    const { versions, inbox, scheduler } = await multiWithARemoved(setup, sources);
    assert.equal(versions.activeVersion('rule', multi.ruleId)?.version, 1, 'the version stays live for B (D9)');
    assert.equal(count(setup, 'rule_activation_points WHERE account_id = ?', A), 0, "A's cut-over is purged");
    assert.equal(count(setup, 'rule_activation_points WHERE account_id = ?', B), 1, "B's is kept");

    await readdAccount(setup.root, inbox);
    setup.store.database.prepare('UPDATE event_settings SET enabled = 1').run();
    sources.length = 0;
    setup.time.advance(120_000);
    await scheduler.tick();
    assert.deepEqual(sources, [B], 'B is polled; the re-added A is not, and gets no source at all');
    assert.equal(count(setup, 'cursors WHERE account_id = ?', A), 0, 'A gets no cursor from a stale cut-over');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('K6: a replacement opens no drain for an account its old version holds no point for, and samples it afresh', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const sources: string[] = [];
    const { versions, inbox } = await multiWithARemoved(setup, sources);
    await readdAccount(setup.root, inbox);
    versions.createRule({ ...multi, version: 2, mapping: { constant: 'safer' } });
    // An enabled replacement drains its old version through P; a disabled one is drained at P at once (D4).
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    const prepared = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 2 })) as PreparedActivation;
    await assert.rejects(
      () =>
        (async () =>
          setup.runtime.approve({
            approvalId: prepared.approvalId,
            answer: await setup.approvals.issueDisclosureChallenge(prepared.approvalId),
          }))(),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
      'B still owes its drain',
    );
    const drains = (
      setup.store.database
        .prepare('SELECT account_id FROM replacement_drains WHERE intent_id = ?')
        .all(prepared.intentId) as Array<{
        account_id: string;
      }>
    ).map((row) => row.account_id);
    assert.deepEqual(drains, [B], 'no drain waits on A, which the old version no longer polls');
    assert.equal(
      count(setup, 'activation_baselines WHERE intent_id = ? AND account_id = ?', prepared.intentId, A),
      1,
      'the new version samples A afresh',
    );
    // B's worker drains it; the replacement then completes with a fresh point for A.
    setup.store.database
      .prepare('UPDATE replacement_drains SET drained_at = ? WHERE intent_id = ?')
      .run(1, prepared.intentId);
    await setup.runtime.recover();
    assert.equal(versions.activeVersion('rule', multi.ruleId)?.version, 2);
    assert.equal(
      count(setup, 'rule_activation_points WHERE rule_id = ? AND rule_version = 2 AND account_id = ?', multi.ruleId, A),
      1,
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('K6: a replacement while an account is out of the configuration plans nothing for it and is not cancelled', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(multi);
    const first = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 1 })) as PreparedActivation;
    await setup.runtime.approve({
      approvalId: first.approvalId,
      answer: await setup.approvals.issueDisclosureChallenge(first.approvalId),
    });
    // A leaves the configuration; no tick has purged it yet, so the old version still holds its point.
    await removeAccount(setup.root);
    versions.createRule({ ...multi, version: 2, source: { ...multi.source, accountIds: [B] } });
    // An enabled replacement drains its old version through P; a disabled one is drained at P at once (D4).
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    const prepared = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 2 })) as PreparedActivation;
    await assert.rejects(
      () =>
        (async () =>
          setup.runtime.approve({
            approvalId: prepared.approvalId,
            answer: await setup.approvals.issueDisclosureChallenge(prepared.approvalId),
          }))(),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    assert.equal(
      (
        setup.store.database.prepare('SELECT status FROM activation_intents WHERE id = ?').get(prepared.intentId) as {
          status: string;
        }
      ).status,
      'pending-completion',
      'the removed account does not cancel the replacement',
    );
    assert.equal(count(setup, 'activation_baselines WHERE intent_id = ? AND account_id = ?', prepared.intentId, A), 0);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('K6: enable-all re-samples a re-added account for a version that went dark for it, and skips a removed one', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const sources: string[] = [];
    const { inbox } = await multiWithARemoved(setup, sources);
    // Removed: enable-all plans only B and completes.
    const removed = await setup.runtime.prepareEnableAll();
    await setup.runtime.approve({
      approvalId: removed.approvalId,
      answer: await setup.approvals.issueDisclosureChallenge(removed.approvalId),
    });
    assert.equal(
      count(setup, 'rule_activation_points WHERE activation_id = ? AND account_id = ?', removed.intentId, A),
      0,
    );
    assert.equal(
      count(setup, 'rule_activation_points WHERE activation_id = ? AND account_id = ?', removed.intentId, B),
      1,
    );
    // Re-added: a later enable-all, under its own approval, gives A a fresh cut-over.
    await new EventLifecycle(setup.store).disableAll();
    await readdAccount(setup.root, inbox);
    const readded = await setup.runtime.prepareEnableAll();
    await setup.runtime.approve({
      approvalId: readded.approvalId,
      answer: await setup.approvals.issueDisclosureChallenge(readded.approvalId),
    });
    assert.equal(
      count(setup, 'rule_activation_points WHERE activation_id = ? AND account_id = ?', readded.intentId, A),
      1,
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('K6: a replacement samples no account its old version went dark for and its new version does not name', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const sources: string[] = [];
    const { versions, inbox } = await multiWithARemoved(setup, sources);
    await readdAccount(setup.root, inbox);
    versions.createRule({ ...multi, version: 2, source: { ...multi.source, accountIds: [B] } });
    // An enabled replacement drains its old version through P; a disabled one is drained at P at once (D4).
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    const prepared = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 2 })) as PreparedActivation;
    await assert.rejects(
      () =>
        (async () =>
          setup.runtime.approve({
            approvalId: prepared.approvalId,
            answer: await setup.approvals.issueDisclosureChallenge(prepared.approvalId),
          }))(),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    assert.equal(
      count(setup, 'activation_baselines WHERE intent_id = ? AND account_id = ?', prepared.intentId, A),
      0,
      'A is neither polled by the old version nor named by the new one: no Gmail call is made for it',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a replacement approved while collection is disabled re-baselines every union scope to P and completes at once (D4)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const first = (await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: 1 })) as PreparedActivation;
    await setup.runtime.approve({
      approvalId: first.approvalId,
      answer: await setup.approvals.issueDisclosureChallenge(first.approvalId),
    });
    // A cursor left behind P by work before the disable.
    setup.store.database
      .prepare(
        "INSERT OR REPLACE INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', '100', 1)",
      )
      .run(A);
    assert.equal(new EventLifecycle(setup.store).status().enabled, false, 'collection is disabled');
    versions.createRule({ ...rule, version: 2, mapping: { constant: 'safer' } });
    const prepared = (await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: 2 })) as PreparedActivation;
    const completion = await setup.runtime.approve({
      approvalId: prepared.approvalId,
      answer: await setup.approvals.issueDisclosureChallenge(prepared.approvalId),
    });
    assert.equal(completion.status, 'completed', 'no drain waits on source work that cannot run while disabled');
    assert.equal(versions.activeVersion('rule', rule.ruleId)?.version, 2);
    assert.equal(
      (setup.store.database.prepare('SELECT cursor FROM cursors WHERE account_id = ?').get(A) as { cursor: string })
        .cursor,
      '202',
      'the scope is re-baselined to P',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('K6: a version naming an account outside the configuration is refused before any approval exists', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const kind of ['first activation', 'replacement'] as const) {
    const setup = await fixture();
    try {
      const versions = new ImmutableVersions(setup.store.database);
      versions.createTarget(target);
      versions.createRule(multi);
      if (kind === 'replacement') {
        const first = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 1 })) as PreparedActivation;
        await setup.runtime.approve({
          approvalId: first.approvalId,
          answer: await setup.approvals.issueDisclosureChallenge(first.approvalId),
        });
        versions.createRule({ ...multi, version: 2, mapping: { constant: 'safer' } });
      }
      await removeAccount(setup.root);
      const intents = count(setup, 'activation_intents');
      await assert.rejects(
        () => setup.runtime.prepareRule({ ruleId: multi.ruleId, version: kind === 'replacement' ? 2 : 1 }),
        (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
        `${kind}: refused`,
      );
      assert.equal(count(setup, 'activation_intents'), intents, `${kind}: no intent or approval is created`);
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});

test("APR-B1: a scan during a first activation's completion commits nothing, so the new version misses no mail after P (D12)", {
  skip: WINDOWS_SKIP,
}, async () => {
  let gap: (() => Promise<void>) | undefined;
  const setup = await fixture({
    // Runs between the baseline (P) and the finalisation that installs the point and pointer.
    encryptPoint: async (input) => {
      const run = gap;
      gap = undefined;
      await run?.();
      return Buffer.from(JSON.stringify(input.position));
    },
  });
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const first = (await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: 1 })) as PreparedActivation;
    await setup.runtime.approve({
      approvalId: first.approvalId,
      answer: await setup.approvals.issueDisclosureChallenge(first.approvalId),
    });
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    // rule-1 is active and polling A; the shared mailbox cursor sits at P = 202 (the fixture's profile).
    setup.store.database
      .prepare(
        "INSERT OR REPLACE INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', '202', 1)",
      )
      .run(A);
    const second = { ...rule, ruleId: 'rule-2' };
    versions.createRule(second);
    const sourceRule = (ruleId: string): GmailSourceRule => ({
      ruleId,
      ruleVersion: 1,
      eventType: 'gmail.message.received',
      options: rule.source.options,
      ingestRetentionMs: rule.retention.ingestMs,
    });
    let rules = [sourceRule('rule-1')];
    const admitted: string[] = [];
    const worker = new GmailSourceWorker({
      store: setup.store,
      source: {
        async listHistory({ historyId }: { historyId: string }) {
          const history =
            Number(historyId) < 203
              ? [
                  {
                    id: '203',
                    messagesAdded: [{ message: { id: 'message-203', threadId: 'thread-203' } }],
                    labelsAdded: [],
                    labelsRemoved: [],
                  },
                ]
              : [];
          return { historyId: history.length > 0 ? '203' : historyId, nextPageToken: undefined, history } as never;
        },
        async getMessageMetadata(messageId: string) {
          return {
            id: messageId,
            threadId: 'thread-203',
            labelIds: ['INBOX'],
            internalDate: '1760000000000',
            payload: { headers: [{ name: 'Subject', value: 'after P' }] },
          };
        },
      },
      mailbox: { accountId: A, name: 'Events inbox' },
      mailboxLock: setup.mailboxLock,
      rules: () => rules,
      assertDisclosable: async () => undefined,
      admit: async (occurrence) => {
        admitted.push(`${occurrence.rule.ruleId}:${String(occurrence.event.messageId)}`);
        return 'terminal';
      },
      encryptStage: async (value: unknown) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (stored: Uint8Array) => JSON.parse(Buffer.from(stored).toString('utf8')),
    });

    let during: unknown;
    gap = async () => {
      during = await worker.scan();
    };
    const prepared = (await setup.runtime.prepareRule({ ruleId: 'rule-2', version: 1 })) as PreparedActivation;
    await setup.runtime.approve({
      approvalId: prepared.approvalId,
      answer: await setup.approvals.issueDisclosureChallenge(prepared.approvalId),
    });
    assert.deepEqual(during, { cursor: '202', pending: true }, 'the scan inside the completion commits nothing');
    assert.deepEqual(admitted, [], 'and admits nothing for the version already active');

    rules = [sourceRule('rule-1'), sourceRule('rule-2')];
    assert.deepEqual(await worker.scan(), { cursor: '203', pending: false });
    assert.deepEqual(admitted.sort(), ['rule-1:message-203', 'rule-2:message-203'], 'both versions see mail after P');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

function stubScheduler(setup: Awaited<ReturnType<typeof fixture>>, sources: string[]) {
  return new EventScheduler({
    store: setup.store,
    lifecycle: new EventLifecycle(setup.store),
    // The pending activation below is driven by hand; the tick must not resume it.
    activations: { resumeClaimedCompletions: async () => undefined } as never,
    dispatcher: { recoverLeases: async () => undefined, dispatch: async () => undefined } as never,
    expiry: new EventExpiry(setup.store, setup.time.now),
    cipher: {
      encrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
      decrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
    } as never,
    approvals: setup.approvals,
    config: setup.configStore,
    taint: { record: async () => undefined } as never,
    gmailSourceFor: async (accountId: string) => {
      sources.push(accountId);
      return {
        getProfile: async () => ({
          emailAddress: 'x@example.test',
          messagesTotal: 1,
          threadsTotal: 1,
          historyId: '300',
        }),
        listHistory: async ({ historyId }: { historyId: string }) => ({
          historyId,
          nextPageToken: undefined,
          history: [],
        }),
        getMessageMetadata: async () => {
          throw new Error('no metadata read is expected');
        },
      } as never;
    },
    mailboxLock: setup.mailboxLock,
    now: setup.time.now,
  });
}

test("APR-B1: the scheduler installs no initial cursor past a claimed first activation's unpublished P (D12)", {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const db = setup.store.database;
    // rule-1 is active on A with a published point at 300; rule-2's first activation has sampled P = 250 and is
    // waiting to publish it. No mailbox cursor exists yet.
    const doc = (ruleId: string) => canonicalJson({ ...rule, ruleId });
    db.prepare(
      `INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES ('rule-1@1', 'rule-1', 1, ?, 'digest', 'active', 'approval', 'act_c', 1)`,
    ).run(doc('rule-1'));
    db.prepare(
      "INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES ('rule-2@1', 'rule-2', 1, ?, 'digest')",
    ).run(doc('rule-2'));
    db.exec(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-1', 1, 'act_c', 1)",
    );
    db.prepare(
      `INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
       VALUES ('act_c', 'rule-1', 1, 'gmail', ?, 'mailbox', CAST('{"historyId":"300"}' AS BLOB), 1)`,
    ).run(A);
    db.prepare(
      `INSERT INTO activation_intents
       (id, kind, document, digest, effect, replacement_of_version, required_points, acquisition_scopes, status, claimed_at, completion_deadline, created_at, updated_at)
       VALUES ('act_b', 'rule', '{}', 'digest', '{}', NULL, '[]', '[]', 'pending-completion', 1, 99999999999999, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO activation_baselines (intent_id, source, account_id, position_scope, encrypted_position, response_at)
       VALUES ('act_b', 'gmail', ?, 'mailbox', CAST('{"historyId":"250"}' AS BLOB), 1)`,
    ).run(A);
    db.exec('UPDATE event_settings SET enabled = 1');
    const sources: string[] = [];
    const scheduler = stubScheduler(setup, sources);
    await scheduler.tick();
    assert.equal(count(setup, 'cursors WHERE account_id = ?', A), 0, 'no cursor is installed past the unpublished P');

    // rule-2 publishes P = 250 (as finalisation does, in one transaction); the cursor then starts at the lowest point.
    setup.store.immediate(() => {
      db.exec(
        "UPDATE rule_versions SET state = 'active', approval_id = 'approval', authorization_activation_id = 'act_b', activated_at = 2 WHERE id = 'rule-2@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-2', 1, 'act_b', 2); DELETE FROM activation_baselines WHERE intent_id = 'act_b'; UPDATE activation_intents SET status = 'completed' WHERE id = 'act_b'",
      );
      db.prepare(
        `INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
         VALUES ('act_b', 'rule-2', 1, 'gmail', ?, 'mailbox', CAST('{"historyId":"250"}' AS BLOB), 2)`,
      ).run(A);
    });
    setup.time.advance(120_000);
    await scheduler.tick();
    assert.equal(
      (db.prepare('SELECT cursor FROM cursors WHERE account_id = ?').get(A) as { cursor: string }).cursor,
      '250',
      'the cursor starts at the lowest published point, so rule-2 misses nothing after its P',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("APR-B1: a replacement's swap drops the old version's debt on an account the new version leaves, and its orphaned page", {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(multi);
    const first = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 1 })) as PreparedActivation;
    await setup.runtime.approve({
      approvalId: first.approvalId,
      answer: await setup.approvals.issueDisclosureChallenge(first.approvalId),
    });
    setup.store.database.exec('UPDATE event_settings SET enabled = 1');
    versions.createRule({ ...multi, version: 2, source: { ...multi.source, accountIds: [B] } });
    const prepared = (await setup.runtime.prepareRule({ ruleId: multi.ruleId, version: 2 })) as PreparedActivation;
    await assert.rejects(
      () =>
        (async () =>
          setup.runtime.approve({
            approvalId: prepared.approvalId,
            answer: await setup.approvals.issueDisclosureChallenge(prepared.approvalId),
          }))(),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    // A's worker held two after-P pages for the old version; one is also owed to another rule.
    const stage = setup.store.database.prepare(
      `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
       VALUES (?, 'gmail', ?, 'mailbox', 1, 99999999999999, X'00', 1)`,
    );
    const debt = setup.store.database.prepare(
      'INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, ?)',
    );
    stage.run('stage-only-old', A);
    debt.run('stage-only-old', multi.ruleId, 1);
    stage.run('stage-shared', A);
    debt.run('stage-shared', multi.ruleId, 1);
    debt.run('stage-shared', 'rule-other', 1);
    setup.store.database
      .prepare('UPDATE replacement_drains SET drained_at = ? WHERE intent_id = ?')
      .run(1, prepared.intentId);
    await setup.runtime.recover();
    assert.equal(versions.activeVersion('rule', multi.ruleId)?.version, 2);
    assert.equal(count(setup, "source_scan_state WHERE id = 'stage-only-old'"), 0, 'a page owed to nobody is deleted');
    assert.equal(count(setup, "source_scan_state WHERE id = 'stage-shared'"), 1, 'a page another rule is owed stays');
    assert.equal(
      count(setup, 'source_stage_rule_debts WHERE rule_id = ? AND rule_version = 1', multi.ruleId),
      0,
      "the old version's debt on A is gone",
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a completion that crosses its deadline during the baseline or point encryption installs nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const stage of ['baseline', 'point'] as const) {
    let advance: () => void = () => undefined;
    const setup = await fixture(
      stage === 'baseline'
        ? {
            encryptBaseline: async (_intentId, _accountId, position) => {
              advance();
              return Buffer.from(JSON.stringify(position));
            },
          }
        : {
            encryptPoint: async (input) => {
              advance();
              return Buffer.from(JSON.stringify(input.position));
            },
          },
    );
    advance = () => setup.time.advance(3_600_001);
    try {
      const versions = new ImmutableVersions(setup.store.database);
      versions.createTarget(target);
      versions.createRule(rule);
      const prepared = (await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: 1 })) as PreparedActivation;
      if (stage === 'baseline') {
        // This trigger makes the baseline transaction's own deadline check observable. The later settlement removes
        // baselines, so inspecting only the final database would not prove that an expired baseline was never written.
        setup.store.database.exec(
          `CREATE TRIGGER reject_expired_baseline BEFORE INSERT ON activation_baselines
           WHEN NEW.intent_id = '${prepared.intentId}'
           BEGIN SELECT RAISE(ABORT, 'EXPIRED_BASELINE_WRITE'); END`,
        );
      }
      await assert.rejects(
        () =>
          (async () =>
            setup.runtime.approve({
              approvalId: prepared.approvalId,
              answer: await setup.approvals.issueDisclosureChallenge(prepared.approvalId),
            }))(),
        (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
        `${stage}: refused at the deadline`,
      );
      assert.equal(versions.activeVersion('rule', rule.ruleId), null, `${stage}: no pointer`);
      assert.equal(count(setup, 'rule_activation_points'), 0, `${stage}: no point`);
      assert.equal(count(setup, 'activation_baselines'), 0, `${stage}: no baseline left`);
      assert.deepEqual(
        {
          ...(setup.store.database
            .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
            .get(prepared.intentId) as Record<string, unknown>),
        },
        { status: 'failed', failure_code: 'COMPLETION_TIMEOUT' },
        `${stage}: the timeout is recorded`,
      );
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});

test('APR-B1: a settlement found at finalisation commits rather than rolling back with its refusal', {
  skip: WINDOWS_SKIP,
}, async () => {
  let bump: () => void = () => undefined;
  const setup = await fixture({
    encryptPoint: async (input) => {
      bump();
      return Buffer.from(JSON.stringify(input.position));
    },
  });
  // The switch generation moves while the point is encrypted (no disable-all cancels the intent itself).
  bump = () => setup.store.database.exec('UPDATE event_settings SET switch_generation = switch_generation + 1');
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: 1 })) as PreparedActivation;
    await assert.rejects(
      () =>
        (async () =>
          setup.runtime.approve({
            approvalId: prepared.approvalId,
            answer: await setup.approvals.issueDisclosureChallenge(prepared.approvalId),
          }))(),
      (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
          .get(prepared.intentId) as Record<string, unknown>),
      },
      { status: 'cancelled', failure_code: 'STALE_GENERATION' },
    );
    assert.equal(count(setup, 'activation_baselines'), 0, 'its baseline is gone, so it fences no mailbox');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a point published while the initial cursor is being computed makes that cursor stale; the next tick uses it (D12)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const db = setup.store.database;
    const doc = (ruleId: string) => canonicalJson({ ...rule, ruleId });
    db.prepare(
      `INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES ('rule-1@1', 'rule-1', 1, ?, 'digest', 'active', 'approval', 'act_c', 1)`,
    ).run(doc('rule-1'));
    db.prepare(
      "INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES ('rule-2@1', 'rule-2', 1, ?, 'digest')",
    ).run(doc('rule-2'));
    db.exec(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-1', 1, 'act_c', 1)",
    );
    db.prepare(
      `INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
       VALUES ('act_c', 'rule-1', 1, 'gmail', ?, 'mailbox', CAST('{"historyId":"300"}' AS BLOB), 1)`,
    ).run(A);
    db.exec('UPDATE event_settings SET enabled = 1');
    // Finalisation takes no mailbox lock: rule-2 publishes P = 250 while the scheduler decrypts rule-1's point.
    let publish: (() => void) | undefined = () =>
      setup.store.immediate(() => {
        db.exec(
          "UPDATE rule_versions SET state = 'active', approval_id = 'approval', authorization_activation_id = 'act_b', activated_at = 2 WHERE id = 'rule-2@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-2', 1, 'act_b', 2)",
        );
        db.prepare(
          `INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
           VALUES ('act_b', 'rule-2', 1, 'gmail', ?, 'mailbox', CAST('{"historyId":"250"}' AS BLOB), 2)`,
        ).run(A);
      });
    const sources: string[] = [];
    const scheduler = new EventScheduler({
      store: setup.store,
      lifecycle: new EventLifecycle(setup.store),
      activations: { resumeClaimedCompletions: async () => undefined } as never,
      dispatcher: { recoverLeases: async () => undefined, dispatch: async () => undefined } as never,
      expiry: new EventExpiry(setup.store, setup.time.now),
      cipher: {
        encrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
        decrypt: async (_location: unknown, value: Uint8Array) => {
          const run = publish;
          publish = undefined;
          run?.();
          return Buffer.from(value);
        },
      } as never,
      approvals: setup.approvals,
      config: setup.configStore,
      taint: { record: async () => undefined } as never,
      gmailSourceFor: async (accountId: string) => {
        sources.push(accountId);
        return {
          listHistory: async ({ historyId }: { historyId: string }) => ({
            historyId,
            nextPageToken: undefined,
            history: [],
          }),
          getMessageMetadata: async () => {
            throw new Error('no metadata read is expected');
          },
        } as never;
      },
      mailboxLock: setup.mailboxLock,
      now: setup.time.now,
    });
    await scheduler.tick();
    assert.equal(
      count(setup, 'cursors WHERE account_id = ?', A),
      0,
      'the minimum computed before the publish is not installed',
    );
    setup.time.advance(120_000);
    await scheduler.tick();
    assert.equal(
      (db.prepare('SELECT cursor FROM cursors WHERE account_id = ?').get(A) as { cursor: string }).cursor,
      '250',
      'the next tick starts the cursor at the lowest published point',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});
