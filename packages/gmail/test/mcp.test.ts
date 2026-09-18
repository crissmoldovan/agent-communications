import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { GmailContext } from '../src/context.ts';
import { mcpBoolean, mcpInboxes, mcpInteger, mcpStringArray } from '../src/mcp/schemas.ts';
import { buildInstructions, createGmailMcpServer } from '../src/mcp/server.ts';
import { newHarness } from './support/harness.ts';

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
    'gmail_contacts_search',
    'gmail_doctor',
    'gmail_followups',
    'gmail_inboxes_list',
    'gmail_labels_list',
    'gmail_message_get',
    'gmail_search',
    'gmail_sendas_list',
    'gmail_thread_get',
    'gmail_thread_timeline',
    'gmail_whoami',
  ]);
  assert.deepEqual(await names(withInbox), withoutInboxes, 'registration must not depend on the inboxes present');
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
    assert.match(client_?.fix ?? '', /client add/);
    assert.equal(result.structuredContent?.healthy, false);
  } finally {
    await close();
  }
});

test('the instructions tell the model the three things it must know, and stay under 2 KB', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const instructions = await buildInstructions(context, undefined);
  assert.ok(Buffer.byteLength(instructions) < 2048, 'Claude Code truncates instructions at 2 KB');
  assert.match(instructions, /untrusted-email-content/);
  assert.match(instructions, /approve/);
  assert.match(instructions, /Pass `inbox` on every call/);
  assert.match(instructions, /work/);
  const pinnedText = await buildInstructions(context, 'work');
  assert.match(pinnedText, /pinned to the "work" mailbox/);
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
