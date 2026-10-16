import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  asV2,
  claimUpdateCheck,
  gatedChange,
  readUpdateCheck,
  stateOf,
  UPDATE_CHECK_CHILD_COMMAND,
  updateCheckPath,
  updateLevelChange,
} from '@agentcomms/core';
import { locatedCoreLine } from './support/handoffs.ts';
import { type Harness, newHarness, tempDir } from './support/harness.ts';
import { cli, connect, type ToolResult } from './support/surfaces.ts';

/*
 * The update notice, on Gmail's server and command (design 2026-10-16, U1): nothing is refused for being behind. The
 * server's first result carries one line beside it, and a command prints it once on stderr, at most once a day for the
 * machine. The check is turned back on here — the harness turns it off — with a file a check wrote a moment ago, so
 * nothing here asks a registry; `npm_config_registry` points at a port nobody answers on besides.
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
    channel: 'gmail',
    surface: 'mcp',
  });
  assert.equal(prepared.status, 'approval-required');
  return (prepared as { prepared: { approvalId: string } }).prepared.approvalId;
}

const OUT = 'agent-communications 99.0.0 is out; say "update" when it suits you.';
const notice = (result: ToolResult) => (result.structuredContent as { update?: unknown } | undefined)?.update;
const texts = (result: ToolResult) =>
  (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');

test('an update that is out stops no Gmail tool: the first result carries the notice, once, and the doctor never does', async () => {
  const harness = await newHarness();
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', refreshToken: 'fake-refresh-token' });
  updateOut(harness);
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const doctor = await call('gmail_doctor', {});
    assert.equal(notice(doctor), undefined, 'the doctor carried the notice');
    // A tool with an output schema the client checks the result against: it takes the one carrying the notice.
    const listed = await call('gmail_inboxes_list', {});
    assert.notEqual(listed.isError, true, JSON.stringify(listed.structuredContent));
    assert.equal(notice(listed), OUT);
    assert.ok(Array.isArray((listed.structuredContent as { inboxes?: unknown }).inboxes), 'the result is all there');
    assert.ok(texts(listed).includes(OUT), texts(listed));
    const again = await call('gmail_inboxes_list', {});
    assert.equal(notice(again), undefined, 'the process repeated it');
    assert.ok(!texts(again).includes(OUT));
  } finally {
    await close();
  }
  // Every registration of Gmail's server here names the latest: restart the client. Another channel's, or Gmail's
  // global command, says nothing of this server: it is out.
  for (const [current, words] of [
    [{ registered: ['gmail'], global: [] }, /^agent-communications 99\.0\.0 is installed; restart the client/],
    [{ registered: ['slack'], global: ['gmail'] }, /^agent-communications 99\.0\.0 is out; say "update"/],
  ] as const) {
    updateOut(harness, { registered: [...current.registered], global: [...current.global] });
    const next = await connect({ core: harness.core, env: harness.env });
    try {
      assert.match(String(notice(await next.call('gmail_inboxes_list', {}))), words);
    } finally {
      await next.close();
    }
  }
});

test('agent-gmail: a command that is behind runs, and says so once on stderr, naming core’s own update', async () => {
  const harness = await newHarness();
  updateOut(harness);
  const listed = await cli(harness, ['inbox', 'list', '--json']);
  assert.equal(listed.code, 0, listed.stdout + listed.stderr);
  assert.equal(listed.envelope<unknown>().ok, true, 'the command ran');
  assert.match(listed.stderr, /^agent-communications 99\.0\.0 is out \(this is /m);
  // Core's own command, located from Gmail through its runtime dependency on core (CUE-403).
  locatedCoreLine(listed.stderr, ['update']);
  // Not again today, on this machine.
  const second = await cli(harness, ['inbox', 'list', '--json']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.doesNotMatch(second.stderr, /is out/);
  // The doctor, and the listener a sign-in starts, never say it. (This flow does not exist, so it ends for that.)
  updateOut(harness);
  const doctor = await cli(harness, ['doctor', '--json']);
  assert.doesNotMatch(doctor.stderr, /is out/, doctor.stderr);
  const listener = await cli(harness, ['oauth-listen', 'flow_none', '--json']);
  assert.doesNotMatch(listener.stderr, /is out/, listener.stderr);
  // Gmail's package installed globally at the latest, and this copy older: told to run the installed one.
  updateOut(harness, { registered: [], global: ['gmail'] });
  const older = await cli(harness, ['inbox', 'list', '--json']);
  assert.equal(older.code, 0, older.stdout);
  assert.match(older.stderr, /is installed; this Gmail CLI is .*: run it from the installed one\./);
});

test('agent-gmail: an approval a run would not claim is refused by a finish, and by a setup that would not claim it', async () => {
  /*
   * An approval handed to a path that would not claim it is refused, before anything is done. `inbox reauth --finish`
   * took `--approval` and claimed none; `setup` claimed each of its two only at the step that uses it, and a run that
   * never got there dropped it after doing the steps before — a sign-in started, a preview prepared. (The update
   * check's stop once let such a command past it; nothing is stopped now, and the refusal stands on its own.)
   */
  const harness = await newHarness();
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', refreshToken: 'fake-refresh-token' });
  const later = await heldApproval(harness);
  updateOut(harness);
  const before = JSON.stringify(await harness.core.config.load());
  for (const [argv, words] of [
    // A flow id of the right shape that nothing started: without the refusal, the finish looks it up.
    [
      ['inbox', 'reauth', 'work', '--finish', `fl_${'0'.repeat(22)}`, '--approval', later],
      /--finish collects a sign-in/,
    ],
    // A client is registered already: no step of this run registers one.
    [
      ['setup', '--inbox', 'work', '--approval', later],
      /already registered, so this run registers none and takes no --approval/,
    ],
    // No client named: nothing claims the registration's approval, whatever the run reaches.
    [['setup', '--inbox', 'work', '--mcp-approval', later], /names no client with --mcp-client/],
    // A mailbox to sign in first: the run stops at its browser, before the registration.
    [
      ['setup', '--mcp-client', 'cursor', '--inbox', 'home', '--mcp-approval', later],
      /signs a mailbox in first, and that waits for a browser/,
    ],
  ] as const) {
    const refused = await cli(harness, [...argv, '--json']);
    assert.equal(refused.code, 64, `${argv.join(' ')}: ${refused.stdout}${refused.stderr}`);
    const error = refused.envelope<unknown>().error as { code: string; message: string };
    assert.equal(error.code, 'USAGE', argv.join(' '));
    assert.match(error.message, words, argv.join(' '));
  }
  assert.equal(JSON.stringify(await harness.core.config.load()), before, 'a mailbox or a client was changed');
  assert.deepEqual(
    (await harness.core.approvals.list()).map((record) => [asV2(record)?.approvalId, stateOf(record)]),
    [[later, 'pending']],
    'an approval was claimed, or another prepared',
  );
});

test('agent-gmail finishes the update check a command handed on: under its claim, with no notice, and not in help', async () => {
  // The child a command starts for the day's check (#48) is this CLI again, with the hidden command and the claim.
  const harness = await newHarness();
  updateOut(harness);
  // A day old, so every other command would ask first — and, with an update out, say so.
  const stateDir = harness.core.paths.stateDir;
  writeFileSync(updateCheckPath(stateDir), JSON.stringify({ latest: '99.0.0', behind: true }));
  const claimedAt = await claimUpdateCheck(harness.core);
  assert.ok(claimedAt !== null);
  const ambient = tempDir('agent-gmail-update-ambient-');
  const { configDir, stateDir: pinnedState, dataDir, secretsDir, downloadsDir } = harness.core.paths;
  const child = await cli(
    harness,
    [
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
      '--json',
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
  assert.doesNotMatch(child.stderr, /is out/, 'the child gave the notice');
  // The registry here refuses at once: the ask is recorded as the day's, with why, and the claim given up.
  const record = await readUpdateCheck(stateDir);
  assert.deepEqual([record.lastChecked, record.checking], [claimedAt, null]);
  assert.match(String(record.lastError), /could not be reached/);
  assert.doesNotMatch((await cli(harness, ['--help'])).stdout, new RegExp(UPDATE_CHECK_CHILD_COMMAND));
});
