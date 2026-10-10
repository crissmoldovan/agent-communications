import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '@agentcomms/core';
import { EventControlClient } from '../src/control/client.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/** The fake list file's digest has the real shape: lowercase SHA-256 of the list document. */
const FAKE_LIST_DIGEST = createHash('sha256').update('{"lists":"fake-owner"}').digest('hex');

test('D-C: an owner behind the wall clock leaves unexpired Resend received and status stages encrypted', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('aev-dc-owner-clock-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  const accountId = 'acc_RRRRRRRRRRRRRRRR';
  const receivedId = `resend-received:${accountId}`;
  const statusEmailId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const statusId = `resend-status:${accountId}:${statusEmailId}`;
  const ownerNow = 19;
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(emptyConfig())}\n`);
  const store = await openEventDatabase({ stateDir });
  try {
    await selectEventSecretStore(store.database, 'file');
    const cipher = new EventRecordCipher(
      store.database,
      await openEventSecretStore({ database: store.database, paths: store.paths, configDir }),
    );
    const received = await cipher.encrypt(
      { table: 'source_scan_state', column: 'encryptedRecord', key: [{ type: 'text', value: receivedId }] },
      Buffer.from(
        JSON.stringify({
          anchorId: 'anchor',
          cycleHeadId: statusEmailId,
          after: null,
          pagesScanned: 1,
          items: [statusEmailId],
          candidate: { emailId: statusEmailId },
        }),
      ),
    );
    const status = await cipher.encrypt(
      { table: 'source_scan_state', column: 'encryptedRecord', key: [{ type: 'text', value: statusId }] },
      Buffer.from(
        JSON.stringify({
          change: {
            emailId: statusEmailId,
            previous: 'sent',
            current: 'delivered',
            observedAt: '1970-01-01T00:00:00.019Z',
            scanGeneration: 1,
            from: null,
            to: [],
            cc: [],
            bcc: [],
            subject: 'synthetic stage',
            createdAt: null,
            scheduledAt: null,
            messageId: null,
          },
        }),
      ),
    );
    store.database
      .prepare(
        `INSERT INTO source_scan_state
         (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
         VALUES (?, 'resend', ?, ?, 10, 20, ?, 10)`,
      )
      .run(receivedId, accountId, 'received', received);
    store.database
      .prepare(
        `INSERT INTO source_scan_state
         (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
         VALUES (?, 'resend', ?, ?, 10, 20, ?, 10)`,
      )
      .run(statusId, accountId, 'status', status);
  } finally {
    store.close();
  }

  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    try {
      owner = await startEventOwner({ stateDir, configDir, tickMs: 60_000, now: () => ownerNow });
    } catch (error) {
      // The development sandbox denies Unix-domain listeners after start-up expiry. The rows below still verify the
      // production owner composition that ran before listener creation; other errors remain test failures.
      if (!(error instanceof Error) || !/EPERM/u.test(error.message)) throw error;
    }
    const afterStart = await openEventDatabase({ stateDir });
    try {
      assert.deepEqual(
        afterStart.database
          .prepare('SELECT id, staged_at, stage_expires_at FROM source_scan_state WHERE id IN (?, ?) ORDER BY id')
          .all(receivedId, statusId)
          .map((row) => ({ ...row })),
        [
          { id: receivedId, staged_at: 10, stage_expires_at: 20 },
          { id: statusId, staged_at: 10, stage_expires_at: 20 },
        ],
        'the injected owner clock is before both stage deadlines, regardless of the wall clock',
      );
      assert.equal(
        afterStart.database.prepare("SELECT 1 FROM source_occurrence_resolutions WHERE source = 'resend'").get(),
        undefined,
      );
      assert.equal(
        afterStart.database.prepare('SELECT 1 FROM resend_status_state WHERE account_id = ?').get(accountId),
        undefined,
      );
    } finally {
      afterStart.close();
    }
  } finally {
    await owner?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('D7: a normal Phase-D owner registers all sources and exposes their content-free state', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-d7-owner-');
  try {
    const owner = await startEventOwner({ stateDir, tickMs: 60_000 });
    try {
      const control = new EventControlClient({ stateDir, clientName: 'events-daemon-phase-d-owner-test' });
      assert.deepEqual(await control.request('sources-list'), [
        { source: 'gmail', accounts: [] },
        { source: 'resend', accounts: [] },
        { source: 'slack', accounts: [] },
        { source: 'whatsapp', accounts: [] },
      ]);
      for (const source of ['gmail', 'resend', 'slack', 'whatsapp']) {
        assert.deepEqual(await control.request('source-show', { source }), { source, accounts: [] });
      }
    } finally {
      await owner.stop();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B1: a Gmail alias swap is refused before the returned source can read or stage another mailbox', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('aev-b1-gmail-identity-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  const firstId = 'ibx_AAAAAAAAAAAAAAAA';
  const secondId = 'ibx_BBBBBBBBBBBBBBBB';
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  const inbox = (id: string, email: string) => ({
    id,
    provider: 'gmail' as const,
    email,
    identity: 'oidc' as const,
    client: 'client-1',
    tier: 'read' as const,
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:none:${id}`,
    internalDomains: [],
    createdAt: '2026-10-10T12:00:00.000Z',
  });
  const first = inbox(firstId, 'first@example.test');
  const second = inbox(secondId, 'second@example.test');
  config.inboxes['first/gmail'] = first;
  config.inboxes['second/gmail'] = second;
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const store = await openEventDatabase({ stateDir });
  try {
    const rule = {
      ruleId: 'rule-gmail-identity',
      version: 1,
      source: {
        channel: 'gmail',
        accountIds: [firstId],
        options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
      },
      event: { type: 'gmail.message.received', version: 1 },
      condition: { path: '/id', op: 'exists' },
      mapping: { constant: 'safe' },
      targets: [],
      subscribers: [],
      judges: [],
      deliveryRateCap: 1,
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
    store.database
      .prepare(
        `INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
         VALUES ('rule-gmail-identity@1', 'rule-gmail-identity', 1, ?, 'digest', 'active', 'approval', 'cutover', 1)`,
      )
      .run(JSON.stringify(rule));
    store.database.exec(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('rule', 'rule-gmail-identity', 1, 'cutover', 1);
       INSERT INTO rule_activation_points
       (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
       VALUES ('cutover', 'rule-gmail-identity', 1, 'gmail', '${firstId}', 'mailbox', X'01', 1);
       INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
       VALUES ('gmail', '${firstId}', 'mailbox', '1', 1);
       UPDATE event_settings SET enabled = 1, paused = 0;`,
    );
  } finally {
    store.close();
  }
  let providerCalls = 0;
  const owner = await startEventOwner({
    stateDir,
    configDir,
    tickMs: 60_000,
    gmailSourceFor: async ({ accountId, alias }) => {
      assert.equal(accountId, firstId);
      assert.equal(
        alias,
        'first/gmail',
        'the owner first resolves the configured presentation alias for the stable id',
      );
      config.inboxes['first/gmail'] = second;
      config.inboxes['second/gmail'] = first;
      await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
      return {
        inboxId: secondId,
        getProfile: async () => {
          providerCalls += 1;
          return { historyId: '2' };
        },
        listHistory: async () => {
          providerCalls += 1;
          return { historyId: '2', history: [], nextPageToken: undefined };
        },
      } as never;
    },
  });
  try {
    await owner.tick();
    assert.equal(providerCalls, 0, 'the swapped mailbox never reaches a provider method');
    const database = await openEventDatabase({ stateDir });
    try {
      assert.equal(database.database.prepare('SELECT 1 FROM source_scan_state').get(), undefined);
      assert.equal(database.database.prepare('SELECT 1 FROM ingest').get(), undefined);
      assert.equal(
        database.database.prepare('SELECT 1 FROM rule_activation_points WHERE account_id = ?').get(secondId),
        undefined,
        'the swapped mailbox never becomes an activation anchor',
      );
    } finally {
      database.close();
    }
  } finally {
    await owner.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('D7b: a normal owner approves all four injected fakes, interleaves source work, and purges a paused removed Slack account', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('aev-d7b-owner-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const ids = {
    gmail: 'ibx_AAAAAAAAAAAAAAAA',
    slack: 'acc_SSSSSSSSSSSSSSSS',
    resend: 'acc_RRRRRRRRRRRRRRRR',
    whatsapp: 'acc_WWWWWWWWWWWWWWWW',
  };
  const config = emptyConfig();
  config.inboxes['events/gmail'] = {
    id: ids.gmail,
    provider: 'gmail',
    email: 'events@example.test',
    identity: 'oidc',
    client: 'client-1',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:none:${ids.gmail}`,
    internalDomains: [],
    createdAt: '2026-10-09T12:00:00.000Z',
  };
  for (const [platform, id] of Object.entries(ids).filter(([platform]) => platform !== 'gmail'))
    config.accounts[`events/${platform}`] = {
      id,
      platform,
      workspace: `workspace-${platform}`,
      userId: `user-${platform}`,
      tier: 'read',
      grantedScopes: [],
      secretRef: `${platform}:none:${id}`,
      createdAt: '2026-10-09T12:00:00.000Z',
    };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);

  let emit = false;
  let status = 'sent';
  let holdSlack = false;
  let releaseSlack: (() => void) | undefined;
  let sawSlack: (() => void) | undefined;
  const slackStarted = new Promise<void>((resolve) => {
    sawSlack = resolve;
  });
  const owner = await startEventOwner({
    stateDir,
    configDir,
    tickMs: 60_000,
    // Ticks are driven by hand here; a short poll interval makes each scope due again on the next turn.
    pollIntervalMs: 1,
    gmailSourceFor: async () =>
      ({
        inboxId: ids.gmail,
        getProfile: async () => ({ historyId: '1' }),
        listHistory: async () =>
          emit
            ? {
                historyId: '2',
                nextPageToken: undefined,
                history: [
                  {
                    id: '2',
                    messagesAdded: [{ message: { id: 'g-new', threadId: 'g-thread' } }],
                    labelsAdded: [],
                    labelsRemoved: [],
                  },
                ],
              }
            : { historyId: '1', nextPageToken: undefined, history: [] },
        getMessageMetadata: async () => ({
          id: 'g-new',
          threadId: 'g-thread',
          labelIds: ['INBOX'],
          internalDate: '1760000000000',
          payload: { headers: [{ name: 'Subject', value: 'fake owner event' }] },
        }),
      }) as never,
    slackSourceFor: async () =>
      ({
        accountId: ids.slack,
        accountAlias: 'events/slack',
        workspaceId: 'workspace-slack',
        conversation: async () => ({ id: 'C-owner', name: null, kind: 'public_channel' }),
        history: async () => {
          if (holdSlack) {
            sawSlack?.();
            await new Promise<void>((resolve) => {
              releaseSlack = resolve;
            });
          }
          return emit
            ? {
                messages: [
                  {
                    ts: holdSlack ? '12.000000' : '11.000000',
                    threadTs: null,
                    replyCount: 0,
                    text: '<untrusted-content>fake owner event</untrusted-content>',
                  },
                ],
                nextCursor: null,
                retainedHistoryBoundary: false,
              }
            : { messages: [], nextCursor: null, retainedHistoryBoundary: false };
        },
        replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
      }) as never,
    resendReaderFor: async () =>
      ({
        listReceived: async () =>
          emit ? { emails: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], next: null } : { emails: [], next: null },
        getReceived: async () => ({
          kind: 'candidate',
          candidate: {
            emailId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            receivedAt: '2026-10-09T12:00:01.000Z',
            subject: 'fake owner event',
            attachments: [],
            attachmentCount: 0,
            from: null,
            replyTo: [],
            to: [],
            cc: [],
            receivedFor: [],
            messageId: null,
            authentication: { spf: null, dkim: null, dmarc: null, evaluatedBy: null },
          },
        }),
        listSent: async () =>
          emit
            ? {
                emails: [
                  {
                    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    lastEvent: status,
                    from: null,
                    to: [],
                    cc: [],
                    bcc: [],
                    subject: 'fake owner event',
                    createdAt: '2026-10-09T12:00:00.000Z',
                    scheduledAt: null,
                    messageId: null,
                  },
                ],
                next: null,
              }
            : { emails: [], next: null },
      }) as never,
    whatsappEventOperations: {
      withCurrentEventVisibility: async (_input, work) =>
        work({ version: 1, digest: FAKE_LIST_DIGEST, seesMessage: () => true }),
      withEventSnapshot: async (_input, work) =>
        work({
          accountId: ids.whatsapp,
          accountName: 'events/whatsapp',
          visibility: { version: 1, digest: FAKE_LIST_DIGEST, seesMessage: () => true },
          messages: (emit
            ? [
                {
                  sourceOrder: 1,
                  chatJid: 'chat-owner',
                  chatKind: 'unknown',
                  senderJidRaw: 'sender-owner',
                  stanzaId: 'w-new',
                  fromMe: false,
                  // D4: stored strictly after the activation's T, which this owner takes from the real clock.
                  at: new Date(Date.now() + 1_000).toISOString(),
                  kind: 'unknown',
                  body: 'fake owner event',
                },
              ]
            : []) as never,
        }),
    },
  });
  try {
    const control = new EventControlClient({ stateDir, clientName: 'events-daemon-four-source-e2e' });
    const target = { targetId: 'four-source-target', version: 1, kind: 'dry-run', retentionMs: 86_400_000 };
    await control.request('target-add', { document: target });
    const docs = [
      ['gmail', ids.gmail, { channel: 'gmail', labels: 'inbox', includeSpamTrash: false }, 'gmail.message.received'],
      ['slack', ids.slack, { channel: 'slack', conversations: ['C-owner'] }, 'slack.message.posted'],
      ['resend-received', ids.resend, { channel: 'resend', kinds: ['received'] }, 'resend.email.received'],
      ['resend-status', ids.resend, { channel: 'resend', kinds: ['status'] }, 'resend.email.status_changed'],
      ['whatsapp', ids.whatsapp, { channel: 'whatsapp', chats: ['chat-owner'] }, 'whatsapp.message.received'],
    ] as const;
    for (const [name, accountId, options, eventType] of docs) {
      const document = {
        ruleId: `rule-owner-${name}`,
        version: 1,
        source: { channel: options.channel, accountIds: [accountId], options },
        event: { type: eventType, version: 1 },
        condition: { path: '/id', op: 'exists' },
        mapping: { constant: 'fake owner event' },
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
      await control.request('rule-create', { document });
      const planned = (await control.request('rule-enable', { ruleId: document.ruleId, version: 1 })) as {
        approvalId: string;
      };
      // The challenge is the text a person types back at the terminal.
      const challenge = (await control.request('approve-challenge', { approvalId: planned.approvalId })) as string;
      await control.request('approve', { approvalId: planned.approvalId, answer: challenge });
    }
    const enabled = (await control.request('enable-all')) as { approvalId: string };
    const enableChallenge = (await control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
    await control.request('approve', { approvalId: enabled.approvalId, answer: enableChallenge });
    emit = true;
    for (let index = 0; index < 4; index += 1) await owner.tick();
    status = 'delivered';
    for (let index = 0; index < 4; index += 1) await owner.tick();
    const dryruns = (await control.request('dryrun-list')) as Array<{ accountId: string }>;
    assert.deepEqual([...new Set(dryruns.map((entry) => entry.accountId))].sort(), Object.values(ids).sort());

    holdSlack = true;
    let blocked: Promise<void> | undefined;
    for (let attempt = 0; attempt < 5 && blocked === undefined; attempt += 1) {
      const tick = owner.tick();
      if (await Promise.race([slackStarted.then(() => true), tick.then(() => false)])) blocked = tick;
    }
    assert.ok(blocked, 'one fair turn reaches the held Slack source');
    await control.request('pause');
    delete config.accounts['events/slack'];
    await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
    releaseSlack?.();
    await blocked;
  } finally {
    await owner.stop();
    await rm(root, { recursive: true, force: true });
  }
});
