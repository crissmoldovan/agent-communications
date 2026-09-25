import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { managedRuntimeEntry } from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { createDraft, getDraft } from '../src/operations/drafts.ts';
import { inboxPolicy, orphanedSecretsPath } from '../src/operations/inboxes.ts';
import { prepareSend } from '../src/operations/send.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { applied, approvalAsked, cli, connect, toolError, wire } from './support/surfaces.ts';

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

/**
 * A sign-in on record and waiting for a browser nobody will open: no listener behind it, and nothing asked of Google.
 * `expiresIn` moves its end nearer, for the tests about a wait that outlives it.
 */
async function waitingFlow(
  harness: Harness,
  options: { mode?: 'add' | 'reauth'; expiresIn?: number; alias?: string } = {},
): Promise<string> {
  const flows = new GmailContext({ core: harness.core, env: harness.env }).flows;
  const flow = await flows.create({
    mode: options.mode ?? 'add',
    alias: options.alias ?? 'later',
    clientName: 'default',
    tier: 'organize',
    contacts: true,
    scopes: [],
    state: 'state-nobody-will-return',
    codeVerifier: 'verifier-nobody-will-use',
    redirectUri: 'http://127.0.0.1:9/',
    port: 9,
    expect: {},
  });
  if (options.expiresIn !== undefined) {
    await flows.patch(flow.flowId, { expiresAt: new Date(Date.now() + options.expiresIn).toISOString() });
  }
  return flow.flowId;
}

test('a `--wait` that is not a number of seconds from 0 to 600 is refused as USAGE, as gmail_inbox_finish refuses it', {
  timeout: 20_000,
}, async () => {
  /*
   * `--wait` was `Number.parseInt`: `--wait abc` was NaN, a deadline no clock reaches, so `inbox add --finish …
   * --wait abc` waited for ever on a sign-in that lasts ten minutes; `--wait 12abc` was twelve seconds, and `--wait
   * 601` waited past the sign-in's own end. The tool's schema kept its wait between 0 and 600; the command kept
   * nothing. Both `inbox add` and `inbox reauth` take `--wait`, and both are held to the one range.
   */
  const harness = await oneMailbox();
  const added = await waitingFlow(harness);
  const reauthorising = await waitingFlow(harness, { mode: 'reauth' });
  const cases: Array<[string, string, string]> = [
    ['add', added, 'abc'],
    ['add', added, '12abc'],
    ['add', added, '1.5'],
    ['add', added, '-1'],
    ['add', added, '601'],
    // Numbers to `Number()`, and not a count of seconds anyone typed on purpose.
    ['add', added, '1e2'],
    ['add', added, '0x10'],
    ['reauth', reauthorising, 'abc'],
    ['reauth', reauthorising, '601'],
  ];
  const refusals = new Map<string, { message: string }>();
  for (const [command, flowId, wait] of cases) {
    const run = await cli(harness, ['inbox', command, '--finish', flowId, `--wait=${wait}`, '--json']);
    assert.equal(run.code, 64, `inbox ${command} --wait ${wait}: ${run.stdout}`);
    const error = run.envelope().error;
    assert.equal(error?.code, 'USAGE', run.stdout);
    assert.equal(error?.message, `"${wait}" is not a wait`);
    assert.match(error?.hint ?? '', /from 0 to 600/);
    refusals.set(wait, { message: error?.message ?? '' });
  }

  // Given without `--finish`, where nothing waits, a wait that is not one is still refused rather than ignored.
  const unfinished = await cli(harness, ['inbox', 'add', '--wait=abc', '--json']);
  assert.equal(unfinished.code, 64, unfinished.stdout);
  assert.equal(unfinished.envelope().error?.message, '"abc" is not a wait');

  // Refused before the sign-in was read, so it is still there to finish — and a wait in range still waits.
  for (const flowId of [added, reauthorising]) {
    const command = flowId === added ? 'add' : 'reauth';
    const once = await cli(harness, ['inbox', command, '--finish', flowId, '--wait', '0', '--json']);
    assert.equal(once.code, 10, once.stdout);
    assert.equal(once.envelope().error?.code, 'APPROVAL_PENDING');
  }

  // The tool refuses what the command refuses, in the same words, from the same check.
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    for (const waitSeconds of [601, -1]) {
      const refused = toolError(await call('gmail_inbox_finish', { flowId: added, waitSeconds }));
      assert.equal(refused.code, 'USAGE');
      assert.equal(refused.message, refusals.get(String(waitSeconds))?.message);
      assert.match(refused.hint ?? '', /from 0 to 600/);
      assert.match(refused.hint ?? '', /gmail_inbox_finish/);
    }
  } finally {
    await close();
  }
});

test('a wait that outlives the sign-in stops when it expires, and says so as gmail_inbox_finish does', {
  timeout: 60_000,
}, async () => {
  /*
   * The wait ran to its own end whatever the sign-in's: `--finish … --wait 10` on a sign-in with three seconds left
   * waited all ten, then answered "nobody has finished signing in yet" and told the person to open the link and run
   * the finish again — for a link that had expired seven seconds before. Now it stops when the sign-in ends, and
   * answers as gmail_inbox_finish answers for one that has already ended — the same code and words, and the next step
   * as each surface takes it (the test after this one holds that step to the kind of sign-in and the surface).
   */
  const harness = await oneMailbox();
  const flows = new GmailContext({ core: harness.core, env: harness.env }).flows;
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    // How the tool reports a sign-in that has ended: the answer every wait below is held to.
    const ended = toolError(
      await call('gmail_inbox_finish', { flowId: await waitingFlow(harness, { expiresIn: -1_000 }), waitSeconds: 0 }),
    );
    assert.equal(ended.code, 'AUTH_REQUIRED');
    assert.match(ended.message, /expired/);
    assert.match(ended.hint ?? '', /Start again/);

    for (const mode of ['add', 'reauth'] as const) {
      // And how the command reports one of this kind that has already ended, for the step it names.
      const over = await waitingFlow(harness, { mode, expiresIn: -1_000 });
      const endedHere = (await cli(harness, ['inbox', mode, '--finish', over, '--wait', '0', '--json'])).envelope()
        .error;
      const flowId = await waitingFlow(harness, { mode, expiresIn: 3_000 });
      const began = Date.now();
      const run = await cli(harness, ['inbox', mode, '--finish', flowId, '--wait', '10', '--json']);
      const took = Date.now() - began;
      const error = run.envelope().error;
      assert.equal(error?.code, ended.code, `inbox ${mode}: ${run.stdout}`);
      assert.equal(run.code, 77, run.stdout);
      assert.equal(error?.message, ended.message);
      assert.equal(error?.hint, endedHere?.hint);
      assert.match(error?.hint ?? '', /Start again/);
      assert.ok(took < 8_000, `inbox ${mode} waited ${took} ms, past the end of the sign-in`);
      // Discarded, as an expired sign-in is: nothing is left to finish, and nothing says the link is still good.
      await assert.rejects(flows.get(flowId), (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
    }

    // The tool, asked to wait past the end, stops at it the same way.
    const flowId = await waitingFlow(harness, { expiresIn: 3_000 });
    const began = Date.now();
    const waited = toolError(await call('gmail_inbox_finish', { flowId, waitSeconds: 10 }));
    assert.ok(Date.now() - began < 8_000, 'the tool waited past the end of the sign-in');
    assert.deepEqual(waited, ended);
  } finally {
    await close();
  }
});

test('an expired sign-in says how to start that one again: its own kind, in the words of the caller’s surface', {
  timeout: 60_000,
}, async () => {
  /*
   * Every expired sign-in said "Start again with `agent-gmail inbox add <alias> --start`": to a person whose
   * re-authorisation had run out, sending them to connect the mailbox as a new one — which is refused, since the name
   * is taken — and to an agent over MCP, sending it to a command it may have no shell to run, for a step its own
   * tools take. The refusal is the same on both surfaces, code and message; only the next step is named for whoever
   * asked, and for the kind of sign-in that ran out. Checked where it can run out: at `--finish`, during a `--wait`,
   * and at gmail_inbox_finish, before and during its wait.
   */
  const harness = await oneMailbox();
  // The next step each kind of sign-in names, by surface, and what it must never name instead.
  const next = {
    add: { alias: 'later', cli: '`agent-gmail inbox add later --start`', tool: 'gmail_inbox_add', not: /reauth/ },
    reauth: { alias: 'work', cli: '`agent-gmail inbox reauth work --start`', tool: 'gmail_inbox_reauth', not: /add/ },
  } as const;
  type Refusal = { where: string; surface: 'cli' | 'mcp'; code?: string; message?: string; hint?: string | null };
  const byCommand = async (where: string, argv: string[]): Promise<Refusal> => {
    const run = await cli(harness, [...argv, '--json']);
    assert.equal(run.code, 77, `${argv.join(' ')}: ${run.stdout}`);
    return { where, surface: 'cli', ...run.envelope().error };
  };
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  const byTool = async (where: string, args: Record<string, unknown>): Promise<Refusal> => ({
    where,
    surface: 'mcp',
    ...toolError(await call('gmail_inbox_finish', args)),
  });
  try {
    for (const mode of ['add', 'reauth'] as const) {
      const { alias } = next[mode];
      // Already over when asked, and running out while the caller waits — `expiresIn` in milliseconds.
      const over = () => waitingFlow(harness, { mode, alias, expiresIn: -1_000 });
      const ending = () => waitingFlow(harness, { mode, alias, expiresIn: 1_500 });
      const refusals = [
        await byCommand('--finish', ['inbox', mode, '--finish', await over(), '--wait', '0']),
        await byCommand('--wait', ['inbox', mode, '--finish', await ending(), '--wait', '10']),
        await byTool('gmail_inbox_finish', { flowId: await over(), waitSeconds: 0 }),
        await byTool('gmail_inbox_finish, waiting', { flowId: await ending(), waitSeconds: 10 }),
      ];

      for (const { where, surface, code, message, hint } of refusals) {
        const label = `${mode}, ${where}: ${hint}`;
        // One refusal: the same code and the same words, wherever it was asked from.
        assert.equal(code, 'AUTH_REQUIRED', label);
        assert.equal(message, 'that sign-in took longer than ten minutes and has expired', label);
        // The next step for this kind of sign-in, on this surface: never the other kind's, or the other surface's.
        if (surface === 'cli') {
          assert.ok(hint?.includes(next[mode].cli), label);
          assert.doesNotMatch(hint ?? '', /gmail_inbox_/, label);
        } else {
          assert.ok(hint?.includes(next[mode].tool), label);
          assert.ok(hint?.includes(`"${alias}"`), label);
          assert.doesNotMatch(hint ?? '', /agent-gmail/, label);
        }
        assert.doesNotMatch(hint ?? '', next[mode].not, label);
      }
    }
  } finally {
    await close();
  }
});

test('a sign-in that is gone, or already finished, names the next step on the caller’s surface too', async () => {
  /*
   * The same sentence was in the other two refusals a finish can meet: a sign-in that is not there — which is what an
   * expired one is the second time it is asked about, since the first refusal discards it — and one another finish
   * already claimed. Both sent every caller to `agent-gmail inbox add`.
   */
  const harness = await oneMailbox();
  const flows = new GmailContext({ core: harness.core, env: harness.env }).flows;
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    // Gone: nothing says which kind it was, so both ways to start again are named — each as its surface takes it.
    const gone = await waitingFlow(harness, { expiresIn: -1_000 });
    assert.equal(toolError(await call('gmail_inbox_finish', { flowId: gone, waitSeconds: 0 })).code, 'AUTH_REQUIRED');
    const byTool = toolError(await call('gmail_inbox_finish', { flowId: gone, waitSeconds: 0 }));
    const byCommand = (await cli(harness, ['inbox', 'reauth', '--finish', gone, '--wait', '0', '--json'])).envelope()
      .error;
    assert.equal(byTool.code, 'NOT_FOUND');
    assert.equal(byCommand?.code, 'NOT_FOUND');
    assert.equal(byCommand?.message, byTool.message);
    assert.match(byTool.hint ?? '', /gmail_inbox_add\b.*gmail_inbox_reauth\b/);
    assert.doesNotMatch(byTool.hint ?? '', /agent-gmail/);
    assert.match(
      byCommand?.hint ?? '',
      /`agent-gmail inbox add <alias> --start`.*`agent-gmail inbox reauth <alias> --start`/,
    );
    assert.doesNotMatch(byCommand?.hint ?? '', /gmail_inbox_/);

    // Already finished: the grant is in, and another finish holds the claim on it.
    const claimed = async (mode: 'add' | 'reauth'): Promise<string> => {
      const flowId = await waitingFlow(harness, { mode, alias: mode === 'add' ? 'later' : 'work' });
      await flows.recordOutcome(flowId, { code: 'a-code-another-finish-took' });
      await writeFile(join(flows.directory, `${flowId}.claim`), '{}\n');
      return flowId;
    };
    for (const [mode, tool, command] of [
      ['add', 'gmail_inbox_add with alias "later"', '`agent-gmail inbox add later --start`'],
      ['reauth', 'gmail_inbox_reauth with inbox "work"', '`agent-gmail inbox reauth work --start`'],
    ] as const) {
      const refused = toolError(await call('gmail_inbox_finish', { flowId: await claimed(mode), waitSeconds: 0 }));
      const run = await cli(harness, ['inbox', mode, '--finish', await claimed(mode), '--wait', '0', '--json']);
      const error = run.envelope().error;
      assert.equal(refused.code, 'AUTH_REQUIRED', mode);
      assert.equal(error?.code, refused.code, run.stdout);
      assert.equal(error?.message, refused.message, mode);
      assert.match(refused.message, /already been finished/);
      assert.ok(refused.hint?.includes(tool), `${mode}: ${refused.hint}`);
      assert.doesNotMatch(refused.hint ?? '', /agent-gmail/, mode);
      assert.ok(error?.hint?.includes(command), `${mode}: ${error?.hint}`);
      assert.doesNotMatch(error?.hint ?? '', /gmail_inbox_/, mode);
    }
  } finally {
    await close();
  }
});

// ── a pinned server, and approvals for other mailboxes ──────────────────────────────────────────────────────

/** `work`, which a server is pinned to, and `home`, which it was not given. Both send under `chat`. */
async function workAndHome(): Promise<Harness> {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: 'chat' });
  await harness.addInbox({
    alias: 'home',
    email: 'sam@example.test',
    sub: 'sub-2',
    refreshToken: 'rt_home',
    client: 'other',
    sendPolicy: 'chat',
  });
  return harness;
}

test('a pinned server refuses another mailbox’s change approval before it touches it', async () => {
  /*
   * `gmail_inbox_policy {approvalId: <home's>}` on a server pinned to `work` computed work's change, found it was not
   * the one approved, and voided home's approval on the mismatch — so a server narrowed to one mailbox could cancel
   * a change a person had agreed to for another. `gmail_send_cancel` already refused this; the change tools did not.
   */
  const harness = await workAndHome();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await inboxPolicy(context, 'work', { sendPolicy: 'never' });
  await inboxPolicy(context, 'home', { sendPolicy: 'never' });

  const whole = await connect({ core: harness.core, env: harness.env });
  const forHome = approvalAsked(await whole.call('gmail_inbox_policy', { inbox: 'home', sendPolicy: 'chat' }));

  const pinned = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const refused = toolError(
      await pinned.call('gmail_inbox_policy', { sendPolicy: 'chat', approvalId: forHome.approvalId }),
    );
    assert.equal(refused.code, 'NOT_FOUND');
    assert.match(refused.message, /for the "work" mailbox/);
    assert.equal(
      (await harness.core.approvals.get(forHome.approvalId))?.state,
      'pending',
      'home’s approval was voided',
    );

    // Its own mailbox's approvals are its to claim, as before.
    const own = approvalAsked(await pinned.call('gmail_inbox_policy', { sendPolicy: 'chat' }));
    const done = applied<{ sendPolicy: string }>(
      await pinned.call('gmail_inbox_policy', { sendPolicy: 'chat', approvalId: own.approvalId }),
    );
    assert.equal(done.sendPolicy, 'chat');

    // And home's approval is still good where it belongs.
    const claimed = applied<{ alias: string; sendPolicy: string }>(
      await whole.call('gmail_inbox_policy', { inbox: 'home', sendPolicy: 'chat', approvalId: forHome.approvalId }),
    );
    assert.equal(claimed.sendPolicy, 'chat');
  } finally {
    await pinned.close();
    await whole.close();
  }
});

test('a pinned server refuses another mailbox’s send approval rather than voiding it', async () => {
  const harness = await workAndHome();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tue', text: 'Tuesday.' });
  const home = (await harness.core.config.load()).inboxes.home;
  assert.ok(home);
  // A send prepared for home: only its mailbox matters here, so it is recorded directly.
  const forHome = await harness.core.approvals.create({
    inboxId: home.id,
    inboxSub: 'sub-2',
    draftId: 'r-home',
    draftMessageId: 'm-home',
    digest: 'digest-home',
    policy: 'chat',
    requiredPolicy: 'chat',
    riskFlags: [],
    expect: { to: ['kim@partner.test'], cc: [], bcc: [], subject: 'Home' },
  });

  const pinned = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    // Sending work's draft under home's approval voided home's approval ("belongs to a different inbox"); a
    // `confirm` one would have put home's preview in a form on this server. Refused before either can happen.
    const refused = toolError(
      await pinned.call('gmail_draft_send', {
        draftId: draft.draftId,
        approvalId: forHome.approvalId,
        expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Tue' },
      }),
    );
    assert.equal(refused.code, 'NOT_FOUND');
    assert.equal(
      (await harness.core.approvals.get(forHome.approvalId))?.state,
      'pending',
      'home’s approval was voided',
    );

    // The same words gmail_send_cancel has always used for it.
    const cancel = toolError(await pinned.call('gmail_send_cancel', { approvalId: forHome.approvalId }));
    assert.equal(cancel.code, refused.code);
    assert.equal(cancel.message, refused.message);
    assert.equal((await harness.core.approvals.get(forHome.approvalId))?.state, 'pending');
  } finally {
    await pinned.close();
  }
});

test('a pinned gmail_send_list refuses another mailbox, as every pinned tool does, rather than listing its own', async () => {
  /*
   * `{inbox: 'home'}` on a server pinned to `work` was answered with work's approvals, as if it had been asked for
   * work's: the pin replaced the argument instead of refusing it. An agent that named home read the answer as "home
   * has these approvals waiting" — work's list, under the wrong name.
   */
  const harness = await workAndHome();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tue', text: 'Tuesday.' });
  const prepared = await prepareSend(context, 'work', draft.draftId);

  const pinned = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const refused = toolError(await pinned.call('gmail_send_list', { inbox: 'home' }));
    // The same refusal, word for word, as another pinned tool asked about the same mailbox.
    const byAnother = toolError(await pinned.call('gmail_whoami', { inbox: 'home' }));
    assert.equal(refused.code, 'USAGE');
    assert.equal(refused.message, byAnother.message);
    assert.equal(refused.hint, byAnother.hint);
    assert.match(refused.message, /only serves the "work" mailbox/);

    // Its own mailbox, named or not, is listed as before.
    for (const args of [{}, { inbox: 'work' }]) {
      const listed = wire(await pinned.call('gmail_send_list', args)).approvals as Array<{ approvalId: string }>;
      assert.deepEqual(
        listed.map((approval) => approval.approvalId),
        [prepared.approvalId],
      );
    }
  } finally {
    await pinned.close();
  }
});

test('a pinned tool that takes `inboxes` refuses another mailbox in the list, as every pinned tool does, rather than searching its own', async () => {
  /*
   * `gmail_search {inboxes: ['home']}` on a server pinned to `work` searched work and answered as if it had searched
   * home — the pin replaced the list instead of refusing it, as `gmail_send_list` once replaced `inbox`. So did every
   * tool taking a list of mailboxes, and `['work', 'home']` quietly dropped home.
   */
  const harness = await workAndHome();
  const pinned = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const cases: Record<string, Record<string, unknown>> = {
      gmail_search: { query: 'Tuesday' },
      gmail_attachments_find: {},
      // Past mail only: work was connected without the address book, which would make the answer incomplete.
      gmail_contacts_search: { query: 'sam', sources: ['history'] },
      gmail_followups: {},
    };
    // Every tool that takes a list of mailboxes is here, so one added later is held to this too.
    const listed = (await pinned.client.listTools()).tools;
    assert.deepEqual(
      listed
        .filter((tool) => Object.hasOwn((tool.inputSchema.properties ?? {}) as object, 'inboxes'))
        .map((tool) => tool.name)
        .sort(),
      Object.keys(cases).sort(),
    );

    // The same refusal, word for word, as a pinned tool taking one mailbox gives for the same one.
    const byAnother = toolError(await pinned.call('gmail_whoami', { inbox: 'home' }));
    for (const [tool, args] of Object.entries(cases)) {
      for (const inboxes of [['home'], ['work', 'home'], 'home']) {
        const asked = harness.google.requests.length;
        const refused = toolError(await pinned.call(tool, { ...args, inboxes }));
        const label = `${tool} ${JSON.stringify(inboxes)}`;
        assert.equal(refused.code, 'USAGE', label);
        assert.equal(refused.message, byAnother.message, label);
        assert.equal(refused.hint, byAnother.hint, label);
        assert.equal(harness.google.requests.length, asked, `${label} asked Google before refusing`);
      }

      // Its own mailbox — left out, named, or as "all" of the one it serves — is searched as before, and only it.
      for (const inboxes of [undefined, ['work'], 'work', 'all']) {
        const answered = wire(await pinned.call(tool, inboxes === undefined ? args : { ...args, inboxes }));
        const label = `${tool} ${JSON.stringify(inboxes)}`;
        assert.equal(answered.complete, true, label);
        assert.deepEqual(answered.errors, [], label);
        if (tool === 'gmail_search') assert.deepEqual(answered.inboxes, ['work'], label);
      }
    }
  } finally {
    await pinned.close();
  }
});

// ── a pinned doctor ─────────────────────────────────────────────────────────────────────────────────────────

test('a pinned gmail_doctor answers for its own mailbox only, and refuses another, as `doctor --inbox` scopes', async () => {
  /*
   * Pinned, it listed every OAuth client on the machine by name, and `{inbox: 'home'}` was answered with work's
   * checks instead of being refused — the one read tool that neither forced the pin nor refused a mismatch.
   */
  const harness = await workAndHome();
  // Two old registrations: one serving every mailbox, which concerns work too, and one pinned to home, which does not.
  const stale = managedRuntimeEntry(harness.core.paths.dataDir, '@agentcomms/gmail', '0.0.1');
  await writeFile(
    join(harness.configDir, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        gmail: { command: 'node', args: [stale, 'mcp'] },
        'gmail-home': { command: 'node', args: [stale, 'mcp', '--inbox', 'home'] },
      },
    }),
  );
  // And a token some other mailbox left behind when it was removed: the machine's to clear up, not work's.
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await mkdir(dirname(orphanedSecretsPath(context)), { recursive: true });
  await writeFile(
    orphanedSecretsPath(context),
    `${JSON.stringify({ secretRef: 'gmail/refresh/ibx_GONEGONEGONEGONE', inboxId: 'ibx_GONEGONEGONEGONE', alias: 'gone' })}\n`,
  );

  const pinned = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const refused = toolError(await pinned.call('gmail_doctor', { inbox: 'home' }));
    assert.equal(refused.code, 'USAGE');
    assert.match(refused.message, /only serves the "work" mailbox/);

    const report = wire(await pinned.call('gmail_doctor', {})) as {
      checks: Array<{ id: string; detail: string; fix: string | null; inbox: string | null }>;
    };
    const byId = (id: string) => report.checks.find((check) => check.id === id);
    assert.match(byId('oauth-client')?.detail ?? '', /"default"/);
    assert.deepEqual([...new Set(report.checks.map((check) => check.inbox).filter(Boolean))], ['work']);
    // The registration serving every mailbox is still reported; the one pinned to home is not this server's to name.
    assert.match(byId('registered-server-version')?.detail ?? '', /runs 0\.0\.1 as "gmail"/);
    const said = JSON.stringify(report.checks);
    assert.equal(byId('orphaned-secrets')?.detail, 'none');
    for (const other of ['"other"', 'gmail-home', '--inbox home', 'sam@example.test', 'ibx_GONE']) {
      assert.ok(!said.includes(other), `a doctor pinned to work named ${other}`);
    }

    // The same scoping at a terminal, from the same operation: `doctor --inbox work`.
    const scoped = await cli(harness, ['doctor', '--inbox', 'work', '--json']);
    const printed = scoped.envelope<{ checks: Array<{ id: string; detail: string }> }>().data;
    assert.equal(printed?.checks.find((check) => check.id === 'oauth-client')?.detail, byId('oauth-client')?.detail);
    assert.ok(!JSON.stringify(printed?.checks).includes('gmail-home'));
  } finally {
    await pinned.close();
  }

  // Unscoped, the machine's doctor still names both.
  const whole = await cli(harness, ['doctor', '--json']);
  const all = JSON.stringify(whole.envelope().data);
  assert.match(all, /default, other/);
  assert.match(all, /gmail-home/);
  assert.match(all, /ibx_GONE/);
});

// ── a word that is not one of the choices ───────────────────────────────────────────────────────────────────

test('a tier that is not one is refused as USAGE by gmail_inbox_reauth, as `inbox reauth --tier` refuses it', async () => {
  const harness = await oneMailbox();
  const byCommand = await cli(harness, ['inbox', 'reauth', 'work', '--tier', 'everything', '--start', '--json']);
  assert.equal(byCommand.code, 64, byCommand.stdout);
  assert.equal(byCommand.envelope().error?.code, 'USAGE');

  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const refused = toolError(await call('gmail_inbox_reauth', { inbox: 'work', tier: 'everything' }));
    assert.equal(refused.code, 'USAGE');
    assert.match(refused.message, /"everything" is not a permission tier/);
    assert.match(refused.hint ?? '', /read, draft, organize/);
    // Refused before anything was prepared: no approval stands for a tier that does not exist.
    assert.deepEqual(await harness.core.approvals.list(), []);
  } finally {
    await close();
  }
});

test('every word argument a tool takes refuses a word that is not one as USAGE, naming the choices, as its command does', async () => {
  /*
   * `sendPolicy`, `changePolicy` and `tier` were already words the operation checks. Every other choice a Gmail tool
   * offered was a schema enum, so `gmail_followups {direction: 'sideways'}` was answered with the SDK's bare "Input
   * validation error: … expected one of …" — no `error.code` for an agent to act on — while `followups --direction
   * sideways` exits 64 with USAGE. Each is refused here before anything is read: the ids and paths below name nothing,
   * so a check made any later would answer NOT_FOUND instead.
   */
  const harness = await oneMailbox();
  const missing = join(harness.configDir, 'no-such-client.json');
  const cases: Array<{
    tool: string;
    args: Record<string, unknown>;
    word: string;
    choices: string[];
    argv?: string[];
  }> = [
    {
      tool: 'gmail_search',
      args: { query: 'Tuesday', kind: 'emails' },
      word: 'emails',
      choices: ['threads', 'messages'],
    },
    {
      tool: 'gmail_followups',
      args: { direction: 'sideways' },
      word: 'sideways',
      choices: ['them', 'me'],
      argv: ['followups', '--direction', 'sideways'],
    },
    {
      tool: 'gmail_export',
      args: { inbox: 'work', id: 'nope', format: 'pdf' },
      word: 'pdf',
      choices: ['md', 'json', 'eml'],
      argv: ['export', 'nope', '--inbox', 'work', '--format', 'pdf'],
    },
    {
      tool: 'gmail_draft_reply',
      args: { inbox: 'work', messageId: 'nope', text: 'Yes.', mode: 'reply_most' },
      word: 'reply_most',
      choices: ['reply', 'reply_all', 'forward'],
      argv: ['draft', 'reply', 'nope', '--inbox', 'work', '--text', 'Yes.', '--mode', 'reply_most'],
    },
    {
      tool: 'gmail_client_add',
      args: { path: missing, store: 'vault' },
      word: 'vault',
      choices: ['keychain', 'file'],
      argv: ['client', 'add', missing, '--store', 'vault'],
    },
    {
      tool: 'gmail_inbox_import',
      args: { dir: missing, store: 'vault' },
      word: 'vault',
      choices: ['keychain', 'file'],
      argv: ['inbox', 'import', '--dir', missing, '--store', 'vault'],
    },
    {
      tool: 'gmail_inbox_import',
      args: { dir: missing, store: 'vault', dryRun: true },
      word: 'vault',
      choices: ['keychain', 'file'],
      argv: ['inbox', 'import', '--dir', missing, '--store', 'vault', '--dry-run'],
    },
    {
      // A list of words: one that is not a source is refused even beside one that is.
      tool: 'gmail_contacts_search',
      args: { query: 'sam', sources: ['history', 'address-book'] },
      word: 'address-book',
      choices: ['contacts', 'other-contacts', 'history'],
      argv: ['contacts', 'sam', '--sources', 'history', 'address-book'],
    },
  ];

  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    for (const { tool, args, word, choices, argv } of cases) {
      const refused = toolError(await call(tool, args));
      assert.equal(refused.code, 'USAGE', `${tool}: ${JSON.stringify(refused)}`);
      assert.match(refused.message, new RegExp(`^"${word}" is not `), tool);
      for (const choice of choices)
        assert.match(refused.hint ?? '', new RegExp(`\\b${choice}\\b`), `${tool} names ${choice}`);

      // The command refuses the same word with the same code.
      if (argv) {
        const byCommand = await cli(harness, [...argv, '--json']);
        assert.equal(byCommand.code, 64, `${argv.join(' ')}: ${byCommand.stdout}`);
        assert.equal(byCommand.envelope().error?.code, 'USAGE');
      }
    }
    // Refused before anything was prepared: no approval stands for a store that does not exist.
    assert.deepEqual(await harness.core.approvals.list(), []);
  } finally {
    await close();
  }
});

test('a number option that is not a whole number in its range is refused as USAGE, naming it and the range, by the command and the tool alike', {
  timeout: 120_000,
}, async () => {
  /*
   * Every number option of the command was `Number.parseInt`: `--limit abc` was NaN, `--limit 1e2` was 1,
   * `--max-chars 12abc` was 12, and `--port abc` was no port at all — a sign-in on whichever port was free. The tools'
   * schemas took whole numbers only, but a number out of range was clamped by the operation (`limit: 500` searched
   * 50) or, for a port, handed to the listener to fail on. Each is checked by its operation now, before anything is
   * read, for both surfaces: refused as USAGE, naming the option as its caller spells it, and the range.
   */
  const harness = await oneMailbox();
  const nothing = 'fl_aaaaaaaaaaaaaaaaaaaaaa';
  const cases: Array<{
    argv: (value: string) => string[];
    flag: string;
    tool: string;
    args: Record<string, unknown>;
    arg: string;
    range: string;
    typed: string[];
    given: number[];
  }> = [
    {
      argv: (value) => ['search', 'Tuesday', `--limit=${value}`],
      flag: '--limit',
      tool: 'gmail_search',
      args: { query: 'Tuesday' },
      arg: 'limit',
      range: 'from 1 to 50',
      typed: ['abc', '1e2', '12abc', '0', '51', '-1', '2.5', '0x10', ''],
      given: [0, 51, -1],
    },
    {
      // The message and thread ids name nothing: a check made after the read would answer NOT_FOUND.
      argv: (value) => ['read', 'nope', '--inbox', 'work', `--max-chars=${value}`],
      flag: '--max-chars',
      tool: 'gmail_message_get',
      args: { inbox: 'work', messageId: 'nope' },
      arg: 'maxChars',
      range: 'of 1 or more',
      typed: ['0', '1e3', '12abc', 'all'],
      given: [0, -5],
    },
    {
      argv: (value) => ['read', 'nope', '--inbox', 'work', `--offset=${value}`],
      flag: '--offset',
      tool: 'gmail_message_get',
      args: { inbox: 'work', messageId: 'nope' },
      arg: 'offset',
      range: 'of 0 or more',
      typed: ['-1', '1e3', 'next'],
      given: [-1],
    },
    {
      argv: (value) => ['thread', 'nope', '--inbox', 'work', `--max-chars=${value}`],
      flag: '--max-chars',
      tool: 'gmail_thread_get',
      args: { inbox: 'work', threadId: 'nope' },
      arg: 'maxChars',
      range: 'of 1 or more',
      typed: ['0', '8k'],
      given: [0],
    },
    {
      argv: (value) => ['attachments', 'find', `--min-bytes=${value}`],
      flag: '--min-bytes',
      tool: 'gmail_attachments_find',
      args: {},
      arg: 'minBytes',
      range: 'of 0 or more',
      typed: ['-1', '1e6', '1MB'],
      given: [-1],
    },
    {
      argv: (value) => ['attachments', 'find', `--max-bytes=${value}`],
      flag: '--max-bytes',
      tool: 'gmail_attachments_find',
      args: {},
      arg: 'maxBytes',
      range: 'of 1 or more',
      typed: ['0', '10k'],
      given: [0],
    },
    {
      argv: (value) => ['attachments', 'find', `--limit=${value}`],
      flag: '--limit',
      tool: 'gmail_attachments_find',
      args: {},
      arg: 'limit',
      range: 'from 1 to 100',
      typed: ['0', '101', '1e2'],
      given: [0, 101],
    },
    {
      argv: (value) => ['attachments', 'download', 'nope', '--inbox', 'work', `--max-files=${value}`],
      flag: '--max-files',
      tool: 'gmail_attachment_download',
      args: { inbox: 'work', messageIds: ['nope'] },
      arg: 'maxFiles',
      range: 'from 1 to 200',
      typed: ['0', '201', '5x'],
      given: [0, 201],
    },
    {
      argv: (value) => ['contacts', 'sam', `--limit=${value}`],
      flag: '--limit',
      tool: 'gmail_contacts_search',
      args: { query: 'sam' },
      arg: 'limit',
      range: 'from 1 to 50',
      typed: ['0', '51', '1e1'],
      given: [0, 51],
    },
    {
      argv: (value) => ['followups', `--older-than=${value}`],
      flag: '--older-than',
      tool: 'gmail_followups',
      args: {},
      arg: 'olderThanDays',
      range: 'of 0 or more',
      typed: ['-1', '3d', '1e1'],
      given: [-1],
    },
    {
      argv: (value) => ['followups', `--lookback=${value}`],
      flag: '--lookback',
      tool: 'gmail_followups',
      args: {},
      arg: 'lookbackDays',
      range: 'of 1 or more',
      typed: ['0', '30d'],
      given: [0],
    },
    {
      argv: (value) => ['followups', `--limit=${value}`],
      flag: '--limit',
      tool: 'gmail_followups',
      args: {},
      arg: 'limit',
      range: 'from 1 to 50',
      typed: ['0', '51'],
      given: [0, 51],
    },
    {
      argv: (value) => ['draft', 'list', '--inbox', 'work', `--limit=${value}`],
      flag: '--limit',
      tool: 'gmail_draft_list',
      args: { inbox: 'work' },
      arg: 'limit',
      range: 'of 1 or more',
      typed: ['0', '1e2', 'x'],
      given: [0],
    },
    {
      // 0, as ever, is any free port: the check leaves it alone.
      argv: (value) => ['inbox', 'add', 'fresh', '--start', `--port=${value}`],
      flag: '--port',
      tool: 'gmail_inbox_add',
      args: { alias: 'fresh' },
      arg: 'port',
      range: 'from 0 to 65535',
      typed: ['abc', '1e3', '80abc', '-1', '65536', '8.0'],
      given: [-1, 65536],
    },
    {
      argv: (value) => ['inbox', 'reauth', 'work', '--start', `--port=${value}`],
      flag: '--port',
      tool: 'gmail_inbox_reauth',
      args: { inbox: 'work' },
      arg: 'port',
      range: 'from 0 to 65535',
      typed: ['abc', '70000'],
      given: [70000],
    },
    {
      // Asking for the address book widens the grant, so it is approved before the sign-in starts: a port that is not
      // one is refused before an approval is asked for a sign-in that could never start.
      argv: (value) => ['inbox', 'reauth', 'work', '--contacts', '--start', `--port=${value}`],
      flag: '--port',
      tool: 'gmail_inbox_reauth',
      args: { inbox: 'work', contacts: true },
      arg: 'port',
      range: 'from 0 to 65535',
      typed: ['70000'],
      given: [70000],
    },
    {
      // Given with `--finish`, where no port is used, a port that is not one is still refused rather than ignored.
      argv: (value) => ['inbox', 'add', '--finish', nothing, `--port=${value}`],
      flag: '--port',
      tool: 'gmail_inbox_add',
      args: { alias: 'fresh' },
      arg: 'port',
      range: 'from 0 to 65535',
      typed: ['abc'],
      given: [],
    },
  ];

  const asked = harness.google.requests.length;
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    for (const { argv, flag, tool, args, arg, range, typed, given } of cases) {
      for (const value of typed) {
        const run = await cli(harness, [...argv(value), '--json']);
        // A sign-in the old parse let through is stopped, not left listening.
        stopLater(harness, run.envelope<{ flowId?: string }>().data?.flowId);
        const label = argv(value).join(' ');
        assert.equal(run.code, 64, `${label}: ${run.stdout}`);
        const error = run.envelope().error;
        assert.equal(error?.code, 'USAGE', label);
        assert.equal(error?.message, `${flag} "${value}" is not a whole number ${range}`, label);
      }
      // The tool refuses what the command refuses, from the same check, naming the argument as a tool call spells it.
      for (const value of given) {
        const result = await call(tool, { ...args, [arg]: value });
        stopLater(harness, result.structuredContent?.flowId);
        const refused = toolError(result);
        const label = `${tool} ${arg}: ${value}`;
        assert.equal(refused.code, 'USAGE', label);
        assert.equal(refused.message, `${arg} "${value}" is not a whole number ${range}`, label);
      }
    }
  } finally {
    await close();
  }
  // Refused before anything was read, asked for or started.
  assert.equal(harness.google.requests.length, asked, 'Google was asked something');
  assert.deepEqual(await harness.core.approvals.list(), []);
  const flows = await readdir(join(harness.core.paths.stateDir, 'flows')).catch(() => []);
  assert.deepEqual(
    flows.filter((name) => name.endsWith('.json')),
    [],
    'a sign-in was started',
  );

  // And the ends of each range are still taken, from both surfaces.
  for (const argv of [
    ['search', 'Tuesday', '--limit', '50'],
    ['search', 'Tuesday', '--limit', '1'],
    ['attachments', 'find', '--limit', '100', '--min-bytes', '0', '--max-bytes', '1'],
    ['contacts', 'sam', '--limit', '50', '--sources', 'history'],
    ['followups', '--older-than', '0', '--lookback', '1', '--limit', '50'],
  ]) {
    const run = await cli(harness, [...argv, '--json']);
    assert.equal(run.code, 0, `${argv.join(' ')}: ${run.stdout}`);
  }
  const again = await connect({ core: harness.core, env: harness.env });
  try {
    assert.equal(wire(await again.call('gmail_search', { query: 'Tuesday', limit: 50 })).complete, true);
    assert.equal(wire(await again.call('gmail_search', { query: 'Tuesday', limit: '1' })).complete, true);
    assert.equal(wire(await again.call('gmail_followups', { olderThanDays: 0, lookbackDays: 1 })).complete, true);
  } finally {
    await again.close();
  }
});

test('the tools still take every word that is one', async () => {
  // The other half of the check above: a schema that stops refusing must not start refusing what is right.
  const harness = await oneMailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    for (const kind of ['threads', 'messages']) {
      assert.equal(wire(await call('gmail_search', { query: 'Tuesday', kind })).kind, kind);
    }
    for (const direction of ['them', 'me']) {
      assert.equal(wire(await call('gmail_followups', { direction })).complete, true);
    }
    for (const sources of [['contacts'], ['other-contacts'], ['history'], ['contacts', 'other-contacts', 'history']]) {
      assert.equal(wire(await call('gmail_contacts_search', { query: 'sam', sources })).query, 'sam');
    }
  } finally {
    await close();
  }
});

test('a source gmail_contacts_search does not know is refused before anything is searched, as `contacts --sources` refuses it', async () => {
  /*
   * `sources` was taken as whatever list arrived and used as a filter, so a word that is not a source was never looked
   * for and never mentioned: `sources: ['history', 'adress-book']` searched past mail alone, and `['address-book']`
   * searched nothing and answered with no contacts and `complete: true` — the answer a person reads as "nobody by
   * that name". `contacts --sources` did the same. Refused now by the operation, before any mailbox is read, naming
   * the words it takes; and the command lists them as its choices.
   */
  const harness = await oneMailbox();
  const asked = harness.google.requests.length;
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    for (const sources of [['address-book'], ['history', 'adress-book'], '["history","adress-book"]']) {
      const refused = toolError(await call('gmail_contacts_search', { query: 'sam', sources }));
      assert.equal(refused.code, 'USAGE', JSON.stringify(sources));
      assert.match(refused.message, /^"(address-book|adress-book)" is not a source/);
      assert.equal(refused.hint, 'Use contacts, other-contacts or history.');
    }
    for (const argv of [
      ['contacts', 'sam', '--sources', 'address-book'],
      ['contacts', 'sam', '--sources', 'history', 'adress-book'],
    ]) {
      const run = await cli(harness, [...argv, '--json']);
      assert.equal(run.code, 64, `${argv.join(' ')}: ${run.stdout}`);
      const error = run.envelope().error;
      assert.equal(error?.code, 'USAGE');
      assert.match(error?.message ?? '', /adress-book|address-book/);
      assert.match(error?.message ?? '', /contacts, other-contacts, history/);
    }
    assert.equal(harness.google.requests.length, asked, 'a mailbox was searched for a source that is not one');

    // Every source that is one is still searched, from the command as from the tool.
    const run = await cli(harness, ['contacts', 'sam', '--sources', 'contacts', 'other-contacts', 'history', '--json']);
    assert.equal(run.code, 0, run.stdout);
  } finally {
    await close();
  }
});

// ── the tool answers with what the command prints ───────────────────────────────────────────────────────────

test('gmail_inboxes_list, gmail_send_list and gmail_search answer with everything the command’s --json prints', async () => {
  /*
   * Each tool picked a few fields out of the operation's result, so an agent working over MCP saw less than one at a
   * terminal: which client a mailbox signs in through and whether its policies are its own or the defaults'; what a
   * prepared send would send (`expect`), its policy, and whether it is a send or a change; the search's `kind` and
   * mailboxes, and each row's recipient count. None of it is a secret, so none of it is held back.
   */
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
            snippet: 'About Tuesday',
            internalDate: String(Date.parse('2026-09-17T09:00:00Z')),
            payload: {
              partId: '',
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Sam <sam@partner.test>' },
                { name: 'To', value: 'Jo <jo@example.test>, kim@example.test' },
                { name: 'Subject', value: 'Tuesday' },
              ],
              body: { size: 2, data: Buffer.from('hi', 'utf8').toString('base64url') },
            },
          },
        },
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: 'confirm' });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tue', text: 'Tuesday.' });
  await prepareSend(context, 'work', draft.draftId);
  await inboxPolicy(context, 'work', { sendPolicy: 'never' });

  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    // A change approval as well as a send, so `kind` has something to tell apart.
    approvalAsked(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'chat' }));

    const inboxes = (await cli(harness, ['inbox', 'list', '--json'])).envelope<unknown[]>().data;
    assert.deepEqual(wire(await call('gmail_inboxes_list')).inboxes, inboxes);

    const approvals = (await cli(harness, ['send', 'list', '--json'])).envelope<Array<{ kind?: string }>>().data;
    assert.equal(approvals?.length, 2);
    assert.deepEqual(approvals?.map((approval) => approval.kind ?? 'send').sort(), ['change', 'send']);
    assert.deepEqual(wire(await call('gmail_send_list', {})).approvals, approvals);

    const searched = (await cli(harness, ['search', 'Tuesday', '--json'])).envelope<Record<string, unknown>>().data;
    const found = wire(await call('gmail_search', { query: 'Tuesday' }));
    // `nextCursor` is null over MCP where the command leaves it out, and the envelope's boundary is drawn afresh for
    // every answer; everything else is the same.
    assert.equal(found.nextCursor, null);
    const unbounded = (text: unknown) => String(text).replaceAll(/boundary="[^"]+"/g, 'boundary=""');
    const { nextCursor: _cursor, ...rest } = found;
    assert.deepEqual(
      { ...rest, enveloped: unbounded(rest.enveloped) },
      { ...searched, enveloped: unbounded(searched?.enveloped) },
    );
    assert.equal((rest.rows as Array<{ toCount: number }>)[0]?.toCount, 2);
  } finally {
    await close();
  }
});

test('gmail_inbox_finish answers with the mailbox it connected, as `--finish --json` does, without its token’s place', async () => {
  const harness = await readyToConnect();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const first = wire(await call('gmail_inbox_add', { alias: 'viatool', email: 'jo@example.test' }));
    stopLater(harness, first.flowId);
    const finished = wire(
      await call('gmail_inbox_finish', {
        flowId: first.flowId,
        url: harness.google.consent(String(first.authUrl), { sub: 'sub-1' }),
      }),
    );

    const second = wire(await call('gmail_inbox_add', { alias: 'viacli', email: 'sam@example.test' }));
    stopLater(harness, second.flowId);
    const byCommand = await cli(harness, [
      'inbox',
      'add',
      '--finish',
      String(second.flowId),
      '--url',
      harness.google.consent(String(second.authUrl), { sub: 'sub-2' }),
      '--json',
    ]);
    const printed = byCommand.envelope<{ inbox: Record<string, unknown> }>().data;
    assert.ok(printed);

    // Every field the command prints, the tool answers — except where the refresh token is kept, which no tool names.
    for (const key of Object.keys(printed)) assert.ok(key in finished, `the tool left out ${key}`);
    const inbox = finished.inbox as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(inbox).sort(),
      Object.keys(printed.inbox)
        .filter((key) => key !== 'secretRef')
        .sort(),
    );
    assert.equal('secretRef' in inbox, false);
    assert.equal(inbox.email, 'jo@example.test');
    assert.equal(inbox.id, (await harness.core.config.load()).inboxes.viatool?.id);
    // What it answered before stays where it was.
    assert.equal(finished.email, 'jo@example.test');
    assert.equal(finished.tier, inbox.tier);
  } finally {
    await close();
  }
});

// ── setup: the report is the tool; the steps are the tools that take them ───────────────────────────────────

test('gmail_setup answers with the report `setup --json` makes before it takes any step', async () => {
  /*
   * `agent-gmail setup` is a report and then up to three steps — the client, a mailbox, the agent connection — which
   * over MCP are gmail_client_add, gmail_inbox_add and comms_server_install (capabilities.json says so row by row).
   * gmail_setup is the report half: with no flags and no terminal, `setup --json` changes nothing and prints the same
   * state, plus the fields about steps it took (`did`, `warnings`, `blocked`, `handoff`), which a report has none of.
   */
  const harness = await workAndHome();
  const printed = await cli(harness, ['setup', '--json']);
  const report = printed.envelope<Record<string, unknown>>().data ?? {};
  assert.deepEqual(report.did, [], 'setup with no flags took a step');

  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const answered = wire(await call('gmail_setup', {}));
    const steps = new Set(['did', 'warnings', 'blocked', 'handoff']);
    for (const [key, value] of Object.entries(report)) {
      if (steps.has(key)) continue;
      assert.deepEqual(answered[key], value, key);
    }
    assert.deepEqual(answered.clientOf, { home: 'other', work: 'default' });
  } finally {
    await close();
  }

  // Pinned, it is still only its own mailbox's.
  const pinned = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const answered = wire(await pinned.call('gmail_setup', {}));
    assert.deepEqual(answered.clientOf, { work: 'default' });
    assert.deepEqual(answered.clients, ['default']);
  } finally {
    await pinned.close();
  }
});
