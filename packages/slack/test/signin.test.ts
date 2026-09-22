import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type CommsError, classifyChange, parseConfig } from '@agentcomms/core';
import { SlackContext } from '../src/context.ts';
import { releaseChannel, resolveListenerEntry, startSignIn } from '../src/operations/signin.ts';
import { newHarness, TEST_CLIENT_ID, tempDir } from './support/harness.ts';

/*
 * The listener entry, in the layout that breaks it.
 *
 * The Gmail package shipped this as `process.argv[1]` — whatever binary happens to be running. Started as the
 * CLI that is the thing that understands the hidden listener command; started as the packaged MCP server it is a
 * different entry with no such command, and the sign-in failed before it could hand back a URL. These check the
 * resolution, then the thing the resolution is for, then the wiring that uses it.
 */

const strays: number[] = [];
after(() => {
  for (const pid of strays) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((settle) => server.close(() => settle()));
  return port;
}

test('the listener is resolved from this package, not from whatever binary is running', async () => {
  const root = tempDir();
  // The packed shape: this module compiled into `dist/` beside the `agent-slack` bin, reached as a dependency
  // rather than as the running program.
  const dist = join(root, 'node_modules', '@agentcomms', 'slack', 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'cli.mjs'), '// the agent-slack bin\n');
  await writeFile(join(dist, 'index.mjs'), '// this module, bundled\n');

  const entry = await resolveListenerEntry(dist);
  assert.ok(entry, 'no listener entry was resolved in the packed layout');
  assert.equal(entry.command, process.execPath);
  assert.equal(entry.args.at(-1), join(dist, 'cli.mjs'));
  // The bundled `.mjs` runs as it is; only the TypeScript source needs the strip-types flags.
  assert.deepEqual(entry.args.slice(0, -1), []);
});

test('nothing resolves in a layout with no CLI beside it', async () => {
  const empty = join(tempDir(), 'somewhere', 'else');
  await mkdir(empty, { recursive: true });
  assert.equal(await resolveListenerEntry(empty), null);
});

test('the resolved entry understands the listener command', async () => {
  /*
   * Resolution is only useful if what it finds answers. This runs the entry the current layout resolves to —
   * source here, `dist/cli.mjs` in a package — and asks it to listen for a flow that does not exist. A command it
   * did not recognise would say so; a command it did recognise gets as far as looking the flow up and fails
   * there. That difference is the whole point.
   */
  const here = fileURLToPath(new URL('../src/operations/', import.meta.url));
  const entry = await resolveListenerEntry(here);
  assert.ok(entry, 'the repository layout resolved no listener entry');

  const child = spawn(entry.command, [...entry.args, 'sign-in-listen', 'sfl_doesnotexistaaaaaaaa'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_COMMS_CONFIG_DIR: tempDir(), NO_COLOR: '1' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  await new Promise((settle) => child.on('close', settle));

  assert.doesNotMatch(output, /unknown command/i, `the resolved entry does not handle the listener:\n${output}`);
  assert.match(output, /not waiting to be finished/i, `unexpected output:\n${output}`);
});

test('a detached sign-in with no listener injected still starts: the wiring, not just the resolver', async () => {
  /*
   * The regression test the other three are not.
   *
   * They call `resolveListenerEntry` directly, and every other sign-in test hands `listenerCommand` in — so
   * reverting `defaultListenerCommand()` to `process.argv[1]` would leave all of them green while `workspace add
   * --start` was broken for everybody running the published package.
   *
   * This injects nothing, so the real `defaultListenerCommand()` runs. Under the test runner `argv[1]` is this
   * file, which has no listener command — the same shape as the packaged entry that broke Gmail. If the
   * resolution regresses, the child exits before it reports ready and this never returns a link.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
  const started = await startSignIn(context, {
    mode: 'read',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
  });

  assert.match(started.authUrl, /^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
  assert.equal(started.listener, undefined, 'the detached form kept the listener in this process');

  const flow = await context.flows.peek(started.flowId);
  assert.ok(flow?.listenerPid, 'the detached listener never reported itself');
  strays.push(flow.listenerPid as number);
});

test('dropping the IPC channel survives the child having closed it first', () => {
  /*
   * The listener disconnects itself the instant after it reports ready, so the parent races it and loses
   * whenever it is not already on the next tick — measured, every time once it pauses at all in between.
   *
   * Unguarded, the resulting `ERR_IPC_DISCONNECTED` escapes `startSignIn` *after* the listener is running and
   * the flow is on disk, and past the block that would discard it: the caller is told the sign-in failed, the
   * port stays held for ten minutes, and the flow is still finishable.
   */
  const closed = {
    disconnect() {
      const error = new Error('channel closed') as NodeJS.ErrnoException;
      error.code = 'ERR_IPC_DISCONNECTED';
      throw error;
    },
  };
  assert.doesNotThrow(() => releaseChannel(closed));

  let called = 0;
  releaseChannel({
    disconnect() {
      called += 1;
    },
  });
  assert.equal(called, 1, 'an open channel was left open');
});

test('a widening sign-in with no consent is refused by the config layer, not only by the CLI', () => {
  /*
   * Belt and braces, and they answer different failures.
   *
   * The CLI gate stops an agent asking for `--mode send` on a `read` workspace. This is what stops a *second*
   * caller — another surface, a later refactor, a path somebody forgets to route through the gate — from writing
   * the same change. `classifyChange` sees it whatever asked for it, and `ConfigStore.update` refuses without a
   * matching consent.
   */
  const read = parseConfig(
    JSON.stringify({ version: 1, accounts: { acme: { ...slackAccount('acc_AAAAAAAAAAAAAAAA'), mode: 'read' } } }),
  );
  const send = parseConfig(
    JSON.stringify({ version: 1, accounts: { acme: { ...slackAccount('acc_BBBBBBBBBBBBBBBB'), mode: 'send' } } }),
  );
  assert.deepEqual(classifyChange(read, send).loosened, ['accounts.acme.mode']);
});

function slackAccount(id: string): Record<string, unknown> {
  return {
    id,
    platform: 'slack',
    workspace: 'T0001',
    userId: 'U0001',
    tier: 'read',
    secretRef: `slack/token/${id}`,
    createdAt: '2026-09-22T12:00:00.000Z',
  };
}

test('a port already in use leaves no sign-in behind', async () => {
  /*
   * The commonest failure on this path, because Slack forces a fixed port: something else already has it. The
   * flow record holds a PKCE verifier, so leaving it means a secret on disk that nothing can complete and
   * nothing will ever remove — `peek` only sweeps an id somebody asks about, and nobody will.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
  const port = await freePort();
  const blocker = createServer();
  await new Promise<void>((settle) => blocker.listen(port, 'localhost', () => settle()));
  try {
    await assert.rejects(
      startSignIn(context, {
        mode: 'read',
        alias: 'acme',
        clientId: TEST_CLIENT_ID,
        port,
        detached: false,
      }),
      (error: CommsError) => {
        assert.match(error.hint ?? '', new RegExp(String(port)), 'the message never names the port');
        return true;
      },
    );
    assert.deepEqual(await context.flows.pending(), [], 'a sign-in with no listener was left on disk');
  } finally {
    await new Promise<void>((settle) => blocker.close(() => settle()));
  }
});
