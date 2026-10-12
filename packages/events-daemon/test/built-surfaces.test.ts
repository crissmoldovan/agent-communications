import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
const PRELOAD = new URL('../../../test/helpers/loopback-seal-preload.mjs', import.meta.url).href;
const ROOT = new URL('../../..', import.meta.url).pathname;

/** A copied repository makes `sync-reference --check` read the mutant rather than the worktree. Installed modules are
 * immutable test infrastructure, so only their root is linked; source, package declarations, skills, and generated
 * pages are copied. */
async function referenceFixture(): Promise<{ readonly root: string; readonly parent: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'events-daemon-reference-fixture-'));
  const root = join(parent, 'repository');
  const skip = (source: string) =>
    !source
      .split('/')
      .some((part) => part === '.git' || part === 'node_modules' || part === 'dist' || part === '.mutants');
  for (const path of [
    'scripts',
    'packages',
    'skills',
    'docs/reference',
    'docs/skills.md',
    'capabilities.json',
    'package.json',
  ])
    await cp(join(ROOT, path), join(root, path), { recursive: true, filter: skip });
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await symlink(
      join(ROOT, 'packages', entry.name, 'node_modules'),
      join(root, 'packages', entry.name, 'node_modules'),
      'dir',
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { root, parent };
}

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

test('PAR-B3: the production reference generator rejects a fixture copy with a removed daemon command', async () => {
  const fixture = await referenceFixture();
  try {
    const page = join(fixture.root, 'docs/reference/events-daemon-cli.md');
    const source = await readFile(page, 'utf8');
    const commandAt = source.indexOf('### `agent-events rule test`\n');
    assert.notEqual(commandAt, -1, 'the generated page contains the paired rule-test command');
    const nextCommandAt = source.indexOf('\n### `', commandAt + 1);
    const changed = source.slice(0, commandAt) + source.slice(nextCommandAt === -1 ? source.length : nextCommandAt + 1);
    assert.notEqual(changed, source, 'the reference-command mutant removes the generated rule-test section');
    await writeFile(page, changed);
    await assert.rejects(
      run(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          'scripts/sync-reference.mjs',
          '--check',
        ],
        {
          cwd: fixture.root,
        },
      ),
      (error: unknown) => {
        const failed = error as { readonly code?: number; readonly stderr?: string };
        assert.equal(failed.code, 1);
        assert.match(failed.stderr ?? '', /out of date: docs\/reference\/events-daemon-cli\.md/u);
        return true;
      },
      'the generated-reference command cannot be deleted without the generator detecting drift',
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
