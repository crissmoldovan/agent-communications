import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { gatedChange } from '../src/change-flow.ts';
import type { InboxConfig } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { knownClientConfigs } from '../src/mcp-clients.ts';
import { doctor } from '../src/operations/maintenance.ts';
import { type ServerInstallRequest, serverInstallChange } from '../src/operations/servers.ts';
import { VERSION } from '../src/version.ts';
import { writeManaged } from './fixtures/cli-command/trees.ts';
import { fixtureTarballs, registryOf, testReleaseVerifier } from './helpers/provenance-fixture.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * A registration is agreed to — or found to need nobody's agreement — on what `plan` saw, and carried out a moment
 * later by `apply`. The machine can move in between: a client's CLI turns up on PATH, an entry the plan was going to
 * replace is removed by somebody else. What a person was shown has to be what then happens, so everything that
 * decides what the install does — whether it writes or only prints, where it writes, which entries it replaces and
 * what the server is pinned to — is carried from the plan into the apply, looked at again there, and a difference is
 * a refusal, with nothing written.
 *
 * The surface tests move the machine inside one call, the way it moves under a real one: the first time the
 * installer looks for a client on PATH is the plan's look, and every later one the apply's. Every test runs in a
 * temporary home with a PATH holding only stand-ins that record what they were asked; nothing touches a real client,
 * config, keychain or npm.
 */

const NOT_ON_WINDOWS =
  process.platform === 'win32'
    ? { skip: 'the stand-in clients are scripts, which Windows cannot spawn without a shell' }
    : {};

const MAIL = 'ibx_AAAAAAAAAAAAAAAA';

function inbox(): InboxConfig {
  return {
    id: MAIL,
    provider: 'gmail',
    email: 'jo@acme.test',
    identity: 'oidc',
    client: 'desktop',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:refresh:${MAIL}`,
    internalDomains: ['acme.test'],
    createdAt: '2026-09-20T00:00:00.000Z',
  };
}

interface Machine {
  home: string;
  /** On PATH from the start: empty unless a test puts a stand-in there. */
  bin: string;
  /** Not on PATH until a test puts it there. */
  later: string;
  env: Record<string, string>;
  core: Core;
}

/** A home of its own with one mailbox, and a PATH holding only `bin`. */
function machine(): Machine {
  const home = tempDir('comms-drift-');
  const bin = join(home, 'bin');
  const later = join(home, 'later');
  mkdirSync(bin);
  mkdirSync(later);
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, 'config.json'),
    `${JSON.stringify({ version: 2, inboxes: { 'acme/gmail': inbox() } }, null, 2)}\n`,
  );
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    PATH: bin,
    AGENT_COMMS_CONFIG_DIR: configDir,
    NO_COLOR: '1',
    // Where a client's own command is looked for beyond PATH: this home, and nowhere else. Left out, /opt/homebrew/bin
    // and /usr/local/bin are searched too, and a real `claude` or `codex` there would be found — and run — by a test
    // that meant to have none.
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    // The daily update check, off: no test asks the real npm registry, and no call stops for a release the tests did
    // not make. The gate's own tests turn it back on, with a registry and a clock of their own (design 2026-09-28).
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return { home, bin, later, env, core: openCore({ env, caller: CORE_CALLER }) };
}

/**
 * PATH as `first` the first time anything reads it, and as `then` every time after: the plan's look for the client,
 * then the apply's. Returns how many times it was read, so a test can say the apply looked again.
 */
function racingPath(env: Record<string, string>, first: string, then: string): () => number {
  let reads = 0;
  Object.defineProperty(env, 'PATH', {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      return reads === 1 ? first : then;
    },
  });
  return () => reads;
}

/** Our own Gmail entry of this release, pinned to one mailbox, as the npx launcher writes it. */
const PINNED = { command: 'npx', args: ['-y', `@agentcomms/gmail-mcp@${VERSION}`, '--inbox', 'acme/gmail'] };

test('doctor diagnoses a legacy registration without mutating it, and its approved repair writes all four pins', async () => {
  const m = machine();
  standIn(m.bin, 'node');
  const npx = standIn(m.bin, 'npx');
  const cursor = knownClientConfigs(m.env).find((file) => file.client === 'cursor')?.path;
  assert.ok(cursor);
  const legacy = {
    command: npx,
    args: ['-y', `@agentcomms/gmail-mcp@${VERSION}`, '--inbox', 'acme/gmail'],
  };
  mkdirSync(dirname(cursor), { recursive: true });
  writeFileSync(cursor, `${JSON.stringify({ mcpServers: { work: legacy } }, null, 2)}\n`);
  const before = readFileSync(cursor, 'utf8');
  /*
   * Gmail's command is found only where Gmail is registered from a file this release can check (CUE-403): an npx entry
   * is never one, so the repair is located through a managed Gmail Claude Code also starts — pinned already, so it is
   * no finding of its own.
   */
  const claude = knownClientConfigs(m.env).find((file) => file.client === 'claude-code')?.path;
  assert.ok(claude);
  const { paths } = m.core;
  const pins = ['--config-dir', paths.configDir, '--state-dir', paths.stateDir, '--data-dir', paths.dataDir];
  const managed = {
    command: process.execPath,
    args: [writeManaged(paths.dataDir, 'gmail').entry, ...pins, '--secrets-dir', paths.secretsDir, 'mcp'],
  };
  mkdirSync(dirname(claude), { recursive: true });
  writeFileSync(claude, `${JSON.stringify({ mcpServers: { gmail: managed } }, null, 2)}\n`);

  const report = await doctor(m.core, m.env, { keyring: null });
  // It still starts, so it is something to look at — a warning, not a failure — with the command that pins it.
  const incomplete = report.checks.find((check) => /suite path pins/.test(check.detail));
  assert.ok(incomplete, JSON.stringify(report.checks));
  assert.equal(incomplete.ok, true, JSON.stringify(incomplete));
  assert.equal(incomplete.warn, true, JSON.stringify(incomplete));
  for (const word of ['--name work', '--inbox acme/gmail', '--launcher npx', '--force']) {
    assert.match(incomplete.fix ?? '', new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(readFileSync(cursor, 'utf8'), before, 'doctor only diagnosed; it did not rewrite the client file');

  const request = {
    channel: 'gmail',
    client: 'cursor',
    name: 'work',
    inbox: 'acme/gmail',
    launcher: 'npx',
    force: true,
    noVerify: true,
  } as const;
  const asked = await gatedChange(m.core, serverInstallChange(m.core, m.env, request), {
    channel: 'core',
    surface: 'mcp',
  });
  assert.equal(asked.status, 'approval-required');
  if (asked.status !== 'approval-required') return;
  const repaired = await gatedChange(m.core, serverInstallChange(m.core, m.env, request), {
    channel: 'core',
    surface: 'mcp',
    approvalId: asked.prepared.approvalId,
  });
  assert.equal(repaired.status, 'applied');
  if (repaired.status !== 'applied') return;
  const written = JSON.parse(readFileSync(cursor, 'utf8')).mcpServers.work as { args: string[] };
  assert.deepEqual(written.args, [
    '-y',
    `@agentcomms/gmail-mcp@${VERSION}`,
    '--config-dir',
    m.core.paths.configDir,
    '--state-dir',
    m.core.paths.stateDir,
    '--data-dir',
    m.core.paths.dataDir,
    '--secrets-dir',
    m.core.paths.secretsDir,
    '--inbox',
    'acme/gmail',
  ]);
  assert.ok(!written.args.includes('--downloads-dir'));
});

/**
 * A stand-in for `codex` or `claude` that records every call and succeeds.
 *
 * Codex is asked what it has under a name before anything is written there; the stand-in answers `mcp get` with
 * `entry` for the first `answers` times it is asked, and "No MCP server named …" after that — somebody removed it
 * with `codex mcp remove` in between.
 */
function fakeClient(
  dir: string,
  name: 'codex' | 'claude',
  options: { entry?: { command: string; args: string[] }; answers?: number } = {},
): () => string[] {
  const log = join(dir, `${name}.log`);
  const count = join(dir, `${name}.gets`);
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      // This node, by path: the client CLI is started with the install's own environment, whose PATH has none.
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const argv = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");`,
      'if (argv[0] === "mcp" && argv[1] === "get") {',
      `  const asked = (fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0) + 1;`,
      `  fs.writeFileSync(${JSON.stringify(count)}, String(asked));`,
      `  const entry = ${JSON.stringify(options.entry ?? null)};`,
      `  if (!entry || asked > ${options.answers ?? Number.MAX_SAFE_INTEGER}) {`,
      '    process.stderr.write("Error: No MCP server named \'" + argv[2] + "\' found.\\n");',
      '    process.exit(1);',
      '  }',
      '  const transport = { type: "stdio", command: entry.command, args: entry.args, env: null, env_vars: [], cwd: null };',
      '  process.stdout.write(JSON.stringify({ name: argv[2], enabled: true, transport }));',
      '}',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
}

/** What was asked of a client's CLI that changes something: asking what is registered changes nothing. */
const writesOf = (calls: string[]) => calls.filter((call) => !call.startsWith('mcp get '));

/**
 * Core's server, its verifier and registry the test's own (design 2026-10-22 P5: core verifies the release an npx entry's
 * client fetches), under which this release verifies: what is refused here is refused for the drift alone.
 */
async function connect(m: Machine) {
  const { server } = await createCoreMcpServer({
    core: m.core,
    env: m.env,
    keyring: null,
    update: { registry: registryOf(() => VERSION), verifyRelease: testReleaseVerifier(), tarballs: fixtureTarballs },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

/** The refusal a registration that moved after it was planned ends with. */
function assertDrifted(result: { isError?: boolean; structuredContent?: Record<string, unknown> }, what: RegExp) {
  assert.equal(result.isError, true, `expected a refusal: ${JSON.stringify(result.structuredContent)}`);
  const error = result.structuredContent?.error as { code: string; message: string; hint: string | null };
  assert.equal(error.code, 'CONFIG', error.message);
  assert.match(error.message, /changed between being planned and being applied/);
  assert.match(error.message, what);
  assert.match(error.message, /nothing was written/);
  assert.match(error.hint ?? '', /again/);
}

const drifted = (what: RegExp) => (error: unknown) => {
  assert.ok(error instanceof CommsError, String(error));
  assert.equal(error.code, 'CONFIG', error.message);
  assert.match(error.message, /changed between being planned and being applied/);
  assert.match(error.message, what);
  return true;
};

// ── comms_server_install ────────────────────────────────────────────────────────────────────────────────────────

test(
  'comms_server_install: a client that appears after a print-only plan is not registered with, unasked',
  NOT_ON_WINDOWS,
  async () => {
    /*
     * Codex is not on PATH when the call is planned, so the plan is to print the entry: no effect, and nobody is
     * asked. It is there by the time the install runs, and the install used to look again, find it, and register the
     * server — a new set of tools handed to a client with no approval at all.
     */
    const m = machine();
    const calls = fakeClient(m.later, 'codex');
    const reads = racingPath(m.env, m.bin, [m.later, m.bin].join(delimiter));
    const { call, close } = await connect(m);
    try {
      const result = await call('comms_server_install', {
        channel: 'gmail',
        client: 'codex',
        launcher: 'npx',
        noVerify: true,
      });
      assert.ok(reads() >= 2, 'the apply looked for the client again');
      assertDrifted(result, /codex was not on PATH when this was planned, and is now/);
      assert.deepEqual(writesOf(calls()), [], 'codex was never asked to add anything');
      assert.deepEqual(await m.core.approvals.list(), [], 'nobody was asked, and nothing was claimed');
    } finally {
      await close();
    }
  },
);

test(
  'comms_server_install: a pinned entry removed after the approval is not replaced by an unpinned one',
  NOT_ON_WINDOWS,
  async () => {
    /*
     * `--force` over our own entry keeps its pin, and the preview says so. Codex reports the entry while the change is
     * planned and approved, and not when the install runs: somebody ran `codex mcp remove` in between. The install used
     * to plan again, find nothing to replace and nothing to keep, and register a server reaching every mailbox under
     * an approval for one pinned to a single mailbox.
     */
    const m = machine();
    // Asked once for the approval, once when it is claimed; gone by the third.
    const calls = fakeClient(m.bin, 'codex', { entry: PINNED, answers: 2 });
    const request = { channel: 'gmail', client: 'codex', launcher: 'npx', force: true, noVerify: true };
    const { call, close } = await connect(m);
    try {
      const asked = await call('comms_server_install', request);
      assert.equal(asked.structuredContent?.approvalRequired, true, JSON.stringify(asked.structuredContent));
      assert.match(
        String(asked.structuredContent?.preview),
        /pinned to the mailbox acme\/gmail, replacing its own earlier entry of that name, which served the mailbox acme\/gmail, and keeping --inbox acme\/gmail from it/,
      );
      const result = await call('comms_server_install', {
        ...request,
        approvalId: asked.structuredContent?.approvalId,
      });
      assertDrifted(result, /is not what it was planned to replace/);
      assert.deepEqual(writesOf(calls()), [], 'codex was never asked to remove or add anything');
    } finally {
      await close();
    }
  },
);

// ── The change itself, with the machine moved between its plan and its apply ────────────────────────────────────

/** Plans `request`, lets `move` change the machine, and applies. */
async function planThenApply(m: Machine, request: ServerInstallRequest, move: () => void) {
  const change = serverInstallChange(m.core, m.env, request);
  const planned = await change.plan(await m.core.config.load());
  move();
  return change.apply(undefined, planned);
}

test(
  'a client that disappears after it was planned to be written is refused, not quietly printed',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const calls = fakeClient(m.bin, 'claude');
    await assert.rejects(
      planThenApply(m, { channel: 'gmail', client: 'claude-code', launcher: 'npx', noVerify: true }, () => {
        m.env.PATH = m.later;
      }),
      drifted(/claude was on PATH when this was planned, and is not now/),
    );
    assert.deepEqual(writesOf(calls()), []);
  },
);

test(
  'a different client CLI found on PATH after the plan is refused: it is not the one planned',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const planned = fakeClient(m.bin, 'claude');
    const other = fakeClient(m.later, 'claude');
    await assert.rejects(
      planThenApply(m, { channel: 'gmail', client: 'claude-code', launcher: 'npx', noVerify: true }, () => {
        m.env.PATH = [m.later, m.bin].join(delimiter);
      }),
      drifted(/it would register through another claude/),
    );
    assert.deepEqual(writesOf(planned()), []);
    assert.deepEqual(writesOf(other()), []);
  },
);

test('a client config that resolves elsewhere by the time of the apply is refused: it is not the file planned', async () => {
  const m = machine();
  const planned = knownClientConfigs(m.env).find((file) => file.client === 'cursor')?.path;
  const elsewhere = join(m.home, 'elsewhere');
  await assert.rejects(
    planThenApply(m, { channel: 'gmail', client: 'cursor', launcher: 'npx', noVerify: true }, () => {
      m.env.HOME = elsewhere;
      m.env.USERPROFILE = elsewhere;
    }),
    drifted(/cursor's config is now .*elsewhere.*, not /),
  );
  assert.ok(planned && !existsSync(planned));
  assert.equal(existsSync(join(elsewhere, '.cursor', 'mcp.json')), false);
});

test('an entry of ours that appears under the name after the plan is not replaced: the plan replaced nothing', async () => {
  /*
   * With `--force` over nothing, the preview says the server is registered, and nothing about replacing an entry. One
   * of ours appearing under the name before the apply would be replaced — and its pin kept — under an approval that
   * never mentioned it.
   */
  const m = machine();
  const cursor = knownClientConfigs(m.env).find((file) => file.client === 'cursor')?.path;
  assert.ok(cursor);
  await assert.rejects(
    planThenApply(m, { channel: 'gmail', client: 'cursor', launcher: 'npx', force: true, noVerify: true }, () => {
      mkdirSync(join(m.home, '.cursor'), { recursive: true });
      writeFileSync(cursor, JSON.stringify({ mcpServers: { gmail: PINNED } }));
    }),
    drifted(/is not what it was planned to replace/),
  );
  assert.deepEqual(JSON.parse(readFileSync(cursor, 'utf8')), { mcpServers: { gmail: PINNED } }, 'left as it was');
});

test(
  'a registration nothing moved under is applied as planned, with the pin the plan kept',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const calls = fakeClient(m.bin, 'codex', { entry: PINNED });
    const request = { channel: 'gmail', client: 'codex', launcher: 'npx', force: true, noVerify: true } as const;
    const asked = await gatedChange(m.core, serverInstallChange(m.core, m.env, request), {
      channel: 'core',
      surface: 'mcp',
    });
    assert.equal(asked.status, 'approval-required');
    if (asked.status !== 'approval-required') return;
    const done = await gatedChange(m.core, serverInstallChange(m.core, m.env, request), {
      channel: 'core',
      surface: 'mcp',
      approvalId: asked.prepared.approvalId,
    });
    assert.equal(done.status, 'applied');
    if (done.status !== 'applied') return;
    assert.equal(done.result.applied, true);
    assert.deepEqual(done.result.entry.args.slice(-2), ['--inbox', 'acme/gmail'], 'the pin the preview named');
    assert.ok(
      done.result.warnings.some((warning) => /Kept --inbox acme\/gmail from the "gmail" entry/.test(warning)),
      done.result.warnings.join('\n'),
    );
    const writes = writesOf(calls());
    assert.equal(writes[0], 'mcp remove gmail');
    assert.match(writes[1] ?? '', /^mcp add gmail .* --inbox acme\/gmail$/);
  },
);

test('a registration applied before it was planned is refused', async () => {
  const m = machine();
  const change = serverInstallChange(m.core, m.env, { channel: 'gmail', client: 'json' });
  await assert.rejects(
    change.apply(undefined, { before: await m.core.config.load(), after: await m.core.config.load(), summary: 'x' }),
    (error: unknown) => error instanceof CommsError && error.code === 'UNEXPECTED',
  );
});

// ── Where the entry goes, and what it starts: in the approval, and held to it (#46) ─────────────────────────────

/** An executable stand-in called `name` in `dir`: found on PATH, never run (every test here passes `noVerify`). */
function standIn(dir: string, name: 'node' | 'npx'): string {
  const path = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  writeFileSync(path, '');
  chmodSync(path, 0o755);
  return path;
}

/** The effect sentence that names the client's config file and the command, as the preview says it. */
const whereAndHow = (client: string, file: string, command: string) =>
  `the entry goes in ${file}, and ${client} will start it with ${command}`;

test('the preview names the client config file and the command the entry starts, the home as ~', async () => {
  const m = machine();
  // As found on PATH, home written `~`: `npx.exe` and `node.exe` on Windows, where PATHEXT decides what runs.
  const node = join('~', 'bin', basename(standIn(m.bin, 'node')));
  const npxPath = join('~', 'bin', basename(standIn(m.bin, 'npx')));
  const plan = async (request: Omit<ServerInstallRequest, 'client'>) =>
    (
      await serverInstallChange(m.core, m.env, { client: 'cursor', noVerify: true, ...request }).plan(
        await m.core.config.load(),
      )
    ).effects ?? [];
  const cursor = join('~', '.cursor', 'mcp.json');
  const npx = await plan({ channel: 'gmail', launcher: 'npx' });
  assert.ok(npx.includes(whereAndHow('cursor', cursor, npxPath)), npx.join('\n'));
  // `local` and `managed` start node, from this PATH.
  const local = await plan({ channel: 'core', launcher: 'local' });
  assert.ok(local.includes(whereAndHow('cursor', cursor, node)), local.join('\n'));
  // Printing writes nowhere, so it has no such sentence — and asks nobody.
  assert.ok(
    !(await plan({ channel: 'core', launcher: 'local', print: true })).some((effect) => /entry goes in/.test(effect)),
  );
});

test(
  'an approval is claimed only from an environment that resolves the same config file and command',
  NOT_ON_WINDOWS,
  async () => {
    /*
     * The approval is bound to its sentences, and the sentences said nothing of where the entry goes or what it
     * starts. An approval prepared in one environment and claimed from another — `CLAUDE_CONFIG_DIR` pointing at
     * another account's `.claude.json`, a PATH that finds another `npx` — registered there, with what the person
     * never read.
     */
    const m = machine();
    const calls = fakeClient(m.bin, 'claude');
    const npx = standIn(m.bin, 'npx');
    const elsewhere = join(m.home, 'elsewhere');
    mkdirSync(elsewhere);
    standIn(elsewhere, 'npx');
    const request = { channel: 'gmail', client: 'claude-code', launcher: 'npx', noVerify: true };
    const here = await connect(m);
    const claims = async (env: Record<string, string>) => {
      const asked = await here.call('comms_server_install', request);
      assert.equal(asked.structuredContent?.approvalRequired, true, JSON.stringify(asked.structuredContent));
      const there = await connect({ ...m, env: { ...m.env, ...env } });
      try {
        return {
          preview: String(asked.structuredContent?.preview),
          result: await there.call('comms_server_install', {
            ...request,
            approvalId: asked.structuredContent?.approvalId,
          }),
        };
      } finally {
        await there.close();
      }
    };
    try {
      for (const env of [
        { CLAUDE_CONFIG_DIR: join(m.home, 'other-account') },
        { PATH: [elsewhere, m.bin].join(delimiter) },
      ]) {
        const { preview, result } = await claims(env);
        assert.equal(result.isError, true, `${JSON.stringify(env)}: ${JSON.stringify(result.structuredContent)}`);
        const error = result.structuredContent?.error as { code: string; message: string };
        assert.equal(error.code, 'APPROVAL_VOID', error.message);
        assert.match(error.message, /what it does outside the configuration is not what was approved/);
        assert.deepEqual(writesOf(calls()), [], `${JSON.stringify(env)}: claude was asked to write`);
        // What the person read, and what the other environment would have changed.
        assert.ok(
          preview.includes(whereAndHow('claude-code', join('~', '.claude.json'), join('~', 'bin', 'npx'))),
          preview,
        );
      }

      // Claimed where it was prepared, it registers, starting exactly the command it named.
      const asked = await here.call('comms_server_install', request);
      const done = await here.call('comms_server_install', {
        ...request,
        approvalId: asked.structuredContent?.approvalId,
      });
      assert.notEqual(done.isError, true, JSON.stringify(done.structuredContent));
      const [add] = writesOf(calls());
      assert.match(add ?? '', /^mcp add-json gmail /);
      assert.equal(
        JSON.parse(add?.replace(/^mcp add-json gmail /, '').replace(/ --scope user$/, '') ?? '{}').command,
        npx,
      );
    } finally {
      await here.close();
    }
  },
);

/**
 * PATH as `first` for the first `looks` times anything reads it, and as `then` after: the plan's look for node and the
 * apply's, then anything later. Returns how many times it was read.
 */
function pathAfter(env: Record<string, string>, looks: number, first: string, then: string): () => number {
  let reads = 0;
  Object.defineProperty(env, 'PATH', {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      return reads <= looks ? first : then;
    },
  });
  return () => reads;
}

test('the entry starts the command the plan resolved: the install looks for node once, before it asks', async () => {
  const m = machine();
  const planned = standIn(m.bin, 'node');
  standIn(m.later, 'node');
  // One look by the plan, one by the apply's own preflight, and then the machine changes: a node that turns up now is
  // not the one the plan named, and nothing after the preflight looks again.
  const reads = pathAfter(m.env, 2, m.bin, m.later);
  const result = await planThenApply(
    m,
    { channel: 'core', client: 'cursor', launcher: 'local', noVerify: true },
    () => undefined,
  );
  assert.equal(result.applied, true);
  assert.equal(result.entry.command, planned, 'the command the preview named');
  assert.equal(reads(), 2, 'looked for once by the plan and once by the apply, and never again');
  const cursor = knownClientConfigs(m.env).find((file) => file.client === 'cursor')?.path;
  assert.ok(cursor);
  assert.equal(JSON.parse(readFileSync(cursor, 'utf8')).mcpServers.agentcomms.command, planned);
});

test('an npx entry starts npx by its full path, found beside node when PATH has none; with none at all nothing is written', async () => {
  // No node and no npx on PATH: the install's own node, and the npx beside it — never the bare word.
  const bare = machine();
  const beside = join(dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const plan = () =>
    planThenApply(bare, { channel: 'core', client: 'cursor', launcher: 'npx', noVerify: true }, () => undefined);
  if (existsSync(beside)) {
    const result = await plan();
    assert.notEqual(result.entry.command, 'npx', 'never the bare word');
    assert.ok(isAbsolute(result.entry.command), result.entry.command);
    assert.equal(basename(result.entry.command).replace(/\.(cmd|exe)$/i, ''), 'npx');
  }
  // A node on PATH with no npx on PATH or beside it: refused, and nothing written.
  const m = machine();
  standIn(m.bin, 'node');
  const cursor = knownClientConfigs(m.env).find((file) => file.client === 'cursor')?.path;
  await assert.rejects(
    planThenApply(m, { channel: 'core', client: 'cursor', launcher: 'npx', noVerify: true }, () => undefined),
    (error: unknown) =>
      error instanceof CommsError && error.code === 'CONFIG' && /npx could not be found/.test(error.message),
  );
  assert.ok(cursor && !existsSync(cursor), 'nothing was written');
});

test('a node found elsewhere by the time of the apply is refused: it is not the command planned', async () => {
  const m = machine();
  standIn(m.bin, 'node');
  standIn(m.later, 'node');
  const cursor = knownClientConfigs(m.env).find((file) => file.client === 'cursor')?.path;
  await assert.rejects(
    planThenApply(m, { channel: 'core', client: 'cursor', launcher: 'local', noVerify: true }, () => {
      m.env.PATH = m.later;
    }),
    // `node.exe` on Windows, where PATHEXT decides what runs.
    drifted(/it would start the server with .*later.*node(?:\.exe)?, not .*bin.*node/),
  );
  assert.ok(cursor && !existsSync(cursor), 'nothing was written');
});
