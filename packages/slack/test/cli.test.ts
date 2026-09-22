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
  options: {
    onStderr?: (soFar: string) => void;
    tty?: boolean;
    env?: NodeJS.ProcessEnv;
    /** Types back whatever challenge the CLI prints, as a person at a terminal would. */
    answerChallenge?: boolean;
  } = {},
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  const input = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  let answered = false;
  err.on('data', (chunk) => {
    stderr += String(chunk);
    if (options.answerChallenge && !answered) {
      // `Type ABCD to confirm` — the code is invented per run, so it is read back off the prompt.
      const asked = /Type (\S+) to confirm/.exec(stderr);
      if (asked) {
        answered = true;
        input.write(`${asked[1]}\n`);
      }
    }
    options.onStderr?.(stderr);
  });
  const code = await run(argv, {
    core: harness.core,
    env: { ...harness.env, ...options.env },
    exchange: (params) => harness.exchange(params),
    streams: {
      stdout: Object.assign(out, { isTTY: options.tty ?? false }),
      stderr: Object.assign(err, { isTTY: options.tty ?? false }),
      stdin: Object.assign(input, { isTTY: options.tty ?? false }),
    },
    openBrowser: () => undefined,
    probe: (input, init) => harness.probe(input, init),
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

test('reauth that comes back from a different Slack app is refused', async () => {
  /*
   * The client id cannot differ here — `reauth` re-uses the workspace's own, which is the point of recording it
   * — so what has to be caught is the app Slack says answered. They can disagree: an app can be deleted and
   * remade under the same client id, and the token that comes back then belongs to a different app with a
   * different install and different permissions.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', appId: 'A0001' });
  harness.reply = () => slackOk({ app_id: 'A9999' });
  const port = await freePort();
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

test('reauth --mode read narrows a send workspace, because that was asked for', async () => {
  // The other half of the default-versus-explicit rule: keeping the existing mode must not become "ignore --mode".
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const port = await freePort();
  const result = await cli(
    harness,
    ['workspace', 'reauth', 'acme', '--mode', 'read', '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  const after = (await harness.core.config.load()).accounts.acme;
  assert.equal(after?.mode, 'read');
  assert.deepEqual([...(after?.grantedScopes ?? [])], scopesForMode('read'));
});

test('reauth read → send is refused to an agent, by name', async () => {
  /*
   * The change D1 exists to prevent. A workspace connected as `read` holds a token that physically cannot post;
   * renewing it as `send` replaces that token with one that can, and nothing downstream undoes it.
   *
   * An agent that can run commands can also type a challenge, so the challenge is not what stops this — being
   * refused outright is.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read' });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'reauth', 'acme', '--mode', 'send', '--port', String(port), '--no-browser'],
    // The browser answers with a refusal only if the gate lets the flow start at all. It must not: this is here
    // so that removing the gate fails this test in seconds rather than hanging on a sign-in nobody completes.
    { ...browserOn({ error: 'access_denied' }), env: { CLAUDECODE: '1' } },
  );
  assert.equal(result.code, EXIT_CODES.APPROVAL);
  const error = result.json<Envelope<never>>().error;
  assert.equal(error?.code, 'LOOSENING_REFUSED');
  assert.match(error?.hint ?? '', /in their own terminal/);
  // Refused before anything was asked of Slack, and before the workspace changed.
  assert.equal(harness.calls.length, 0);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'read');
});

test('reauth read → send is refused with no terminal to type a challenge at', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read' });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'reauth', 'acme', '--mode', 'send', '--port', String(port), '--no-browser'],
    browserOn({ error: 'access_denied' }),
  );
  assert.equal(result.code, EXIT_CODES.APPROVAL);
  assert.match(result.json<Envelope<never>>().error?.message ?? '', /needs a terminal/);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'read');
});

test('reauth send → send renews without asking anybody anything', async () => {
  // The gate has to catch the widening and nothing else, or it becomes something people work around.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const port = await freePort();
  const result = await cli(
    harness,
    ['workspace', 'reauth', 'acme', '--mode', 'send', '--port', String(port), '--no-browser'],
    { ...browserOn(), env: { CLAUDECODE: '1' } },
  );
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'send');
});

test('doctor asks Slack who the token is, and fails when Slack says somebody else', async () => {
  /*
   * The only check here that can tell a revoked token from a working one. Everything else reads files this
   * package wrote, so it can only confirm we still agree with ourselves — a token revoked in Slack's own admin
   * screens looks perfect from disk.
   *
   * A token that works and is *somebody else's* is worse than a broken one: every later command would act as
   * that account while naming this one.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001', userId: 'U0001' });
  harness.authTest = () => new Response(JSON.stringify({ ok: true, team_id: 'T0001', user_id: 'U9999' }));

  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(result.code, EXIT_CODES.CONFIG);
  const checks = result.json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>().data?.checks;
  const identity = checks?.find((check) => check.id === 'identity');
  assert.equal(identity?.status, 'fail');
  assert.match(identity?.detail ?? '', /U9999/);
});

test('doctor reports a revoked token as revoked, with the command that replaces it', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  harness.authTest = () => new Response(JSON.stringify({ ok: false, error: 'token_revoked' }));

  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(result.code, EXIT_CODES.CONFIG);
  const identity = result
    .json<Envelope<{ checks: { id: string; status: string; detail: string; fix: string | null }[] }>>()
    .data?.checks.find((check) => check.id === 'identity');
  assert.equal(identity?.status, 'fail');
  assert.match(identity?.detail ?? '', /token_revoked/);
  assert.match(identity?.fix ?? '', /reauth acme/);
});

test('doctor on a machine with no network says it did not ask, and stays healthy', async () => {
  // An install is not broken because a laptop is on a train, and a `doctor` that fails on a plane is one people
  // learn to ignore.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  harness.probe = () => Promise.reject(new Error('getaddrinfo ENOTFOUND slack.com'));

  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(result.code, EXIT_CODES.OK);
  const identity = result
    .json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>()
    .data?.checks.find((check) => check.id === 'identity');
  assert.equal(identity?.status, 'unknown');
  assert.match(identity?.detail ?? '', /ENOTFOUND/);
});

test('--offline asks Slack nothing at all', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  // Counted rather than asserted inside the probe, which swallows everything thrown at it by design.
  let asked = 0;
  harness.probe = () => {
    asked += 1;
    return Promise.resolve(harness.authTest());
  };

  const result = await cli(harness, ['--json', 'doctor', '--offline']);
  assert.equal(asked, 0, '--offline reached the network');
  assert.equal(result.code, EXIT_CODES.OK);
  const identity = result
    .json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>()
    .data?.checks.find((check) => check.id === 'identity');
  assert.equal(identity?.status, 'unknown');
  assert.equal(identity?.detail, 'not asked');
});

test('scope drift is measured against what Slack reports, when Slack reports it', async () => {
  /*
   * Comparing the recorded scopes against the mode they were recorded for can only agree with itself. An admin
   * narrowing an app is exactly the drift this check is named for, and it is invisible from disk.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  harness.authTest = () =>
    new Response(JSON.stringify({ ok: true, team_id: 'T0001', user_id: 'U0001' }), {
      headers: {
        'x-oauth-scopes': scopesForMode('read')
          .filter((s) => s !== 'search:read')
          .join(','),
      },
    });

  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(result.code, EXIT_CODES.CONFIG);
  const scopes = result
    .json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>()
    .data?.checks.find((check) => check.id === 'scopes');
  assert.equal(scopes?.status, 'fail');
  assert.match(scopes?.detail ?? '', /missing search:read/);
});

test('a throttled Slack is not reported as a revoked token', async () => {
  /*
   * `ok: false` covers both "this token is revoked" and "ask again later". Reporting the second as the first
   * tells somebody to re-authorise a perfectly good credential — during exactly the minutes when Slack is least
   * able to help them, and `reauth` is the one piece of advice that throws away a working refresh token.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  harness.authTest = () => new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), { status: 429 });

  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(result.code, EXIT_CODES.OK, 'a rate limit was treated as a broken install');
  const identity = result
    .json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>()
    .data?.checks.find((check) => check.id === 'identity');
  assert.equal(identity?.status, 'unknown');
  assert.match(identity?.detail ?? '', /could not answer right now/);
});

test('an already-expired token is not asked about, because the answer would mean nothing', async () => {
  /*
   * Slack would refuse it, and the refusal would read as a credential problem. It is not one: an expired access
   * token is the ordinary state of a workspace nobody has used today, and `credential-state` already says so.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', bundle: { accessExpiresAt: '2020-01-01T00:00:00.000Z' } });
  /*
   * Counted, not `assert.fail`ed inside the probe.
   *
   * `probeIdentity` turns every thrown thing into `{ kind: 'unreachable' }` on purpose, so an assertion raised
   * in there is swallowed and the test passes whatever the code does. Found by deleting the guard and watching
   * nothing fail.
   */
  let asked = 0;
  harness.probe = () => {
    asked += 1;
    return Promise.resolve(harness.authTest());
  };

  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(asked, 0, 'doctor asked Slack about a token it already knew was stale');
  const checks = result.json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>().data?.checks;
  assert.equal(checks?.find((check) => check.id === 'identity')?.status, 'unknown');
  assert.match(checks?.find((check) => check.id === 'credential-state')?.detail ?? '', /expired/);
});

test('a widening a person approved actually goes through', async () => {
  /*
   * The half the refusal tests never covered: that the key works, not only that the door is locked.
   *
   * The consent is collected at the terminal and has to reach `ConfigStore.update`, which refuses a read→send
   * change without it — so dropping it anywhere on the way turns the gate from "a person must approve this" into
   * "this can never happen", and every refusal test still passes.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read' });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const port = await freePort();

  const result = await cli(
    harness,
    ['workspace', 'reauth', 'acme', '--mode', 'send', '--port', String(port), '--no-browser'],
    // A terminal, nobody's agent marker, and the challenge typed back.
    { ...browserOn(), tty: true, answerChallenge: true },
  );

  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'send');
});

test('two reauths of the same workspace: the second cannot overwrite what the first minted', async () => {
  /*
   * The case the in-lock check exists for, and the one it originally missed.
   *
   * Both sign-ins are for the same person in the same workspace, so every identity check passes for both. What
   * separates them is *which* account each set out to renew. Comparing against a snapshot read after the
   * exchange only asks "has the alias changed since I looked", which both answer yes to — so the one that
   * started first and finished second would overwrite a credential minted in between, and strand it.
   */
  const harness = await newHarness();
  const original = await harness.addWorkspace({ alias: 'acme' });
  const portA = await freePort();
  const portB = await freePort();

  // Two flows started against the same account, before either finishes.
  const first = await startDetached(harness, ['workspace', 'reauth', 'acme', '--port', String(portA)]);
  const second = await startDetached(harness, ['workspace', 'reauth', 'acme', '--port', String(portB)]);

  await redirect(second.authUrl);
  assert.equal(
    (await cli(harness, ['workspace', 'reauth', 'acme', '--finish', second.flowId, '--wait', '20'])).code,
    0,
  );
  const renewed = (await harness.core.config.load()).accounts.acme;
  assert.notEqual(renewed?.id, original.id, 'the first finish did not replace the account');

  // Now the older flow arrives. It set out to renew an account that no longer holds the alias.
  await redirect(first.authUrl);
  const late = await cli(harness, ['--json', 'workspace', 'reauth', 'acme', '--finish', first.flowId, '--wait', '20']);
  assert.equal(late.code, EXIT_CODES.CONFIG);
  assert.match(late.json<Envelope<never>>().error?.message ?? '', /changed while this sign-in was being completed/);

  const after = (await harness.core.config.load()).accounts.acme;
  assert.equal(after?.id, renewed?.id, 'a stale sign-in overwrote a newer credential');
  const secrets = await harness.core.secrets('file');
  assert.ok(await secrets.get(after?.secretRef as string), 'the live credential was stranded');
});

test('a mailbox taking the name mid-sign-in is caught too, because the two share one namespace', async () => {
  /*
   * S1 decided `inboxes` and `accounts` share a namespace rather than renaming `inboxes`, so a mailbox called
   * `work` and a workspace called `work` cannot both exist — otherwise every later lookup by alias is
   * ambiguous.
   *
   * The in-lock re-check therefore has to be `checkAliasFree`, which consults both maps, and not merely "is
   * there an account under this name". Weakening it to the latter left every other test passing, because they
   * all collide through `accounts`.
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

  // A Gmail inbox takes the name while the browser is still open.
  await harness.core.config.update((config) => ({
    ...config,
    inboxes: {
      ...config.inboxes,
      acme: {
        id: 'ibx_AAAAAAAAAAAAAAAA',
        provider: 'gmail',
        email: 'jo@example.test',
        identity: 'oidc',
        client: 'default',
        tier: 'organize',
        contacts: true,
        grantedScopes: [],
        secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
        internalDomains: [],
        createdAt: '2026-09-22T12:00:00.000Z',
      },
    },
  }));

  await redirect(start.authUrl);
  const finished = await cli(harness, ['--json', 'workspace', 'add', '--finish', start.flowId, '--wait', '20']);
  assert.equal(finished.code, EXIT_CODES.CONFIG);
  assert.match(finished.json<Envelope<never>>().error?.message ?? '', /already connected/);
  assert.equal((await harness.core.config.load()).accounts.acme, undefined);
});

test('doctor still asks about a token with minutes left, because Slack would still accept it', async () => {
  // Skipping on `isDue` skipped the identity check for any token within ten minutes of expiry — tokens that
  // work — while the comment beside it said only expired ones were skipped.
  const harness = await newHarness();
  const minutes = new Date(Date.now() + 5 * 60_000).toISOString();
  await harness.addWorkspace({ alias: 'acme', bundle: { accessExpiresAt: minutes } });
  let asked = 0;
  harness.probe = () => {
    asked += 1;
    return Promise.resolve(harness.authTest());
  };
  await cli(harness, ['--json', 'doctor']);
  assert.equal(asked, 1, 'a token Slack would still accept was not asked about');
});
