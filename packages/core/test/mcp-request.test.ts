import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { openCore } from '../src/core.ts';
import type { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { activityClient, envelopeClient, requestClient, toolRequestClient } from '../src/mcp-request.ts';
import { strictToolArguments } from '../src/tool-arguments.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Who a request comes from, in both protocol eras (single-server design D7; the spike's finding 3): a 2026-07-28
 * request's own envelope first, then what the client said in `initialize`. Under `serveStdio` on 2026-07-28 the SDK
 * never sets `getClientVersion()`, so a server that read only that saw no client on every modern request.
 */

const ERAS = [
  { mode: 'legacy', version: '2025-11-25' },
  { mode: 'auto', version: '2026-07-28' },
] as const;
const CLIENT = { name: 'claude-code', version: '2.1.310' };

test('the envelope names the client first; what the client said on connecting is read only where it names none', () => {
  const modern = { mcpReq: { envelope: { 'io.modelcontextprotocol/clientInfo': CLIENT } } };
  assert.deepEqual(envelopeClient(modern), CLIENT);
  assert.deepEqual(
    requestClient(modern, () => ({ name: 'stale', version: '1' })),
    CLIENT,
  );
  assert.deepEqual(
    requestClient({ mcpReq: {} }, () => ({ name: 'codex', version: '0.1' })),
    { name: 'codex', version: '0.1' },
  );
  // A client with no name is no client, wherever it came from; a version that is not text is left out.
  assert.equal(
    requestClient({ mcpReq: { envelope: { 'io.modelcontextprotocol/clientInfo': { name: '' } } } }),
    undefined,
  );
  assert.deepEqual(
    requestClient(undefined, () => ({ name: 'cursor', version: 7 })),
    { name: 'cursor' },
  );
  assert.equal(
    requestClient(undefined, () => undefined),
    undefined,
  );
});

/** A server whose one tool answers with the client its activity line would name: the ALS scope, then the accessor. */
function whoServer(): McpServer {
  const server = new McpServer({ name: 'who', version: '1' }, { capabilities: { tools: {} } });
  strictToolArguments(server, (error: CommsError) => ({
    isError: true,
    content: [{ type: 'text' as const, text: error.message }],
  }));
  const named = activityClient(() => server.server.getClientVersion());
  server.registerTool('who_am_i', { description: 'who', inputSchema: { nested: z.string().optional() } }, async () => {
    // Read after an await, as an operation's activity line is written once its work is done.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      content: [{ type: 'text' as const, text: 'who' }],
      structuredContent: { scoped: toolRequestClient() ?? null, recorded: named() ?? null },
    };
  });
  return server;
}

for (const { mode, version } of ERAS) {
  test(`P0 (${version}): a tool's activity line names the client of the request it handles`, async (t) => {
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => whoServer(), { transport: serverTransport, onerror: () => undefined });
    const client = new Client(CLIENT, { versionNegotiation: { mode } });
    await client.connect(clientTransport);
    t.after(async () => {
      await client.close().catch(() => undefined);
      await handle.close();
    });
    assert.equal(client.getNegotiatedProtocolVersion(), version);
    const answer = (await client.callTool({ name: 'who_am_i', arguments: {} })) as {
      structuredContent: { scoped: unknown; recorded: unknown };
    };
    assert.deepEqual(answer.structuredContent.recorded, CLIENT, 'the activity context names the client');
    // On 2026-07-28 it comes from the request's own envelope; on 2025-11-25 from `initialize`, which has no envelope.
    assert.deepEqual(answer.structuredContent.scoped, mode === 'auto' ? CLIENT : null);
    // Outside a call there is no request, and so no client of one.
    assert.equal(toolRequestClient(), undefined);
  });

  test(`P0 (${version}): the core server serves either era through serveStdio, and comms_activity answers`, async (t) => {
    const home = tempDir('comms-eras-');
    const configDir = join(home, 'config');
    mkdirSync(configDir);
    const env = {
      HOME: home,
      USERPROFILE: home,
      PATH: join(home, 'bin'),
      AGENT_COMMS_CONFIG_DIR: configDir,
      AGENT_COMMS_STATE_DIR: join(home, 'state'),
      AGENT_COMMS_CLIENT_CLI_DIRS: '',
      AGENT_COMMS_UPDATE_CHECK: 'off',
      NO_COLOR: '1',
    };
    const core = openCore({ env, caller: CORE_CALLER });
    const built = await createCoreMcpServer({ core, env, keyring: null, platform: 'darwin' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = await built.serve(serverTransport);
    const client = new Client(CLIENT, { versionNegotiation: { mode } });
    await client.connect(clientTransport);
    t.after(async () => {
      await client.close().catch(() => undefined);
      await handle.close();
    });
    assert.equal(client.getNegotiatedProtocolVersion(), version);
    const mine = (await client.callTool({ name: 'comms_activity', arguments: {} })) as {
      isError?: boolean;
      structuredContent?: { session?: { surface?: string } };
    };
    assert.notEqual(mine.isError, true, JSON.stringify(mine.structuredContent));
    assert.equal(mine.structuredContent?.session?.surface, 'mcp');
  });
}
