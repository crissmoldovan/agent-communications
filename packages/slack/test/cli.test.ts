import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '@agentcomms/core';
import { parseBundle } from '../src/auth/bundle.ts';
import { openFlowStore } from '../src/auth/flow.ts';
import { run } from '../src/cli/program.ts';
import { scopesForMode } from '../src/manifest.ts';
import { type Harness, newHarness, slackOk, TEST_CLIENT_ID } from './support/harness.ts';

/**
 * The command, end to end.
 *
 * The sign-in tests here drive a real loopback socket and a real redirect, because the part worth testing is
 * exactly the part a unit test of `readExchange` cannot see: that nothing is written when the grant is wrong, and
 * that what is written is what the grant said.
 */

const CLI_ENTRY = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  json: <T>() => T;
}

interface Envelope<T> {
  ok: boolean;
  schemaVersion: number;
  data?: T;
  error?: { code: string; message: string; hint?: string };
}

async function cli(
  harness: Harness,
  argv: string[],
  options: { onStderr?: (soFar: string) => void; tty?: boolean } = {},
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  err.on('data', (chunk) => {
    stderr += String(chunk);
    options.onStderr?.(stderr);
  });
  const code = await run(argv, {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: {
      stdout: Object.assign(out, { isTTY: options.tty ?? false }),
      stderr: Object.assign(err, { isTTY: options.tty ?? false }),
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
    },
    openBrowser: () => undefined,
    listenerCommand: {
      command: process.execPath,
      args: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI_ENTRY],
    },
  });
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
}

/** A port nothing is listening on right now. Slack needs one fixed in advance, so the tests must choose too. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((settle) => server.close(() => settle()));
  return port;
}

/**
 * A detached sign-in, with its listener registered for cleanup.
 *
 * `--start` leaves a real child process holding a real port for ten minutes, which is the whole point of it — and
 * means a test that starts one and never finishes it leaks a process and a port. One run left twelve behind
 * before this existed.
 */
const strays: number[] = [];
after(() => {
  for (const pid of strays) {
    try {
      process.kill(pid);
    } catch {
      // already gone, which is the normal case for a flow that was finished
    }
  }
});

async function startDetached(harness: Harness, argv: string[]): Promise<{ flowId: string; authUrl: string }> {
  const started = await cli(harness, ['--json', ...argv, '--start', '--no-browser']);
  assert.equal(started.code, EXIT_CODES.OK, started.stderr);
  const data = started.json<Envelope<{ flowId: string; authUrl: string }>>().data as {
    flowId: string;
    authUrl: string;
  };
  const flow = await openFlowStore(harness.core.paths.stateDir, () => new Date()).peek(data.flowId);
  if (flow?.listenerPid) strays.push(flow.listenerPid);
  return data;
}

/** Follows the authorisation URL the way a browser would: straight back to the loopback with a code. */
async function redirect(authUrl: string, over: Record<string, string> = {}): Promise<void> {
  const url = new URL(authUrl);
  const back = new URL(url.searchParams.get('redirect_uri') as string);
  back.searchParams.set('state', url.searchParams.get('state') as string);
  if (!('error' in over)) back.searchParams.set('code', 'fake-authorisation-code');
  for (const [key, value] of Object.entries(over)) back.searchParams.set(key, value);
  await fetch(back);
}

/** Waits for the CLI to print the authorisation link, then plays the browser. */
function browserOn(over: Record<string, string> = {}): { onStderr: (soFar: string) => void } {
  let done = false;
  return {
    onStderr(soFar) {
      if (done) return;
      const found = soFar.match(/https:\/\/slack\.com\/oauth\/v2\/authorize\?\S+/);
      if (!found) return;
      done = true;
      void redirect(found[0], over);
    },
  };
}

// ── manifest ──────────────────────────────────────────────────────────────────────────────────────────────────

test('the manifest names the port it was built with, and so does the command it tells you to run next', async () => {
  // The step people get wrong: Slack matches redirect URLs exactly, so a manifest made with one port and a
  // sign-in run with another fails at the redirect with no hint that two numbers had to agree.
  const harness = await newHarness();
  const result = await cli(harness, ['manifest', '--port', '51234']);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.match(result.stdout, /http:\/\/localhost:51234\/slack\/callback/);
  assert.match(result.stdout, /--port 51234/);
});

test('a manifest with no port is refused rather than guessed', async () => {
  const harness = await newHarness();
  const result = await cli(harness, ['--json', 'manifest']);
  assert.equal(result.code, EXIT_CODES.USAGE);
  const envelope = result.json<Envelope<never>>();
  assert.equal(envelope.error?.code, 'USAGE');
});

test('--json puts exactly one document on stdout', async () => {
  const harness = await newHarness();
  const result = await cli(harness, ['--json', 'manifest', '--port', '51234']);
  const envelope = result.json<Envelope<{ manifest: { oauth_config: unknown } }>>();
  assert.equal(envelope.ok, true);
  assert.ok(envelope.data?.manifest.oauth_config);
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
});

// ── listing, showing, removing ────────────────────────────────────────────────────────────────────────────────

test('an empty install says how to connect one, not that something is wrong', async () => {
  const harness = await newHarness();
  const result = await cli(harness, ['workspace', 'list']);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.match(result.stdout, /No workspace connected yet/);
  assert.match(result.stdout, /agent-slack manifest/);
});

test('removing takes the credential with it, and says what it did not remove', async () => {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme' });
  const secrets = await harness.core.secrets('file');
  assert.ok(await secrets.get(account.secretRef));

  const result = await cli(harness, ['workspace', 'remove', 'acme']);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(await secrets.get(account.secretRef), null, 'the credential outlived the workspace');
  assert.equal((await harness.core.config.load()).accounts.acme, undefined);
  // Disconnecting here leaves the app installed in Slack, and somebody who believes otherwise stops looking.
  assert.match(result.stdout, /still installed in your workspace/);
});

test('an unknown workspace exits 66 and says how to list the real ones', async () => {
  const harness = await newHarness();
  const result = await cli(harness, ['--json', 'workspace', 'show', 'nope']);
  assert.equal(result.code, EXIT_CODES.NOT_FOUND);
  assert.match(result.json<Envelope<never>>().error?.hint ?? '', /workspace list/);
});

// ── signing in ────────────────────────────────────────────────────────────────────────────────────────────────

test('a sign-in stores what the grant actually said, and never sends a client secret', async () => {
  const harness = await newHarness();
  const port = await freePort();
  const result = await cli(
    harness,
    ['workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);

  const config = await harness.core.config.load();
  const account = config.accounts.acme;
  assert.equal(account?.workspace, 'T0001');
  assert.equal(account?.userId, 'U0001');
  assert.equal(account?.mode, 'read');
  assert.deepEqual([...(account?.grantedScopes ?? [])].sort(), scopesForMode('read'));
  assert.equal(account?.oauthClientId, TEST_CLIENT_ID);

  /*
   * The whole reason this flow is usable at all: PKCE means the app has no secret to store, so there is nothing
   * on this machine that could leak one. An exchange that quietly carried a `client_secret` would mean the
   * opposite, and it would still work — which is why this is asserted rather than assumed.
   */
  const [call] = harness.calls;
  assert.equal(harness.calls.length, 1);
  assert.equal(call?.params.client_secret, undefined);
  assert.ok(call?.params.code_verifier);
  assert.equal(call?.params.client_id, TEST_CLIENT_ID);

  const secrets = await harness.core.secrets('file');
  const bundle = parseBundle(await secrets.get(account?.secretRef as string));
  assert.equal(bundle?.accessToken, 'fake-user-token-1');
  assert.ok(bundle?.refreshExpiresAt, 'the 30-day expiry was not recorded');
});

test('what the terminal says afterwards names the workspace and the person', async () => {
  // The browser page cannot: at that moment nothing has been exchanged. This is the only place that knows.
  const harness = await newHarness();
  const port = await freePort();
  const result = await cli(
    harness,
    ['workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.match(result.stdout, /Connected "acme"/);
  assert.match(result.stdout, /Acme \(T0001\)/);
  assert.match(result.stdout, /U0001/);
});

test('a grant missing a scope writes nothing at all', async () => {
  /*
   * The order is the guarantee. `--mode read` is a claim about a token, and the only moment it can be
   * established is before that token is stored; a half-written install would leave a credential nothing lists.
   */
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: scopesForMode('read').filter((scope) => scope !== 'search:read') });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.AUTH);
  assert.equal(result.json<Envelope<never>>().error?.code, 'SCOPE_MISSING');
  assert.deepEqual((await harness.core.config.load()).accounts, {});
});

test('a grant wider than the mode is refused, because the label would otherwise be a lie', async () => {
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: [...scopesForMode('read'), 'chat:write'] });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.CONFIG);
  assert.match(result.json<Envelope<never>>().error?.message ?? '', /chat:write/);
  assert.deepEqual((await harness.core.config.load()).accounts, {});
});

test('a bot token in the reply is refused, not dropped', async () => {
  // Dropping it would leave a token that can post in existence, in the same app, and unmentioned.
  const harness = await newHarness();
  harness.reply = () => slackOk({ access_token: 'fake-bot-token-1' });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.AUTH);
  assert.match(result.json<Envelope<never>>().error?.message ?? '', /bot token/);
  assert.deepEqual((await harness.core.config.load()).accounts, {});
});

test('a refusal at the consent screen is reported as one, and nothing is exchanged', async () => {
  const harness = await newHarness();
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', String(port), '--no-browser'],
    browserOn({ error: 'access_denied' }),
  );
  assert.equal(result.code, EXIT_CODES.AUTH);
  assert.match(result.json<Envelope<never>>().error?.message ?? '', /access_denied/);
  assert.equal(harness.calls.length, 0, 'a refused sign-in still called Slack');
});

test('connecting the same account twice is refused with the command that renews it', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'add', 'other', '--client-id', TEST_CLIENT_ID, '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.CONFIG);
  assert.match(result.json<Envelope<never>>().error?.hint ?? '', /reauth acme/);
});

// ── re-authorising ────────────────────────────────────────────────────────────────────────────────────────────

test('reauth keeps the access the workspace already had, rather than the flag default', async () => {
  /*
   * `--mode` carries a default, so at the option layer "not passed" and "passed read" look the same. Taking the
   * default would quietly downgrade a `send` workspace every time somebody renewed its grant — which is the
   * opposite of what "the same, again" means.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const port = await freePort();
  const result = await cli(
    harness,
    ['workspace', 'reauth', 'acme', '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'send');
});

test('reauth as a different person is refused, and the old credential is still there', async () => {
  // "The workspace's own app" binds the app, not the person: a browser signed into two accounts will authorise
  // whichever one is active.
  const harness = await newHarness();
  const before = await harness.addWorkspace({ alias: 'acme' });
  harness.reply = () => slackOk({ authed_user: { id: 'U0002' } });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'reauth', 'acme', '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.CONFIG);
  assert.match(result.json<Envelope<never>>().error?.message ?? '', /different Slack account/);

  const after = (await harness.core.config.load()).accounts.acme;
  assert.equal(after?.id, before.id, 'the account was replaced by a refused sign-in');
  const secrets = await harness.core.secrets('file');
  assert.ok(await secrets.get(before.secretRef), 'the working credential was removed by a refused sign-in');
});

test('a successful reauth replaces the credential and removes the old one', async () => {
  const harness = await newHarness();
  const before = await harness.addWorkspace({ alias: 'acme' });
  const port = await freePort();
  const result = await cli(
    harness,
    ['workspace', 'reauth', 'acme', '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);

  const after = (await harness.core.config.load()).accounts.acme;
  assert.notEqual(after?.secretRef, before.secretRef, 'the new credential was written over the old reference');
  const secrets = await harness.core.secrets('file');
  assert.equal(await secrets.get(before.secretRef), null, 'the superseded credential was left behind');
  assert.equal(parseBundle(await secrets.get(after?.secretRef as string))?.accessToken, 'fake-user-token-1');
});

test('reauth through a different Slack app is refused', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', oauthClientId: '9999.9999' });
  harness.reply = () => slackOk();
  const port = await freePort();
  // The CLI re-uses the workspace's own client id, so the refusal has to come from the app id Slack reports.
  harness.reply = () => slackOk({ app_id: 'A9999' });
  const result = await cli(
    harness,
    ['--json', 'workspace', 'reauth', 'acme', '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.CONFIG);
  assert.match(result.json<Envelope<never>>().error?.message ?? '', /different Slack app/);
});

// ── the two-step form ─────────────────────────────────────────────────────────────────────────────────────────

test('--start returns immediately and --finish completes it from another process', async () => {
  /*
   * The case this whole two-step shape exists for: an agent's shell call returns in seconds while consent takes
   * minutes. The listener is detached, so the process that finishes need not be the one that started.
   */
  const harness = await newHarness();
  const port = await freePort();
  const start = await startDetached(harness, [
    'workspace',
    'add',
    'acme',
    '--client-id',
    TEST_CLIENT_ID,
    '--port',
    String(port),
  ]);
  assert.match(start.flowId, /^sfl_/);

  await redirect(start.authUrl);
  const finished = await cli(harness, ['workspace', 'add', '--finish', start.flowId, '--wait', '20']);
  assert.equal(finished.code, EXIT_CODES.OK, finished.stderr);
  assert.equal((await harness.core.config.load()).accounts.acme?.workspace, 'T0001');
});

test('the same sign-in cannot be finished twice', async () => {
  const harness = await newHarness();
  const port = await freePort();
  const start = await startDetached(harness, [
    'workspace',
    'add',
    'acme',
    '--client-id',
    TEST_CLIENT_ID,
    '--port',
    String(port),
  ]);
  await redirect(start.authUrl);
  assert.equal((await cli(harness, ['workspace', 'add', '--finish', start.flowId, '--wait', '20'])).code, 0);

  const again = await cli(harness, ['--json', 'workspace', 'add', '--finish', start.flowId, '--wait', '1']);
  assert.equal(again.code, EXIT_CODES.NOT_FOUND);
  assert.equal(harness.calls.length, 1, 'the same authorisation code was exchanged twice');
});

test('--finish before the browser has answered says so and leaves the sign-in alone', async () => {
  const harness = await newHarness();
  const port = await freePort();
  const start = await startDetached(harness, [
    'workspace',
    'add',
    'acme',
    '--client-id',
    TEST_CLIENT_ID,
    '--port',
    String(port),
  ]);

  const waited = await cli(harness, ['--json', 'workspace', 'add', '--finish', start.flowId, '--wait', '1']);
  assert.equal(waited.code, EXIT_CODES.APPROVAL);
  assert.equal(waited.json<Envelope<never>>().error?.code, 'APPROVAL_PENDING');

  // Still finishable: a wait that ran out is not an answer.
  await redirect(start.authUrl);
  const finished = await cli(harness, ['workspace', 'add', '--finish', start.flowId, '--wait', '20']);
  assert.equal(finished.code, EXIT_CODES.OK, finished.stderr);
});

test('a reauth sign-in cannot be finished as an add', async () => {
  // The two do very different things, and a flow id is all `--finish` needs to name one.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const port = await freePort();
  const start = await startDetached(harness, ['workspace', 'reauth', 'acme', '--port', String(port)]);
  const wrong = await cli(harness, ['--json', 'workspace', 'add', '--finish', start.flowId, '--wait', '1']);
  assert.equal(wrong.code, EXIT_CODES.USAGE);
  assert.match(wrong.json<Envelope<never>>().error?.message ?? '', /re-authorising/);
});

// ── doctor ────────────────────────────────────────────────────────────────────────────────────────────────────

test('doctor exits 78 when something is broken, with one JSON document and the findings inside it', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', bundle: { state: 'refresh-uncertain' } });
  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(result.code, EXIT_CODES.CONFIG);
  const envelope = result.json<Envelope<{ healthy: boolean; checks: { id: string }[] }>>();
  assert.equal(envelope.ok, true, 'the findings are the output, so the envelope stays the normal one');
  assert.equal(envelope.data?.healthy, false);
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
});

test('doctor survives a credential it cannot read, and reports it', async () => {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme' });
  const secrets = await harness.core.secrets('file');
  await secrets.set(account.secretRef, 'not a bundle');

  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(result.code, EXIT_CODES.CONFIG);
  const checks = (result.json<Envelope<{ checks: { id: string; status: string }[] }>>().data?.checks ?? []).filter(
    (check) => check.id === 'credential',
  );
  assert.equal(checks[0]?.status, 'fail');
});

test('a healthy install exits 0', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const result = await cli(harness, ['doctor']);
  assert.equal(result.code, EXIT_CODES.OK, result.stdout);
});

test('a sign-in cannot connect over a name taken while it was waiting', async () => {
  /*
   * Ten minutes pass between `--start` and `--finish`, in different processes. The entry being replaced holds
   * the only reference to its credential, so writing over it would strand a live Slack token that nothing can
   * list, refresh or remove.
   */
  const harness = await newHarness();
  const port = await freePort();
  const start = await startDetached(harness, [
    'workspace',
    'add',
    'acme',
    '--client-id',
    TEST_CLIENT_ID,
    '--port',
    String(port),
  ]);

  // Somebody else takes the name in the gap — a different workspace, so the duplicate-account check does not fire.
  const squatter = await harness.addWorkspace({ alias: 'acme', workspaceId: 'T9999', userId: 'U9999' });

  await redirect(start.authUrl);
  const finished = await cli(harness, ['--json', 'workspace', 'add', '--finish', start.flowId, '--wait', '20']);
  assert.equal(finished.code, EXIT_CODES.CONFIG);
  assert.match(finished.json<Envelope<never>>().error?.message ?? '', /already connected/);

  const after = (await harness.core.config.load()).accounts.acme;
  assert.equal(after?.id, squatter.id, 'the workspace that held the name was replaced');
  const secrets = await harness.core.secrets('file');
  assert.ok(await secrets.get(squatter.secretRef), 'its credential was stranded');
});

test('a sign-in for one workspace cannot be finished under another name', async () => {
  // `reauth <alias>` makes the caller name a workspace; a flow id names one too, and they have to agree.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  await harness.addWorkspace({ alias: 'zed', workspaceId: 'T0002', userId: 'U0002' });
  const port = await freePort();
  const start = await startDetached(harness, ['workspace', 'reauth', 'acme', '--port', String(port)]);

  const wrong = await cli(harness, ['--json', 'workspace', 'reauth', 'zed', '--finish', start.flowId, '--wait', '1']);
  assert.equal(wrong.code, EXIT_CODES.USAGE);
  assert.match(wrong.json<Envelope<never>>().error?.message ?? '', /is for "acme", not "zed"/);
});
