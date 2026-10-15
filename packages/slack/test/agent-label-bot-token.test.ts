import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { EXIT_CODES } from '@agentcomms/core';
import { parseBundle } from '../src/auth/bundle.ts';
import { run } from '../src/cli/program.ts';
import { prepareDraftPost } from '../src/operations/post.ts';
import { botSecretRefFor } from '../src/operations/workspaces.ts';
import { type FakeSlack, type SlackRequest, startFakeSlack } from './support/fake-slack.ts';
import { slackHandoffs } from './support/handoffs.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * Pasting the send app's bot token once (design 2026-10-15 S1, revised): `workspace bot <workspace>`, at a person's
 * terminal only. The PKCE sign-in cannot ask Slack for bot scopes, so the token is copied from the app's own page — and
 * checked with Slack before anything keeps it: a bot token, of this workspace's team, with exactly the four posting
 * scopes, and one that does not rotate. Nothing here reaches Slack: `auth.test` is the fake's.
 */

const PASTED = 'xoxb-fake-good-0001';
const OTHER_TEAM = 'xoxb-fake-otherteam-0001';
const WIDE = 'xoxb-fake-wide-0001';
const ROTATING = 'xoxe.xoxb-fake-rotating-0001';
const USER = 'xoxp-fake-user-0001';
const FOUR = 'chat:write,chat:write.customize,chat:write.public,reactions:write';

/** `auth.test` as Slack answers each pasted value: the team, the bot user, and the scopes in the header. */
function authTest(request: SlackRequest): unknown {
  const bearer = request.authorization?.replace(/^Bearer /, '');
  const bot = { ok: true, team_id: 'T0001', user_id: 'U0BOT0001', bot_id: 'B0BOT0001' };
  if (bearer === PASTED) return { status: 200, headers: { 'x-oauth-scopes': FOUR }, body: bot };
  if (bearer === OTHER_TEAM) {
    return { status: 200, headers: { 'x-oauth-scopes': FOUR }, body: { ...bot, team_id: 'T0OTHER' } };
  }
  if (bearer === WIDE) {
    return { status: 200, headers: { 'x-oauth-scopes': `${FOUR},channels:history` }, body: bot };
  }
  return { ok: false, error: 'invalid_auth' };
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function world(t: TestContext, mode: 'read' | 'send' = 'send') {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme', mode, identity: 'agent' });
  const fake = await startFakeSlack();
  t.after(() => fake.close());
  fake.world({
    users: { U0001: { real_name: 'Jo Example' }, U0BOT0001: { real_name: 'Acme Agent', is_bot: true } },
    rooms: { C1: { name: 'eng', members: ['U0001'] } },
  });
  fake.script['auth.test'] = authTest;
  return { harness, fake, accountId: account.id };
}

/** The Slack CLI, with what a person types at its hidden prompt once it asks. */
async function cli(
  harness: Harness,
  fake: FakeSlack,
  argv: string[],
  options: { tty?: boolean; type?: string; env?: NodeJS.ProcessEnv } = {},
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
    if (options.type !== undefined && !typed && stderr.includes('Bot User OAuth Token')) {
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
    read: fake.fetch,
    platform: 'darwin',
  });
  return { code, stdout, stderr };
}

/** What the command said: its error goes to stderr, its result to stdout. */
const said = (result: Captured): string => `${result.stdout}\n${result.stderr}`;

const asked = (fake: FakeSlack, method: string) => fake.requests.filter((request) => request.method === method);

/** Nothing the command printed or left on disk outside the secret store holds the pasted value. */
async function assertNotPrinted(harness: Harness, result: Captured, value: string) {
  assert.equal(result.stdout.includes(value), false, 'the token was printed');
  assert.equal(result.stderr.includes(value), false, 'the token was echoed');
  for (const entry of await readdir(harness.configDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name.endsWith('.secrets.json') || entry.parentPath.includes('secrets')) continue;
    const text = await readFile(join(entry.parentPath, entry.name), 'utf8');
    assert.equal(text.includes(value), false, `${entry.name} holds the token`);
  }
}

test('a pasted bot token is checked with Slack and kept under slack/bot-token/<accountId>, and posts go as the app', async (t) => {
  const w = await world(t);
  const result = await cli(w.harness, w.fake, ['workspace', 'bot', 'acme'], { tty: true, type: PASTED });
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  // Checked through the guard, with the pasted token and nothing else.
  const [checked, ...more] = asked(w.fake, 'auth.test');
  assert.equal(more.length, 0);
  assert.equal(checked?.authorization, `Bearer ${PASTED}`);
  const account = (await w.harness.core.config.load()).accounts.acme as unknown as Record<string, unknown>;
  assert.equal(account.botUserId, 'U0BOT0001', 'auth.test’s user_id is the bot user the app posts as');
  const secrets = await w.harness.core.secrets('file');
  assert.equal(parseBundle(await secrets.get(botSecretRefFor(w.accountId)), slackHandoffs())?.accessToken, PASTED);
  await assertNotPrinted(w.harness, result, PASTED);
  // And the gate now routes an agent's post in a public channel to the app.
  const context = w.harness.context({ platform: 'darwin' });
  const prepared = await prepareDraftPost(context, 'acme', { channel: 'C1', text: 'hello' }, { fetch: w.fake.fetch });
  assert.equal(prepared.label?.route, 'app');
  // Removing the workspace deletes it, as `agent-label-signin.test.ts` shows for a bot token however it came.
});

test('a bot token of another workspace’s team is refused, and nothing is kept', async (t) => {
  const w = await world(t);
  const result = await cli(w.harness, w.fake, ['workspace', 'bot', 'acme'], { tty: true, type: OTHER_TEAM });
  assert.notEqual(result.code, EXIT_CODES.OK);
  assert.match(said(result), /another workspace|T0OTHER|team/);
  await assertNothingKept(w);
  await assertNotPrinted(w.harness, result, OTHER_TEAM);
});

test('a bot token with any scope but exactly the four is refused, and nothing is kept', async (t) => {
  const w = await world(t);
  const result = await cli(w.harness, w.fake, ['workspace', 'bot', 'acme'], { tty: true, type: WIDE });
  assert.notEqual(result.code, EXIT_CODES.OK);
  assert.match(said(result), /channels:history/);
  await assertNothingKept(w);
});

test('a user token pasted in its place is refused before Slack is asked anything', async (t) => {
  const w = await world(t);
  const result = await cli(w.harness, w.fake, ['workspace', 'bot', 'acme'], { tty: true, type: USER });
  assert.notEqual(result.code, EXIT_CODES.OK);
  assert.match(said(result), /user token/);
  assert.equal(asked(w.fake, 'auth.test').length, 0);
  await assertNothingKept(w);
  await assertNotPrinted(w.harness, result, USER);
});

test('a rotating token is refused, saying to turn rotation off or sign in with the client secret', async (t) => {
  const w = await world(t);
  const result = await cli(w.harness, w.fake, ['workspace', 'bot', 'acme'], { tty: true, type: ROTATING });
  assert.notEqual(result.code, EXIT_CODES.OK);
  assert.match(said(result), /rotat/);
  assert.match(said(result), /--with-client-secret/);
  assert.equal(asked(w.fake, 'auth.test').length, 0);
  await assertNothingKept(w);
});

test('an agent cannot run it, and nor can anything without a terminal: refused before the prompt', async (t) => {
  const w = await world(t);
  // `--json`, so the refusal's code is printed: the agent check comes before the terminal check, and refuses first.
  const agent = await cli(w.harness, w.fake, ['--json', 'workspace', 'bot', 'acme'], {
    tty: true,
    type: PASTED,
    env: { CLAUDECODE: '1' },
  });
  assert.notEqual(agent.code, EXIT_CODES.OK);
  assert.match(said(agent), /APPROVAL_REQUIRED/);
  assert.match(said(agent), /only a person/);
  assert.equal(agent.stderr.includes('Bot User OAuth Token'), false, 'an agent was asked for the token');

  const piped = await cli(w.harness, w.fake, ['workspace', 'bot', 'acme'], { tty: false, type: PASTED });
  assert.notEqual(piped.code, EXIT_CODES.OK);
  assert.match(said(piped), /interactive terminal/);
  assert.equal(asked(w.fake, 'auth.test').length, 0);
  await assertNothingKept(w);
});

test('a workspace connected to read keeps no bot token: refused', async (t) => {
  const w = await world(t, 'read');
  const result = await cli(w.harness, w.fake, ['workspace', 'bot', 'acme'], { tty: true, type: PASTED });
  assert.notEqual(result.code, EXIT_CODES.OK);
  assert.match(said(result), /read/);
  assert.equal(asked(w.fake, 'auth.test').length, 0);
  await assertNothingKept(w);
});

async function assertNothingKept(w: Awaited<ReturnType<typeof world>>) {
  const secrets = await w.harness.core.secrets('file');
  secrets.invalidate(botSecretRefFor(w.accountId));
  assert.equal(await secrets.get(botSecretRefFor(w.accountId)), null, 'a refused token was kept');
  const account = (await w.harness.core.config.load()).accounts.acme as unknown as Record<string, unknown>;
  assert.equal(account.botUserId, undefined, 'a refused token named a bot user');
}
