import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const run = promisify(execFile);
const PACKAGE = new URL('..', import.meta.url).pathname;
const CLI = join(PACKAGE, 'dist', 'cli.mjs');
const PRELOAD = new URL('../../../test/helpers/loopback-seal-preload.mjs', import.meta.url).pathname;

test('BOOT-B1/B3: the built command has clean help and its MCP server exposes the paired content-free control tools', async () => {
  const state = await mkdtemp(join(tmpdir(), 'events-daemon-state-'));
  try {
    const env = { ...process.env, AGENT_COMMS_STATE_DIR: state, NO_COLOR: '1' };
    const help = await run(process.execPath, ['--import', PRELOAD, CLI, '--help'], { env });
    assert.match(help.stdout, /Usage: agent-events/);
    assert.doesNotMatch(help.stdout, /ExperimentalWarning/, 'the command keeps its user-facing output on stdout clean');
    assert.doesNotMatch(
      help.stdout,
      /^\s+migrate\b|^\s+target (?:resume|replay)\b|^\s+held decide\b/m,
      'the built CLI keeps B3 human-only secret/resume/held-decision controls out of its paired boundary',
    );

    if (WINDOWS_SKIP) {
      // B1-G: on Windows the service refuses by name rather than reaching for a pipe it cannot protect.
      await assert.rejects(
        run(process.execPath, ['--import', PRELOAD, CLI, '--json', 'status'], { env }),
        (error: unknown) => {
          const failed = error as { code?: number; stderr?: string };
          assert.equal(failed.code, 78);
          assert.match(failed.stderr ?? '', /does not run on Windows in this release/);
          return true;
        },
      );
    } else {
      const status = await run(process.execPath, ['--import', PRELOAD, CLI, '--json', 'status'], { env });
      assert.equal(status.stdout, '{"owner":"not-running"}\n');
    }

    const client = new Client({ name: 'events-daemon-built-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', PRELOAD, CLI, 'mcp'],
        env,
        stderr: 'ignore',
      }),
    );
    try {
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name),
        [
          'events_status',
          'events_stop',
          'events_pause',
          'events_resume',
          'events_disable_all',
          'events_enable_all',
          'events_doctor',
          'events_catalogue_list',
          'events_approval_view',
          'events_rule_test',
          'events_target_test',
          'events_subscribers_list',
          'events_subscriber_add',
          'events_subscriber_update',
          'events_subscriber_remove',
          'events_judges_list',
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
        ],
      );
    } finally {
      await client.close();
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
