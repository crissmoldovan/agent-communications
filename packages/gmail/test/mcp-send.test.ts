import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { GmailContext } from '../src/context.ts';
import { createGmailMcpServer } from '../src/mcp/server.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * Sending through MCP, including the one channel a model cannot answer.
 *
 * The elicitation path is the strongest claim this package makes — "under `confirm`, no argument an agent can pass
 * will send" — so it is tested through a real client, with the client answering the form the way a person would, and
 * the way a careless client would.
 */

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function connect(
  harness: Harness,
  options: { clientName?: string; answer?: (message: string) => string | null } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const built = await createGmailMcpServer({ core: harness.core, env: harness.env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: options.clientName ?? 'test-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } },
  );
  if (options.answer) {
    // A client that shows the form to a person: it reads the code out of the message and sends back what they type.
    client.setRequestHandler('elicitation/create', async (request) => {
      const typed = options.answer?.(request.params.message) ?? null;
      if (typed === null) return { action: 'decline' as const };
      return { action: 'accept' as const, content: { code: typed } };
    });
  }
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await built.close();
    },
  };
}

async function mailbox(sendPolicy: 'chat' | 'confirm'): Promise<Harness> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo', isDefault: true, isPrimary: true }],
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

async function draftId(harness: Harness): Promise<string> {
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const draft = await createDraft(context, 'work', {
    to: ['sam@partner.test'],
    subject: 'Tuesday',
    text: 'Tuesday works.',
  });
  return draft.draftId;
}

test('an agent prepares, shows the preview, and sends exactly what it showed', async () => {
  const harness = await mailbox('chat');
  const id = await draftId(harness);
  const { client, close } = await connect(harness);
  try {
    const prepared = (await client.callTool({
      name: 'gmail_send_prepare',
      arguments: { inbox: 'work', draftId: id },
    })) as ToolResult;
    const preparation = prepared.structuredContent as { approvalId: string; preview: string; expect: unknown };
    assert.match(preparation.preview, /SEND PREVIEW/);
    assert.match(preparation.preview, /Tuesday works\./);

    const sent = (await client.callTool({
      name: 'gmail_draft_send',
      arguments: {
        inbox: 'work',
        draftId: id,
        approvalId: preparation.approvalId,
        expect: preparation.expect,
      },
    })) as ToolResult;
    assert.ok(!sent.isError, JSON.stringify(sent.structuredContent));
    assert.ok((sent.structuredContent as { sentMessageId: string }).sentMessageId);
  } finally {
    await close();
  }
});

test('under confirm, an un-allowlisted client is refused and told where to go', async () => {
  const harness = await mailbox('confirm');
  const id = await draftId(harness);
  const { client, close } = await connect(harness);
  try {
    const prepared = (await client.callTool({
      name: 'gmail_send_prepare',
      arguments: { inbox: 'work', draftId: id },
    })) as ToolResult;
    const preparation = prepared.structuredContent as { approvalId: string; expect: unknown };

    const refused = (await client.callTool({
      name: 'gmail_draft_send',
      arguments: { inbox: 'work', draftId: id, approvalId: preparation.approvalId, expect: preparation.expect },
    })) as ToolResult;
    assert.equal(refused.isError, true);
    const error = (refused.structuredContent as { error: { code: string; hint: string } }).error;
    assert.equal(error.code, 'APPROVAL_REQUIRED');
    assert.match(error.hint, /agent-gmail approve/);
    assert.match(error.hint, /not on the list/);

    // And the approval is still there: being asked from the wrong client says nothing about the message.
    const listed = (await client.callTool({ name: 'gmail_send_list', arguments: {} })) as ToolResult;
    const approvals = (listed.structuredContent as { approvals: Array<{ state: string }> }).approvals;
    assert.equal(approvals[0]?.state, 'pending');
  } finally {
    await close();
  }
});

test('a client on the list raises a form, and only the typed code sends', async () => {
  const harness = await mailbox('confirm');
  const id = await draftId(harness);
  // The user probed this client and then added it at a terminal; here, that has already happened.
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const { startProbe, completeProbe, addConfirmClient } = await import('../src/operations/confirm-clients.ts');
  const probe = await startProbe(context, 'trusted-client');
  await completeProbe(context, probe.probeId);
  await addConfirmClient(context, 'trusted-client', {
    kind: 'loosening-consent',
    paths: ['defaults.confirm.elicitationClients'],
  });

  // A client that answers the form without showing it to anybody: the wrong code, so nothing is sent.
  const careless = await connect(harness, { clientName: 'trusted-client', answer: () => 'yes' });
  try {
    const prepared = (await careless.client.callTool({
      name: 'gmail_send_prepare',
      arguments: { inbox: 'work', draftId: id },
    })) as ToolResult;
    const preparation = prepared.structuredContent as { approvalId: string; expect: unknown };
    const refused = (await careless.client.callTool({
      name: 'gmail_draft_send',
      arguments: { inbox: 'work', draftId: id, approvalId: preparation.approvalId, expect: preparation.expect },
    })) as ToolResult;
    assert.equal(refused.isError, true, 'a form answered without reading it does not send anything');
  } finally {
    await careless.close();
  }

  // A client that shows it: the person reads the code out of the message and types it back.
  const real = await connect(harness, {
    clientName: 'trusted-client',
    answer: (message) => /Type ([A-Za-z0-9_-]{4}) to send/.exec(message)?.[1] ?? '',
  });
  try {
    const prepared = (await real.client.callTool({
      name: 'gmail_send_prepare',
      arguments: { inbox: 'work', draftId: id },
    })) as ToolResult;
    const preparation = prepared.structuredContent as { approvalId: string; expect: unknown };
    const sent = (await real.client.callTool({
      name: 'gmail_draft_send',
      arguments: { inbox: 'work', draftId: id, approvalId: preparation.approvalId, expect: preparation.expect },
    })) as ToolResult;
    assert.ok(!sent.isError, JSON.stringify(sent.structuredContent));
    assert.ok((sent.structuredContent as { sentMessageId: string }).sentMessageId);
  } finally {
    await real.close();
  }
});

test('adding a client to the list needs a probe a person answered', async () => {
  const harness = await mailbox('confirm');
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const { addConfirmClient, startProbe } = await import('../src/operations/confirm-clients.ts');
  const consent = { kind: 'loosening-consent' as const, paths: ['defaults.confirm.elicitationClients'] };

  await assert.rejects(addConfirmClient(context, 'never-probed', consent), /has not shown/);
  // A probe raised but never answered is evidence of nothing.
  await startProbe(context, 'half-probed');
  await assert.rejects(addConfirmClient(context, 'half-probed', consent), /has not shown/);
});
