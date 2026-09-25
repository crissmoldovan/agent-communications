import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/server';
import { settleRefreshes } from '../src/auth/refresh.ts';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer, serveUntilClosed } from '../src/mcp/server.ts';
import { newHarness, slackOk, tempDir } from './support/harness.ts';
import { expired, fakeProcess, flakyStore, markerLandsLate, QUICK, stored, until } from './support/refresh.ts';

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

test('a CLI command takes back a marker that lands after the wait for it was given up, before it returns', async () => {
  /*
   * The keychain dialog raised by the marker write is answered after the refresh has stopped waiting for it, so
   * the marker lands with nothing behind it. A command makes no next call, so the end of the command is the only
   * moment left to take it back — and it has to wait for the store to be free, because every read fails fast until
   * the dialog is answered. Left there, the marker becomes a re-authorisation for a token that never left.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  // QUICK gives up waiting for the store after 200 ms; the marker lands at 400.
  const store = markerLandsLate(await harness.core.secrets('file'), 400);
  const stderr = captured();
  const running = run(['--json', 'channels', '--workspace', 'acme'], {
    core: { ...harness.core, secrets: async () => store },
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    persist: QUICK,
    streams: { stdout: new PassThrough(), stderr: stderr.stream, stdin: new PassThrough() },
    read: noChannels,
  });
  try {
    // Bounded: an exit that waits on the store for ever would stall the suite rather than fail it.
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      running,
      new Promise<'hung'>((resolve) => {
        timer = setTimeout(resolve, 10_000, 'hung');
      }),
    ]);
    clearTimeout(timer);
    assert.notEqual(code, 'hung', 'the command never returned');
    assert.equal(code, EXIT_CODES.TRANSIENT, 'the command did not report the keychain waiting for a person');
    assert.equal(harness.calls.length, 0, 'the token was sent without its marker');
    await store.settled();
    const after = await stored(harness, account.secretRef);
    assert.equal(after?.state, 'ready', 'the command left a marker nobody is behind');
    assert.equal(after?.attempt, undefined);
    assert.equal(after?.refreshToken, 'fake-refresh-token-0', 'the credential changed although nothing was sent');
    assert.equal(stderr.text(), '');
  } finally {
    await running;
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
  const host = fakeProcess();
  const exits: number[] = [];
  const running = run(['--json', 'channels', '--workspace', 'acme'], {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() },
    read: noChannels,
    signals: { host, exit: (code) => exits.push(code) },
  });
  try {
    await until(() => harness.calls.length === 1);
    host.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(host.raised, [], 'the command died with a refresh in flight');
    assert.deepEqual(exits, [], 'the command exited with a refresh in flight');
    answer();
    assert.equal(await running, 0);
    await until(() => host.raised.length > 0, 5_000);
    /*
     * Then it dies of the Ctrl-C, as it would have with no hold: sent again with nothing left to catch it. An exit
     * status of 130 instead is what a bash script takes for a command that dealt with the interrupt, and it runs
     * the next line.
     */
    assert.deepEqual(host.raised, [{ pid: host.pid, signal: 'SIGINT', listening: 0 }]);
    assert.deepEqual(exits, [], 'the command exited with a status instead of dying by the signal');
    assert.equal((await stored(harness, account.secretRef))?.refreshToken, 'fake-new-refresh');
  } finally {
    answer();
    await running;
  }
});

/** Windows has no POSIX signals for a process to die of; there the status the signal stands for is used instead. */
const posixOnly = { skip: process.platform === 'win32' };

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(
    `${signal} ends a process holding for refreshes by ${signal}, so a script running it stops as well`,
    posixOnly,
    async () => {
      /*
       * What a parent is told, from a real process. bash waits on a command, and when the command exits normally
       * after SIGINT it takes the interrupt as handled and carries on with the script — the next command in a
       * loop, or an approved `post send` after a read. Only a child that died by the signal stops the script.
       */
      const exitModule = new URL('../src/auth/exit.ts', import.meta.url).href;
      const script = [
        `const { exitAfterRefreshes } = await import(${JSON.stringify(exitModule)});`,
        'exitAfterRefreshes();',
        'setInterval(() => {}, 60_000);',
        "process.stdout.write('holding\\n');",
      ].join('\n');
      const child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          '--input-type=module',
          '--eval',
          script,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGENT_COMMS_CONFIG_DIR: tempDir() } },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal })),
      );
      try {
        await until(() => output.includes('holding'), 10_000);
        child.kill(signal);
        // Bounded: a process that ignored the signal would otherwise stall the suite rather than fail it.
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          ended,
          new Promise<'running'>((resolve) => {
            timer = setTimeout(resolve, 10_000, 'running');
          }),
        ]);
        clearTimeout(timer);
        assert.deepEqual(result, { code: null, signal }, `the process did not die by ${signal}:\n${output}`);
      } finally {
        child.kill('SIGKILL');
      }
    },
  );
}

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

test('an MCP client that just closes stdin still gets the kept token written down', async () => {
  /*
   * The production case. `StdioServerTransport` does not report stdin ending as a close, so the transport's own
   * `onclose` never fires and only `closed` — stdin's end — can end the serving. This transport forwards messages
   * and never says it closed.
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
  const [clientTransport, inner] = InMemoryTransport.createLinkedPair();
  const silent: Transport = {
    start: () => inner.start(),
    // The two option types differ only in fields neither transport reads here.
    send: (message, options) => inner.send(message, options as Parameters<typeof inner.send>[1]),
    close: () => inner.close(),
  };
  // Messages go straight through; `onclose` is the one thing never passed on.
  Object.defineProperty(silent, 'onmessage', {
    get: () => inner.onmessage,
    set: (handler: NonNullable<typeof inner.onmessage>) => {
      inner.onmessage = handler;
    },
  });
  let endStdin = () => {};
  const stdinClosed = new Promise<void>((resolve) => {
    endStdin = resolve;
  });
  const stderr = captured();
  const serving = serveUntilClosed(server, silent, { closed: stdinClosed, stderr: stderr.stream });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  await client.callTool({ name: 'slack_channels', arguments: { workspace: 'acme' } });
  assert.equal((await stored(harness, account.secretRef))?.state, 'refreshing', 'nothing could have been written');

  store.failing = false;
  await client.close();
  endStdin();
  // Bounded: a serving that ignores stdin's end never finishes, and a hang would stall the suite, not fail it.
  let timer: NodeJS.Timeout | undefined;
  const ended = await Promise.race([
    serving.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    }),
  ]);
  clearTimeout(timer);
  assert.ok(ended, 'the server kept serving after stdin closed');
  const after = await stored(harness, account.secretRef);
  assert.equal(after?.state, 'ready', 'the renewed token was dropped when stdin closed');
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
