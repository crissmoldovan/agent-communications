import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { conversationProfileFile, inboxProfileFile, PROFILE_STARTER } from '../src/compose-profile.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { renameEntry } from '../src/names.ts';
import { profileInit, profileView } from '../src/operations/profile.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Task 5 of the behaviour rules (design 2026-10-19-agent-behaviour-rules, B6): `agentcomms profile` and `comms_profile`
 * show the joined writing profile for a place and every file it would read; `profile init`, at the command line only,
 * starts a missing file from a starter and never overwrites one. No tool writes a profile.
 *
 * Every test runs against a temporary home and config folder, with synthetic accounts; nothing reads a real profile
 * and nothing talks to a channel.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const CREATED = '2026-09-20T00:00:00.000Z';

const inbox = {
  id: 'ibx_AAAAAAAAAAAAAAAA',
  provider: 'gmail',
  email: 'jo@acme.test',
  identity: 'oidc',
  client: 'desktop',
  tier: 'send',
  contacts: false,
  grantedScopes: [],
  secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
  internalDomains: ['acme.test'],
  createdAt: CREATED,
};
const slack = {
  id: 'acc_AAAAAAAAAAAAAAAA',
  platform: 'slack',
  workspace: 'T_ACME',
  userId: 'U_AAAA',
  tier: 'send',
  mode: 'send',
  grantedScopes: [],
  secretRef: 'slack:token:acc_AAAAAAAAAAAAAAAA',
  createdAt: CREATED,
};

interface Machine {
  env: Record<string, string>;
  core: Core;
  compose: string;
}

function machine(): Machine {
  const home = tempDir('comms-profile-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const body = { version: 2, inboxes: { 'acme/gmail': inbox }, accounts: { 'acme/slack': slack } };
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify(body, null, 2)}\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return { env, core: openCore({ env, caller: CORE_CALLER }), compose: join(configDir, 'compose') };
}

function write(m: Machine, name: string, text: string): string {
  mkdirSync(m.compose, { recursive: true });
  const path = join(m.compose, name);
  writeFileSync(path, text);
  return path;
}

/** Every file under the compose folder with its bytes, or null when the folder was never made. */
function snapshot(m: Machine): Record<string, string> | null {
  if (!existsSync(m.compose)) return null;
  return Object.fromEntries(readdirSync(m.compose).map((name) => [name, readFileSync(join(m.compose, name), 'utf8')]));
}

const is = (code: string, pattern?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof CommsError, String(error));
  assert.equal(error.code, code, error.message);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

// ── The operation ─────────────────────────────────────────────────────────────────────────────────────────────

test('a Slack DM reads its D… file, then the person’s U… file, after the workspace’s', async () => {
  const m = machine();
  write(m, 'slack.md', '- Short, in Slack.\n');
  write(m, inboxProfileFile('acme/slack'), '- Our workspace is informal.\n');
  const dm = write(m, conversationProfileFile('acme/slack', 'D0SAM'), '- This DM is about the launch.\n');
  const person = write(m, conversationProfileFile('acme/slack', 'U0SAM'), '- Sam likes emoji.\n');

  const view = await profileView(m.core, { account: 'acme/slack', conversations: ['D0SAM', 'U0SAM'] });
  assert.deepEqual(
    view.sections.map((section) => section.layer),
    ['default', 'platform', 'account', 'conversation', 'conversation'],
  );
  assert.deepEqual(
    view.sections.filter((section) => section.layer === 'conversation').map((section) => section.source),
    [dm, person],
  );
  assert.ok(view.text.indexOf('informal') < view.text.indexOf('launch'));
  assert.ok(view.text.indexOf('launch') < view.text.indexOf('emoji'));
  // Every file it would read, written or not, so a person knows where to put one.
  assert.deepEqual(view.candidates, [
    join(m.compose, 'default.md'),
    join(m.compose, 'user.md'),
    join(m.compose, 'slack.md'),
    join(m.compose, inboxProfileFile('acme/slack')),
    dm,
    person,
  ]);
});

test('mail reads each recipient’s file before its domain’s, in recipient order', async () => {
  const m = machine();
  const sam = write(m, conversationProfileFile('acme/gmail', 'sam+news@client.test'), '- Sam: first names.\n');
  const domain = write(m, conversationProfileFile('acme/gmail', '@client.test'), '- Client: formal.\n');
  const view = await profileView(m.core, {
    account: 'acme/gmail',
    conversations: ['Sam+News@Client.test', '@client.test', 'lee@other.test', '@other.test'],
  });
  assert.equal(sam, join(m.compose, 'conversation-acme__gmail__sam%2Bnews@client.test.md'));
  assert.deepEqual(
    view.sections.filter((section) => section.layer === 'conversation').map((section) => section.source),
    [sam, domain],
  );
  assert.ok(view.candidates.includes(join(m.compose, 'gmail.md')), 'the platform is the mailbox’s');
  assert.ok(view.candidates.includes(join(m.compose, conversationProfileFile('acme/gmail', '@other.test'))));
});

test('with no account, the layers every message shares; a conversation needs its account', async () => {
  const m = machine();
  write(m, 'user.md', '- Sign off as Jo.\n');
  const view = await profileView(m.core, {});
  assert.deepEqual(
    view.sections.map((section) => section.layer),
    ['default', 'user'],
  );
  assert.deepEqual(view.candidates, [join(m.compose, 'default.md'), join(m.compose, 'user.md')]);
  await assert.rejects(profileView(m.core, { conversations: ['C01'] }), is('USAGE', /account/));
});

test('an account is looked up by name: unknown is refused, a former name says what it is called now', async () => {
  const m = machine();
  await assert.rejects(profileView(m.core, { account: 'acme/slak' }), is('NOT_FOUND', /acme\/slak/));
  await m.core.config.update((config) => renameEntry(config, 'account', 'acme/slack', 'acme/slack-main'));
  await assert.rejects(
    profileView(m.core, { account: 'acme/slack' }),
    is('NOT_FOUND', /renamed to "acme\/slack-main"/),
  );
  await assert.rejects(profileInit(m.core, { account: 'acme/slack' }), is('NOT_FOUND', /renamed/));
});

test('a conversation must be one its account has: a Slack id for Slack, an address or @domain for mail', async () => {
  const m = machine();
  await assert.rejects(profileView(m.core, { account: 'acme/slack', conversations: ['sam@client.test'] }), is('USAGE'));
  await assert.rejects(profileView(m.core, { account: 'acme/gmail', conversations: ['C01ACME'] }), is('USAGE'));
  await assert.rejects(profileInit(m.core, { account: 'acme/gmail', conversation: '../escape' }), is('USAGE'));
  assert.equal(snapshot(m), null, 'nothing was written');
});

test('the rules written under a former name keep applying after a rename', async () => {
  const m = machine();
  write(m, inboxProfileFile('acme/slack'), '- Workspace rules.\n');
  write(m, conversationProfileFile('acme/slack', 'C01ACME'), '- Channel rules.\n');
  await m.core.config.update((config) => renameEntry(config, 'account', 'acme/slack', 'acme/slack-main'));
  const view = await profileView(m.core, { account: 'acme/slack-main', conversations: ['C01ACME'] });
  assert.match(view.text, /Workspace rules/);
  assert.match(view.text, /Channel rules/);
});

test('profileInit creates the starter for the layer named, and never overwrites', async () => {
  const m = machine();

  const user = await profileInit(m.core, {});
  assert.deepEqual(user, { path: join(m.compose, 'user.md'), created: true });
  assert.equal(readFileSync(user.path, 'utf8'), PROFILE_STARTER);

  const account = await profileInit(m.core, { account: 'acme/slack' });
  assert.deepEqual(account, { path: join(m.compose, inboxProfileFile('acme/slack')), created: true });

  const conversation = await profileInit(m.core, { account: 'acme/gmail', conversation: 'Sam+News@Client.test' });
  assert.deepEqual(conversation, {
    path: join(m.compose, 'conversation-acme__gmail__sam%2Bnews@client.test.md'),
    created: true,
  });
  assert.equal(readFileSync(conversation.path, 'utf8'), PROFILE_STARTER);

  // What the person wrote since stays as they wrote it.
  writeFileSync(account.path, '- Mine.\n');
  assert.deepEqual(await profileInit(m.core, { account: 'acme/slack' }), { ...account, created: false });
  assert.equal(readFileSync(account.path, 'utf8'), '- Mine.\n');

  await assert.rejects(profileInit(m.core, { conversation: 'C01ACME' }), is('USAGE', /account/));
});

test('profileInit never shadows a file written under a former name: it names that file and creates nothing', async () => {
  const m = machine();
  const old = write(m, inboxProfileFile('acme/slack'), '- Written before the rename.\n');
  await m.core.config.update((config) => renameEntry(config, 'account', 'acme/slack', 'acme/slack-main'));
  const before = snapshot(m);
  assert.deepEqual(await profileInit(m.core, { account: 'acme/slack-main' }), { path: old, created: false });
  assert.deepEqual(snapshot(m), before);
});

// ── Both surfaces ─────────────────────────────────────────────────────────────────────────────────────────────

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function connect(m: Machine) {
  const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (args: Record<string, unknown> = {}) =>
    (await client.callTool({ name: 'comms_profile', arguments: args })) as ToolResult;
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}

function cli(m: Machine, args: string[]) {
  const result = spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: m.env });
  return { ...result, json: () => JSON.parse(result.stdout.trim().split('\n')[0] ?? '') };
}

test('comms_profile and the profile command show the same thing', async () => {
  const m = machine();
  write(m, conversationProfileFile('acme/slack', 'D0SAM'), '- The launch.\n');
  write(m, conversationProfileFile('acme/slack', 'U0SAM'), '- Emoji.\n');
  const { call, close } = await connect(m);
  try {
    const shown = await call({ account: 'acme/slack', conversations: ['D0SAM', 'U0SAM'] });
    assert.notEqual(shown.isError, true, JSON.stringify(shown.structuredContent));
    const expected = JSON.parse(
      JSON.stringify(await profileView(m.core, { account: 'acme/slack', conversations: ['D0SAM', 'U0SAM'] })),
    );
    assert.deepEqual(shown.structuredContent, expected);
    // `--conversation` repeats, in order.
    const byCommand = cli(m, ['profile', 'acme/slack', '--conversation', 'D0SAM', '--conversation', 'U0SAM', '--json']);
    assert.equal(byCommand.status, 0, byCommand.stderr);
    assert.deepEqual(byCommand.json().data, expected);

    const unknown = await call({ account: 'acme/nothing' });
    assert.equal(unknown.isError, true);
    assert.match(JSON.stringify(unknown.structuredContent), /NOT_FOUND/);
    const byCommandUnknown = cli(m, ['profile', 'acme/nothing']);
    assert.equal(byCommandUnknown.status, 66, byCommandUnknown.stderr);
  } finally {
    await close();
  }
});

test('comms_profile only reads: it has no init, takes no approval, and writes nothing', async () => {
  const m = machine();
  const { client, call, close } = await connect(m);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === 'comms_profile');
    assert.ok(tool, 'comms_profile is offered');
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['account', 'conversations']);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.ok(!tools.some((entry) => /profile.*init|init.*profile/.test(entry.name)), 'no tool starts a profile');

    for (const args of [
      {},
      { account: 'acme/slack' },
      { account: 'acme/slack', conversations: ['C01ACME'] },
      { account: 'acme/gmail', conversations: ['sam@client.test', '@client.test'] },
    ]) {
      const result = await call(args);
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    }
    assert.equal(snapshot(m), null, 'the compose folder was not even made');

    for (const args of [
      { init: true },
      { account: 'acme/slack', init: true },
      { approvalId: 'ap_00000000000000000000000000' },
    ]) {
      const refused = await call(args);
      assert.equal(refused.isError, true, `${JSON.stringify(args)} is refused`);
    }
    assert.equal(snapshot(m), null);
  } finally {
    await close();
  }
});

test('profile init, at the command line, starts the file and prints its path; again, it says it is there', () => {
  const m = machine();
  const path = join(m.compose, conversationProfileFile('acme/slack', 'C01ACME'));
  const first = cli(m, ['profile', 'init', 'acme/slack', '--conversation', 'C01ACME', '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.json().data, { path, created: true });
  assert.equal(readFileSync(path, 'utf8'), PROFILE_STARTER);

  writeFileSync(path, '- Mine.\n');
  const again = cli(m, ['profile', 'init', 'acme/slack', '--conversation', 'C01ACME']);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.includes(path), again.stdout);
  assert.match(again.stdout, /already/);
  assert.equal(readFileSync(path, 'utf8'), '- Mine.\n');

  // One file at a time: a second --conversation is refused before anything is written.
  const two = cli(m, ['profile', 'init', 'acme/slack', '--conversation', 'C01ACME', '--conversation', 'C02ACME']);
  assert.equal(two.status, 64, two.stderr);
  assert.ok(!existsSync(join(m.compose, conversationProfileFile('acme/slack', 'C02ACME'))));
  // The profile command takes none of the label's other options, and no approval.
  assert.equal(cli(m, ['profile', '--kinds', 'post']).status, 64);
  assert.equal(cli(m, ['profile', '--approval', 'ap_00000000000000000000000000']).status, 64);
});

test('the profile command prints the profile, then the files read and the ones not written yet', () => {
  const m = machine();
  const user = write(m, 'user.md', '- Sign off as Jo.\n');
  const shown = cli(m, ['profile', 'acme/slack']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Sign off as Jo/);
  assert.ok(shown.stdout.includes(user));
  assert.ok(shown.stdout.includes(join(m.compose, inboxProfileFile('acme/slack'))));
  assert.match(shown.stdout, /profile init/);
});
