import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';
import { status } from '../src/operations/status.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('PAR-B1: the status command and tool return the one content-free daemon status', {
  skip: WINDOWS_SKIP,
}, async () => {
  const expected = await status();
  assert.deepEqual(expected, { owner: 'not-running' });

  const stdout = new PassThrough();
  let output = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  const code = await run(['--json', 'status'], {
    streams: { stdin: new PassThrough(), stdout, stderr: new PassThrough() },
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), expected);

  const { server } = await createEventsMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-daemon-test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes('events_status'));
    assert.ok(names.includes('events_catalogue_list'));
    assert.ok(!names.includes('events_approve'));
    const result = (await client.callTool({ name: 'events_status', arguments: {} })) as {
      isError?: boolean;
      structuredContent: unknown;
    };
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, expected);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
