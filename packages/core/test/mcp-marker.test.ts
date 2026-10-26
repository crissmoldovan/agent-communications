import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MCP_SERVER_MARKER } from '../src/mcp-marker.ts';
import { runMain } from './helpers/main-in-process.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * 0.32.0 (design 2026-10-26-owner-feedback-0320 §4): core's MCP server marks its own process as it starts, so every
 * program it starts inherits the mark, and the person's reads — `agentcomms activity items` among them — refuse there.
 * The server itself is a stand-in: nothing here opens stdio.
 */

test('agentcomms mcp marks its process as core’s MCP server before it serves, and activity items refuses there', async () => {
  const home = tempDir('comms-marker-');
  mkdirSync(join(home, 'config'));
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    NO_COLOR: '1',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  let seen: string | undefined;
  const served = await runMain(['mcp'], env, process.platform, {
    startMcp: async ({ env: given }) => {
      seen = given[MCP_SERVER_MARKER];
    },
  });
  assert.equal(served.code, 0, served.stderr);
  assert.equal(seen, 'core', 'marked before the server starts');
  assert.equal(env[MCP_SERVER_MARKER], 'core', 'in the environment its children inherit');

  const read = await runMain(['activity', 'items', '--json'], env, process.platform);
  assert.equal(read.code, 10, read.stdout);
});
