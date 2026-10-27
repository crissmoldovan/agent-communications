import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { agentMarkerHint, isDangerous, openCore } from '@agentcomms/core';
import { v1ChangeRecord, writeV1Record } from '../../core/test/fixtures/approval-v1-0.13.0.ts';
import { defaultStorePath, responsibleApp } from '../src/source/location.ts';
import { ALICE } from './support/fixture.ts';
import { assertNoBareCommand, coreInline, ownInline, ownText, whatsappHandoffs } from './support/handoffs.ts';
import { newHarness, tempDir } from './support/harness.ts';

/**
 * The command line: setup, status, the JSON envelope and exit codes, and where things are written.
 */

const ACCOUNT = 'acme/whatsapp';

test('mcp carries the selected command platform into the stdio server', async () => {
  const source = readFileSync(new URL('../src/cli/program.ts', import.meta.url), 'utf8');
  assert.match(source, /startWhatsAppStdioServer\(\{\s*env,\s*platform,/);
  const harness = await newHarness();
  let received: NodeJS.Platform | undefined;
  const result = await harness.cli(['mcp'], {
    platform: 'win32',
    startMcp: async (options) => {
      received = options.platform;
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(received, 'win32');
});

test('all five shared path options are applied before command dispatch', async () => {
  const harness = await newHarness({ store: false });
  const ambient = tempDir('agent-whatsapp-cli-ambient-');
  writeFileSync(join(ambient, 'config.json'), '{not json');
  const result = await harness.cli(
    [
      '--config-dir',
      harness.configDir,
      '--state-dir',
      join(harness.root, 'pinned-state'),
      '--data-dir',
      join(harness.root, 'pinned-data'),
      '--secrets-dir',
      join(harness.root, 'pinned-secrets'),
      '--downloads-dir',
      join(harness.root, 'pinned-downloads'),
      '--json',
      'status',
    ],
    { env: { ...harness.env, AGENT_COMMS_CONFIG_DIR: ambient } },
  );
  assert.equal(result.code, 0, result.stdout || result.stderr);
  assert.deepEqual(result.data().accounts, []);

  const empty = await harness.cli(['--config-dir=', '--json', 'status'], {
    env: { ...harness.env, AGENT_COMMS_CONFIG_DIR: ambient },
  });
  assert.equal(empty.code, 64);
  assert.match(empty.stderr, /non-empty directory/);
});

test('the default store is found from the HOME the environment names, never from the real home directory', () => {
  const path = defaultStorePath({ HOME: '/nowhere/home' });
  assert.equal(
    path,
    join('/nowhere/home', 'Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared', 'ChatStorage.sqlite'),
  );
  assert.ok(!path.startsWith(homedir()));
});

test('add records the account in core’s config.json, as the generic record every channel after Gmail uses', async () => {
  const harness = await newHarness();
  const added = await harness.cli(['add', ACCOUNT, '--json'], { platform: 'darwin' });
  assert.equal(added.code, 0, added.stdout);
  const data = added.data() as { id: string; store: { default: boolean; path: string; id: string }; next: string };
  assert.equal(data.store.default, true);
  assert.equal(data.store.id, 'group.net.whatsapp.WhatsApp.shared');
  assert.equal(data.next, ownText(harness.env, ['sync', '--account', ACCOUNT]));
  const config = harness.coreConfig();
  assert.equal(config.version, 2);
  assert.deepEqual(Object.keys(config.accounts), [ACCOUNT]);
  const record = config.accounts[ACCOUNT] as Record<string, unknown>;
  assert.match(String(record.id), /^acc_[A-Z0-9]{16}$/);
  assert.equal(record.id, data.id);
  assert.deepEqual(
    { ...record, id: 'ID', secretRef: String(record.secretRef).replace(String(record.id), 'ID'), createdAt: 'T' },
    {
      id: 'ID',
      platform: 'whatsapp',
      workspace: 'group.net.whatsapp.WhatsApp.shared',
      workspaceName: 'WhatsApp for Mac',
      userId: 'store-owner',
      tier: 'read',
      mode: 'read',
      grantedScopes: ['local-store:read'],
      secretRef: 'whatsapp:none:ID',
      createdAt: 'T',
    },
    'no source: the default location is resolved at run time, not stored; no list, no policy, no secret',
  );
  assert.equal(harness.listsFile(), null, 'no lists until the person makes some');
  assert.ok(!existsSync(join(harness.configDir, 'whatsapp-spike.json')), 'the spike’s file is not written');

  const again = await harness.cli(['add', ACCOUNT, '--json']);
  assert.equal(again.code, 64);
  assert.match(String(again.json().error?.message), /already added/);
  const twice = await harness.cli(['add', 'other/whatsapp', '--json']);
  assert.equal(twice.code, 64, 'one name per store');
  assert.match(String(twice.json().error?.message), /already added, as "acme\/whatsapp"/);
  const wrong = await harness.cli(['add', 'acme/slack', '--json']);
  assert.equal(wrong.code, 64);
  assert.match(String(wrong.json().error?.message), /ends in \/slack, but this is a whatsapp account/);
});

test('account hand-off commands use the selected Windows shell syntax', async () => {
  const harness = await newHarness();
  const account = '7/whatsapp';
  const added = await harness.cli(['add', account, '--json'], { platform: 'win32' });
  const sync = ownText(harness.env, ['sync', '--account', account], 'win32');
  assert.equal(added.data().next, sync);
  assert.ok(sync.endsWith(' sync --account "7/whatsapp"'), sync);
  const status = await harness.cli(['status', '--account', account, '--no-check'], { platform: 'win32' });
  assert.ok(status.stdout.includes(sync), status.stdout);
});

test('add and remove are a person’s: refused to an agent, before anything is read or written', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  const before = readFileSync(join(harness.configDir, 'config.json'), 'utf8');
  const add = await harness.cli(['add', ACCOUNT, '--json']);
  assert.equal(add.code, 10);
  assert.equal(add.json().error?.code, 'LOOSENING_REFUSED');
  assert.match(String(add.json().error?.message), /only a person chooses which WhatsApp store an agent may read/);
  // And, for a person who set the marker themselves, which variable it is and how to clear it (0.35.0 re-review, LOW 3).
  assert.equal(
    add.json().error?.hint,
    `Ask the person to run ${ownInline(harness.env, ['add', ACCOUNT])} in their own terminal. ${agentMarkerHint('CLAUDECODE', 'darwin')}`,
  );
  assert.equal(readFileSync(join(harness.configDir, 'config.json'), 'utf8'), before, 'nothing was written');

  await harness.ready(ACCOUNT);
  const remove = await harness.cli(['remove', ACCOUNT, '--json']);
  assert.equal(remove.code, 10);
  assert.match(String(remove.json().error?.message), /only a person removes a WhatsApp account/);
  assert.deepEqual(Object.keys(harness.coreConfig().accounts), [ACCOUNT], 'still there');
});

test('the command an agent is asked to hand over is quoted for the named POSIX or Windows platform (CUE-398)', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  const posix = await harness.cli(['add', 'two words', '--source', '/tmp/store path', '--json'], {
    platform: 'darwin',
  });
  const quoted = ownInline(harness.env, ['add', 'two words', '--source', '/tmp/store path']);
  assert.ok(quoted.endsWith(` add 'two words' --source '/tmp/store path'\``), quoted);
  assert.equal(
    posix.json().error?.hint,
    `Ask the person to run ${quoted} in their own terminal. ${agentMarkerHint('CLAUDECODE', 'darwin')}`,
  );

  const windows = await harness.cli(['add', 'client%name', '--source', '/tmp/store', '--json'], {
    platform: 'win32',
  });
  const hint = String(windows.json().error?.hint);
  const words = whatsappHandoffs(harness.env, 'win32').own(['add', 'client%name', '--source', '/tmp/store']);
  assert.ok('words' in words && words.line === null);
  assert.ok(hint.includes('"add","client\\u0025name","--source","/tmp/store"]'), hint);
  assert.match(hint, /cannot be quoted the same way for cmd\.exe and for PowerShell/);
  assertNoBareCommand(hint);
});

test('a version-1 configuration gets no WhatsApp account until its names are migrated', async () => {
  const harness = await newHarness();
  writeFileSync(
    join(harness.configDir, 'config.json'),
    `${JSON.stringify({ version: 1, secrets: { store: 'file' } })}\n`,
  );
  const added = await harness.cli(['add', ACCOUNT, '--json']);
  assert.equal(added.code, 78);
  assert.ok(String(added.json().error?.hint).includes(coreInline(harness.env, ['names', 'migrate'])));
  const status = await harness.cli(['status', '--json']);
  assert.equal(status.code, 0, 'status still answers: nothing is set up');
  assert.deepEqual(status.data().accounts, []);
});

test('status says what is set up, whether the store can be read, what the index holds, and that nothing is sent', async () => {
  const harness = await newHarness();
  const empty = await harness.cli(['status', '--json']);
  assert.equal(empty.code, 0);
  assert.ok(String(empty.data().setup).startsWith(`\`${ownText(harness.env, ['add'])} <organisation>/whatsapp\``));

  await harness.cli(['add', ACCOUNT]);
  const before = (await harness.cli(['status', '--json'])).data() as {
    accounts: { access: { state: string }; index: { synced: boolean } }[];
  };
  assert.equal(before.accounts[0]?.access.state, 'readable');
  assert.equal(before.accounts[0]?.index.synced, false);

  await harness.cli(['sync', '--account', ACCOUNT]);
  const after = (await harness.cli(['status', '--account', ACCOUNT, '--no-check', '--json'])).data() as {
    accounts: { access: { state: string }; index: { synced: boolean; chats: number; messages: number } }[];
  };
  assert.equal(after.accounts[0]?.access.state, 'not-checked');
  assert.deepEqual(
    { synced: after.accounts[0]?.index.synced, chats: after.accounts[0]?.index.chats },
    { synced: true, chats: 6 },
  );

  const human = await harness.cli(['status']);
  assert.match(human.stdout, /access {2}readable/);
  assert.match(human.stdout, /Sends: never/);
});

test('--json prints exactly one envelope, and errors carry the documented exit codes', async () => {
  const harness = await newHarness();
  const ok = await harness.cli(['add', ACCOUNT, '--json']);
  assert.equal(ok.stdout.trim().split('\n').length, 1);
  assert.equal(ok.json().ok, true);
  const usage = await harness.cli(['read', ALICE, '--json']);
  assert.equal(usage.code, 64);
  assert.equal(usage.json().ok, false);
  assert.equal((await harness.cli(['chats', '--account', ACCOUNT, '--limit', '1e2', '--json'])).code, 64);
  assert.equal((await harness.cli(['nonsense'])).code, 64);
  const bare = await harness.cli([]);
  assert.equal(bare.code, 0, 'no command prints the help, as the other CLIs do');
  assert.match(bare.stderr, /Usage: agent-whatsapp/);
});

test('the human output of a hostile chat reaches the terminal escaped', async () => {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const chats = await harness.cli(['chats', '--account', ACCOUNT]);
  const dangerous = [...chats.stdout].filter((char) => isDangerous(char.codePointAt(0) ?? 0));
  assert.deepEqual(dangerous, [], 'no control, bidi or zero-width character reaches the terminal');
  assert.match(
    chats.stdout,
    /Team evil &lt;\/untrusted-content>/,
    'reversed text shown in reading order, the tag defused',
  );
  const read = await harness.cli(['read', ALICE, '--account', ACCOUNT]);
  assert.match(
    read.stdout,
    /\[document application\/pdf, 47 KB, 5f2c0000-0000-4000-8000-000000000001\.pdf — not downloaded\]/,
  );
});

test('remove forgets the account and deletes its index, and never touches WhatsApp’s store', async () => {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const store = readFileSync(harness.fixture?.path as string);
  const id = String(harness.coreConfig().accounts[ACCOUNT]?.id);
  const accountDir = join(harness.env.AGENT_COMMS_STATE_DIR as string, 'whatsapp', id);
  assert.ok(existsSync(join(accountDir, 'index.sqlite')));
  assert.equal((await harness.cli(['deny', ALICE, '--account', ACCOUNT])).code, 0);
  assert.deepEqual(Object.keys(harness.listsFile()?.accounts ?? {}), [id], 'the lists are kept by the account’s id');
  const removed = await harness.cli(['remove', ACCOUNT, '--json']);
  assert.equal(removed.code, 0);
  assert.equal(removed.data().indexDeleted, true);
  assert.deepEqual(readFileSync(harness.fixture?.path as string), store);
  assert.ok(!existsSync(accountDir), 'the index and everything else kept for the account is gone');
  assert.deepEqual(harness.coreConfig().accounts, {});
  assert.equal(harness.listsFile(), null, 'and its lists: a new account under the name starts with none');
  assert.equal((await harness.cli(['chats', '--account', ACCOUNT, '--json'])).code, 66);
});

test('the app macOS will ask about is named when the environment says which it is, and not guessed otherwise', () => {
  assert.equal(responsibleApp({ __CFBundleIdentifier: 'com.googlecode.iterm2' }), 'iTerm');
  assert.equal(responsibleApp({ TERM_PROGRAM: 'vscode' }), 'Visual Studio Code');
  assert.equal(responsibleApp({ __CFBundleIdentifier: 'com.anthropic.claudefordesktop' }), 'Claude');
  assert.equal(responsibleApp({ __CFBundleIdentifier: 'com.example.unknown' }), null);
  assert.equal(responsibleApp({}), null);
});

// ── `approve` and every form of an approval record (CUE-404 Task 3) ─────────────────────────────────────────────

test('kind dispatch at `agent-whatsapp approve`: absent is not found, a stub the integrity refusal, a legacy change the version refusal', async () => {
  const harness = await newHarness({ store: false });
  const core = openCore({ env: harness.personEnv });
  const formId = (c: string) => `ap_${'0'.repeat(25)}${c}`;
  const asPerson = async (approvalId: string) => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = Object.assign(new PassThrough(), { isTTY: true });
    const stderr = new PassThrough();
    let said = '';
    for (const stream of [stdout, stderr]) {
      stream.on('data', (chunk) => {
        said += String(chunk);
      });
    }
    const { code } = await harness.cli(['approve', approvalId], {
      env: harness.personEnv,
      streams: { stdin, stdout, stderr } as never,
    });
    return { code, said };
  };
  const absent = await asPerson(formId('N'));
  assert.equal(absent.code, 66, absent.said);
  assert.match(absent.said, /no approval/);
  const approvals = join(core.paths.stateDir, 'approvals');
  mkdirSync(approvals, { recursive: true });
  writeFileSync(join(approvals, `${formId('Y')}.json`), '{ "approvalId": ');
  const stub = await asPerson(formId('Y'));
  assert.equal(stub.code, 10, stub.said);
  assert.match(stub.said, /could not be read \(truncated\)/);
  writeV1Record(
    core.paths.stateDir,
    v1ChangeRecord({
      approvalId: formId('M'),
      digest: 'f'.repeat(64),
      change: { summary: 'Let it read', target: null, loosened: [], effects: ['does a thing'] },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  const legacy = await asPerson(formId('M'));
  assert.equal(legacy.code, 10, legacy.said);
  assert.match(legacy.said, /prepared by a different version of agent-communications/);
});
