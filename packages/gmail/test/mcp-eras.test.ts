import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActivityLine } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { GmailContext } from '../src/context.ts';
import { createGmailMcpServer } from '../src/mcp/server.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { type Harness, newHarness } from './support/harness.ts';

/*
 * The client a Gmail server sees, in both protocol eras (single-server design D6, D7, and the spike's finding 3).
 *
 * On 2025-11-25 a client names itself in `initialize`; on 2026-07-28 every request names it in its own envelope, and
 * `serveStdio` never sets `getClientVersion()`. Gmail offers a `confirm` send's approval form only to a client the
 * person chose to trust, by that name, and every activity line names it: read from the accessor alone, a modern client
 * got no form and its calls no client. Each test runs in both eras, through `serve` — `serveStdio` over an in-memory
 * transport, as `connectStdio` serves stdio.
 */

const ERAS = [
  { mode: 'legacy', version: '2025-11-25' },
  { mode: 'auto', version: '2026-07-28' },
] as const;

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function mailbox(sendPolicy: 'chat' | 'confirm'): Promise<Harness> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo', isDefault: true, isPrimary: true }],
        messages: {
          m1: {
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX'],
            snippet: 'the invoice',
            internalDate: String(Date.parse('2026-10-20T09:00:00Z')),
            payload: {
              partId: '',
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Sam Lee <sam@partner.test>' },
                { name: 'Subject', value: 'Invoice March' },
              ],
              body: { size: 4, data: Buffer.from('body', 'utf8').toString('base64url') },
            },
          },
        },
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy });
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, riskEscalation: false } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation'] } },
  );
  return harness;
}

/** The person probed `name` and added it to the clients trusted with forms, at a terminal, before the test. */
async function trust(harness: Harness, name: string): Promise<void> {
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const { startProbe, completeProbe, addConfirmClient } = await import('../src/operations/confirm-clients.ts');
  const probe = await startProbe(context, name);
  await completeProbe(context, probe.probeId);
  await addConfirmClient(context, name, { kind: 'loosening-consent', paths: ['defaults.confirm.elicitationClients'] });
}

/** A client connected through `serve` in `mode`, answering each form with the code it shows. */
async function connect(
  harness: Harness,
  mode: (typeof ERAS)[number]['mode'],
  clientName: string,
): Promise<{ client: Client; asked: string[]; close: () => Promise<void> }> {
  const built = await createGmailMcpServer({ core: harness.core, env: harness.env, platform: 'darwin' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const served = await built.serve(serverTransport);
  const client = new Client(
    { name: clientName, version: '2.1.310' },
    { versionNegotiation: { mode }, capabilities: { elicitation: { form: {} } } },
  );
  const asked: string[] = [];
  client.setRequestHandler('elicitation/create', async (request) => {
    const message = String((request.params as { message?: unknown }).message ?? '');
    asked.push(message);
    const code = /Type ([A-Za-z0-9_-]{4}) to send/.exec(message)?.[1] ?? '';
    return { action: 'accept' as const, content: { code } };
  });
  await client.connect(clientTransport);
  return {
    client,
    asked,
    close: async () => {
      await client.close().catch(() => undefined);
      await served.close();
      await built.close();
    },
  };
}

async function prepared(client: Client, harness: Harness): Promise<string> {
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Tuesday.' });
  const result = (await client.callTool({
    name: 'gmail_send_prepare',
    arguments: { inbox: 'work', draftId: draft.draftId },
  })) as ToolResult;
  return (result.structuredContent as { approvalId: string }).approvalId;
}

const sends = (harness: Harness) => harness.google.requests.filter((request) => request.path.endsWith('/send')).length;

async function activityLines(harness: Harness): Promise<ActivityLine[]> {
  const directory = harness.core.activity.directory;
  const days = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.jsonl')).sort();
  const texts = await Promise.all(days.map((day) => readFile(join(directory, day), 'utf8')));
  return texts
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActivityLine);
}

for (const { mode, version } of ERAS) {
  test(`P0 (${version}): a client the person trusts is shown a confirm send's form, and the typed code sends it once`, async () => {
    const harness = await mailbox('confirm');
    await trust(harness, 'trusted-client');
    const { client, asked, close } = await connect(harness, mode, 'trusted-client');
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), version);
      const approvalId = await prepared(client, harness);
      const sent = (await client.callTool({
        name: 'gmail_draft_send',
        arguments: { inbox: 'work', approvalId },
      })) as ToolResult;
      assert.notEqual(sent.isError, true, JSON.stringify(sent.structuredContent));
      assert.equal(asked.length, 1, 'the form was raised once, to this client');
      assert.match(asked[0] ?? '', /SEND PREVIEW/);
      assert.equal(sends(harness), 1);
    } finally {
      await close();
    }
  });

  test(`P0 (${version}): a client the person does not trust gets no form, and is told to approve at a terminal`, async () => {
    const harness = await mailbox('confirm');
    await trust(harness, 'trusted-client');
    const { client, asked, close } = await connect(harness, mode, 'another-client');
    try {
      const approvalId = await prepared(client, harness);
      const refused = (await client.callTool({
        name: 'gmail_draft_send',
        arguments: { inbox: 'work', approvalId },
      })) as ToolResult;
      assert.equal(refused.isError, true);
      assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'APPROVAL_REQUIRED');
      assert.equal(asked.length, 0);
      assert.equal(sends(harness), 0);
    } finally {
      await close();
    }
  });

  test(`P0 (${version}): an activity line names the client the call came from`, async () => {
    const harness = await mailbox('chat');
    const { client, close } = await connect(harness, mode, 'claude-code');
    try {
      const found = (await client.callTool({
        name: 'gmail_search',
        arguments: { inboxes: ['work'], query: 'invoice' },
      })) as ToolResult;
      assert.notEqual(found.isError, true, JSON.stringify(found.structuredContent));
      const line = (await activityLines(harness)).find((each) => each.operation === 'gmail.search');
      assert.ok(line, 'the search was recorded');
      assert.equal(line.session.surface, 'mcp');
      assert.deepEqual(line.session.client, { name: 'claude-code', version: '2.1.310' });
    } finally {
      await close();
    }
  });
}
