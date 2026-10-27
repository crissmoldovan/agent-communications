import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ConnectionPartResult, EXIT_CODES } from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { clientAdd } from '../src/operations/clients.ts';
import { gmailCommand, gmailRetryWords } from './support/handoffs.ts';
import { newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';
import { cli, connect, pendingApproval, wire } from './support/surfaces.ts';

/*
 * `agent-gmail mcp install` from 0.35.0 (single-server design D17): Gmail put into the app's MCP connection — or, where
 * the app has none, a connection made for it with Agent Comms itself and Gmail — through the change
 * comms_connection_change makes with `add`, approved the same way. What names an entry of Gmail's own is refused
 * without `--standalone`, never taken as asking for one; `--standalone` registers that entry as before, which
 * registration.test.ts holds to its old behaviour.
 *
 * Every client config is under a temporary home; the connection's parts start with `npx`, which nothing runs here
 * (`--no-verify`), so nothing is fetched, verified or started.
 */

async function machine() {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const home = tempDir();
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  return { harness, home, env, cursor: join(home, '.cursor', 'mcp.json') };
}

const cursorEntries = (path: string) =>
  existsSync(path)
    ? ((JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, { args: string[] }> }).mcpServers ?? {})
    : {};

test('D17: mcp install puts Gmail into a connection it makes for the app, approved, with one entry: Agent Comms’', async () => {
  const { harness, env, cursor } = await machine();
  const words = ['mcp', 'install', '--client', 'cursor', '--launcher', 'npx', '--no-verify', '--json'];
  const asked = await cli(harness, words, { env });
  const approvalId = pendingApproval(asked);
  const preview = String(asked.envelope().error?.details?.preview);
  assert.match(preview, /Add the connection "Cursor" for Cursor/);
  assert.match(preview, /Agent Comms itself; Gmail, every mailbox/);
  assert.equal(existsSync(cursor), false, 'nothing written while it waits');
  const done = await cli(harness, [...words, '--approval', approvalId], { env });
  assert.equal(done.code, 0, done.stdout + done.stderr);
  const result = done.envelope<ConnectionPartResult>().data as ConnectionPartResult;
  assert.equal(result.created, true);
  assert.deepEqual(
    result.connection.parts.map((part) => part.server),
    ['core', 'gmail'],
  );
  const entries = cursorEntries(cursor);
  assert.deepEqual(Object.keys(entries), ['agentcomms'], 'no entry of Gmail’s own');
  assert.deepEqual(entries.agentcomms?.args.slice(-3), ['mcp', '--connection', result.connection.id]);
  // Pinned on the next call: a narrowing, applied at once and said so.
  const pinned = await cli(harness, ['mcp', 'install', '--client', 'cursor', '--inbox', 'work', '--json'], { env });
  assert.equal(pinned.code, 0, pinned.stdout + pinned.stderr);
  assert.deepEqual(pinned.envelope<ConnectionPartResult>().data?.appliedAtOnce, ['Gmail kept to work']);
  // And at a terminal, read as a person reads it.
  const again = await cli(harness, ['mcp', 'install', '--client', 'cursor', '--inbox', 'work'], { env });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /Gmail is a part of "Cursor" already, as asked: nothing was changed\./);
});

test('D17: what names an entry of Gmail’s own is refused without --standalone, and --connection is refused with it', async () => {
  const { harness, env, cursor } = await machine();
  for (const [extra, said] of [
    [['--client', 'json'], /--client json is for an entry of its own: add --standalone/],
    [['--client', 'cursor', '--print'], /--print is for an entry of its own: add --standalone/],
    [['--client', 'cursor', '--force'], /--force is for an entry of its own: add --standalone/],
    [['--client', 'cursor', '--name', 'work-mail'], /--name is for an entry of its own: add --standalone/],
  ] as const) {
    const run = await cli(harness, ['mcp', 'install', ...extra, '--no-verify', '--json'], { env });
    assert.equal(run.code, EXIT_CODES.USAGE, `${extra.join(' ')}: ${run.stdout}`);
    assert.match(String(run.envelope().error?.message), said);
  }
  const both = await cli(
    harness,
    ['mcp', 'install', '--client', 'cursor', '--standalone', '--connection', 'cn_0123456789ABCDEFGHJKMNPQRS', '--json'],
    { env },
  );
  assert.equal(both.code, EXIT_CODES.USAGE, both.stdout);
  assert.match(String(both.envelope().error?.message), /--connection names the connection to put Gmail into/);
  assert.equal(existsSync(cursor), false);
  // The way back: an entry of its own, as before 0.35.0.
  const own = await cli(
    harness,
    ['mcp', 'install', '--client', 'cursor', '--standalone', '--launcher', 'npx', '--no-verify', '--json'],
    { env },
  );
  const id = pendingApproval(own);
  assert.match(String(own.envelope().error?.details?.preview), /registers the Gmail MCP server with cursor as "gmail"/);
  const registered = await cli(
    harness,
    [
      'mcp',
      'install',
      '--client',
      'cursor',
      '--standalone',
      '--launcher',
      'npx',
      '--no-verify',
      '--json',
      '--approval',
      id,
    ],
    { env },
  );
  assert.equal(registered.code, 0, registered.stdout);
  assert.deepEqual(Object.keys(cursorEntries(cursor)), ['gmail']);
});

/*
 * `setup --mcp-client` and the `inbox add --finish` of a sign-in it handed off (D17, the lead's decision): from 0.35.0
 * they put Gmail into the app's connection as `mcp install` does — the same change, so `mcp install --approval` claims
 * what the finish prepared — and `--standalone` keeps the entry of Gmail's own, which registration.test.ts holds.
 * `--launcher local` needs nothing from npm: the connection's entry starts Agent Comms from this checkout.
 */

/** A machine past its OAuth client step, with no mailbox, and a home of its own for the client configs. */
async function clientOnly() {
  const harness = await newHarness({ accounts: [{ sub: 'sub-2', email: 'sam@example.test' }] });
  const file = join(tempDir(), 'client_secret.json');
  await writeFile(
    file,
    JSON.stringify({ installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET } }),
  );
  await clientAdd(new GmailContext({ core: harness.core, env: harness.env }), { path: file, store: 'file' });
  const home = tempDir();
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  return { harness, env, cursor: join(home, '.cursor', 'mcp.json') };
}

const SETUP = [
  'setup',
  '--inbox',
  'home',
  '--email',
  'sam@example.test',
  '--mcp-client',
  'cursor',
  '--launcher',
  'local',
];

interface HandOff {
  handoff: { authUrl: string; finish: string; registerWith?: Record<string, unknown> };
  blocked: { step: string; hint: string };
}

/** `setup` handing the sign-in off, as an agent runs it, and the browser coming back. */
async function handedOff(machine: Awaited<ReturnType<typeof clientOnly>>): Promise<HandOff> {
  const run = await cli(machine.harness, [...SETUP, '--json'], { env: machine.env });
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const report = run.envelope<HandOff>().data;
  assert.ok(report?.handoff, run.stdout);
  await fetch(machine.harness.google.consent(report.handoff.authUrl));
  return report;
}

test('D17: setup --mcp-client puts Gmail into the app’s connection — approved, claimed with --mcp-approval — and counts it done', async () => {
  const { harness, env, cursor } = await machine();
  const argv = ['setup', '--mcp-client', 'cursor', '--launcher', 'local', '--json'];
  const first = await cli(harness, argv, { env });
  assert.equal(first.code, EXIT_CODES.APPROVAL, `${first.stdout}${first.stderr}`);
  const report = first.envelope<{
    did: string[];
    blocked: { step: string; needs: string; approvalId: string; preview: string; hint: string };
  }>().data;
  assert.equal(report?.blocked.step, 'mcp');
  assert.equal(report?.blocked.needs, "a person's approval to put Gmail into cursor's MCP connection");
  assert.match(String(report?.blocked.preview), /Add the connection "Cursor" for Cursor/);
  assert.match(String(report?.blocked.preview), /Agent Comms itself; Gmail, every mailbox/);
  assert.doesNotMatch(String(report?.blocked.preview), /registers the Gmail MCP server/);
  assert.match(
    String(report?.blocked.hint),
    / setup --mcp-client cursor --launcher local --json --mcp-approval ap_\w+`/,
  );
  assert.equal(existsSync(cursor), false, 'nothing written while it waits');

  const done = await cli(harness, [...argv, '--mcp-approval', String(report?.blocked.approvalId)], { env });
  assert.equal(done.code, 0, `${done.stdout}${done.stderr}`);
  const after = done.envelope<{ did: string[]; registeredWith: string[]; next: string }>().data;
  assert.deepEqual(after?.did, ['made the connection "Cursor" for cursor, with Agent Comms itself and Gmail']);
  const entries = cursorEntries(cursor);
  assert.deepEqual(Object.keys(entries), ['agentcomms'], 'no entry of Gmail’s own');
  assert.equal(entries.agentcomms?.args.includes('--connection'), true);
  // The agent step is behind it now: the connection counts as Gmail registered with cursor.
  assert.deepEqual(after?.registeredWith, ['cursor']);
  assert.equal(after?.next, 'done');
});

test('D17: setup refuses --replace-server without --standalone, before anything is asked or done', async () => {
  const { harness, env, cursor } = await machine();
  const run = await cli(harness, ['setup', '--mcp-client', 'cursor', '--replace-server', '--json'], { env });
  assert.equal(run.code, EXIT_CODES.USAGE, run.stdout);
  assert.match(
    String(run.envelope().error?.message),
    /--replace-server is for an entry of its own: add --standalone, or leave it out/,
  );
  assert.deepEqual(await harness.core.approvals.list(), [], 'nothing was prepared');
  assert.equal(existsSync(cursor), false);
});

test('D17: the finish of a sign-in setup handed off prepares Gmail into the connection, and mcp install --approval claims it', async () => {
  const machine = await clientOnly();
  const report = await handedOff(machine);
  assert.deepEqual(report.handoff.registerWith, { client: 'cursor', launcher: 'local' });
  assert.match(report.blocked.hint, /also puts Gmail into the MCP connection of cursor/);

  const finished = await cli(machine.harness, [...gmailRetryWords(report.handoff.finish), '--json'], {
    env: machine.env,
  });
  assert.equal(finished.code, EXIT_CODES.APPROVAL, `${finished.stdout}${finished.stderr}`);
  const registration = finished.envelope<{
    alias: string;
    registration: { client: string; status: string; approvalId: string; preview: string; claim: string };
  }>().data?.registration;
  assert.equal(registration?.status, 'approval-required');
  assert.match(String(registration?.preview), /Add the connection "Cursor" for Cursor/);
  // This installation's own `mcp install`, with no --standalone: the same change, located.
  assert.equal(
    registration?.claim,
    gmailCommand(
      machine.harness.core.paths,
      ['mcp', 'install', '--client', 'cursor', '--launcher', 'local', '--approval', String(registration?.approvalId)],
      'darwin',
    ),
  );
  assert.equal(existsSync(machine.cursor), false, 'nothing is registered before the person agrees');

  const claimed = await cli(machine.harness, [...gmailRetryWords(String(registration?.claim)), '--json'], {
    env: machine.env,
  });
  assert.equal(claimed.code, 0, `${claimed.stdout}${claimed.stderr}`);
  assert.equal(claimed.envelope<ConnectionPartResult>().data?.created, true);
  assert.deepEqual(Object.keys(cursorEntries(machine.cursor)), ['agentcomms']);

  // Read by a person: connected, then what waits, and the command that claims it — no --standalone in it.
  const other = await clientOnly();
  const plain = await cli(other.harness, gmailRetryWords((await handedOff(other)).handoff.finish), { env: other.env });
  assert.equal(plain.code, EXIT_CODES.APPROVAL, `${plain.stdout}${plain.stderr}`);
  assert.match(plain.stdout, /CHANGE PREVIEW[\s\S]*Add the connection "Cursor" for Cursor/);
  assert.match(plain.stdout, /run `[^`]* mcp install --client cursor --launcher local --approval ap_\w+`/);
});

test('D17: a finish whose app’s connection reaches the mailbox already changes nothing; gmail_inbox_finish hands back comms_connection_change', async () => {
  // Over MCP, with no connection yet: the registration handed back is comms_connection_change's `add`, made by nobody.
  const fresh = await clientOnly();
  const report = await handedOff(fresh);
  const flowId = /--finish (fl_\w+)/.exec(report.handoff.finish)?.[1];
  const server = await connect({
    core: fresh.harness.core,
    env: { ...fresh.harness.env, ...fresh.env },
    platform: 'darwin',
  });
  try {
    const pending = wire(await server.call('gmail_inbox_finish', { flowId, waitSeconds: 10 })).pendingRegistration as
      | Record<string, unknown>
      | undefined;
    assert.equal(pending?.tool, 'comms_connection_change');
    assert.deepEqual(pending?.arguments, { app: 'cursor', add: { server: 'gmail' } });
    assert.match(String(pending?.next), /Call comms_connection_change on the core server with these arguments/);
    assert.match(String(pending?.next), / mcp install --client cursor --launcher local/);
    assert.doesNotMatch(String(pending?.next), /--standalone/);
  } finally {
    await server.close();
  }
  assert.equal(existsSync(fresh.cursor), false, 'this server registers nothing');

  // Cursor's connection has Gmail for every mailbox already: the finish leaves it alone, and exits 0.
  const machine = await clientOnly();
  const words = ['mcp', 'install', '--client', 'cursor', '--launcher', 'npx', '--no-verify', '--json'];
  const asked = await cli(machine.harness, words, { env: machine.env });
  const made = await cli(machine.harness, [...words, '--approval', pendingApproval(asked)], { env: machine.env });
  assert.equal(made.code, 0, made.stdout);
  const handed = await handedOff(machine);
  const finished = await cli(machine.harness, [...gmailRetryWords(handed.handoff.finish), '--json'], {
    env: machine.env,
  });
  assert.equal(finished.code, 0, `${finished.stdout}${finished.stderr}`);
  assert.deepEqual(finished.envelope<{ registration: unknown }>().data?.registration, {
    client: 'cursor',
    status: 'already-registered',
    connection: 'Cursor',
  });
});
