import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createResendMcpServer } from '../src/mcp/server.ts';
import { newHarness } from './support/harness.ts';

/*
 * The Resend server in both protocol eras (single-server design D6): `serve` is `serveStdio` over a transport, as
 * `connectStdio` serves stdio, so a 2025-11-25 client and a 2026-07-28 one each get the same tools.
 */

for (const { mode, version } of [
  { mode: 'legacy', version: '2025-11-25' },
  { mode: 'auto', version: '2026-07-28' },
] as const) {
  test(`P0 (${version}): the Resend server serves this era through serveStdio, with every tool it registers`, async (t) => {
    const harness = await newHarness();
    const built = await createResendMcpServer({
      core: harness.core,
      env: harness.env,
      fetch: harness.fake.fetch,
      throttle: { intervalMs: 0 },
      platform: 'darwin',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = await built.serve(serverTransport);
    const client = new Client({ name: 'claude-code', version: '2.1.310' }, { versionNegotiation: { mode } });
    await client.connect(clientTransport);
    t.after(async () => {
      await client.close().catch(() => undefined);
      await handle.close();
      // The harness's loopback Resend, which keeps the process alive until it is closed.
      await harness.close();
    });
    assert.equal(client.getNegotiatedProtocolVersion(), version);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.length > 3 && names.every((name) => name.startsWith('resend_')), names.join(', '));
  });
}
