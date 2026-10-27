import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  asV2,
  handoffText,
  isCommand,
  launcherPaths,
  managedRuntimeDir,
  managedRuntimeEntry,
  readPointer,
} from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tarballOf } from '../../core/test/helpers/provenance-fixture.ts';
import { GmailContext } from '../src/context.ts';
import { clientServesInbox } from '../src/mcp/install.ts';
import { clientAdd } from '../src/operations/clients.ts';
import { VERSION } from '../src/version.ts';
import {
  assertNoBareCommand,
  GMAIL_SOURCE_CLI,
  gmailCommand,
  gmailHandoffs,
  gmailRetryWords,
  locatedGmailLine,
} from './support/handoffs.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';
import {
  applied,
  approvalAsked,
  type CliRun,
  cli,
  connect,
  pendingApproval,
  type ToolResult,
  toolError,
  wire,
} from './support/surfaces.ts';

/*
 * Registering the Gmail server, and removing its old runtimes, are changes a person approves (design 2026-09-25
 * §3.1) — whichever surface asks. `comms_server_install` and `comms_server_prune` on the core server always asked;
 * `agent-gmail mcp install`, `mcp prune` and `setup --mcp-client` did not, so an agent could register a server by
 * picking the command over the tool. They are now the same change, and these tests hold them to it: the same
 * preview, one approval good on either surface, and nothing written before it is claimed.
 *
 * Nothing here reaches npm, a real client config or the keychain: every client config is under a temporary home, the
 * `npx` launcher only names a package that nothing runs (`--no-verify`), and a managed runtime is laid out by hand.
 */

/**
 * A harness with one mailbox, and a home of its own for the client configs — Windows' too, which are found through
 * `APPDATA` rather than the home.
 */
async function machine(): Promise<{ harness: Harness; home: string; env: NodeJS.ProcessEnv }> {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const home = tempDir();
  return {
    harness,
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
    },
  };
}

/**
 * The core MCP server, started as a client starts it — `agentcomms mcp`, from the core this package is built
 * against — over stdio, with this harness's configuration and the same home. Its data directory is the harness's, so
 * a runtime one surface finds is the one the other finds.
 *
 * Its environment is pinned whole. The transport adds `PATH` and `HOME` from the process running the tests — and
 * `APPDATA` on Windows, where a client's config is found through it — unless they are given, so they are: the home is
 * the test's, and `PATH` holds only `ps`, which `prune` needs to see what is running and nothing else it could start.
 */
async function coreServer(harness: Harness, env: NodeJS.ProcessEnv, verifiedWith?: string) {
  /*
   * Core verifies the release whose runtime it registers on (re-review of 0.20.0, severity 4), and a server built from
   * the package reads npm and Sigstore for it, which no test may reach. Handed a registry, it is core's own server with
   * the test's verifier (`core/test/fixtures/verified-core-server.ts`), reading that registry.
   */
  const coreCli =
    verifiedWith === undefined
      ? join(dirname(fileURLToPath(import.meta.resolve('@agentcomms/core'))), 'cli.mjs')
      : fileURLToPath(new URL('../../core/test/fixtures/verified-core-server.ts', import.meta.url));
  const bin = tempDir();
  const ps = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path));
  if (ps) symlinkSync(ps, join(bin, 'ps'));
  const serverEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...harness.env,
    ...env,
    PATH: bin,
    AGENT_COMMS_DATA_DIR: harness.core.paths.dataDir,
    ...(verifiedWith === undefined ? {} : { npm_config_registry: verifiedWith }),
  })) {
    if (value !== undefined) serverEnv[key] = value;
  }
  const client = new Client({ name: 'registration-test', version: '0' });
  const args =
    verifiedWith === undefined
      ? [coreCli, 'mcp']
      : ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', coreCli];
  await client.connect(new StdioClientTransport({ command: process.execPath, args, env: serverEnv, stderr: 'ignore' }));
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    close: () => client.close(),
  };
}

/**
 * A registry on the loopback address naming this release of every package, with the tarball the test's verifier is
 * shown signed (`tarballOf`): what core reads to verify the runtime it registers on.
 */
async function releaseRegistry(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const name = decodeURIComponent(request.url ?? '').slice(1);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        'dist-tags': { latest: VERSION },
        versions: { [VERSION]: { dist: { integrity: tarballOf(name, VERSION) } } },
      }),
    );
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

/** The preview without its first line, which names the approval: what two approvals for one change share. */
const body = (preview: string) => preview.split('\n').slice(1).join('\n');

/** A managed runtime of this release, laid out as the installer leaves one, so registering it fetches nothing. */
async function readyRuntime(harness: Harness): Promise<string> {
  const { dataDir } = harness.core.paths;
  const root = managedRuntimeDir(dataDir, '@agentcomms/gmail', VERSION);
  const entry = managedRuntimeEntry(dataDir, '@agentcomms/gmail', VERSION);
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, '');
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@agentcomms/gmail': VERSION } }));
  await writeFile(
    join(root, 'node_modules', '@agentcomms', 'gmail', 'package.json'),
    JSON.stringify({ name: '@agentcomms/gmail', version: VERSION }),
  );
  // The lockfile npm writes, with the tarball a test's registry names: what core holds a runtime on disk to.
  await writeFile(
    join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/@agentcomms/gmail': { version: VERSION, integrity: tarballOf('@agentcomms/gmail', VERSION) },
      },
    }),
  );
  return entry;
}

const envelopeError = (run: CliRun) => run.envelope().error;

/** The four folder pins a registration is written with (CUE-403), in the order the installer writes them. */
function pinWords(paths: { configDir: string; stateDir: string; dataDir: string; secretsDir: string }): string[] {
  const { configDir, stateDir, dataDir, secretsDir } = paths;
  return ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir];
}

test('an approval from comms_server_install registers from `agent-gmail mcp install --approval`, and the other way round', async () => {
  const { harness, home, env } = await machine();
  const npm = await releaseRegistry();
  const server = await coreServer(harness, env, npm.url);
  try {
    // ── Prepared in chat, claimed at the command line ──
    const request = {
      channel: 'gmail',
      client: 'cursor',
      launcher: 'npx',
      inbox: 'work',
      readOnly: true,
      noVerify: true,
    };
    const command = [
      'mcp',
      'install',
      '--client',
      'cursor',
      '--standalone',
      '--launcher',
      'npx',
      '--inbox',
      'work',
      '--read-only',
      '--no-verify',
      '--json',
    ];
    const cursor = join(home, '.cursor', 'mcp.json');

    const fromChat = approvalAsked(await server.call('comms_server_install', request));
    assert.match(
      fromChat.preview,
      /registers the Gmail MCP server with cursor as "gmail", pinned to the mailbox work, read-only/,
    );
    assert.match(fromChat.preview, new RegExp(`fetch @agentcomms/gmail-mcp@${VERSION.replaceAll('.', '\\.')}`));
    // The command, asked the same thing, says the same thing: the approval is bound to these words.
    const fromCommand = await cli(harness, command, { env });
    assert.equal(body(String(envelopeError(fromCommand)?.details?.preview)), body(fromChat.preview));
    assert.equal(existsSync(cursor), false, 'nothing is written while it is only asked');

    // For other arguments — the same server without `--read-only` — the approval is not the command's to claim.
    const narrower = approvalAsked(await server.call('comms_server_install', request));
    const wider = await cli(
      harness,
      [...command.filter((word) => word !== '--read-only'), '--approval', narrower.approvalId],
      { env },
    );
    assert.equal(envelopeError(wider)?.code, 'APPROVAL_VOID', wider.stdout);
    assert.equal(existsSync(cursor), false, 'a refused claim writes nothing');

    const claimed = await cli(harness, [...command, '--approval', fromChat.approvalId], { env });
    assert.equal(claimed.code, 0, claimed.stdout);
    const result = claimed.envelope<{ applied: boolean; restart: string }>().data;
    assert.equal(result?.applied, true);
    assert.match(String(result?.restart), /Restart cursor/);
    const written = JSON.parse(await readFile(cursor, 'utf8')) as { mcpServers: { gmail: { args: string[] } } };
    assert.deepEqual(written.mcpServers.gmail.args, [
      '-y',
      `@agentcomms/gmail-mcp@${VERSION}`,
      ...pinWords(harness.core.paths),
      '--inbox',
      'work',
      '--read-only',
    ]);

    // ── Prepared at the command line, claimed in chat — with the default launcher, whose runtime is here ──
    await readyRuntime(harness);
    const gemini = join(home, '.gemini', 'settings.json');
    const asked = await cli(
      harness,
      ['mcp', 'install', '--client', 'gemini', '--standalone', '--no-verify', '--json'],
      { env },
    );
    const approvalId = pendingApproval(asked);
    assert.match(
      String(envelopeError(asked)?.details?.preview),
      /registers the Gmail MCP server with gemini as "gmail"/,
    );
    assert.equal(existsSync(gemini), false);

    const done = applied<{ applied: boolean }>(
      await server.call('comms_server_install', { channel: 'gmail', client: 'gemini', noVerify: true, approvalId }),
    );
    assert.equal(done.applied, true);
    const settings = JSON.parse(await readFile(gemini, 'utf8')) as {
      mcpServers: { gmail: { command: string; args: string[] } };
    };
    // It starts Gmail's stable launcher — the program on POSIX, Node's first word on Windows — which starts the runtime.
    const started = settings.mcpServers.gmail;
    const { dataDir } = harness.core.paths;
    assert.deepEqual(process.platform === 'win32' ? started.args : [started.command, ...started.args], [
      launcherPaths(dataDir, 'gmail').launcher,
      ...pinWords(harness.core.paths),
      'mcp',
    ]);
    assert.equal(
      (await readPointer(dataDir, 'gmail'))?.current,
      managedRuntimeDir(dataDir, '@agentcomms/gmail', VERSION),
    );

    // Spent: the same approval registers nothing a second time, from either surface.
    const again = await cli(
      harness,
      [
        'mcp',
        'install',
        '--client',
        'gemini',
        '--standalone',
        '--no-verify',
        '--force',
        '--json',
        '--approval',
        approvalId,
      ],
      {
        env,
      },
    );
    assert.notEqual(again.code, 0, again.stdout);
    assert.ok(
      toolError(
        await server.call('comms_server_install', {
          channel: 'gmail',
          client: 'gemini',
          noVerify: true,
          force: true,
          approvalId,
        }),
      ),
    );
  } finally {
    await server.close();
    await npm.close();
  }
});

test('a person at the terminal approves a registration there and then, having read what it does', async () => {
  const { harness, home, env } = await machine();
  const run = await cli(
    harness,
    ['mcp', 'install', '--client', 'cursor', '--standalone', '--launcher', 'npx', '--no-verify'],
    {
      env,
      tty: true,
      answer: true,
    },
  );
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /CHANGE PREVIEW[\s\S]*registers the Gmail MCP server with cursor/, 'shown before asked');
  assert.match(run.stderr, /Type yes to apply this change/);
  assert.ok(existsSync(join(home, '.cursor', 'mcp.json')));

  // An agent holding a terminal is not a person at it: it gets the preview and the id, and nothing is written.
  const other = await machine();
  const agent = await cli(
    other.harness,
    ['mcp', 'install', '--client', 'cursor', '--standalone', '--launcher', 'npx', '--no-verify'],
    {
      env: { ...other.env, CLAUDECODE: '1' },
      tty: true,
      answer: true,
    },
  );
  assert.equal(agent.code, 10, `${agent.stdout}${agent.stderr}`);
  assert.match(agent.stderr, /--approval ap_/);
  assert.equal(existsSync(join(other.home, '.cursor', 'mcp.json')), false);
});

test('printing an entry, or `--client json`, writes nothing and so asks nobody', async () => {
  const { harness, home, env } = await machine();
  for (const argv of [
    ['mcp', 'install', '--client', 'cursor', '--standalone', '--launcher', 'npx', '--no-verify', '--print', '--json'],
    ['mcp', 'install', '--client', 'json', '--standalone', '--launcher', 'npx', '--no-verify', '--json'],
  ]) {
    const run = await cli(harness, argv, { env });
    assert.equal(run.code, 0, `${argv.join(' ')}: ${run.stdout}`);
    assert.equal(run.envelope<{ applied: boolean }>().data?.applied, false);
  }
  assert.deepEqual(await harness.core.approvals.list(), [], 'no approval was made');
  assert.equal(existsSync(join(home, '.cursor', 'mcp.json')), false);
});

test('`setup --mcp-client` stops for approval without registering, and only `--mcp-approval` carries it', async () => {
  const { harness, home, env } = await machine();
  const cursor = join(home, '.cursor', 'mcp.json');
  const argv = ['setup', '--mcp-client', 'cursor', '--launcher', 'local', '--json'];

  const first = await cli(harness, argv, { env });
  assert.equal(first.code, 10, `a registration nobody approved must not exit 0: ${first.stdout}`);
  const report = first.envelope<{
    did: string[];
    blocked: { step: string; needs: string; approvalId: string; preview: string; hint: string };
  }>().data;
  assert.equal(report?.blocked.step, 'mcp');
  assert.match(String(report?.blocked.preview), /registers the Gmail MCP server with cursor as "gmail"/);
  // This installation's own `setup`, located (CUE-403), carrying the registration's approval.
  const rerun = locatedGmailLine(String(report?.blocked.hint), [
    'setup',
    '--mcp-client',
    'cursor',
    '--launcher',
    'local',
    '--json',
    '--mcp-approval',
    String(report?.blocked.approvalId),
  ]);
  assert.ok(rerun);
  assert.deepEqual(report?.did, []);
  assert.equal(existsSync(cursor), false, 'nothing was registered');

  // `--approval` is the OAuth client's, and this machine has one: handed the registration's id, it is refused, and
  // nothing is registered or asked. It used to be dropped, and the run went on to ask again — past the update check's
  // stop, which had let it through on that id.
  const wrongFlag = await cli(harness, [...argv, '--approval', String(report?.blocked.approvalId)], { env });
  assert.equal(wrongFlag.code, 64, wrongFlag.stdout);
  const refusal = wrongFlag.envelope<unknown>().error as { code: string; message: string };
  assert.equal(refusal.code, 'USAGE');
  assert.match(refusal.message, /already registered, so this run registers none and takes no --approval/);
  assert.deepEqual(
    (await harness.core.approvals.list()).map((record) => asV2(record)?.approvalId),
    [report?.blocked.approvalId],
    'no new approval was prepared',
  );
  assert.equal(existsSync(cursor), false);

  const done = await cli(harness, [...argv, '--mcp-approval', String(report?.blocked.approvalId)], { env });
  assert.equal(done.code, 0, done.stdout);
  assert.ok(done.envelope<{ did: string[] }>().data?.did.includes('registered the server with cursor'));
  assert.ok(existsSync(cursor));

  // Read by a person, the report says what they are agreeing to and what to run once they have.
  const other = await machine();
  const plain = await cli(other.harness, ['setup', '--mcp-client', 'cursor', '--launcher', 'local'], {
    env: other.env,
  });
  assert.equal(plain.code, 10, plain.stderr);
  assert.match(plain.stdout, /Stopped at: mcp/);
  assert.match(plain.stdout, /CHANGE PREVIEW[\s\S]*registers the Gmail MCP server with cursor/);
  assert.match(plain.stdout, /--mcp-approval ap_/);
});

test('an interactive setup given `--mcp-client` asks as `mcp install` does: nobody has answered anything yet', async () => {
  const argv = ['setup', '--mcp-client', 'cursor', '--launcher', 'local', '--no-browser', '--no-tui'];

  // A terminal held by an agent: the preview and the id, the flag to carry it back, and nothing registered.
  const { harness, home, env } = await machine();
  const cursor = join(home, '.cursor', 'mcp.json');
  const agentEnv = { ...env, CLAUDECODE: '1' };
  const agent = await cli(harness, argv, { env: agentEnv, tty: true, answer: true });
  assert.equal(agent.code, 10, `${agent.stdout}${agent.stderr}`);
  assert.match(agent.stdout, /registers the Gmail MCP server with cursor/);
  const id = /--mcp-approval (ap_[\w-]+)`/.exec(agent.stderr)?.[1];
  assert.ok(id, `the hint names --mcp-approval: ${agent.stderr}`);
  assert.equal(existsSync(cursor), false);

  const claimed = await cli(harness, [...argv, '--mcp-approval', id], { env: agentEnv, tty: true });
  assert.equal(claimed.code, 0, `${claimed.stdout}${claimed.stderr}`);
  assert.ok(existsSync(cursor));

  // A person at the terminal reads the preview and says yes.
  const person = await machine();
  const said = await cli(person.harness, argv, { env: person.env, tty: true, answer: true });
  assert.equal(said.code, 0, `${said.stdout}${said.stderr}`);
  assert.match(said.stdout, /CHANGE PREVIEW[\s\S]*registers the Gmail MCP server with cursor/);
  assert.ok(existsSync(join(person.home, '.cursor', 'mcp.json')));
});

test('an interactive setup that asked "Connect this to an agent?" takes the yes under chat, and the code under confirm', async () => {
  const argv = ['setup', '--launcher', 'local', '--no-browser', '--no-tui'];
  // The target mailbox is already connected: yes to connecting an agent, then the fourth client in the list, Cursor.
  const answers = [
    [/which one\?/, '1'],
    [/Connect this to an agent\?/, 'y'],
    [/which one\?/, '4'],
  ] as const;

  // Under `chat` the answer a moment ago is the approval: nothing more is asked, and the server is registered.
  const chat = await machine();
  const said = await cli(chat.harness, argv, { env: chat.env, tty: true, replies: answers });
  assert.equal(said.code, 0, `${said.stdout}${said.stderr}`);
  assert.doesNotMatch(said.stderr, /Type yes to apply this change/, 'it asked again for what was just asked for');
  assert.ok(existsSync(join(chat.home, '.cursor', 'mcp.json')));

  // Under `confirm` a registration is approved with the code, whoever asked for it — a yes typed into a question is
  // what an agent holding a terminal could give. Enter instead of the code: nothing registered.
  const confirm = async () => {
    const m = await machine();
    await m.harness.core.config.update((c) => ({ ...c, defaults: { ...c.defaults, changePolicy: 'confirm' } }));
    return m;
  };
  const unanswered = await confirm();
  const refused = await cli(unanswered.harness, argv, {
    env: unanswered.env,
    tty: true,
    replies: [...answers, [/to approve this change/, '']],
  });
  assert.match(refused.stdout, /CHANGE PREVIEW[\s\S]*registers the Gmail MCP server with cursor/);
  assert.equal(existsSync(join(unanswered.home, '.cursor', 'mcp.json')), false, 'registered without the code');

  // And the code, typed back, registers it.
  const confirmed = await confirm();
  const typed = await cli(confirmed.harness, argv, { env: confirmed.env, tty: true, replies: answers, answer: true });
  assert.equal(typed.code, 0, `${typed.stdout}${typed.stderr}`);
  assert.ok(existsSync(join(confirmed.home, '.cursor', 'mcp.json')));
});

test('an agent at a terminal that picked the client from the list is told to run setup again naming it', async () => {
  /*
   * `--mcp-approval` is claimed only for a client named with `--mcp-client`: one picked from the list may be declined,
   * and an approval the run then never claimed would have been dropped past the update check's stop. So the command
   * an agent is told to run again carries the client it picked, and that command registers it.
   */
  const argv = ['setup', '--launcher', 'local', '--no-browser', '--no-tui'];
  const { harness, home, env } = await machine();
  const agentEnv = { ...env, CLAUDECODE: '1' };
  const asked = await cli(harness, argv, {
    env: agentEnv,
    tty: true,
    replies: [
      [/which one\?/, '1'],
      [/Connect this to an agent\?/, 'y'],
      [/which one\?/, '4'],
    ],
  });
  assert.equal(asked.code, 10, `${asked.stdout}${asked.stderr}`);
  const rerun = /`([^`]* setup [^`]*--mcp-client cursor --mcp-approval (ap_[\w-]+))`/.exec(asked.stderr);
  assert.ok(rerun, `the command to run again names the client picked: ${asked.stderr}`);
  assertNoBareCommand(asked.stderr);
  assert.equal(existsSync(join(home, '.cursor', 'mcp.json')), false);

  /*
   * This installation's own command, located: the words after its entry are what the person runs again. Rendered for
   * this machine's shell — the registration's gate is not given `cli`'s darwin — so it is held to the command made for
   * that shell, and its words are read from that command rather than from a POSIX reading of a Windows line.
   */
  const expected = gmailHandoffs(harness.core.paths).own([
    ...argv,
    '--mcp-client',
    'cursor',
    '--mcp-approval',
    rerun?.[2] ?? '',
  ]);
  assert.ok(isCommand(expected));
  assert.equal(rerun?.[1], handoffText(expected));
  const again = expected.words.slice(expected.words.indexOf(GMAIL_SOURCE_CLI) + 1);
  const claimed = await cli(harness, again, { env: agentEnv, tty: true });
  assert.equal(claimed.code, 0, `${claimed.stdout}${claimed.stderr}`);
  assert.ok(existsSync(join(home, '.cursor', 'mcp.json')));
});

test(
  '`mcp prune`: a dry run is free; removing needs an approval, and removes only what it showed',
  process.platform === 'win32'
    ? { skip: 'no `ps` on Windows: prune keeps everything when it cannot list processes' }
    : {},
  async () => {
    const { harness, env } = await machine();
    const { dataDir } = harness.core.paths;
    const runtime = async (version: string) => {
      const dir = managedRuntimeDir(dataDir, '@agentcomms/gmail', version);
      await mkdir(join(dir, 'node_modules', '@agentcomms', 'gmail'), { recursive: true });
      return dir;
    };
    const old = await runtime('0.0.1');
    const current = await runtime(VERSION);

    const dry = await cli(harness, ['mcp', 'prune', '--dry-run', '--json'], { env });
    assert.equal(dry.code, 0, dry.stdout);
    assert.deepEqual(
      dry.envelope<{ removed: { path: string }[] }>().data?.removed.map((item) => item.path),
      [old],
    );
    assert.deepEqual(await harness.core.approvals.list(), [], 'a dry run asks nobody');

    const asked = await cli(harness, ['mcp', 'prune', '--json'], { env });
    const approvalId = pendingApproval(asked);
    assert.match(String(envelopeError(asked)?.details?.preview), /deletes the unused Gmail runtime 0\.0\.1/);
    assert.ok(existsSync(old), 'asking removed nothing');

    const done = await cli(harness, ['mcp', 'prune', '--json', '--approval', approvalId], { env });
    assert.equal(done.code, 0, done.stdout);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(current), 'this release stays');
  },
);

test('a server name that could rewrite the preview is refused by `agent-gmail mcp install`, before anybody is asked', async () => {
  // Quoted in the sentence the person approves, this name read as a pin and `--read-only` the entry would not have.
  const { harness, home, env } = await machine();
  const spoof = 'gmail", pinned to the mailbox work, read-only, "';
  const run = await cli(harness, ['mcp', 'install', '--client', 'cursor', '--standalone', '--name', spoof, '--json'], {
    env,
  });
  assert.equal(run.code, 64, run.stdout);
  assert.match(String(envelopeError(run)?.message), /a server name is 1 to 64 letters/);
  assert.deepEqual(await harness.core.approvals.list(), [], 'nobody was asked');
  assert.equal(existsSync(join(home, '.cursor', 'mcp.json')), false);
});

test('`agent-gmail mcp install` and comms_server_install warn about the same ungated servers', async () => {
  const { harness, home, env } = await machine();
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'old-gmail': { command: 'npx', args: ['-y', '@artymclabin/gmail-mcp'] },
        'team-slack': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
      },
    }),
  );
  const server = await coreServer(harness, env);
  try {
    const command = await cli(
      harness,
      ['mcp', 'install', '--client', 'cursor', '--standalone', '--print', '--no-verify', '--json'],
      {
        env,
      },
    );
    assert.equal(command.code, 0, command.stdout);
    const fromCommand = command.envelope<{ warnings: string[] }>().data?.warnings ?? [];
    const fromChat = applied<{ warnings: string[] }>(
      await server.call('comms_server_install', { channel: 'gmail', client: 'cursor', print: true, noVerify: true }),
    ).warnings;
    assert.deepEqual(fromChat, fromCommand);
    assert.equal(fromCommand.length, 1, JSON.stringify(fromCommand));
    assert.match(fromCommand[0] ?? '', /@artymclabin\/gmail-mcp is registered with cursor as "old-gmail"/);
  } finally {
    await server.close();
  }
});

test(
  'an approval to prune from comms_server_prune is claimed by `agent-gmail mcp prune --approval`, and the other way round',
  process.platform === 'win32'
    ? { skip: 'no `ps` on Windows: prune keeps everything when it cannot list processes' }
    : {},
  async () => {
    const { harness, env } = await machine();
    const { dataDir } = harness.core.paths;
    const runtime = async (version: string) => {
      const dir = managedRuntimeDir(dataDir, '@agentcomms/gmail', version);
      await mkdir(join(dir, 'node_modules', '@agentcomms', 'gmail'), { recursive: true });
      return dir;
    };
    const server = await coreServer(harness, env);
    try {
      // Prepared in chat, claimed at the command line.
      const first = await runtime('0.0.1');
      const fromChat = approvalAsked(await server.call('comms_server_prune', { channel: 'gmail' }));
      assert.match(fromChat.preview, /deletes the unused Gmail runtime 0\.0\.1/);
      const claimed = await cli(harness, ['mcp', 'prune', '--json', '--approval', fromChat.approvalId], { env });
      assert.equal(claimed.code, 0, claimed.stdout);
      assert.deepEqual(
        claimed.envelope<{ removed: { path: string }[] }>().data?.removed.map((item) => item.path),
        [first],
      );
      assert.ok(!existsSync(first));

      // Prepared at the command line, claimed in chat.
      const second = await runtime('0.0.2');
      const asked = await cli(harness, ['mcp', 'prune', '--json'], { env });
      const approvalId = pendingApproval(asked);
      assert.ok(existsSync(second), 'asking removed nothing');
      const done = applied<{ removed: { path: string }[] }>(
        await server.call('comms_server_prune', { channel: 'gmail', approvalId }),
      );
      assert.deepEqual(
        done.removed.map((item) => item.path),
        [second],
      );
      assert.ok(!existsSync(second));
    } finally {
      await server.close();
    }
  },
);

/*
 * `setup --inbox … --mcp-client …` without a terminal stops at the browser: the sign-in is handed off, and the
 * registration step comes after it. That step used to be dropped there — the mailbox was connected later by a finish
 * that knew nothing of it, everything exited 0, and the server was never registered. The request now travels with the
 * sign-in, and the finish that connects the mailbox takes it up, through the same change `setup` and `mcp install`
 * make. None of these sign-ins leaves a listener waiting: each is consented to before its test ends.
 */

/** A machine `setup` has taken past its client step — an OAuth client, no mailbox — with a home for client configs. */
async function clientOnly(): Promise<{ harness: Harness; env: NodeJS.ProcessEnv; cursor: string }> {
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

/** `setup` asked for a mailbox and the agent connection at once, with the launcher that needs nothing from npm. */
const BOTH = [
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
  handoff: { authUrl: string; finish: string; registerWith?: { client: string; launcher?: string; replace?: boolean } };
  blocked: { step: string; hint: string };
  did: string[];
}

/** `setup` handing the sign-in off, as an agent runs it, and the browser coming back: what the finish then finds. */
async function handedOff(machine: Awaited<ReturnType<typeof clientOnly>>, extra: string[] = []): Promise<HandOff> {
  const run = await cli(machine.harness, [...BOTH, ...extra, '--json'], { env: machine.env });
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const report = run.envelope<HandOff>().data;
  assert.ok(report?.handoff, run.stdout);
  await fetch(machine.harness.google.consent(report.handoff.authUrl));
  return report;
}

/** A printed command as the argv this CLI takes: without the binary. */
/** The words after the program of a command Gmail printed for itself, located (CUE-403): what is run again here. */
const argvOf = (command: string) => gmailRetryWords(command);

/** The sign-in's record on disk, as the finish will read it. */
async function flowRecord(harness: Harness, flowId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(harness.core.paths.stateDir, 'flows', `${flowId}.json`), 'utf8'));
}

test('`setup --inbox --mcp-client` hands the registration on with the sign-in, and says the finish will ask for it', async () => {
  const machine = await clientOnly();
  const run = await cli(machine.harness, BOTH, { env: machine.env });
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const finish = / inbox add --finish (fl_\w+) --wait (\d+)/.exec(run.stdout);
  assertNoBareCommand(run.stdout);
  assert.ok(finish, run.stdout);
  // One wait, whoever prints the finish: `setup` said 120 where `inbox add --start` said 60.
  assert.equal(finish[2], '60');
  assert.match(
    run.stdout,
    /--wait 60\nFinishing it will also register the Gmail server with cursor, after the person approves the registration\./,
  );
  // Recorded where the finish will find it, and nothing registered yet.
  assert.deepEqual((await flowRecord(machine.harness, String(finish[1]))).registerWith, {
    client: 'cursor',
    launcher: 'local',
  });
  assert.equal(existsSync(machine.cursor), false);
  const link = /^\s+(http\S+)$/m.exec(run.stdout)?.[1];
  assert.ok(link, run.stdout);
  await fetch(machine.harness.google.consent(link));
});

test('finishing it without a terminal connects the mailbox and hands back the registration, which `mcp install --approval` claims', async () => {
  const machine = await clientOnly();
  const report = await handedOff(machine);
  assert.deepEqual(report.handoff.registerWith, { client: 'cursor', launcher: 'local' });
  assert.match(report.blocked.hint, /also registers the server with cursor/);
  assert.deepEqual(report.did, ['started a sign-in for "home"'], 'nothing claims the registration happened');

  const finished = await cli(machine.harness, [...argvOf(report.handoff.finish), '--json'], { env: machine.env });
  // Exit 10, "waiting for an approval", in an envelope that says the finish itself worked.
  assert.equal(finished.code, 10, `${finished.stdout}${finished.stderr}`);
  const envelope = finished.envelope<{
    alias: string;
    inbox: { email: string };
    registration: { client: string; status: string; approvalId: string; preview: string; claim: string };
  }>();
  assert.equal(envelope.ok, true, finished.stdout);
  assert.equal(envelope.data?.alias, 'home');
  assert.equal(envelope.data?.inbox.email, 'sam@example.test');
  const registration = envelope.data?.registration;
  assert.equal(registration?.client, 'cursor');
  assert.equal(registration?.status, 'approval-required');
  assert.match(String(registration?.approvalId), /^ap_/);
  assert.match(String(registration?.preview), /registers the Gmail MCP server with cursor as "gmail"/);
  // This installation's own `mcp install`, located, carrying the approval (CUE-403).
  assert.equal(
    registration?.claim,
    // For darwin, the shell `cli` gives the command that printed the claim.
    gmailCommand(
      machine.harness.core.paths,
      [
        'mcp',
        'install',
        '--client',
        'cursor',
        '--standalone',
        '--launcher',
        'local',
        '--approval',
        String(registration?.approvalId),
      ],
      'darwin',
    ),
  );
  assert.equal(existsSync(machine.cursor), false, 'nothing is registered before the person agrees');
  // The mailbox is connected whatever the registration is waiting for.
  const listed = await cli(machine.harness, ['inbox', 'list', '--json'], { env: machine.env });
  assert.deepEqual(
    listed.envelope<{ alias: string }[]>().data?.map((inbox) => inbox.alias),
    ['home'],
  );

  // The same change `mcp install` makes, so its `--approval` claims it and registers.
  const claimed = await cli(machine.harness, [...argvOf(String(registration?.claim)), '--json'], {
    env: machine.env,
  });
  assert.equal(claimed.code, 0, `${claimed.stdout}${claimed.stderr}`);
  assert.equal(claimed.envelope<{ applied: boolean }>().data?.applied, true);
  const written = JSON.parse(await readFile(machine.cursor, 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.ok(written.mcpServers.gmail, JSON.stringify(written));

  // Read by a person, the finish says the same: connected, then what waits, and the command that claims it.
  const other = await clientOnly();
  const plain = await cli(other.harness, argvOf((await handedOff(other)).handoff.finish), { env: other.env });
  assert.equal(plain.code, 10, `${plain.stdout}${plain.stderr}`);
  assert.match(plain.stdout, /Connected sam@example\.test as "home"/);
  assert.match(plain.stdout, /register the Gmail server with cursor\. That waits for the person's approval/);
  assert.match(plain.stdout, /CHANGE PREVIEW[\s\S]*registers the Gmail MCP server with cursor/);
  assert.match(plain.stdout, /run `[^`]* mcp install --client cursor --standalone --launcher local --approval ap_\w+`/);
  assertNoBareCommand(plain.stdout);
});

test('a person finishing it at a terminal approves the registration there and then', async () => {
  const machine = await clientOnly();
  const report = await handedOff(machine);
  const finished = await cli(machine.harness, argvOf(report.handoff.finish), {
    env: machine.env,
    tty: true,
    answer: true,
  });
  assert.equal(finished.code, 0, `${finished.stdout}${finished.stderr}`);
  assert.match(finished.stderr, /Connected sam@example\.test as "home"\. Setup also asked to register/);
  assert.match(
    finished.stdout,
    /CHANGE PREVIEW[\s\S]*registers the Gmail MCP server with cursor/,
    'shown before asked',
  );
  assert.match(finished.stdout, /Registered "gmail" with cursor/);
  assert.ok(existsSync(machine.cursor));
});

test('a client that already has the server is left alone by the finish', async () => {
  const machine = await clientOnly();
  await mkdir(dirname(machine.cursor), { recursive: true });
  const entry = JSON.stringify({ mcpServers: { gmail: { command: 'npx', args: ['-y', '@agentcomms/gmail-mcp'] } } });
  await writeFile(machine.cursor, entry);
  const report = await handedOff(machine);
  const finished = await cli(machine.harness, [...argvOf(report.handoff.finish), '--json'], { env: machine.env });
  assert.equal(finished.code, 0, `${finished.stdout}${finished.stderr}`);
  assert.deepEqual(finished.envelope<{ registration: unknown }>().data?.registration, {
    client: 'cursor',
    status: 'already-registered',
  });
  assert.equal(await readFile(machine.cursor, 'utf8'), entry);
  assert.deepEqual(await machine.harness.core.approvals.list(), [], 'nobody was asked anything');
});

/*
 * "Already registered" is decided by the entry, not by the client's name: only an entry of ours that serves the
 * mailbox just connected counts — at user scope, under the name the registration would use, unpinned or pinned to that
 * mailbox, and able to start. Every other entry used to count too, and the finish reported success for a mailbox no
 * server reached. Now the registration is made, and what its own preflight refuses is reported as not made.
 */

/** Cursor's config as it stood before `setup` ran, returned as written so the test can say it was left alone. */
async function cursorHolds(
  machine: Awaited<ReturnType<typeof clientOnly>>,
  servers: Record<string, { command: string; args: string[] }>,
): Promise<string> {
  await mkdir(dirname(machine.cursor), { recursive: true });
  const text = JSON.stringify({ mcpServers: servers });
  await writeFile(machine.cursor, text);
  return text;
}

/** Our server as `npx` starts it, which names no file that could be missing: serving, unless pinned elsewhere. */
const ours = (...args: string[]) => ({ command: 'npx', args: ['-y', '@agentcomms/gmail-mcp', ...args] });

interface Finished {
  alias: string;
  registration: {
    client: string;
    status: string;
    reason?: string;
    hint?: string;
    approvalId?: string;
    claim?: string;
    preview?: string;
  };
}

/** The finish as an agent runs it, and whether the mailbox is connected afterwards, whatever the registration did. */
async function finishing(machine: Awaited<ReturnType<typeof clientOnly>>, report: HandOff) {
  const run = await cli(machine.harness, [...argvOf(report.handoff.finish), '--json'], { env: machine.env });
  const envelope = run.envelope<Finished>();
  const listed = await cli(machine.harness, ['inbox', 'list', '--json'], { env: machine.env });
  return {
    run,
    envelope,
    registration: envelope.data?.registration,
    inboxes: listed.envelope<{ alias: string }[]>().data?.map((inbox) => inbox.alias),
  };
}

test('an entry of ours pinned to another mailbox does not serve this one: the finish registers, and reports the refusal', async () => {
  const machine = await clientOnly();
  const before = await cursorHolds(machine, { gmail: ours('--inbox', 'other') });
  const finished = await finishing(machine, await handedOff(machine));
  // Not "already registered": that entry reaches `other` only. The registration `setup` asked for was made, and its
  // own preflight refused it — ours under that name, with no `--replace-server` — which is said, with the way on.
  assert.equal(finished.registration?.status, 'not-registered', finished.run.stdout);
  assert.match(String(finished.registration?.reason), /cursor already has this server registered as "gmail"/);
  // The way on is a second entry for the mailbox just connected (#47). It was `--inbox other … --force`: the command
  // that registers `other` again, and leaves `home` reached by nothing.
  const hint = String(finished.registration?.hint);
  locatedGmailLine(hint, [
    'mcp',
    'install',
    '--client',
    'cursor',
    '--standalone',
    '--name',
    'gmail-home',
    '--inbox',
    'home',
    '--launcher',
    'local',
  ]);
  assert.match(hint, /serves other/);
  assert.doesNotMatch(hint, /--inbox other|--force/);
  // The mailbox is connected, in an envelope that says the finish worked; the status is the registration's refusal.
  assert.equal(finished.envelope.ok, true, finished.run.stdout);
  assert.equal(finished.envelope.data?.alias, 'home');
  assert.deepEqual(finished.inboxes, ['home']);
  assert.equal(finished.run.code, 78, finished.run.stdout);
  assert.equal(await readFile(machine.cursor, 'utf8'), before, 'nothing was replaced');
});

test('an entry of ours whose runtime is gone serves nothing: the finish registers, and reports the refusal', async () => {
  const machine = await clientOnly();
  // A managed runtime deleted by hand: the entry still reads as ours, and starts nothing.
  const gone = managedRuntimeEntry(join(tempDir(), 'data'), '@agentcomms/gmail', '0.0.1');
  const before = await cursorHolds(machine, { gmail: { command: 'node', args: [gone, 'mcp'] } });
  const finished = await finishing(machine, await handedOff(machine));
  assert.equal(finished.registration?.status, 'not-registered', finished.run.stdout);
  assert.match(String(finished.registration?.reason), /cursor already has this server registered as "gmail"/);
  assert.deepEqual(finished.inboxes, ['home']);
  assert.equal(await readFile(machine.cursor, 'utf8'), before);
});

test("somebody else's `gmail` server is never replaced by the finish: not registered, with the reason, and the mailbox connected", async () => {
  const machine = await clientOnly();
  // Beside it, one of ours under another name and for another mailbox — which, by the client's name alone, was "it".
  const before = await cursorHolds(machine, {
    gmail: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
    'gmail-other': ours('--inbox', 'other'),
  });
  const finished = await finishing(machine, await handedOff(machine));
  assert.equal(finished.registration?.status, 'not-registered', finished.run.stdout);
  assert.match(
    String(finished.registration?.reason),
    /cursor already has an MCP server called "gmail", and it is not this one \(it runs @gongrzhe\/server-gmail-autoauth-mcp\)/,
  );
  assert.equal(finished.envelope.ok, true, finished.run.stdout);
  assert.deepEqual(finished.inboxes, ['home']);
  assert.equal(await readFile(machine.cursor, 'utf8'), before, 'the foreign entry is untouched');
  assert.deepEqual(await machine.harness.core.approvals.list(), [], 'nobody was asked to approve a refused change');

  // Read by a person: connected, then what did not happen and why.
  const other = await clientOnly();
  await cursorHolds(other, { gmail: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] } });
  const plain = await cli(other.harness, argvOf((await handedOff(other)).handoff.finish), { env: other.env });
  assert.match(plain.stdout, /Connected sam@example\.test as "home"/);
  assert.match(
    plain.stdout,
    /The Gmail server was not registered with cursor: cursor already has an MCP server called "gmail"/,
  );
});

test('an entry of ours under another name is not the one setup registers: the finish prepares it', async () => {
  const machine = await clientOnly();
  await cursorHolds(machine, { 'gmail-all': ours() });
  const finished = await finishing(machine, await handedOff(machine));
  assert.equal(finished.registration?.status, 'approval-required', finished.run.stdout);
  assert.match(String(finished.registration?.preview), /registers the Gmail MCP server with cursor as "gmail"/);
  assert.equal(finished.run.code, 10);
  assert.deepEqual(finished.inboxes, ['home']);
});

test('clientServesInbox counts only a user-scope entry of ours, under the name, for this mailbox, that can start', async () => {
  const home = tempDir();
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') };
  const holds = (config: Record<string, unknown>) => writeFile(join(home, '.claude.json'), JSON.stringify(config));
  const serves = (inbox = 'home', name?: string) =>
    clientServesInbox(env, { client: 'claude-code', inbox, ...(name ? { name } : {}) });
  const present = await readyRuntime((await machine()).harness);

  // Nothing registered at all, and a config that is not there.
  assert.equal(await serves(), false);

  // A project's entry is not the user-scope one a registration writes, however ours it is.
  await holds({ projects: { [home]: { mcpServers: { gmail: ours() } } } });
  assert.equal(await serves(), false, 'project scope');

  for (const [entry, expected, why] of [
    [ours(), true, 'unpinned'],
    [ours('--inbox', 'home'), true, 'pinned to this mailbox'],
    [ours('--inbox=home'), true, 'pinned in the one-word form'],
    [ours('--inbox', 'other'), false, 'pinned to another mailbox'],
    [{ command: 'node', args: [present, 'mcp'] }, true, 'a managed runtime that is there'],
    [
      { command: 'node', args: [join(home, 'gone', 'node_modules', '@agentcomms', 'gmail', 'dist', 'cli.mjs'), 'mcp'] },
      false,
      'a runtime that is gone',
    ],
    [{ command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] }, false, 'somebody else’s server'],
  ] as const) {
    await holds({ mcpServers: { gmail: entry } });
    assert.equal(await serves(), expected, why);
  }

  // Under another name it is not what the registration would find in its place — unless that is the name asked for.
  await holds({ mcpServers: { 'gmail-all': ours() } });
  assert.equal(await serves(), false, 'another name');
  assert.equal(await serves('home', 'gmail-all'), true, 'the name asked for');
  // Another client's entry is that client's.
  assert.equal(await clientServesInbox(env, { client: 'cursor', inbox: 'home' }), false, 'another client');
});

/*
 * `setup --replace-server` goes with the sign-in too. It used to stop at `setup`: the finish found the entry it had
 * been asked to replace and called the client registered, or prepared a change `mcp install` could not claim, since
 * replacing had not been asked for there.
 */
test('`setup --replace-server` travels with the sign-in, and the finish replaces the entry once `mcp install --force --approval` claims it', async () => {
  const machine = await clientOnly();
  await cursorHolds(machine, { gmail: ours() });
  const report = await handedOff(machine, ['--replace-server']);
  assert.deepEqual(report.handoff.registerWith, { client: 'cursor', launcher: 'local', replace: true });
  // In the sign-in's record, where the finish reads it.
  const flowId = String(/--finish (fl_\w+)/.exec(report.handoff.finish)?.[1]);
  assert.deepEqual((await flowRecord(machine.harness, flowId)).registerWith, report.handoff.registerWith);

  const finished = await finishing(machine, report);
  // Not "already registered", although that entry serves the mailbox: replacing it is what was asked for.
  assert.equal(finished.run.code, 10, finished.run.stdout);
  assert.equal(finished.registration?.status, 'approval-required', finished.run.stdout);
  assert.match(String(finished.registration?.preview), /as "gmail", replacing its own earlier entry of that name/);
  assert.deepEqual(finished.inboxes, ['home']);

  // The printed claim is the prepared change, `--force` and all: it claims, and replaces the entry.
  const claimed = await cli(machine.harness, [...argvOf(String(finished.registration?.claim)), '--json'], {
    env: machine.env,
  });
  assert.equal(claimed.code, 0, `${claimed.stdout}${claimed.stderr}`);
  assert.equal(claimed.envelope<{ applied: boolean }>().data?.applied, true);
  const written = JSON.parse(await readFile(machine.cursor, 'utf8')) as {
    mcpServers: { gmail: { command: string; args: string[] } };
  };
  assert.doesNotMatch(written.mcpServers.gmail.args.join(' '), /@agentcomms\/gmail-mcp/, 'the npx entry was replaced');
  assert.match(written.mcpServers.gmail.args.join(' '), /packages[/\\]+gmail[/\\]+(src|dist)[/\\]+cli\./);
  assert.equal(
    finished.registration?.claim,
    // For darwin, the shell `cli` gives the command that printed the claim.
    gmailCommand(
      machine.harness.core.paths,
      [
        'mcp',
        'install',
        '--client',
        'cursor',
        '--standalone',
        '--launcher',
        'local',
        '--force',
        '--approval',
        String(finished.registration?.approvalId),
      ],
      'darwin',
    ),
  );
});

/*
 * `setup --replace-server` over an entry pinned to another mailbox. The replacement kept that pin — the install's rule
 * for an entry it replaces — so the finish of `home` re-registered the server for `other`, and the preview said only
 * "replacing its own earlier entry". The mailbox just connected is the pin now, and the preview says what the old
 * entry served (#47).
 */
test('`setup --replace-server` over an entry pinned to another mailbox pins the replacement to the one just connected', async () => {
  const machine = await clientOnly();
  await cursorHolds(machine, { gmail: ours('--inbox', 'other') });
  const finished = await finishing(machine, await handedOff(machine, ['--replace-server']));
  assert.equal(finished.registration?.status, 'approval-required', finished.run.stdout);
  const preview = String(finished.registration?.preview);
  assert.match(
    preview,
    /as "gmail", pinned to the mailbox home, replacing its own earlier entry of that name, which served the mailbox other/,
  );
  assert.doesNotMatch(preview, /keeping --inbox other/);
  assert.equal(
    finished.registration?.claim,
    // For darwin, the shell `cli` gives the command that printed the claim.
    gmailCommand(
      machine.harness.core.paths,
      [
        'mcp',
        'install',
        '--client',
        'cursor',
        '--standalone',
        '--launcher',
        'local',
        '--inbox',
        'home',
        '--force',
        '--approval',
        String(finished.registration?.approvalId),
      ],
      'darwin',
    ),
  );

  // The printed claim is the prepared change: it claims, and the entry serves `home`.
  const claimed = await cli(machine.harness, [...argvOf(String(finished.registration?.claim)), '--json'], {
    env: machine.env,
  });
  assert.equal(claimed.code, 0, `${claimed.stdout}${claimed.stderr}`);
  const written = JSON.parse(await readFile(machine.cursor, 'utf8')) as {
    mcpServers: { gmail: { args: string[] } };
  };
  const args = written.mcpServers.gmail.args;
  assert.deepEqual(args.slice(args.indexOf('--inbox'), args.indexOf('--inbox') + 2), ['--inbox', 'home']);
  assert.ok(!args.includes('other'), args.join(' '));
});

test('gmail_inbox_finish hands the mailbox just connected back as the pin, when the entry it replaces serves another', async () => {
  const machine = await clientOnly();
  await cursorHolds(machine, { gmail: ours('--inbox', 'other') });
  const pending = (await finishedOverMcp(machine, ['--replace-server'])).pendingRegistration as
    | Record<string, unknown>
    | undefined;
  assert.ok(pending);
  const args = pending.arguments as Record<string, unknown>;
  assert.deepEqual(args, { channel: 'gmail', client: 'cursor', launcher: 'local', inbox: 'home', force: true });
  assert.match(String(pending.next), /it served the mailbox other/);
  locatedGmailLine(String(pending.next), [
    'mcp',
    'install',
    '--client',
    'cursor',
    '--standalone',
    '--launcher',
    'local',
    '--inbox',
    'home',
    '--force',
  ]);

  // The core server takes them as that replacement: pinned to `home`, saying what the old entry served.
  const server = await coreServer(machine.harness, machine.env);
  try {
    const asked = approvalAsked(await server.call('comms_server_install', args));
    assert.match(
      asked.preview,
      /pinned to the mailbox home, replacing its own earlier entry of that name, which served the mailbox other/,
    );
  } finally {
    await server.close();
  }
});

test('a sign-in that carries no registration finishes exactly as it always did', async () => {
  // Started by `inbox add --start`, as every flow before this change was: its record has no `registerWith` at all.
  const machine = await clientOnly();
  const started = await cli(
    machine.harness,
    ['inbox', 'add', 'home', '--start', '--email', 'sam@example.test', '--json'],
    { env: machine.env },
  );
  const flow = started.envelope<{ flowId: string; authUrl: string }>().data;
  assert.ok(flow, started.stdout);
  assert.equal(Object.hasOwn(await flowRecord(machine.harness, flow.flowId), 'registerWith'), false);
  await fetch(machine.harness.google.consent(flow.authUrl));

  const finished = await cli(machine.harness, ['inbox', 'add', '--finish', flow.flowId, '--json'], {
    env: machine.env,
  });
  assert.equal(finished.code, 0, `${finished.stdout}${finished.stderr}`);
  const data = finished.envelope<Record<string, unknown>>().data ?? {};
  // Organisation routing deliberately adds the client to every completed sign-in result (§D6),
  // including an otherwise unchanged flow that carries no MCP registration handoff.
  assert.deepEqual(Object.keys(data).sort(), ['alias', 'client', 'inbox', 'missingScopes', 'reauthorised']);
  assert.equal(existsSync(machine.cursor), false);
  assert.deepEqual(await machine.harness.core.approvals.list(), []);
});

test('gmail_inbox_finish connects the mailbox and hands the registration back for comms_server_install, making none', async () => {
  const machine = await clientOnly();
  const report = await handedOff(machine);
  const flowId = /--finish (fl_\w+)/.exec(report.handoff.finish)?.[1];
  const server = await connect({
    core: machine.harness.core,
    env: { ...machine.harness.env, ...machine.env },
    platform: 'darwin',
  });
  try {
    const result = wire(await server.call('gmail_inbox_finish', { flowId, waitSeconds: 10 }));
    assert.equal(result.alias, 'home');
    assert.equal(result.email, 'sam@example.test');
    const pending = result.pendingRegistration as Record<string, unknown>;
    assert.equal(pending.client, 'cursor');
    assert.equal(pending.tool, 'comms_server_install');
    assert.deepEqual(pending.arguments, { channel: 'gmail', client: 'cursor', launcher: 'local' });
    assert.match(String(pending.next), /no Gmail server registered with cursor serves it yet/);
  } finally {
    await server.close();
  }
  assert.equal(existsSync(machine.cursor), false, 'this server registers nothing');
  assert.deepEqual(await machine.harness.core.approvals.list(), [], 'and prepares nothing');
});

/** gmail_inbox_finish on a sign-in `setup` handed off with `extra`, and what it hands back. */
async function finishedOverMcp(
  machine: Awaited<ReturnType<typeof clientOnly>>,
  extra: string[] = [],
): Promise<Record<string, unknown>> {
  const report = await handedOff(machine, extra);
  const flowId = /--finish (fl_\w+)/.exec(report.handoff.finish)?.[1];
  const server = await connect({
    core: machine.harness.core,
    env: { ...machine.harness.env, ...machine.env },
    platform: 'darwin',
  });
  try {
    return wire(await server.call('gmail_inbox_finish', { flowId, waitSeconds: 10 }));
  } finally {
    await server.close();
  }
}

test('gmail_inbox_finish decides `pendingRegistration` by the entry that serves the mailbox, as `--finish` does', async () => {
  // Pinned to another mailbox: it serves `home` no more than no entry would, so the registration is still pending.
  const pinned = await clientOnly();
  const before = await cursorHolds(pinned, { gmail: ours('--inbox', 'other') });
  const pending = (await finishedOverMcp(pinned)).pendingRegistration as Record<string, unknown> | undefined;
  assert.ok(pending, 'an entry for another mailbox is not this one');
  // Pinned to the mailbox just connected, as `inbox add --finish` asks for it; and, since nothing is to be replaced,
  // the way to reach both is a second entry, which the text names (#47).
  assert.deepEqual(pending.arguments, {
    channel: 'gmail',
    client: 'cursor',
    launcher: 'local',
    inbox: 'home',
    name: 'gmail-home',
  });
  assert.match(String(pending.next), /serves the mailbox other, not this one/);
  locatedGmailLine(String(pending.next), [
    'mcp',
    'install',
    '--client',
    'cursor',
    '--standalone',
    '--launcher',
    'local',
    '--name',
    'gmail-home',
    '--inbox',
    'home',
  ]);
  assert.equal(await readFile(pinned.cursor, 'utf8'), before);
  // The arguments work as they are given: passed on unchanged, they ask for the second entry, not the taken name.
  const env = { ...pinned.harness.env, ...pinned.env };
  const core = await coreServer(pinned.harness, env);
  try {
    const asked = approvalAsked(
      await core.call('comms_server_install', { ...(pending.arguments as object), noVerify: true }),
    );
    assert.match(
      asked.preview,
      /registers the Gmail MCP server with cursor as "gmail-home", pinned to the mailbox home/,
    );
    await core.call('comms_server_install', {
      ...(pending.arguments as object),
      noVerify: true,
      approvalId: asked.approvalId,
    });
    const servers = JSON.parse(await readFile(pinned.cursor, 'utf8')).mcpServers;
    assert.ok(servers['gmail-home'], 'the second entry was not written');
    assert.deepEqual(servers.gmail, JSON.parse(before).mcpServers.gmail, "the other mailbox's entry was changed");
  } finally {
    await core.close();
  }

  // One that serves it: nothing pending, as the command says "already-registered".
  const serving = await clientOnly();
  await cursorHolds(serving, { gmail: ours('--inbox', 'home') });
  assert.equal(Object.hasOwn(await finishedOverMcp(serving), 'pendingRegistration'), false);
});

test('gmail_inbox_finish hands `--replace-server` back as `force`, which comms_server_install needs to replace the entry', async () => {
  const machine = await clientOnly();
  await cursorHolds(machine, { gmail: ours() });
  const pending = (await finishedOverMcp(machine, ['--replace-server'])).pendingRegistration as
    | Record<string, unknown>
    | undefined;
  // Pending although that entry serves the mailbox: replacing it is what `setup` was asked for.
  assert.ok(pending, 'replacing was asked for, so the registration is pending');
  const args = pending.arguments as Record<string, unknown>;
  assert.deepEqual(args, { channel: 'gmail', client: 'cursor', launcher: 'local', force: true });
  locatedGmailLine(String(pending.next), [
    'mcp',
    'install',
    '--client',
    'cursor',
    '--standalone',
    '--launcher',
    'local',
    '--force',
  ]);

  // And the core server takes those arguments as the replacement they are, where without `force` it refuses.
  const server = await coreServer(machine.harness, machine.env);
  try {
    const asked = approvalAsked(await server.call('comms_server_install', args));
    assert.match(asked.preview, /as "gmail", replacing its own earlier entry of that name/);
  } finally {
    await server.close();
  }
});
