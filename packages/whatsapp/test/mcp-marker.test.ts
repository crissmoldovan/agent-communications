import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { MCP_SERVER_MARKER } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';

/*
 * 0.32.0 (design 2026-10-26-owner-feedback-0320 §4): WhatsApp's MCP server marks its own process as it starts, so every
 * program it starts inherits the mark, and the person's reads — `agentcomms activity items`, the event service's queue
 * and messages — refuse there. The server is a stand-in (`startMcp`): nothing here opens stdio or reaches WhatsApp.
 */

test('`agent-whatsapp mcp` marks its process as WhatsApp’s MCP server before the server starts', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'agent-whatsapp-marker-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_SECRETS_DIR: join(home, 'secrets'),
    AGENT_COMMS_UPDATE_CHECK: 'off',
    NO_COLOR: '1',
  };
  let seen: string | undefined;
  const code = await run(['mcp'], {
    env,
    platform: 'darwin',
    streams: { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() },
    startMcp: async (options) => {
      seen = options.env?.[MCP_SERVER_MARKER];
    },
  });
  assert.equal(code, 0);
  assert.equal(seen, 'whatsapp', 'marked before the server starts');
  assert.equal(env[MCP_SERVER_MARKER], 'whatsapp', 'in the environment every program it starts inherits');
});
