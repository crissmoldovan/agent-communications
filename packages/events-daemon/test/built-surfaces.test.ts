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

test('BOOT-B1: the built command has clean help and its MCP server exposes only the content-free control tools', async () => {
  const state = await mkdtemp(join(tmpdir(), 'events-daemon-state-'));
  try {
    const env = { ...process.env, AGENT_COMMS_STATE_DIR: state, NO_COLOR: '1' };
    const help = await run(process.execPath, [CLI, '--help'], { env });
    assert.match(help.stdout, /Usage: agent-events/);
    assert.doesNotMatch(help.stdout, /ExperimentalWarning/, 'the command keeps its user-facing output on stdout clean');

    if (WINDOWS_SKIP) {
      // B1-G: on Windows the service refuses by name rather than reaching for a pipe it cannot protect.
      await assert.rejects(run(process.execPath, [CLI, '--json', 'status'], { env }), (error: unknown) => {
        const failed = error as { code?: number; stderr?: string };
        assert.equal(failed.code, 78);
        assert.match(failed.stderr ?? '', /does not run on Windows in this release/);
        return true;
      });
    } else {
      const status = await run(process.execPath, [CLI, '--json', 'status'], { env });
      assert.equal(status.stdout, '{"owner":"not-running"}\n');
    }

    const client = new Client({ name: 'events-daemon-built-test', version: '0' });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env, stderr: 'ignore' }),
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
        ],
      );
    } finally {
      await client.close();
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
