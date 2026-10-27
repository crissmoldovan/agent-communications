import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type GatedOutcome, gatedChange } from '../src/change-flow.ts';
import {
  type ConnectionRecord,
  connectionKeyHash,
  connectionKeyMatches,
  newConnectionId,
  newConnectionKey,
  readConnections,
  withConnection,
} from '../src/connections.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { launcherPaths } from '../src/launcher.ts';
import {
  connectionMigrateChange,
  connectionMigrateUndoChange,
  type MigrationResult,
  type MigrationUndoResult,
} from '../src/operations/connection-migrate.ts';
import { connectionList } from '../src/operations/connections.ts';
import { connectionConsent } from './helpers/connection-consent.ts';
import { fakeClaude } from './helpers/gateway/fake-claude.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * `connection migrate` (single-server design D16, §9.1, §9.4): an app's separate Agent Comms entries become one
 * connection reaching exactly what they reached — every pin and read-only kept, nothing added — and only once its entry
 * has started are the others removed, each saved first. A second entry of one server, one project's entries and
 * somebody else's are left alone and named; an app config that cannot be read stops it; an entry that does not start
 * puts everything back; and the undo gives each part its own entry again. Every test has a temporary home and a
 * stand-in `claude`; the parts run from this checkout's source.
 */

const NOT_ON_WINDOWS = process.platform === 'win32' ? { skip: 'the stand-in `claude` is a POSIX script' } : {};
const PACKAGES = fileURLToPath(new URL('../..', import.meta.url));
const STRIP = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

const INBOX = {
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
  createdAt: '2026-09-20T00:00:00.000Z',
};

interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
  claudeJson: string;
  project: string;
}

function machine(): Machine {
  const home = tempDir('comms-connections-migrate-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  mkdirSync(join(home, 'bin'));
  writeFileSync(
    join(configDir, 'config.json'),
    `${JSON.stringify({ version: 2, inboxes: { 'acme/gmail': INBOX } })}\n`,
  );
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
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
  fakeClaude(join(home, 'bin'), claudeJson, join(home, 'claude-calls.jsonl'));
  const project = join(home, 'work', 'acme');
  mkdirSync(project, { recursive: true });
  return { home, env, core: openCore({ env, caller: CORE_CALLER }), claudeJson, project };
}

/** An entry as `--launcher local` writes one: this Node, a package's own source CLI, the four path pins, `mcp`. */
function local(m: Machine, pkg: string, words: string[] = []) {
  const { configDir, stateDir, dataDir, secretsDir } = m.core.paths;
  return {
    command: process.execPath,
    args: [
      ...STRIP,
      join(PACKAGES, pkg, 'src', 'cli.ts'),
      ...['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir],
      'mcp',
      ...words,
    ],
    env: { PATH: '/usr/bin:/bin' },
  };
}

/** A six-entry-style setup in Claude Code, and what a migration must leave alone beside it. */
function sixEntries(m: Machine, over: Record<string, unknown> = {}): void {
  writeFileSync(
    m.claudeJson,
    JSON.stringify(
      {
        mcpServers: {
          agentcomms: local(m, 'core'),
          gmail: local(m, 'gmail', ['--inbox', 'acme/gmail', '--read-only']),
          slack: local(m, 'slack'),
          events: local(m, 'events-daemon'),
          // A second Gmail: a connection holds one.
          'gmail-2': local(m, 'gmail'),
          // Somebody else's.
          notes: { command: 'node', args: ['/example/home/notes-server.js'] },
          ...over,
        },
        projects: { [m.project]: { mcpServers: { 'gmail-acme': local(m, 'gmail') } } },
      },
      null,
      2,
    ),
  );
}

const servers = (m: Machine) =>
  JSON.parse(readFileSync(m.claudeJson, 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    projects: Record<string, { mcpServers: Record<string, unknown> }>;
  };

async function prepared(m: Machine, change: () => ReturnType<typeof connectionMigrateChange>) {
  const first = await gatedChange(m.core, change(), { surface: 'cli', channel: 'core' });
  assert.equal(first.status, 'approval-required', 'a migration waits for the person');
  return first as Extract<GatedOutcome<unknown>, { status: 'approval-required' }>;
}

test(
  'a six-entry setup becomes one entry reaching exactly what they did; pins kept; the rest left and named; backups written',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    sixEntries(m);
    const first = await prepared(m, () => connectionMigrateChange(m.core, m.env, { client: 'claude-code' }, 'cli'));
    const effects = first.prepared.effects.join('\n');
    assert.match(
      effects,
      /moves "agentcomms", "gmail", "slack", "events" in .*\.claude\.json into one connection, "Claude Code" \(Claude Code, every folder, new\)/,
    );
    assert.match(effects, /Gmail, the mailbox acme\/gmail, read-only/);
    assert.match(effects, /leaves "gmail-2" .*a connection holds one Gmail/);
    assert.match(effects, /leaves "gmail-acme" .*one project’s own entry/);
    assert.doesNotMatch(effects, /notes/, 'somebody else’s entry is not ours to name');
    // §9.4, in the preview.
    assert.match(effects, /the tools appear under the one Agent Comms entry: mcp__agentcomms__/);
    assert.match(effects, /need allowing again as mcp__agentcomms__/);
    assert.match(effects, /restart the app once/);
    const applied = (await gatedChange(
      m.core,
      connectionMigrateChange(m.core, m.env, { client: 'claude-code' }, 'cli'),
      {
        surface: 'cli',
        channel: 'core',
        approvalId: first.prepared.approvalId,
      },
    )) as GatedOutcome<MigrationResult>;
    assert.equal(applied.status, 'applied');
    const result = (applied as { result: MigrationResult }).result;
    assert.equal(result.migrated.length, 1);
    const [read] = readConnections(await m.core.config.load()).connections;
    assert.ok(read?.readable);
    assert.deepEqual(
      read.record.parts.map((part) => [part.server, part.pin?.alias ?? null, part.readOnly === true]),
      [
        ['core', null, false],
        ['gmail', 'acme/gmail', true],
        ['slack', null, false],
        ['events', null, false],
      ],
      'exactly what the entries reached, nothing added',
    );
    const after = servers(m);
    assert.deepEqual(Object.keys(after.mcpServers).sort(), ['agentcomms', 'gmail-2', 'notes']);
    const gateway = after.mcpServers.agentcomms;
    assert.deepEqual(gateway?.args.slice(-3), ['mcp', '--connection', read.record.id]);
    assert.ok(connectionKeyMatches(gateway?.env?.AGENT_COMMS_CONNECTION_KEY, read.record.keyHash));
    assert.deepEqual(Object.keys(after.projects[m.project]?.mcpServers ?? {}), ['gmail-acme']);
    assert.deepEqual(
      read.record.migratedFrom?.entries.map((entry) => entry.name),
      ['agentcomms', 'gmail', 'slack', 'events'],
    );
    assert.ok((read.record.migratedFrom?.backups.length ?? 0) >= 3, 'each removed entry was saved first');
    for (const backup of read.record.migratedFrom?.backups ?? []) assert.ok(existsSync(backup));
    // `connection list` says it came from a migration, and which entries it replaced — never where they were saved.
    const [view] = (await connectionList(m.core, m.env)).connections;
    assert.deepEqual(view?.migratedFrom, {
      at: read.record.migratedFrom?.at,
      entries: [
        { server: 'core', name: 'agentcomms' },
        { server: 'gmail', name: 'gmail' },
        { server: 'slack', name: 'slack' },
        { server: 'events', name: 'events' },
      ],
    });

    // The undo: each part an entry of its own again, under its old name, the connection gone.
    const undo = await gatedChange(m.core, connectionMigrateUndoChange(m.core, m.env, { id: read.record.id }, 'cli'), {
      surface: 'cli',
      channel: 'core',
    });
    assert.equal(undo.status, 'approval-required');
    const undone = (await gatedChange(
      m.core,
      connectionMigrateUndoChange(m.core, m.env, { id: read.record.id }, 'cli'),
      {
        surface: 'cli',
        channel: 'core',
        approvalId: (undo as { prepared: { approvalId: string } }).prepared.approvalId,
      },
    )) as GatedOutcome<MigrationUndoResult>;
    assert.equal(undone.status, 'applied');
    const back = servers(m).mcpServers;
    assert.deepEqual(Object.keys(back).sort(), ['agentcomms', 'events', 'gmail', 'gmail-2', 'notes', 'slack']);
    assert.equal(back.agentcomms?.args.includes('--connection'), false, 'core’s own entry again');
    assert.ok(
      back.gmail?.args.includes('--read-only') && back.gmail.args.includes('acme/gmail'),
      'its pin and read-only kept',
    );
    assert.deepEqual(readConnections(await m.core.config.load()).connections, []);
  },
);

test(
  'an entry that does not start puts everything back: the entries as they were, and the connection cut off',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    // Managed entries on a launcher with no runtime behind it, and no way to fetch one: the connection cannot start.
    const { configDir, stateDir, dataDir, secretsDir } = m.core.paths;
    const managed = (name: string, words: string[] = []) => ({
      command: launcherPaths(dataDir, name).launcher,
      args: [
        '--config-dir',
        configDir,
        '--state-dir',
        stateDir,
        '--data-dir',
        dataDir,
        '--secrets-dir',
        secretsDir,
        'mcp',
        ...words,
      ],
    });
    writeFileSync(
      m.claudeJson,
      JSON.stringify({
        mcpServers: { agentcomms: managed('core'), gmail: managed('gmail', ['--inbox', 'acme/gmail']) },
      }),
    );
    const before = readFileSync(m.claudeJson, 'utf8');
    await assert.rejects(
      (async () => {
        const first = await prepared(m, () => connectionMigrateChange(m.core, m.env, {}, 'cli'));
        await gatedChange(m.core, connectionMigrateChange(m.core, m.env, {}, 'cli'), {
          surface: 'cli',
          channel: 'core',
          approvalId: first.prepared.approvalId,
        });
      })(),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(m.claudeJson, 'utf8')).mcpServers.gmail,
      JSON.parse(before).mcpServers.gmail,
    );
    assert.ok(JSON.parse(readFileSync(m.claudeJson, 'utf8')).mcpServers.agentcomms, 'core’s own entry is there');
    const records = readConnections(await m.core.config.load()).connections;
    assert.ok(
      records.every((read) => read.readable && read.record.revokedAt !== null),
      'a connection left serves nothing',
    );
  },
);

test('a connection no migration made says so, and its undo is refused before anything is asked or changed', async () => {
  /*
   * Before 0.35.0's finish, `connection migrate --undo` took any connection: one made by `connection add` or a
   * channel's own `mcp install` was, once approved, taken out of its app and each part registered as an entry of its
   * own under its default name — "undoing" a migration that never happened, into the six-entry shape.
   */
  const m = machine();
  const key = newConnectionKey();
  const made: ConnectionRecord = {
    id: newConnectionId(),
    name: 'Claude Code',
    app: 'claude-code',
    where: { scope: 'user', folder: null, configDir: null },
    entry: { name: 'agentcomms', path: m.claudeJson },
    launcher: 'managed',
    parts: [{ server: 'core' }, { server: 'gmail' }],
    keyHash: connectionKeyHash(key),
    keyIssuedAt: '2026-10-27T09:00:00.000Z',
    createdAt: '2026-10-27T09:00:00.000Z',
    revokedAt: null,
  };
  await m.core.config.update((config) => ({ ...config, connections: withConnection(config, { put: made }) }), {
    consent: connectionConsent(made),
  });
  const [view] = (await connectionList(m.core, m.env)).connections;
  assert.equal(view?.migratedFrom, null);
  await assert.rejects(
    gatedChange(m.core, connectionMigrateUndoChange(m.core, m.env, { id: made.id }, 'cli'), {
      surface: 'cli',
      channel: 'core',
    }),
    (error: { code?: string; message?: string; hint?: string }) => {
      assert.equal(error.code, 'USAGE');
      assert.match(String(error.message), /"Claude Code" came from no migration, so there is nothing to undo/);
      assert.match(String(error.hint), /connection remove/);
      return true;
    },
  );
  assert.deepEqual(await m.core.approvals.list(), [], 'nothing was prepared');
  assert.equal(readConnections(await m.core.config.load()).connections.length, 1, 'the connection is as it was');
});

test('an app config that cannot be read stops a migration before anything is planned', NOT_ON_WINDOWS, async () => {
  const m = machine();
  writeFileSync(m.claudeJson, '{ not json');
  await assert.rejects(
    gatedChange(m.core, connectionMigrateChange(m.core, m.env, {}, 'cli'), { surface: 'cli', channel: 'core' }),
    /could not be read, so nothing was migrated/,
  );
  assert.deepEqual(readConnections(await m.core.config.load()).connections, []);
});
