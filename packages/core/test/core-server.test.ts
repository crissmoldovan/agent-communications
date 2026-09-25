import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { gatedChange } from '../src/change-flow.ts';
import { beginChangeApproval, finishChangeApproval } from '../src/changes.ts';
import { CHANNEL_SERVERS } from '../src/channel-servers.ts';
import type { AccountConfig, InboxConfig } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { type CoreMcpOptions, createCoreMcpServer } from '../src/mcp/server.ts';
import { type McpProduct, managedRuntimeDir, managedRuntimeEntry, pruneManagedRuntimes } from '../src/mcp-install.ts';
import { serverInstallChange, serverPruneChange } from '../src/operations/servers.ts';
import type { SecretStore } from '../src/secrets.ts';
import { VERSION } from '../src/version.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The core MCP server and the commands it mirrors (design 2026-09-25 §5): every tool is the operation its
 * `agentcomms` command runs, every change goes through the one change flow, and no tool claims a change it did not
 * plan itself. Every test runs against temporary directories and a clean environment; `claude` is a stand-in on PATH
 * that records what it was asked, and nothing touches the keychain, a real client config or npm.
 */

const NOT_ON_WINDOWS =
  process.platform === 'win32'
    ? { skip: 'the stand-in client is a script, which Windows cannot spawn without a shell' }
    : {};

const CREATED = '2026-09-20T00:00:00.000Z';
const ACME = 'acc_AAAAAAAAAAAAAAAA';
const MAIL = 'ibx_AAAAAAAAAAAAAAAA';
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

function account(over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id: ACME,
    platform: 'slack',
    workspace: 'T_ACME',
    userId: 'U_AAAA',
    tier: 'read',
    mode: 'read',
    grantedScopes: [],
    secretRef: `slack/token/${ACME}`,
    createdAt: CREATED,
    ...over,
  };
}

function inbox(over: Partial<InboxConfig> = {}): InboxConfig {
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
    createdAt: CREATED,
    ...over,
  };
}

/** A config directory holding `body`, written directly: a fixture's own settings need nobody's consent. */
function configDirWith(body: Record<string, unknown> = {}): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ version: 2, ...body }, null, 2)}\n`);
  return dir;
}

interface Machine {
  home: string;
  bin: string;
  configDir: string;
  env: Record<string, string>;
  core: Core;
}

/**
 * A home of its own, a config directory in it, and a PATH holding only the stand-ins.
 *
 * Every variable a client or a path could be read from is set here, so nothing falls through to the real home: a
 * `CLAUDE_CONFIG_DIR` or an `XDG_DATA_HOME` inherited from the person running the tests would point the installer at
 * their own files.
 */
function machine(body?: Record<string, unknown>): Machine {
  const home = tempDir('comms-home-');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  if (body) writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, ...body }, null, 2)}\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    PATH: bin,
    AGENT_COMMS_CONFIG_DIR: configDir,
    NO_COLOR: '1',
  };
  return { home, bin, configDir, env, core: openCore({ env }) };
}

/** A stand-in for `claude` that records every call and succeeds. Returns what it was asked, one call a line. */
function fakeClaude(bin: string): () => string[] {
  const log = join(bin, 'claude.log');
  const path = join(bin, 'claude');
  writeFileSync(
    path,
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`,
  );
  chmodSync(path, 0o755);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
}

/**
 * The core CLI from source, with `m`'s environment — plus node, for the stand-ins it starts, and the system's own
 * directories, where `ps` is: prune keeps everything when it cannot list the running processes.
 */
function cli(m: Machine, args: string[], extra: Record<string, string> = {}) {
  const path = [m.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);
  const result = spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], {
    encoding: 'utf8',
    env: { ...m.env, PATH: path, ...extra },
  });
  const json = () => JSON.parse(result.stdout.trim().split('\n')[0] ?? '');
  return { ...result, json };
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
  /** A call that must succeed: its structured content. */
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent)}`);
    return result.structuredContent as Record<string, unknown>;
  };
  return { client, call, ok, close: () => Promise.all([client.close(), server.close()]) };
}

/** A person at a terminal approving a change under `confirm`: shown it, and typing the code back. */
async function approveAtTerminal(core: Core, approvalId: string): Promise<void> {
  const prompt = await beginChangeApproval(core, approvalId, { surface: 'cli' });
  await finishChangeApproval(core, approvalId, prompt.challenge, { surface: 'cli' });
}

// ── The store's refusal ────────────────────────────────────────────────────────────────────────────────────────

test('a loosening refused by the store names both ways to approve it: from a chat, and at a terminal', async () => {
  // The hint said only a terminal could loosen a setting, which stopped being true when change approvals reached
  // chat. A hint that names one route sends an agent to a terminal it may not have, for a change it could have asked
  // for in the conversation.
  const dir = configDirWith({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account() } });
  const core = openCore({ env: { AGENT_COMMS_CONFIG_DIR: dir, HOME: dir } });
  await assert.rejects(
    core.config.update((config) => {
      config.defaults.changePolicy = 'chat';
      return config;
    }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'LOOSENING_REFUSED');
      assert.match(error.hint ?? '', /chat/, 'the chat route');
      assert.match(error.hint ?? '', /approval id/, '…which is a tool returning an approval id');
      assert.match(error.hint ?? '', /agentcomms approve/, 'the terminal route under confirm');
      assert.match(error.hint ?? '', /terminal/);
      assert.doesNotMatch(error.hint ?? '', /Only a person at a terminal/, 'not the terminal alone');
      return true;
    },
  );
});

// ── What the server offers ──────────────────────────────────────────────────────────────────────────────────────

const READING = ['comms_paths', 'comms_doctor', 'comms_audit_tail', 'comms_approvals_list', 'comms_channels_available'];
const CHANGING = [
  'comms_change_policy',
  'comms_server_install',
  'comms_server_prune',
  'comms_names_migrate',
  'comms_secrets_migrate',
];

test('the server offers the core tools, and no tool that approves or claims a change it did not plan', async () => {
  /*
   * A generic claim — hand it an approval id and a configuration, and it writes — would let an agent make any change
   * it could describe, shown to nobody as what it is. Each changing tool plans its own change instead, and the
   * approval is only good for that plan. And under `confirm` approving is a person at a terminal, so no tool approves.
   */
  const m = machine();
  const { client, close } = await connect(m);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...READING, ...CHANGING, 'comms_approval_revoke'].sort());
    for (const name of names) {
      assert.doesNotMatch(name, /claim|prepare|approve(?!d)|apply/, `${name} reads as a generic approval tool`);
    }
    for (const tool of tools) {
      // A changing tool takes the approval it returned, optionally; `comms_approval_revoke` requires the one it voids.
      const takesApproval =
        'approvalId' in (tool.inputSchema.properties ?? {}) &&
        !(tool.inputSchema.required ?? []).includes('approvalId');
      assert.equal(takesApproval, CHANGING.includes(tool.name), `${tool.name}: approvalId only on a changing tool`);
      assert.equal(
        tool.annotations?.readOnlyHint === true,
        READING.includes(tool.name),
        `${tool.name}: read-only hint`,
      );
    }
  } finally {
    await close();
  }
});

test('the greeting says how a change is approved, names the policy in force, and stays under 2 KB', async () => {
  /*
   * Claude Code cuts a server's instructions at 2,048 bytes (design 2026-09-18 §11). The Gmail and Slack greetings
   * have a test holding them under it; this one had none, and the Slack greeting was 2.7 KB before anyone measured.
   */
  for (const changePolicy of ['chat', 'confirm'] as const) {
    const m = machine({ defaults: { changePolicy } });
    const { client, close } = await connect(m);
    try {
      const greeting = client.getInstructions() ?? '';
      assert.ok(Buffer.byteLength(greeting) < 2048, `${Buffer.byteLength(greeting)} bytes; Claude Code keeps 2,048`);
      assert.match(greeting, /approvalRequired/);
      assert.match(greeting, /agentcomms approve <approvalId>/);
      assert.match(greeting, /you cannot approve it for them/);
      assert.match(greeting, new RegExp(`The default change policy here is ${changePolicy}\\.`));
      assert.match(greeting, /restarted/, 'the last line survives too');
    } finally {
      await close();
    }
  }
});

// ── Reading: the same data as the command ───────────────────────────────────────────────────────────────────────

test('paths, the audit log and the approvals list return what their commands print', async () => {
  const m = machine({ accounts: { 'acme/slack': account() } });
  // One audit line and one approval, from a change prepared through the server itself.
  const { ok, call, close } = await connect(m);
  try {
    const prepared = await ok('comms_change_policy', { account: 'acme/slack', set: 'chat' });
    assert.equal(prepared.applied, true, 'chat is already in force, so there was nothing to loosen');
    await ok('comms_change_policy', { account: 'acme/slack', set: 'confirm' });
    const loosen = await ok('comms_change_policy', { account: 'acme/slack', set: 'chat' });
    assert.equal(loosen.approvalRequired, true);

    assert.deepEqual(await ok('comms_paths'), cli(m, ['paths', '--json']).json().data);
    assert.deepEqual(
      (await ok('comms_audit_tail', { limit: 5 })).records,
      cli(m, ['audit', 'tail', '--limit', '5', '--json']).json().data,
    );
    const listed = (await ok('comms_approvals_list', { state: 'pending' })).approvals as { approvalId: string }[];
    assert.deepEqual(listed, cli(m, ['approvals', 'list', '--state', 'pending', '--json']).json().data);
    assert.deepEqual(
      listed.map((record) => record.approvalId),
      [loosen.approvalId],
    );
    assert.ok(!JSON.stringify(listed).includes('challengeHash'), 'never a code, nor its hash');

    // A state that does not exist is refused on both surfaces, not answered with an empty list.
    const refused = cli(m, ['approvals', 'list', '--state', 'nope', '--json']);
    assert.equal(refused.status, 64);
    assert.equal((await call('comms_approvals_list', { state: 'nope' })).isError, true);
  } finally {
    await close();
  }
});

test('revoking a change approval from chat voids it, and the audit log says which surface did', async () => {
  const m = machine({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account() } });
  const { ok, close } = await connect(m);
  try {
    const loosen = await ok('comms_change_policy', { set: 'chat' });
    const revoked = await ok('comms_approval_revoke', { approvalId: loosen.approvalId });
    assert.equal(revoked.state, 'revoked');
    const line = (await m.core.audit.tail()).find((record) => record.operation === 'change.revoke');
    assert.equal(line?.surface, 'mcp');
    // Revoked is final: approving it at a terminal afterwards is refused.
    await assert.rejects(approveAtTerminal(m.core, String(loosen.approvalId)));
  } finally {
    await close();
  }
});

test('the doctor over MCP is the same report, and the keychain it probes is the one it is given', async () => {
  const m = machine();
  const { ok, close } = await connect(m, { keyring: null });
  try {
    const report = await ok('comms_doctor');
    const names = (report.checks as { name: string }[]).map((check) => check.name);
    assert.deepEqual(names, [
      'node',
      'config dir',
      'state dir',
      'config',
      'account names',
      'system keychain',
      'secret backend',
    ]);
    const keychain = (report.checks as { name: string; ok: boolean; detail: string }[]).find(
      (check) => check.name === 'system keychain',
    );
    assert.match(keychain?.detail ?? '', /not installed/, 'no module given, so none was loaded or probed');
    assert.equal(report.ok, false, 'a keychain-backed machine with no keychain fails the doctor');
  } finally {
    await close();
  }
});

// ── The change policy ───────────────────────────────────────────────────────────────────────────────────────────

test('the change policy: reported the same by the tool and the command, tightened at once', async () => {
  const m = machine({
    accounts: { 'acme/slack': account() },
    inboxes: { 'acme/gmail': inbox({ changePolicy: 'confirm' }) },
  });
  const { ok, close } = await connect(m);
  try {
    const defaults = await ok('comms_change_policy');
    assert.deepEqual(defaults, {
      scope: 'defaults',
      name: null,
      changePolicy: 'chat',
      setHere: null,
      overrides: [{ kind: 'inbox', name: 'acme/gmail', changePolicy: 'confirm' }],
    });
    assert.deepEqual(defaults, cli(m, ['policy', '--json']).json().data);
    const one = await ok('comms_change_policy', { account: 'acme/slack' });
    assert.deepEqual(one, { scope: 'account', name: 'acme/slack', changePolicy: 'chat', setHere: null });
    assert.deepEqual(one, cli(m, ['policy', '--account', 'acme/slack', '--json']).json().data);

    // Tightening asks nobody, from either surface.
    const tightened = await ok('comms_change_policy', { account: 'acme/slack', set: 'confirm' });
    assert.deepEqual(tightened, {
      applied: true,
      result: { scope: 'account', name: 'acme/slack', changePolicy: 'confirm', setHere: 'confirm' },
    });
    const byCommand = cli(m, ['policy', 'confirm', '--json'], { CLAUDECODE: '1' });
    assert.equal(byCommand.status, 0, byCommand.stderr);
    assert.equal(byCommand.json().data.changePolicy, 'confirm');
    assert.deepEqual(await m.core.approvals.list(), [], 'tightening made no approval');

    // An approval id with nothing to set is refused, not ignored.
    const stray = cli(m, ['policy', '--approval', 'apr_x', '--json']);
    assert.equal(stray.status, 64);
  } finally {
    await close();
  }
});

test('loosening the change policy from chat needs a code typed at a terminal, whatever surface asks', async () => {
  const m = machine({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account() } });
  const { ok, call, close } = await connect(m);
  try {
    const first = await ok('comms_change_policy', { set: 'chat' });
    assert.equal(first.applied, false);
    assert.equal(first.approvalRequired, true);
    // The policy in force before the change decides how it is approved: `confirm`, so a terminal.
    assert.equal(first.policy, 'confirm');
    assert.match(String(first.preview), /default change policy: confirm → chat/);
    assert.match(String(first.next), new RegExp(`agentcomms approve ${first.approvalId}`));

    // Called again before anybody approved it: refused, and the approval is still there to be approved.
    const early = await call('comms_change_policy', { set: 'chat', approvalId: first.approvalId });
    assert.equal(early.isError, true);
    assert.equal((early.structuredContent as { error: { code: string } }).error.code, 'APPROVAL_PENDING');
    assert.equal((await m.core.config.load()).defaults.changePolicy, 'confirm');

    await approveAtTerminal(m.core, String(first.approvalId));
    const applied = await ok('comms_change_policy', { set: 'chat', approvalId: first.approvalId });
    assert.deepEqual(applied.result, {
      scope: 'defaults',
      name: null,
      changePolicy: 'chat',
      setHere: 'chat',
      overrides: [],
    });
    assert.equal((await m.core.config.load()).defaults.changePolicy, 'chat');

    // The command is the same change: an agent gets the approval id and exit 10, and nothing is written.
    const again = machine({ defaults: { changePolicy: 'confirm' } });
    const asked = cli(again, ['policy', 'chat', '--json'], { CLAUDECODE: '1' });
    assert.equal(asked.status, 10, asked.stderr);
    assert.equal(asked.json().error.details.policy, 'confirm');
    assert.equal((await again.core.config.load()).defaults.changePolicy, 'confirm');
  } finally {
    await close();
  }
});

test('an approval is good only for the change the tool that prepared it plans: no tool claims another’s', async () => {
  /*
   * What makes a generic claim tool unnecessary is also what makes one impossible to fake: every tool computes its own
   * change again when it is called with an approval id, and `claimChange` refuses an id bound to anything else.
   */
  const m = machine({
    defaults: { changePolicy: 'chat' },
    accounts: { 'acme/slack': account({ changePolicy: 'confirm' }) },
  });
  const readClaude = fakeClaude(m.bin);
  const { ok, call, close } = await connect(m);
  try {
    const install = await ok('comms_server_install', {
      channel: 'core',
      client: 'claude-code',
      launcher: 'npx',
      noVerify: true,
    });
    assert.equal(install.approvalRequired, true);
    // The same id, handed to a different tool: refused, and neither change is made.
    const stolen = await call('comms_change_policy', {
      account: 'acme/slack',
      set: 'chat',
      approvalId: install.approvalId,
    });
    assert.equal(stolen.isError, true);
    assert.equal((await m.core.config.load()).accounts['acme/slack']?.changePolicy, 'confirm');
    // …and to the same tool, for a different registration: refused too.
    const other = await call('comms_server_install', {
      channel: 'core',
      client: 'claude-code',
      name: 'something-else',
      launcher: 'npx',
      noVerify: true,
      approvalId: install.approvalId,
    });
    assert.equal(other.isError, true);
    assert.deepEqual(readClaude(), [], 'nothing was registered');
  } finally {
    await close();
  }
});

// ── Registering a server ────────────────────────────────────────────────────────────────────────────────────────

test(
  'comms_server_install registers nothing until the person agrees, then registers it and says to restart',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const readClaude = fakeClaude(m.bin);
    const { ok, close } = await connect(m);
    try {
      const first = await ok('comms_server_install', { channel: 'core', client: 'claude-code', launcher: 'local' });
      assert.equal(first.approvalRequired, true);
      assert.equal(first.policy, 'chat');
      assert.match(
        String(first.preview),
        /registers the agentcomms \(core\) MCP server with claude-code as "agentcomms"/,
      );
      assert.match(String(first.preview), /will start it from .*packages[/\\]core[/\\]src[/\\]cli\.ts/);
      assert.deepEqual(readClaude(), [], 'asking wrote nothing');

      const second = await ok('comms_server_install', {
        channel: 'core',
        client: 'claude-code',
        launcher: 'local',
        approvalId: first.approvalId,
      });
      assert.equal(second.applied, true);
      const result = second.result as Record<string, unknown>;
      assert.equal(result.applied, true);
      assert.equal(result.method, 'cli');
      // Started through exactly the entry it wrote, and it answered: the core server, from this checkout.
      assert.equal(result.verification, 'passed', String(result.verifyDetail));
      assert.match(String(result.restart), /Restart claude-code to load "agentcomms"/);
      const [added] = readClaude();
      assert.match(added ?? '', /^mcp add-json agentcomms \{.*"mcp".*\} --scope user$/);
      assert.ok(
        (added ?? '').includes(`"AGENT_COMMS_CONFIG_DIR":${JSON.stringify(m.configDir)}`),
        'this config, named',
      );

      // Spent: the same approval does not register it again.
      const replayed = await connect(m).then(async (again) => {
        try {
          return await again.call('comms_server_install', {
            channel: 'core',
            client: 'claude-code',
            launcher: 'local',
            force: true,
            approvalId: first.approvalId,
          });
        } finally {
          await again.close();
        }
      });
      assert.equal(replayed.isError, true);
      assert.equal(readClaude().length, 1);
    } finally {
      await close();
    }
  },
);

test('printing an entry registers nothing, and so asks nobody', async () => {
  const m = machine();
  const { ok, close } = await connect(m);
  try {
    const printed = await ok('comms_server_install', {
      channel: 'slack',
      client: 'cursor',
      print: true,
      noVerify: true,
    });
    assert.equal(printed.applied, true, 'nothing to approve');
    const result = printed.result as Record<string, unknown>;
    assert.equal(result.applied, false);
    assert.equal(result.restart, null);
    assert.match(String(result.snippet), /"slack"/);
    assert.match(String(result.snippet), new RegExp(`runtime[/\\\\]+${VERSION.replaceAll('.', '\\.')}-slack`));
    assert.deepEqual(await m.core.approvals.list(), []);
  } finally {
    await close();
  }
});

test('a registration that would be refused is refused before anybody is asked', async () => {
  const m = machine({
    inboxes: { 'acme/gmail': inbox() },
    formerNames: { inboxes: { work: { name: 'acme/gmail', id: MAIL } }, accounts: {} },
  });
  fakeClaude(m.bin);
  // Somebody else's server under the name the Slack server would take.
  writeFileSync(
    join(m.home, '.claude.json'),
    JSON.stringify({
      mcpServers: { slack: { command: 'npx', args: ['-y', 'some-other-slack'], env: { TOKEN: 'fake-token-1' } } },
    }),
  );
  const { call, close } = await connect(m);
  const refused = async (args: Record<string, unknown>, code: string, message: RegExp) => {
    const result = await call('comms_server_install', args);
    assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
    const error = result.structuredContent?.error as { code: string; message: string };
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.ok(!JSON.stringify(result).includes('fake-token-1'), 'a token in somebody else’s entry is never repeated');
  };
  try {
    await refused(
      { channel: 'gmail', client: 'claude-code', inbox: 'nope/gmail' },
      'NOT_FOUND',
      /no inbox called "nope\/gmail"/,
    );
    await refused(
      { channel: 'gmail', client: 'claude-code', inbox: 'work' },
      'NOT_FOUND',
      /"work" was renamed to "acme\/gmail"/,
    );
    // What a channel's own `mcp install` has no flag for is refused, not dropped: dropped, the pin would widen.
    await refused(
      { channel: 'slack', client: 'claude-code', inbox: 'acme/gmail' },
      'USAGE',
      /option of the Gmail server/,
    );
    await refused({ channel: 'core', client: 'claude-code', readOnly: true }, 'USAGE', /option of the Gmail server/);
    await refused({ channel: 'slack', client: 'claude-code', launcher: 'npx' }, 'CONFIG', /is not this one/);
    assert.deepEqual(await m.core.approvals.list(), [], 'nobody was asked about any of them');
  } finally {
    await close();
  }
});

test('`agentcomms mcp install` is the same change at the command line', NOT_ON_WINDOWS, () => {
  const m = machine();
  const readClaude = fakeClaude(m.bin);
  const args = ['mcp', 'install', '--client', 'claude-code', '--launcher', 'local', '--no-verify'];
  const asked = cli(m, [...args, '--json'], { CLAUDECODE: '1' });
  assert.equal(asked.status, 10, asked.stderr);
  const pending = asked.json().error;
  assert.match(pending.details.preview, /registers the agentcomms \(core\) MCP server with claude-code/);
  assert.match(
    pending.hint,
    new RegExp(
      `agentcomms mcp install --client claude-code --launcher local --no-verify --approval ${pending.details.approvalId}`,
    ),
  );
  assert.deepEqual(readClaude(), []);

  const done = cli(m, [...args, '--approval', pending.details.approvalId, '--json'], { CLAUDECODE: '1' });
  // Registered but not started (`--no-verify`): exit 0, and the entry is what the tool would have written.
  assert.equal(done.status, 0, done.stderr);
  const result = done.json().data;
  assert.equal(result.applied, true);
  assert.match(result.restart, /Restart claude-code/);
  assert.equal(readClaude().length, 1);

  const printed = cli(m, ['mcp', 'install', '--client', 'json', '--print', '--no-verify', '--json'], {
    CLAUDECODE: '1',
  });
  assert.equal(printed.status, 0, 'a print asks nobody');
});

/** A channel's own product, as `agent-slack mcp install` passes `SLACK_MCP`: the facts, plus what only it knows. */
function slackOwnProduct(warning: string): McpProduct {
  return { ...CHANNEL_SERVERS.slack, version: VERSION, moduleUrl: '', warnAbout: () => [warning] };
}

test("a channel's own product registers with its own warnings, under the approval the core server prepared", async () => {
  /*
   * `agent-gmail mcp install` and `agent-slack mcp install` pass their own product, because it carries what core
   * cannot know: the warning about other servers for the same service. The approval is bound to the preview's
   * sentences, so those have to be the same whichever surface planned them — an approval an agent got from
   * `comms_server_install` is claimed by the channel's own command, and a person's yes to one is not refused by the
   * other.
   */
  const m = machine();
  const request = { channel: 'slack', client: 'cursor', launcher: 'npx', noVerify: true } as const;
  const own = slackOwnProduct('another Slack server posts with its own token');

  const asked = await gatedChange(m.core, serverInstallChange(m.core, m.env, request), { surface: 'mcp' });
  assert.equal(asked.status, 'approval-required');
  if (asked.status !== 'approval-required') return;
  assert.match(asked.prepared.preview, /registers the Slack MCP server with cursor as "slack"/);
  assert.match(asked.prepared.preview, new RegExp(`will fetch @agentcomms/slack@${VERSION.replaceAll('.', '\\.')}`));
  const config = await m.core.config.load();
  assert.deepEqual(
    (await serverInstallChange(m.core, m.env, request, own).plan(config)).effects,
    asked.prepared.effects,
    'the same words, whichever product planned them',
  );

  const done = await gatedChange(m.core, serverInstallChange(m.core, m.env, request, own), {
    surface: 'cli',
    approvalId: asked.prepared.approvalId,
  });
  assert.equal(done.status, 'applied');
  if (done.status !== 'applied') return;
  assert.equal(done.result.applied, true);
  assert.deepEqual(done.result.warnings, ['another Slack server posts with its own token'], 'the channel’s warning');
  const written = JSON.parse(readFileSync(join(m.home, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(written.mcpServers.slack.args.slice(0, 3), ['-y', `@agentcomms/slack@${VERSION}`, 'mcp']);
});

test('a product that is not the channel’s cannot register or prune that channel', () => {
  // The preview names the channel's server; a product for another package would register something else under it.
  const m = machine();
  const slack = slackOwnProduct('unused');
  const refused = (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'UNEXPECTED');
    assert.match(error.message, /@agentcomms\/slack is not the Gmail server's package/);
    return true;
  };
  assert.throws(() => serverInstallChange(m.core, m.env, { channel: 'gmail', client: 'cursor' }, slack), refused);
  assert.throws(() => serverPruneChange(m.core, m.env, { channel: 'gmail' }, slack), refused);
  // Its own channel's is accepted.
  serverInstallChange(m.core, m.env, { channel: 'slack', client: 'cursor' }, slack);
  serverPruneChange(m.core, m.env, { channel: 'slack' }, slack);
});

/** A server name built to read, inside the preview's quotes, as a pin and `--read-only` the entry will not have. */
const SPOOF_NAME = 'gmail", pinned to the mailbox work, read-only, "';

test('a server name that could rewrite the preview is refused on every surface, before anybody is asked', async () => {
  /*
   * The name is quoted in the sentence a person approves. Unchecked, `SPOOF_NAME` made the preview read "as "gmail",
   * pinned to the mailbox work, read-only, """ over an entry that was neither; and a long one pushed what followed
   * past the preview's cut-off. It is checked three times: in the tool's schema, where a client sees the rule; by the
   * change, where every surface's request enters; and by the installer, for any caller that skipped both.
   */
  const m = machine({ inboxes: { 'acme/gmail': inbox() } });
  const refused = (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /a server name is 1 to 64 letters, digits, dots, underscores or hyphens/);
    assert.ok(!error.message.includes('pinned'), 'the name is not repeated back');
    return true;
  };
  for (const name of [SPOOF_NAME, 'a'.repeat(65), '', 'gmail work']) {
    assert.throws(() => serverInstallChange(m.core, m.env, { channel: 'gmail', client: 'cursor', name }), refused);
  }
  serverInstallChange(m.core, m.env, { channel: 'gmail', client: 'cursor', name: `gmail_work-2.${'a'.repeat(51)}` });

  const { client, call, close } = await connect(m);
  try {
    const listed = await client.listTools();
    const schema = listed.tools.find((tool) => tool.name === 'comms_server_install')?.inputSchema as {
      properties: Record<string, { pattern?: string }>;
    };
    assert.equal(schema.properties.name?.pattern, '^[A-Za-z0-9_.-]{1,64}$', 'a client is told the rule');
    const result = await call('comms_server_install', { channel: 'gmail', client: 'cursor', name: SPOOF_NAME });
    assert.equal(result.isError, true);
  } finally {
    await close();
  }

  const command = cli(m, ['mcp', 'install', '--client', 'cursor', '--name', SPOOF_NAME, '--json'], {
    CLAUDECODE: '1',
  });
  assert.equal(command.status, 64, command.stdout);
  assert.equal(command.json().error.code, 'USAGE');
  assert.deepEqual(await m.core.approvals.list(), [], 'nobody was asked about any of them');
  assert.equal(existsSync(join(m.home, '.cursor', 'mcp.json')), false);
});

test('the preview says when a server reaches every mailbox, every tool or every workspace', async () => {
  // The absence of a pin was implied by a pin not being mentioned, which reads the same to a person skimming it.
  const m = machine({ inboxes: { 'acme/gmail': inbox() }, accounts: { 'acme/slack': account() } });
  const config = await m.core.config.load();
  const effects = async (request: Omit<Parameters<typeof serverInstallChange>[2], 'client'>) =>
    (await serverInstallChange(m.core, m.env, { client: 'cursor', launcher: 'npx', ...request }).plan(config))
      .effects ?? [];

  assert.ok(
    (await effects({ channel: 'gmail' })).includes(
      'not pinned: it reaches every mailbox on this machine, with every tool',
    ),
  );
  const readOnly = await effects({ channel: 'gmail', readOnly: true });
  assert.ok(readOnly.includes('not pinned: it reaches every mailbox on this machine'), JSON.stringify(readOnly));
  assert.ok(!readOnly.some((effect) => /every tool/.test(effect)));
  assert.ok(
    (await effects({ channel: 'gmail', inbox: 'acme/gmail' })).includes(
      'not read-only: it has every tool for acme/gmail, including those that change it',
    ),
  );
  const narrow = await effects({ channel: 'gmail', inbox: 'acme/gmail', readOnly: true });
  assert.ok(!narrow.some((effect) => /^not /.test(effect)), JSON.stringify(narrow));

  assert.ok((await effects({ channel: 'slack' })).includes('not pinned: it reaches every workspace on this machine'));
  assert.ok(!(await effects({ channel: 'slack', workspace: 'acme/slack' })).some((effect) => /^not /.test(effect)));
  // The core server reaches no account, so there is nothing to pin and nothing to say.
  assert.ok(!(await effects({ channel: 'core' })).some((effect) => /^not /.test(effect)));
});

test('registering from chat warns about the servers that send with no approval, as the channel’s own command does', async () => {
  // The detectors are the channels' facts in core, so `comms_server_install` — which cannot import a channel package —
  // says what `agent-gmail mcp install` and `agent-slack mcp install` say.
  const m = machine();
  mkdirSync(join(m.home, '.cursor'), { recursive: true });
  writeFileSync(
    join(m.home, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'old-gmail': { command: 'npx', args: ['-y', '@artymclabin/gmail-mcp'] },
        'team-slack': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
      },
    }),
  );
  const { ok, close } = await connect(m);
  try {
    const warnings = async (channel: string) =>
      (
        (await ok('comms_server_install', { channel, client: 'cursor', print: true, noVerify: true })).result as {
          warnings: string[];
        }
      ).warnings;
    const gmail = await warnings('gmail');
    assert.equal(gmail.length, 1, JSON.stringify(gmail));
    assert.match(
      gmail[0] ?? '',
      /@artymclabin\/gmail-mcp is registered with cursor as "old-gmail": .*no approval step gates/,
    );
    const slack = await warnings('slack');
    assert.equal(slack.length, 1, JSON.stringify(slack));
    assert.match(slack[0] ?? '', /"team-slack" in cursor .*can post to Slack with no approval step/);
    assert.deepEqual(await warnings('core'), []);
  } finally {
    await close();
  }
});

// ── Pruning ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A managed runtime for `packageName` at `version`, as the installer leaves one. */
function runtime(m: Machine, packageName: string, version: string): string {
  const dir = managedRuntimeDir(m.core.paths.dataDir, packageName, version);
  mkdirSync(dirname(managedRuntimeEntry(m.core.paths.dataDir, packageName, version)), { recursive: true });
  return dir;
}

const nobodyRuns = async () => [] as string[];

test('comms_server_prune: a dry run is free; removing needs an approval, and removes what it showed', async () => {
  const m = machine();
  const old = runtime(m, '@agentcomms/core', '0.0.1');
  const older = runtime(m, '@agentcomms/core', '0.0.2');
  const current = runtime(m, '@agentcomms/core', VERSION);
  const gmail = runtime(m, '@agentcomms/gmail', '0.0.1');
  const { ok, close } = await connect(m, { processes: nobodyRuns });
  try {
    const dry = await ok('comms_server_prune', { channel: 'core', dryRun: true });
    assert.equal(dry.applied, true);
    const shown = dry.result as {
      removed: { path: string }[];
      kept: { path: string; reason: string }[];
      dryRun: boolean;
    };
    assert.equal(shown.dryRun, true);
    assert.deepEqual(
      shown.removed.map((item) => item.path),
      [old, older],
    );
    assert.deepEqual(
      shown.kept.map((item) => [item.path, item.reason]),
      [[current, 'this release']],
    );
    assert.ok(existsSync(old) && existsSync(older), 'a dry run removes nothing');

    const first = await ok('comms_server_prune', { channel: 'core' });
    assert.equal(first.approvalRequired, true);
    assert.match(String(first.preview), /deletes the unused agentcomms \(core\) runtime 0\.0\.1/);
    assert.match(String(first.preview), /deletes the unused agentcomms \(core\) runtime 0\.0\.2/);
    assert.ok(existsSync(old), 'asking removed nothing');

    const second = await ok('comms_server_prune', { channel: 'core', approvalId: first.approvalId });
    assert.deepEqual(
      (second.result as { removed: { path: string }[] }).removed.map((item) => item.path),
      [old, older],
    );
    assert.ok(!existsSync(old) && !existsSync(older));
    assert.ok(existsSync(current) && existsSync(gmail), 'this release, and another channel’s runtime, stay');

    // Nothing left to remove: nothing to approve.
    const nothing = await ok('comms_server_prune', { channel: 'core' });
    assert.equal(nothing.applied, true);
  } finally {
    await close();
  }
});

test('comms_server_prune removes what was approved, even if another runtime falls out of use meanwhile', async () => {
  // A process is using 0.0.2 while the removal is shown and claimed, and stops before the removal runs. Pruning then
  // would find it unused; it was not on the list the person approved, so it stays.
  const m = machine();
  const shown = runtime(m, '@agentcomms/core', '0.0.1');
  const busy = runtime(m, '@agentcomms/core', '0.0.2');
  let listed = 0;
  const processes = async () => (listed++ < 2 ? [`node ${busy}/node_modules/@agentcomms/core/dist/cli.mjs mcp`] : []);
  const { ok, close } = await connect(m, { processes });
  try {
    const first = await ok('comms_server_prune', { channel: 'core' });
    assert.doesNotMatch(String(first.preview), /0\.0\.2/);
    const done = await ok('comms_server_prune', { channel: 'core', approvalId: first.approvalId });
    const result = done.result as { removed: { path: string }[]; kept: { path: string; reason: string }[] };
    assert.deepEqual(
      result.removed.map((item) => item.path),
      [shown],
    );
    assert.ok(existsSync(busy), 'a runtime nobody was shown is not removed');
  } finally {
    await close();
  }
});

test('a prune removes no more than the list that was approved', async () => {
  // The removal is approved as a list of paths. A runtime that became unused after the list was shown is not on it,
  // and stays until it is shown and approved in turn.
  const m = machine();
  const approved = runtime(m, '@agentcomms/core', '0.0.1');
  const later = runtime(m, '@agentcomms/core', '0.0.2');
  const result = await pruneManagedRuntimes(
    { env: m.env, core: m.core },
    { packageName: '@agentcomms/core', version: VERSION },
    { processes: nobodyRuns, only: [approved] },
  );
  assert.deepEqual(
    result.removed.map((item) => item.path),
    [approved],
  );
  assert.deepEqual(
    result.kept.map((item) => item.path),
    [later],
  );
  assert.match(result.kept[0]?.reason ?? '', /not in the removal that was approved/);
  assert.ok(existsSync(later));
});

test("a channel's own prune keeps its own release, and removes the rest only once approved", async () => {
  // `agent-slack mcp prune` passes its product, so "this release" is the release of the command that was run.
  const m = machine();
  const theirs = runtime(m, '@agentcomms/slack', '0.0.1');
  const own = runtime(m, '@agentcomms/slack', '0.0.2');
  const product = { packageName: '@agentcomms/slack', version: '0.0.2' };
  const request = { channel: 'slack', processes: nobodyRuns } as const;

  const asked = await gatedChange(m.core, serverPruneChange(m.core, m.env, request, product), { surface: 'cli' });
  assert.equal(asked.status, 'approval-required');
  if (asked.status !== 'approval-required') return;
  assert.deepEqual(asked.prepared.effects, [`deletes the unused Slack runtime 0.0.1 at ${theirs}`]);
  assert.ok(existsSync(theirs), 'asking removed nothing');

  const done = await gatedChange(m.core, serverPruneChange(m.core, m.env, request, product), {
    surface: 'cli',
    approvalId: asked.prepared.approvalId,
  });
  assert.equal(done.status, 'applied');
  if (done.status !== 'applied') return;
  assert.deepEqual(
    done.result.kept.map((item) => [item.path, item.reason]),
    [[own, 'this release']],
  );
  assert.ok(!existsSync(theirs) && existsSync(own));
});

test('`agentcomms mcp prune --dry-run` returns what the tool does', async () => {
  const m = machine();
  runtime(m, '@agentcomms/core', '0.0.1');
  const { ok, close } = await connect(m);
  try {
    const tool = await ok('comms_server_prune', { channel: 'core', dryRun: true });
    const command = cli(m, ['mcp', 'prune', '--dry-run', '--json']);
    assert.equal(command.status, 0, command.stderr);
    assert.deepEqual(command.json().data, tool.result);
  } finally {
    await close();
  }
});

// ── Migrations ──────────────────────────────────────────────────────────────────────────────────────────────────

test('comms_names_migrate: a dry run is free, and the approval is for exactly the mapping shown', async () => {
  const m = machine();
  writeFileSync(
    join(m.configDir, 'config.json'),
    JSON.stringify({ version: 1, inboxes: { work: inbox() }, accounts: { live: account() } }),
  );
  const { ok, call, close } = await connect(m);
  try {
    const dry = await ok('comms_names_migrate', { dryRun: true, renames: ['live=cue/slack'] });
    assert.equal(dry.status, 'dry-run');
    assert.deepEqual(
      (dry.rows as { from: string; to: string }[]).map((row) => `${row.from}→${row.to}`),
      ['work→work/gmail', 'live→cue/slack'],
    );
    assert.deepEqual(
      dry,
      cli(m, ['names', 'migrate', '--dry-run', '--rename', 'live=cue/slack', '--json']).json().data,
    );

    const first = await ok('comms_names_migrate', { renames: ['live=cue/slack'] });
    assert.equal(first.approvalRequired, true);
    assert.match(String(first.preview), /renames workspace "live" to "cue\/slack"/);
    // Claimed without the rename the person was shown: a different mapping, refused, and nothing renamed.
    const different = await call('comms_names_migrate', { approvalId: first.approvalId });
    assert.equal(different.isError, true);
    assert.equal((await m.core.config.load()).version, 1);

    const second = await ok('comms_names_migrate', { renames: ['live=cue/slack'] });
    const done = await ok('comms_names_migrate', { renames: ['live=cue/slack'], approvalId: second.approvalId });
    assert.equal((done.result as { status: string }).status, 'migrated');
    const config = await m.core.config.load();
    assert.deepEqual(Object.keys(config.accounts), ['cue/slack']);
  } finally {
    await close();
  }
});

/** An in-memory secret store: a test must never read or write the real keychain. */
function memoryStore(kind: 'keychain' | 'file'): { values: Map<string, string>; store: SecretStore } {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      kind,
      async get(ref: string) {
        return values.get(ref) ?? null;
      },
      async set(ref: string, value: string) {
        values.set(ref, value);
      },
      async delete(ref: string) {
        return values.delete(ref);
      },
      invalidate() {},
    } as SecretStore,
  };
}

test('comms_secrets_migrate: moving real credentials is approved first, in either direction', async () => {
  const m = machine({ secrets: { store: 'file' }, accounts: { 'acme/slack': account() } });
  const file = memoryStore('file');
  const keychain = memoryStore('keychain');
  file.values.set(`slack/token/${ACME}`, 'fake-token-1');
  const { ok, close } = await connect(m, { secretStores: { source: file.store, target: keychain.store } });
  try {
    // Into the keychain tightens how credentials are kept, but the originals are deleted: that cannot be taken back.
    const first = await ok('comms_secrets_migrate', { to: 'keychain' });
    assert.equal(first.approvalRequired, true);
    assert.match(String(first.preview), /It loosens no safety setting/);
    assert.match(
      String(first.preview),
      /copies the 1 credential .* then deletes the originals from files on this disk/,
    );
    assert.equal(keychain.values.size, 0, 'asking moved nothing');

    const done = await ok('comms_secrets_migrate', { to: 'keychain', approvalId: first.approvalId });
    assert.deepEqual(done.result, { from: 'file', to: 'keychain', moved: 1, leftovers: [] });
    assert.equal(keychain.values.get(`slack/token/${ACME}`), 'fake-token-1');
    assert.equal(file.values.size, 0);
    assert.ok(!JSON.stringify(done).includes('fake-token-1'), 'no credential is ever returned');
  } finally {
    await close();
  }
});

test('comms_secrets_migrate on a configuration that holds no credential chooses the backend at once', async () => {
  // Setup, not a loosening: nothing is stored to move, and `ConfigStore.update` judges it the same way.
  const m = machine();
  const { ok, close } = await connect(m, {
    secretStores: { source: memoryStore('keychain').store, target: memoryStore('file').store },
  });
  try {
    const done = await ok('comms_secrets_migrate', { to: 'file' });
    assert.equal(done.applied, true);
    assert.equal((await m.core.config.load()).secrets?.store, 'file');
  } finally {
    await close();
  }
});

// ── What is available ───────────────────────────────────────────────────────────────────────────────────────────

test('comms_channels_available says what is installed and where each server is registered, and is `agentcomms channels`', async () => {
  const m = machine();
  // Gmail: a managed runtime, registered with Claude Code pinned to one mailbox; its entry file has since gone.
  runtime(m, '@agentcomms/gmail', '0.0.9');
  const gmailEntry = managedRuntimeEntry(m.core.paths.dataDir, '@agentcomms/gmail', '0.0.9');
  // Slack: the command on PATH, from a package whose manifest says which version it is.
  const pkg = join(m.home, 'global', 'node_modules', '@agentcomms', 'slack');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@agentcomms/slack', version: '9.9.9' }));
  writeFileSync(join(pkg, 'dist', 'cli.mjs'), '#!/usr/bin/env node\n');
  chmodSync(join(pkg, 'dist', 'cli.mjs'), 0o755);
  if (process.platform !== 'win32') symlinkSync(join(pkg, 'dist', 'cli.mjs'), join(m.bin, 'agent-slack'));
  writeFileSync(
    join(m.home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        gmail: {
          command: 'node',
          args: [gmailEntry, 'mcp', '--inbox', 'acme/gmail'],
          env: { AGENT_COMMS_CONFIG_DIR: m.configDir },
        },
        // Somebody else's: not ours, not listed, and its token is never repeated.
        slack: { command: 'npx', args: ['-y', 'some-other-slack'], env: { SLACK_BOT_TOKEN: 'fake-token-2' } },
      },
    }),
  );
  const { ok, close } = await connect(m);
  try {
    const report = await ok('comms_channels_available');
    assert.equal(report.core, VERSION);
    const [core, gmail, slack] = report.channels as Record<string, unknown>[];
    assert.equal(core?.channel, 'core');
    assert.equal(core?.installed, true, 'the core is answering');
    assert.equal(gmail?.installed, true);
    assert.deepEqual(gmail?.runtimes, [
      { version: '0.0.9', path: managedRuntimeDir(m.core.paths.dataDir, '@agentcomms/gmail', '0.0.9') },
    ]);
    assert.deepEqual(gmail?.registered, [
      {
        client: 'claude-code',
        name: 'gmail',
        scope: 'user',
        path: join(m.home, '.claude.json'),
        launcher: 'managed',
        version: '0.0.9',
        narrowing: ['--inbox', 'acme/gmail'],
        missing: gmailEntry,
      },
    ]);
    if (process.platform !== 'win32') {
      assert.deepEqual(slack?.onPath, { path: join(m.bin, 'agent-slack'), version: '9.9.9' });
      assert.equal(slack?.installed, true);
    }
    assert.deepEqual(slack?.registered, [], 'somebody else’s "slack" is not ours');
    assert.ok(!JSON.stringify(report).includes('fake-token-2'));
    assert.ok(!JSON.stringify(report).includes('AGENT_COMMS_CONFIG_DIR'), 'no entry’s env is returned');

    const command = cli(m, ['channels', '--json']);
    assert.equal(command.status, 0, command.stderr);
    // The command sees node's directory on PATH as well, where a global install could put a channel's command; the
    // rest of the report is the tool's.
    const data = command.json().data;
    for (const channel of data.channels) delete channel.onPath;
    for (const channel of report.channels as Record<string, unknown>[]) delete channel.onPath;
    for (const channel of [...data.channels, ...(report.channels as Record<string, unknown>[])])
      delete channel.installed;
    assert.deepEqual(data, report);
  } finally {
    await close();
  }
});
