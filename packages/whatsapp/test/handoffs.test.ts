import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  channelManifest,
  cliHandoffs,
  handoffSentence,
  handoffSentenceToFill,
  isCommand,
  knownClientConfigs,
  openCore,
  type RegisteredServer,
  sendApprovesHint,
} from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createWhatsAppMcpServer } from '../src/mcp/server.ts';
import { MIN_NODE } from '../src/sqlite.ts';
import { VERSION } from '../src/version.ts';
import { ALICE } from './support/fixture.ts';
import {
  assertLocatedHere,
  assertNoBareCommand,
  coreInline,
  namesBareCommand,
  OWN_SOURCE_CLI,
  ownInline,
  ownText,
  pathsOf,
  whatsappHandoffs,
} from './support/handoffs.ts';
import { newHarness, tempDir } from './support/harness.ts';

/*
 * Every command WhatsApp tells a person to run names this Node and this installation's own CLI, with the run's folders
 * pinned — or says plainly that there is none here (CUE-403, design 2026-10-04 D1 and D5; §4 7d for WhatsApp). The
 * expected sentences are made the way the package makes them, through core's handoffs from this package's caller; one
 * test shows what such a command is, word by word. None of these reaches WhatsApp, the network or a real home.
 */

const ACCOUNT = 'acme/whatsapp';
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

/** Streams that are a terminal, with everything written to them collected. */
function terminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let said = '';
  for (const stream of [stdout, stderr]) {
    stream.on('data', (chunk) => {
      said += String(chunk);
    });
  }
  return { streams: { stdin, stdout, stderr } as never, said: () => said };
}

// ── The checker: what counts as a command nobody can run (7d) ───────────────────────────────────────────────────────

test('the checker catches a bare binary, an option-only command, the old --help line and a mixed-case Windows name (7d)', () => {
  for (const bare of [
    'Run `agent-whatsapp --help` to see the commands.',
    'Nothing to do. Try `agent-whatsapp --help`.',
    'Add it again with `agent-whatsapp add` to read it.',
    'a person runs `agent-whatsapp add <organisation>/whatsapp` in a terminal.',
    'Type `agent-whatsapp`.',
    'agent-whatsapp sync --account acme/whatsapp',
    'Run `Agent-WhatsApp.CMD sync --account acme/whatsapp`.',
    'Run `AGENT-WHATSAPP.exe --help`.',
    '["Agent-WhatsApp.cmd","approve","ap_1"]',
    'Approve it with `Agent-Gmail.CMD approve ap_1`.',
    'Run `agentcomms names migrate --dry-run`.',
  ]) {
    assert.ok(namesBareCommand(bare), `caught: ${bare}`);
  }
  const harness = { env: { HOME: '/h', AGENT_COMMS_CONFIG_DIR: '/c', AGENT_COMMS_STATE_DIR: '/s' } };
  for (const located of [
    ownText(harness.env, ['--help'], 'darwin', { uses: [] }),
    ownText(harness.env, ['sync', '--account', ACCOUNT]),
    ownText(harness.env, ['sync', '--account', '7/whatsapp'], 'win32'),
    coreInline(harness.env, ['names', 'migrate']),
  ]) {
    assert.ok(!namesBareCommand(located), `a located command passes: ${located}`);
  }
});

test('a command WhatsApp prints for itself is this Node, its own CLI, the run’s folders, then the words', async () => {
  const harness = await newHarness({ store: false });
  const sync = whatsappHandoffs(harness.env).own(['sync', '--account', ACCOUNT]);
  assert.ok(isCommand(sync));
  assertLocatedHere(sync.words, harness.env, ['sync', '--account', ACCOUNT]);
  // `--help` opens no folder, so it is pinned to none.
  const help = whatsappHandoffs(harness.env).own(['--help'], { uses: [] });
  assert.ok(isCommand(help));
  assert.deepEqual(help.words, [process.execPath, '--experimental-strip-types', OWN_SOURCE_CLI, '--help']);
});

// ── Each site, as a person or an agent meets it ─────────────────────────────────────────────────────────────────────

test('a usage error names this installation’s --help, located, never `agent-whatsapp --help` (7d)', async () => {
  const harness = await newHarness({ store: false });
  const help = ownInline(harness.env, ['--help'], 'darwin', { uses: [] });
  const usage = await harness.cli(['nonsense', '--json']);
  assert.equal(usage.code, 64);
  assert.equal(usage.json().error?.hint, `Run ${help} to see the commands.`);
  assertNoBareCommand(String(usage.json().error?.hint));

  // On Windows, quoted for it.
  const windows = await harness.cli(['nonsense', '--json'], { platform: 'win32' });
  assert.equal(
    windows.json().error?.hint,
    `Run ${ownInline(harness.env, ['--help'], 'win32', { uses: [] })} to see the commands.`,
  );
  // A command line that names no command gets the help itself, from Commander, rather than a line about it.
  const nothing = await harness.cli([]);
  assert.equal(nothing.code, 0);
  assert.match(nothing.stderr, /^Usage: agent-whatsapp /);
});

test('add, remove, allow, deny and clear refused to an agent hand the person the command, located (7d)', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  const add = await harness.cli(['add', ACCOUNT, '--json']);
  assert.equal(add.code, 10);
  assert.equal(
    add.json().error?.hint,
    `Ask the person to run ${ownInline(harness.env, ['add', ACCOUNT])} in their own terminal.`,
  );
  const source = await harness.cli(['add', ACCOUNT, '--source', '/tmp/store path/ChatStorage.sqlite', '--json']);
  assert.equal(
    source.json().error?.hint,
    `Ask the person to run ${ownInline(harness.env, ['add', ACCOUNT, '--source', '/tmp/store path/ChatStorage.sqlite'])} in their own terminal.`,
  );

  await harness.ready(ACCOUNT);
  const remove = await harness.cli(['remove', ACCOUNT, '--json']);
  assert.equal(
    remove.json().error?.hint,
    `Ask the person to run ${ownInline(harness.env, ['remove', ACCOUNT])} in their own terminal.`,
  );
  for (const argv of [['allow', ALICE], ['deny', ALICE], ['clear'], ['clear', ALICE]]) {
    const refused = await harness.cli([...argv, '--account', ACCOUNT, '--json']);
    assert.equal(refused.code, 10);
    assert.equal(
      refused.json().error?.hint,
      `Ask the person to run ${ownInline(harness.env, [...argv, '--account', ACCOUNT])} in their own terminal.`,
    );
    assertNoBareCommand(String(refused.json().error?.hint));
  }
});

test('on Windows a refusal whose words no line can carry gives them as JSON to type, this Node and CLI first', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  const windows = await harness.cli(['add', 'client%name', '--source', '/tmp/store', '--json'], { platform: 'win32' });
  const hint = String(windows.json().error?.hint);
  const handoff = whatsappHandoffs(harness.env, 'win32').own(['add', 'client%name', '--source', '/tmp/store']);
  assert.ok(isCommand(handoff) && handoff.line === null, 'no line: `%` cannot be quoted for every Windows shell');
  assert.equal(
    hint,
    handoffSentence(handoff, (command) => `Ask the person to run ${command} in their own terminal.`),
  );
  assert.match(hint, /cannot be quoted the same way for cmd\.exe and for PowerShell/);
  assertNoBareCommand(hint);
});

test('what add, status and a list change say to run next is the sync, located — POSIX and Windows', async () => {
  const harness = await newHarness();
  const added = await harness.cli(['add', ACCOUNT, '--json']);
  assert.equal(added.data().next, ownText(harness.env, ['sync', '--account', ACCOUNT]));
  const human = await harness.cli(['status', '--no-check']);
  assert.ok(
    human.stdout.includes(`  index   not synced yet — ${ownText(harness.env, ['sync', '--account', ACCOUNT])}\n`),
    human.stdout,
  );
  const again = await harness.cli(['add', ACCOUNT, '--json']);
  assert.equal(
    again.json().error?.hint,
    `Remove it first with ${ownInline(harness.env, ['remove', ACCOUNT])} to point it at another store.`,
  );

  await harness.cli(['sync', '--account', ACCOUNT]);
  const cleared = await harness.cli(['clear', '--account', ACCOUNT, '--json']);
  assert.equal(cleared.data().next, ownText(harness.env, ['sync', '--account', ACCOUNT]));

  const windows = await newHarness();
  const named = await windows.cli(['add', '7/whatsapp', '--json'], { platform: 'win32' });
  assert.equal(named.data().next, ownText(windows.env, ['sync', '--account', '7/whatsapp'], 'win32'));
  const status = await windows.cli(['status', '--account', '7/whatsapp', '--no-check'], { platform: 'win32' });
  assert.ok(status.stdout.includes(ownText(windows.env, ['sync', '--account', '7/whatsapp'], 'win32')), status.stdout);
  for (const text of [String(named.data().next), status.stdout]) assertNoBareCommand(text);
});

test('with no account, status’s setup and the not-found hint name add, located, with the name to fill in', async () => {
  const harness = await newHarness({ store: false });
  const status = await harness.cli(['status', '--json']);
  const add = whatsappHandoffs(harness.env).own(['add']);
  assert.equal(
    status.data().setup,
    handoffSentenceToFill(add, ['<organisation>/whatsapp'], (command) => `${command} — run by a person, in a terminal`),
  );
  const human = await harness.cli(['status']);
  assert.ok(human.stdout.startsWith(`No WhatsApp account yet. ${String(status.data().setup)}\n`), human.stdout);

  const missing = await harness.cli(['chats', '--account', ACCOUNT, '--json']);
  assert.equal(missing.code, 66);
  assert.equal(
    missing.json().error?.hint,
    handoffSentenceToFill(
      add,
      ['<organisation>/whatsapp'],
      (command) => `None yet: a person adds one with ${command}.`,
    ),
  );
  for (const text of [String(status.data().setup), String(missing.json().error?.hint)]) assertNoBareCommand(text);
});

test('a configuration with the old flat names is migrated with core’s command, as this package finds it', async () => {
  const harness = await newHarness();
  writeFileSync(
    join(harness.configDir, 'config.json'),
    `${JSON.stringify({ version: 1, secrets: { store: 'file' } })}\n`,
  );
  const added = await harness.cli(['add', ACCOUNT, '--json']);
  assert.equal(added.code, 78);
  assert.equal(
    added.json().error?.hint,
    `Run ${coreInline(harness.env, ['names', 'migrate', '--dry-run'])} to see what everything would be called, then ${coreInline(harness.env, ['names', 'migrate'])}.`,
  );
  // Core's own CLI, through this package's installed dependency on it: core's source beside this checkout's.
  const migrate = whatsappHandoffs(harness.env).core(['names', 'migrate']);
  assert.ok(isCommand(migrate));
  assert.equal(migrate.words[2], realpathSync(join(PACKAGE, '..', 'core', 'src', 'cli.ts')));
  assertNoBareCommand(String(added.json().error?.hint));
});

test('a sync that cannot read yet, on either surface, names the sync and status to run, located', async () => {
  const harness = await newHarness();
  await harness.cli(['add', ACCOUNT]);
  const sync = ownInline(harness.env, ['sync', '--account', ACCOUNT]);
  const cli = await harness.cli(['chats', '--account', ACCOUNT, '--json']);
  assert.equal(cli.json().error?.hint, `Run ${sync} (or the whatsapp_sync tool) first.`);
  const { server } = await createWhatsAppMcpServer({ env: harness.env, platform: 'darwin' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const tool = (await client.callTool({ name: 'whatsapp_chats', arguments: { account: ACCOUNT } })) as {
      structuredContent: { error?: { hint: string } };
    };
    assert.equal(tool.structuredContent.error?.hint, cli.json().error?.hint, 'the same command on both surfaces');
  } finally {
    await Promise.all([client.close(), server.close()]);
  }

  // A store that does not answer: an MCP server cannot answer macOS's dialog, so the person runs status at a terminal.
  const hanging = { lstat: () => new Promise<never>(() => undefined), open: () => new Promise<never>(() => undefined) };
  const waiting = await harness.cli(['sync', '--account', ACCOUNT, '--json'], {
    sourceIo: hanging as never,
    sourceTimeoutMs: 50,
  });
  assert.equal(waiting.code, 75);
  const hint = String(waiting.json().error?.hint);
  assert.ok(
    hint.endsWith(
      `An MCP server cannot answer it: run ${ownInline(harness.env, ['status'])} in a terminal once, or grant Full Disk Access.`,
    ),
    hint,
  );
  assertNoBareCommand(hint);
});

test('the server’s greeting names no command: with no account, whatsapp_status’s setup gives the add, located', async () => {
  const harness = await newHarness({ store: false });
  const { server } = await createWhatsAppMcpServer({ env: harness.env, platform: 'darwin' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const instructions = client.getInstructions() ?? '';
    assert.match(
      instructions,
      /No account is set up yet: a person adds one in a terminal — whatsapp_status gives the command, as `setup`\./,
    );
    assertNoBareCommand(instructions, 'the instructions');
    assert.ok(!instructions.includes(OWN_SOURCE_CLI), 'no command at all');
    const status = (await client.callTool({ name: 'whatsapp_status', arguments: {} })) as {
      structuredContent: { setup?: string };
    };
    assert.equal(
      status.structuredContent.setup,
      handoffSentenceToFill(
        whatsappHandoffs(harness.env).own(['add']),
        ['<organisation>/whatsapp'],
        (command) => `${command} — run by a person, in a terminal`,
      ),
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('a missing store names the add that points at another one, located, with what to fill in', async () => {
  const harness = await newHarness({ store: false });
  const result = await harness.cli(['add', ACCOUNT, '--json']);
  assert.equal(result.code, 66);
  const hint = String(result.json().error?.hint);
  const add = whatsappHandoffs(harness.env).own(['add']);
  assert.ok(
    hint.endsWith(
      handoffSentenceToFill(
        add,
        ['<organisation>/whatsapp', '--source', '<path to its ChatStorage.sqlite>'],
        (command) =>
          `The WhatsApp Business app keeps its own, under group.net.whatsapp.WhatsAppSMB.shared: add it with ${command}.`,
      ),
    ),
    hint,
  );
  assertNoBareCommand(hint);
});

// ── approve, mcp install and mcp prune ──────────────────────────────────────────────────────────────────────────────

test('approve refused to an agent, or away from a terminal, names this installation’s approve (7d)', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  const approve = ownInline(harness.env, ['approve', 'ap_1']);
  const byAgent = await harness.cli(['approve', 'ap_1', '--json']);
  assert.equal(byAgent.code, 10);
  // And the wait that learns when they have: core's, which WhatsApp has installed, as it has no wait of its own (§D7).
  const wait = coreInline(harness.env, ['approval', 'wait', 'ap_1']);
  assert.equal(
    byAgent.json().error?.hint,
    `Ask the person to run ${approve} in their own terminal; learn when they have with ${wait}.`,
  );
  assertNoBareCommand(String(byAgent.json().error?.hint));
  const noTerminal = await harness.cli(['approve', 'ap_1', '--json'], { env: harness.personEnv });
  assert.equal(noTerminal.json().error?.hint, `Run ${approve} directly in a terminal.`);
});

test('a change waiting for approval is run again with this installation’s own mcp install, located', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  await harness.ready(ACCOUNT);
  const argv = [
    'mcp',
    'install',
    '--client',
    'cursor',
    '--standalone',
    '--launcher',
    'npx',
    '--no-verify',
    '--account',
    ACCOUNT,
  ];
  const asked = await harness.cli([...argv, '--json']);
  assert.equal(asked.code, 10, asked.stdout);
  const error = asked.json().error as { hint: string; details: { approvalId: string } };
  const { approvalId } = error.details;
  const rerun = [
    'mcp',
    'install',
    '--client',
    'cursor',
    '--standalone',
    '--account',
    ACCOUNT,
    '--launcher',
    'npx',
    '--no-verify',
  ];
  assert.equal(
    error.hint,
    `Show the person the preview. Once they say yes, run ${ownInline(harness.env, [...rerun, '--approval', approvalId])}.`,
  );
  assertNoBareCommand(error.hint);

  // Under confirm, the person approves with this installation's approve first.
  const config = harness.coreConfig();
  writeFileSync(
    join(harness.configDir, 'config.json'),
    `${JSON.stringify({ ...config, defaults: { ...((config.defaults as object) ?? {}), changePolicy: 'confirm' } })}\n`,
  );
  const confirm = await harness.cli([...argv, '--force', '--json']);
  const pending = confirm.json().error as { hint: string; details: { approvalId: string } };
  const id = pending.details.approvalId;
  assert.equal(
    pending.hint,
    `Show the person the preview. They run ${ownInline(harness.env, ['approve', id])}; learn when they have with ${coreInline(harness.env, ['approval', 'wait', id])}, then run ${ownInline(harness.env, [...rerun, '--force', '--approval', id])}.`,
  );

  const unnamed = await harness.cli(['mcp', 'install', '--json']);
  assert.equal(unnamed.code, 64);
  assert.equal(
    unnamed.json().error?.hint,
    `For example: ${ownInline(harness.env, ['mcp', 'install', '--client', 'claude-code', '--account', 'personal/whatsapp'])}.`,
  );
});

test('a correction found from a Windows registration in another case names the located command, never that name (7d)', async () => {
  const harness = await newHarness({ store: false });
  // Gmail installed globally on Windows, registered by its command as Windows wrote it: another case, `.CMD`.
  const gmail = channelManifest('gmail');
  assert.ok(gmail);
  const prefix = tempDir('agent-whatsapp-npm-prefix-');
  const root = join(prefix, 'node_modules', '@agentcomms', 'gmail');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@agentcomms/gmail',
      version: VERSION,
      type: 'module',
      engines: { node: '>=22.12.0' },
      bin: { [gmail.binary]: './dist/cli.mjs' },
      agentcomms: { channel: 'gmail', binary: gmail.binary },
    }),
  );
  writeFileSync(join(root, 'dist', 'cli.mjs'), 'export {};\n');
  const mixed = join(prefix, 'Agent-Gmail.CMD');
  writeFileSync(
    mixed,
    '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\@agentcomms\\gmail\\dist\\cli.mjs" %*\r\n',
  );
  const claude = knownClientConfigs(harness.personEnv, 'win32').find((file) => file.client === 'claude-code')?.path;
  assert.ok(claude);
  mkdirSync(join(claude, '..'), { recursive: true });
  writeFileSync(claude, JSON.stringify({ mcpServers: { gmail: { command: mixed, args: ['mcp'] } } }));

  const record = await openCore({ env: harness.personEnv }).approvals.create({
    inboxId: 'ibx_AAAAAAAAAAAAAAAA',
    draftId: 'r-1',
    draftMessageId: 'm-1',
    channel: 'whatsapp',
    sendEpoch: 0,
    contentDigest: 'd'.repeat(64),
    policy: 'confirm',
    requiredPolicy: 'confirm',
    riskFlags: [],
    expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'hi' },
  });
  // The correction a person is handed for a send's approval: the approve of each channel that can have prepared one,
  // as this machine's registrations find it.
  const registered = await whatsappHandoffs(harness.personEnv, 'win32').registered();
  const approve = registered.of('gmail', ['approve', record.approvalId]);
  assert.ok(isCommand(approve), 'message' in approve ? approve.message : '');
  assert.equal(approve.words[0], process.execPath, 'this Node, not the registration’s');
  assert.ok(approve.words.includes(join(root, 'dist', 'cli.mjs')), JSON.stringify(approve.words));
  const hint = sendApprovesHint(registered, record.approvalId);
  assert.doesNotMatch(hint, /Agent-Gmail\.CMD/i);
  assertNoBareCommand(hint);

  // WhatsApp's own approve is not where that is said: another kind's id is the one NOT_FOUND there (design
  // 2026-10-05 §D2), naming no registration at all.
  const { streams, said } = terminal();
  const refused = await harness.cli(['approve', record.approvalId], {
    env: harness.personEnv,
    platform: 'win32',
    streams,
  });
  assert.equal(refused.code, 66, said());
  assert.ok(!said().includes(hint), said());
  assert.doesNotMatch(said(), /Agent-Gmail\.CMD/i);
  assertNoBareCommand(said());
});

// ── A Node core runs on and WhatsApp does not ───────────────────────────────────────────────────────────────────────

test('the range the locator checks for WhatsApp is the floor WhatsApp refuses below: its manifest’s engines', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { engines: { node: string } };
  assert.equal(manifest.engines.node, `>=${MIN_NODE}`);
  const core = JSON.parse(readFileSync(join(PACKAGE, '..', 'core', 'package.json'), 'utf8')) as {
    engines: { node: string };
  };
  assert.notEqual(core.engines.node, manifest.engines.node, 'core runs on Nodes WhatsApp does not: the case below');
});

test('on a Node core supports and WhatsApp does not, WhatsApp’s own commands are the locator’s Node-range failure', async () => {
  const harness = await newHarness({ store: false });
  for (const version of ['v22.12.0', 'v22.15.1']) {
    const handoffs = whatsappHandoffs(harness.env, 'darwin', { version, execArgv: [] });
    const own = handoffs.own(['sync', '--account', ACCOUNT]);
    assert.ok(!isCommand(own), `no command to run WhatsApp with on ${version}`);
    assert.equal(own.reason, 'engine');
    assert.equal(own.nodeRange, `>=${MIN_NODE}`);
    assert.equal(
      own.message,
      `WhatsApp ${VERSION} (@agentcomms/whatsapp) needs Node >=${MIN_NODE}, and this is Node ${version}, so there is no command to run it with here. Run it again under a Node in that range.`,
    );
    assert.ok(!('words' in own), 'nothing to run');
    // Core's own command still runs there: its range is wider.
    assert.ok(isCommand(handoffs.core(['update'])), `core runs on ${version}`);
  }
  assert.ok(
    isCommand(whatsappHandoffs(harness.env, 'darwin', { version: `v${MIN_NODE}`, execArgv: [] }).own(['status'])),
  );
});

test('a core process on such a Node, finding this WhatsApp registered, gets the Node-range failure and no command (0a)', async () => {
  const harness = await newHarness({ store: false });
  // Core as a caller: a module of the core this package installs, as core's own CLI or server is.
  const coreCaller = { url: import.meta.resolve('@agentcomms/core'), packageName: '@agentcomms/core' };
  // This checkout's WhatsApp, registered from source with an interpreter that is never run.
  const server: RegisteredServer = {
    client: 'claude-code',
    path: join(harness.home, '.claude.json'),
    name: 'whatsapp',
    command: join(tempDir(), 'node-24', 'bin', 'node'),
    args: [OWN_SOURCE_CLI, 'mcp'],
  } as RegisteredServer;
  const paths = pathsOf(harness.env);
  for (const version of ['v22.12.0', 'v22.15.1']) {
    const found = cliHandoffs({ caller: coreCaller, paths, platform: 'darwin', runtime: { version, execArgv: [] } })
      .withRegistrations([server])
      .of('whatsapp', ['sync', '--account', ACCOUNT]);
    assert.ok(!isCommand(found), `no command on ${version}`);
    assert.equal(found.reason, 'engine');
    assert.equal(found.nodeRange, `>=${MIN_NODE}`);
    assert.match(
      found.message,
      new RegExp(`needs Node >=${MIN_NODE.replace(/\./g, '\\.')}, and this is Node ${version}`),
    );
    assert.ok(!('words' in found), 'nothing a person could paste and see WhatsApp refuse');
  }
  const runs = cliHandoffs({
    caller: coreCaller,
    paths,
    platform: 'darwin',
    runtime: { version: `v${MIN_NODE}`, execArgv: [] },
  })
    .withRegistrations([server])
    .of('whatsapp', ['sync', '--account', ACCOUNT]);
  assert.ok(isCommand(runs), 'message' in runs ? runs.message : '');
  assertLocatedHere(runs.words, harness.env, ['sync', '--account', ACCOUNT]);
});
