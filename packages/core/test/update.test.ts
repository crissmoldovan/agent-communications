import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { CHANNEL_SERVERS } from '../src/channel-servers.ts';
import type { AccountConfig, InboxConfig } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { type CoreMcpOptions, createCoreMcpServer } from '../src/mcp/server.ts';
import { managedRuntimeDir, managedRuntimeEntry } from '../src/mcp-install.ts';
import { compareVersions, npmLatestVersion } from '../src/npm.ts';
import type { UpdateDeps } from '../src/operations/update.ts';
import { VERSION } from '../src/version.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * `agentcomms update` and `comms_update`: what on this machine is behind the latest release, and one change, approved
 * like every other, that brings it there — every registration registered again at the latest version with exactly
 * the name, client, scope, launcher and pins it has, the runtimes that needs, and the global packages that are there.
 *
 * Nothing here reaches npm or a real client. The registry is a function the test hands the server, or a server on the
 * loopback address for the command; the global packages are a function, or `npm ls -g` over an empty prefix of the
 * test's own; a runtime is a directory the test makes. Clients are Cursor and VS Code, whose configuration is a file
 * this writes itself, so the tests run on Windows too — except where a stand-in client has to be a script.
 */

/*
 * A safety net under all of it: anything that reached the real npm by mistake — an install the stand-ins were meant to
 * take — fails at once, offline, rather than fetching. The command's children get the same through `machine()`.
 */
process.env.npm_config_offline = 'true';

const NOT_ON_WINDOWS =
  process.platform === 'win32'
    ? { skip: 'the stand-in client is a script, which Windows cannot spawn without a shell' }
    : {};

const OLD = '0.0.1';
const LATEST = '99.0.0';
const CREATED = '2026-09-20T00:00:00.000Z';
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

const PACKAGES = {
  core: '@agentcomms/core',
  gmail: '@agentcomms/gmail',
  gmailMcp: '@agentcomms/gmail-mcp',
  slack: '@agentcomms/slack',
} as const;

function account(over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id: 'acc_AAAAAAAAAAAAAAAA',
    platform: 'slack',
    workspace: 'T_ACME',
    userId: 'U_AAAA',
    tier: 'read',
    mode: 'read',
    grantedScopes: [],
    secretRef: 'slack/token/acc_AAAAAAAAAAAAAAAA',
    createdAt: CREATED,
    ...over,
  };
}

function inbox(over: Partial<InboxConfig> = {}): InboxConfig {
  return {
    id: 'ibx_AAAAAAAAAAAAAAAA',
    provider: 'gmail',
    email: 'jo@acme.test',
    identity: 'oidc',
    client: 'desktop',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
    internalDomains: ['acme.test'],
    createdAt: CREATED,
    ...over,
  };
}

/** The accounts the pins below name: a mailbox and a workspace. */
const ACCOUNTS = {
  inboxes: { 'acme/gmail': inbox() },
  accounts: { 'acme/slack': account() },
};

interface Machine {
  home: string;
  bin: string;
  configDir: string;
  dataDir: string;
  env: Record<string, string>;
  core: Core;
}

/** A home of its own, a config directory in it, and a PATH holding only the stand-ins. */
function machine(body: Record<string, unknown> = ACCOUNTS): Machine {
  const home = tempDir('comms-update-');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, ...body }, null, 2)}\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: bin,
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    NO_COLOR: '1',
    npm_config_offline: 'true',
  };
  const core = openCore({ env });
  return { home, bin, configDir, dataDir: core.paths.dataDir, env, core };
}

/**
 * A runtime as the managed launcher leaves one. With `server`, its CLI is a tiny MCP server that answers `initialize`
 * and `tools/list` and writes the arguments it was started with to `started.log` beside it: enough for an install to
 * start the entry it wrote and see it answer, with nothing fetched.
 */
function makeRuntime(m: Machine, packageName: string, version: string, server = false): string {
  const root = managedRuntimeDir(m.dataDir, packageName, version);
  const entry = managedRuntimeEntry(m.dataDir, packageName, version);
  mkdirSync(dirname(entry), { recursive: true });
  const log = join(root, 'started.log');
  writeFileSync(
    entry,
    server
      ? [
          "import { appendFileSync } from 'node:fs';",
          "import { createInterface } from 'node:readline';",
          `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
          'createInterface({ input: process.stdin }).on("line", (line) => {',
          '  let message;',
          '  try { message = JSON.parse(line); } catch { return; }',
          '  if (message.id === undefined) return;',
          '  const result = message.method === "initialize"',
          `    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: ${JSON.stringify(version)} } }`,
          '    : { tools: [] };',
          '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
          '});',
          '',
        ].join('\n')
      : '',
  );
  writeFileSync(
    join(root, 'node_modules', ...packageName.split('/'), 'package.json'),
    JSON.stringify({ name: packageName, version }),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, dependencies: { [packageName]: version } }),
  );
  return root;
}

/** The arguments a started stand-in runtime was given, one start a line. */
function startedWith(m: Machine, packageName: string, version: string): string[][] {
  const log = join(managedRuntimeDir(m.dataDir, packageName, version), 'started.log');
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    : [];
}

interface Entry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** An entry the managed launcher writes: this Node, the runtime's CLI, `mcp`, and the flags that narrow it. */
function managed(m: Machine, packageName: string, version: string, flags: string[] = []): Entry {
  return {
    command: process.execPath,
    args: [managedRuntimeEntry(m.dataDir, packageName, version), 'mcp', ...flags],
    env: { AGENT_COMMS_CONFIG_DIR: m.configDir },
  };
}

/** An entry the npx launcher writes for `channel`. */
function npx(channel: 'core' | 'gmail' | 'slack', version: string, flags: string[] = []): Entry {
  const facts = CHANNEL_SERVERS[channel];
  return { command: 'npx', args: ['-y', `${facts.npxPackage}@${version}`, ...(facts.npxArgs ?? []), ...flags] };
}

const cursorConfig = (m: Machine) => join(m.home, '.cursor', 'mcp.json');

/** Cursor's own configuration, holding `servers`. */
function cursor(m: Machine, servers: Record<string, Entry>): string {
  mkdirSync(join(m.home, '.cursor'), { recursive: true });
  writeFileSync(cursorConfig(m), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  return cursorConfig(m);
}

function cursorEntries(m: Machine): Record<string, Entry> {
  return (JSON.parse(readFileSync(cursorConfig(m), 'utf8')) as { mcpServers: Record<string, Entry> }).mcpServers;
}

/** A registry that answers `latest` for each package, and records every package it was asked about. */
function registry(latest: Record<string, string>) {
  const asked: string[] = [];
  const latestVersion = async (packageName: string) => {
    asked.push(packageName);
    const version = latest[packageName];
    if (version === undefined) throw new Error(`the registry answered 404 for ${packageName}`);
    return version;
  };
  return { asked, latestVersion };
}

const EVERYTHING_LATEST = {
  [PACKAGES.core]: LATEST,
  [PACKAGES.gmail]: LATEST,
  [PACKAGES.gmailMcp]: LATEST,
  [PACKAGES.slack]: LATEST,
};

interface Fakes extends UpdateDeps {
  asked: string[];
  runtimes: string[];
  globals: string[];
}

/** Every outside effect the update has, as stand-ins that record what they were asked to do. */
function fakes(
  m: Machine,
  options: {
    latest?: Record<string, string>;
    global?: Record<string, string>;
    runtimeFails?: string[];
    serverRuntimes?: boolean;
  } = {},
): Fakes {
  const { asked, latestVersion } = registry(options.latest ?? EVERYTHING_LATEST);
  const runtimes: string[] = [];
  const globals: string[] = [];
  // What `npm ls -g` would list: what the test says is there, and then whatever the update installed.
  const installed: Record<string, string> = { ...(options.global ?? {}) };
  return {
    asked,
    runtimes,
    globals,
    latestVersion,
    globalPackages: async () => ({ ...installed }),
    installGlobal: async (spec: string) => {
      globals.push(spec);
      const at = spec.lastIndexOf('@');
      installed[spec.slice(0, at)] = spec.slice(at + 1);
    },
    installRuntime: async (packageName: string, version: string) => {
      runtimes.push(`${packageName}@${version}`);
      if (options.runtimeFails?.includes(packageName)) throw new Error(`npm could not fetch ${packageName}@${version}`);
      makeRuntime(m, packageName, version, options.serverRuntimes === true);
    },
  };
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function connect(m: Machine, options: Partial<CoreMcpOptions> = {}) {
  const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent)}`);
    return result.structuredContent as Record<string, unknown>;
  };
  const refused = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name} should have been refused: ${JSON.stringify(result.structuredContent)}`);
    return (result.structuredContent as { error: { code: string; message: string; hint: string | null } }).error;
  };
  return { call, ok, refused, close: () => Promise.all([client.close(), server.close()]) };
}

type Item = Record<string, unknown>;

/** The report's items of one kind, without the ones a test does not look at. */
const of = (items: unknown, kind: string) => (items as Item[]).filter((item) => item.kind === kind);

// ── Versions ────────────────────────────────────────────────────────────────────────────────────────────────────

test('versions compare as semver: numbers as numbers, and a prerelease before its release', () => {
  assert.equal(compareVersions('0.5.1', '0.5.1'), 0);
  assert.equal(compareVersions('0.5.1', '0.6.0'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1, 'numerically, not as text');
  assert.equal(compareVersions('10.0.0', '9.0.0'), 1);
  assert.equal(compareVersions('0.6.0-rc.1', '0.6.0'), -1, 'a prerelease comes before its release');
  assert.equal(compareVersions('0.6.0-rc.2', '0.6.0-rc.10'), -1, 'numeric identifiers numerically');
  assert.equal(compareVersions('0.6.0-alpha', '0.6.0-alpha.1'), -1, 'fewer identifiers first');
  assert.equal(compareVersions('0.6.0-1', '0.6.0-alpha'), -1, 'a number before a word');
  assert.equal(compareVersions('0.6.0+build.5', '0.6.0'), 0, 'build metadata does not count');
  assert.equal(compareVersions('0.6', '0.6.0'), null, 'not a version: not comparable');
  assert.equal(compareVersions('latest', '0.6.0'), null);
});

// ── The registry ────────────────────────────────────────────────────────────────────────────────────────────────

/** A registry on the loopback address: the abbreviated document for each package, and every path it was asked. */
async function loopbackRegistry(latest: Record<string, string>, options: { hang?: boolean; status?: number } = {}) {
  const requests: { url: string; accept: string }[] = [];
  const server: Server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', accept: String(request.headers.accept ?? '') });
    if (options.hang) return;
    const name = decodeURIComponent((request.url ?? '').slice(1));
    const version = latest[name];
    if (options.status !== undefined || version === undefined) {
      response.writeHead(options.status ?? 404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/vnd.npm.install-v1+json' })
      .end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: {} } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test('the registry is asked for the latest dist-tag of a package by its escaped name, and nothing else is guessed', async () => {
  const served = await loopbackRegistry({ [PACKAGES.gmail]: '1.2.3' });
  try {
    const env = { npm_config_registry: served.url };
    assert.equal(await npmLatestVersion(PACKAGES.gmail, { env }), '1.2.3');
    // npm's own spelling of a scoped name in a registry path: the slash escaped, the @ not.
    assert.equal(served.requests[0]?.url, '/@agentcomms%2fgmail');
    assert.match(served.requests[0]?.accept ?? '', /application\/vnd\.npm\.install-v1\+json/, 'the small document');
    // A package the registry does not have is an error, not "nothing newer".
    await assert.rejects(npmLatestVersion(PACKAGES.slack, { env }), /404/);
  } finally {
    await served.close();
  }
  // A registry that does not answer is given up on, and said so.
  const silent = await loopbackRegistry({}, { hang: true });
  try {
    await assert.rejects(
      npmLatestVersion(PACKAGES.gmail, { env: { npm_config_registry: silent.url }, timeoutMs: 200 }),
      /no answer from http:\/\/127\.0\.0\.1:\d+ within 0\.2 s/,
    );
  } finally {
    await silent.close();
  }
  // Credentials in a configured registry's address are never repeated in what goes wrong.
  const failing = await loopbackRegistry({}, { status: 500 });
  try {
    const withSecret = failing.url.replace('http://', 'http://someone:fake-registry-token@');
    await assert.rejects(npmLatestVersion(PACKAGES.gmail, { env: { npm_config_registry: withSecret } }), (error) => {
      assert.match(String(error), /500/);
      assert.doesNotMatch(String(error), /fake-registry-token/);
      return true;
    });
  } finally {
    await failing.close();
  }
});

// ── Checking ────────────────────────────────────────────────────────────────────────────────────────────────────

test('update --check: what is behind, what is up to date, what pins nothing, and what cannot be updated here', async () => {
  const m = machine();
  makeRuntime(m, PACKAGES.gmail, OLD);
  const before = cursor(m, {
    gmail: managed(m, PACKAGES.gmail, OLD, ['--inbox', 'acme/gmail', '--read-only']),
    slack: npx('slack', LATEST),
    agentcomms: {
      command: process.execPath,
      args: [join(m.home, 'checkout', 'packages', 'core', 'src', 'cli.ts'), 'mcp'],
    },
  });
  const cursorBefore = readFileSync(before, 'utf8');
  // Claude Code: one entry at user scope, with no `claude` on PATH to replace it; one in a project.
  writeFileSync(
    join(m.home, '.claude.json'),
    JSON.stringify({
      mcpServers: { slack: managed(m, PACKAGES.slack, OLD) },
      projects: { [join(m.home, 'project')]: { mcpServers: { gmail: managed(m, PACKAGES.gmail, OLD) } } },
    }),
  );
  const deps = fakes(m, { global: { [PACKAGES.core]: OLD, [PACKAGES.slack]: LATEST } });
  const { ok, close } = await connect(m, { update: deps });
  try {
    const report = await ok('comms_update', { check: true });
    assert.equal(report.core, VERSION);
    // Gmail's npx package is asked about only when something starts it; nothing here does.
    assert.deepEqual(report.latest, {
      [PACKAGES.core]: LATEST,
      [PACKAGES.gmail]: LATEST,
      [PACKAGES.slack]: LATEST,
    });
    assert.deepEqual([...deps.asked].sort(), [PACKAGES.core, PACKAGES.gmail, PACKAGES.slack]);

    const behind = report.behind as Item[];
    assert.deepEqual(of(behind, 'registration'), [
      {
        kind: 'registration',
        channel: 'gmail',
        package: PACKAGES.gmail,
        client: 'claude-code',
        name: 'gmail',
        scope: 'project',
        path: join(m.home, '.claude.json'),
        launcher: 'managed',
        version: OLD,
        latest: LATEST,
        narrowing: [],
        updatable: false,
        reason: of(behind, 'registration')[0]?.reason,
      },
      {
        kind: 'registration',
        channel: 'gmail',
        package: PACKAGES.gmail,
        client: 'cursor',
        name: 'gmail',
        scope: 'user',
        path: before,
        launcher: 'managed',
        version: OLD,
        latest: LATEST,
        narrowing: ['--inbox', 'acme/gmail', '--read-only'],
        updatable: true,
      },
      {
        kind: 'registration',
        channel: 'slack',
        package: PACKAGES.slack,
        client: 'claude-code',
        name: 'slack',
        scope: 'user',
        path: join(m.home, '.claude.json'),
        launcher: 'managed',
        version: OLD,
        latest: LATEST,
        narrowing: [],
        updatable: false,
        reason: of(behind, 'registration')[2]?.reason,
      },
    ]);
    const [project, , noClaude] = of(behind, 'registration');
    assert.match(String(project?.reason), /project/, 'mcp install registers at user scope only');
    assert.match(String(noClaude?.reason), /`claude` is not on PATH/);
    // The runtime the cursor entry needs; the Slack one would be needed only by an entry this cannot update.
    assert.deepEqual(of(behind, 'runtime'), [
      {
        kind: 'runtime',
        channel: 'gmail',
        package: PACKAGES.gmail,
        version: OLD,
        latest: LATEST,
        path: managedRuntimeDir(m.dataDir, PACKAGES.gmail, LATEST),
      },
    ]);
    assert.deepEqual(of(behind, 'global'), [{ kind: 'global', package: PACKAGES.core, version: OLD, latest: LATEST }]);

    const upToDate = report.upToDate as Item[];
    assert.deepEqual(
      of(upToDate, 'registration').map((item) => [item.client, item.name, item.launcher, item.version]),
      [['cursor', 'slack', 'npx', LATEST]],
    );
    assert.deepEqual(of(upToDate, 'global'), [
      { kind: 'global', package: PACKAGES.slack, version: LATEST, latest: LATEST },
    ]);
    // A checkout's own code pins no version, so it is neither behind nor up to date: it is said so.
    assert.deepEqual(
      (report.unpinned as Item[]).map((item) => [item.client, item.name, item.launcher]),
      [['cursor', 'agentcomms', 'local']],
    );
    assert.deepEqual(report.unreadable, []);

    // A check asks nobody and changes nothing.
    assert.deepEqual(await m.core.approvals.list(), []);
    assert.equal(readFileSync(before, 'utf8'), cursorBefore);
    assert.deepEqual([deps.runtimes, deps.globals], [[], []]);
  } finally {
    await close();
  }
});

test('an entry pinned to a renamed account, or written by hand, is behind and left for a person with what to run', async () => {
  const m = machine({
    ...ACCOUNTS,
    formerNames: { inboxes: { work: { name: 'acme/gmail', id: 'ibx_AAAAAAAAAAAAAAAA' } }, accounts: {} },
  });
  makeRuntime(m, PACKAGES.gmail, OLD);
  const config = cursor(m, {
    // Registered before the rename: the server it starts refuses the name it is pinned to.
    'gmail-old': managed(m, PACKAGES.gmail, OLD, ['--inbox', 'work']),
    // Not an entry `mcp install` writes: the whole CLI through npx, by hand.
    'gmail-hand': { command: 'npx', args: ['-y', `${PACKAGES.gmail}@${OLD}`, 'mcp', '--read-only'] },
  });
  const untouched = readFileSync(config, 'utf8');
  const deps = fakes(m);
  const { ok, close } = await connect(m, { update: deps });
  try {
    const check = await ok('comms_update', { check: true });
    const [renamed, hand] = of(check.behind, 'registration');
    assert.equal(renamed?.updatable, false);
    assert.match(String(renamed?.reason), /"work" was renamed to "acme\/gmail"/);
    assert.equal(hand?.launcher, 'other');
    assert.equal(hand?.updatable, false);
    assert.match(
      String(hand?.reason),
      /`agent-gmail mcp install --client cursor --name gmail-hand --read-only --force`/,
    );
    assert.deepEqual(of(check.behind, 'runtime'), [], 'no runtime is needed by what cannot be moved');

    const update = await ok('comms_update', {});
    assert.equal(update.applied, true, 'nothing to approve');
    const result = update.result as { status: string; steps: Item[]; manual: Item[]; next: string | null };
    assert.equal(result.status, 'manual');
    assert.deepEqual(
      result.manual.map((item) => item.name),
      ['gmail-old', 'gmail-hand'],
    );
    assert.equal(result.next, null);
    assert.deepEqual(await m.core.approvals.list(), []);
    assert.equal(readFileSync(config, 'utf8'), untouched);
  } finally {
    await close();
  }
});

test('a configuration that cannot be read still gets a check, and a pinned entry is left unmoved, saying why', async () => {
  const m = machine();
  writeFileSync(join(m.configDir, 'config.json'), '{ not json');
  cursor(m, {
    gmail: managed(m, PACKAGES.gmail, OLD, ['--inbox', 'acme/gmail']),
    slack: managed(m, PACKAGES.slack, OLD),
  });
  const { ok, close } = await connect(m, { update: fakes(m) });
  try {
    const check = await ok('comms_update', { check: true });
    const [gmail, slack] = of(check.behind, 'registration');
    assert.equal(gmail?.updatable, false);
    assert.match(String(gmail?.reason), /configuration could not be read/);
    assert.equal(slack?.updatable, true, 'an entry pinned to nothing needs no account to be found');
  } finally {
    await close();
  }
});

// ── Updating ────────────────────────────────────────────────────────────────────────────────────────────────────

test('update prepares one approval listing every step, writes nothing before it, and applies it with the id', async () => {
  const m = machine();
  makeRuntime(m, PACKAGES.gmail, OLD);
  makeRuntime(m, PACKAGES.slack, OLD);
  const config = cursor(m, {
    gmail: managed(m, PACKAGES.gmail, OLD, ['--inbox', 'acme/gmail', '--read-only']),
    'slack-acme': managed(m, PACKAGES.slack, OLD, ['--workspace', 'acme/slack']),
    agentcomms: npx('core', OLD),
  });
  const untouched = readFileSync(config, 'utf8');
  const deps = fakes(m, { global: { [PACKAGES.core]: OLD, [PACKAGES.gmail]: LATEST } });
  const { ok, close } = await connect(m, { update: deps });
  try {
    const first = await ok('comms_update', { noVerify: true });
    assert.equal(first.approvalRequired, true);
    assert.equal(first.policy, 'chat');
    const preview = String(first.preview);
    const steps = preview.slice(preview.indexOf('It also:')).split('\n').slice(1);
    assert.deepEqual(steps, [
      `  - installs ${PACKAGES.gmail}@${LATEST} from npm into ${managedRuntimeDir(m.dataDir, PACKAGES.gmail, LATEST)}`,
      `  - installs ${PACKAGES.slack}@${LATEST} from npm into ${managedRuntimeDir(m.dataDir, PACKAGES.slack, LATEST)}`,
      `  - registers the agentcomms (core) MCP server with cursor as "agentcomms" again (user scope, npx launcher), at ${LATEST} in place of ${OLD}`,
      `  - cursor will fetch ${PACKAGES.core}@${LATEST} from npm each time it starts "agentcomms"`,
      `  - registers the Gmail MCP server with cursor as "gmail" again (user scope, managed launcher), at ${LATEST} in place of ${OLD} — pinned to the mailbox acme/gmail, read-only, as now`,
      `  - registers the Slack MCP server with cursor as "slack-acme" again (user scope, managed launcher), at ${LATEST} in place of ${OLD} — pinned to the workspace acme/slack, as now`,
      `  - updates the global ${PACKAGES.core} from ${OLD} to ${LATEST}: \`npm install -g ${PACKAGES.core}@${LATEST}\``,
    ]);
    assert.equal(
      first.summary,
      'Update agent-communications to the latest release: 3 registrations, 2 runtimes, 1 global package',
    );
    assert.ok(!preview.includes('…'), 'no step is cut short in the preview');
    // The steps a person agreed to, in full, are what the approval is bound to.
    assert.deepEqual(
      (await m.core.approvals.get(String(first.approvalId)))?.change?.effects,
      steps.map((line) => line.slice(4)),
    );

    // Asking wrote nothing, installed nothing, and made one approval.
    assert.equal(readFileSync(config, 'utf8'), untouched);
    assert.deepEqual([deps.runtimes, deps.globals], [[], []]);
    assert.deepEqual(
      (await m.core.approvals.list()).map((record) => record.approvalId),
      [first.approvalId],
    );

    const second = await ok('comms_update', { noVerify: true, approvalId: first.approvalId });
    assert.equal(second.applied, true);
    const result = second.result as Record<string, unknown>;
    assert.equal(result.status, 'updated');
    assert.equal(result.ok, true);
    assert.deepEqual(
      (result.steps as Item[]).map((step) => [step.kind, step.package ?? step.name, step.outcome]),
      [
        ['runtime', PACKAGES.gmail, 'installed'],
        ['runtime', PACKAGES.slack, 'installed'],
        ['registration', 'agentcomms', 'registered'],
        ['registration', 'gmail', 'registered'],
        ['registration', 'slack-acme', 'registered'],
        ['global', PACKAGES.core, 'updated'],
      ],
    );
    assert.deepEqual(deps.runtimes, [`${PACKAGES.gmail}@${LATEST}`, `${PACKAGES.slack}@${LATEST}`]);
    // Only the global package that was there and behind: Gmail's is current, and Slack's is not installed.
    assert.deepEqual(deps.globals, [`${PACKAGES.core}@${LATEST}`]);

    // Every entry is where it was, under the name it had, with the pins it had — at the latest version.
    const entries = cursorEntries(m);
    assert.deepEqual(Object.keys(entries).sort(), ['agentcomms', 'gmail', 'slack-acme']);
    assert.deepEqual(entries.gmail?.args, [
      managedRuntimeEntry(m.dataDir, PACKAGES.gmail, LATEST),
      'mcp',
      '--inbox',
      'acme/gmail',
      '--read-only',
    ]);
    assert.deepEqual(entries['slack-acme']?.args, [
      managedRuntimeEntry(m.dataDir, PACKAGES.slack, LATEST),
      'mcp',
      '--workspace',
      'acme/slack',
    ]);
    assert.deepEqual(entries.agentcomms?.args, ['-y', `${PACKAGES.core}@${LATEST}`, 'mcp']);
    assert.equal(entries.gmail?.env?.AGENT_COMMS_CONFIG_DIR, m.configDir);

    assert.match(String(result.next), /Restart cursor to load the new servers/);
    assert.match(String(result.next), /comms_server_prune/);
    assert.match(String(result.next), /agentcomms mcp prune/);
    assert.match(String(result.next), /agent-gmail mcp prune/);

    // The approval was claimed, once, and is spent…
    assert.deepEqual(
      (await m.core.approvals.list()).map((record) => [record.approvalId, record.state]),
      [[first.approvalId, 'used']],
    );
    // …and now there is nothing left to do.
    const settled = await ok('comms_update', {});
    assert.equal(settled.applied, true);
    assert.equal((settled.result as Record<string, unknown>).status, 'up-to-date');
  } finally {
    await close();
  }
});

test('a registration is started through its new entry, with its pins, and must answer', async () => {
  const m = machine();
  makeRuntime(m, PACKAGES.gmail, OLD);
  cursor(m, { 'gmail-work': managed(m, PACKAGES.gmail, OLD, ['--inbox', 'acme/gmail']) });
  const deps = fakes(m, { serverRuntimes: true });
  const { ok, close } = await connect(m, { update: deps });
  try {
    const first = await ok('comms_update');
    const done = await ok('comms_update', { approvalId: first.approvalId });
    const [, registration] = (done.result as { steps: Item[] }).steps;
    assert.equal(registration?.outcome, 'registered');
    assert.equal(registration?.verification, 'passed', String(registration?.detail));
    assert.equal(registration?.name, 'gmail-work', 'the name it had');
    assert.deepEqual(startedWith(m, PACKAGES.gmail, LATEST), [['mcp', '--inbox', 'acme/gmail']]);
  } finally {
    await close();
  }
});

test('a runtime that cannot be installed leaves its registrations as they were, and the rest goes on', async () => {
  const m = machine();
  makeRuntime(m, PACKAGES.gmail, OLD);
  makeRuntime(m, PACKAGES.slack, OLD);
  cursor(m, {
    gmail: managed(m, PACKAGES.gmail, OLD, ['--inbox', 'acme/gmail']),
    slack: managed(m, PACKAGES.slack, OLD),
  });
  const deps = fakes(m, { runtimeFails: [PACKAGES.gmail], global: { [PACKAGES.core]: OLD } });
  const { ok, close } = await connect(m, { update: deps });
  try {
    const first = await ok('comms_update', { noVerify: true });
    const done = await ok('comms_update', { noVerify: true, approvalId: first.approvalId });
    const result = done.result as { status: string; ok: boolean; steps: Item[]; next: string };
    assert.equal(result.status, 'failed');
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.steps.map((step) => [step.kind, step.package ?? step.name, step.outcome]),
      [
        ['runtime', PACKAGES.gmail, 'failed'],
        ['runtime', PACKAGES.slack, 'installed'],
        ['registration', 'gmail', 'skipped'],
        ['registration', 'slack', 'registered'],
        ['global', PACKAGES.core, 'updated'],
      ],
    );
    assert.match(String(result.steps[0]?.detail), /could not fetch/);
    assert.match(String(result.steps[2]?.detail), /runtime/);
    const entries = cursorEntries(m);
    assert.deepEqual(entries.gmail?.args, [
      managedRuntimeEntry(m.dataDir, PACKAGES.gmail, OLD),
      'mcp',
      '--inbox',
      'acme/gmail',
    ]);
    assert.deepEqual(entries.slack?.args, [managedRuntimeEntry(m.dataDir, PACKAGES.slack, LATEST), 'mcp']);
    assert.match(result.next, /Restart cursor/);
  } finally {
    await close();
  }
});

test('up to date: it says so, and prepares nothing', async () => {
  const m = machine();
  makeRuntime(m, PACKAGES.gmail, LATEST);
  cursor(m, { gmail: managed(m, PACKAGES.gmail, LATEST, ['--inbox', 'acme/gmail']), slack: npx('slack', LATEST) });
  const deps = fakes(m, { global: { [PACKAGES.core]: LATEST } });
  const { ok, close } = await connect(m, { update: deps });
  try {
    const check = await ok('comms_update', { check: true });
    assert.deepEqual(check.behind, []);
    assert.deepEqual(
      of(check.upToDate, 'runtime').map((item) => [item.package, item.version]),
      [[PACKAGES.gmail, LATEST]],
    );
    const update = await ok('comms_update', {});
    assert.equal(update.applied, true, 'nothing to approve');
    const result = update.result as Record<string, unknown>;
    assert.equal(result.status, 'up-to-date');
    assert.deepEqual(result.steps, []);
    assert.equal(result.next, null);
    assert.deepEqual(await m.core.approvals.list(), []);
    assert.deepEqual([deps.runtimes, deps.globals], [[], []]);
  } finally {
    await close();
  }
});

test('a registry that fails, or answers something that is not a version, stops it: nothing is prepared', async () => {
  const m = machine();
  makeRuntime(m, PACKAGES.gmail, OLD);
  const config = cursor(m, { gmail: managed(m, PACKAGES.gmail, OLD) });
  const untouched = readFileSync(config, 'utf8');
  const failing = fakes(m);
  failing.latestVersion = async (packageName: string) => {
    if (packageName === PACKAGES.gmail) throw new Error('no answer within 10 s');
    return LATEST;
  };
  const one = await connect(m, { update: failing });
  try {
    for (const args of [{ check: true }, {}]) {
      const error = await one.refused('comms_update', args);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.match(error.message, /@agentcomms\/gmail/);
      assert.match(error.message, /no answer within 10 s/);
    }
  } finally {
    await one.close();
  }
  // A version is written into a path, a preview and an npm command: an answer that is not one is refused, not used.
  for (const answer of ['../../../elsewhere', '1.0.0 && rm -rf ~', 'latest', '']) {
    const odd = fakes(m, { latest: { ...EVERYTHING_LATEST, [PACKAGES.gmail]: answer } });
    const two = await connect(m, { update: odd });
    try {
      const error = await two.refused('comms_update', {});
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', answer);
      assert.match(error.message, /not a version/);
    } finally {
      await two.close();
    }
  }
  assert.deepEqual(await m.core.approvals.list(), []);
  assert.equal(readFileSync(config, 'utf8'), untouched);
  assert.equal(existsSync(managedRuntimeDir(m.dataDir, PACKAGES.gmail, LATEST)), false);
});

test('an approval is good only for the update it showed: a newer release, or another tool’s approval, is refused', async () => {
  const m = machine();
  makeRuntime(m, PACKAGES.gmail, OLD);
  const config = cursor(m, { gmail: managed(m, PACKAGES.gmail, OLD, ['--inbox', 'acme/gmail']) });
  const untouched = readFileSync(config, 'utf8');
  const latest = { ...EVERYTHING_LATEST };
  const deps = fakes(m, { latest });
  const { ok, refused, close } = await connect(m, { update: deps });
  try {
    const first = await ok('comms_update', { noVerify: true });
    // A release published between the question and the yes: the person agreed to 99.0.0, not to this.
    latest[PACKAGES.gmail] = '99.0.1';
    const moved = await refused('comms_update', { noVerify: true, approvalId: first.approvalId });
    assert.equal(moved.code, 'APPROVAL_VOID');
    assert.equal(readFileSync(config, 'utf8'), untouched, 'nothing was registered');
    assert.deepEqual(deps.runtimes, [], 'nothing was installed');

    // An approval another tool prepared, for another change, is not this one either.
    const install = await ok('comms_server_install', {
      channel: 'core',
      client: 'cursor',
      launcher: 'npx',
      noVerify: true,
    });
    assert.equal(install.approvalRequired, true);
    const stolen = await refused('comms_update', { noVerify: true, approvalId: install.approvalId });
    assert.equal(stolen.code, 'APPROVAL_VOID');
    assert.equal(readFileSync(config, 'utf8'), untouched);

    // And a check takes no approval: it asks nobody for anything.
    const checked = await refused('comms_update', { check: true, approvalId: first.approvalId });
    assert.equal(checked.code, 'USAGE');
  } finally {
    await close();
  }
});

/** A stand-in for `codex` that records its calls and answers `mcp get <name>` with `answer`. */
function fakeCodex(bin: string, answer: Record<string, unknown>): () => string[] {
  const log = join(bin, 'codex.log');
  const path = join(bin, 'codex');
  writeFileSync(
    path,
    [
      '#!/usr/bin/env node',
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
      `if (process.argv[2] === 'mcp' && process.argv[3] === 'get') process.stdout.write(${JSON.stringify(JSON.stringify(answer))});`,
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
}

test(
  'an entry whose pins would not be carried over exactly is left for a person, never widened',
  NOT_ON_WINDOWS,
  async () => {
    /*
     * Codex's file says the entry is pinned to one mailbox; codex itself, asked what it has, says it is not — and codex
     * is what `codex mcp add` overwrites, so it is what an install keeps the pins of. Registering again from that answer
     * would register a server that reaches every mailbox where the file showed one: the update refuses the step rather
     * than widen it, and says why.
     */
    const m = machine();
    makeRuntime(m, PACKAGES.gmail, OLD);
    const pinned = managed(m, PACKAGES.gmail, OLD, ['--inbox', 'acme/gmail']);
    mkdirSync(join(m.home, '.codex'));
    writeFileSync(
      join(m.home, '.codex', 'config.toml'),
      [
        '[mcp_servers.gmail]',
        `command = ${JSON.stringify(pinned.command)}`,
        `args = [${pinned.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
        '',
      ].join('\n'),
    );
    const readCodex = fakeCodex(m.bin, {
      name: 'gmail',
      transport: { type: 'stdio', command: pinned.command, args: pinned.args.slice(0, 2) },
    });
    const deps = fakes(m);
    const { ok, close } = await connect(m, { update: deps });
    try {
      const check = await ok('comms_update', { check: true });
      assert.equal(of(check.behind, 'registration')[0]?.updatable, true, 'from the file, it could be');
      const update = await ok('comms_update', { noVerify: true });
      assert.equal(update.applied, true, 'nothing left to approve');
      const result = update.result as { status: string; steps: Item[]; manual: Item[] };
      assert.equal(result.status, 'manual');
      assert.deepEqual(result.steps, []);
      assert.equal(result.manual[0]?.name, 'gmail');
      assert.match(String(result.manual[0]?.reason), /--inbox acme\/gmail/);
      assert.deepEqual(
        readCodex().filter((call) => !call.startsWith('mcp get')),
        [],
        'codex was asked what it has, and told to change nothing',
      );
      assert.deepEqual(deps.runtimes, []);
    } finally {
      await close();
    }
  },
);

// ── The command is the same change ──────────────────────────────────────────────────────────────────────────────

/** The core CLI from source, as a child that does not block this process: the registry it asks is served here. */
function cli(m: Machine, args: string[], extra: Record<string, string>) {
  const path = [m.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);
  return new Promise<{ status: number | null; stdout: string; stderr: string; json: () => Record<string, unknown> }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [...NODE_FLAGS, CLI, ...args], {
        env: { ...m.env, PATH: path, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.once('error', reject);
      child.once('close', (status) =>
        resolve({ status, stdout, stderr, json: () => JSON.parse(stdout.trim().split('\n')[0] ?? '') }),
      );
    },
  );
}

test('`agentcomms update` gives the tool’s check and preview, and claims the approval the tool prepared', async () => {
  /*
   * Both surfaces with nothing injected: the registry is one on the loopback address, named the way npm names one
   * (`npm_config_registry`), and the global packages are what `npm ls -g` finds in an empty prefix of the test's own.
   */
  const m = machine();
  const config = cursor(m, { gmail: npx('gmail', OLD, ['--inbox', 'acme/gmail']) });
  const served = await loopbackRegistry(EVERYTHING_LATEST);
  const prefix = join(m.home, 'npm-global');
  // npm's global root: `lib/node_modules` on POSIX, `node_modules` on Windows.
  mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
  mkdirSync(join(prefix, 'node_modules'), { recursive: true });
  const extra = { npm_config_registry: served.url, npm_config_prefix: prefix, npm_config_update_notifier: 'false' };
  const env = { ...m.env, ...extra };
  const { ok, close } = await connect({ ...m, env });
  try {
    const check = await ok('comms_update', { check: true });
    const byCommand = await cli(m, ['update', '--check', '--json'], extra);
    assert.equal(byCommand.status, 0, byCommand.stderr);
    assert.deepEqual(byCommand.json().data, check);
    // Gmail's npx package, asked about because an entry starts it.
    assert.deepEqual(check.latest, EVERYTHING_LATEST);
    assert.ok(served.requests.some((request) => request.url === '/@agentcomms%2fgmail-mcp'));
    assert.deepEqual(check.unreadable, [], 'npm ls -g read the empty prefix');
    // A check reads; an approval handed to it is refused, not ignored, as the tool refuses it.
    const stray = await cli(m, ['update', '--check', '--approval', 'ap_00000000000000000000000000', '--json'], extra);
    assert.equal(stray.status, 64, stray.stdout);

    const asked = await ok('comms_update', {});
    assert.equal(asked.approvalRequired, true);
    const pending = await cli(m, ['update', '--json'], { ...extra, CLAUDECODE: '1' });
    assert.equal(pending.status, 10, pending.stderr);
    const error = pending.json().error as { hint: string; details: { approvalId: string; preview: string } };
    const same = (preview: string, id: string) => preview.replaceAll(id, '<id>');
    assert.equal(
      same(error.details.preview, error.details.approvalId),
      same(String(asked.preview), String(asked.approvalId)),
    );
    assert.match(error.hint, new RegExp(`agentcomms update --approval ${error.details.approvalId}`));
    assert.match(String(asked.preview), new RegExp(`${PACKAGES.gmailMcp}@${LATEST}`));

    // The approval the tool prepared, claimed by the command: one change, whichever surface asked.
    const done = await cli(m, ['update', '--no-verify', '--approval', String(asked.approvalId), '--json'], {
      ...extra,
      CLAUDECODE: '1',
    });
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal((done.json().data as Record<string, unknown>).status, 'updated');
    assert.deepEqual(cursorEntries(m).gmail?.args, ['-y', `${PACKAGES.gmailMcp}@${LATEST}`, '--inbox', 'acme/gmail']);
    assert.equal(readFileSync(config, 'utf8').includes(`@${OLD}`), false);
  } finally {
    await close();
    await served.close();
  }
});

test('a registration that does not start fails the update, and the command says so in its exit status', async () => {
  const m = machine();
  // The latest runtime is on disk already, and its CLI exits at once: registered, started, and no answer.
  makeRuntime(m, PACKAGES.gmail, LATEST);
  cursor(m, { gmail: managed(m, PACKAGES.gmail, OLD, ['--inbox', 'acme/gmail']) });
  const served = await loopbackRegistry(EVERYTHING_LATEST);
  const prefix = join(m.home, 'npm-global');
  mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
  mkdirSync(join(prefix, 'node_modules'), { recursive: true });
  const extra = {
    npm_config_registry: served.url,
    npm_config_prefix: prefix,
    npm_config_update_notifier: 'false',
    CLAUDECODE: '1',
  };
  try {
    const asked = await cli(m, ['update', '--json'], extra);
    assert.equal(asked.status, 10, asked.stderr);
    const { approvalId, preview } = (asked.json().error as { details: { approvalId: string; preview: string } })
      .details;
    assert.doesNotMatch(preview, /installs /, 'the runtime is there: nothing to install');
    const done = await cli(m, ['update', '--approval', approvalId, '--json'], extra);
    assert.equal(done.status, 69, done.stdout + done.stderr);
    const result = done.json().data as { status: string; ok: boolean; steps: Item[] };
    assert.equal(result.status, 'failed');
    assert.equal(result.ok, false);
    assert.equal(result.steps[0]?.outcome, 'registered');
    assert.equal(result.steps[0]?.verification, 'failed');
    assert.ok(result.steps[0]?.backupPath, 'the entry it replaced was saved first');
  } finally {
    await served.close();
  }
});

// ── Seeing drift without asking the network ─────────────────────────────────────────────────────────────────────

test('comms_channels_available flags an entry pinned older than this core, and reads no registry to do it', async () => {
  const m = machine();
  const newer = `${Number(VERSION.split('.')[0]) + 1}.0.0`;
  cursor(m, {
    gmail: managed(m, PACKAGES.gmail, OLD),
    slack: npx('slack', VERSION),
    'slack-next': npx('slack', newer),
    agentcomms: {
      command: process.execPath,
      args: [join(m.home, 'checkout', 'packages', 'core', 'src', 'cli.ts'), 'mcp'],
    },
  });
  const deps = fakes(m);
  const { ok, close } = await connect(m, { update: deps });
  try {
    const report = await ok('comms_channels_available');
    const flags = (report.channels as { registered: Item[] }[])
      .flatMap((channel) => channel.registered)
      .map((entry) => [entry.name, entry.version, entry.behindCore]);
    assert.deepEqual(flags, [
      ['agentcomms', null, false],
      ['gmail', OLD, true],
      ['slack', VERSION, false],
      ['slack-next', newer, false],
    ]);
    assert.deepEqual(deps.asked, [], 'no registry was asked');
  } finally {
    await close();
  }
});
