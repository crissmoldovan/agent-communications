import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';
import { MCP_SERVER_MARKER } from '../src/targets/queue.ts';
import { shortTempDir } from './support/short-temp.ts';

const ITEM = 'qi_01JBQZ8Y6W3T5N0M4K2H7G9F1D';

async function cli(argv: readonly string[], env: NodeJS.ProcessEnv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += chunk;
  });
  stderr.on('data', (chunk) => {
    err += chunk;
  });
  const stdin = Object.assign(new PassThrough(), { isTTY: false });
  const code = await run(argv, {
    env,
    streams: {
      stdin,
      stdout: Object.assign(stdout, { isTTY: false }),
      stderr: Object.assign(stderr, { isTTY: false }),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, out, err };
}

test('QUEUE-A: queue list and show refuse inside an MCP server’s process, before they ask the owner (Q1)', async () => {
  const stateDir = await shortTempDir('events-queue-gate-');
  try {
    const base = ['--state-dir', stateDir];
    for (const argv of [
      [...base, 'queue', 'list', '--json'],
      [...base, 'queue', 'show', ITEM, '--json'],
      [...base, 'queue', 'list'],
      [...base, 'queue', 'clear', '--json'],
    ]) {
      const refused = await cli(argv, { [MCP_SERVER_MARKER]: 'events' });
      assert.equal(refused.code, 10, `${argv.join(' ')}: ${refused.err}`);
      assert.match(refused.err, argv.includes('clear') ? /cannot clear it/u : /an MCP server cannot read it/u);
      assert.equal(refused.out, '', 'nothing is printed');
    }
    // The server marks its own process, so every program it starts is refused too.
    const served: NodeJS.ProcessEnv = {};
    const started = await run(['mcp'], {
      env: served,
      startMcp: async () => undefined,
      streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
    });
    assert.equal(started, 0);
    assert.equal(served[MCP_SERVER_MARKER], 'events');
    assert.equal((await cli([...base, 'queue', 'list', '--json'], served)).code, 10);
    // A shell an agent runs is the person's own: this gate does not pretend otherwise. With no owner running, the
    // read gets as far as asking it.
    const agentShell = await cli([...base, 'queue', 'list', '--json'], { CLAUDECODE: '1' });
    assert.equal(agentShell.code, 66, agentShell.err);
    assert.match(agentShell.err, /not running/u);
    // The content-free reads and the state changes are not content reads; the gate does not apply to them.
    for (const argv of [
      [...base, 'queue', 'items', '--json'],
      [...base, 'queue', 'counts', '--json'],
      [...base, 'queue', 'done', ITEM, '--json'],
    ])
      assert.equal((await cli(argv, { [MCP_SERVER_MARKER]: 'events' })).code, 66, argv.join(' '));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('QUEUE-A: a malformed item id or filter exits 64 before the owner is asked', async () => {
  const stateDir = await shortTempDir('events-queue-usage-');
  try {
    const base = ['--state-dir', stateDir];
    for (const argv of [
      ['queue', 'show', 'not-an-item'],
      ['queue', 'done', 'qi_short'],
      ['queue', 'dismiss', `qi_${'I'.repeat(26)}`],
      ['queue', 'reopen', 'QI_01JBQZ8Y6W3T5N0M4K2H7G9F1D'],
      ['queue', 'list', '--state', 'archived'],
      ['queue', 'list', '--channel', 'email'],
      ['queue', 'list', '--since', 'last tuesday'],
      ['queue', 'list', '--limit', '0'],
      ['queue', 'list', '--limit', 'ten'],
      ['queue', 'items', '--limit', '501'],
    ]) {
      const result = await cli([...base, ...argv, '--json'], {});
      assert.equal(result.code, 64, `${argv.join(' ')}: ${result.err}`);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('QUEUE-A: MCP has the content-free queue tools only, and none of them takes or names content (Q1, Q5)', async () => {
  const { server } = await createEventsMcpServer({ stateDir: '/nonexistent/queue-surface' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-queue-surface', version: '0' });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith('events_queue'));
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'events_queue_counts',
      'events_queue_dismiss',
      'events_queue_done',
      'events_queue_items',
      'events_queue_reopen',
    ]);
    for (const tool of tools)
      assert.doesNotMatch(
        JSON.stringify(tool),
        /sender|subject|\bfrom\b|"text"|link|since/iu,
        `${tool.name} neither takes nor names item content`,
      );
    const done = tools.find((tool) => tool.name === 'events_queue_done');
    assert.equal(done?.annotations?.readOnlyHint, false);
    assert.equal(done?.annotations?.destructiveHint, false);
    assert.equal(
      tools.some((tool) => tool.name === 'events_queue_clear'),
      false,
      'an agent must not be able to make the person’s queue disappear: clear is the terminal’s and the app’s',
    );
    const refused = (await client.callTool({ name: 'events_queue_done', arguments: { itemId: 'nope' } })) as {
      readonly isError?: boolean;
    };
    assert.equal(refused.isError, true, 'the item id grammar is checked at the tool too');
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
