import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { LaneWindowIdentity } from '../src/domain/lanes.ts';
import { createEventsMcpServer, TASKS_EXTENSION } from '../src/mcp/server.ts';
import { rawClient, resultText } from './support/raw-mcp.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * The event service's MCP server serves both protocol eras through the SDK's `serveStdio` (routing design §3.4): a
 * client that offers 2026-07-28 negotiates it, which a task needs, and a 2025-era client that opens with `initialize`
 * connects and lists tools exactly as before. The spike found `server.connect(new StdioServerTransport())` falls back to
 * the 2025 era, where Claude Code uses no tasks.
 */

const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'dist', 'cli.mjs');
const PRELOAD = new URL('../../../test/helpers/loopback-seal-preload.mjs', import.meta.url).href;
const LANE_TOOLS = [
  'events_lane_item',
  'events_lane_list',
  'events_lane_unbind',
  'events_lane_whoami',
  'events_wait',
  'events_watch',
];

const WINDOW: LaneWindowIdentity = {
  sessionId: '25f971a3-0c69-44e3-971c-3a4656afa986',
  activityKey: '0123456789abcdef',
  grouped: true,
  folder: '/example/home/work/project',
  client: null,
};

async function served(): Promise<{
  readonly client: InMemoryTransport;
  readonly close: () => Promise<void>;
}> {
  const events = await createEventsMcpServer({ stateDir: '/nonexistent/lane-protocol', window: async () => WINDOW });
  const [client, server] = InMemoryTransport.createLinkedPair();
  const handle = await events.serve(server);
  return { client, close: () => handle.close() };
}

test('LANE-C: a legacy client (2025-11-25 initialize) still connects and lists every tool, the lane tools among them', async () => {
  const { client: transport, close } = await served();
  const client = new Client({ name: 'legacy-lane-client', version: '0' });
  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25');
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const tool of [...LANE_TOOLS, 'events_status', 'events_queue_items']) assert.ok(names.includes(tool), tool);
    assert.equal(names.includes('events_lane_bind'), false, 'no tool binds a lane (B1)');
  } finally {
    await client.close();
    await close();
  }
});

test('LANE-C: a modern client negotiates 2026-07-28 and sees the tasks extension advertised', async () => {
  const { client: transport, close } = await served();
  const client = new Client({ name: 'modern-lane-client', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    const capabilities = client.getServerCapabilities() as { readonly extensions?: Record<string, unknown> };
    assert.ok(capabilities.extensions !== undefined && TASKS_EXTENSION in capabilities.extensions);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const tool of LANE_TOOLS) assert.ok(names.includes(tool), tool);
  } finally {
    await client.close();
    await close();
  }
});

test('LANE-C: events_watch answers with no task when the request does not declare the tasks extension, and names events_wait (B7)', async () => {
  const { client: legacyTransport, close: closeLegacy } = await served();
  const legacy = new Client({ name: 'legacy-watch-client', version: '0' });
  try {
    await legacy.connect(legacyTransport);
    const refused = (await legacy.callTool({ name: 'events_watch', arguments: { lane: 'david' } })) as {
      readonly isError?: boolean;
      readonly content: readonly { readonly text?: string }[];
    };
    assert.equal(refused.isError, true, 'a legacy request has no tasks extension to declare');
    assert.match(refused.content[0]?.text ?? '', /tasks extension.*events_wait/u);
  } finally {
    await legacy.close();
    await closeLegacy();
  }

  const { client: transport, close } = await served();
  const raw = await rawClient(transport);
  try {
    const discovered = await raw.request('server/discover', {}, { tasks: false });
    assert.deepEqual((discovered.result as { supportedVersions: string[] }).supportedVersions, ['2026-07-28']);
    const call = await raw.request(
      'tools/call',
      { name: 'events_watch', arguments: { lane: 'david' } },
      { tasks: false },
    );
    assert.notEqual(call.result?.resultType, 'task', 'no task without the extension');
    assert.equal(call.result?.isError, true);
    assert.match(resultText(call), /did not declare the tasks extension.*events_wait/u);
    const unknown = await raw.request('tasks/get', { taskId: 'lt_00000000000000000000000000000000' });
    assert.equal(unknown.error?.code, -32602, 'a task this server never made is an unknown task');
    assert.deepEqual((await raw.request('tasks/cancel', { taskId: 'lt_none' })).result?.resultType, 'complete');
  } finally {
    await raw.close();
    await close();
  }
});

test('LANE-C: the built server, over real stdio, serves a legacy and a modern client alike', {
  skip: WINDOWS_SKIP,
}, async () => {
  const state = await shortTempDir('aev-lane-stdio-');
  const env = {
    ...(process.env as Record<string, string>),
    AGENT_COMMS_STATE_DIR: join(state, 'state'),
    AGENT_COMMS_CONFIG_DIR: join(state, 'config'),
  };
  try {
    for (const [mode, version] of [
      ['legacy', '2025-11-25'],
      ['auto', '2026-07-28'],
    ] as const) {
      const client = new Client({ name: `stdio-${mode}`, version: '0' }, { versionNegotiation: { mode } });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', PRELOAD, CLI, 'mcp'],
          env,
          stderr: 'ignore',
        }),
      );
      try {
        assert.equal(client.getNegotiatedProtocolVersion(), version, mode);
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        for (const tool of LANE_TOOLS) assert.ok(names.includes(tool), `${mode}: ${tool}`);
        const status = (await client.callTool({ name: 'events_status', arguments: {} })) as {
          readonly structuredContent?: unknown;
        };
        assert.deepEqual(status.structuredContent, { owner: 'not-running' }, `${mode}: an ordinary tool still answers`);
      } finally {
        await client.close();
      }
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
