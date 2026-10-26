import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type ActivityLine,
  ActivityLog,
  type ActivitySession,
  canonicalJson,
  emptyConfig,
  sessionIdentity,
  sha256Hex,
} from '@agentcomms/core';
import { EventControlClient } from '../src/control/client.ts';
import {
  DELIVERY_ACTIVITY_CHANNEL,
  DELIVERY_ACTIVITY_OPERATION,
  DeliveryActivity,
} from '../src/runtime/delivery-activity.ts';
import { DryRunDispatcher } from '../src/runtime/dispatcher.ts';
import { deadLetterDelivery, EventExpiry } from '../src/runtime/expiry.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { selectEventSecretStore } from '../src/store/event-secrets.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

/**
 * Activity design S1 (§8 Task 2c): the event service writes one content-free "told" line for what each delivery came
 * to. These tests drive the real delivery transitions — the dry-run dispatcher, dead-lettering, the expiry sweep and
 * disable-all — and read the activity file core writes.
 */

const ACCOUNT = 'ibx_TOLDTOLDTOLDTOLD';
const ALIAS = 'events/gmail';
const RULE = 'told-rule';
const TARGET = 'told-target';

// What a sender controls. None of it may reach the activity log.
const SUBJECT = 'Told-test subject: invoice 4417';
const SENDER = 'told.sender@example.test';
const SENDER_NAME = 'Told Sender';
const BODY = 'the told-test body text that must never be logged';
const SNIPPET = 'told-test snippet text';

const rule = {
  ruleId: RULE,
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: [ACCOUNT],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { subject: { $path: '/subject' } },
  targets: [{ targetId: TARGET, version: 1, kind: 'dry-run', retentionMs: 86_400_000 }],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: {
    ingestMs: 100_000,
    holdMs: 100_000,
    deliveryMs: 100_000,
    dryrunMs: 86_400_000,
    sseReplayMs: 100_000,
    deadLetterMs: 100_000,
    decisionMetadataMs: 100_000,
  },
};

// The exact persisted retry payload, carrying the sender-controlled values a mapping could copy.
const record = Buffer.from(
  JSON.stringify({
    cloudEventBytes: JSON.stringify({ subject: SUBJECT, from: { address: SENDER, name: SENDER_NAME }, body: BODY }),
    untrusted: ['/subject', '/from/name', '/body'],
    representation: 'plain',
  }),
);

const SESSION = {
  pid: 4242,
  ppid: 1,
  cwd: () => '/',
  platform: 'darwin' as const,
  probe: async () => ({ ppid: 0, startedAt: 'Sun Oct 25 10:00:00 2026', name: 'launchd' }),
};

async function fixture() {
  let clock = 1_000;
  const stateDir = await shortTempDir('events-told-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
  const canonical = canonicalJson(rule);
  store.database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 'approval', 'activation', 1)`,
    )
    .run(`${RULE}@1`, RULE, 1, canonical, sha256Hex(canonical));
  const target = canonicalJson(rule.targets[0]);
  store.database
    .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
    .run(`${TARGET}@1`, TARGET, 1, target, sha256Hex(target));
  const insert = (id: string, expiresAt = 50_000) => {
    store.database
      .prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
      )
      .run(`event-${id}`, store.installationId, ACCOUNT, id, clock, clock, clock);
    store.database
      .prepare(
        `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
         VALUES (?, ?, ?, ?, 1, 'delivered', ?, 'retained')`,
      )
      .run(`decision-${id}`, `event-${id}`, ACCOUNT, RULE, 90_000);
    store.database
      .prepare(
        `INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
                                encrypted_record, expires_at, state, switch_generation)
         VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?, 'queued', 7)`,
      )
      .run(id, `decision-${id}`, ACCOUNT, RULE, `dryrun:${TARGET}:1`, TARGET, record, expiresAt);
  };
  const cipher = {
    async encrypt(_: unknown, bytes: Uint8Array) {
      return Buffer.from(bytes);
    },
    async decrypt(_: unknown, bytes: Uint8Array) {
      return Buffer.from(bytes);
    },
  };
  const config = {
    load: async () => ({ inboxes: { [ALIAS]: { id: ACCOUNT, provider: 'gmail' } }, accounts: {} }),
  };
  const dryrun = new DryRunDispatcher({
    store,
    cipher,
    approvals: { get: async () => null },
    config,
    now: () => clock,
    fence: async () => ({ switchGeneration: 7 }),
  } as unknown as ConstructorParameters<typeof DryRunDispatcher>[0]);
  const log = new ActivityLog(stateDir, { now: () => new Date(Date.UTC(2026, 9, 25, 12, 0, 0) + clock) });
  const session = (): Promise<ActivitySession> => sessionIdentity('daemon', undefined, SESSION);
  const activity = (options: Partial<ConstructorParameters<typeof DeliveryActivity>[0]> = {}) =>
    new DeliveryActivity({ store, core: { activity: log }, config: config as never, session, ...options });
  return {
    stateDir,
    store,
    insert,
    dryrun,
    log,
    activity,
    tick: (ms: number) => {
      clock += ms;
      return clock;
    },
    now: () => clock,
    async close() {
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/** The activity log as written: every day's file, each line parsed. */
async function activityLines(stateDir: string): Promise<{ text: string; lines: ActivityLine[] }> {
  const directory = join(stateDir, 'activity');
  let names: string[] = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    return { text: '', lines: [] };
  }
  const text = (await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')))).join('');
  return {
    text,
    lines: text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as ActivityLine),
  };
}

function toldOf(lines: readonly ActivityLine[]) {
  return lines
    .map((line) => ({ outcome: line.outcome, reason: line.reason, count: line.count }))
    .sort((left, right) => `${left.outcome}${left.reason}`.localeCompare(`${right.outcome}${right.reason}`));
}

function assertContentFree(text: string, also: readonly string[] = []): void {
  for (const content of [SUBJECT, SENDER, SENDER_NAME, BODY, SNIPPET, 'invoice 4417', 'cloudEventBytes', ...also])
    assert.ok(!text.includes(content), `the activity log holds no ${JSON.stringify(content)}`);
}

test('S1: each delivery outcome is one content-free told line, counted once, after it is committed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    // Finished before this process started: counted by the process that finished it, never again here.
    setup.insert('d0');
    assert.equal((await setup.dryrun.dispatch('d0')).state, 'delivered');
    for (const id of ['d1', 'd2', 'd3', 'd5']) setup.insert(id);
    setup.insert('d4', 2_000);
    const activity = setup.activity();

    assert.equal((await setup.dryrun.dispatch('d1')).state, 'delivered');
    assert.equal((await setup.dryrun.dispatch('d2')).state, 'delivered');
    deadLetterDelivery(setup.store, { deliveryId: 'd3', deadLetterRetentionMs: 100_000, now: setup.now() });
    setup.tick(2_000);
    new EventExpiry(setup.store, setup.now).sweep();
    assert.equal(
      (setup.store.database.prepare("SELECT state FROM deliveries WHERE id = 'd4'").get() as { state: string }).state,
      'retention-expired',
    );

    await activity.record();
    let { text, lines } = await activityLines(setup.stateDir);
    assert.deepEqual(toldOf(lines), [
      { outcome: 'failed', reason: 'dead-lettered', count: 1 },
      { outcome: 'failed', reason: 'retention-expired', count: 1 },
      { outcome: 'ok', reason: undefined, count: 2 },
    ]);
    for (const line of lines) {
      assert.equal(line.channel, DELIVERY_ACTIVITY_CHANNEL);
      assert.equal(line.channel, 'events');
      assert.equal(line.operation, DELIVERY_ACTIVITY_OPERATION);
      assert.equal(line.operation, 'events.delivery');
      assert.equal(line.kind, 'told');
      assert.deepEqual(line.account, { id: ACCOUNT, alias: ALIAS });
      assert.deepEqual(line.told, { rule: RULE, target: TARGET });
      assert.equal(line.ms, 0);
      assert.equal(line.session.surface, 'daemon');
      assert.equal(line.items, undefined, 'a told line lists no items: no event, message or delivery');
      assert.deepEqual(
        Object.keys(line).sort(),
        [
          'account',
          'at',
          'channel',
          'count',
          'kind',
          'ms',
          'operation',
          'outcome',
          'session',
          'told',
          ...(line.reason === undefined ? [] : ['reason']),
        ].sort(),
      );
    }
    // Not an event's id either: those are derived from the provider's.
    assertContentFree(text, ['event-d']);

    // Nothing new: nothing more is written.
    await activity.record();
    assert.equal((await activityLines(setup.stateDir)).lines.length, 3);

    // A delivery made after the baseline, and one dropped by disable-all.
    setup.insert('d6');
    assert.equal((await setup.dryrun.dispatch('d6')).state, 'delivered');
    await new EventLifecycle(setup.store, setup.now).disableAll();
    await activity.stop();
    ({ text, lines } = await activityLines(setup.stateDir));
    assert.deepEqual(toldOf(lines.slice(3)), [
      { outcome: 'ok', reason: undefined, count: 1 },
      { outcome: 'refused', reason: 'cancelled', count: 1 },
    ]);
    assertContentFree(text, ['event-d']);

    // The log reads them back as the event service's own session.
    const sessions = await setup.log.sessions();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]?.counts.kind, { read: 0, write: 0, told: 5, approval: 0 });
  } finally {
    await setup.close();
  }
});

test('S1: two passes at once count each outcome once; its timer records, and once stopped it records nothing more', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const activity = setup.activity();
    setup.insert('a1');
    setup.insert('a2');
    assert.equal((await setup.dryrun.dispatch('a1')).state, 'delivered');
    assert.equal((await setup.dryrun.dispatch('a2')).state, 'delivered');
    await Promise.all([activity.record(), activity.record(), activity.record()]);
    assert.deepEqual(toldOf((await activityLines(setup.stateDir)).lines), [
      { outcome: 'ok', reason: undefined, count: 2 },
    ]);
    // Started, it records on its own timer.
    activity.start(5);
    setup.insert('a2b');
    assert.equal((await setup.dryrun.dispatch('a2b')).state, 'delivered');
    for (let wait = 0; wait < 200 && (await activityLines(setup.stateDir)).lines.length < 2; wait += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await activityLines(setup.stateDir)).lines.length, 2, 'the timer recorded the next outcome');
    await activity.stop();
    setup.insert('a3');
    assert.equal((await setup.dryrun.dispatch('a3')).state, 'delivered');
    await activity.stop();
    activity.start(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await activityLines(setup.stateDir)).lines.length, 2, 'a stopped recorder never starts again');
  } finally {
    await setup.close();
  }
});

test('S1: an outcome is recorded only once it is committed, and never for one rolled back', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('t1');
    setup.insert('t2');
    const activity = setup.activity();
    const settle = (id: string) =>
      setup.store.database
        .prepare("UPDATE deliveries SET state = 'delivered', encrypted_record = NULL WHERE id = ?")
        .run(id);
    let pending: Promise<void> | undefined;
    // Seen from inside the transaction that settles it, the outcome is not yet durable: nothing is counted.
    setup.store.immediate(() => {
      settle('t1');
      pending = activity.record();
    });
    await pending;
    assert.deepEqual((await activityLines(setup.stateDir)).lines, []);
    // One rolled back never happened.
    assert.throws(() =>
      setup.store.immediate(() => {
        settle('t2');
        pending = activity.record();
        throw new Error('rolled back');
      }),
    );
    await pending;
    await activity.record();
    const { lines } = await activityLines(setup.stateDir);
    assert.deepEqual(toldOf(lines), [{ outcome: 'ok', reason: undefined, count: 1 }]);
    assert.equal(
      (setup.store.database.prepare("SELECT state FROM deliveries WHERE id = 't2'").get() as { state: string }).state,
      'queued',
    );
  } finally {
    await setup.close();
  }
});

test('S1: recording never fails or changes a delivery: off, a failing log, an unreadable configuration, a closed database', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    // Recording off: the delivery happens, nothing is written.
    const off = new ActivityLog(setup.stateDir, {
      settings: async () => ({ record: 'off', retentionDays: 30, problems: [] }),
    });
    const quiet = setup.activity({ core: { activity: off } });
    setup.insert('f1');
    assert.equal((await setup.dryrun.dispatch('f1')).state, 'delivered');
    await quiet.record();
    assert.deepEqual((await activityLines(setup.stateDir)).lines, []);

    // A log whose every append throws, and a configuration that cannot be read: the pass still resolves.
    const failing = setup.activity({
      core: {
        activity: {
          append: async () => {
            throw new Error('the disk is full');
          },
        } as never,
      },
    });
    setup.insert('f2');
    assert.equal((await setup.dryrun.dispatch('f2')).state, 'delivered');
    await failing.record();
    const unnamed = setup.activity({
      config: {
        load: async () => {
          throw new Error('the configuration is unreadable');
        },
      },
    });
    setup.insert('f3');
    assert.equal((await setup.dryrun.dispatch('f3')).state, 'delivered');
    await unnamed.record();
    const { lines } = await activityLines(setup.stateDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.count, 1, 'only what finished after it started');
    assert.deepEqual(lines[0]?.account, { id: ACCOUNT, alias: '' }, 'an account it cannot name is named by its id');

    // A database closed under it: nothing is read, nothing throws.
    const late = setup.activity();
    setup.store.close();
    await late.record();
    await late.stop();
    // One that cannot read its baseline at all starts anyway, and records nothing.
    const blind = setup.activity();
    blind.start(1);
    await blind.record();
    await blind.stop();
    assert.equal((await activityLines(setup.stateDir)).lines.length, 1);
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('S1: a real owner records a Gmail delivery as one told line and never the mail it carried', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('aev-told-owner-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes[ALIAS] = {
    id: ACCOUNT,
    provider: 'gmail',
    email: 'events@example.test',
    identity: 'oidc',
    client: 'client-1',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:none:${ACCOUNT}`,
    internalDomains: [],
    createdAt: '2026-10-09T12:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  // Approving a rule writes event secrets; a headless runner has no keychain, so the file backend is chosen first.
  const selected = await openEventDatabase({ stateDir });
  try {
    await selectEventSecretStore(selected.database, 'file');
  } finally {
    selected.close();
  }
  const headers = [
    { name: 'Subject', value: SUBJECT },
    { name: 'From', value: `"${SENDER_NAME}" <${SENDER}>` },
  ];
  const message = {
    id: 'g-told',
    threadId: 'g-told-thread',
    labelIds: ['INBOX'],
    internalDate: '1760000000000',
    snippet: SNIPPET,
  };
  let emit = false;
  const owner = await startEventOwner({
    ...noRealHome(stateDir),
    stateDir,
    configDir,
    tickMs: 60_000,
    pollIntervalMs: 1,
    gmailSourceFor: async () =>
      ({
        inboxId: ACCOUNT,
        getProfile: async () => ({ historyId: '1' }),
        listHistory: async () =>
          emit
            ? {
                historyId: '2',
                nextPageToken: undefined,
                history: [
                  {
                    id: '2',
                    messagesAdded: [{ message: { id: message.id, threadId: message.threadId } }],
                    labelsAdded: [],
                    labelsRemoved: [],
                  },
                ],
              }
            : { historyId: '1', nextPageToken: undefined, history: [] },
        getMessageMetadata: async () => ({ ...message, payload: { headers } }),
        getMessage: async () => ({
          ...message,
          payload: {
            mimeType: 'text/plain',
            headers,
            body: { data: Buffer.from(BODY, 'utf8').toString('base64url'), size: BODY.length },
          },
        }),
      }) as never,
  });
  let stopped = false;
  try {
    const control = new EventControlClient({ stateDir, clientName: 'events-daemon-told-e2e' });
    const target = { targetId: TARGET, version: 1, kind: 'dry-run', retentionMs: 86_400_000 };
    await control.request('target-add', { document: target });
    const document = {
      ...rule,
      mapping: {
        subject: { $path: '/subject' },
        from: { $path: '/from' },
        snippet: { $path: '/snippet' },
        body: { $path: '/body' },
      },
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
    await control.request('rule-create', { document });
    const planned = (await control.request('rule-enable', { ruleId: RULE, version: 1 })) as { approvalId: string };
    // The challenge is the text a person types back at the terminal.
    const challenge = (await control.request('approve-challenge', { approvalId: planned.approvalId })) as string;
    await control.request('approve', { approvalId: planned.approvalId, answer: challenge });
    const enabled = (await control.request('enable-all')) as { approvalId: string };
    const enableChallenge = (await control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
    await control.request('approve', { approvalId: enabled.approvalId, answer: enableChallenge });
    emit = true;
    let dryruns: Array<{ deliveryId: string; accountId: string }> = [];
    for (let index = 0; index < 8 && dryruns.length === 0; index += 1) {
      await owner.tick();
      dryruns = (await control.request('dryrun-list')) as typeof dryruns;
    }
    assert.equal(dryruns.length, 1, 'the matched mail reached the dry-run target');
    // The delivery really carried the mail: its subject, sender and body are in the target's own record.
    const shown = JSON.stringify(await control.request('dryrun-show', { deliveryId: dryruns[0]?.deliveryId }));
    for (const content of [SUBJECT, SENDER, BODY]) assert.ok(shown.includes(content), `the delivery carried it`);

    await owner.stop();
    stopped = true;
    const { text, lines } = await activityLines(stateDir);
    const told = lines.filter((line) => line.kind === 'told');
    assert.equal(told.length, 1, 'one delivery outcome, one line');
    assert.equal(told[0]?.operation, 'events.delivery');
    assert.equal(told[0]?.channel, 'events');
    assert.equal(told[0]?.outcome, 'ok');
    assert.equal(told[0]?.count, 1);
    assert.deepEqual(told[0]?.account, { id: ACCOUNT, alias: ALIAS });
    assert.deepEqual(told[0]?.told, { rule: RULE, target: TARGET });
    assert.equal(told[0]?.session.surface, 'daemon');
    assertContentFree(text);
    assert.ok(!text.includes(dryruns[0]?.deliveryId ?? '-'), 'nor the delivery id');
  } finally {
    if (!stopped) await owner.stop();
    await rm(root, { recursive: true, force: true });
  }
});
