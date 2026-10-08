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
  for (const command of [
    'run',
    'stop',
    'pause',
    'resume',
    'disable-all',
    'enable-all',
    'doctor',
    'catalogue',
    'sources',
    'source',
    'rules',
    'rule',
    'targets',
    'target',
    'approve',
  ]) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }

  const { server } = await createEventsMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-daemon-runtime-parity', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'events_catalogue_list',
      'events_catalogue_show',
      'events_disable_all',
      'events_doctor',
      'events_enable_all',
      'events_pause',
      'events_resume',
      'events_rule_create',
      'events_rule_disable',
      'events_rule_enable',
      'events_rule_remove',
      'events_rule_show',
      'events_rule_update',
      'events_rules_list',
      'events_source_show',
      'events_sources_list',
      'events_status',
      'events_stop',
      'events_target_add',
      'events_target_remove',
      'events_target_update',
      'events_targets_list',
    ]);
    assert.ok(!names.includes('events_run'), 'the owner-starting command is not an MCP tool');
    assert.ok(!names.includes('events_approve'), 'standing disclosure approval is terminal-only');
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
