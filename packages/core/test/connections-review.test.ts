import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type GatedChange, type GatedOutcome, gatedChange } from '../src/change-flow.ts';
import type { ChangeSurface } from '../src/changes.ts';
import { readConnections } from '../src/connections.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import {
  type ConnectionAddRequest,
  type ConnectionAddResult,
  connectionAddChange,
  connectionChangeChange,
  connectionKeyReplaceChange,
  connectionRemoveChange,
  connectionRenameChange,
  parsePartsSpec,
} from '../src/operations/connections.ts';
import { homeDirectory, shortenHome } from '../src/paths.ts';
import { partEnv } from './helpers/gateway/as-part.ts';
import { fakeClaude } from './helpers/gateway/fake-claude.ts';
import { runMain } from './helpers/main-in-process.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The 0.35.0 security review's connection findings, as the reviewer ran them (scratch probes `gw/probe.test.ts`), held
 * as regression tests. Each machine has a temporary home, a stand-in `claude` keeping its servers in the home's
 * `.claude.json`, and parts started from this checkout (`--launcher local`): nothing real is read, written or started.
 */

const NOT_ON_WINDOWS = process.platform === 'win32' ? { skip: 'the stand-in `claude` is a POSIX script' } : {};

interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
  claudeJson: string;
}

function machine(): Machine {
  const home = tempDir('comms-connections-review-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  mkdirSync(join(home, 'bin'));
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
  return { home, env, core: openCore({ env, caller: CORE_CALLER }), claudeJson };
}

/** A connection added as the person adds one: prepared, then approved with its id. */
async function added(m: Machine, request: Omit<ConnectionAddRequest, 'launcher' | 'noVerify'>) {
  const build = () => connectionAddChange(m.core, m.env, { ...request, launcher: 'local', noVerify: true }, 'cli');
  const first = await gatedChange(m.core, build(), { surface: 'cli', channel: 'core' });
  assert.equal(first.status, 'approval-required');
  if (first.status !== 'approval-required') throw new Error('unreachable');
  const second = (await gatedChange(m.core, build(), {
    surface: 'cli',
    channel: 'core',
    approvalId: first.prepared.approvalId,
  })) as GatedOutcome<ConnectionAddResult>;
  assert.equal(second.status, 'applied');
  if (second.status !== 'applied') throw new Error('unreachable');
  return second.result.connection;
}

/** "Everywhere", every folder, and "Acme only", one project: the person's two connections in the review. */
async function twoConnections(m: Machine) {
  const project = join(m.home, 'work', 'acme');
  mkdirSync(project, { recursive: true });
  const everywhere = await added(m, { app: 'claude-code', name: 'Everywhere', parts: parsePartsSpec('core,events') });
  const acme = await added(m, {
    app: 'claude-code',
    name: 'Acme only',
    parts: parsePartsSpec('core'),
    folder: project,
  });
  return { project, everywhere, acme };
}

const run = <T>(m: Machine, change: GatedChange<T>, surface: ChangeSurface) =>
  gatedChange(m.core, change, { surface, channel: 'core' });

const names = async (m: Machine) =>
  readConnections(await m.core.config.load()).connections.map((read) => (read.readable ? read.record.name : read.id));

test(
  'M1: over MCP an agent renames, re-keys and removes only the connection it is a part of — another is refused, unchanged',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const { everywhere, acme } = await twoConnections(m);
    // The reviewer's swap: the agent in "Acme only" renames the other connection. Refused, with the person's way to do it.
    const inAcme = partEnv(m.env, acme.id);
    for (const change of [
      connectionRenameChange(m.core, inAcme, { id: everywhere.id, name: 'Untrusted repo' }, 'mcp'),
      connectionKeyReplaceChange(m.core, inAcme, { id: everywhere.id }, 'mcp'),
      connectionRemoveChange(m.core, inAcme, { id: everywhere.id }, 'mcp'),
    ] as GatedChange<unknown>[]) {
      await assert.rejects(run(m, change, 'mcp'), (error: Error & { code?: string; hint?: string }) => {
        assert.equal(error.code, 'APPROVAL_REQUIRED', error.message);
        assert.match(error.message, /only the connection it is a part of/);
        assert.match(error.hint ?? '', /at your terminal, or in the app/);
        return true;
      });
    }
    // Its own: at once, as before.
    const own = await run(m, connectionRenameChange(m.core, inAcme, { id: acme.id, name: 'Acme' }, 'mcp'), 'mcp');
    assert.equal(own.status, 'applied');
    assert.deepEqual(await names(m), ['Everywhere', 'Acme']);
    const servers = JSON.parse(readFileSync(m.claudeJson, 'utf8')).mcpServers;
    assert.ok(servers.agentcomms, 'the other connection’s entry is still there');
  },
);

test(
  'M1: outside any connection — core’s own server, an agent’s shell, a variable a shell set itself — none of them is the agent’s',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const { acme } = await twoConnections(m);
    const rename = (env: Record<string, string>, surface: ChangeSurface) =>
      run(m, connectionRenameChange(m.core, env, { id: acme.id, name: 'Elsewhere' }, surface), surface);
    // Core's own server, started without a gateway: a part of no connection.
    await assert.rejects(rename(m.env, 'mcp'), /a part of no connection/);
    // An agent's shell: the CLI, with an agent's marker.
    await assert.rejects(rename({ ...m.env, CLAUDECODE: '1' }, 'cli'), /a part of no connection/);
    // The variable alone, as a shell could set it, outside any part a gateway started.
    await assert.rejects(rename(partEnv(m.env, acme.id, { gateway: false }), 'mcp'), /a part of no connection/);
    // The person at a terminal: any connection.
    assert.equal((await rename(m.env, 'cli')).status, 'applied');
    assert.deepEqual(await names(m), ['Everywhere', 'Elsewhere']);
  },
);

test(
  'M1: every preview line that names a connection names it by name, app, place and short id — new for one being added',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const { project, everywhere, acme } = await twoConnections(m);
    // The reviewer's names, given by the person at a terminal (an agent can no longer rename another connection).
    for (const [id, name] of [
      [acme.id, 'tmp'],
      [everywhere.id, 'Untrusted repo'],
      [acme.id, 'My main Claude Code'],
    ] as const) {
      assert.equal((await run(m, connectionRenameChange(m.core, m.env, { id, name }, 'cli'), 'cli')).status, 'applied');
    }
    // The agent in the project asks to widen its own connection: the preview says which one that is, past its name.
    const asked = await run(
      m,
      connectionChangeChange(
        m.core,
        partEnv(m.env, acme.id),
        { id: acme.id, parts: parsePartsSpec('core,events') },
        'mcp',
      ),
      'mcp',
    );
    assert.equal(asked.status, 'approval-required');
    if (asked.status !== 'approval-required') return;
    const label = `"My main Claude Code" (Claude Code, ${realpathSync(project)}, ${acme.id.slice(0, 7)}…)`;
    assert.equal(asked.prepared.summary, `Let agents in ${label} reach more`);
    assert.deepEqual(
      asked.prepared.loosened.map((loosening) => loosening.path),
      [`connections[${label}].parts.events`],
    );
    assert.ok(asked.prepared.preview.includes(`connections[${label}].parts.events`), asked.prepared.preview);
    // One being added has no id until it is: its name, its app and its place, and "new".
    const adding = await run(
      m,
      connectionAddChange(
        m.core,
        m.env,
        { app: 'claude-code', name: 'Third', parts: parsePartsSpec('core'), launcher: 'local', noVerify: true },
        'cli',
      ),
      'cli',
    );
    assert.equal(adding.status, 'approval-required');
    if (adding.status !== 'approval-required') return;
    const added = '"Third" (Claude Code, every folder, new)';
    assert.equal(adding.prepared.summary, `Add the connection ${added}`);
    assert.deepEqual(
      adding.prepared.loosened.map((loosening) => loosening.path),
      [`connections[${added}]`],
    );
    assert.ok(
      adding.prepared.effects.some((effect) => effect.startsWith(`registers the connection ${added} with claude-code`)),
      adding.prepared.effects.join('\n'),
    );
  },
);

const claudeJson = (m: Machine) =>
  JSON.parse(readFileSync(m.claudeJson, 'utf8')) as {
    mcpServers?: Record<string, unknown>;
    projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
  };

test(
  'H1: removing a one-project connection over the app’s every-folder one widens reach, so it waits for the person',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const { project, everywhere, acme } = await twoConnections(m);
    const real = realpathSync(project);
    // Both entries carry core's name: the project's shadows the one for every folder there (Claude Code's precedence).
    assert.ok(claudeJson(m).mcpServers?.agentcomms);
    assert.ok(claudeJson(m).projects?.[real]?.mcpServers?.agentcomms);
    // The reviewer's scenario: the agent in the project removes its own connection over MCP.
    const inAcme = partEnv(m.env, acme.id);
    const remove = () => connectionRemoveChange(m.core, inAcme, { id: acme.id }, 'mcp');
    const asked = await run(m, remove(), 'mcp');
    assert.equal(asked.status, 'approval-required', 'not applied at once');
    if (asked.status !== 'approval-required') return;
    const place = shortenHome(real, homeDirectory(m.env));
    const line = `Agents in ${place} will then use the connection "Everywhere" (Claude Code, every folder, ${everywhere.id.slice(0, 7)}…), for every folder: Agent Comms itself; Events — more than this one reaches`;
    assert.deepEqual(asked.prepared.effects, [line]);
    assert.ok(asked.prepared.preview.includes(line), asked.prepared.preview);
    assert.ok(claudeJson(m).projects?.[real]?.mcpServers?.agentcomms, 'nothing removed while it waits');
    assert.deepEqual(await names(m), ['Everywhere', 'Acme only']);
    // The person's yes in the chat, claimed with the approval: removed.
    const done = await gatedChange(m.core, remove(), {
      surface: 'mcp',
      channel: 'core',
      approvalId: asked.prepared.approvalId,
    });
    assert.equal(done.status, 'applied');
    assert.equal(claudeJson(m).projects?.[real]?.mcpServers?.agentcomms, undefined);
    assert.deepEqual(await names(m), ['Everywhere']);
  },
);

test(
  'H1: a remove that leaves nothing wider behind applies at once — every folder, or a project over a narrower one',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const project = join(m.home, 'work', 'acme');
    mkdirSync(project, { recursive: true });
    // The project's connection reaches more than the one for every folder: removing it narrows, at once.
    const narrow = await added(m, { app: 'claude-code', name: 'Everywhere', parts: parsePartsSpec('core') });
    const wide = await added(m, {
      app: 'claude-code',
      name: 'Acme',
      parts: parsePartsSpec('core,events'),
      folder: project,
    });
    const atOnce = await run(m, connectionRemoveChange(m.core, m.env, { id: wide.id }, 'cli'), 'cli');
    assert.equal(atOnce.status, 'applied');
    // The connection for every folder shadows nothing: at once too.
    const last = await run(m, connectionRemoveChange(m.core, m.env, { id: narrow.id }, 'cli'), 'cli');
    assert.equal(last.status, 'applied');
    assert.deepEqual(await names(m), []);
  },
);

test(
  'H1 at a terminal: connection remove prints the preview and takes --approval; --app-approval is the app’s to give',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const { acme } = await twoConnections(m);
    const words = ['connection', 'remove', acme.id, '--json'];
    // No terminal to ask at (an agent, or a pipe): the preview and the approval to claim.
    const asked = await runMain(words, m.env, 'darwin');
    assert.equal(asked.code, 10, asked.stdout + asked.stderr);
    const error = asked.json().error as { code: string; details: { approvalId: string; preview: string } };
    assert.equal(error.code, 'APPROVAL_PENDING');
    assert.match(error.details.preview, /will then use the connection "Everywhere"/);
    assert.deepEqual(await names(m), ['Everywhere', 'Acme only']);
    const removed = await runMain([...words, '--approval', error.details.approvalId], m.env, 'darwin');
    assert.equal(removed.code, 0, removed.stdout + removed.stderr);
    assert.deepEqual(await names(m), ['Everywhere']);
    // The app approves a remove as it approves an addition: refused to an agent, as there.
    const agent = await runMain(
      ['connection', 'remove', acme.id, '--app-approval', 'ap_00000000000000000000000000', '--json'],
      { ...m.env, CLAUDECODE: '1' },
      'darwin',
    );
    assert.equal(agent.code, 10, agent.stdout);
    assert.match(agent.stdout, /only a person can approve a change in the app, not an agent/);
  },
);

test(
  'LOW: a key replaced where the person took the entry out by hand is refused, and nothing is written back',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const work = await added(m, { app: 'claude-code', name: 'Work', parts: parsePartsSpec('core') });
    // The person takes the entry out of Claude Code by hand.
    const held = claudeJson(m);
    delete held.mcpServers?.agentcomms;
    writeFileSync(m.claudeJson, JSON.stringify(held, null, 2));
    const before = await m.core.config.load();
    await assert.rejects(
      run(m, connectionKeyReplaceChange(m.core, m.env, { id: work.id }, 'cli'), 'cli'),
      (error: Error & { hint?: string }) => {
        assert.match(error.message, /entry isn’t in .*\.claude\.json any more, so its key was not replaced/);
        assert.match(error.hint ?? '', /Add the connection again/);
        return true;
      },
    );
    assert.equal(claudeJson(m).mcpServers?.agentcomms, undefined, 'the entry is not written back');
    const [read] = readConnections(await m.core.config.load()).connections;
    const [was] = readConnections(before).connections;
    assert.ok(read?.readable && was?.readable);
    assert.equal(read.record.keyHash, was.record.keyHash, 'the key is the one it had');
  },
);
