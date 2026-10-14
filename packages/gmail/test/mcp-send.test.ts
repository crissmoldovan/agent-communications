import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalStore, asV2 } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { GmailContext } from '../src/context.ts';
import { createGmailMcpServer } from '../src/mcp/server.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { locatedGmailLine } from './support/handoffs.ts';
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
  options: {
    clientName?: string;
    answer?: (message: string) => string | null;
    /** What the person does with a form they do not answer with a code: decline it (the default), or cancel it. */
    refuse?: 'decline' | 'cancel';
  } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  // POSIX-pinned, as the shared `connect` pins it: a refusal's command is read back with `locatedGmailLine`, a POSIX
  // reader. On Windows the server's own shell quotes this Node's path otherwise.
  const built = await createGmailMcpServer({ core: harness.core, env: harness.env, platform: 'darwin' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: options.clientName ?? 'test-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } },
  );
  if (options.answer) {
    // A client that shows the form to a person: it reads the code out of the message and sends back what they type.
    client.setRequestHandler('elicitation/create', async (request) => {
      const typed = options.answer?.(request.params.message) ?? null;
      if (typed === null) return { action: options.refuse ?? ('decline' as const) };
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
        approvalId: preparation.approvalId,
      },
    })) as ToolResult;
    assert.ok(!sent.isError, JSON.stringify(sent.structuredContent));
    assert.ok((sent.structuredContent as { sentMessageId: string }).sentMessageId);
  } finally {
    await close();
  }
});

test('gmail_draft_send accepts the approval id without a draft id or expect block', async () => {
  const harness = await mailbox('chat');
  const id = await draftId(harness);
  const { client, close } = await connect(harness);
  try {
    const prepared = (await client.callTool({
      name: 'gmail_send_prepare',
      arguments: { inbox: 'work', draftId: id },
    })) as ToolResult;
    const approvalId = (prepared.structuredContent as { approvalId: string }).approvalId;
    const sent = (await client.callTool({
      name: 'gmail_draft_send',
      arguments: { inbox: 'work', approvalId },
    })) as ToolResult;
    assert.notEqual(sent.isError, true, `approval-id-only Gmail MCP send succeeds: ${JSON.stringify(sent)}`);
    assert.equal(
      harness.google.requests.filter((request) => request.path.endsWith('/send')).length,
      1,
      'approval-id-only Gmail MCP execution reaches the fake once',
    );
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
    const preparation = prepared.structuredContent as { approvalId: string; expect: unknown; nextStep: string };
    // What follows the prepare names the person's command and the wait, so nobody has to relay the approval.
    locatedGmailLine(preparation.nextStep, ['approve', preparation.approvalId]);
    assert.match(preparation.nextStep, /learn when they have with gmail_send_wait/);

    const refused = (await client.callTool({
      name: 'gmail_draft_send',
      arguments: { inbox: 'work', approvalId: preparation.approvalId },
    })) as ToolResult;
    assert.equal(refused.isError, true);
    const error = (refused.structuredContent as { error: { code: string; hint: string } }).error;
    assert.equal(error.code, 'APPROVAL_REQUIRED');
    // Complete, and where to go (D5-a): the person's terminal command, and the wait that learns the result.
    const command = locatedGmailLine(error.hint, ['approve', preparation.approvalId]);
    assert.equal(
      error.hint,
      `This needs your approval outside the chat: run \`${command}\` in a terminal, and I will wait with gmail_send_wait.`,
    );
    // The trust list is not advertised, and no client is said to reach a person.
    assert.doesNotMatch(error.hint, /known to reach a person|not on the list|trust|confirm-clients|gmail_confirm/i);

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
      arguments: { inbox: 'work', approvalId: preparation.approvalId },
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
      arguments: { inbox: 'work', approvalId: preparation.approvalId },
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

// ── Whose and what before a route, and where the approval stands (CUE-404 Task 9; §D2, §D8) ──────────────────────

test('gmail_draft_send finds another mailbox’s or another kind’s approval as the one NOT_FOUND before choosing a route: no form is raised (D2-b)', async () => {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: 'confirm' });
  await harness.connectInbox({ alias: 'home', email: 'sam@example.test', sub: 'sub-2', sendPolicy: 'confirm' });
  await harness.core.config.update(
    (config) => ({
      ...config,
      defaults: {
        ...config.defaults,
        riskEscalation: false,
        confirm: { ...config.defaults.confirm, elicitationClients: ['trusted-client'] },
      },
    }),
    {
      consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation', 'defaults.confirm.elicitationClients'] },
    },
  );
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const homeDraft = await createDraft(context, 'home', { to: ['kim@partner.test'], subject: 'Home', text: 'Hi.' });
  let forms = 0;
  const { client, close } = await connect(harness, {
    clientName: 'trusted-client',
    answer: () => {
      forms += 1;
      return null;
    },
  });
  try {
    const home = (
      await client.callTool({ name: 'gmail_send_prepare', arguments: { inbox: 'home', draftId: homeDraft.draftId } })
    ).structuredContent as { approvalId: string; expect: unknown };
    const change = await harness.core.approvals.createChange({
      channel: 'gmail',
      change: { summary: 'x', target: null, loosened: [], effects: ['does a thing'] },
      policy: 'chat',
    });
    const envelopes = [];
    for (const approvalId of [`ap_${'7'.repeat(26)}`, home.approvalId, change.approvalId]) {
      const refused = (await client.callTool({
        name: 'gmail_draft_send',
        arguments: { inbox: 'work', approvalId },
      })) as ToolResult;
      const error = (
        refused.structuredContent as { error: { code: string; message: string; hint: string; details: unknown } }
      ).error;
      assert.equal(error.code, 'NOT_FOUND', JSON.stringify(error));
      assert.deepEqual(error.details, { approval: null });
      envelopes.push(JSON.stringify(error).replaceAll(approvalId, 'ID'));
    }
    assert.equal(new Set(envelopes).size, 1, 'one envelope, byte for byte');
    assert.equal(forms, 0, 'no form was raised for another mailbox’s send');
    assert.equal(harness.google.requests.filter((request) => request.path.endsWith('/send')).length, 0);
  } finally {
    await close();
  }
});

test('the send tools say where the approval stands: prepared, refused for a person outside the chat, and sent (D8o-a)', async () => {
  const harness = await mailbox('confirm');
  const id = await draftId(harness);
  const { client, close } = await connect(harness);
  try {
    const prepared = (await client.callTool({ name: 'gmail_send_prepare', arguments: { inbox: 'work', draftId: id } }))
      .structuredContent as { approvalId: string; expect: unknown; approval: Record<string, unknown> };
    assert.equal(prepared.approval.id, prepared.approvalId);
    assert.equal(prepared.approval.state, 'pending');
    assert.equal(prepared.approval.route, 'confirm');
    assert.equal(prepared.approval.claimable, false);
    // An untrusted client: refused, with the approval as it stands — still pending, and left alone.
    const refused = (await client.callTool({
      name: 'gmail_draft_send',
      arguments: { inbox: 'work', approvalId: prepared.approvalId },
    })) as ToolResult;
    const error = (
      refused.structuredContent as { error: { code: string; details: { approval: Record<string, unknown> } } }
    ).error;
    assert.equal(error.code, 'APPROVAL_REQUIRED');
    assert.equal(error.details.approval.state, 'pending');
    assert.equal(error.details.approval.claimable, false);
  } finally {
    await close();
  }

  const chat = await mailbox('chat');
  const chatDraft = await draftId(chat);
  const chatClient = await connect(chat);
  try {
    const prepared = (
      await chatClient.client.callTool({ name: 'gmail_send_prepare', arguments: { inbox: 'work', draftId: chatDraft } })
    ).structuredContent as { approvalId: string; expect: unknown; approval: Record<string, unknown> };
    assert.equal(prepared.approval.claimable, true);
    const sent = (
      await chatClient.client.callTool({
        name: 'gmail_draft_send',
        arguments: { inbox: 'work', approvalId: prepared.approvalId },
      })
    ).structuredContent as { sentMessageId: string; approval: Record<string, unknown> };
    assert.equal(sent.approval.state, 'used');
    assert.equal(sent.approval.sentMessageId, sent.sentMessageId);
  } finally {
    await chatClient.close();
  }
});

// ── What a send says when Gmail's answer is short of certain (CUE-404 Task 12; §D2, §D8) ─────────────────────────

test('over MCP, a send Gmail accepted without an id says exactly that, and a lost answer is SEND_OUTCOME_UNKNOWN (D8o-e, D2pt-b)', async () => {
  const harness = await mailbox('chat');
  const { client, close } = await connect(harness);
  try {
    const prepareAndSend = async () => {
      const id = await draftId(harness);
      const prepared = (
        await client.callTool({ name: 'gmail_send_prepare', arguments: { inbox: 'work', draftId: id } })
      ).structuredContent as { approvalId: string; expect: unknown };
      return (await client.callTool({
        name: 'gmail_draft_send',
        arguments: { inbox: 'work', approvalId: prepared.approvalId },
      })) as ToolResult;
    };

    harness.google.afterSend = () => ({ status: 200, body: { threadId: 't-1' } });
    const noId = await prepareAndSend();
    assert.ok(!noId.isError, JSON.stringify(noId.structuredContent));
    const sent = noId.structuredContent as { said: string; approval: { state: string } };
    assert.equal(sent.said, 'sent; the provider returned no id');
    assert.equal('sentMessageId' in sent, false);
    assert.equal(sent.approval.state, 'sending', 'never used without an id');

    harness.google.afterSend = () => ({ status: 503, body: { error: { code: 503, message: 'the answer was lost' } } });
    const lost = await prepareAndSend();
    assert.equal(lost.isError, true);
    const error = (
      lost.structuredContent as {
        error: { code: string; hint: string; details: { approval: Record<string, unknown> } };
      }
    ).error;
    assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
    assert.match(error.hint, /^Check the Sent folder before anything else/);
    assert.equal(error.details.approval.state, 'sending');
    assert.equal(typeof error.details.approval.unknownAt, 'string');
    assert.equal(harness.google.requests.filter((request) => request.path.endsWith('/send')).length, 2);
  } finally {
    await close();
  }
});

// ── The confirmation route: one decision, and where to go (CUE-404 Task 13; §D1 "A refusal has one meaning", §D5) ──

/** The approvals on a clock of their own, set before a server is built over this harness. */
function clocked(harness: Harness) {
  const start = Date.now();
  let at = start;
  harness.core.approvals = new ApprovalStore(harness.core.paths.stateDir, {
    now: () => new Date(at),
    loadConfig: () => harness.core.config.load(),
  });
  return {
    /** Sets the clock `minutes` after it started. */
    minute: (minutes: number) => {
      at = start + minutes * 60_000;
    },
  };
}

/** The person has trusted `client` to show them approval forms (its probe and change approval already given). */
async function trusting(harness: Harness, client: string): Promise<void> {
  await harness.core.config.update(
    (config) => ({
      ...config,
      defaults: { ...config.defaults, confirm: { ...config.defaults.confirm, elicitationClients: [client] } },
    }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.confirm.elicitationClients'] } },
  );
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;
const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return (
    result.structuredContent as {
      error: { code: string; message: string; hint: string | null; details?: { approval: Record<string, unknown> } };
    }
  ).error;
};

test('no surface says a client is known to reach a person; the trusted clients are the ones the person chose to trust (D5-a)', async () => {
  const harness = await mailbox('confirm');
  const { client, close } = await connect(harness);
  try {
    const tools = (await client.listTools()).tools;
    const said = [
      client.getInstructions() ?? '',
      ...tools.flatMap((tool) => [tool.title ?? '', tool.description ?? '']),
    ];
    for (const text of said) {
      assert.doesNotMatch(text, /known to reach|reach(es)? a person|reach you|to a human/i, text.slice(0, 120));
    }
    const described = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));
    for (const name of ['gmail_confirm_probe', 'gmail_confirm_client_add', 'gmail_confirm_clients']) {
      assert.match(described.get(name) ?? '', /the person chose to trust/, name);
    }
    // The probe proves only that the client can return a form's answer, and says so.
    assert.match(described.get('gmail_confirm_probe') ?? '', /can return an approval form’s answer/);
  } finally {
    await close();
  }
});

test('a declined form is revoked at once, as declined: claims at 11 and 29 minutes find it so, and nothing is sent (D2-f, D1rr-c)', async () => {
  const harness = await mailbox('confirm');
  const clock = clocked(harness);
  await trusting(harness, 'trusted-client');
  const id = await draftId(harness);
  let forms = 0;
  const { client, close } = await connect(harness, {
    clientName: 'trusted-client',
    answer: () => {
      forms += 1;
      return null;
    },
    refuse: 'decline',
  });
  try {
    const prepared = (await call(client, 'gmail_send_prepare', { inbox: 'work', draftId: id })).structuredContent as {
      approvalId: string;
      expect: unknown;
    };
    const send = { inbox: 'work', approvalId: prepared.approvalId };
    clock.minute(1);
    const declined = errorOf(await call(client, 'gmail_draft_send', send));
    assert.equal(declined.code, 'APPROVAL_VOID');
    assert.equal(declined.message, 'nothing was sent: the approval was declined');
    assert.equal(declined.details?.approval.state, 'revoked');
    assert.equal(declined.details?.approval.reason, 'declined');
    // Stored as the person's decision, under the record's lock, before anything else could claim it.
    const stored = asV2(await harness.core.approvals.get(prepared.approvalId));
    assert.equal(stored?.state, 'revoked');
    assert.equal(stored?.reason, 'declined');
    for (const minute of [11, 29]) {
      clock.minute(minute);
      const again = errorOf(await call(client, 'gmail_draft_send', send));
      assert.equal(again.code, 'APPROVAL_VOID', `at minute ${minute}`);
      assert.match(again.message, /voided \(declined\)/);
      const status = (await call(client, 'gmail_send_wait', { approvalId: prepared.approvalId, waitSeconds: 0 }))
        .structuredContent as { state: string; claimable: boolean };
      assert.deepEqual([status.state, status.claimable], ['revoked', false], `at minute ${minute}`);
    }
    assert.equal(forms, 1, 'one decision, asked once');
    assert.equal(harness.google.requests.filter((request) => request.path.endsWith('/send')).length, 0);
  } finally {
    await close();
  }
});

test('a cancelled or dismissed form decides nothing: the approval stays pending to minute 29, and can still be used (D2-f, D1rr-c)', async (t) => {
  for (const how of ['cancelled', 'dismissed'] as const) {
    await t.test(how, async () => {
      const harness = await mailbox('confirm');
      const clock = clocked(harness);
      await trusting(harness, 'trusted-client');
      const id = await draftId(harness);
      const { client, close } = await connect(harness, {
        clientName: 'trusted-client',
        answer: () => null,
        refuse: 'cancel',
      });
      try {
        const prepared = (await call(client, 'gmail_send_prepare', { inbox: 'work', draftId: id }))
          .structuredContent as { approvalId: string; expect: unknown };
        const send = { inbox: 'work', approvalId: prepared.approvalId };
        clock.minute(1);
        const result =
          how === 'cancelled'
            ? await call(client, 'gmail_draft_send', send)
            : // A response that is no answer to the form at all: what a client that dismissed it may send back.
              ((await client.callTool({
                name: 'gmail_draft_send',
                arguments: send,
                inputResponses: { approve: { roots: [] } },
              } as never)) as ToolResult);
        const waiting = errorOf(result);
        assert.equal(waiting.code, 'APPROVAL_PENDING');
        assert.equal(
          waiting.message,
          `nothing was sent: the form was ${how === 'cancelled' ? 'cancelled' : 'not answered'}, and the approval is still waiting`,
        );
        const command = locatedGmailLine(waiting.hint ?? '', ['approve', prepared.approvalId]);
        assert.match(waiting.hint ?? '', new RegExp(`run \`${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
        assert.match(waiting.hint ?? '', /gmail_send_wait/);
        assert.equal(waiting.details?.approval.state, 'pending');
        for (const minute of [11, 29]) {
          clock.minute(minute);
          const status = (await call(client, 'gmail_send_wait', { approvalId: prepared.approvalId, waitSeconds: 0 }))
            .structuredContent as { state: string; claimable: boolean };
          assert.deepEqual([status.state, status.claimable], ['pending', false], `at minute ${minute}`);
          assert.equal(asV2(await harness.core.approvals.get(prepared.approvalId))?.state, 'pending');
        }
      } finally {
        await close();
      }
      // At minute 29 it is still the person's to give: a form answered with its code sends it.
      const answering = await connect(harness, {
        clientName: 'trusted-client',
        answer: (message) => /Type ([A-Za-z0-9_-]{4}) to send/.exec(message)?.[1] ?? '',
      });
      try {
        const listed = (await call(answering.client, 'gmail_send_list', {})).structuredContent as {
          approvals: Array<{
            approvalId: string;
            expect: { to: string[]; cc: string[]; bcc: string[]; subject: string };
          }>;
        };
        const [pending] = listed.approvals;
        assert.ok(pending);
        const sent = await call(answering.client, 'gmail_draft_send', {
          inbox: 'work',
          draftId: id,
          approvalId: pending.approvalId,
          expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Tuesday' },
        });
        assert.ok(!sent.isError, JSON.stringify(sent.structuredContent));
      } finally {
        await answering.close();
      }
      assert.equal(harness.google.requests.filter((request) => request.path.endsWith('/send')).length, 1);
    });
  }
});

test('a confirm change never raises a form, even in a client trusted with them (D2-d)', async () => {
  const harness = await mailbox('confirm');
  await trusting(harness, 'trusted-client');
  // Tightening needs nobody: from here every change to this mailbox needs a person at a terminal.
  await harness.core.config.update((config) => ({
    ...config,
    inboxes: {
      ...config.inboxes,
      work: { ...(config.inboxes.work as NonNullable<typeof config.inboxes.work>), changePolicy: 'confirm' },
    },
  }));
  let forms = 0;
  const { client, close } = await connect(harness, {
    clientName: 'trusted-client',
    answer: () => {
      forms += 1;
      return 'ABCD';
    },
  });
  try {
    const asked = (await call(client, 'gmail_inbox_policy', { inbox: 'work', sendPolicy: 'chat' }))
      .structuredContent as {
      approvalRequired: boolean;
      approvalId: string;
      policy: string;
    };
    assert.equal(asked.approvalRequired, true);
    assert.equal(asked.policy, 'confirm');
    const refused = errorOf(
      await call(client, 'gmail_inbox_policy', { inbox: 'work', sendPolicy: 'chat', approvalId: asked.approvalId }),
    );
    assert.equal(refused.code, 'APPROVAL_PENDING');
    locatedGmailLine(refused.hint ?? '', ['approve', asked.approvalId]);
    assert.equal(forms, 0, 'no form was raised for a change');
    assert.equal(asV2(await harness.core.approvals.get(asked.approvalId))?.state, 'pending');
  } finally {
    await close();
  }
});
