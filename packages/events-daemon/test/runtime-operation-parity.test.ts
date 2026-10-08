import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';

test('PAR-B1: runtime CLI commands and tools expose every paired operation, while run stays terminal-only', async () => {
  const stdout = new PassThrough();
  let help = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    help += String(chunk);
  });
  const code = await run(['--help'], {
    streams: { stdin: new PassThrough(), stdout, stderr: new PassThrough() },
  });
  assert.equal(code, 0);
  for (const command of ['run', 'stop', 'pause', 'resume', 'disable-all', 'enable-all', 'doctor']) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }

  const { server } = await createEventsMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-daemon-runtime-parity', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'events_disable_all',
      'events_doctor',
      'events_enable_all',
      'events_pause',
      'events_resume',
      'events_status',
      'events_stop',
    ]);
    assert.ok(!names.includes('events_run'), 'the owner-starting command is not an MCP tool');
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
