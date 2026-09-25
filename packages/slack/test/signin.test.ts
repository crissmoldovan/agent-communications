import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommsError, classifyChange, parseConfig, type SecretStore } from '@agentcomms/core';
import { newFlowId, type SlackFlow } from '../src/auth/flow.ts';
import { SlackContext } from '../src/context.ts';
import { scopesForMode } from '../src/manifest.ts';
import {
  finishSignIn,
  releaseChannel,
  resolveListenerEntry,
  type StartedSignIn,
  startSignIn,
} from '../src/operations/signin.ts';
import { newHarness, slackOk, TEST_CLIENT_ID, tempDir } from './support/harness.ts';
import { running, stopListeners } from './support/listener.ts';

/*
 * The listener entry, in the layout that breaks it.
 *
 * The Gmail package shipped this as `process.argv[1]` — whatever binary happens to be running. Started as the
 * CLI that is the thing that understands the hidden listener command; started as the packaged MCP server it is a
 * different entry with no such command, and the sign-in failed before it could hand back a URL. These check the
 * resolution, then the thing the resolution is for, then the wiring that uses it.
 */

/*
 * Listeners a test started, stopped when that test ends rather than when the file does: a file the runner ends for
 * overrunning its timeout never reaches a file-wide hook, and whatever was waiting for one stays up.
 */
let strays: number[] = [];
afterEach(async () => {
  const started = strays;
  strays = [];
  await stopListeners(started);
});

async function freePort(): Promise<number> {
  const server = createServer();
  /*
   * `localhost`, the same host the listener binds — not `127.0.0.1`.
   *
   * On this machine `localhost` resolves to `::1` first. Probing IPv4 and then binding IPv6 checks one address
   * family and uses the other, so a port free on the first can already be held on the second by another test
   * file running concurrently. It showed up as a rare, unrepeatable failure in two unrelated tests.
   */
  await new Promise<void>((settle) => server.listen(0, 'localhost', () => settle()));
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

test('a listener a test started goes when the test process does, however that process ended', async () => {
  /*
   * The runner ends a test file that overruns its timeout with SIGTERM, and no hook of the file's runs after that.
   * Every listener the file had started then outlived it: detached, re-parented, holding its port for the ten
   * minutes a sign-in lasts. Two were found that way after `cli.test.ts` timed out under load.
   *
   * So the process that starts the listener here is killed outright, with no chance to clean anything up, and the
   * listener has to notice by itself. SIGKILL rather than the runner's SIGTERM, because it leaves the test process
   * nothing at all to do — which is the case the guard has to cover.
   */
  const specifier = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const starter = `
    import { newHarness, TEST_CLIENT_ID } from ${specifier('./support/harness.ts')};
    import { LISTENER_COMMAND } from ${specifier('./support/listener.ts')};
    import { SlackContext } from ${specifier('../src/context.ts')};
    import { startSignIn } from ${specifier('../src/operations/signin.ts')};
    const harness = await newHarness();
    const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
    const started = await startSignIn(context, {
      mode: 'read', alias: 'acme', clientId: TEST_CLIENT_ID, port: ${await freePort()}, listenerCommand: LISTENER_COMMAND,
    });
    process.stdout.write(String((await context.flows.peek(started.flowId))?.listenerPid) + '\\n');
    setInterval(() => undefined, 60_000);
  `;
  /*
   * Stands in for a test file's process: it starts the listener, then waits to be killed. Its stderr is piped, not
   * inherited, so nothing it leaves running can hold this file's output open.
   */
  const testProcess = spawn(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', starter],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let errors = '';
  testProcess.stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  let listener = 0;
  try {
    listener = await new Promise<number>((settle, reject) => {
      let output = '';
      testProcess.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('\n')) settle(Number(output.trim()));
      });
      testProcess.once('exit', (code) =>
        reject(new Error(`the test process ended (exit ${code}) before its listener was up:\n${errors}`)),
      );
    });
    assert.ok(Number.isInteger(listener) && listener > 0, `no listener pid came back: ${listener}`);
    assert.ok(running(listener), 'the listener was not running while its test process was');

    testProcess.kill('SIGKILL');
    const deadline = Date.now() + 10_000;
    while (running(listener) && Date.now() < deadline) await new Promise((settle) => setTimeout(settle, 100));
    assert.equal(running(listener), false, 'the listener outlived the test process that started it');
  } finally {
    // A failure here must not become the leak it is reporting.
    testProcess.kill('SIGKILL');
    if (listener > 0) await stopListeners([listener]);
  }
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

test('the config layer classifies a read → send widening as a loosening, whatever asked for it', () => {
  /*
   * The classification half only. Renamed after review: this used to claim `ConfigStore.update` refuses the
   * change, and asserted nothing of the kind — it calls `classifyChange`, which is necessary for the refusal and
   * not the refusal itself. The refusal is tested where `ConfigStore` is, in
   * `packages/core/test/safety-extras.test.ts` ("ConfigStore.update itself refuses a Slack widening").
   *
   * What this one does hold: the change is classified from what is written, not from who asked, so a second
   * surface or a later refactor that skips the CLI's gate still meets it.
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

test('a name taken between the snapshot and the write is caught by the check inside the lock', async () => {
  /*
   * Isolating the in-lock re-check, which no CLI test can.
   *
   * `completeSignIn` checks the alias twice: once on a snapshot read before the exchange, and again inside the
   * config lock. Any collision arranged before `--finish` runs is caught by the first, so the second looks
   * redundant and mutating it away leaves every test green — while the window it actually covers, between the
   * snapshot and the write, stays open.
   *
   * The sequence is: read config → exchange → validate → **store the credential** → update config. So a store
   * that takes the name on its way past lands in exactly that window, and nothing else can.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });

  const real = await harness.core.secrets('file');
  let taken = false;
  const meddling: SecretStore = {
    ...real,
    kind: real.kind,
    get: (ref) => real.get(ref),
    delete: (ref) => real.delete(ref),
    invalidate: (ref) => real.invalidate(ref),
    async set(ref: string, value: string) {
      await real.set(ref, value);
      if (taken) return;
      taken = true;
      await harness.core.config.update((config) => ({
        ...config,
        inboxes: { ...config.inboxes, acme: inboxFixture() },
      }));
    },
  };
  context.secrets = async () => meddling;

  const port = await freePort();
  const started = await startSignIn(context, {
    mode: 'read',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port,
    detached: false,
  });
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  await redirectTo(started.authUrl);

  await assert.rejects(listener.result, (error: CommsError) => {
    assert.match(error.message, /already connected/);
    return true;
  });
  await listener.close();

  // And the credential staged into that failed attempt is not left behind.
  assert.equal((await harness.core.config.load()).accounts.acme, undefined);
});

/** A Gmail inbox, for the one test that needs the shared namespace to collide. */
function inboxFixture() {
  return {
    id: 'ibx_AAAAAAAAAAAAAAAA',
    provider: 'gmail',
    email: 'jo@example.test',
    identity: 'oidc' as const,
    client: 'default',
    tier: 'organize',
    contacts: true,
    grantedScopes: [] as string[],
    secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
    internalDomains: [] as string[],
    createdAt: '2026-09-22T12:00:00.000Z',
  };
}

/** Follows the authorisation URL the way a browser would. */
async function redirectTo(authUrl: string): Promise<void> {
  const url = new URL(authUrl);
  const back = new URL(url.searchParams.get('redirect_uri') as string);
  back.searchParams.set('state', url.searchParams.get('state') as string);
  back.searchParams.set('code', 'fake-authorisation-code');
  await fetch(back);
}

test('two finishers racing one sign-in: one exchanges, the loser leaves the winner alone', async () => {
  /*
   * The operation-level race, which the primitive test cannot reach.
   *
   * Eight `claim()` calls in a row prove `O_EXCL` works while the first marker exists. They say nothing about
   * what happens around it: the loser's cleanup used to run in a `finally` it reached by losing, deleting the
   * winner's marker and record while the winner was still exchanging — so a third caller could claim again.
   *
   * The exchange is held open here until both finishers have made their attempt, so the race is real rather
   * than sequential.
   */
  const harness = await newHarness();
  let release: () => void = () => undefined;
  const held = new Promise<void>((settle) => {
    release = settle;
  });
  let exchanges = 0;
  const context = new SlackContext({
    core: harness.core,
    env: harness.env,
    exchange: async (params) => {
      exchanges += 1;
      await held;
      return harness.exchange(params);
    },
  });

  const flowId = newFlowIdFor(context);
  await context.flows.save(await pendingFlow(context, flowId));
  await context.flows.recordOutcome(flowId, { code: 'fake-authorisation-code' });

  const winner = finishSignIn(context, { flowId, waitSeconds: 5 });
  // Give the winner time to take the claim and reach the held exchange.
  await new Promise((settle) => setTimeout(settle, 100));

  await assert.rejects(finishSignIn(context, { flowId, waitSeconds: 5 }), (error: CommsError) => {
    assert.match(error.message, /already been finished/);
    return true;
  });

  // The loser has come and gone. The winner's claim must still be standing: a third caller is refused too.
  await assert.rejects(context.flows.claim(flowId), /already been finished/);

  release();
  const view = await winner;
  assert.equal(view.alias, 'acme');
  assert.equal(exchanges, 1, `${exchanges} exchanges for one authorisation code`);
});

function newFlowIdFor(_context: SlackContext): string {
  return newFlowId();
}

async function pendingFlow(context: SlackContext, flowId: string): Promise<SlackFlow> {
  const at = context.now();
  return {
    flowId,
    mode: 'read',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    verifier: 'fake-verifier-not-a-real-one',
    state: 'fake-state',
    redirectUrl: 'http://localhost:1/slack/callback',
    port: 1,
    createdAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + 10 * 60_000).toISOString(),
  };
}

test('a credential that cannot be taken back after a failed attempt is named, not silently left', async () => {
  /*
   * The rollback was `delete().catch(() => undefined)`. When the delete failed — a keychain whose prompt is
   * refused is the realistic case — a live Slack token stayed in the secret store under a reference nothing
   * names, and the only error anyone saw was the original one, which said nothing about it.
   *
   * Arranged here by making the attempt fail in the config lock (the name is taken on the way past) while the
   * secret store refuses every delete.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
  const real = await harness.core.secrets('file');
  let deletes = 0;
  const stubborn: SecretStore = {
    kind: real.kind,
    get: (ref) => real.get(ref),
    invalidate: (ref) => real.invalidate(ref),
    async delete() {
      deletes += 1;
      throw new Error('the keychain said no');
    },
    async set(ref: string, value: string) {
      await real.set(ref, value);
      await harness.core.config.update((config) => ({
        ...config,
        inboxes: { ...config.inboxes, acme: inboxFixture() },
      }));
    },
  };
  context.secrets = async () => stubborn;

  const started = await startSignIn(context, {
    mode: 'read',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
  });
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  await redirectTo(started.authUrl);

  await assert.rejects(listener.result, (error: CommsError) => {
    // The real cause is still the headline — the name was taken — and the leak rides along with it.
    assert.match(error.message, /already connected/);
    assert.match(error.hint ?? '', /could not be removed/);
    assert.match(String(error.details?.strandedSecretRef), /^slack\/token\/acc_/);
    return true;
  });
  await listener.close();
  assert.equal(deletes, 2, 'the rollback was not retried once before giving up');
});

test('a credential write that reports failure but landed anyway is taken back', async () => {
  /*
   * A keychain write cannot be cancelled and can finish after the store has reported it timed out. The write
   * used to sit outside the rollback, so that case left a live token with no config entry and no error naming
   * it. Modelled here as a store that writes and then throws, which is what a late-landing timeout looks like
   * from this side.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
  const real = await harness.core.secrets('file');
  let stored: string | undefined;
  const lateLanding: SecretStore = {
    kind: real.kind,
    get: (ref) => real.get(ref),
    delete: (ref) => real.delete(ref),
    invalidate: (ref) => real.invalidate(ref),
    async set(ref: string, value: string) {
      await real.set(ref, value);
      stored = ref;
      throw new Error('timed out waiting for the keychain');
    },
  };
  context.secrets = async () => lateLanding;

  const started = await startSignIn(context, {
    mode: 'read',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
  });
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  await redirectTo(started.authUrl);
  await assert.rejects(listener.result, /timed out waiting for the keychain/);
  await listener.close();

  assert.ok(stored, 'the fake store never wrote, so the test proves nothing');
  assert.equal(
    await real.get(stored as string),
    null,
    'a credential that landed after a reported failure was left behind',
  );
  assert.equal((await harness.core.config.load()).accounts.acme, undefined);
});

test('a sign-in refuses to finish into a backend a migration has just switched away from', async () => {
  /*
   * `secrets migrate` copies every credential across outside the lock, then switches. A sign-in that chose its
   * store before the switch and writes after it would leave the token somewhere nothing reads, with the config
   * naming a credential the runtime cannot find. The switch is modelled at the one moment it matters: after this
   * sign-in has picked its store and written to it.
   *
   * The config is moved to `keychain` here only as a marker that the backend changed. Nothing in this test opens
   * a keychain: the sign-in's own store is the file store below, and that is where the withdrawal goes.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
  const real = await harness.core.secrets('file');
  let stored: string | undefined;
  const beforeTheSwitch: SecretStore = {
    kind: 'file',
    get: (ref) => real.get(ref),
    delete: (ref) => real.delete(ref),
    invalidate: (ref) => real.invalidate(ref),
    async set(ref: string, value: string) {
      await real.set(ref, value);
      stored = ref;
      await harness.core.config.update((config) => ({ ...config, secrets: { store: 'keychain' } }));
    },
  };
  context.secrets = async () => beforeTheSwitch;

  const started = await startSignIn(context, {
    mode: 'read',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
  });
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  await redirectTo(started.authUrl);
  await assert.rejects(listener.result, /secret store was changed while this sign-in was completing/);
  await listener.close();

  assert.equal((await harness.core.config.load()).accounts.acme, undefined, 'the account was saved anyway');
  assert.equal(await real.get(stored as string), null, 'the credential was left in the abandoned backend');
});

test('a sign-in whose config write committed but whose lock release failed keeps its credential', async () => {
  /*
   * The configuration names the new credential; only releasing the lock failed afterwards. The rollback read
   * the rejection as "nothing was saved" and deleted the token the configuration now points at — a sign-in that
   * worked, turned into a workspace with no credential.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
  const update = harness.core.config.update.bind(harness.core.config);
  let failed = false;
  harness.core.config.update = (async (...args: Parameters<typeof update>) => {
    const written = await update(...args);
    if (!failed && written.accounts.acme) {
      failed = true;
      throw new Error('EPERM: could not remove the lock file');
    }
    return written;
  }) as typeof harness.core.config.update;

  const started = await startSignIn(context, {
    mode: 'read',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
  });
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  await redirectTo(started.authUrl);
  const view = await listener.result;
  await listener.close();

  assert.ok(failed, 'the lock failure was never injected, so the test proves nothing');
  assert.equal(view.alias, 'acme');
  const account = (await harness.core.config.load()).accounts.acme;
  const secrets = await harness.core.secrets('file');
  assert.ok(await secrets.get(account?.secretRef as string), 'the credential the config names was deleted');
});

test('a sign-in that cannot tell whether it was saved keeps the credential and names it', async () => {
  /*
   * If the configuration cannot even be read back, either deletion could be the wrong one. Keeping a possibly
   * orphaned token and saying so is recoverable; deleting a live one is not.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
  const update = harness.core.config.update.bind(harness.core.config);
  let broken = false;
  harness.core.config.update = (async (...args: Parameters<typeof update>) => {
    const written = await update(...args);
    if (!broken && written.accounts.acme) {
      broken = true;
      throw new Error('EPERM: could not remove the lock file');
    }
    return written;
  }) as typeof harness.core.config.update;
  const realConfig = context.config.bind(context);
  context.config = async () => {
    if (broken) throw new Error('EIO reading the configuration');
    return realConfig();
  };

  const started = await startSignIn(context, {
    mode: 'read',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
  });
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  await redirectTo(started.authUrl);
  let ref = '';
  await assert.rejects(listener.result, (error: CommsError) => {
    ref = String(error.details?.possiblyStrandedSecretRef);
    assert.match(ref, /^slack\/token\/acc_/);
    assert.match(error.hint ?? '', /kept rather than risk deleting a live one/);
    return true;
  });
  await listener.close();
  const secrets = await harness.core.secrets('file');
  assert.ok(await secrets.get(ref), 'the credential was deleted when nobody could say it was unused');
});

test('a workspace connected able to post needs a person, however the sign-in is started', async () => {
  /*
   * `workspace remove` then `workspace add --mode send` used to turn a read-only workspace into one that can post with
   * no person at a terminal. Core now refuses to record one without consent; this is the earlier refusal, before a
   * flow exists, so nobody is sent to Slack's consent screen for a grant that will not be recorded.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
  const port = await freePort();
  await assert.rejects(
    startSignIn(context, { mode: 'send', alias: 'acme', clientId: TEST_CLIENT_ID, port }),
    (error: unknown) => error instanceof CommsError && error.code === 'LOOSENING_REFUSED',
  );
  // Consent for a different workspace is not consent for this one.
  await assert.rejects(
    startSignIn(context, {
      mode: 'send',
      alias: 'acme',
      clientId: TEST_CLIENT_ID,
      port,
      consent: { kind: 'loosening-consent', paths: ['accounts.other.mode'] },
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'LOOSENING_REFUSED',
  );
  assert.deepEqual(
    await readdir(join(harness.core.paths.stateDir, 'slack', 'flows')).catch(() => []),
    [],
    'no flow was created',
  );

  // With the person's consent, and in read mode without it, the sign-in starts as before.
  const started = await startSignIn(context, {
    mode: 'send',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port,
    detached: false,
    consent: { kind: 'loosening-consent', paths: ['accounts.acme.mode'] },
  });
  await started.listener?.close();
  assert.match(started.authUrl, /chat%3Awrite/);

  const read = await startSignIn(context, {
    mode: 'read',
    alias: 'other',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
  });
  await read.listener?.close();
  assert.doesNotMatch(read.authUrl, /chat%3Awrite/, 'a read sign-in needs no consent, and asks for no posting');
});

test('a flow to connect a posting workspace, left over from before the gate, is refused before Slack issues a token', async () => {
  const harness = await newHarness();
  let exchanges = 0;
  const context = new SlackContext({
    core: harness.core,
    env: harness.env,
    exchange: async (params) => {
      exchanges += 1;
      return harness.exchange(params);
    },
  });
  // Written as a flow started before this gate existed: `send`, a new workspace, and no consent on it.
  const flowId = newFlowIdFor(context);
  await context.flows.save({ ...(await pendingFlow(context, flowId)), mode: 'send' });
  await context.flows.recordOutcome(flowId, { code: 'fake-authorisation-code' });

  await assert.rejects(finishSignIn(context, { flowId, waitSeconds: 5 }), (error: CommsError) => {
    assert.equal(error.code, 'LOOSENING_REFUSED');
    return true;
  });
  assert.equal(exchanges, 0, 'the code was never exchanged, so no token exists');
  assert.deepEqual((await harness.core.config.load()).accounts, {});
  assert.equal(await context.flows.peek(flowId), null, 'and the flow is gone');
});

test('the package does not hand out the sign-in operations, so the gated paths are the only way in', async () => {
  // Anything exported here is a door a library caller can walk through without the CLI's questions. The core and
  // operation-level refusals hold regardless, but there is no reason to offer the door.
  const root = await import('../src/index.ts');
  for (const name of ['startSignIn', 'completeSignIn', 'finishSignIn']) {
    assert.equal(name in root, false, `${name} is exported from the package root`);
  }
});

test('a widening whose approval names another account is not saved, says why, and keeps no token', async () => {
  /*
   * A consent from a claimed change approval binds each loosening to the account it was approved on, by id, and
   * `ConfigStore.update` refuses a write that loosens anything else — a name that moved on to another account between
   * the claim and the write, minutes later. Core's refusal is right and says nothing about the sign-in the person has
   * just finished in Slack, so this one says that nothing was saved and how to ask again; and the token Slack issued
   * for it does not stay on this machine under a reference nothing names.
   */
  const harness = await newHarness();
  const context = new SlackContext({ core: harness.core, env: harness.env, exchange: (p) => harness.exchange(p) });
  const account = await harness.addWorkspace({ alias: 'acme', mode: 'read' });
  const real = await harness.core.secrets('file');
  const written: string[] = [];
  context.secrets = async () => ({
    kind: real.kind,
    get: (ref) => real.get(ref),
    delete: (ref) => real.delete(ref),
    invalidate: (ref) => real.invalidate(ref),
    async set(ref: string, value: string) {
      written.push(ref);
      await real.set(ref, value);
    },
  });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const started = await startSignIn(context, {
    mode: 'send',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
    expect: {
      accountId: account.id,
      workspaceId: account.workspace,
      userId: account.userId,
      oauthClientId: TEST_CLIENT_ID,
      appId: 'A0001',
    },
    consent: {
      kind: 'loosening-consent',
      paths: ['accounts.acme.mode'],
      changes: [{ path: 'accounts.acme.mode', before: 'read', after: 'send', id: 'acc_ZZZZZZZZZZZZZZZZ' }],
    },
  });
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  await redirectTo(started.authUrl);
  await assert.rejects(listener.result, (error: CommsError) => {
    assert.equal(error.code, 'LOOSENING_REFUSED');
    assert.match(error.message, /"acme" changed after this was approved, so the sign-in was not saved/);
    assert.match(error.hint ?? '', /Nothing was saved for it/);
    assert.match(error.hint ?? '', /agent-slack workspace reauth acme --mode send/);
    assert.match(String(error.details?.refused), /this is not the change that was approved/);
    return true;
  });
  await listener.close();

  const after = (await harness.core.config.load()).accounts.acme;
  assert.equal(after?.id, account.id);
  assert.equal(after?.mode, 'read');
  assert.equal(written.length, 1, 'the sign-in stored its credential before the write, as it does');
  assert.equal(await real.get(written[0] as string), null, 'the token Slack issued was left on this machine');
  assert.ok(await real.get(account.secretRef), 'the credential the workspace still uses is untouched');
});
