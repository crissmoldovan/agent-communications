import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { buildManifest } from '../src/manifest.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type FakeSlack, startFakeSlack } from './support/fake-slack.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * `agent-slack app update` and `app create`: changing the Slack app itself with an app configuration token.
 *
 * That token can rewrite every app its owner has, so most of what is tested here is about where it goes and where it
 * does not. It rides on the configuration calls, in the Authorization header, and nowhere else: not in the output,
 * not in an error, not in any file under the configuration directory, not on a command line, and not through any
 * MCP tool. And `apps.manifest.validate` goes first, so a manifest Slack refuses changes nothing.
 *
 * Every request goes to a loopback fake Slack through the real guard; nothing here reaches slack.com.
 */

/** A placeholder-shaped value, so the repository's secret scan reads it as the fixture it is. */
const TOKEN = 'fake-config-token-5d1e4b93';
/** Its distinctive tail, so a token cut short or wrapped still counts as leaked. */
const TAIL = '5d1e4b93';

const CLIENT_SECRET = 'fake-client-secret-77aa11';
const VERIFICATION = 'fake-verification-token-88bb22';
const SIGNING = 'fake-signing-secret-99cc33';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  json: <T>() => Envelope<T>;
}

let fakes: FakeSlack[] = [];
afterEach(async () => {
  const started = fakes;
  fakes = [];
  await Promise.all(started.map((fake) => fake.close()));
});

/** A fake Slack that validates, updates and creates successfully unless a test says otherwise. */
async function slack(over: Partial<FakeSlack['script']> = {}): Promise<FakeSlack> {
  const fake = await startFakeSlack({
    'apps.manifest.validate': () => ({ ok: true, errors: [] }),
    'apps.manifest.update': (request) => ({
      ok: true,
      app_id: request.params.get('app_id'),
      permissions_updated: true,
    }),
    'apps.manifest.create': () => ({
      ok: true,
      app_id: 'A0NEWAPP1',
      credentials: {
        client_id: '1111111111.2222222222',
        client_secret: CLIENT_SECRET,
        verification_token: VERIFICATION,
        signing_secret: SIGNING,
      },
      oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=1111111111.2222222222',
    }),
    ...over,
  } as FakeSlack['script']);
  fakes.push(fake);
  return fake;
}

/** A fetch that fails the test if anything reaches it: for commands that must refuse before any request. */
const unreachable = async (): Promise<Response> => {
  throw new Error('this command reached Slack when it should have refused first');
};

async function cli(
  harness: Harness,
  argv: string[],
  options: {
    fake?: FakeSlack;
    appConfig?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    tty?: boolean;
    env?: NodeJS.ProcessEnv;
    /** Typed at the hidden prompt, the way a person would, once it is asked. */
    type?: string;
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
  let typed = false;
  err.on('data', (chunk) => {
    stderr += String(chunk);
    if (options.type !== undefined && !typed && stderr.includes('App configuration token')) {
      typed = true;
      input.write(`${options.type}\r`);
    }
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
    probe: (probeInput, init) => harness.probe(probeInput, init),
    read: unreachable,
    appConfig: options.appConfig ?? options.fake?.fetch ?? unreachable,
  });
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as Envelope<T> };
}

/** Every file under the harness's configuration directory — config, state, audit, secrets — as text. */
async function everyFile(root: string): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found.push({ path: relative(root, path), text: await readFile(path, 'utf8') });
  }
  return found;
}

/** The token, or any recognisable piece of it, nowhere in what the command printed or left behind. */
async function assertNoToken(harness: Harness, result: Captured, secrets: readonly string[] = [TOKEN, TAIL]) {
  for (const secret of secrets) {
    assert.ok(!result.stdout.includes(secret), `stdout carries ${secret}`);
    assert.ok(!result.stderr.includes(secret), `stderr carries ${secret}`);
    for (const file of await everyFile(harness.configDir)) {
      assert.ok(!file.text.includes(secret), `${file.path} carries ${secret}`);
    }
  }
}

async function auditLines(harness: Harness): Promise<Record<string, unknown>[]> {
  const directory = join(harness.core.paths.stateDir, 'audit');
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const lines: Record<string, unknown>[] = [];
  for (const name of names) {
    for (const line of (await readFile(join(directory, name), 'utf8')).split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return lines;
}

const configText = (harness: Harness) => readFile(join(harness.configDir, 'config.json'), 'utf8');

// ── app update ────────────────────────────────────────────────────────────────────────────────────────────────

test('app update validates first, then updates the recorded app, with the configuration token and no other', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read', appId: 'A0001', redirectPort: 51234 });
  const fake = await slack();
  const before = await configText(harness);

  const result = await cli(harness, ['--json', 'app', 'update', 'acme', '--mode', 'send', '--port', '51234'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.OK, result.stdout + result.stderr);

  // Validation first, and exactly one of each.
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['apps.manifest.validate', 'apps.manifest.update'],
  );
  const manifest = buildManifest('send', 'http://localhost:51234/slack/callback');
  for (const request of fake.requests) {
    // The configuration token, in the header Slack prefers, and never in the URL, which Slack refuses and logs keep.
    assert.equal(request.authorization, `Bearer ${TOKEN}`);
    assert.ok(!request.url.includes(TOKEN), 'the token went out in the URL');
    assert.equal(request.params.get('app_id'), 'A0001');
    assert.deepEqual(JSON.parse(request.params.get('manifest') ?? 'null'), manifest);
    // The workspace's own credential is not on any of these requests, in any form.
    assert.ok(!request.raw.includes('fake-user-token-0'), 'the workspace token rode on a configuration call');
    assert.ok(!request.raw.includes('fake-refresh-token-0'), 'the refresh token rode on a configuration call');
  }

  const data = result.json<Record<string, unknown>>().data;
  assert.equal(data?.appId, 'A0001');
  assert.equal(data?.tokenChanged, false);
  assert.equal(data?.workspaceMode, 'read');
  assert.equal(data?.permissionsUpdated, true);
  assert.equal(data?.manifestPage, 'https://api.slack.com/apps/A0001/app-manifest');
  // The app is updated now, so the next step says so: without `--app-updated` the move would hand back the app step.
  assert.match(
    String((data?.next as string[] | undefined)?.[0]),
    /agent-slack workspace mode acme send --app-updated --port 51234/,
  );

  // Nothing local changed: the workspace's mode and port describe its token and its last sign-in, and neither moved.
  assert.equal(await configText(harness), before);
  await assertNoToken(harness, result);
});

test('updating an app to send says it changes no token, and names the sign-in that would', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read', redirectPort: 51234 });
  const fake = await slack();

  const result = await cli(harness, ['app', 'update', 'acme', '--mode', 'send', '--port', '51234'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.match(result.stdout, /not what any token already issued can do: "acme" is still in read mode/);
  assert.match(result.stdout, /agent-slack workspace mode acme send --app-updated --port 51234/);
  // Said before the token is taken, because Slack's update replaces the app's name and description too.
  assert.match(result.stderr, /replaces the whole configuration of Slack app A0001/);
  await assertNoToken(harness, result);
});

test('updating a send workspace’s app to read leaves the two steps only a person can take', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', redirectPort: 51234 });
  const fake = await slack();

  const result = await cli(harness, ['--json', 'app', 'update', 'acme', '--mode', 'read'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.OK, result.stdout);
  const next = (result.json<{ next: string[] }>().data?.next ?? []).join('\n');
  // The app step is done; what remains is removing the installation in Slack, then a narrowing reauth.
  assert.match(next, /Remove app/);
  assert.match(next, /agent-slack workspace reauth acme --mode read --port 51234/);
  assert.doesNotMatch(next, /App Manifest/, 'the step just done is not listed again');
});

test('with no --mode and no --port, the workspace’s own mode and recorded port are used', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', redirectPort: 50999 });
  const fake = await slack();

  const result = await cli(harness, ['--json', 'app', 'update', 'acme'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.OK, result.stdout);
  const sent = JSON.parse(fake.requests[1]?.params.get('manifest') ?? 'null');
  assert.deepEqual(sent, buildManifest('send', 'http://localhost:50999/slack/callback'));
  assert.deepEqual(result.json<{ next: string[] }>().data?.next, [], 'same mode, same port: nothing left to do');
});

test('a manifest Slack refuses changes nothing: no update is sent, and Slack’s reasons are shown', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read', redirectPort: 51234 });
  const fake = await slack({
    'apps.manifest.validate': () => ({
      ok: false,
      error: 'invalid_manifest',
      errors: [{ message: 'Redirect URL is not allowed', pointer: '/oauth_config/redirect_urls/0' }],
    }),
  });
  const before = await configText(harness);

  const result = await cli(harness, ['--json', 'app', 'update', 'acme', '--mode', 'send', '--port', '51234'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.BAD_DATA, result.stdout);
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['apps.manifest.validate'],
    'the update went out after a refused validation',
  );
  const error = result.json<never>().error;
  assert.equal(error?.code, 'BAD_DATA');
  assert.match(String(error?.message), /nothing was changed/);
  assert.match(String(error?.hint), /\/oauth_config\/redirect_urls\/0: Redirect URL is not allowed/);
  assert.equal(await configText(harness), before);

  const audit = (await auditLines(harness)).filter((line) => line.operation === 'slack.app.update');
  assert.deepEqual(
    audit.map((line) => line.outcome),
    ['refused'],
  );
  await assertNoToken(harness, result);
});

test('a validation that says ok but still lists problems is a refusal, not a pass', async () => {
  // "Valid, but" is not a state to write an app from. Slack's documented success lists no errors at all.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 51234 });
  const fake = await slack({
    'apps.manifest.validate': () => ({ ok: true, errors: [{ message: 'odd', pointer: '/settings' }] }),
  });
  const result = await cli(harness, ['--json', 'app', 'update', 'acme'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.BAD_DATA, result.stdout);
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['apps.manifest.validate'],
  );
});

test('at a terminal the token is read from a hidden prompt, and what is typed is never echoed', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read', redirectPort: 51234 });
  const fake = await slack();

  const result = await cli(harness, ['app', 'update', 'acme', '--mode', 'send', '--port', '51234'], {
    fake,
    tty: true,
    type: TOKEN,
  });
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.match(result.stderr, /App configuration token/);
  assert.match(result.stderr, /not shown as you type/);
  assert.equal(fake.requests.length, 2);
  for (const request of fake.requests) assert.equal(request.authorization, `Bearer ${TOKEN}`);
  await assertNoToken(harness, result);
});

test('without a terminal and without SLACK_APP_CONFIG_TOKEN it refuses before asking Slack anything', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 51234 });

  for (const argv of [
    ['--json', 'app', 'update', 'acme', '--mode', 'send'],
    ['--json', 'app', 'create', '--port', '51234'],
  ]) {
    const result = await cli(harness, argv, { appConfig: unreachable });
    assert.equal(result.code, EXIT_CODES.AUTH, `${argv.join(' ')}: ${result.stdout}`);
    const error = result.json<never>().error;
    assert.match(String(error?.message), /no terminal to ask for it/);
    assert.match(String(error?.hint), /SLACK_APP_CONFIG_TOKEN/);
    // Addressed to whoever reads it, an agent included: the token is not something to ask for in a chat.
    assert.match(String(error?.hint), /Never paste the token into a chat/);
  }

  // `--json` at a terminal is not a terminal to prompt at either, as for every other prompt in this CLI.
  const json = await cli(harness, ['--json', 'app', 'update', 'acme'], { tty: true, appConfig: unreachable });
  assert.equal(json.code, EXIT_CODES.AUTH, json.stdout);
});

test('the token is never taken from the command line, and an attempt is not quoted back', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 51234 });

  for (const argv of [
    ['app', 'update', 'acme', `--token=${TOKEN}`],
    ['--json', 'app', 'update', 'acme', `--token=${TOKEN}`],
    ['app', 'update', 'acme', '--token', TOKEN],
    ['app', 'create', '--port', '51234', `--config-token=${TOKEN}`],
  ]) {
    const result = await cli(harness, argv, { appConfig: unreachable });
    assert.equal(result.code, EXIT_CODES.USAGE, argv.join(' '));
    await assertNoToken(harness, result);
  }

  // And no option of either command is one a token could be passed through.
  for (const command of ['update', 'create']) {
    const help = await cli(harness, ['app', command, '--help']);
    assert.doesNotMatch(help.stdout, /--\S*token/i, `app ${command} has an option for a token`);
  }
});

test('a token with spaces or a line break is refused before any request, without quoting it', async () => {
  // `fetch` rejects a header value with a line break, and its error quotes the value; this refuses first.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 51234 });
  for (const bad of [`${TOKEN} extra`, `${TOKEN}\nx-evil: 1`]) {
    const result = await cli(harness, ['--json', 'app', 'update', 'acme'], {
      appConfig: unreachable,
      env: { SLACK_APP_CONFIG_TOKEN: bad },
    });
    assert.equal(result.code, EXIT_CODES.USAGE, result.stdout);
    await assertNoToken(harness, result);
  }
});

test('an error from under the transport that quotes the token has it taken out before it is shown', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 51234 });
  const leaky = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const sent = new Headers(init?.headers).get('authorization') ?? '';
    throw new TypeError(`connect ECONNREFUSED while sending ${sent}`);
  };
  for (const flags of [['--json'], []]) {
    const result = await cli(harness, [...flags, 'app', 'update', 'acme'], {
      appConfig: leaky,
      env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
    });
    assert.equal(result.code, EXIT_CODES.TRANSIENT, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /\[the configuration token\]/, 'the scrub ran where the token was');
    await assertNoToken(harness, result);
  }
});

test('Slack refusing the token is explained as a configuration token, not a workspace sign-in', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 51234 });
  const cases: [string, number, RegExp][] = [
    ['token_expired', EXIT_CODES.AUTH, /twelve hours/],
    ['invalid_auth', EXIT_CODES.AUTH, /Your App Configuration Tokens/],
    ['missing_scope', EXIT_CODES.AUTH, /sign-in token cannot change an app/],
    ['app_not_found', EXIT_CODES.NOT_FOUND, /workspace the app lives in/],
  ];
  for (const [slackError, exit, hint] of cases) {
    const fake = await slack({ 'apps.manifest.validate': () => ({ ok: false, error: slackError }) });
    const result = await cli(harness, ['--json', 'app', 'update', 'acme'], {
      fake,
      env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
    });
    assert.equal(result.code, exit, `${slackError}: ${result.stdout}`);
    assert.match(String(result.json<never>().error?.hint), hint, slackError);
    assert.doesNotMatch(result.stdout, /workspace reauth/, 'a config token is not renewed by signing in again');
    assert.deepEqual(
      fake.requests.map((request) => request.method),
      ['apps.manifest.validate'],
    );
    await assertNoToken(harness, result);
  }
});

test('a workspace that does not record its app is refused before the token is asked for', async () => {
  // No terminal and no variable: had it asked for the token first, this would be AUTH, not CONFIG.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 51234 });
  // A record from before the app id was kept: the same account, with the key simply absent.
  await harness.core.config.update((current) => {
    const { appId: _dropped, ...rest } = current.accounts.acme as NonNullable<(typeof current.accounts)['acme']>;
    return { ...current, accounts: { ...current.accounts, acme: rest } };
  });

  const result = await cli(harness, ['--json', 'app', 'update', 'acme'], { appConfig: unreachable });
  assert.equal(result.code, EXIT_CODES.CONFIG, result.stdout);
  assert.match(String(result.json<never>().error?.hint), /workspace reauth acme/);
});

test('the audit trail records the update, and never the token', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 51234 });
  const fake = await slack();
  const result = await cli(harness, ['app', 'update', 'acme', '--mode', 'send'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  const lines = (await auditLines(harness)).filter((line) => line.operation === 'slack.app.update');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.outcome, 'ok');
  assert.deepEqual(lines[0]?.ids, { appId: 'A0001', mode: 'send' });
  assert.equal(lines[0]?.surface, 'cli');
  await assertNoToken(harness, result);
});

// ── app create ────────────────────────────────────────────────────────────────────────────────────────────────

test('app create validates, creates, and prints the app id, the Client ID and the next command — never a secret', async () => {
  const harness = await newHarness();
  const fake = await slack();
  const before = await configText(harness);

  const result = await cli(harness, ['app', 'create', 'zeta', '--mode', 'send', '--port', '51234'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['apps.manifest.validate', 'apps.manifest.create'],
  );
  for (const request of fake.requests) {
    assert.equal(request.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.params.get('app_id'), null, 'a new app has no id to validate against');
    assert.deepEqual(
      JSON.parse(request.params.get('manifest') ?? 'null'),
      buildManifest('send', 'http://localhost:51234/slack/callback'),
    );
  }
  assert.match(result.stdout, /A0NEWAPP1/);
  assert.match(result.stdout, /1111111111\.2222222222/);
  assert.match(
    result.stdout,
    /agent-slack workspace add zeta --client-id 1111111111\.2222222222 --port 51234 --mode send/,
  );
  assert.match(result.stdout, /client_secret, signing_secret, verification_token\. None was kept or shown/);
  assert.equal(await configText(harness), before, 'creating an app connects nothing');
  await assertNoToken(harness, result, [TOKEN, TAIL, CLIENT_SECRET, VERIFICATION, SIGNING]);
});

test('app create under --json returns the ids and the names of what it dropped, not their values', async () => {
  const harness = await newHarness();
  const fake = await slack();
  const result = await cli(harness, ['--json', 'app', 'create', '--port', '51234'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.OK, result.stdout);
  const data = result.json<Record<string, unknown>>().data;
  assert.equal(data?.appId, 'A0NEWAPP1');
  assert.equal(data?.clientId, '1111111111.2222222222');
  assert.equal(data?.mode, 'read');
  assert.deepEqual(data?.secretsDiscarded, ['client_secret', 'signing_secret', 'verification_token']);
  assert.equal(data?.next, 'agent-slack workspace add <name> --client-id 1111111111.2222222222 --port 51234');
  assert.deepEqual(Object.keys(data ?? {}).sort(), [
    'appId',
    'clientId',
    'manifestPage',
    'mode',
    'next',
    'port',
    'redirectUrl',
    'secretsDiscarded',
  ]);
  await assertNoToken(harness, result, [TOKEN, TAIL, CLIENT_SECRET, VERIFICATION, SIGNING]);
});

test('a refused validation creates no app', async () => {
  const harness = await newHarness();
  const fake = await slack({
    'apps.manifest.validate': () => ({ ok: false, error: 'invalid_manifest', errors: [{ message: 'no' }] }),
  });
  const result = await cli(harness, ['--json', 'app', 'create', '--port', '51234'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.BAD_DATA, result.stdout);
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['apps.manifest.validate'],
  );
});

test('app create refuses a name that is already connected before asking for a token', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const result = await cli(harness, ['--json', 'app', 'create', 'acme', '--port', '51234'], {
    appConfig: unreachable,
  });
  assert.notEqual(result.code, EXIT_CODES.OK);
  assert.notEqual(result.code, EXIT_CODES.AUTH, 'it asked for a token for a command that could not succeed');
});

test('a create whose reply has no Client ID names the app it made, so nobody makes a second', async () => {
  const harness = await newHarness();
  const fake = await slack({
    'apps.manifest.create': () => ({ ok: true, app_id: 'A0NEWAPP2', credentials: { client_secret: CLIENT_SECRET } }),
  });
  const result = await cli(harness, ['--json', 'app', 'create', '--port', '51234'], {
    fake,
    env: { SLACK_APP_CONFIG_TOKEN: TOKEN },
  });
  assert.equal(result.code, EXIT_CODES.UNAVAILABLE, result.stdout);
  const error = result.json<never>().error;
  assert.match(String(error?.message), /A0NEWAPP2/);
  assert.match(String(error?.hint), /Do not create another app/);
  await assertNoToken(harness, result, [TOKEN, TAIL, CLIENT_SECRET]);
});

// ── Where the token cannot go ─────────────────────────────────────────────────────────────────────────────────

/** Every source file of this package, as a path relative to `src` with forward slashes, and its text. */
async function sources(): Promise<{ path: string; text: string }[]> {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  return (await everyFile(root))
    .filter((file) => file.path.endsWith('.ts'))
    .map((file) => ({ path: file.path.split(sep).join('/'), text: file.text }));
}

test('only the app operation opens a configuration grant, and only the CLI reaches the app operation', async () => {
  /*
   * The configuration methods are on the allowlist, which is why this has to hold: the guard lets one through inside
   * a grant, so the question is who can open one. One module, reached from one command. If an MCP tool, a read
   * session or anything else imports either, a configuration token or a workspace token could reach a call that
   * rewrites an app.
   */
  const files = await sources();
  const grants = files.filter(
    (file) => file.path !== 'api/guard.ts' && /^import [^;]*\bconfigureWith\b[^;]*;/m.test(file.text),
  );
  assert.deepEqual(
    grants.map((file) => file.path),
    ['operations/app.ts'],
  );

  const valueImport = /^import (?!type\b)[^;]*?from '(?:\.\.\/operations\/|\.\/)app\.ts';/m;
  assert.deepEqual(
    files.filter((file) => valueImport.test(file.text)).map((file) => file.path),
    ['cli/program.ts'],
  );

  const tokenReaders = files.filter(
    (file) => file.path !== 'cli/config-token.ts' && /config-token\.ts'/.test(file.text),
  );
  assert.deepEqual(
    tokenReaders.map((file) => file.path),
    ['cli/program.ts'],
  );
  for (const file of files.filter((entry) => entry.path.startsWith('mcp/'))) {
    assert.doesNotMatch(file.text, /SLACK_APP_CONFIG_TOKEN|apps\.manifest\.|configureWith/, file.path);
  }
});

test('no MCP tool changes an app or takes a token', async () => {
  const harness = await newHarness();
  const { server } = await createSlackMcpServer({ core: harness.core, env: harness.env, fetch: unreachable });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    for (const tool of (await client.listTools()).tools) {
      assert.doesNotMatch(tool.name, /app_(update|create)|config/i, tool.name);
      const properties = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      for (const property of properties) assert.doesNotMatch(property, /token|secret/i, `${tool.name}.${property}`);
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
