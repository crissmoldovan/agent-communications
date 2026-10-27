import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ConnectionPartResult, EXIT_CODES } from '@agentcomms/core';
import { newHarness, tempDir } from './support/harness.ts';
import { cli, pendingApproval } from './support/surfaces.ts';

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
