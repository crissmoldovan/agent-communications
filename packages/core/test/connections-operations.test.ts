import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type GatedOutcome, gatedChange } from '../src/change-flow.ts';
import { connectionKeyMatches, readConnections } from '../src/connections.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import {
  type ConnectionAddResult,
  type ConnectionChangeResult,
  type ConnectionPartRequest,
  type ConnectionPartResult,
  connectionAddChange,
  connectionChangeChange,
  connectionKeyReplaceChange,
  connectionList,
  connectionPartChange,
  connectionRemoveChange,
  connectionRenameChange,
  connectionShow,
  parsePartsSpec,
} from '../src/operations/connections.ts';
import { VERSION } from '../src/version.ts';
import { fakeClaude } from './helpers/gateway/fake-claude.ts';
import { runMain } from './helpers/main-in-process.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * MCP connections as the person makes them (single-server design §6, §8.1, §10): `connection add|list|show|change|
 * rename|key replace|remove` and their tools. Each test has a temporary home, its own `claude` — a stand-in script
 * that keeps its servers in the home's `.claude.json` — and parts run from this checkout's source (`--launcher
 * local`), so nothing real is read, written or started, and nothing is fetched.
 */

const NOT_ON_WINDOWS = process.platform === 'win32' ? { skip: 'the stand-in `claude` is a POSIX script' } : {};

interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
  claudeJson: string;
  log: string;
}

function machine(): Machine {
  const home = tempDir('comms-connections-ops-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  mkdirSync(join(home, 'bin'));
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`,
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_SECRETS_DIR: join(home, 'secrets'),
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  const claudeJson = join(home, '.claude.json');
  const log = join(home, 'claude-calls.jsonl');
  fakeClaude(join(home, 'bin'), claudeJson, log);
  return { home, env, core: openCore({ env, caller: CORE_CALLER }), claudeJson, log };
}

async function twice<T>(m: Machine, build: () => ReturnType<typeof connectionAddChange> | never): Promise<T> {
  const first = (await gatedChange(m.core, build() as never, { surface: 'cli', channel: 'core' })) as GatedOutcome<T>;
  if (first.status === 'applied') return first.result;
  // Under `chat`, the person's yes in the conversation is the approval: the same call again, with its id.
  const second = (await gatedChange(m.core, build() as never, {
    surface: 'cli',
    channel: 'core',
    approvalId: first.prepared.approvalId,
  })) as GatedOutcome<T>;
  assert.equal(second.status, 'applied');
  return (second as { result: T }).result;
}

const claudeServers = (m: Machine) =>
  (
    JSON.parse(readFileSync(m.claudeJson, 'utf8')) as {
      mcpServers?: Record<string, { args: string[]; env: Record<string, string> }>;
    }
  ).mcpServers ?? {};

function auditText(m: Machine): string {
  const dir = join(m.env.AGENT_COMMS_STATE_DIR as string, 'audit');
  try {
    return readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('');
  } catch {
    return '';
  }
}

test(
  'connection add: a loosening, approved, that writes one entry carrying the key, and a record holding only its hash',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const request = {
      app: 'claude-code' as const,
      name: 'Work — Claude Code',
      parts: parsePartsSpec('core'),
      launcher: 'local' as const,
    };
    const first = await gatedChange(m.core, connectionAddChange(m.core, m.env, request, 'cli'), {
      surface: 'cli',
      channel: 'core',
    });
    assert.equal(first.status, 'approval-required', 'adding a connection waits for the person');
    if (first.status !== 'approval-required') return;
    assert.deepEqual(
      first.prepared.loosened.map((change) => change.path),
      ['connections["Work — Claude Code"]'],
    );
    assert.match(first.prepared.preview, /Agent Comms itself/);
    assert.ok(
      first.prepared.effects.some((effect) =>
        /registers the connection "Work — Claude Code" with claude-code as "agentcomms": one entry that starts Agent Comms with its parts, its key in the entry's environment/.test(
          effect,
        ),
      ),
      first.prepared.effects.join('\n'),
    );
    // Nothing was written while it waited.
    assert.deepEqual(readConnections(await m.core.config.load()).connections, []);
    const applied = (await gatedChange(m.core, connectionAddChange(m.core, m.env, request, 'cli'), {
      surface: 'cli',
      channel: 'core',
      approvalId: first.prepared.approvalId,
    })) as GatedOutcome<ConnectionAddResult>;
    assert.equal(applied.status, 'applied');
    const result = (applied as { result: ConnectionAddResult }).result;
    // The entry started — a real gateway, in front of core run from this checkout — and answered.
    assert.equal(result.verification, 'passed', result.verifyDetail);
    const [read] = readConnections(await m.core.config.load()).connections;
    assert.ok(read?.readable);
    const entry = claudeServers(m).agentcomms;
    assert.ok(entry, 'one entry, called agentcomms');
    assert.deepEqual(entry.args.slice(-3), ['mcp', '--connection', read.record.id]);
    const key = entry.env.AGENT_COMMS_CONNECTION_KEY;
    assert.ok(connectionKeyMatches(key, read.record.keyHash), 'the entry carries the key whose hash the record keeps');
    assert.equal(
      entry.args.some((arg) => arg.startsWith('ack_')),
      false,
      'never in its arguments',
    );
    // The key is in no result, the configuration, the audit or the claude command's own argv beyond its one add.
    assert.equal(JSON.stringify(result).includes(key as string), false);
    assert.equal(
      readFileSync(join(m.env.AGENT_COMMS_CONFIG_DIR as string, 'config.json'), 'utf8').includes(key as string),
      false,
    );
    assert.match(auditText(m), /"operation":"connection.add".*"connection":"cn_/);
    assert.equal(auditText(m).includes(key as string), false);
    assert.equal(result.connection.entry?.present, true);
    assert.equal(result.connection.entry?.keyMatches, true);
    assert.match(result.next, /Restart Claude Code to use the connection/);
  },
);

test(
  'list, show, change, rename, key replace and remove: what narrows or names applies at once; what reaches more waits',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const added = await twice<ConnectionAddResult>(m, () =>
      connectionAddChange(
        m.core,
        m.env,
        { app: 'claude-code', name: 'Work', parts: parsePartsSpec('core,events'), launcher: 'local', noVerify: true },
        'cli',
      ),
    );
    const id = added.connection.id;
    const listed = await connectionList(m.core, m.env);
    assert.deepEqual(
      listed.connections.map((view) => [
        view.name,
        view.app,
        view.parts.map((part) => part.server),
        view.entry?.keyMatches,
      ]),
      [['Work', 'claude-code', ['core', 'events'], true]],
    );
    assert.equal(JSON.stringify(listed).includes('ack_'), false, 'no key in a listing');
    assert.equal(JSON.stringify(listed).includes('sha256:'), false, 'nor its hash');
    // Taking Events away applies at once.
    const narrowed = await gatedChange(
      m.core,
      connectionChangeChange(m.core, m.env, { id, parts: parsePartsSpec('core') }, 'cli'),
      { surface: 'cli', channel: 'core' },
    );
    assert.equal(narrowed.status, 'applied');
    assert.deepEqual(
      (await connectionShow(m.core, m.env, { id })).parts.map((part) => part.server),
      ['core'],
    );
    // Giving it back waits.
    const widened = await gatedChange(
      m.core,
      connectionChangeChange(m.core, m.env, { id, parts: parsePartsSpec('core,events') }, 'cli'),
      { surface: 'cli', channel: 'core' },
    );
    assert.equal(widened.status, 'approval-required');
    if (widened.status === 'approval-required') {
      assert.deepEqual(
        widened.prepared.loosened.map((change) => change.path),
        ['connections["Work"].parts.events'],
      );
    }
    // Renaming applies at once, and is audited.
    const renamed = await gatedChange(m.core, connectionRenameChange(m.core, m.env, { id, name: 'Acme' }, 'cli'), {
      surface: 'cli',
      channel: 'core',
    });
    assert.equal(renamed.status, 'applied');
    assert.equal((await connectionShow(m.core, m.env, { id })).name, 'Acme');
    // A new key: written into the entry, the old one no longer the record's.
    const oldKey = claudeServers(m).agentcomms?.env.AGENT_COMMS_CONNECTION_KEY;
    const keyed = await gatedChange(m.core, connectionKeyReplaceChange(m.core, m.env, { id }, 'cli'), {
      surface: 'cli',
      channel: 'core',
    });
    assert.equal(keyed.status, 'applied');
    const newKey = claudeServers(m).agentcomms?.env.AGENT_COMMS_CONNECTION_KEY;
    assert.notEqual(newKey, oldKey);
    const [held] = readConnections(await m.core.config.load()).connections;
    assert.ok(held?.readable);
    assert.equal(connectionKeyMatches(oldKey, held.record.keyHash), false, 'the old key stopped working');
    assert.equal(connectionKeyMatches(newKey, held.record.keyHash), true);
    assert.equal(JSON.stringify(keyed).includes(newKey as string), false, 'the new key is in no result');
    // Removing it: its entry out of the app, its record gone, so no copy of its key works.
    const removed = await gatedChange(m.core, connectionRemoveChange(m.core, m.env, { id }, 'cli'), {
      surface: 'cli',
      channel: 'core',
    });
    assert.equal(removed.status, 'applied');
    assert.deepEqual(Object.keys(claudeServers(m)), []);
    assert.deepEqual(readConnections(await m.core.config.load()).connections, []);
    for (const operation of ['connection.update', 'connection.rename', 'connection.rotate', 'connection.remove']) {
      assert.match(auditText(m), new RegExp(`"operation":"${operation}"`));
    }
  },
);

test(
  'one project (Claude Code, local scope): its entry is written in that folder, never a .mcp.json',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const project = join(m.home, 'work', 'acme');
    mkdirSync(project, { recursive: true });
    const added = await twice<ConnectionAddResult>(m, () =>
      connectionAddChange(
        m.core,
        m.env,
        {
          app: 'claude-code',
          name: 'Acme site',
          parts: parsePartsSpec('core'),
          folder: project,
          launcher: 'local',
          noVerify: true,
        },
        'cli',
      ),
    );
    const calls = readFileSync(m.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
    const add = calls.find((call) => call.argv[1] === 'add-json');
    assert.deepEqual(add?.argv.slice(-2), ['--scope', 'local']);
    assert.equal(readdirSync(project).includes('.mcp.json'), false);
    assert.equal(added.connection.where?.scope, 'local');
    assert.match(added.next, /Open .*acme in Claude Code/);
    assert.equal(added.connection.entry?.present, true, 'found again under its project');
  },
);

test('a second connection where `agentcomms` is taken gets an entry name of its own', NOT_ON_WINDOWS, async () => {
  const m = machine();
  for (const name of ['Work', 'Personal profile']) {
    await twice(m, () =>
      connectionAddChange(
        m.core,
        m.env,
        { app: 'claude-code', name, parts: parsePartsSpec('core'), launcher: 'local', noVerify: true },
        'cli',
      ),
    );
  }
  assert.deepEqual(Object.keys(claudeServers(m)).sort(), ['agentcomms', 'agentcomms-personal-profile']);
  // And a name already taken is refused, ignoring case.
  await assert.rejects(
    gatedChange(m.core, connectionAddChange(m.core, m.env, { app: 'claude-code', name: 'work', parts: [] }, 'cli'), {
      surface: 'cli',
      channel: 'core',
    }),
    /you have a connection called "work" already/,
  );
});

test(
  '§8.1 over MCP: a connection is listed and prepared, never with its key; Manual is the person’s alone',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null, platform: 'darwin' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
    try {
      const call = async (name: string, args: Record<string, unknown>) =>
        (await client.callTool({ name, arguments: args })) as {
          isError?: boolean;
          structuredContent: Record<string, unknown>;
        };
      const prepared = await call('comms_connection_add', {
        app: 'claude-code',
        name: 'From chat',
        parts: [{ server: 'core' }],
        launcher: 'local',
      });
      assert.equal(prepared.structuredContent.approvalRequired, true, JSON.stringify(prepared.structuredContent));
      const applied = await call('comms_connection_add', {
        app: 'claude-code',
        name: 'From chat',
        parts: [{ server: 'core' }],
        launcher: 'local',
        approvalId: prepared.structuredContent.approvalId,
      });
      assert.equal(applied.structuredContent.applied, true, JSON.stringify(applied.structuredContent));
      const key = claudeServers(m).agentcomms?.env.AGENT_COMMS_CONNECTION_KEY as string;
      assert.ok(key.startsWith('ack_'));
      assert.equal(JSON.stringify(applied).includes(key), false, 'never in a tool result');
      const manual = await call('comms_connection_add', { app: 'manual', name: 'Raycast' });
      assert.equal(manual.isError, true, 'manual is no app the tool takes');
      const id = (applied.structuredContent.result as { connection: { id: string } }).connection.id;
      const shown = await call('comms_connection_show', { id });
      assert.equal((shown.structuredContent as { name: string }).name, 'From chat');
      assert.equal(JSON.stringify(shown).includes(key), false);
      const listed = await call('comms_connections_list', {});
      assert.equal(JSON.stringify(listed).includes(key), false);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  },
);

test('§8.1 at a terminal: a Manual connection’s snippet, with its key, is shown to the person once — and refused to an agent', async () => {
  const m = machine();
  const words = [
    'connection',
    'add',
    '--app',
    'manual',
    '--name',
    'Raycast',
    '--parts',
    'core',
    '--launcher',
    'local',
    '--json',
  ];
  const agent = await runMain(words, { ...m.env, CLAUDECODE: '1' }, 'darwin');
  assert.equal(agent.code, 10, agent.stdout + agent.stderr);
  assert.match(agent.stdout, /a Manual connection's key is shown only to the person, not to an agent/);
  assert.deepEqual(readConnections(await m.core.config.load()).connections, []);
  // Not a terminal: the preview and an approval, as every change; then the person's yes, carried with --approval.
  const asked = await runMain(words, m.env, 'darwin');
  assert.equal(asked.code, 10, asked.stdout);
  const approvalId = (asked.json().error as { details: { approvalId: string } }).details.approvalId;
  const added = await runMain([...words, '--approval', approvalId], m.env, 'darwin');
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const result = (added.json() as { data: ConnectionAddResult }).data;
  const snippet = JSON.parse(result.snippets?.json ?? '{}') as {
    mcpServers: { agentcomms: { args: string[]; env: Record<string, string> } };
  };
  const [read] = readConnections(await m.core.config.load()).connections;
  assert.ok(read?.readable);
  assert.ok(connectionKeyMatches(snippet.mcpServers.agentcomms.env.AGENT_COMMS_CONNECTION_KEY, read.record.keyHash));
  assert.deepEqual(snippet.mcpServers.agentcomms.args.slice(-3), ['mcp', '--connection', read.record.id]);
  assert.match(result.snippets?.toml ?? '', /\[mcp_servers\.agentcomms\.env\]/);
  assert.match(result.next, /This is the only time the key is shown/);
});

test('§8.1: --app-approval covers connection add and change, and is refused inside an MCP server’s process and to an agent', async () => {
  const m = machine();
  const words = ['connection', 'add', '--app', 'claude-code', '--name', 'From the app', '--parts', 'core', '--json'];
  const fake = 'ap_00000000000000000000000000';
  const inServer = await runMain(
    [...words, '--app-approval', fake],
    { ...m.env, AGENTCOMMS_MCP_SERVER: 'gateway' },
    'darwin',
  );
  assert.equal(inServer.code, 10, inServer.stdout);
  assert.match(inServer.stdout, /an MCP server's process is not the app/);
  const agent = await runMain([...words, '--app-approval', fake], { ...m.env, CLAUDECODE: '1' }, 'darwin');
  assert.equal(agent.code, 10, agent.stdout);
  assert.match(agent.stdout, /only a person can approve a change in the app, not an agent/);
  // Nothing attests the app here: refused, and said where to approve it instead.
  const unattested = await runMain([...words, '--app-approval', fake], m.env, 'linux', {
    appOrigin: async () => ({ ok: false, reason: 'unattested-platform' }) as never,
  });
  assert.equal(unattested.code, 10, unattested.stdout);
  assert.match(unattested.stdout, /ORIGIN_UNATTESTED/);
  // Commands with no approval take none from the app either.
  const rename = await runMain(
    ['connection', 'rename', 'cn_0123456789ABCDEFGHJKMNPQRS', 'X', '--app-approval', fake, '--json'],
    m.env,
    'darwin',
  );
  assert.equal(rename.code, 64);
  assert.deepEqual(readConnections(await m.core.config.load()).connections, []);
});

test('D11 (§7): an audit line written inside a part of a connection names the connection, by id', async () => {
  const m = machine();
  const before = process.env.AGENTCOMMS_CONNECTION;
  process.env.AGENTCOMMS_CONNECTION = 'cn_0123456789ABCDEFGHJKMNPQRS';
  try {
    await m.core.audit.append({ inboxId: 'ibx_AAAAAAAAAAAAAAAA', operation: 'send.execute', outcome: 'ok' });
  } finally {
    if (before === undefined) delete process.env.AGENTCOMMS_CONNECTION;
    else process.env.AGENTCOMMS_CONNECTION = before;
  }
  await m.core.audit.append({ inboxId: 'ibx_AAAAAAAAAAAAAAAA', operation: 'send.execute', outcome: 'ok' });
  const lines = auditText(m)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { connection?: string });
  assert.deepEqual(
    lines.map((line) => line.connection ?? null),
    ['cn_0123456789ABCDEFGHJKMNPQRS', null],
  );
});

test(
  'connection change: what narrows at once is bound into the waiting preview, marked done, and said again by the result and the audit',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const added = await twice<ConnectionAddResult>(m, () =>
      connectionAddChange(
        m.core,
        m.env,
        { app: 'claude-code', name: 'Work', parts: parsePartsSpec('core,events'), launcher: 'local', noVerify: true },
        'cli',
      ),
    );
    const id = added.connection.id;
    // Events out — at once — and Gmail in, which waits: one call, from a chat, where each call builds the change afresh.
    const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null, platform: 'darwin' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
    const call = async (args: Record<string, unknown>) =>
      (
        (await client.callTool({ name: 'comms_connection_change', arguments: args })) as {
          structuredContent: Record<string, unknown>;
        }
      ).structuredContent;
    const asked = await call({ id, parts: [{ server: 'core' }, { server: 'gmail' }] });
    assert.equal(asked.approvalRequired, true, JSON.stringify(asked));
    const first = { prepared: asked as unknown as { approvalId: string; preview: string } };
    assert.deepEqual(
      (await connectionShow(m.core, m.env, { id })).parts.map((part) => part.server),
      ['core'],
      'Events was taken out before anything waited',
    );
    const { preview } = first.prepared;
    assert.match(
      preview,
      /what is marked done at once is done already; the rest has not been changed, and approving changes only the rest/,
    );
    assert.match(preview, /Let agents in "Work" reach more; what narrows was applied at once/);
    assert.match(preview, /Done already, at once, as this was prepared:\n {2}- Events taken out/);
    const stored = await m.core.approvals.get(first.prepared.approvalId);
    assert.deepEqual(stored?.form === 'v2' ? stored.record.change?.doneAtOnce : null, ['Events taken out'], 'bound');
    // The person's yes: the same call again, built afresh, with the approval id — the record narrowed already.
    const claimed = await call({
      id,
      parts: [{ server: 'core' }, { server: 'gmail' }],
      approvalId: first.prepared.approvalId,
    });
    await Promise.all([client.close(), server.close()]);
    assert.equal(claimed.applied, true, JSON.stringify(claimed));
    const result = claimed.result as ConnectionChangeResult;
    assert.deepEqual(result.appliedAtOnce, ['Events taken out'], 'the result says what the preparation did at once');
    assert.deepEqual(
      result.connection.parts.map((part) => part.server),
      ['core', 'gmail'],
    );
    const lines = auditText(m)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { operation: string; reason?: string })
      .filter((line) => line.operation === 'connection.update');
    assert.deepEqual(
      lines.map((line) => line.reason),
      [
        'narrowed at once: Events taken out',
        'parts: core, gmail; narrowed at once as this was prepared: Events taken out',
      ],
    );
  },
);

test(
  'connection change at a terminal: the narrowing done as the person was asked is in the preview they read, and the claim binds the same',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const added = await twice<ConnectionAddResult>(m, () =>
      connectionAddChange(
        m.core,
        m.env,
        { app: 'claude-code', name: 'Work', parts: parsePartsSpec('core,events'), launcher: 'local', noVerify: true },
        'cli',
      ),
    );
    const id = added.connection.id;
    // Not a terminal: the preview and the approval id, exit 10; the narrowing done already.
    const words = ['connection', 'change', id, '--parts', 'core,gmail', '--json'];
    const asked = await runMain(words, m.env, 'darwin');
    assert.equal(asked.code, 10, asked.stdout);
    const details = (asked.json().error as { details: { approvalId: string; preview: string } }).details;
    assert.match(details.preview, /Done already, at once, as this was prepared:\n {2}- Events taken out/);
    // The approval carried back: the claim, in a process of its own, plans from a record narrowed already.
    const applied = await runMain([...words, '--approval', details.approvalId], m.env, 'darwin');
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    const data = (applied.json() as { data: ConnectionChangeResult }).data;
    assert.deepEqual(data.appliedAtOnce, ['Events taken out']);
    assert.deepEqual(
      data.connection.parts.map((part) => part.server),
      ['core', 'gmail'],
    );
  },
);

// ── D17: a channel's own `mcp install` puts that channel into the app's connection ──────────────────────────────

/** A mailbox here, `cue/gmail`, written into `config.json` before anything else is. */
function withMailbox(m: Machine): void {
  writeFileSync(
    join(m.env.AGENT_COMMS_CONFIG_DIR as string, 'config.json'),
    `${JSON.stringify({
      version: 2,
      inboxes: {
        'cue/gmail': {
          id: 'ibx_AAAAAAAAAAAAAAAA',
          provider: 'gmail',
          email: 'jo@example.test',
          identity: 'oidc',
          client: 'desktop',
          tier: 'read',
          contacts: false,
          grantedScopes: [],
          secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
          internalDomains: ['example.test'],
          createdAt: '2026-10-27T09:00:00.000Z',
        },
      },
    })}\n`,
  );
}

const part = (m: Machine, request: Omit<ConnectionPartRequest, 'app'> & { app?: string }, deps = {}) =>
  connectionPartChange(
    m.core,
    m.env,
    { app: 'claude-code', launcher: 'local', noVerify: true, ...request },
    'cli',
    deps,
  );

async function addConnection(m: Machine, name: string, parts: string, extra: Record<string, unknown> = {}) {
  return twice<ConnectionAddResult>(m, () =>
    connectionAddChange(
      m.core,
      m.env,
      { app: 'claude-code', name, parts: parsePartsSpec(parts), launcher: 'local', noVerify: true, ...extra },
      'cli',
    ),
  );
}

test(
  "D17: a channel's mcp install where the app has no connection makes one, with Agent Comms itself and that channel",
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const first = await gatedChange(m.core, part(m, { server: 'gmail' }), { surface: 'cli', channel: 'gmail' });
    assert.equal(first.status, 'approval-required', 'making a connection is a loosening the person approves');
    if (first.status !== 'approval-required') return;
    // The preview names the connection it makes, and every part it reaches.
    assert.match(first.prepared.preview, /Add the connection "Claude Code" for Claude Code/);
    assert.deepEqual(
      first.prepared.loosened.map((change) => [change.path, change.after]),
      [['connections["Claude Code"]', 'Claude Code (claude-code): Agent Comms itself; Gmail, every mailbox']],
    );
    assert.deepEqual(readConnections(await m.core.config.load()).connections, [], 'nothing written while it waits');
    const done = (await gatedChange(m.core, part(m, { server: 'gmail' }), {
      surface: 'cli',
      channel: 'gmail',
      approvalId: first.prepared.approvalId,
    })) as GatedOutcome<ConnectionPartResult>;
    assert.equal(done.status, 'applied');
    const result = (done as { result: ConnectionPartResult }).result;
    assert.equal(result.created, true);
    assert.deepEqual(
      result.connection.parts.map((each) => each.server),
      ['core', 'gmail'],
    );
    const entry = claudeServers(m).agentcomms;
    assert.deepEqual(entry?.args.slice(-3), ['mcp', '--connection', result.connection.id], 'one entry, the gateway');
    assert.match(result.next, /Restart Claude Code/);
  },
);

test(
  'D17: where the app has one connection, the channel goes into it — a part added, approved, the preview naming the connection',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const work = await addConnection(m, 'Work', 'core');
    const entries = JSON.stringify(claudeServers(m));
    const first = await gatedChange(m.core, part(m, { server: 'slack' }), { surface: 'cli', channel: 'slack' });
    assert.equal(first.status, 'approval-required');
    if (first.status !== 'approval-required') return;
    assert.match(first.prepared.preview, /Let agents in "Work" reach more/);
    assert.deepEqual(
      first.prepared.loosened.map((change) => [change.path, change.after]),
      [['connections["Work"].parts.slack', 'Slack, every workspace']],
    );
    const done = (await gatedChange(m.core, part(m, { server: 'slack' }), {
      surface: 'cli',
      channel: 'slack',
      approvalId: first.prepared.approvalId,
    })) as GatedOutcome<ConnectionPartResult>;
    const result = (done as { result: ConnectionPartResult }).result;
    assert.equal(result.created, false);
    assert.equal(result.connection.id, work.connection.id);
    assert.deepEqual(
      result.connection.parts.map((each) => each.server),
      ['core', 'slack'],
    );
    assert.equal(JSON.stringify(claudeServers(m)), entries, 'no entry of its own, and the connection’s untouched');
    // Asked again as it is: nothing to approve, nothing changed, and said so.
    const again = (await gatedChange(m.core, part(m, { server: 'slack' }), {
      surface: 'cli',
      channel: 'slack',
    })) as GatedOutcome<ConnectionPartResult>;
    assert.equal(again.status, 'applied');
    const same = (again as { result: ConnectionPartResult }).result;
    assert.equal(same.changed, false);
    assert.equal(same.next, 'Slack is a part of "Work" already, as asked: nothing was changed.');
    // A connection that is there keeps how it starts its parts.
    await assert.rejects(
      gatedChange(m.core, part(m, { server: 'events', launcher: 'npx' }), { surface: 'cli', channel: 'core' }),
      /"Work" starts its parts with local, and a part is started as the others are: nothing was changed/,
    );
  },
);

test(
  'D17: an account asked for narrows the part at once; letting it go, or read-only off, waits',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    withMailbox(m);
    await addConnection(m, 'Work', 'core,gmail');
    const pinned = (await gatedChange(m.core, part(m, { server: 'gmail', account: 'cue/gmail', readOnly: true }), {
      surface: 'cli',
      channel: 'gmail',
    })) as GatedOutcome<ConnectionPartResult>;
    assert.equal(pinned.status, 'applied', 'kept to one mailbox, read-only: it only narrows');
    assert.deepEqual((pinned as { result: ConnectionPartResult }).result.appliedAtOnce, [
      'Gmail kept to cue/gmail',
      'Gmail read-only',
    ]);
    const freed = await gatedChange(m.core, part(m, { server: 'gmail' }), { surface: 'cli', channel: 'gmail' });
    assert.equal(freed.status, 'approval-required');
    if (freed.status === 'approval-required') {
      assert.deepEqual(
        freed.prepared.loosened.map((change) => [change.path, change.before, change.after]),
        [
          ['connections["Work"].parts.gmail.pin', 'cue/gmail', 'every mailbox'],
          ['connections["Work"].parts.gmail.readOnly', true, false],
        ],
      );
    }
  },
);

test(
  'D17: an app with several connections for every folder gets the part in none, each named by its id, until one is named',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const work = await addConnection(m, 'Work', 'core');
    const personal = await addConnection(m, 'Personal', 'core');
    const before = readFileSync(join(m.env.AGENT_COMMS_CONFIG_DIR as string, 'config.json'), 'utf8');
    await assert.rejects(
      gatedChange(m.core, part(m, { server: 'slack' }), { surface: 'cli', channel: 'slack' }),
      (error: Error & { hint?: string }) => {
        assert.match(
          error.message,
          /Claude Code has 2 connections for every folder, so Slack was put into none: say which/,
        );
        assert.ok(error.hint?.includes(`${work.connection.id} ("Work")`), error.hint);
        assert.ok(error.hint?.includes(`${personal.connection.id} ("Personal")`), error.hint);
        return true;
      },
    );
    assert.equal(readFileSync(join(m.env.AGENT_COMMS_CONFIG_DIR as string, 'config.json'), 'utf8'), before);
    const named = await gatedChange(m.core, part(m, { server: 'slack', id: personal.connection.id }), {
      surface: 'cli',
      channel: 'slack',
    });
    assert.equal(named.status, 'approval-required');
    if (named.status === 'approval-required')
      assert.match(named.prepared.preview, /Let agents in "Personal" reach more/);
  },
);

test(
  'D17: a connection for one project is not the app’s for every folder: one is made, under a name of its own',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const project = join(m.home, 'work', 'acme');
    mkdirSync(project, { recursive: true });
    await addConnection(m, 'Claude Code', 'core', { folder: project });
    const made = await gatedChange(m.core, part(m, { server: 'gmail' }), { surface: 'cli', channel: 'gmail' });
    assert.equal(made.status, 'approval-required');
    if (made.status === 'approval-required') {
      assert.match(made.prepared.preview, /Add the connection "Claude Code 2" for Claude Code/);
    }
  },
);

test(
  'D17: an entry of the channel’s own in the app is named in the preview — the agent would see its tools twice',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    writeFileSync(
      m.claudeJson,
      JSON.stringify({
        mcpServers: { gmail: { command: 'npx', args: ['-y', '@agentcomms/gmail@0.34.0', 'mcp'] } },
      }),
    );
    const first = await gatedChange(m.core, part(m, { server: 'gmail' }), { surface: 'cli', channel: 'gmail' });
    assert.equal(first.status, 'approval-required');
    if (first.status !== 'approval-required') return;
    assert.ok(
      first.prepared.effects.includes(
        'Claude Code reaches Gmail through its own entry "gmail" already: as a part of the connection too, the agent sees the same tools twice — connection migrate moves that entry into the connection',
      ),
      first.prepared.effects.join('\n'),
    );
  },
);

test(
  "D17: a channel's own process, which cannot verify a release, makes no managed connection whose Agent Comms runtime is not here",
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const own = { running: { packageName: '@agentcomms/gmail', version: VERSION } };
    await assert.rejects(
      gatedChange(m.core, connectionPartChange(m.core, m.env, { app: 'claude-code', server: 'gmail' }, 'cli', own), {
        surface: 'cli',
        channel: 'gmail',
      }),
      (error: Error & { hint?: string }) => {
        assert.match(error.message, /nothing was installed or changed: @agentcomms\/core@.* could not be verified/);
        assert.match(error.hint ?? '', /connection add --app claude-code --name .*Claude Code.* --parts core,gmail/);
        return true;
      },
    );
    assert.deepEqual(readConnections(await m.core.config.load()).connections, []);
    assert.equal(existsSync(join(m.env.AGENT_COMMS_STATE_DIR as string, 'approvals')), false, 'nothing prepared');
  },
);

test(
  'D17 over MCP: comms_connection_change with `add` and `app` puts the part in, approved; `add` beside `parts`, or without `app`, is refused',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const work = await addConnection(m, 'Work', 'core');
    const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null, platform: 'darwin' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
    try {
      const call = async (args: Record<string, unknown>) =>
        (await client.callTool({ name: 'comms_connection_change', arguments: args })) as {
          isError?: boolean;
          structuredContent: Record<string, unknown>;
        };
      const asked = await call({ app: 'claude-code', add: { server: 'slack' } });
      assert.equal(asked.structuredContent.approvalRequired, true, JSON.stringify(asked.structuredContent));
      assert.match(String(asked.structuredContent.preview), /Let agents in "Work" reach more/);
      const done = await call({
        app: 'claude-code',
        add: { server: 'slack' },
        approvalId: asked.structuredContent.approvalId,
      });
      assert.equal(done.structuredContent.applied, true, JSON.stringify(done.structuredContent));
      assert.deepEqual(
        (done.structuredContent.result as ConnectionPartResult).connection.parts.map((each) => each.server),
        ['core', 'slack'],
      );
      const both = await call({ id: work.connection.id, parts: [{ server: 'core' }], add: { server: 'slack' } });
      assert.equal(both.isError, true);
      assert.match(JSON.stringify(both.structuredContent), /`add` puts one part in, and `parts` says every part/);
      const noApp = await call({ add: { server: 'slack' } });
      assert.equal(noApp.isError, true);
      assert.match(JSON.stringify(noApp.structuredContent), /give `app`/);
      const neither = await call({ id: work.connection.id });
      assert.equal(neither.isError, true);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  },
);
