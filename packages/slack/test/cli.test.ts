import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';
import { EXIT_CODES, withCredentialsLock } from '@agentcomms/core';
import { parseBundle } from '../src/auth/bundle.ts';
import { openFlowStore } from '../src/auth/flow.ts';
import { run } from '../src/cli/program.ts';
import { scopesForMode } from '../src/manifest.ts';
import { type Harness, newHarness, slackOk, TEST_CLIENT_ID, tempDir } from './support/harness.ts';
import { LISTENER_COMMAND, stopListeners } from './support/listener.ts';

/**
 * The command, end to end.
 *
 * The sign-in tests here drive a real loopback socket and a real redirect, because the part worth testing is
 * exactly the part a unit test of `readExchange` cannot see: that nothing is written when the grant is wrong, and
 * that what is written is what the grant said.
 */

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
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

/** What a change waiting for approval says: the approval, the policy that decides it, and what the person reads. */
interface PendingChange {
  approvalId: string;
  policy: 'chat' | 'confirm';
  preview: string;
}

/** The approval a changing command stopped for, read off its refusal. */
function pendingOf(result: { code: number; json: <T>() => T }): PendingChange {
  assert.equal(result.code, EXIT_CODES.APPROVAL);
  const error = result.json<Envelope<never>>().error;
  assert.equal(error?.code, 'APPROVAL_PENDING', JSON.stringify(error));
  const details = error?.details as unknown as PendingChange;
  assert.match(details.approvalId, /^ap_/);
  return details;
}

async function cli(
  harness: Harness,
  argv: string[],
  options: {
    onStderr?: (soFar: string) => void;
    tty?: boolean;
    env?: NodeJS.ProcessEnv;
    /** The fetch the read commands use, so a test never reaches Slack. */
    read?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    /**
     * Answers the approval the CLI asks for, as a person at a terminal would: `yes` to a change under the `chat`
     * change policy, and the code it shows under `confirm` or for a post.
     */
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
      // `Type yes to apply this change`, or `Type ABCD to approve this change` — the code is invented per run, so
      // what to type is read back off the prompt.
      const asked = /Type (\S+) to (?:confirm|apply this change|approve this change)/.exec(stderr);
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
    ...(options.read ? { read: options.read } : {}),
    listenerCommand: LISTENER_COMMAND,
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
 * A detached sign-in, with its listener stopped when the test that started it ends.
 *
 * `--start` leaves a real child process holding a real port for ten minutes, which is the whole point of it — and
 * means a test that starts one and never finishes it leaks a process and a port. One run left twelve behind
 * before any cleanup existed.
 *
 * Stopped after each test, not once after the file. A file-wide `after` hook ran only if the file got that far:
 * when the runner ended the file for overrunning its timeout, it never ran, and every listener the unfinished
 * tests had left for it stayed up. Per test, a killed file strands at most the listener of the test it was in —
 * and `LISTENER_COMMAND` ends that one once this process has gone.
 */
let strays: number[] = [];
afterEach(async () => {
  const started = strays;
  strays = [];
  await stopListeners(started);
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

test('the setup skill says `--port` may be left off `manifest` only when it names a workspace', async () => {
  /*
   * A recorded port is a workspace's. `manifest` alone names none, so it has nothing to fall back on and still needs
   * the number given; `manifest --workspace` names one, and uses the port it signed in with. The skill listed
   * `manifest` and `workspace reauth` as two steps and then said `--port` could be left out of "both", which sent a
   * reader to a refusal on the first of them — so each claim is checked against what the command does.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read', redirectPort: 50123 });
  const bare = await cli(harness, ['--json', 'manifest', '--mode', 'send']);
  assert.equal(bare.code, EXIT_CODES.USAGE, 'a recorded port does not reach a `manifest` that names no workspace');
  const named = await cli(harness, ['--json', 'manifest', '--mode', 'send', '--workspace', 'acme']);
  assert.equal(named.code, EXIT_CODES.OK, named.stdout);
  assert.equal(named.json<Envelope<{ port: number }>>().data?.port, 50123, 'and does reach one that names it');

  const skill = await readFile(new URL('../../../skills/slack-setup/SKILL.md', import.meta.url), 'utf8');
  const claims = skill
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;])\s/)
    .filter((sentence) => /--port`? can be left out/.test(sentence));
  assert.ok(claims.length > 0, 'the skill still says where the port can be left out');
  for (const claim of claims) {
    assert.doesNotMatch(
      claim,
      /\bboth\b|\ball\b|\bmanifest\b(?! --workspace)/,
      `names only commands that fill it in: ${claim}`,
    );
  }
  assert.match(skill.replace(/\s+/g, ' '), /`agent-slack manifest` [^.]*needs `--port`/, 'and says manifest needs it');
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

test('removing is approved first, takes the credential with it, and says what it did not remove', async () => {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme' });
  const secrets = await harness.core.secrets('file');
  assert.ok(await secrets.get(account.secretRef));

  // A deleted token cannot be taken back, so without a person at the terminal it waits, having removed nothing.
  const pending = pendingOf(
    await cli(harness, ['--json', 'workspace', 'remove', 'acme'], { env: { CLAUDECODE: '1' } }),
  );
  assert.match(pending.preview, /removes acme and deletes its token from this machine/);
  assert.ok(await secrets.get(account.secretRef), 'something was removed before anybody approved it');
  assert.ok((await harness.core.config.load()).accounts.acme);

  // A person at a terminal approves it there and then.
  const result = await cli(harness, ['workspace', 'remove', 'acme'], { tty: true, answerChallenge: true });
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.equal(await secrets.get(account.secretRef), null, 'the credential outlived the workspace');
  assert.equal((await harness.core.config.load()).accounts.acme, undefined);
  // Disconnecting here leaves the app installed in Slack, and somebody who believes otherwise stops looking.
  assert.match(result.stdout, /still installed in your workspace/);
});

test('agent-slack approve approves a change under confirm, so the person needs no other command', async () => {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme' });
  // Tightening, so it needs nobody's consent: from here every change asks for a person at a terminal.
  await harness.core.config.update((config) => ({
    ...config,
    defaults: { ...config.defaults, changePolicy: 'confirm' },
  }));

  const pending = pendingOf(
    await cli(harness, ['--json', 'workspace', 'remove', 'acme'], { env: { CLAUDECODE: '1' } }),
  );
  // An agent cannot approve it with this command either.
  const refused = await cli(harness, ['--json', 'approve', pending.approvalId], {
    env: { CLAUDECODE: '1' },
    tty: true,
  });
  assert.notEqual(refused.code, EXIT_CODES.OK);

  const approved = await cli(harness, ['approve', pending.approvalId], { tty: true, answerChallenge: true });
  assert.equal(approved.code, EXIT_CODES.OK, approved.stderr);
  assert.match(approved.stdout, /the change is applied by the command that prepared it/);
  assert.equal((await harness.core.config.load()).accounts.acme?.id, account.id, 'approving applied nothing');

  const applied = await cli(harness, ['--json', 'workspace', 'remove', 'acme', '--approval', pending.approvalId], {
    env: { CLAUDECODE: '1' },
  });
  assert.equal(applied.code, EXIT_CODES.OK, applied.stdout);
  assert.equal((await harness.core.config.load()).accounts.acme, undefined);
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
  const error = result.json<Envelope<never>>().error;
  // Posting scopes on a `read` sign-in are what Slack's accumulated grant looks like, and the advice says so:
  // removing the app's installation, never re-creating the app, which changes no installation.
  assert.match(error?.message ?? '', /posting scopes it granted this app before: chat:write/);
  assert.match(error?.hint ?? '', /Manage apps → the app → Remove app/);
  assert.doesNotMatch(error?.hint ?? '', /Re-create/);
  assert.deepEqual((await harness.core.config.load()).accounts, {});
});
test('a scope beyond both modes still points at the app, which is where it came from', async () => {
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: [...scopesForMode('read'), 'admin'] });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', String(port), '--no-browser'],
    browserOn(),
  );
  assert.equal(result.code, EXIT_CODES.CONFIG);
  assert.match(
    result.json<Envelope<never>>().error?.hint ?? '',
    /Re-create it from `agent-slack manifest --mode read`/,
  );
});

test('workspace mode counts each posting scope on its own, and none as none', async () => {
  // A report that only recognised one of the three would pass any test that granted them together.
  const harness = await newHarness();
  const cases: Array<[string, string[]]> = [
    ['chat:write', ['chat:write']],
    ['files:write', ['files:write']],
    ['reactions:write', ['reactions:write']],
    ['none', []],
  ];
  let n = 1;
  for (const [label, extra] of cases) {
    n += 1;
    const alias = `w${n}`;
    await harness.addWorkspace({
      alias,
      workspaceId: `T00${n}0`,
      userId: `U00${n}0`,
      grantedScopes: [...scopesForMode('read'), ...extra],
    });
    const report = (await cli(harness, ['--json', 'workspace', 'mode', alias])).json<
      Envelope<{ canActOutward: boolean; outwardScopes: string[] }>
    >().data;
    assert.deepEqual(report?.outwardScopes, extra, label);
    assert.equal(report?.canActOutward, extra.length > 0, label);
  }
});

test('workspace mode says what a workspace can do, from its recorded grant', async () => {
  const harness = await newHarness();
  // Three different workspaces: the configuration treats the same person in the same workspace as one account.
  await harness.addWorkspace({ alias: 'acme' });
  await harness.addWorkspace({ alias: 'loud', mode: 'send', workspaceId: 'T0002', userId: 'U0002' });
  // Labelled read, but the recorded grant includes a reaction scope: the report believes the grant.
  await harness.addWorkspace({
    alias: 'odd',
    workspaceId: 'T0003',
    userId: 'U0003',
    grantedScopes: [...scopesForMode('read'), 'reactions:write'],
  });

  type Report = { mode: string; canActOutward: boolean; outwardScopes: string[]; toSend: string[]; toRead: string[] };
  const reportOf = async (alias: string) =>
    (await cli(harness, ['--json', 'workspace', 'mode', alias], { env: { CLAUDECODE: '1' } })).json<Envelope<Report>>()
      .data as Report;

  const read = await reportOf('acme');
  assert.equal(read.canActOutward, false);
  assert.equal(read.toSend.length, 2, 'the app first, then the sign-in');
  assert.deepEqual(read.toRead, []);

  const send = await reportOf('loud');
  assert.deepEqual(send.outwardScopes, ['chat:write', 'files:write', 'reactions:write']);
  assert.match(send.toRead.join('\n'), /Remove app/);
  assert.match(send.toRead.join('\n'), /workspace reauth loud --mode read/);

  const odd = await reportOf('odd');
  assert.equal(odd.mode, 'read');
  assert.equal(odd.canActOutward, true);
  assert.deepEqual(odd.outwardScopes, ['reactions:write']);
  assert.ok(odd.toRead.length > 0, 'and says how to take it away, although the label says read');
});

test('workspace mode read changes nothing and says what does; mode send needs a port, the app, and an approval', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'loud', mode: 'send' });
  await harness.addWorkspace({ alias: 'acme' });
  const before = JSON.stringify(await harness.core.config.load());

  const read = await cli(harness, ['--json', 'workspace', 'mode', 'loud', 'read', '--port', '51234'], {
    env: { CLAUDECODE: '1' },
  });
  assert.equal(read.code, EXIT_CODES.OK, read.stderr);
  const data = read.json<Envelope<{ changed: boolean; steps: string[] }>>().data;
  assert.equal(data?.changed, false);
  assert.match(data?.steps.join('\n') ?? '', /workspace reauth loud --mode read --port 51234/);
  assert.equal(JSON.stringify(await harness.core.config.load()), before, 'nothing was written');

  const noPort = await cli(harness, ['--json', 'workspace', 'mode', 'acme', 'send']);
  assert.equal(noPort.code, EXIT_CODES.USAGE);
  // Both procedures name the port, which the configuration does not keep.
  const noPortRead = await cli(harness, ['--json', 'workspace', 'mode', 'loud', 'read']);
  assert.equal(noPortRead.code, EXIT_CODES.USAGE);

  /*
   * A read workspace's grant cannot show its app was widened, so the app step comes back first — the manifest, and the
   * link to that app's own manifest page — and nothing starts: a sign-in now would be granted read again.
   */
  const port = String(await freePort());
  const agent = await cli(harness, ['--json', 'workspace', 'mode', 'acme', 'send', '--port', port, '--start'], {
    env: { CLAUDECODE: '1' },
  });
  assert.equal(agent.code, EXIT_CODES.OK, agent.stderr);
  const appStep =
    agent.json<
      Envelope<{
        changed: boolean;
        appUpdateNeeded: boolean;
        steps: string[];
        manifest: { manifestUrl: string; manifest: { oauth_config: { scopes: { user: string[] } } } };
        terminalAlternative: string;
      }>
    >().data;
  assert.equal(appStep?.changed, false);
  assert.equal(appStep?.appUpdateNeeded, true);
  assert.equal(appStep?.manifest.manifestUrl, 'https://api.slack.com/apps/A0001/app-manifest');
  assert.ok(appStep?.manifest.manifest.oauth_config.scopes.user.includes('chat:write'), 'the send manifest');
  assert.match(appStep?.steps[0] ?? '', /apps\/A0001\/app-manifest/, 'the step links the app’s own page');
  assert.equal(appStep?.terminalAlternative, `agent-slack app update acme --mode send --port ${port}`);
  assert.equal(JSON.stringify(await harness.core.config.load()), before);

  // Once the person says the app is updated, it is a change they approve before any sign-in starts.
  const asked = await cli(
    harness,
    ['--json', 'workspace', 'mode', 'acme', 'send', '--app-updated', '--port', port, '--start'],
    { env: { CLAUDECODE: '1' } },
  );
  const pending = pendingOf(asked);
  assert.match(pending.preview, /acme mode: read → send/);
  assert.match(asked.json<Envelope<never>>().error?.hint ?? '', new RegExp(`--approval ${pending.approvalId}`));
  assert.equal(JSON.stringify(await harness.core.config.load()), before);
  assert.equal(harness.calls.length, 0, 'nothing was asked of Slack');

  // A record from before workspaces remembered their app cannot be re-authorised, and is told what works instead.
  await harness.addWorkspace({ alias: 'old', mode: 'send', workspaceId: 'T0009', userId: 'U0009' });
  await harness.core.config.update((config) => {
    const { oauthClientId: _dropped, ...legacyRow } = config.accounts.old as NonNullable<
      (typeof config.accounts)['old']
    >;
    return { ...config, accounts: { ...config.accounts, old: legacyRow } };
  });
  const legacy = await cli(harness, ['--json', 'workspace', 'mode', 'old', 'read', '--port', '51234']);
  const legacySteps = legacy.json<Envelope<{ steps: string[] }>>().data?.steps.join('\n') ?? '';
  assert.match(legacySteps, /workspace remove old/);
  assert.doesNotMatch(legacySteps, /workspace reauth old/);
});

test('the manifest names the other mode and what switching to it takes', async () => {
  const harness = await newHarness();
  const read = await cli(harness, ['manifest', '--port', '51234']);
  assert.match(read.stdout, /agent-slack manifest --mode send --port 51234/);
  assert.match(read.stdout, /update this same app with it first/);
  const send = await cli(harness, ['manifest', '--mode', 'send', '--port', '51234']);
  assert.match(send.stdout, /agent-slack workspace mode <name> send --app-updated --port 51234/);
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

test('reauth keeps the access the workspace already had, rather than a flag default', async () => {
  /*
   * `add`'s `--mode` defaults to `read`. Taking that default here would quietly downgrade a `send` workspace every
   * time somebody renewed its grant — which is the opposite of what "the same, again" means.
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

test('reauth --help says an absent --mode keeps the workspace’s own, and promises no `read` default', async () => {
  // The help (and the reference page generated from it) said `default: "read"` while the command kept the
  // workspace's mode — a person reading it would pass `--mode send` to avoid a downgrade that never happens, or
  // trust a renewal to narrow a workspace it leaves able to post.
  const harness = await newHarness();
  // Help wraps at the terminal's width, so an option's text is read with its line breaks folded away.
  const modeOf = async (argv: string[]) => {
    const help = (await cli(harness, [...argv, '--help'])).stdout.replace(/\s+/g, ' ');
    return /--mode <mode> (.*?) --port/.exec(help)?.[1] ?? '';
  };
  const reauth = await modeOf(['workspace', 'reauth']);
  assert.match(reauth, /its own mode when left out/);
  assert.doesNotMatch(reauth, /default/);
  // `add` still starts at `read`, and says so.
  assert.match(await modeOf(['workspace', 'add']), /default: "read"/);
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
  // The same account, renewed: an MCP server pinned to it, and the drafts and approvals filed under it, still find it.
  assert.equal(after?.id, before.id, 'the renewal replaced the account rather than its credential');
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

test('reauth read → send by an agent waits for an approval, and asks Slack nothing until it has one', async () => {
  /*
   * The change D1 exists to guard. A workspace connected as `read` holds a token that physically cannot post;
   * renewing it as `send` replaces that token with one that can, and nothing downstream undoes it.
   *
   * Since 2026-09-25 an agent may make it — once a person has approved exactly that change. Until then it gets the
   * preview and the approval id, and nothing is started: no listener, no link, no exchange.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read' });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const port = String(await freePort());
  const argv = ['--json', 'workspace', 'reauth', 'acme', '--mode', 'send', '--port', port];
  const asked = await cli(harness, [...argv, '--no-browser'], {
    // The browser answers with a refusal only if a flow starts at all. It must not: this is here so that removing
    // the gate fails this test in seconds rather than hanging on a sign-in nobody completes.
    ...browserOn({ error: 'access_denied' }),
    env: { CLAUDECODE: '1' },
  });
  const pending = pendingOf(asked);
  assert.equal(pending.policy, 'chat');
  assert.match(pending.preview, /acme mode: read → send — it will be able to send, not only read/);
  assert.match(pending.preview, /signs in to Slack again as acme and stores a token that can post/);
  assert.equal(harness.calls.length, 0);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'read');

  // The person said yes in the conversation; the agent claims it, and the sign-in starts with the consent on it.
  const { flowId, authUrl } = await startDetached(harness, [
    'workspace',
    'reauth',
    'acme',
    '--mode',
    'send',
    '--port',
    port,
    '--approval',
    pending.approvalId,
  ]);
  await redirect(authUrl);
  const finished = await cli(harness, ['--json', 'workspace', 'reauth', 'acme', '--finish', flowId, '--wait', '20'], {
    env: { CLAUDECODE: '1' },
  });
  assert.equal(finished.code, EXIT_CODES.OK, finished.stdout);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'send');
});

test('under the confirm change policy, an agent cannot claim its own widening before a person approves it', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read' });
  // Tightening, so it needs nobody's consent.
  await harness.core.config.update((config) => ({
    ...config,
    defaults: { ...config.defaults, changePolicy: 'confirm' },
  }));
  const port = String(await freePort());
  const argv = ['--json', 'workspace', 'reauth', 'acme', '--mode', 'send', '--port', port, '--start', '--no-browser'];
  const asked = await cli(harness, argv, { env: { CLAUDECODE: '1' } });
  const pending = pendingOf(asked);
  assert.equal(pending.policy, 'confirm');
  assert.match(
    asked.json<Envelope<never>>().error?.hint ?? '',
    new RegExp(`agent-slack approve ${pending.approvalId}`),
  );

  const claimed = await cli(harness, [...argv, '--approval', pending.approvalId], { env: { CLAUDECODE: '1' } });
  assert.equal(claimed.code, EXIT_CODES.APPROVAL);
  const error = claimed.json<Envelope<never>>().error;
  assert.equal(error?.code, 'APPROVAL_PENDING');
  assert.match(error?.message ?? '', /needs a person to approve it at a terminal first/);
  assert.equal(harness.calls.length, 0);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'read');
  assert.deepEqual(await openFlowStore(harness.core.paths.stateDir, () => new Date()).pending(), [], 'no sign-in');
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
   * separates them is *which* credential each set out to replace — the account keeps its id across a renewal.
   * Comparing against a snapshot read after the exchange only asks "has the alias changed since I looked", which
   * both answer yes to — so the one that started first and finished second would overwrite a credential minted in
   * between.
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
  assert.notEqual(renewed?.secretRef, original.secretRef, 'the first finish did not replace the credential');
  assert.equal(renewed?.id, original.id, 'a renewal keeps the account');

  // Now the older flow arrives. It set out to replace a credential the account no longer holds.
  await redirect(first.authUrl);
  const late = await cli(harness, ['--json', 'workspace', 'reauth', 'acme', '--finish', first.flowId, '--wait', '20']);
  assert.equal(late.code, EXIT_CODES.CONFIG);
  assert.match(late.json<Envelope<never>>().error?.message ?? '', /changed while this sign-in was being completed/);

  const after = (await harness.core.config.load()).accounts.acme;
  assert.equal(after?.secretRef, renewed?.secretRef, 'a stale sign-in overwrote a newer credential');
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

test('reauth keeps the send policy the person set, on both sides of the default', async () => {
  /*
   * `accountFrom` builds a record from the token alone, so writing it whole on a reauth dropped every setting
   * made since. An explicit `never` became the default `chat` — and because reauth rotates the account id, the
   * loosening check read the result as a new account arriving at the default and asked nobody.
   *
   * Both directions, because "keep the setting" and "reset to the default" only disagree when the setting is
   * not the default, and a test on one side cannot tell them apart.
   */
  for (const policy of ['never', 'confirm'] as const) {
    const harness = await newHarness();
    await harness.addWorkspace({ alias: 'acme', sendPolicy: policy });
    const port = await freePort();
    const result = await cli(
      harness,
      ['workspace', 'reauth', 'acme', '--port', String(port), '--no-browser'],
      browserOn(),
    );
    assert.equal(result.code, EXIT_CODES.OK, result.stderr);
    assert.equal(
      (await harness.core.config.load()).accounts.acme?.sendPolicy,
      policy,
      `a reauth reset "${policy}" to the default`,
    );
  }
});

test('without --port, the mode steps and a reauth use the port the workspace signed in with', async () => {
  /*
   * Slack matches the redirect URL exactly, so the port is not a preference: it is the one in the app. The
   * configuration did not keep it, so every one of these asked for it again — and the MCP server, which cannot ask,
   * guessed 51234.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'loud', mode: 'send', redirectPort: 50123 });
  const read = await cli(harness, ['--json', 'workspace', 'mode', 'loud', 'read'], { env: { CLAUDECODE: '1' } });
  assert.equal(read.code, EXIT_CODES.OK, read.stderr);
  const steps = read.json<Envelope<{ steps: string[] }>>().data?.steps.join('\n') ?? '';
  assert.match(steps, /workspace reauth loud --mode read --port 50123/);

  const port = await freePort();
  await harness.addWorkspace({ alias: 'acme', redirectPort: port });
  const result = await cli(harness, ['workspace', 'reauth', 'acme', '--no-browser'], browserOn());
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.equal((await harness.core.config.load()).accounts.acme?.redirectPort, port, 'and the new record keeps it');

  // A reauth on another port — the app's redirect was changed to match — records that one instead.
  const moved = await freePort();
  const again = await cli(
    harness,
    ['workspace', 'reauth', 'acme', '--port', String(moved), '--no-browser'],
    browserOn(),
  );
  assert.equal(again.code, EXIT_CODES.OK, again.stderr);
  assert.equal((await harness.core.config.load()).accounts.acme?.redirectPort, moved);
});

test('a stored mode that is neither read nor send is refused, never read as send', async () => {
  /*
   * Core stores `mode` as any non-empty string, and this package used to treat every value except `read` as
   * `send`. A typo of `read` in a hand-edited config therefore asked Slack for posting scopes — and skipped the
   * read → send challenge, because the stored value was not `read` either.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'raed' });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'reauth', 'acme', '--port', String(port), '--no-browser'],
    // Answers with a refusal only if the flow wrongly starts, so a regression fails fast instead of hanging.
    browserOn({ error: 'access_denied' }),
  );
  assert.equal(result.code, EXIT_CODES.CONFIG);
  assert.match(result.json<Envelope<never>>().error?.message ?? '', /neither "read" nor "send"/);
  assert.equal(harness.calls.length, 0, 'a sign-in was started for a mode nobody chose');
});

test('doctor reports an unknown stored mode instead of crashing or assuming read', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'raed' });
  const result = await cli(harness, ['--json', 'doctor', '--offline']);
  assert.equal(result.code, EXIT_CODES.CONFIG);
  const scopes = result
    .json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>()
    .data?.checks.find((check) => check.id === 'scopes');
  assert.equal(scopes?.status, 'fail');
  assert.match(scopes?.detail ?? '', /raed/);
});

test('--mode send on a workspace whose stored mode is a typo does not skip the challenge', async () => {
  /*
   * The exact hole: the challenge fires when the stored mode is `read`. A stored `raed` is not `read`, and an
   * explicit `--mode send` is a perfectly valid mode, so the scope check downstream has nothing to object to —
   * and a posting sign-in would start with no challenge and no refusal, for a workspace the person connected
   * read-only. Only checking the stored value itself closes it.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'raed' });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const port = await freePort();
  const result = await cli(
    harness,
    ['--json', 'workspace', 'reauth', 'acme', '--mode', 'send', '--port', String(port), '--no-browser'],
    browserOn({ error: 'access_denied' }),
  );
  assert.equal(result.code, EXIT_CODES.CONFIG, result.stdout);
  assert.match(result.json<Envelope<never>>().error?.message ?? '', /neither "read" nor "send"/);
  assert.equal(harness.calls.length, 0);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'raed', 'the workspace was changed');
});

test('--wait is a number of seconds from 0 to 600, and nothing else', async () => {
  /*
   * `Number(flags.wait) || 60` turned `0` into sixty seconds, accepted negatives, and accepted `Infinity` — an
   * unbounded deadline on a command whose whole job is to return.
   */
  const harness = await newHarness();
  for (const bad of ['-5', 'Infinity', 'soon', '601']) {
    const result = await cli(harness, [
      '--json',
      'workspace',
      'add',
      '--finish',
      'sfl_aaaaaaaaaaaaaaaaaaaaaa',
      '--wait',
      bad,
    ]);
    assert.equal(result.code, EXIT_CODES.USAGE, `--wait ${bad} was accepted`);
    assert.match(result.json<Envelope<never>>().error?.message ?? '', /is not a wait/);
  }
});

test('--wait 0 looks once and reports, rather than quietly waiting a minute', async () => {
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
  const began = Date.now();
  const result = await cli(harness, ['--json', 'workspace', 'add', '--finish', start.flowId, '--wait', '0']);
  assert.equal(result.code, EXIT_CODES.APPROVAL);
  assert.ok(Date.now() - began < 5000, `--wait 0 took ${Date.now() - began}ms`);
});

test('removing waits for a migration holding the credentials lock, instead of deleting under it', async () => {
  /*
   * Removal deleted the credential before any lock, so a migration running in between saw an account still
   * configured with nothing stored, skipped it, switched backends — and the removal then refused because the
   * backend had moved. The account stayed configured with its credential in neither backend.
   *
   * Here the lock is held as a migration would hold it. While it is held, nothing may have been deleted.
   */
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme' });
  const secrets = await harness.core.secrets('file');
  // Approved beforehand, so what is timed below is the removal itself.
  const { approvalId } = pendingOf(await cli(harness, ['--json', 'workspace', 'remove', 'acme']));

  let midway: string | null = 'unread';
  const migration = withCredentialsLock(harness.core.paths.configDir, async () => {
    await new Promise((settle) => setTimeout(settle, 400));
  });
  await new Promise((settle) => setTimeout(settle, 50)); // the lock is held from here
  const removal = cli(harness, ['workspace', 'remove', 'acme', '--approval', approvalId]);
  await new Promise((settle) => setTimeout(settle, 150)); // removal has started and must be waiting
  midway = await secrets.get(account.secretRef);

  await migration;
  const result = await removal;
  assert.ok(midway, 'the credential was deleted while a migration held the credentials lock');
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.equal(await secrets.get(account.secretRef), null);
  assert.equal((await harness.core.config.load()).accounts.acme, undefined);
});

test('the identify scope Slack adds to every user token is not reported as drift', async () => {
  /*
   * Found by the first real sign-in. The grant held exactly the eleven read scopes, but `auth.test`'s scope header
   * listed `identify` too, and `doctor` failed every healthy install with a fix that could not work. The harness
   * now mirrors what Slack actually sends.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  harness.authTest = () =>
    new Response(JSON.stringify({ ok: true, team_id: 'T0001', user_id: 'U0001' }), {
      headers: { 'x-oauth-scopes': [...scopesForMode('read'), 'identify'].sort().join(',') },
    });

  const result = await cli(harness, ['--json', 'doctor']);
  const scopes = result
    .json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>()
    .data?.checks.find((check) => check.id === 'scopes');
  assert.equal(scopes?.status, 'ok', scopes?.detail);
  // And it says so, rather than calling the filtered eleven "exactly as Slack reports them" when Slack sent twelve.
  assert.match(scopes?.detail ?? '', /the 11 scopes it asked for/);
  assert.match(scopes?.detail ?? '', /plus identify, which Slack adds to every user token/);
  assert.equal(result.code, EXIT_CODES.OK);
});

test('a scope beyond read that Slack reports is still drift, identify aside', async () => {
  // The exemption is one named scope, not a loosening of the check: anything else extra still fails.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  harness.authTest = () =>
    new Response(JSON.stringify({ ok: true, team_id: 'T0001', user_id: 'U0001' }), {
      headers: { 'x-oauth-scopes': [...scopesForMode('read'), 'identify', 'chat:write'].sort().join(',') },
    });
  const result = await cli(harness, ['--json', 'doctor']);
  const scopes = result
    .json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>()
    .data?.checks.find((check) => check.id === 'scopes');
  assert.equal(scopes?.status, 'fail');
  assert.match(scopes?.detail ?? '', /chat:write/);
  assert.doesNotMatch(scopes?.detail ?? '', /identify/);
});

test('every name the command suggests is one a config made today would accept', async () => {
  const harness = await newHarness();
  // Nothing else on this machine teaches the shape: whatever these two print is what somebody types first.
  const help = await cli(harness, ['--help']);
  assert.match(help.stdout, /workspace add acme\/slack/);
  const missing = await cli(harness, ['workspace', 'add', '--json']);
  assert.equal(missing.code, EXIT_CODES.USAGE);
  assert.match(missing.json<Envelope<never>>().error?.hint ?? '', /workspace add acme\/slack/);
});

test('an agent cannot turn a read workspace into one that can post by removing it and adding it back, unapproved', async () => {
  /*
   * The route the mode-switching design closed: remove a `read` workspace, add it back as `send`. Both halves are now
   * changes a person approves — removing, because a deleted token cannot be taken back; connecting in `send`, because it
   * loosens — so an agent without an approval gets the preview and nothing else, whichever half it tries.
   */
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme' });
  const port = String(await freePort());
  pendingOf(await cli(harness, ['--json', 'workspace', 'remove', 'acme'], { env: { CLAUDECODE: '1' } }));
  assert.equal((await harness.core.config.load()).accounts.acme?.id, account.id, 'removed without an approval');

  // Suppose a person did approve removing it.
  const removal = pendingOf(await cli(harness, ['--json', 'workspace', 'remove', 'acme']));
  const removed = await cli(harness, ['--json', 'workspace', 'remove', 'acme', '--approval', removal.approvalId], {
    env: { CLAUDECODE: '1' },
  });
  assert.equal(removed.code, EXIT_CODES.OK, removed.stdout);

  const add = ['--json', 'workspace', 'add', 'acme', '--mode', 'send', '--client-id', TEST_CLIENT_ID, '--port', port];
  const asAgent = pendingOf(await cli(harness, [...add, '--start'], { env: { CLAUDECODE: '1' } }));
  assert.match(asAgent.preview, /acme mode \(connected by this change\): read → send/);
  assert.match(asAgent.preview, new RegExp(`through the app with Client ID ${TEST_CLIENT_ID.replace('.', '\\.')}`));
  pendingOf(await cli(harness, [...add, '--start']));
  // The removal's approval is spent, and was for a different change: it cannot stand in for this one.
  const borrowed = await cli(harness, [...add, '--start', '--approval', removal.approvalId], {
    env: { CLAUDECODE: '1' },
  });
  assert.equal(borrowed.code, EXIT_CODES.APPROVAL, borrowed.stdout);
  assert.deepEqual(await openFlowStore(harness.core.paths.stateDir, () => new Date()).pending(), [], 'no sign-in');

  // Read mode is still anybody's to connect.
  await startDetached(harness, ['workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', port]);
});

test('a person at a terminal can connect a workspace that can post: the key works, not only the lock', async () => {
  // The consent a claimed approval gives has to reach the classifier, which refuses a new posting workspace without
  // it. Dropping it anywhere would turn "a person must approve this" into "this can never happen".
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const port = await freePort();
  const result = await cli(
    harness,
    [
      'workspace',
      'add',
      'acme',
      '--mode',
      'send',
      '--client-id',
      TEST_CLIENT_ID,
      '--port',
      String(port),
      '--no-browser',
    ],
    { ...browserOn(), tty: true, answerChallenge: true },
  );
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'send');
});

test('workspace mode send without a person, or before the app is updated, starts nothing', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  let exchanges = 0;
  harness.reply = () => {
    exchanges += 1;
    return slackOk({ scopes: scopesForMode('send') });
  };
  const port = String(await freePort());
  // The app step, and nothing else: exit 0, because nothing went wrong — the order is Slack's.
  const appFirst = await cli(harness, ['--json', 'workspace', 'mode', 'acme', 'send', '--port', port]);
  assert.equal(appFirst.code, EXIT_CODES.OK, appFirst.stdout);
  assert.equal(appFirst.json<Envelope<{ appUpdateNeeded: boolean }>>().data?.appUpdateNeeded, true);
  // Then a change a person approves, and without one here nothing is asked of Slack.
  pendingOf(await cli(harness, ['--json', 'workspace', 'mode', 'acme', 'send', '--app-updated', '--port', port]));
  assert.equal(exchanges, 0);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'read');
});

test('a read workspace whose recorded grant already has a posting scope skips the app step', async () => {
  // Slack kept a scope from an app that once was `send`: the grant shows the app offers posting, so there is nothing
  // to ask the person about the app, and the move is a change to approve straight away.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'odd', mode: 'read', grantedScopes: [...scopesForMode('read'), 'chat:write'] });
  const port = String(await freePort());
  pendingOf(await cli(harness, ['--json', 'workspace', 'mode', 'odd', 'send', '--port', port]));
});

test('the command a narrowing refusal prints is one that works', async () => {
  // Slack returns the union: posting scopes on a `read` reauth of a `send` workspace. The hint names a command, and
  // following it must print the procedure rather than fail for a missing port.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'loud', mode: 'send' });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const port = await freePort();
  const refused = await cli(
    harness,
    ['--json', 'workspace', 'reauth', 'loud', '--mode', 'read', '--port', String(port), '--no-browser'],
    browserOn(),
  );
  const hint = refused.json<Envelope<never>>().error?.hint ?? '';
  const printed = /`agent-slack (workspace mode loud read --port \d+)`/.exec(hint)?.[1];
  assert.ok(printed, hint);
  const followed = await cli(harness, ['--json', ...printed.split(' ')]);
  assert.equal(followed.code, EXIT_CODES.OK, followed.stderr);
  assert.match(followed.json<Envelope<{ steps: string[] }>>().data?.steps.join('\n') ?? '', /Remove app/);
});

test('workspace mode send at a terminal widens the workspace it names', async () => {
  // The refusals were tested and this was not — and it could never have worked: without the account's identity the
  // sign-in was an add, which refuses a name already connected.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const port = await freePort();
  const result = await cli(
    harness,
    ['workspace', 'mode', 'acme', 'send', '--app-updated', '--port', String(port), '--no-browser'],
    { ...browserOn(), tty: true, answerChallenge: true },
  );
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  const account = (await harness.core.config.load()).accounts.acme;
  assert.equal(account?.mode, 'send');
  assert.ok(account?.grantedScopes?.includes('chat:write'));
});

test('the command a widening waiting for approval names is one that works as printed', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const port = String(await freePort());
  const refused = await cli(harness, ['--json', 'workspace', 'reauth', 'acme', '--mode', 'send', '--port', port]);
  const { approvalId } = pendingOf(refused);
  const hint = refused.json<Envelope<never>>().error?.hint ?? '';
  const printed = /`agent-slack (workspace reauth [^`]+)`/.exec(hint)?.[1];
  assert.equal(printed, `workspace reauth acme --mode send --port ${port} --approval ${approvalId}`, hint);

  // The person said yes; the command, run exactly as printed, widens the workspace.
  const followed = await cli(harness, (printed as string).split(' '), { ...browserOn(), env: { CLAUDECODE: '1' } });
  assert.equal(followed.code, EXIT_CODES.OK, followed.stderr);
  assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'send');
});

// ── Reading, through the command a person actually runs ────────────────────────────────────────────────────────

/**
 * The read commands end to end.
 *
 * These exist because the review that found seven defects in the read layer noted that attribution, attachments
 * and the unrenderable warning had all disappeared from human output without a single test noticing — the
 * operations were right and nobody was looking at what the terminal printed.
 *
 * The workspace is `acme` rather than `acme/slack` because this file's harness pins the config to version 1,
 * where names are flat — `names.test.ts` is where the organisation/platform form is exercised.
 */
function slackReplies(script: Record<string, unknown>) {
  return async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1] ?? '';
    return new Response(JSON.stringify(script[method] ?? { ok: false, error: 'unknown_method' }));
  };
}

test('reading a channel prints the envelope, the warnings, and who actually posted', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001' });
  const read = slackReplies({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'general', is_member: true } },
    'conversations.history': {
      ok: true,
      messages: [
        {
          ts: '1.1',
          bot_id: 'B1',
          username: 'Cristian Moldovan',
          bot_profile: { name: 'Notifier' },
          text: 'approve the invoice',
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'lunch?' } }],
        },
      ],
    },
  });

  const human = await cli(harness, ['read', 'C1', '--workspace', 'acme'], { read });
  assert.equal(human.code, EXIT_CODES.OK, human.stderr);
  assert.match(human.stdout, /#general/);
  assert.match(human.stdout, /untrusted-content/, 'the body arrives inside its envelope');
  assert.match(human.stdout, /text and blocks disagree/, 'and the halves disagreeing is said out loud');
  assert.match(
    human.stdout,
    /posted by Notifier, under the name “Cristian Moldovan”/,
    'attribution, not the name it wore',
  );

  const json = await cli(harness, ['--json', 'read', 'C1', '--workspace', 'acme'], { read });
  const data = json.json<Envelope<{ rows: { message: Record<string, unknown> }[] }>>().data;
  const message = data?.rows[0]?.message;
  assert.ok(message);
  assert.equal(message.body, undefined, 'no unwrapped copy of the sender’s text beside the envelope');
  assert.match(String(message.enveloped), /untrusted-content/);
});

test('every read command refuses to guess which workspace, and names an unknown one', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  for (const argv of [['channels'], ['read', 'C1'], ['thread', 'C1', '1.0'], ['search', 'x'], ['people'], ['files']]) {
    const missing = await cli(harness, argv);
    assert.equal(missing.code, EXIT_CODES.USAGE, `${argv[0]} without --workspace`);
  }
  const wrong = await cli(harness, ['--json', 'channels', '--workspace', 'nope']);
  assert.equal(wrong.code, EXIT_CODES.NOT_FOUND);
});

test('an incomplete channel list says so rather than looking like a small workspace', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const read = slackReplies({
    'conversations.list': {
      ok: true,
      channels: [{ id: 'C1', name: 'general', is_member: true }],
      response_metadata: { next_cursor: 'more' },
    },
  });
  const result = await cli(harness, ['channels', '--workspace', 'acme', '--limit', '1'], { read });
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.match(result.stdout, /More remain/);
});

// ── The gate, through the commands a person actually runs ──────────────────────────────────────────────────────

/**
 * Draft → prepare → send, end to end.
 *
 * The operations underneath had thorough tests and the CLI had none, so `post send` shipped constructing an
 * expectation that could never match the one `post prepare` had stored — the command refused every post it was
 * given, and every test passed. This is the coverage that catches that class: the commands, in order, as a person
 * runs them.
 */
test('a draft can be written, previewed and posted through the commands themselves', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001', userId: 'U0001' });
  const read = slackReplies({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'general', num_members: 4, is_member: true } },
    'chat.postMessage': { ok: true, ts: '1700000000.000100' },
  });

  const written = await cli(
    harness,
    ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--text', 'ready when you are'],
    { read },
  );
  assert.equal(written.code, EXIT_CODES.OK, written.stderr);
  const draftId = written.json<Envelope<{ draftId: string }>>().data?.draftId;
  assert.ok(draftId, 'the draft was written');

  const prepared = await cli(
    harness,
    ['--json', 'post', 'prepare', '--workspace', 'acme', '--draft', String(draftId)],
    { read },
  );
  assert.equal(prepared.code, EXIT_CODES.OK, prepared.stderr);
  const approvalId = prepared.json<Envelope<{ approvalId: string }>>().data?.approvalId;
  assert.ok(approvalId);

  const posted = await cli(
    harness,
    [
      '--json',
      'post',
      'send',
      '--workspace',
      'acme',
      '--draft',
      String(draftId),
      '--approval',
      String(approvalId),
      '--expect-channel',
      'C1',
    ],
    { read },
  );
  assert.equal(posted.code, EXIT_CODES.OK, posted.stderr);
  assert.equal(posted.json<Envelope<{ ts: string }>>().data?.ts, '1700000000.000100');
});

test('posting to a channel the caller did not expect is refused before anything is sent', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001', userId: 'U0001' });
  let posts = 0;
  const read = async (input: string | URL | Request, _init?: RequestInit) => {
    const method = String(input instanceof Request ? input.url : input).split('/api/')[1] ?? '';
    if (method === 'chat.postMessage') posts += 1;
    return new Response(
      JSON.stringify(
        method === 'conversations.info'
          ? { ok: true, channel: { id: 'C1', name: 'general', num_members: 4, is_member: true } }
          : { ok: true, ts: '1.1' },
      ),
    );
  };

  const written = await cli(
    harness,
    ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--text', 'hello'],
    { read },
  );
  const draftId = written.json<Envelope<{ draftId: string }>>().data?.draftId;
  const prepared = await cli(
    harness,
    ['--json', 'post', 'prepare', '--workspace', 'acme', '--draft', String(draftId)],
    { read },
  );
  const approvalId = prepared.json<Envelope<{ approvalId: string }>>().data?.approvalId;

  const wrong = await cli(
    harness,
    [
      '--json',
      'post',
      'send',
      '--workspace',
      'acme',
      '--draft',
      String(draftId),
      '--approval',
      String(approvalId),
      '--expect-channel',
      'C_SOMEWHERE_ELSE',
    ],
    { read },
  );
  assert.notEqual(wrong.code, EXIT_CODES.OK);
  assert.equal(posts, 0, 'nothing reached Slack');
});

test('approving is refused to an agent, and needs a terminal', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const asAgent = await cli(harness, ['--json', 'approve', 'ap_00000000000000000000000000'], {
    env: { CLAUDECODE: '1' },
  });
  assert.equal(asAgent.code, EXIT_CODES.APPROVAL);
  assert.match(asAgent.stdout + asAgent.stderr, /only a person can approve/);

  // Before the id is looked up: an id that is not even well formed still tells an agent to hand it to a person,
  // rather than a usage error it would try to repair.
  const malformed = await cli(harness, ['--json', 'approve', 'ap_whatever'], { env: { CLAUDECODE: '1' } });
  assert.equal(malformed.code, EXIT_CODES.APPROVAL, malformed.stdout);
  assert.match(malformed.stdout + malformed.stderr, /their own terminal/);

  const piped = await cli(harness, ['--json', 'approve', 'ap_whatever']);
  assert.equal(piped.code, EXIT_CODES.APPROVAL, piped.stdout);
  assert.match(piped.stdout + piped.stderr, /interactive terminal/);
});

test('one workspace cannot prepare or post another’s draft', async () => {
  // Drafts share one directory keyed by id. Without a check, naming workspace A reaches workspace B's draft —
  // and on two workspaces of one organisation, which share channel ids, Slack would not refuse it either.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001', userId: 'U0001' });
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002', userId: 'U0002' });
  const read = slackReplies({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'general', num_members: 4, is_member: true } },
  });

  const written = await cli(
    harness,
    ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--text', 'internal'],
    { read },
  );
  const draftId = String(written.json<Envelope<{ draftId: string }>>().data?.draftId);

  const stolen = await cli(harness, ['--json', 'post', 'prepare', '--workspace', 'zeta', '--draft', draftId], { read });
  assert.equal(stolen.code, EXIT_CODES.NOT_FOUND);
  assert.match(JSON.stringify(stolen.json<Envelope<never>>()), /no draft/);
});

/** The long options a command's `--help` lists, which is what Commander actually defined for it. */
async function optionsOf(harness: Harness, argv: string[]): Promise<Set<string>> {
  const help = await cli(harness, [...argv, '--help']);
  return new Set([...help.stdout.matchAll(/^ {2}(?:-\w, )?(--[\w-]+)/gm)].map((match) => match[1] ?? ''));
}

test('every option `mcp` and `mcp install` both define reaches the registered entry, wherever it is typed', async () => {
  /*
   * Commander gives an option name defined on both a command and its subcommand to the *parent*. Gmail lost
   * `--inbox` and then `--read-only` to it, one at a time. This walks the options as Commander defines them, so
   * a new shared option fails here until it is handled and listed.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const parent = await optionsOf(harness, ['mcp']);
  const child = await optionsOf(harness, ['mcp', 'install']);
  const shared = [...parent].filter((option) => child.has(option) && option !== '--help');

  const expected: Record<string, { value?: string; inEntry: string[] }> = {
    '--workspace': { value: 'acme', inEntry: ['--workspace', 'acme'] },
  };
  assert.deepEqual(shared.sort(), Object.keys(expected).sort(), 'a shared option this test does not know about');

  for (const option of shared) {
    const typed = [option, ...(expected[option]?.value ? [expected[option].value] : [])];
    const install = ['--client', 'json', '--launcher', 'local', '--no-verify'];
    for (const argv of [
      ['mcp', 'install', ...typed, ...install],
      ['mcp', ...typed, 'install', ...install],
    ]) {
      const result = await cli(harness, ['--json', ...argv]);
      assert.equal(result.code, EXIT_CODES.OK, `${argv.join(' ')}: ${result.stdout}${result.stderr}`);
      const args = result.json<Envelope<{ entry: { args: string[] } }>>().data?.entry.args ?? [];
      const want = expected[option]?.inEntry ?? [];
      const at = args.indexOf(want[0] ?? '');
      assert.ok(
        at >= 0 && want.every((part, index) => args[at + index] === part),
        `${argv.join(' ')} → ${args.join(' ')}`,
      );
    }
  }
});

test("mcp install names its client, and exits non-zero when that client's CLI is missing", async () => {
  const harness = await newHarness();
  // No silent default: writing into a configuration nobody named is the thing to ask about.
  const unnamed = await cli(harness, ['--json', 'mcp', 'install', '--launcher', 'local', '--no-verify']);
  assert.equal(unnamed.code, EXIT_CODES.USAGE);

  const missing = await cli(
    harness,
    ['--json', 'mcp', 'install', '--client', 'claude-code', '--launcher', 'local', '--no-verify'],
    { env: { HOME: tempDir(), PATH: tempDir() } },
  );
  assert.equal(missing.code, EXIT_CODES.UNAVAILABLE, missing.stdout);
});

test(
  'mcp install says an entry that does not start failed, and exits non-zero',
  process.platform === 'win32' ? { skip: 'the stand-in npx is a shell script' } : {},
  async () => {
    // An `npx` that exits at once, as 0.4.0's entry did without `mcp`: the check runs, and fails.
    const harness = await newHarness();
    const bin = tempDir();
    await writeFile(join(bin, 'npx'), '#!/bin/sh\nexit 3\n');
    await chmod(join(bin, 'npx'), 0o755);
    const env = { HOME: tempDir(), PATH: bin };
    const argv = ['mcp', 'install', '--client', 'json', '--launcher', 'npx'];

    const json = await cli(harness, ['--json', ...argv], { env });
    assert.equal(json.code, EXIT_CODES.UNAVAILABLE, json.stdout);
    assert.equal(json.json<Envelope<{ verification: string }>>().data?.verification, 'failed');
    const text = await cli(harness, argv, { env });
    assert.equal(text.code, EXIT_CODES.UNAVAILABLE);
    assert.match(text.stdout, /Failed to start: /);
  },
);

test('`mcp install --workspace` actually pins the registered server', async () => {
  /*
   * `mcp` and `mcp install` both take `--workspace`, and Commander gives a repeated name to the parent — so the
   * subcommand's own option was always undefined and the pin was silently dropped. A server meant to reach one
   * workspace was registered reaching every one on the machine, which is the opposite of what the flag is for.
   * The Gmail package shipped the same bug at 0.4.0.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const result = await cli(harness, [
    '--json',
    'mcp',
    'install',
    '--client',
    'json',
    '--launcher',
    'local',
    '--workspace',
    'acme',
    '--no-verify',
  ]);
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  const args = result.json<Envelope<{ entry: { args: string[] } }>>().data?.entry.args ?? [];
  assert.ok(args.includes('--workspace'), `the pin reached the entry: ${args.join(' ')}`);
  assert.equal(args[args.indexOf('--workspace') + 1], 'acme');
});

test('`mcp install` refuses a workspace that does not exist, before writing anything', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const result = await cli(harness, [
    '--json',
    'mcp',
    'install',
    '--client',
    'json',
    '--launcher',
    'local',
    '--workspace',
    'nope',
    '--no-verify',
  ]);
  assert.equal(result.code, EXIT_CODES.NOT_FOUND);
});
