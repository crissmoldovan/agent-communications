import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { newHarness } from './support/harness.ts';

/*
 * The Slack server in both protocol eras (single-server design D6): `serve` is `serveStdio` over a transport, as
 * `connectStdio` serves stdio, so a 2025-11-25 client and a 2026-07-28 one each get the same tools.
 */

for (const { mode, version } of [
  { mode: 'legacy', version: '2025-11-25' },
  { mode: 'auto', version: '2026-07-28' },
] as const) {
  test(`P0 (${version}): the Slack server serves this era through serveStdio, with every tool it registers`, async (t) => {
    const harness = await newHarness();
    const built = await createSlackMcpServer({
      core: harness.core,
      env: harness.env,
      platform: 'darwin',
      notify: null,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = await built.serve(serverTransport);
    const client = new Client({ name: 'claude-code', version: '2.1.310' }, { versionNegotiation: { mode } });
    await client.connect(clientTransport);
    t.after(async () => {
      await client.close().catch(() => undefined);
      await handle.close();
    });
    assert.equal(client.getNegotiatedProtocolVersion(), version);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('slack_post_prepare') && names.includes('slack_read'), names.join(', '));
    assert.ok(names.every((name) => name.startsWith('slack_')));
    assert.match(client.getInstructions() ?? '', /untrusted-content/);
  });
}
