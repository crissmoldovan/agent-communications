import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { afterEach, test } from 'node:test';
import { GmailContext } from '../src/context.ts';
import { createDraft, getDraft } from '../src/operations/drafts.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { applied, cli, connect, toolError, wire } from './support/surfaces.ts';

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

// ── finishing a sign-in: from a pasted address, and for as long as the sign-in lives ───────────────────────

/** Two accounts Google knows, a client to sign in through, and nothing connected under the names used here. */
async function readyToConnect(): Promise<Harness> {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
      { sub: 'sub-3', email: 'kim@example.test' },
    ],
  });
  // Registers the `default` client; the mailbox itself is a third account, out of the way.
  await harness.addInbox({ alias: 'existing', email: 'kim@example.test', sub: 'sub-3', refreshToken: 'rt' });
  return harness;
}

test('gmail_inbox_finish finishes from the address the browser ended up at, as `--finish --url` does', async () => {
  /*
   * A browser on another machine from the server — over SSH, in a container — cannot reach the loopback listener,
   * so the sign-in can only finish from the address bar pasted back. The command has always taken it; the tool
   * ignored a `url` and waited for a redirect that could never arrive. Nothing is given away by accepting it: the
   * code in it is useless without the PKCE verifier, which never left this machine.
   */
  const harness = await readyToConnect();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const link = wire(await call('gmail_inbox_add', { alias: 'viatool', email: 'jo@example.test' }));
    stopLater(harness, link.flowId);
    // Consent given, and the browser's redirect NOT followed: its address is what the person pastes.
    const pasted = harness.google.consent(String(link.authUrl), { sub: 'sub-1' });
    const finished = wire(await call('gmail_inbox_finish', { flowId: link.flowId, url: pasted, waitSeconds: 0 }));
    assert.equal(finished.alias, 'viatool');
    assert.equal(finished.email, 'jo@example.test');
    assert.equal((await harness.core.config.load()).inboxes.viatool?.email, 'jo@example.test');

    const other = wire(await call('gmail_inbox_add', { alias: 'viacli', email: 'sam@example.test' }));
    stopLater(harness, other.flowId);
    const byCommand = await cli(harness, [
      'inbox',
      'add',
      '--finish',
      String(other.flowId),
      '--url',
      harness.google.consent(String(other.authUrl), { sub: 'sub-2' }),
      '--json',
    ]);
    assert.equal(byCommand.code, 0, byCommand.stdout);
    assert.equal(byCommand.envelope<{ alias: string }>().data?.alias, 'viacli');

    // A pasted address is checked against the flow it claims to finish, as at the terminal.
    const third = wire(await call('gmail_inbox_add', { alias: 'mismatch' }));
    stopLater(harness, third.flowId);
    const foreign = new URL(pasted);
    foreign.searchParams.set('state', 'not-this-flow');
    const refused = await call('gmail_inbox_finish', { flowId: third.flowId, url: foreign.toString() });
    assert.equal(toolError(refused).code, 'AUTH_REQUIRED');
  } finally {
    await close();
  }
});

test('gmail_inbox_finish waits as long as the sign-in can, and stops waiting when the client gives up', {
  timeout: 60_000,
}, async () => {
  /*
   * It capped the wait at two minutes; `--wait` has no cap. The sign-in itself lives ten minutes, so that is the
   * longest wait that can mean anything, and the tool now takes it. A client may give up on a call long before —
   * most do after a minute — and a wait nobody is listening for any more must not go on to claim the grant when it
   * arrives: the answer would reach nobody, and the next finish would find the sign-in gone.
   */
  const harness = await readyToConnect();
  const { client, call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const link = wire(await call('gmail_inbox_add', { alias: 'patient', email: 'jo@example.test' }));
    stopLater(harness, link.flowId);

    // Not finished yet: the answer says to call the tool again, not to run a command this client may not have.
    const pending = toolError(await call('gmail_inbox_finish', { flowId: link.flowId, waitSeconds: 0 }));
    assert.equal(pending.code, 'APPROVAL_PENDING');
    assert.match(pending.hint ?? '', /gmail_inbox_finish/);
    assert.doesNotMatch(pending.hint ?? '', /agent-gmail/);

    await assert.rejects(
      client.callTool(
        { name: 'gmail_inbox_finish', arguments: { flowId: link.flowId, waitSeconds: 600 } },
        {
          timeout: 1_000,
        },
      ),
      /timed out|timeout/i,
      'a ten-minute wait was refused, or returned before the client gave up',
    );

    // The browser comes back after the client gave up; the abandoned wait must not be the one that takes it.
    const response = await fetch(harness.google.consent(String(link.authUrl), { sub: 'sub-1' }));
    assert.equal(response.status, 200);
    await new Promise((settle) => setTimeout(settle, 1_500));
    assert.equal((await harness.core.config.load()).inboxes.patient, undefined, 'an abandoned wait connected it');

    const finished = wire(await call('gmail_inbox_finish', { flowId: link.flowId, waitSeconds: 10 }));
    assert.equal(finished.alias, 'patient');

    // Beyond the sign-in's own life is refused rather than waited for.
    const tooLong = await call('gmail_inbox_finish', { flowId: link.flowId, waitSeconds: 601 });
    assert.equal(tooLong.isError, true);
  } finally {
    await close();
  }
});
