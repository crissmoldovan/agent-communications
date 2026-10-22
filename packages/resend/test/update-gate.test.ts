import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  asV2,
  claimUpdateCheck,
  gatedChange,
  readUpdateCheck,
  UPDATE_CHECK_CHILD_COMMAND,
  updateCheckPath,
  updateLevelChange,
} from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createResendMcpServer } from '../src/mcp/server.ts';
import { coreText } from './support/handoffs.ts';
import { type Harness, newHarness, type ToolResult, tempDir } from './support/harness.ts';

/*
 * The update notice, on Resend's server and command (design 2026-10-16, U1): nothing is refused for being behind. The
 * server's first result carries one line beside it, and a command prints it once on stderr, at most once a day for the
 * machine. The check is turned back on here — the harness turns it off — with a file a check wrote a moment ago, so
 * nothing here asks a registry; Resend is the loopback fake.
 */

function updateOut(harness: Harness, current: { registered: string[]; global: string[] } | null = null): void {
  harness.env.AGENT_COMMS_UPDATE_CHECK = 'on';
  harness.env.npm_config_registry = 'http://127.0.0.1:9/';
  const stateDir = harness.core.paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    updateCheckPath(stateDir),
    JSON.stringify({ lastChecked: new Date().toISOString(), latest: '99.0.0', behind: true, current }),
  );
}

/** An approval this machine holds, prepared before the update was found — as a send approved moments before is. */
async function heldApproval(harness: Harness): Promise<string> {
  const prepared = await gatedChange(harness.core, updateLevelChange(harness.core, 'never'), {
    channel: 'resend',
    surface: 'mcp',
  });
  assert.equal(prepared.status, 'approval-required');
  return (prepared as { prepared: { approvalId: string } }).prepared.approvalId;
}

/**
 * A send approval of the account's, as `resend_send_prepare` leaves one — or, `used`, as a send that went out leaves
 * it: claimed and completed through the store, the way `resend_send_execute` does. Nothing here reaches Resend.
 */
async function sendApproval(harness: Harness, accountId: string, used = false): Promise<string> {
  const expect = { to: ['someone@example.test'], cc: [], bcc: [], subject: 'Hello' };
  const draft = { draftMessageId: 'revision_one', contentDigest: 'a'.repeat(64) };
  const record = await harness.core.approvals.create({
    channel: 'resend',
    sendEpoch: 0,
    inboxId: accountId,
    draftId: 'draft_one',
    ...draft,
    policy: 'chat',
    requiredPolicy: 'chat',
    riskFlags: [],
    expect,
  });
  if (used) {
    const { claimToken } = await harness.core.approvals.claimForSend(record.approvalId, {
      inboxId: accountId,
      ...draft,
      expect,
    });
    await harness.core.approvals.complete(record.approvalId, claimToken, { sentMessageId: 'email_one' });
    assert.equal(asV2(await harness.core.approvals.get(record.approvalId))?.state, 'used');
  }
  return record.approvalId;
}

const code = (result: ToolResult) =>
  (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
const text = (result: ToolResult) =>
  ((result as { content?: { type: string; text?: string }[] }).content ?? []).find((part) => part.type === 'text')
    ?.text ?? '';

const notice = (result: ToolResult) =>
  (result as { structuredContent?: { update?: unknown } }).structuredContent?.update;
const OUT = 'agent-communications 99.0.0 is out; say "update" when it suits you.';

test('an update that is out stops no Resend tool: the first result carries the notice, once, and the doctor never does', async () => {
  const harness = await newHarness();
  try {
    const account = await harness.addAccount({ name: 'acme/resend' });
    const sent = await sendApproval(harness, account.id, true);
    updateOut(harness);
    const { call, close } = await harness.mcp();
    try {
      assert.equal(notice(await call('resend_doctor', {})), undefined, 'the doctor carried the notice');
      const listed = await call('resend_accounts_list', {});
      assert.equal(listed.isError, undefined, JSON.stringify(listed.structuredContent));
      assert.equal(notice(listed), OUT);
      // A send's status is looked up as it always is, and the process does not say it again.
      const status = await call('resend_send_status', { account: 'acme/resend', approvalId: sent });
      assert.equal(status.isError, undefined, JSON.stringify(status.structuredContent));
      assert.equal(notice(status), undefined);
      // A used approval claims nothing: sending under it again is refused by the send gate itself.
      const again = await call('resend_send_execute', {
        account: 'acme/resend',
        approvalId: sent,
        expect: { to: ['someone@example.test'], cc: [], bcc: [], subject: 'Hello' },
      });
      assert.equal(again.isError, true, JSON.stringify(again.structuredContent));
      assert.notEqual(code(again), 'UPDATE_REQUIRED');
    } finally {
      await close();
    }
    // Every registration of Resend's server here names the latest: restart the client. Another channel's, or
    // Resend's global command, says nothing of this server: it is out.
    for (const [current, words] of [
      [{ registered: ['resend'], global: [] }, /is installed; restart the client/],
      [{ registered: ['gmail'], global: ['resend'] }, /is out; say "update"/],
    ] as const) {
      updateOut(harness, { registered: [...current.registered], global: [...current.global] });
      const next = await harness.mcp();
      try {
        assert.match(String(notice(await next.call('resend_accounts_list', {}))), words);
      } finally {
        await next.close();
      }
    }
  } finally {
    await harness.close();
  }
});

test('agent-resend: a command that is behind runs, and says so once on stderr, naming core’s own update', async () => {
  const harness = await newHarness();
  try {
    await harness.addAccount({ name: 'acme/resend' });
    updateOut(harness);
    const listed = await harness.cli(['--json', 'account', 'list']);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.match(listed.stderr, /^agent-communications 99\.0\.0 is out \(this is /m);
    // Core's own, through Resend's installed dependency on it: located, never `agentcomms` by name (CUE-403).
    assert.ok(listed.stderr.includes(`\`${coreText(harness.core, ['update'])}\``), listed.stderr);
    assert.doesNotMatch(listed.stderr, /`agentcomms /);
    assert.doesNotMatch((await harness.cli(['--json', 'account', 'list'])).stderr, /is out/, 'said twice today');
    // Resend's package installed globally at the latest, and this copy older: told to run the installed one.
    updateOut(harness, { registered: [], global: ['resend'] });
    const older = await harness.cli(['--json', 'account', 'list']);
    assert.equal(older.code, 0, older.stdout);
    assert.match(older.stderr, /is installed; this Resend CLI is .*: run it from the installed one\./);
    updateOut(harness);
    const doctor = await harness.cli(['--json', 'doctor']);
    assert.doesNotMatch(doctor.stderr, /is out/);
  } finally {
    await harness.close();
  }
});

test('an approval the report would not claim is refused by it, over MCP and at the terminal: nothing is reported', async () => {
  /*
   * The report took an approval id and claimed none, answering as though it were not there — which once got a call
   * past the update check's stop. It refuses it, as `comms_change_policy` does without `set`.
   */
  const harness = await newHarness();
  try {
    await harness.addAccount({ name: 'acme/resend' });
    const later = await heldApproval(harness);
    updateOut(harness);
    const before = JSON.stringify(await harness.core.config.load());
    const { call, close } = await harness.mcp();
    try {
      const report = await call('resend_account_policy', { account: 'acme/resend', approvalId: later });
      assert.equal(code(report), 'USAGE', JSON.stringify(report.structuredContent));
      assert.match(
        text(report),
        /an approval goes with a policy to set; without `sendPolicy`, `mode` or `changePolicy`/,
      );
      assert.doesNotMatch(text(report), /"sendPolicyFrom"/, 'the policy was reported');
    } finally {
      await close();
    }
    const refused = await harness.cli(['--json', 'account', 'policy', 'acme/resend', '--approval', later]);
    assert.equal(refused.code, 64, refused.stdout + refused.stderr);
    const error = (refused.json() as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /an approval goes with a policy to set; without --send, --mode or --change/);

    assert.equal(JSON.stringify(await harness.core.config.load()), before, 'the account was changed');
    assert.equal(asV2(await harness.core.approvals.get(later))?.state, 'pending', 'the approval was claimed');
  } finally {
    await harness.close();
  }
});

test('agent-resend finishes the update check a command handed on: under its claim, with no notice, and not in help', async () => {
  // The child a command starts for the day's check (#48) is this CLI again, with the hidden command and the claim.
  const harness = await newHarness();
  try {
    updateOut(harness);
    // A day old, so every other command would ask first — and, with an update out, say so.
    const stateDir = harness.core.paths.stateDir;
    writeFileSync(updateCheckPath(stateDir), JSON.stringify({ latest: '99.0.0', behind: true }));
    const claimedAt = await claimUpdateCheck(harness.core);
    assert.ok(claimedAt !== null);
    const ambient = tempDir('agent-resend-update-ambient-');
    const { configDir, stateDir: pinnedState, dataDir, secretsDir, downloadsDir } = harness.core.paths;
    const child = await harness.cli(
      [
        '--json',
        '--config-dir',
        configDir,
        '--state-dir',
        pinnedState,
        '--data-dir',
        dataDir,
        '--secrets-dir',
        secretsDir,
        '--downloads-dir',
        downloadsDir,
        UPDATE_CHECK_CHILD_COMMAND,
        claimedAt,
      ],
      {
        env: {
          AGENT_COMMS_CONFIG_DIR: join(ambient, 'config'),
          AGENT_COMMS_STATE_DIR: join(ambient, 'state'),
          AGENT_COMMS_DATA_DIR: join(ambient, 'data'),
          HOME: join(ambient, 'home'),
          USERPROFILE: join(ambient, 'home'),
        },
      },
    );
    assert.equal(child.code, 0, child.stdout + child.stderr);
    // The registry here refuses at once: the ask is recorded as the day's, with why, and the claim given up.
    const record = await readUpdateCheck(stateDir);
    assert.deepEqual([record.lastChecked, record.checking], [claimedAt, null]);
    assert.match(String(record.lastError), /could not be reached/);
    assert.doesNotMatch((await harness.cli(['--help'])).stdout, new RegExp(UPDATE_CHECK_CHILD_COMMAND));
  } finally {
    await harness.close();
  }
});

// ── The day's check, handed to core's CLI (design 2026-10-22, P2) ──────────────────────────────────────────────

/** Core's CLI as Resend finds it from this checkout: through its own dependency on core, at its own version. */
const CORE_CLI = realpathSync(fileURLToPath(new URL('../node_modules/@agentcomms/core/src/cli.ts', import.meta.url)));

/** The check on and due — the file a day old — with a registry port nobody answers on. */
function updateDue(harness: Harness): void {
  harness.env.AGENT_COMMS_UPDATE_CHECK = 'on';
  harness.env.npm_config_registry = 'http://127.0.0.1:9/';
  const stateDir = harness.core.paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    updateCheckPath(stateDir),
    JSON.stringify({
      lastChecked: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      latest: '99.0.0',
      behind: true,
    }),
  );
}

/** A start that starts nothing: it records the words it was handed, and says it started them. */
function recordingStart() {
  const started: string[][] = [];
  const start = async (words: readonly string[]) => {
    started.push([...words]);
    return true;
  };
  return { started, start };
}

/** The words start core's CLI with the hidden command, under the claim the file holds. */
async function assertCoreHandOff(harness: Harness, started: string[][]): Promise<void> {
  assert.equal(started.length, 1, JSON.stringify(started));
  const [words] = started as [string[]];
  const claimedAt = (await readUpdateCheck(harness.core.paths.stateDir)).checking;
  assert.equal(typeof claimedAt, 'string', 'the check was not claimed');
  assert.deepEqual(words.slice(-2), [UPDATE_CHECK_CHILD_COMMAND, claimedAt]);
  assert.ok(words.includes(CORE_CLI), `not core's CLI: ${JSON.stringify(words)}`);
  assert.equal(words[words.indexOf('--config-dir') + 1], harness.core.paths.configDir);
}

test("agent-resend hands the day's check to core's CLI", async () => {
  const harness = await newHarness();
  try {
    updateDue(harness);
    const handed = recordingStart();
    const code = await run(['--json', 'account', 'list'], {
      core: harness.core,
      env: harness.env,
      fetch: harness.fake.fetch,
      throttle: { intervalMs: 0 },
      platform: 'darwin',
      streams: { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() },
      updateHandOff: { start: handed.start },
    });
    assert.equal(code, 0);
    await assertCoreHandOff(harness, handed.started);
  } finally {
    await harness.close();
  }
});

test('the Resend server hands its check to core’s CLI', async () => {
  const harness = await newHarness();
  try {
    updateDue(harness);
    const handed = recordingStart();
    const { server } = await createResendMcpServer({
      core: harness.core,
      env: harness.env,
      fetch: harness.fake.fetch,
      throttle: { intervalMs: 0 },
      platform: 'darwin',
      updateHandOff: { start: handed.start },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const listed = (await client.callTool({ name: 'resend_accounts_list', arguments: {} })) as ToolResult;
      assert.notEqual(listed.isError, true, JSON.stringify(listed.structuredContent));
      // The check runs beside the call, never before its answer: waited for here.
      for (const deadline = Date.now() + 10_000; handed.started.length === 0 && Date.now() < deadline; ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await assertCoreHandOff(harness, handed.started);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  } finally {
    await harness.close();
  }
});
