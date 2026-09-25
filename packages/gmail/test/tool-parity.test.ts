import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { afterEach, test } from 'node:test';
import { GmailContext } from '../src/context.ts';
import { createDraft, getDraft } from '../src/operations/drafts.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { applied, cli, connect, wire } from './support/surfaces.ts';

/*
 * Each tool held to the command it mirrors, where the two had drifted: what it takes, what it returns, and what it
 * refuses. Everything here runs both surfaces against one configuration and compares what came back.
 */

async function oneMailbox(): Promise<Harness> {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  return harness;
}

/** A loopback port nothing is listening on, for a sign-in asked to use a fixed one. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((settle) => server.close(() => settle()));
  return port;
}

/*
 * Sign-ins a test started. Each has a detached listener that would otherwise wait out its ten minutes after the test
 * file ends, so every one is noted the moment it exists — before anything is asserted about it — and stopped once
 * the test is done, passed or failed.
 */
let started: Array<{ harness: Harness; flowId: unknown }> = [];
const stopLater = (harness: Harness, ...flowIds: unknown[]): void => {
  for (const flowId of flowIds) started.push({ harness, flowId });
};
afterEach(async () => {
  const flows = started;
  started = [];
  for (const { harness, flowId } of flows) {
    if (typeof flowId !== 'string') continue;
    const context = new GmailContext({ core: harness.core, env: harness.env });
    try {
      const flow = await context.flows.get(flowId);
      if (flow.listenerPid) process.kill(flow.listenerPid, 'SIGTERM');
      await context.flows.discard(flowId);
    } catch {
      // Finished, or gone already: nothing left to stop.
    }
  }
});

/** What a sign-in asked Google for, read from the flow it recorded. */
async function flowOf(harness: Harness, flowId: unknown) {
  return new GmailContext({ core: harness.core, env: harness.env }).flows.get(String(flowId));
}

// ── draft update: no body given means keep it, on both surfaces ─────────────────────────────────────────────

test('draft update from an agent’s shell keeps the body when none is given, as gmail_draft_update does', {
  timeout: 20_000,
}, async () => {
  const harness = await oneMailbox();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const draft = await createDraft(context, 'work', {
    to: ['sam@partner.test'],
    subject: 'Tue',
    text: 'See you Tuesday.',
  });

  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const byTool = wire(
      await call('gmail_draft_update', { inbox: 'work', draftId: draft.draftId, subject: 'Tue, then' }),
    );
    assert.equal(byTool.subject, 'Tue, then');
    assert.match(String(byTool.preview), /See you Tuesday\./);
  } finally {
    await close();
  }

  // Standard input that has ended with nothing on it — what an agent's shell gives a command. It said "the message
  // body was empty" and exited 64, so an agent could not change a subject without restating the whole body.
  const ended = await cli(
    harness,
    ['draft', 'update', draft.draftId, '--inbox', 'work', '--subject', 'Tue, finally', '--json'],
    {
      endStdin: true,
    },
  );
  assert.equal(ended.code, 0, ended.stdout);
  const kept = ended.envelope<{ subject: string; preview: string }>().data;
  assert.equal(kept?.subject, 'Tue, finally');
  assert.match(kept?.preview ?? '', /See you Tuesday\./, 'the body was kept');

  // Standard input that is a pipe nobody closes: this waited for the end of it, for ever. Nothing is read from it now
  // unless the command is asked to (`--file -`), so the update returns.
  const open = await cli(harness, [
    'draft',
    'update',
    draft.draftId,
    '--inbox',
    'work',
    '--subject',
    'Tue, at last',
    '--json',
  ]);
  assert.equal(open.code, 0, open.stdout);
  assert.match(open.envelope<{ preview: string }>().data?.preview ?? '', /See you Tuesday\./);

  // Piped text is not a body unless the command is told it is: guessing from whatever standard input holds is what
  // hung, and a body replaced by accident is worse than one kept.
  const unasked = await cli(harness, ['draft', 'update', draft.draftId, '--inbox', 'work', '--json'], {
    stdin: 'This is not meant as the body.\n',
    endStdin: true,
  });
  assert.equal(unasked.code, 0, unasked.stdout);
  assert.match(unasked.envelope<{ preview: string }>().data?.preview ?? '', /See you Tuesday\./);

  // `--file -` is how to ask: it reads standard input to its end, as `--from -` does for `organise-undo`.
  const asked = await cli(harness, ['draft', 'update', draft.draftId, '--inbox', 'work', '--file', '-', '--json'], {
    stdin: 'Wednesday instead.\n',
    endStdin: true,
  });
  assert.equal(asked.code, 0, asked.stdout);
  const replaced = await getDraft(context, 'work', draft.draftId);
  assert.match(replaced.preview, /Wednesday instead\./);
  assert.doesNotMatch(replaced.preview, /See you Tuesday\./);

  // …and an empty one is still refused rather than taken as "no body".
  const empty = await cli(harness, ['draft', 'update', draft.draftId, '--inbox', 'work', '--file', '-', '--json'], {
    endStdin: true,
  });
  assert.equal(empty.code, 64, empty.stdout);
  assert.match(empty.envelope().error?.message ?? '', /the message body was empty/);
});

test('`--file -` reads the body from standard input for a new draft too', async () => {
  const harness = await oneMailbox();
  const made = await cli(
    harness,
    ['draft', 'new', '--inbox', 'work', '--to', 'sam@partner.test', '--subject', 'Notes', '--file', '-', '--json'],
    { stdin: 'Line one.\n', endStdin: true },
  );
  assert.equal(made.code, 0, made.stdout);
  assert.match(made.envelope<{ preview: string }>().data?.preview ?? '', /Line one\./);
});

// ── starting a sign-in: the same options, the same answer ──────────────────────────────────────────────────

/** Two mailboxes signed in through two clients, so a sign-in that ignored `client` would be visible. */
async function twoClients(): Promise<Harness> {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'a', email: 'x@example.test', refreshToken: 'rt1', client: 'default' });
  await harness.addInbox({ alias: 'b', email: 'y@example.test', refreshToken: 'rt2', client: 'other' });
  return harness;
}

test('gmail_inbox_add takes every option `inbox add --start` does, and answers with what it prints', async () => {
  /*
   * The tool took a name, an address and a tier. `client` and `contacts` were stripped without a word, so a call
   * asking for the second client without the address book signed in through the first and asked for the address
   * book; `port` and `hd` did not exist. And the answer left out where Google sends the browser back and which
   * address the sign-in is bound to.
   */
  const harness = await twoClients();
  const [toolPort, cliPort] = [await freePort(), await freePort()];
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const byTool = wire(
      await call('gmail_inbox_add', {
        alias: 'viatool',
        email: 'jo@example.test',
        tier: 'read',
        client: 'other',
        contacts: false,
        port: toolPort,
        hd: 'example.test',
      }),
    );
    stopLater(harness, byTool.flowId);
    const byCommand = await cli(harness, [
      'inbox',
      'add',
      'viacli',
      '--email',
      'jo@example.test',
      '--tier',
      'read',
      '--client',
      'other',
      '--no-contacts',
      '--port',
      String(cliPort),
      '--hd',
      'example.test',
      '--start',
      '--json',
    ]);
    const printed = byCommand.envelope<Record<string, unknown>>().data ?? {};
    stopLater(harness, printed.flowId);
    assert.equal(byCommand.code, 0, byCommand.stdout);

    // What the command prints, the tool answers — plus the tool that finishes it.
    assert.deepEqual(Object.keys(byTool).sort(), [...Object.keys(printed), 'nextTool'].sort());
    assert.equal(byTool.expectedEmail, 'jo@example.test');
    assert.equal(printed.expectedEmail, 'jo@example.test');
    assert.equal(byTool.redirectUri, `http://127.0.0.1:${toolPort}/`);
    assert.equal(printed.redirectUri, `http://127.0.0.1:${cliPort}/`);

    const viaTool = await flowOf(harness, byTool.flowId);
    const viaCommand = await flowOf(harness, printed.flowId);
    for (const flow of [viaTool, viaCommand]) {
      assert.equal(flow.clientName, 'other');
      assert.equal(flow.contacts, false);
      assert.equal(flow.tier, 'read');
    }
    assert.deepEqual(viaTool.scopes, viaCommand.scopes);
    assert.ok(!viaTool.scopes.some((scope) => scope.includes('contacts')), 'the address book was asked for');
    for (const link of [String(byTool.authUrl), String(printed.authUrl)]) {
      assert.equal(new URL(link).searchParams.get('hd'), 'example.test');
    }
  } finally {
    await close();
  }
});

test('gmail_inbox_reauth takes the address, the port and the domain `inbox reauth --start` does', async () => {
  const harness = await oneMailbox();
  const [toolPort, cliPort] = [await freePort(), await freePort()];
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    // A renewal at the tier it has: nothing to approve, so the link comes back at once on both surfaces.
    const byTool = applied<Record<string, unknown>>(
      await call('gmail_inbox_reauth', { inbox: 'work', email: 'jo@example.test', port: toolPort, hd: 'example.test' }),
    );
    stopLater(harness, byTool.flowId);
    const byCommand = await cli(harness, [
      'inbox',
      'reauth',
      'work',
      '--email',
      'jo@example.test',
      '--port',
      String(cliPort),
      '--hd',
      'example.test',
      '--start',
      '--json',
    ]);
    const printed = byCommand.envelope<Record<string, unknown>>().data ?? {};
    stopLater(harness, printed.flowId);
    assert.equal(byCommand.code, 0, byCommand.stdout);

    assert.deepEqual(Object.keys(byTool).sort(), [...Object.keys(printed), 'nextTool'].sort());
    assert.equal(byTool.redirectUri, `http://127.0.0.1:${toolPort}/`);
    assert.equal(printed.redirectUri, `http://127.0.0.1:${cliPort}/`);
    for (const link of [String(byTool.authUrl), String(printed.authUrl)]) {
      assert.equal(new URL(link).searchParams.get('hd'), 'example.test');
      assert.equal(new URL(link).searchParams.get('login_hint'), 'jo@example.test');
    }
  } finally {
    await close();
  }
});
