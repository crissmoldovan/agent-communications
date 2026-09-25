import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ConfigV2, renameEntry } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { GmailContext } from '../src/context.ts';
import { mcpBoolean, mcpInboxes, mcpInteger, mcpStringArray } from '../src/mcp/schemas.ts';
import { assertRegistrationShape, buildInstructions, createGmailMcpServer } from '../src/mcp/server.ts';
import { migrateNamesForTest, newHarness, tempDir } from './support/harness.ts';

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

/** Connects an SDK client to the server over an in-memory pair, the same messages a stdio client would exchange. */
async function connect(options: Parameters<typeof createGmailMcpServer>[0]): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const built = await createGmailMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await built.close();
    },
  };
}

test('the tool list is the same whatever is configured, and every tool says what it is for', async () => {
  const empty = await newHarness();
  const withInbox = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await withInbox.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });

  const names = async (harness: { env: NodeJS.ProcessEnv; core: unknown }): Promise<string[]> => {
    const { client, close } = await connect({ core: harness.core as never, env: harness.env });
    try {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a description an agent can choose by`);
        assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
      }
      return listed.tools.map((tool) => tool.name).sort();
    } finally {
      await close();
    }
  };

  const withoutInboxes = await names(empty);
  assert.deepEqual(withoutInboxes, [
    'gmail_attachment_download',
    'gmail_attachments_find',
    'gmail_client_add',
    'gmail_client_remove',
    'gmail_clients_list',
    'gmail_confirm_client_add',
    'gmail_confirm_client_remove',
    'gmail_confirm_clients',
    'gmail_confirm_probe',
    'gmail_contacts_search',
    'gmail_doctor',
    'gmail_draft_create',
    'gmail_draft_delete',
    'gmail_draft_get',
    'gmail_draft_list',
    'gmail_draft_reply',
    'gmail_draft_send',
    'gmail_draft_update',
    'gmail_export',
    'gmail_followups',
    // Onboarding is reachable over MCP too: an agent asked to "set up Gmail" could otherwise do nothing
    // but tell the person to go and run a CLI, which is where most of them stop.
    'gmail_inbox_add',
    'gmail_inbox_finish',
    // Account management is reachable from a chat as from a terminal (2026-09-25). What loosens a safety setting, or
    // cannot be taken back, asks for a change approval on either surface before it is done.
    'gmail_inbox_import',
    'gmail_inbox_policy',
    'gmail_inbox_reauth',
    'gmail_inbox_remove',
    'gmail_inbox_rename',
    'gmail_inbox_show',
    'gmail_inboxes_list',
    'gmail_label_create',
    'gmail_labels_list',
    'gmail_message_get',
    'gmail_organise',
    'gmail_organise_undo',
    'gmail_search',
    'gmail_send_cancel',
    'gmail_send_list',
    'gmail_send_prepare',
    'gmail_sendas_list',
    'gmail_setup',
    'gmail_thread_get',
    'gmail_thread_timeline',
    'gmail_trash',
    'gmail_whoami',
  ]);
  assert.deepEqual(await names(withInbox), withoutInboxes, 'registration must not depend on the inboxes present');

  // Exactly one tool sends, and it is registered whatever the policy is: registration has never been the gate, and a
  // tool list that changed with the config would tell an agent which mailboxes are worth trying.
  assert.deepEqual(withoutInboxes.filter((name) => name.includes('send')).sort(), [
    'gmail_draft_send',
    'gmail_send_cancel',
    'gmail_send_list',
    'gmail_send_prepare',
    'gmail_sendas_list',
  ]);
});

test('a read-only server does not offer the tools that would write', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const { client, close } = await connect({ core: harness.core, env: harness.env, readOnly: true });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    // Reading a draft is reading; writing one is not.
    assert.ok(names.includes('gmail_draft_list'));
    assert.ok(names.includes('gmail_draft_get'));
    for (const withheld of [
      'gmail_draft_create',
      'gmail_draft_reply',
      'gmail_draft_update',
      'gmail_draft_delete',
      'gmail_organise',
      'gmail_organise_undo',
      'gmail_trash',
      'gmail_label_create',
      'gmail_send_prepare',
      'gmail_draft_send',
      // Connecting a mailbox is a write. A read-only server was started that way for a reason, and a tool that
      // adds a mailbox to it would be the one write it could not refuse.
      'gmail_inbox_add',
      'gmail_inbox_finish',
      'gmail_send_cancel',
      'gmail_confirm_probe',
      // Renaming, setting a policy, trusting or forgetting a client, and the rest of account management all write.
      'gmail_inbox_rename',
      'gmail_inbox_policy',
      'gmail_confirm_client_add',
      'gmail_confirm_client_remove',
      'gmail_inbox_reauth',
      'gmail_inbox_import',
      'gmail_inbox_remove',
      'gmail_client_add',
      'gmail_client_remove',
    ]) {
      assert.ok(!names.includes(withheld), `${withheld} must not be offered by a read-only server`);
    }
    // A tool that was not registered is not there to be called: the protocol itself refuses, before any handler runs.
    await assert.rejects(
      client.callTool({ name: 'gmail_organise', arguments: { inbox: 'work', messageIds: ['m1'], archive: true } }),
      /not found/i,
    );
  } finally {
    await close();
  }
});

test('results arrive as structured content and as text, so every client sees them', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const { client, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const result = (await client.callTool({ name: 'gmail_inboxes_list', arguments: {} })) as ToolResult;
    const inboxes = result.structuredContent?.inboxes as Array<Record<string, unknown>>;
    assert.equal(inboxes.length, 1);
    assert.equal(inboxes[0]?.alias, 'work');
    assert.equal(inboxes[0]?.sendPolicy, 'chat');
    // Claude Code and Codex read only structuredContent; Cursor reads only the text block. Both must carry it.
    assert.equal(result.content?.length, 1);
    assert.deepEqual(JSON.parse(result.content?.[0]?.text ?? ''), result.structuredContent);
  } finally {
    await close();
  }
});

test('a tool that needs a mailbox refuses to guess one, and says how to find the names', async () => {
  const harness = await newHarness();
  const { client, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const result = (await client.callTool({ name: 'gmail_whoami', arguments: {} })) as ToolResult;
    // The SDK validates arguments against the declared schema before the handler runs, so this is its message,
    // not ours; what matters is that it names the missing argument rather than defaulting to some mailbox.
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /inbox/);
    assert.equal(result.structuredContent, undefined);
  } finally {
    await close();
  }
});

test('an unknown mailbox is reported with the names that do exist', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const { client, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const result = (await client.callTool({ name: 'gmail_whoami', arguments: { inbox: 'nope' } })) as ToolResult;
    assert.equal(result.isError, true);
    const error = result.structuredContent?.error as { code: string; hint: string };
    assert.equal(error.code, 'NOT_FOUND');
    assert.match(error.hint, /work/);
  } finally {
    await close();
  }
});

test('a pinned server serves one mailbox and refuses any other', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  await harness.addInbox({ alias: 'home', email: 'jo.home@example.test', sub: 'sub-2', refreshToken: 'rt_y' });
  const { client, close } = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const listed = (await client.callTool({ name: 'gmail_inboxes_list', arguments: {} })) as ToolResult;
    const inboxes = listed.structuredContent?.inboxes as Array<{ alias: string }> | undefined;
    assert.ok(inboxes, 'the tool returned no structured result');
    assert.deepEqual(
      inboxes.map((inbox) => inbox.alias),
      ['work'],
    );

    const other = (await client.callTool({ name: 'gmail_whoami', arguments: { inbox: 'home' } })) as ToolResult;
    assert.equal(other.isError, true);
    assert.match(
      String((other.structuredContent?.error as { message: string } | undefined)?.message),
      /only serves the "work" mailbox/,
    );
  } finally {
    await close();
  }
});

test('a pinned server refuses to start when its mailbox is gone', async () => {
  const harness = await newHarness();
  await assert.rejects(createGmailMcpServer({ core: harness.core, env: harness.env, inbox: 'missing' }));
});

test('whoami reaches Google and reports what it says, with the server version', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const { refreshToken } = await signIn(harness);
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken });
  const { client, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const result = (await client.callTool({ name: 'gmail_whoami', arguments: { inbox: 'work' } })) as ToolResult;
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.profileEmail, 'jo@example.test');
    assert.equal(result.structuredContent?.matches, true);
    assert.match(String(result.structuredContent?.serverVersion), /^\d+\.\d+\.\d+/);
  } finally {
    await close();
  }
});

test('doctor reports the checks and their fixes through the tool', async () => {
  const harness = await newHarness();
  const { client, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const result = (await client.callTool({ name: 'gmail_doctor', arguments: {} })) as ToolResult;
    const checks = result.structuredContent?.checks as Array<{ id: string; status: string; fix: string | null }>;
    const client_ = checks.find((check) => check.id === 'oauth-client');
    assert.equal(client_?.status, 'fail');
    // One command, and one a person can actually act on. This used to answer `client add
    // ~/Downloads/client_secret_*.json`, naming a file that only exists after five screens of Google Cloud that
    // nothing had mentioned — repair advice given to somebody who had not built the thing yet. An agent reading
    // this over MCP cannot do any of it either, so what it needs is the single thing to tell the user.
    assert.equal(client_?.fix, 'agent-gmail setup');
    assert.equal(checks.find((check) => check.id === 'inboxes')?.fix, 'agent-gmail setup');
    assert.equal(result.structuredContent?.healthy, false);
  } finally {
    await close();
  }
});

test('the instructions tell the model the three things it must know, and stay under 2 KB', async () => {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  // A second mailbox, so the pinned assertion below is about something. With one inbox it passed either way.
  await harness.addInbox({ alias: 'personal', email: 'sam@example.test', sub: 'sub-2', refreshToken: 'rt_y' });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const instructions = await buildInstructions(context, undefined);
  assert.ok(Buffer.byteLength(instructions) < 2048, 'Claude Code truncates instructions at 2 KB');
  assert.match(instructions, /untrusted-content/);
  assert.match(instructions, /approve/);
  assert.match(instructions, /Pass `inbox` on every call/);
  assert.match(instructions, /work/);
  assert.match(instructions, /personal/, 'an unpinned server lists what it serves');
  const pinnedText = await buildInstructions(context, 'work');
  assert.match(pinnedText, /pinned to the "work" mailbox/);
  // The greeting is the first thing a model reads, and it used to list every alias on the machine whatever the
  // server was pinned to. Naming the pin is not enough: the others have to be absent.
  assert.doesNotMatch(pinnedText, /personal/, 'a pinned server named a mailbox it does not serve');
});

test('arguments some clients send as strings are accepted exactly, never guessed', () => {
  assert.equal(mcpBoolean().parse(true), true);
  assert.equal(mcpBoolean().parse('true'), true);
  assert.equal(mcpBoolean().parse('FALSE'), false);
  // z.coerce.boolean() would call this true, which is the opposite of what the caller said.
  assert.throws(() => mcpBoolean().parse('no'));
  assert.throws(() => mcpBoolean().parse(1));

  assert.equal(mcpInteger().parse('12'), 12);
  assert.equal(mcpInteger().parse(-3), -3);
  assert.throws(() => mcpInteger().parse('12.5'));
  assert.throws(() => mcpInteger().parse('twelve'));

  assert.deepEqual(mcpStringArray().parse('["a","b"]'), ['a', 'b']);
  assert.deepEqual(mcpStringArray().parse(['a']), ['a']);
  assert.throws(() => mcpStringArray().parse('a,b'));
  assert.throws(() => mcpStringArray().parse('[1,2]'));

  assert.deepEqual(mcpInboxes().parse('work'), ['work']);
  assert.deepEqual(mcpInboxes().parse('["work","home"]'), ['work', 'home']);
  assert.equal(mcpInboxes().parse('all'), 'all');
  assert.throws(() => mcpInboxes().parse(7));
});

/** Signs in through the fake Google so an inbox has a token that really refreshes. */
async function signIn(harness: Awaited<ReturnType<typeof newHarness>>): Promise<{ refreshToken: string }> {
  const { buildAuthUrl, exchangeCode, newPkce } = await import('../src/auth/oauth.ts');
  const { scopesFor } = await import('../src/auth/scopes.ts');
  const { TEST_CLIENT_ID, TEST_CLIENT_SECRET } = await import('./support/harness.ts');
  const pkce = newPkce();
  const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes: scopesFor('organize', true),
    state: 'st',
    codeChallenge: pkce.challenge,
  });
  const code = new URL(harness.google.consent(authUrl)).searchParams.get('code') ?? '';
  const tokens = await exchangeCode({
    client,
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:5123/',
  });
  return { refreshToken: tokens.refreshToken };
}

test('a pinned server will not connect a second mailbox', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const { client, close } = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    // A server started `--inbox work` exists to reach exactly that mailbox. A tool that adds a second one turns
    // the pin into a suggestion, and the person who set it would have no way to know the surface had grown.
    assert.equal(names.includes('gmail_inbox_add'), false, 'a pinned server must not add mailboxes');
    assert.equal(names.includes('gmail_inbox_finish'), false);
    // Saying what is missing changes nothing, so the read-only one stays.
    assert.ok(names.includes('gmail_setup'));
  } finally {
    await close();
  }
});

test('a pinned gmail_setup answers about its own mailbox and nothing else', async () => {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  // Two clients, not one: with both mailboxes on `default` the client assertion below passes whether the filter
  // is there or not, which is the shape of a test that reads as coverage and is not.
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  await harness.addInbox({
    alias: 'personal',
    email: 'sam@example.test',
    sub: 'sub-2',
    refreshToken: 'rt_y',
    client: 'other',
  });

  // A client JSON sitting in the download directory. Unpinned this is the tool's whole point; pinned it is a
  // path out of somebody's Downloads folder that a server narrowed to one mailbox has no business reporting.
  const downloads = join(tempDir(), 'Downloads');
  await mkdir(downloads, { recursive: true });
  await writeFile(
    join(downloads, 'client_secret_x.json'),
    JSON.stringify({ installed: { client_id: 'cid.apps.googleusercontent.com', client_secret: 's' } }),
  );
  const env = { ...harness.env, XDG_DOWNLOAD_DIR: downloads };

  const open = await connect({ core: harness.core, env });
  try {
    const all = (await open.client.callTool({ name: 'gmail_setup', arguments: {} })) as {
      structuredContent: { inboxes: string[]; clients: string[]; candidates: unknown[] };
    };
    assert.deepEqual(all.structuredContent.inboxes.sort(), ['personal', 'work']);
    assert.deepEqual(all.structuredContent.clients.sort(), ['default', 'other']);
    assert.equal(all.structuredContent.candidates.length, 1);
  } finally {
    await open.close();
  }

  const pinned = await connect({ core: harness.core, env, inbox: 'work' });
  try {
    const scoped = (await pinned.client.callTool({ name: 'gmail_setup', arguments: {} })) as {
      structuredContent: { inboxes: string[]; clients: string[]; candidates: unknown[] };
    };
    assert.deepEqual(scoped.structuredContent.inboxes, ['work'], 'a pinned server named another mailbox');
    assert.deepEqual(scoped.structuredContent.candidates, [], 'a pinned server listed the download directory');
    assert.deepEqual(scoped.structuredContent.clients, ['default'], 'a pinned server named another client');
  } finally {
    await pinned.close();
  }
});

test('gmail_inbox_finish finishes a re-authorisation, which passed its approval before its link existed', async () => {
  /*
   * This used to be refused. `gmail_inbox_finish` finished only new mailboxes, because re-authorising re-points an
   * existing mailbox at the client and tier its flow asked for, and nothing over MCP could approve that. Now every
   * re-authorisation that asks for more is approved before its link exists — gmail_inbox_reauth, or `inbox reauth`
   * at a terminal — so a flow that exists has passed the one gate it needed. Finishing one here re-authorises the
   * mailbox it was for, and says so.
   */
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });

  const { client, close } = await connect({ core: harness.core, env: harness.env });
  try {
    // A renewal at the tier it has: nothing to approve, so the link comes back at once.
    const started = (await client.callTool({ name: 'gmail_inbox_reauth', arguments: { inbox: 'work' } })) as ToolResult;
    assert.equal(started.isError, undefined, JSON.stringify(started.content));
    assert.equal(started.structuredContent?.applied, true);
    const link = started.structuredContent?.result as { flowId: string; authUrl: string; nextTool: string };
    assert.equal(link.nextTool, 'gmail_inbox_finish');
    await fetch(harness.google.consent(link.authUrl, { sub: 'sub-1' }));

    const finished = (await client.callTool({
      name: 'gmail_inbox_finish',
      arguments: { flowId: link.flowId, waitSeconds: 10 },
    })) as ToolResult;
    assert.equal(finished.isError, undefined, JSON.stringify(finished.content));
    assert.equal(finished.structuredContent?.reauthorised, true);
    assert.equal(finished.structuredContent?.alias, 'work');
  } finally {
    await close();
  }
});

test('a pinned gmail_setup does not call the setup done because some other mailbox exists', async () => {
  /*
   * Raised by review, at severity 7, with a scenario that cannot happen — a server pinned to a mailbox that was
   * never connected, which refuses to start with NOT_FOUND. The bug underneath is real by another route: config
   * is deliberately re-read on every call, so a mailbox removed from the CLI while the server runs leaves the
   * pin dangling. With `next` and `done` computed machine-wide, the answer then said `inboxes: []` and
   * `next: "done"` in the same breath — on the strength of somebody else's mailbox — and an agent reading that
   * concludes the setup it was asked to finish is already finished.
   */
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  await harness.addInbox({ alias: 'personal', email: 'sam@example.test', sub: 'sub-2', refreshToken: 'rt_y' });

  const { client, close } = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    // Removed after the server started, exactly as `agent-gmail inbox remove work` would while it runs.
    await harness.core.config.update((config) => {
      const { work: _removed, ...rest } = config.inboxes;
      return { ...config, inboxes: rest };
    });

    const answer = (await client.callTool({ name: 'gmail_setup', arguments: {} })) as {
      structuredContent: { next: string; done: string[]; inboxes: string[] };
    };
    assert.deepEqual(answer.structuredContent.inboxes, []);
    assert.equal(answer.structuredContent.next, 'inbox', 'the pinned mailbox is gone; connecting it is what is next');
    assert.ok(
      !answer.structuredContent.done.includes('inbox'),
      `"inbox" was called done on the strength of another mailbox: ${JSON.stringify(answer.structuredContent.done)}`,
    );
  } finally {
    await close();
  }
});

test('a pinned server whose mailbox was renamed says what it is called now, from setup as from every tool', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  await migrateNamesForTest(harness, ['work=acme/gmail']);
  const { client, close } = await connect({ core: harness.core, env: harness.env, inbox: 'acme/gmail' });
  try {
    // Renamed again while the server runs.
    const config = (await harness.core.config.load()) as ConfigV2;
    await writeFile(
      harness.core.config.path,
      `${JSON.stringify(renameEntry(config, 'inbox', 'acme/gmail', 'acme/gmail-main'), null, 2)}\n`,
    );
    for (const name of ['gmail_setup', 'gmail_whoami', 'gmail_inboxes_list', 'gmail_doctor']) {
      const result = (await client.callTool({ name, arguments: {} })) as ToolResult;
      assert.equal(result.isError, true, name);
      const error = result.structuredContent?.error as { code: string; message: string };
      assert.equal(error.code, 'NOT_FOUND', name);
      assert.match(error.message, /renamed to "acme\/gmail-main"/, name);
    }
  } finally {
    await close();
  }
});

test('a pinned server whose mailbox was removed and replaced under the same name refuses to serve the stranger', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const { client, close } = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    await harness.core.config.update((config) => {
      const { work: _removed, ...rest } = config.inboxes;
      return { ...config, inboxes: rest };
    });
    await harness.addInbox({ alias: 'work', email: 'someone.else@example.test', sub: 'sub-9', refreshToken: 'rt_y' });
    for (const name of ['gmail_whoami', 'gmail_inboxes_list']) {
      const result = (await client.callTool({ name, arguments: {} })) as ToolResult;
      assert.equal(result.isError, true, name);
      const error = result.structuredContent?.error as { code: string; message: string };
      assert.equal(error.code, 'CONFIG', name);
      assert.match(error.message, /now names another/, name);
    }
  } finally {
    await close();
  }
});

test('the mailbox pin refuses to wrap a registration it does not understand, rather than skipping its check', () => {
  // The pin wraps `registerTool(name, config, handler)`. An SDK that added an overload or moved the handler would
  // have it wrap the wrong argument, and a pinned server would quietly stop keeping to its one mailbox.
  const handler = () => undefined;
  assert.doesNotThrow(() => assertRegistrationShape(['gmail_search', { description: 'x' }, handler]));
  for (const shape of [
    ['gmail_search', handler],
    ['gmail_search', { description: 'x' }, { handler }],
    ['gmail_search', { description: 'x' }, handler, { extra: true }],
    [{ name: 'gmail_search' }, handler],
    ['gmail_search', null, handler],
  ]) {
    assert.throws(() => assertRegistrationShape(shape), /cannot check this tool/, JSON.stringify(shape.map(String)));
  }
});

test('a pinned server stops at a registration its pin cannot wrap', async () => {
  // The check has to sit where the wrapping happens, not only in a helper nothing calls.
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  const built = await createGmailMcpServer({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const register = built.server.registerTool as unknown as (...args: unknown[]) => unknown;
    assert.throws(() => register.call(built.server, 'gmail_extra', () => undefined), /cannot check this tool/);
  } finally {
    await built.close();
  }
});
