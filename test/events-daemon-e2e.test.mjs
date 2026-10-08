import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { openCore } from '../packages/core/src/index.ts';
import { run as runCli } from '../packages/events-daemon/src/cli/program.ts';
import { createEventsMcpServer } from '../packages/events-daemon/src/mcp/server.ts';
import { approve, disclosureChallenge } from '../packages/events-daemon/src/operations/approve.ts';
import { assertDisclosable } from '../packages/events-daemon/src/runtime/disclosure-fence.ts';
import { DryRunDispatcher } from '../packages/events-daemon/src/runtime/dispatcher.ts';
import { EventEvaluator } from '../packages/events-daemon/src/runtime/evaluate.ts';
import { startEventOwner } from '../packages/events-daemon/src/runtime/owner.ts';
import { recordEventTaint } from '../packages/events-daemon/src/runtime/untrusted.ts';
import { MailboxLock } from '../packages/events-daemon/src/sources/mailbox-lock.ts';
import { GmailSourceWorker } from '../packages/events-daemon/src/sources/source-worker.ts';
import { openEventDatabase } from '../packages/events-daemon/src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../packages/events-daemon/src/store/event-secrets.ts';
import { EventRecordCipher } from '../packages/events-daemon/src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from '../packages/events-daemon/test/support/short-temp.ts';
import { GmailContext } from '../packages/gmail/src/context.ts';
import { createGmailEventSource } from '../packages/gmail/src/operations/events.ts';
import { DRAFT_SEND_PATH } from '../packages/gmail/test/support/fake-google.ts';
import { newHarness } from '../packages/gmail/test/support/harness.ts';
import { sealToLoopback } from './helpers/loopback-seal.mjs';

// Sealed before anything runs: a path that ignores the fake (a built Gmail package never honours its loopback
// override) fails here instead of reaching the real Google. An earlier draft of this test did exactly that.
const refused = sealToLoopback();

const requireFromDaemon = createRequire(new URL('../packages/events-daemon/package.json', import.meta.url));
const { Client } = requireFromDaemon('@modelcontextprotocol/client');
const { InMemoryTransport } = requireFromDaemon('@modelcontextprotocol/server');

function streams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(stdin, { isTTY: true });
  Object.assign(stdout, { isTTY: true });
  Object.assign(stderr, { isTTY: true });
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  return { streams: { stdin, stdout, stderr }, stdout: () => out, stderr: () => err };
}

async function cli(argv) {
  const io = streams();
  const code = await runCli(argv, { streams: io.streams });
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

async function withHumanEnvironment(env, work) {
  const saved = new Map();
  for (const name of [
    'AGENT_COMMS_CONFIG_DIR',
    'AGENT_COMMS_GOOGLE_ROOT_URL',
    'HOME',
    'USERPROFILE',
    'NO_COLOR',
    'AGENT_COMMS_UPDATE_CHECK',
    'CI',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CODEX_SANDBOX',
    'CODEX_HOME',
    'CURSOR_AGENT',
    'GEMINI_CLI',
    'AGENT_COMMS_AGENT',
  ])
    saved.set(name, process.env[name]);
  Object.assign(process.env, env, { CI: '0' });
  for (const name of [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CODEX_SANDBOX',
    'CODEX_HOME',
    'CURSOR_AGENT',
    'GEMINI_CLI',
    'AGENT_COMMS_AGENT',
  ])
    delete process.env[name];
  try {
    return await work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const retention = {
  ingestMs: 3_600_000,
  holdMs: 3_600_000,
  deliveryMs: 3_600_000,
  dryrunMs: 3_600_000,
  sseReplayMs: 3_600_000,
  deadLetterMs: 3_600_000,
  decisionMetadataMs: 7_200_000,
};

test('REL-B1: the packed daemon consumer starts a foreground owner and controls it through the installed CLI', async () => {
  const check = await readFile(new URL('../packages/events-daemon/test/consumer-check.mjs', import.meta.url), 'utf8');
  assert.match(check, /spawn\(/, 'the packed consumer starts the foreground owner');
  assert.match(check, /'run'/, 'the foreground owner is the CLI run surface');
  assert.match(check, /'stop'/, 'the packed consumer asks the owner to stop through the CLI');
  assert.match(check, /'running'/, 'the packed consumer observes the live owner before stopping it');
  assert.match(check, /'initialize'/, 'the packed consumer starts a standard MCP handshake');
  assert.match(check, /'tools\/call'/, 'the packed consumer calls the installed MCP surface');
  assert.match(check, /'events_status'/, 'the packed consumer uses a content-free MCP tool');
});

test('REL-B1: the Gmail end-to-end path is sealed to the repository fake', async () => {
  const source = await readFile(new URL(import.meta.url), 'utf8');
  assert.match(source, /packages\/gmail\/test\/support\/harness\.ts/);
  assert.match(source, /newHarness\(/);
  assert.match(source, /gmailSourceFor:/, 'the owner is handed the fake-backed Gmail source, never the built one');
  // A reserved name stands in for any provider host: the seal refuses it before it is looked up or connected.
  const net = await import('node:net');
  assert.throws(() => net.connect(443, 'provider.example.test'), /loopback seal/);
  assert.ok(refused.includes('provider.example.test'), 'the seal refuses every host that is not loopback');
  refused.length = 0;
  assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1)/, 'the test may not name a real Google endpoint');
});

test('REL-B1: a fake-Google Gmail event crosses the foreground owner, CLI and MCP control boundary into a terminal-only dry-run', {
  skip: WINDOWS_SKIP,
}, async () => {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'events-e2e-subject',
        email: 'events@example.test',
        profile: { historyId: '201' },
        history: {
          pages: {
            first: {
              historyId: '202',
              history: [
                {
                  id: '202',
                  messagesAdded: [{ message: { id: 'message-e2e', threadId: 'thread-e2e' } }],
                },
              ],
            },
          },
        },
        messages: {
          'message-e2e': {
            id: 'message-e2e',
            threadId: 'thread-e2e',
            labelIds: ['INBOX'],
            internalDate: '1760000000000',
            payload: {
              partId: '',
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Sender <sender@example.test>' },
                { name: 'Subject', value: 'Local fake event' },
              ],
              body: { size: 0 },
            },
          },
        },
      },
    ],
  });
  const inbox = await harness.connectInbox({
    alias: 'events',
    email: 'events@example.test',
    sub: 'events-e2e-subject',
  });
  const stateDir = await shortTempDir('events-e2e-');
  let owner;
  let store;
  try {
    await withHumanEnvironment(harness.env, async () => {
      const selected = await openEventDatabase({ stateDir });
      await selectEventSecretStore(selected.database, 'file');
      selected.close();
      owner = await startEventOwner({
        stateDir,
        configDir: harness.configDir,
        // The activation's one profile baseline goes to the loopback fake through Gmail's source, never the build.
        gmailSourceFor: ({ alias }) =>
          createGmailEventSource({ alias, context: new GmailContext({ core: harness.core, env: harness.env }) }),
      });

      const { server } = await createEventsMcpServer({ stateDir });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'events-e2e', version: '0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const target = { targetId: 'dry-e2e', version: 1, kind: 'dry-run', retentionMs: 3_600_000 };
      try {
        await client.callTool({ name: 'events_target_add', arguments: { document: target } });
      } finally {
        await Promise.all([client.close(), server.close()]);
      }

      const rule = {
        ruleId: 'rule-e2e',
        version: 1,
        source: {
          channel: 'gmail',
          accountIds: [inbox.id],
          options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
        },
        event: { type: 'gmail.message.received', version: 1 },
        condition: { path: '/subject', op: 'exists' },
        mapping: { subject: { $path: '/subject' } },
        targets: [target],
        subscribers: [],
        judges: [],
        deliveryRateCap: 1,
        retention,
      };
      const created = await cli(['--state-dir', stateDir, 'rule', 'create', JSON.stringify(rule)]);
      assert.equal(created.code, 0, created.stderr);
      const enabled = await cli(['--state-dir', stateDir, 'rule', 'enable', rule.ruleId, '1']);
      assert.equal(enabled.code, 0, enabled.stderr);
      const prepared = JSON.parse(enabled.stdout);
      const challenge = await disclosureChallenge(prepared.approvalId, { stateDir });
      assert.equal((await approve(prepared.approvalId, challenge, { stateDir })).status, 'completed');
      const all = await cli(['--state-dir', stateDir, 'enable-all']);
      assert.equal(all.code, 0, all.stderr);
      const allPrepared = JSON.parse(all.stdout);
      const allChallenge = await disclosureChallenge(allPrepared.approvalId, { stateDir });
      assert.equal((await approve(allPrepared.approvalId, allChallenge, { stateDir })).status, 'completed');

      // The components the owner will run in B2 are driven here directly, on the owner's own folders: its core
      // approvals, configuration and taint, not the Gmail harness's.
      const ownerCore = openCore({ pathOverrides: { stateDir, configDir: harness.configDir } });
      store = await openEventDatabase({ stateDir });
      store.database
        .prepare(
          `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
           VALUES ('gmail', ?, 'mailbox', '201', 0)`,
        )
        .run(inbox.id);
      const cipher = new EventRecordCipher(
        store.database,
        await openEventSecretStore({ database: store.database, paths: store.paths, configDir: harness.configDir }),
      );
      const source = await createGmailEventSource({
        alias: 'events',
        context: new GmailContext({ core: harness.core, env: harness.env }),
      });
      const evaluator = new EventEvaluator({
        store,
        cipher,
        approvals: ownerCore.approvals,
        config: ownerCore.config,
        taint: {
          record: (input) => recordEventTaint(ownerCore.taint, { ownAddresses: [], internalDomains: [] }, input),
        },
      });
      const sourceRule = {
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        eventType: rule.event.type,
        options: rule.source.options,
        ingestRetentionMs: rule.retention.ingestMs,
      };
      const location = (id) => ({
        table: 'source_scan_state',
        column: 'encryptedRecord',
        key: [{ type: 'text', value: id }],
      });
      const worker = new GmailSourceWorker({
        store,
        source,
        mailbox: { accountId: inbox.id, name: 'events' },
        mailboxLock: new MailboxLock(),
        rules: () => [sourceRule],
        assertDisclosable: () =>
          assertDisclosable({
            database: store.database,
            approvals: ownerCore.approvals,
            config: ownerCore.config,
            accountId: inbox.id,
            boundary: 'source',
            ruleId: rule.ruleId,
            ruleVersion: rule.version,
            switchGeneration: 0,
          }),
        admit: (occurrence) => evaluator.admitGmailOccurrence(occurrence),
        encryptStage: (value) =>
          cipher.encrypt(location(`gmail-history:${inbox.id}:201:0`), Buffer.from(JSON.stringify(value))),
        decryptStage: async (value) =>
          JSON.parse((await cipher.decrypt(location(`gmail-history:${inbox.id}:201:0`), value)).toString('utf8')),
      });
      assert.deepEqual(await worker.scan(), { cursor: '202', pending: false });

      const deliveryId = store.database.prepare('SELECT id FROM deliveries').get().id;
      const dispatcher = new DryRunDispatcher({
        store,
        cipher,
        approvals: ownerCore.approvals,
        config: ownerCore.config,
      });
      assert.deepEqual(await dispatcher.dispatch(deliveryId), { state: 'delivered', deliveryId });
      store.close();
      store = undefined;

      const shown = await cli(['--state-dir', stateDir, 'dryrun', 'show', deliveryId]);
      assert.equal(shown.code, 0, shown.stderr);
      assert.match(shown.stdout, /<untrusted-content/);
      assert.match(shown.stdout, /Local fake event/);
      assert.equal((await cli(['--state-dir', stateDir, 'stop'])).code, 0);
      await owner.stopped;
      owner = undefined;
    });

    assert.deepEqual(refused, [], 'nothing in the flow tried to leave loopback');
    assert.ok(
      harness.google.requests.some((request) => request.path.endsWith('/profile')),
      'the activation baseline reached the fake Google',
    );
    assert.match(harness.google.url, /^http:\/\/127\.0\.0\.1:/);
    assert.ok(harness.google.requests.every((request) => request.path.startsWith('/')));
    assert.equal(
      harness.google.requests.filter((request) => request.path.endsWith(DRAFT_SEND_PATH)).length,
      0,
      'the sealed end-to-end flow does not use Gmail send',
    );
  } finally {
    store?.close();
    await owner?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});
