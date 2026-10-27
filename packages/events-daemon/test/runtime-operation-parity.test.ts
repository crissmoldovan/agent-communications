import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';

test('PAR-B1/B3: runtime CLI commands and tools expose every paired operation, while human-only operations stay terminal-only', async () => {
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
    'dryrun',
    'approval',
    'subscribers',
    'subscriber',
    'judges',
    'judge',
    'budget',
    'deliveries',
    'delivery',
    'held',
    'queue',
    'lane',
    'messages',
    'message',
    'provider',
    'integration',
    'session-queue',
    'projects',
    'project',
    'runs',
    'collection',
  ]) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }

  const { server } = await createEventsMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-daemon-runtime-parity', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(
      names,
      [
        'events_catalogue_list',
        'events_catalogue_show',
        'events_workflow_events_list',
        'events_workflow_events_show',
        'events_approval_view',
        'events_rule_test',
        'events_target_test',
        'events_subscribers_list',
        'events_subscriber_add',
        'events_subscriber_update',
        'events_subscriber_remove',
        'events_subscriber_enable',
        'events_judges_list',
        'events_judge_show',
        'events_judge_add',
        'events_judge_update',
        'events_judge_remove',
        'events_judge_test',
        'events_budget_show',
        'events_budget_update',
        'events_judge_kinds_list',
        'events_judge_kind_enable',
        'events_judge_kind_disable',
        'events_judge_model_status',
        'events_judge_model_remove',
        'events_deliveries_list',
        'events_delivery_retry',
        'events_delivery_drop',
        'events_held_list',
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
        'events_queue_items',
        'events_queue_counts',
        'events_queue_done',
        'events_queue_dismiss',
        'events_queue_reopen',
        'events_lane_whoami',
        'events_lane_list',
        'events_lane_unbind',
        'events_watch',
        'events_wait',
        'events_lane_item',
        'events_provider_list',
        'events_session_queue_list',
      ].sort(),
    );
    for (const personal of [
      'events_judge_setup',
      'events_provider_key_set',
      'events_provider_key_remove',
      'events_integration_show',
      'events_integration_set',
      'events_session_queue_drop',
    ])
      assert.ok(
        !names.includes(personal),
        `${personal}: judge setup and AI provider keys are the person's, in the app or at a terminal (2026-10-26)`,
      );
    assert.ok(
      !names.some((name) => /project/u.test(name)),
      'projects are the person’s: no MCP tool reads or changes one (0.36.0 §8.1, §10.1)',
    );
    assert.ok(
      !names.some((name) => /_runs?(?:_|$)/u.test(name)),
      'a workflow’s runs are the person’s: no MCP tool lists, shows or cancels one (0.36.0 §7.6, §10.1)',
    );
    assert.ok(!names.includes('events_lane_bind'), 'binding a lane is the person’s act at a terminal (routing B1)');
    assert.ok(
      !names.some((name) => /message/u.test(name)),
      'what happened to each message is the person’s view: no MCP tool reads it (0.32.0 §3.6, §4)',
    );
    for (const contentRead of ['events_queue_list', 'events_queue_show', 'events_queue_clear'])
      assert.ok(
        !names.includes(contentRead),
        `${contentRead}: no MCP tool reads what a queue item says or clears the person's queue`,
      );
    assert.ok(!names.includes('events_run'), 'the owner-starting command is not an MCP tool');
    assert.ok(!names.includes('events_approve'), 'standing disclosure approval is terminal-only');
    assert.ok(!names.includes('events_dryrun_list'), 'retained local content has no MCP selection surface');
    assert.ok(
      !names.includes('events_delivery_show'),
      "one delivery's details are the person's, at a terminal or in the app (0.32.0, §3.5)",
    );
    await assert.rejects(
      client.callTool({ name: 'events_dryrun_show', arguments: { deliveryId: 'delivery-1' } }),
      /not found/,
      'direct model-context invocation is rejected because no tool is registered',
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
