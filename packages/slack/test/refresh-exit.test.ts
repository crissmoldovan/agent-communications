import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { SignalHost } from '../src/auth/exit.ts';
import { settleRefreshes } from '../src/auth/refresh.ts';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer, serveUntilClosed } from '../src/mcp/server.ts';
import { newHarness, slackOk } from './support/harness.ts';
import { expired, flakyStore, QUICK, stored, until } from './support/refresh.ts';

/**
 * Leaving a process with a renewed token in hand: a CLI command that ends, an MCP client that closes the
 * connection, and Ctrl-C during a command's refresh.
 *
 * Slack spends the old refresh token the moment it answers, so a renewed token the store would not take lives only
 * in memory. `refresh-persist.test.ts` covers what happens to it while the process runs; these cover the end of
 * the process, the same way on both surfaces, because the same refresh runs inside either.
 *
 * Every store is the harness's file store in a temporary directory. Nothing here reaches Slack or the keychain.
 */

const renewed = () => slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });

/** Slack's reply to every read: no channels. The commands here only need to get as far as a token. */
const noChannels = async () =>
  new Response(JSON.stringify({ ok: true, channels: [] }), { headers: { 'content-type': 'application/json' } });

function captured() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk) => {
    text += String(chunk);
  });
  return { stream, text: () => text };
}

test('a CLI command writes down the renewed token it kept, before it returns', async () => {
  /*
   * A command has no next call. When the store recovers after the renewal's own write gave up, the end of the
   * command is the only moment left to write the token; after it, the marker becomes a re-authorisation.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  const store = flakyStore(await harness.core.secrets('file'));
  harness.reply = () => {
    store.failing = true;
    return renewed();
  };
  const stderr = captured();
  const code = await run(['--json', 'channels', '--workspace', 'acme'], {
    core: { ...harness.core, secrets: async () => store },
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    persist: QUICK,
    streams: { stdout: new PassThrough(), stderr: stderr.stream, stdin: new PassThrough() },
    // The store recovers while the command reads: after the renewal's write has given up, before the process ends.
    read: async () => {
      store.failing = false;
      return noChannels();
    },
  });
  assert.equal(code, 0);
  const after = await stored(harness, account.secretRef);
  assert.equal(after?.state, 'ready', 'the renewed token was dropped when the command ended');
  assert.equal(after?.refreshToken, 'fake-new-refresh');
  assert.equal(stderr.text(), '');
  assert.equal(harness.calls.length, 1);
});

test('a CLI command that cannot write down its renewed token says so on stderr, by name and never by value', async () => {
  const harness = await newHarness();
  await expired(harness);
  const store = flakyStore(await harness.core.secrets('file'));
  harness.reply = () => {
    store.failing = true;
    return renewed();
  };
  const stdout = captured();
  const stderr = captured();
  const code = await run(['--json', 'channels', '--workspace', 'acme'], {
    core: { ...harness.core, secrets: async () => store },
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    persist: QUICK,
    streams: { stdout: stdout.stream, stderr: stderr.stream, stdin: new PassThrough() },
    read: noChannels,
  });
  try {
    // The command did what it was asked; what it could not do is keep the credential, and that is said beside it.
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout.text()).ok, true, '--json still prints exactly one envelope');
    assert.match(stderr.text(), /could not save the renewed Slack credential for “acme”/);
    assert.match(stderr.text(), /agent-slack workspace reauth acme/);
    assert.doesNotMatch(stderr.text(), /fake-new-access|fake-new-refresh|fake-refresh-token/, 'a token was printed');
  } finally {
    // Nothing is left behind for the next test in this process.
    store.failing = false;
    await settleRefreshes(5_000);
  }
});

test('Ctrl-C during a CLI command’s refresh waits for Slack’s reply to be written before exiting', async () => {
  // The MCP server has held SIGTERM and SIGINT for this since it had a refresh; a command runs the same refresh.
  const harness = await newHarness();
  const account = await expired(harness);
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  harness.reply = async () => {
    await answered;
    return renewed();
  };
  const host = new EventEmitter();
  const exits: number[] = [];
  const running = run(['--json', 'channels', '--workspace', 'acme'], {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() },
    read: noChannels,
    signals: { host: host as unknown as SignalHost, exit: (code) => exits.push(code) },
  });
  try {
    await until(() => harness.calls.length === 1);
    host.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(exits, [], 'the command exited with a refresh in flight');
    answer();
    assert.equal(await running, 0);
    await until(() => exits.length > 0, 5_000);
    assert.deepEqual(exits, [130]);
    assert.equal((await stored(harness, account.secretRef))?.refreshToken, 'fake-new-refresh');
  } finally {
    answer();
    await running;
  }
});

test('an MCP client that closes the connection without a signal still gets the kept token written down', async () => {
  /*
   * A client that is finished closes the connection and sends nothing, so the SIGTERM hold never runs. The server
   * may have held the token for hours while the store was failing, and the store may have recovered since.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  const store = flakyStore(await harness.core.secrets('file'));
  harness.reply = () => {
    store.failing = true;
    return renewed();
  };
  const { server } = await createSlackMcpServer({
    core: { ...harness.core, secrets: async () => store },
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    persist: QUICK,
    fetch: noChannels,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stderr = captured();
  const serving = serveUntilClosed(server, serverTransport, { stderr: stderr.stream });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const result = (await client.callTool({ name: 'slack_channels', arguments: { workspace: 'acme' } })) as {
    isError?: boolean;
  };
  assert.notEqual(result.isError, true);
  assert.equal((await stored(harness, account.secretRef))?.state, 'refreshing', 'nothing could have been written');

  store.failing = false;
  await client.close();
  await serving;
  const after = await stored(harness, account.secretRef);
  assert.equal(after?.state, 'ready', 'the renewed token was dropped when the client went away');
  assert.equal(after?.refreshToken, 'fake-new-refresh');
  assert.equal(stderr.text(), '');
});

test('an MCP server that cannot write down its renewed token at the end says so on stderr', async () => {
  const harness = await newHarness();
  await expired(harness);
  const store = flakyStore(await harness.core.secrets('file'));
  harness.reply = () => {
    store.failing = true;
    return renewed();
  };
  const { server } = await createSlackMcpServer({
    core: { ...harness.core, secrets: async () => store },
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    persist: QUICK,
    fetch: noChannels,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stderr = captured();
  const serving = serveUntilClosed(server, serverTransport, { stderr: stderr.stream });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  await client.callTool({ name: 'slack_channels', arguments: { workspace: 'acme' } });
  await client.close();
  await serving;
  try {
    assert.match(stderr.text(), /could not save the renewed Slack credential for “acme”/);
    assert.match(stderr.text(), /agent-slack workspace reauth acme/);
    assert.doesNotMatch(stderr.text(), /fake-new-access|fake-new-refresh|fake-refresh-token/, 'a token was printed');
  } finally {
    store.failing = false;
    await settleRefreshes(5_000);
  }
});
