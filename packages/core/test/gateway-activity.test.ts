import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ActivityLog,
  type ActivitySession,
  activityLineOf,
  type ProcessProbe,
  sessionIdentity,
  withActivity,
} from '../src/activity.ts';
import { readActivitySettings } from '../src/activity-settings.ts';
import type { Config } from '../src/config.ts';
import {
  type ConnectionRecord,
  connectionKeyHash,
  newConnectionId,
  newConnectionKey,
  withConnection,
} from '../src/connections.ts';
import { openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { connectionConsent } from './helpers/connection-consent.ts';
import { asPartOf } from './helpers/gateway/as-part.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Sessions and activity behind a gateway (single-server design D8, D11). A part's parent is the gateway, which the agent
 * window started: the part looks through the gateway, so its session key is the one a server the window started
 * itself would have, and an agent's shell — whose ancestors hold the window, never the gateway — still joins it. Every
 * line a part records names its connection: by id, and by the name it has when the line is written.
 */

const WINDOW = 900;
const GATEWAY = 950;
const facts: Record<number, { ppid: number; startedAt: string; name: string }> = {
  [WINDOW]: { ppid: 1, startedAt: 'Tue Oct 27 09:00:00 2026', name: 'claude' },
  [GATEWAY]: { ppid: WINDOW, startedAt: 'Tue Oct 27 09:00:05 2026', name: 'node' },
};
const probe: ProcessProbe = async (pid) => facts[pid] ?? null;
const base = { cwd: () => '/example/home/jo/work/acme', probe, platform: 'darwin' as const, home: '/example/home/jo' };

test('D8: a part behind a gateway has the session key of a server the window started itself (golden)', async () => {
  const direct = await sessionIdentity('mcp', undefined, { ...base, pid: 101, ppid: WINDOW });
  const behind = await sessionIdentity('mcp', undefined, { ...base, pid: 102, ppid: GATEWAY, gatewayPid: GATEWAY });
  assert.equal(direct.grouped, true);
  assert.equal(behind.grouped, true);
  assert.equal(behind.key, direct.key, 'the same window, so the same session');
  assert.deepEqual(behind.parent, { pid: WINDOW, startedAt: facts[WINDOW]?.startedAt, name: 'claude' });
  // Without the gateway's pid, the gateway would be taken for the window: another session, which the shell never joins.
  const unaware = await sessionIdentity('mcp', undefined, { ...base, pid: 103, ppid: GATEWAY, gatewayPid: undefined });
  assert.notEqual(unaware.key, direct.key);
});

test('D8: an agent shell’s command joins the window a part behind a gateway recorded in', async () => {
  const state = tempDir('comms-gateway-activity-');
  const log = new ActivityLog(state, { settings: async () => readActivitySettings({}) });
  const part = await sessionIdentity(
    'mcp',
    { name: 'claude-code', version: '2.1.310' },
    {
      ...base,
      pid: 104,
      ppid: GATEWAY,
      gatewayPid: GATEWAY,
    },
  );
  await log.append(
    activityLineOf({
      channel: 'gmail',
      account: { id: 'ibx_AAAAAAAAAAAAAAAA', alias: 'cue/gmail' },
      operation: 'gmail.search',
      kind: 'read',
      outcome: 'ok',
      session: part,
      ms: 3,
    }),
  );
  // The shell the window runs: its parent is a shell, whose parent is the window; the gateway is nowhere above it.
  const shellFacts: typeof facts = {
    ...facts,
    960: { ppid: WINDOW, startedAt: 'Tue Oct 27 09:01:00 2026', name: 'zsh' },
  };
  const shell = await sessionIdentity('cli', undefined, {
    ...base,
    pid: 970,
    ppid: 960,
    probe: async (pid) => shellFacts[pid] ?? null,
    log,
  });
  assert.equal(shell.key, part.key, 'the command joins the window’s session');
});

test('D11: a line a part records names its connection by id and by its name now; a rename is the next line’s name', async () => {
  const home = tempDir('comms-gateway-activity-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const env = {
    HOME: home,
    USERPROFILE: home,
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  const core = openCore({ env, caller: CORE_CALLER });
  const id = newConnectionId();
  const held: ConnectionRecord = {
    id,
    name: 'Work — Claude Code',
    app: 'claude-code',
    where: { scope: 'user', folder: null, configDir: null },
    entry: { name: 'agentcomms', path: '/example/home/.claude.json' },
    launcher: 'managed',
    parts: [{ server: 'gmail' }],
    keyHash: connectionKeyHash(newConnectionKey()),
    keyIssuedAt: '2026-10-27T09:00:00.000Z',
    createdAt: '2026-10-27T09:00:00.000Z',
    revokedAt: null,
  };
  const put = (next: ConnectionRecord, consent: boolean) =>
    core.config.update((config: Config) => ({ ...config, connections: withConnection(config, { put: next }) }), {
      ...(consent ? { consent: connectionConsent(next) } : {}),
    });
  await put(held, true);
  const session: ActivitySession = {
    key: '0123456789abcdef',
    process: 'p1',
    pid: 1,
    folder: null,
    grouped: false,
    surface: 'mcp',
  };
  const call = () =>
    withActivity(
      { core, channel: 'gmail', surface: 'mcp', account: { id: 'ibx_AAAAAAAAAAAAAAAA', alias: 'cue/gmail' }, session },
      'gmail.search',
      'read',
      async () => ({ total: 0 }),
      () => ({ count: 0 }),
    );
  await asPartOf(id, async () => {
    await call();
    await put({ ...held, name: 'Acme — Claude Code' }, false);
    await call();
  });
  await call();
  // The variable a process sets for itself, outside any part a gateway started, names nothing (0.35.0 review, LOW).
  await asPartOf(id, call, { gateway: false });
  const shown = await core.activity.show(session.key, {});
  const named = shown.lines.map((line) => line.session.connection ?? null).reverse();
  assert.deepEqual(named, [{ id, name: 'Work — Claude Code' }, { id, name: 'Acme — Claude Code' }, null, null]);
});
