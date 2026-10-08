import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, ConfigStore, canonicalJson, emptyConfig } from '@agentcomms/core';
import { ImmutableVersions } from '../src/domain/versions.ts';
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
    readonly encryptBaseline?: (
      intentId: string,
      accountId: string,
      position: { readonly historyId: string },
    ) => Promise<Uint8Array>;
    readonly decryptBaseline?: (
      intentId: string,
      accountId: string,
      stored: Uint8Array,
    ) => Promise<{ readonly historyId: string }>;
    readonly encryptPoint?: (input: {
      readonly activationId: string;
      readonly ruleId: string;
      readonly ruleVersion: number;
      readonly accountId: string;
      readonly position: { readonly historyId: string };
    }) => Promise<Uint8Array>;
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
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_old', authorization_activation_id = 'act_old', activated_at = 1 WHERE id = 'rule-1@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-1', 1, 'act_old', 1)",
    );
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
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_old', authorization_activation_id = 'act_old', activated_at = 1 WHERE id = 'rule-1@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-1', 1, 'act_old', 1)",
    );
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
