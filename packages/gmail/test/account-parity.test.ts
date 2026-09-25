import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { GmailContext } from '../src/context.ts';
import { createGmailMcpServer } from '../src/mcp/server.ts';
import { addConfirmClient, completeProbe, startProbe } from '../src/operations/confirm-clients.ts';
import { inboxPolicy } from '../src/operations/inboxes.ts';
import { type Harness, migrateNamesForTest, newHarness, TEST_CLIENT_SECRET } from './support/harness.ts';

/*
 * Account management from both surfaces.
 *
 * The owner's rule since 2026-09-25 is that everything the CLI can do to an account, a chat can do too, and the
 * other way round. The tests here hold each new tool to the command it mirrors: the same operation, the same
 * result, and the same refusal — checked by running both against one configuration and comparing what came back,
 * rather than by asserting each side separately and trusting they agree.
 */

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string };
}

async function connect(options: Parameters<typeof createGmailMcpServer>[0]): Promise<{
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  names: () => Promise<string[]>;
  close: () => Promise<void>;
}> {
  const built = await createGmailMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as ToolResult,
    names: async () => (await client.listTools()).tools.map((tool) => tool.name).sort(),
    close: async () => {
      await client.close();
      await built.close();
    },
  };
}

/** Runs the CLI in-process, answering the typed challenge as a person at a terminal would when asked to. */
async function cli(
  harness: Harness,
  argv: string[],
  options: { tty?: boolean; answerChallenge?: boolean; stdin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string; envelope: <T>() => Envelope<T> }> {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  const input = new PassThrough();
  if (options.stdin !== undefined) input.write(options.stdin);
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  let answered = false;
  err.on('data', (chunk) => {
    stderr += String(chunk);
    if (options.answerChallenge && !answered) {
      // The code is invented per run, so it is read back off the prompt.
      const asked = /Type (\S+) to confirm/.exec(stderr);
      if (asked) {
        answered = true;
        input.write(`${asked[1]}\n`);
      }
    }
  });
  const tty = options.tty ?? false;
  const code = await run(argv, {
    core: harness.core,
    env: { ...harness.env, ...options.env },
    streams: {
      stdout: Object.assign(out, { isTTY: tty }),
      stderr: Object.assign(err, { isTTY: tty }),
      stdin: Object.assign(input, { isTTY: tty }),
    },
  });
  return { code, stdout, stderr, envelope: <T>() => JSON.parse(stdout) as Envelope<T> };
}

/**
 * A tool's result as a client receives it: JSON, so a key whose value is `undefined` is not there at all, exactly as
 * it is not in the CLI's envelope. The in-memory transport these tests use hands the object over as it was built.
 */
function wire(result: ToolResult): unknown {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(JSON.stringify(result.structuredContent));
}

/** The error a tool returned, as the envelope's `error` is shaped. */
function toolError(result: ToolResult): { code: string; message: string; hint: string | null } {
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent?.error as { code: string; message: string; hint: string | null };
}

async function twoMailboxes(): Promise<Harness> {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  // A second client, so a filter that forgot to scope by client is visible rather than passing by coincidence.
  await harness.addInbox({
    alias: 'home',
    email: 'sam@example.test',
    sub: 'sub-2',
    refreshToken: 'rt_y',
    client: 'other',
  });
  return harness;
}

// ── Which servers offer what ────────────────────────────────────────────────────────────────────────────────

test('the confirm-clients tools map one to one onto the CLI, and the probe stays the one tool with no command', async () => {
  const harness = await newHarness();
  const { names, close } = await connect({ core: harness.core, env: harness.env });
  try {
    /*
     * Three tools, three different operations: the probe is the evidence (an MCP form has no terminal
     * equivalent), the list is `confirm-clients list`, and removing is `confirm-clients remove`. Adding a name is
     * a loosening, so it stays a terminal command until change approvals exist — a fourth tool here would be one
     * that trusts a client on the model's say-so.
     */
    assert.deepEqual(
      (await names()).filter((name) => name.startsWith('gmail_confirm')),
      ['gmail_confirm_client_remove', 'gmail_confirm_clients', 'gmail_confirm_probe'],
    );
  } finally {
    await close();
  }
});

test('a pinned server does not rename, and a read-only one changes nothing about an account', async () => {
  const harness = await twoMailboxes();

  const pinned = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const offered = await pinned.names();
    /*
     * A rename from a pinned server could only ever rename its own mailbox, and the pin names the old word — so the
     * server would refuse every call after it, as `checkPin` does for a rename made elsewhere. A tool whose one
     * possible use strands the server that offers it is not a tool worth offering there.
     */
    assert.equal(offered.includes('gmail_inbox_rename'), false, 'a pinned server offered to rename');
    // Reading its own mailbox, and making sending from it stricter, stay.
    for (const kept of ['gmail_inbox_show', 'gmail_inbox_policy', 'gmail_clients_list', 'gmail_confirm_clients']) {
      assert.ok(offered.includes(kept), `a pinned server should offer ${kept}`);
    }
  } finally {
    await pinned.close();
  }

  const readOnly = await connect({ core: harness.core, env: harness.env, readOnly: true });
  try {
    const offered = await readOnly.names();
    for (const read of ['gmail_inbox_show', 'gmail_clients_list', 'gmail_confirm_clients']) {
      assert.ok(offered.includes(read), `a read-only server should offer ${read}`);
    }
    for (const write of ['gmail_inbox_rename', 'gmail_inbox_policy', 'gmail_confirm_client_remove']) {
      assert.equal(offered.includes(write), false, `a read-only server offered ${write}`);
    }
  } finally {
    await readOnly.close();
  }
});

// ── inbox show ──────────────────────────────────────────────────────────────────────────────────────────────

test('gmail_inbox_show answers exactly what `inbox show --json` does', async () => {
  const harness = await twoMailboxes();
  await inboxPolicy(new GmailContext({ core: harness.core, env: harness.env }), 'work', 'confirm');

  const shown = await cli(harness, ['inbox', 'show', 'work', '--json']);
  assert.equal(shown.code, 0, shown.stderr);
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const result = await call('gmail_inbox_show', { inbox: 'work' });
    assert.deepEqual(wire(result), shown.envelope().data);
    assert.equal(result.structuredContent?.sendPolicy, 'confirm');
    assert.equal(result.structuredContent?.sendPolicyInherited, false);

    // The same refusal for a name that is not there, from the same operation.
    const missing = await cli(harness, ['inbox', 'show', 'nope', '--json']);
    const refused = toolError(await call('gmail_inbox_show', { inbox: 'nope' }));
    assert.equal(refused.code, missing.envelope().error?.code);
    assert.equal(refused.message, missing.envelope().error?.message);
  } finally {
    await close();
  }
});

test('a pinned server shows and tightens its own mailbox, and refuses any other', async () => {
  const harness = await twoMailboxes();
  const { call, close } = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const own = await call('gmail_inbox_show', {});
    assert.equal(own.structuredContent?.alias, 'work');
    assert.match(toolError(await call('gmail_inbox_show', { inbox: 'home' })).message, /only serves the "work"/);

    assert.equal((await call('gmail_inbox_policy', { sendPolicy: 'never' })).isError, undefined);
    const other = toolError(await call('gmail_inbox_policy', { inbox: 'home', sendPolicy: 'never' }));
    assert.match(other.message, /only serves the "work"/);
    const config = await harness.core.config.load();
    assert.equal(config.inboxes.work?.sendPolicy, 'never');
    assert.equal(config.inboxes.home?.sendPolicy, undefined, 'a pinned server changed a mailbox it does not serve');
  } finally {
    await close();
  }
});

// ── inbox rename ────────────────────────────────────────────────────────────────────────────────────────────

test('gmail_inbox_rename renames as `inbox rename` does, and refuses what it refuses', async () => {
  const viaCli = await twoMailboxes();
  const viaTool = await twoMailboxes();

  const renamed = await cli(viaCli, ['inbox', 'rename', 'work', 'main', '--json']);
  assert.equal(renamed.code, 0, renamed.stderr);
  const { call, close } = await connect({ core: viaTool.core, env: viaTool.env });
  try {
    const result = await call('gmail_inbox_rename', { from: 'work', to: 'main' });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const cliData = renamed.envelope<{ from: string; to: string; id: string }>().data;
    // The id is minted per harness, so it is compared by shape; the names are compared exactly.
    assert.deepEqual({ ...result.structuredContent, id: 'x' }, { ...cliData, id: 'x' });
    assert.match(String(result.structuredContent?.id), /\S/);
    assert.deepEqual(Object.keys((await viaTool.core.config.load()).inboxes).sort(), ['home', 'main']);

    const audit = await viaTool.core.audit.tail({ inbox: 'main' });
    const row = audit.find((entry) => entry.operation === 'inbox.rename');
    assert.equal(row?.surface, 'mcp', 'the audit trail should say the rename came from chat');

    // Each refusal the CLI gives, the tool gives in the same words.
    for (const [from, to] of [
      ['home', 'main'], // taken
      ['home', 'all'], // reserved
      ['nope', 'spare'], // no such mailbox
      ['home', 'Not A Name'], // not a name
    ] as const) {
      const byCommand = (await cli(viaTool, ['inbox', 'rename', from, to, '--json'])).envelope().error;
      const byTool = toolError(await call('gmail_inbox_rename', { from, to }));
      assert.ok(byCommand, `the CLI accepted ${from} → ${to}`);
      assert.equal(byTool.code, byCommand.code, `${from} → ${to}`);
      assert.equal(byTool.message, byCommand.message, `${from} → ${to}`);
    }
  } finally {
    await close();
  }
});

test('a former name is never taken again, from chat as from the terminal', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  await migrateNamesForTest(harness, ['work=acme/gmail']);
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    assert.equal((await call('gmail_inbox_rename', { from: 'acme/gmail', to: 'acme/gmail-main' })).isError, undefined);
    const back = toolError(await call('gmail_inbox_rename', { from: 'acme/gmail-main', to: 'acme/gmail' }));
    assert.equal(back.code, 'CONFIG');
    assert.match(back.message, /cannot be used again/);
    // And the old name, used as the source, is answered with the new one.
    const stale = toolError(await call('gmail_inbox_rename', { from: 'acme/gmail', to: 'acme/gmail-other' }));
    assert.match(stale.message, /renamed to "acme\/gmail-main"/);
  } finally {
    await close();
  }
});

// ── inbox policy ────────────────────────────────────────────────────────────────────────────────────────────

test('gmail_inbox_policy tightens as `inbox policy` does, with the same result', async () => {
  const viaCli = await twoMailboxes();
  const viaTool = await twoMailboxes();
  const byCommand = await cli(viaCli, ['inbox', 'policy', 'work', '--send', 'confirm', '--json']);
  assert.equal(byCommand.code, 0, byCommand.stderr);

  const { call, close } = await connect({ core: viaTool.core, env: viaTool.env });
  try {
    const byTool = await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'confirm' });
    assert.equal(byTool.isError, undefined, JSON.stringify(byTool.content));
    assert.deepEqual(byTool.structuredContent, byCommand.envelope().data);
    assert.deepEqual(byTool.structuredContent, { alias: 'work', sendPolicy: 'confirm', previous: 'chat' });

    // Further, to never, and the same value again: neither loosens anything.
    assert.equal((await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'never' })).isError, undefined);
    assert.equal((await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'never' })).isError, undefined);
    assert.equal((await viaTool.core.config.load()).inboxes.work?.sendPolicy, 'never');

    const audit = await viaTool.core.audit.tail({ inbox: 'work' });
    assert.ok(audit.some((entry) => entry.operation === 'inbox.policy' && entry.surface === 'mcp'));
  } finally {
    await close();
  }
});

test('gmail_inbox_policy refuses a loosening, says it needs a change approval, and changes nothing', async () => {
  const harness = await twoMailboxes();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'never' });
    for (const looser of ['confirm', 'chat']) {
      const refused = toolError(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: looser }));
      assert.equal(refused.code, 'LOOSENING_REFUSED', looser);
      assert.match(refused.message, /needs a change approval/, looser);
      // The one thing that works today, named exactly, so the agent can hand it over rather than hunt for another way.
      assert.match(refused.hint ?? '', new RegExp(`agent-gmail inbox policy work --send ${looser}`), looser);
      assert.equal((await harness.core.config.load()).inboxes.work?.sendPolicy, 'never', `${looser} was written`);
    }
    // A mailbox that inherits the default is measured against the default: `chat` is not looser than `chat`.
    const inherited = await call('gmail_inbox_policy', { inbox: 'home', sendPolicy: 'chat' });
    assert.equal(inherited.isError, undefined, JSON.stringify(inherited.content));
  } finally {
    await close();
  }
});

test('the refusal lives in the operation, so no surface that forgets to ask for consent can loosen', async () => {
  const harness = await twoMailboxes();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await inboxPolicy(context, 'work', 'never');
  await assert.rejects(inboxPolicy(context, 'work', 'chat'), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'LOOSENING_REFUSED');
    assert.match(error.message, /making sending from "work" easier \(never → chat\) needs a change approval/);
    return true;
  });
  assert.equal((await harness.core.config.load()).inboxes.work?.sendPolicy, 'never');
});

test('a person at a terminal who types the code still loosens it from the CLI', async () => {
  const harness = await twoMailboxes();
  await inboxPolicy(new GmailContext({ core: harness.core, env: harness.env }), 'work', 'never');
  const loosened = await cli(harness, ['inbox', 'policy', 'work', '--send', 'chat'], {
    tty: true,
    answerChallenge: true,
  });
  assert.equal(loosened.code, 0, loosened.stderr);
  assert.match(loosened.stdout, /now needs: chat \(was never\)/);
  assert.equal((await harness.core.config.load()).inboxes.work?.sendPolicy, 'chat');

  // And tightening at a terminal asks nobody anything. Enter is waiting on stdin, so a question asked by mistake is
  // answered with "cancel" and fails here, rather than waiting for ever on a terminal nobody is at.
  const tightened = await cli(harness, ['inbox', 'policy', 'work', '--send', 'confirm'], { tty: true, stdin: '\n' });
  assert.equal(tightened.code, 0, tightened.stderr);
  assert.doesNotMatch(tightened.stderr, /to confirm/);
});

test('a policy that is not one of the three is refused the same way before anything is resolved', async () => {
  const harness = await twoMailboxes();
  const refused = await cli(harness, ['inbox', 'policy', 'work', '--send', 'sometimes', '--json']);
  assert.equal(refused.code, 64);
  assert.match(refused.envelope().error?.message ?? '', /"sometimes" is not a send policy/);
});

// ── clients ─────────────────────────────────────────────────────────────────────────────────────────────────

test('gmail_clients_list lists what `client list` does, and never a secret', async () => {
  const harness = await twoMailboxes();
  const listed = await cli(harness, ['client', 'list', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const result = await call('gmail_clients_list');
    // A list is wrapped under a name, as `gmail_inboxes_list` wraps `inbox list`: a tool's result is an object.
    assert.deepEqual(wire(result), { clients: listed.envelope().data });
    const clients = result.structuredContent?.clients as Array<Record<string, unknown>>;
    assert.deepEqual(
      clients.map((client) => [client.name, client.inboxes]),
      [
        ['default', ['work']],
        ['other', ['home']],
      ],
    );
    for (const client of (wire(result) as { clients: Array<Record<string, unknown>> }).clients) {
      // The fields a person needs to tell clients apart, and nothing that locates or is the secret.
      assert.deepEqual(Object.keys(client).sort(), ['addedAt', 'clientId', 'inboxes', 'name'], String(client.name));
    }
    for (const said of [JSON.stringify(result), listed.stdout]) {
      assert.doesNotMatch(said, new RegExp(TEST_CLIENT_SECRET), 'a client secret reached a result');
      assert.doesNotMatch(said, /secretRef|clientSecret|client_secret/, 'where the secret is kept reached a result');
    }
  } finally {
    await close();
  }
});

test('a pinned gmail_clients_list names only the client its mailbox signs in through', async () => {
  const harness = await twoMailboxes();
  const { call, close } = await connect({ core: harness.core, env: harness.env, inbox: 'home' });
  try {
    const clients = (await call('gmail_clients_list')).structuredContent?.clients as Array<{
      name: string;
      inboxes: string[];
    }>;
    assert.deepEqual(
      clients.map((client) => [client.name, client.inboxes]),
      [['other', ['home']]],
      'a pinned server named a client, or a mailbox, it does not serve',
    );
  } finally {
    await close();
  }
});

// ── confirm-clients ─────────────────────────────────────────────────────────────────────────────────────────

test('gmail_confirm_clients and gmail_confirm_client_remove are `confirm-clients list` and `remove`', async () => {
  const harness = await newHarness();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  for (const name of ['client-a', 'client-b']) {
    // Trusted the only way a client can be: a probe a person answered, then consent from a terminal.
    await completeProbe(context, (await startProbe(context, name)).probeId);
    await addConfirmClient(context, name, {
      kind: 'loosening-consent',
      paths: ['defaults.confirm.elicitationClients'],
    });
  }

  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const listed = await cli(harness, ['confirm-clients', 'list', '--json']);
    assert.deepEqual((await call('gmail_confirm_clients')).structuredContent, { clients: listed.envelope().data });
    assert.deepEqual(listed.envelope().data, ['client-a', 'client-b']);

    // Trusting one fewer client is a tightening: nobody is asked, and it takes effect for the next send.
    const removed = await call('gmail_confirm_client_remove', { name: 'client-a' });
    assert.equal(removed.isError, undefined, JSON.stringify(removed.content));
    assert.deepEqual(removed.structuredContent, { clients: ['client-b'] });
    const byCommand = await cli(harness, ['confirm-clients', 'remove', 'client-b', '--json']);
    assert.deepEqual(byCommand.envelope().data, []);
    assert.deepEqual((await call('gmail_confirm_clients')).structuredContent, { clients: [] });

    const audit = await harness.core.audit.tail();
    assert.ok(audit.some((entry) => entry.operation === 'confirm-clients.remove' && entry.surface === 'mcp'));
  } finally {
    await close();
  }
});
