import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createEventsMcpServer } from '../src/mcp/server.ts';

test('PAR-B1: every Task 9 paired lifecycle surface is present, while approval remains terminal-only', async () => {
  const { server } = await createEventsMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-lifecycle-parity', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const name of [
      'events_catalogue_list',
      'events_catalogue_show',
      'events_sources_list',
      'events_source_show',
      'events_rules_list',
      'events_rule_show',
      'events_rule_create',
      'events_rule_update',
      'events_rule_enable',
      'events_rule_disable',
      'events_rule_remove',
      'events_targets_list',
      'events_target_add',
      'events_target_update',
      'events_target_remove',
    ])
      assert.ok(names.has(name), name);
    assert.ok(!names.has('events_approve'));
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
