import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gatedChange } from '../src/change-flow.ts';
import type { Config } from '../src/config.ts';
import {
  type ConnectionRecord,
  connectionKeyHash,
  newConnectionId,
  newConnectionKey,
  readConnections,
  withConnection,
} from '../src/connections.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { launcherPaths } from '../src/launcher.ts';
import { mcpInstall } from '../src/mcp-install.ts';
import { doctor } from '../src/operations/maintenance.ts';
import {
  channelsAvailable,
  type ServerUninstallResult,
  serverProduct,
  serverUninstallChange,
} from '../src/operations/servers.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The commands that see registrations count what a connection starts (single-server design D19, §9.2 — "the four bugs
 * this would cause"): `channels`, the doctor, `update` (in `launcher-update.test.ts`) and `mcp uninstall`. A part
 * reached only through a connection's gateway is in no app's config, and each of them used to miss it. Every test has
 * a temporary home and writes its app configs there; nothing real is read or run.
 */

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
}

function machine(): Machine {
  const home = tempDir('comms-connections-count-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, 'config.json'),
    `${JSON.stringify({ version: 2, inboxes: { 'acme/gmail': INBOX } })}\n`,
  );
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_SECRETS_DIR: join(home, 'secrets'),
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return { home, env, core: openCore({ env, caller: CORE_CALLER }) };
}

/** A connection for Cursor whose gateway starts core and Gmail, and its one entry in Cursor's file, carrying `key`. */
async function connected(
  m: Machine,
  key = newConnectionKey(),
): Promise<{ record: ConnectionRecord; key: string; path: string }> {
  const path = join(m.home, '.cursor', 'mcp.json');
  const record: ConnectionRecord = {
    id: newConnectionId(),
    name: 'Work — Cursor',
    app: 'cursor',
    where: { scope: 'user', folder: null, configDir: null },
    entry: { name: 'agentcomms', path },
    launcher: 'managed',
    parts: [{ server: 'core' }, { server: 'gmail', pin: { id: INBOX.id, alias: 'acme/gmail' } }],
    keyHash: connectionKeyHash(key),
    keyIssuedAt: '2026-10-27T09:00:00.000Z',
    createdAt: '2026-10-27T09:00:00.000Z',
    revokedAt: null,
  };
  await m.core.config.update(
    (config: Config) => ({ ...config, connections: withConnection(config, { put: record }) }),
    {
      consent: { kind: 'loosening-consent', paths: ['connections["Work — Cursor"]'] },
    },
  );
  const { configDir, stateDir, dataDir, secretsDir } = m.core.paths;
  mkdirSync(join(m.home, '.cursor'), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      mcpServers: {
        agentcomms: {
          command: launcherPaths(dataDir, 'core').launcher,
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
            '--connection',
            record.id,
          ],
          env: { PATH: '/usr/bin', AGENT_COMMS_CONNECTION_KEY: key },
        },
      },
    })}\n`,
  );
  return { record, key, path };
}

test('channels: a part reached only through a connection is registered there, by the connection, and the key is nowhere', async () => {
  const m = machine();
  const { record, key } = await connected(m);
  const report = await channelsAvailable(m.core, m.env);
  const gmail = report.channels.find((channel) => channel.channel === 'gmail');
  assert.deepEqual(gmail?.viaConnections, [{ id: record.id, name: 'Work — Cursor', app: 'cursor' }]);
  assert.deepEqual(
    gmail?.registered.map((entry) => [entry.client, entry.name, entry.connection, entry.narrowing.join(' ')]),
    [['cursor', 'agentcomms', record.id, '--inbox acme/gmail']],
  );
  // The gateway entry is the connection's, not core's own registration; core's part is counted as Gmail's is.
  const core = report.channels.find((channel) => channel.channel === 'core');
  assert.deepEqual(
    core?.registered.map((entry) => entry.connection),
    [record.id],
  );
  assert.equal(JSON.stringify(report).includes(key), false);
});

test('doctor: a mailbox reached through a connection is started; a connection whose entry carries another key, or a part with no runtime, is something to look at', async () => {
  const m = machine();
  const { path } = await connected(m);
  const report = await doctor(m.core, m.env, { keyring: null } as never);
  const text = JSON.stringify(report.checks);
  assert.doesNotMatch(text, /no MCP client[^"]*starts the Gmail server/, 'Gmail is started, through the connection');
  const mine = report.checks.filter((check) => check.name === 'connection "Work — Cursor"');
  assert.ok(
    mine.some((check) => check.warn && /Gmail's runtime is not installed/.test(check.detail)),
    JSON.stringify(mine),
  );
  // Its entry's key replaced by hand: the doctor says so, and prints neither key.
  const held = JSON.parse(readFileSync(path, 'utf8'));
  const other = newConnectionKey();
  held.mcpServers.agentcomms.env.AGENT_COMMS_CONNECTION_KEY = other;
  writeFileSync(path, JSON.stringify(held));
  const again = await doctor(m.core, m.env, { keyring: null } as never);
  const theirs = again.checks.filter((check) => check.name === 'connection "Work — Cursor"');
  assert.ok(
    theirs.some((check) => /carries a key that is not the connection's/.test(check.detail)),
    JSON.stringify(theirs),
  );
  assert.equal(JSON.stringify(again).includes(other), false);
});

test('mcp uninstall --server gmail takes Gmail out of the client’s connections too, at once; core’s own uninstall leaves a connection’s entry', async () => {
  const m = machine();
  const { record, path } = await connected(m);
  const outcome = await gatedChange(
    m.core,
    serverUninstallChange(m.core, m.env, { channel: 'gmail', client: 'cursor' }, 'cli'),
    { surface: 'cli', channel: 'core' },
  );
  assert.equal(outcome.status, 'applied');
  const result = (outcome as { result: ServerUninstallResult }).result;
  assert.deepEqual(result.connections, [{ id: record.id, name: 'Work — Cursor' }]);
  const [read] = readConnections(await m.core.config.load()).connections;
  assert.deepEqual(read?.readable ? read.record.parts.map((part) => part.server) : null, ['core']);
  // `--server core` takes out core's own entries, never a connection's gateway entry.
  const core = await gatedChange(
    m.core,
    serverUninstallChange(m.core, m.env, { channel: 'core', client: 'cursor' }, 'cli'),
    {
      surface: 'cli',
      channel: 'core',
    },
  );
  assert.equal(core.status, 'applied');
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).mcpServers.agentcomms, 'the connection’s entry is still there');
});

test('mcp install --force refuses to replace an entry that belongs to a connection', async () => {
  const m = machine();
  await connected(m);
  const product = await serverProduct('core', 'managed');
  await assert.rejects(
    mcpInstall({ env: m.env, core: m.core }, product, { client: 'cursor', force: true, noVerify: true, apply: true }),
    /belongs to an MCP connection, so it is not replaced/,
  );
});

test('D19: every reader of what is registered counts what a connection starts, or is one that may not', () => {
  // `scanRegisteredServers` reads the apps' configs alone. Only these call it: the installer and the client scan
  // themselves, the locator, the connection operations that look for one entry, and `registeredOrConnected` itself.
  const allowed = new Set([
    'connection-registrations.ts',
    'handoffs.ts',
    'mcp-clients.ts',
    'mcp-install.ts',
    'operations/connections.ts',
    'operations/connection-migrate.ts',
  ]);
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const callers: string[] = [];
  const walk = (dir: string, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (
        entry.name.endsWith('.ts') &&
        /scanRegisteredServers\(/.test(readFileSync(join(dir, entry.name), 'utf8'))
      ) {
        callers.push(`${prefix}${entry.name}`);
      }
    }
  };
  walk(root);
  assert.deepEqual(
    callers.filter((file) => !allowed.has(file)),
    [],
    'read registrations through registeredOrConnected, so a connection’s parts are counted',
  );
});
