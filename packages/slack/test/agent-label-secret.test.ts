import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { CommsError } from '@agentcomms/core';
import { buildAuthorizeUrl } from '../src/auth/authorize.ts';
import { parseBundle, serialiseBundle } from '../src/auth/bundle.ts';
import { newFlowId, type SlackFlow } from '../src/auth/flow.ts';
import { run } from '../src/cli/program.ts';
import { scopesForMode } from '../src/manifest.ts';
import { manifestFor } from '../src/operations/manifest.ts';
import { openApp, openWorkspace } from '../src/operations/session.ts';
import { completeSignIn, startSignIn } from '../src/operations/signin.ts';
import { botSecretRefFor, clientSecretRefFor, removeWorkspace } from '../src/operations/workspaces.ts';
import { slackHandoffs } from './support/handoffs.ts';
import { type Harness, newHarness, slackOk, TEST_CLIENT_ID } from './support/harness.ts';

/**
 * The sign-in with the app's client secret (design 2026-10-15 S1, revised): for a Slack app that has never enabled
 * PKCE, whose `localhost` redirect Slack's PKCE page says is then "treated like a server redirect" — which may ask for
 * bot scopes. The secret is typed at a hidden prompt, kept in the secret store under the app's id, and sent only to
 * `oauth.v2.access`; the authorize URL carries the bot scopes and no PKCE parameter. Whether Slack accepts an `http://`
 * `localhost` redirect for such an app is the live check's to settle (§10). Nothing here reaches Slack.
 */

const SECRET = 'fake-client-secret-0001';
const FOUR = ['chat:write', 'chat:write.customize', 'chat:write.public', 'reactions:write'];

test('the client-secret sign-in asks for the four bot scopes and the user scopes, with no PKCE parameter', () => {
  const send = new URL(
    buildAuthorizeUrl({ clientId: TEST_CLIENT_ID, mode: 'send', port: 51234, auth: 'client-secret' }).url,
  );
  assert.deepEqual(send.searchParams.get('scope')?.split(','), FOUR);
  assert.deepEqual(send.searchParams.get('user_scope')?.split(','), scopesForMode('send'));
  assert.equal(send.searchParams.has('code_challenge'), false);
  assert.equal(send.searchParams.has('code_challenge_method'), false);
  assert.equal(send.searchParams.get('redirect_uri'), 'http://localhost:51234/slack/callback');
  // A read app asks for no bot scope, whichever way it signs in.
  const read = new URL(
    buildAuthorizeUrl({ clientId: TEST_CLIENT_ID, mode: 'read', port: 51234, auth: 'client-secret' }).url,
  );
  assert.equal(read.searchParams.get('scope'), null);
});

test('starting one keeps the secret in the secret store, never in the flow file or the link', async () => {
  const harness = await newHarness();
  const context = harness.context({ platform: 'darwin' });
  const started = await startSignIn(context, {
    mode: 'send',
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    port: 51234,
    detached: false,
    consent: { kind: 'loosening-consent', paths: ['accounts.acme.mode'] },
    clientSecret: SECRET,
  });
  try {
    assert.equal(started.authUrl.includes(SECRET), false, 'the secret is in the link');
    assert.equal(new URL(started.authUrl).searchParams.has('code_challenge'), false);
    const flows = join(harness.core.paths.stateDir, 'slack', 'flows');
    for (const name of await readdir(flows)) {
      assert.equal((await readFile(join(flows, name), 'utf8')).includes(SECRET), false, `${name} holds the secret`);
    }
    const flow = JSON.parse(await readFile(join(flows, `${started.flowId}.json`), 'utf8')) as SlackFlow;
    assert.ok(flow.clientSecretRef, 'the flow does not say where its secret is');
    assert.equal(await (await harness.core.secrets('file')).get(flow.clientSecretRef), SECRET);
  } finally {
    await started.listener?.close();
  }
});

/** A client-secret flow as `startSignIn` saves one, its secret staged where it put it. */
async function secretFlow(harness: Harness, mode: 'read' | 'send') {
  const staged = 'slack/client-secret/pending/1234567890.1234567890';
  await (await harness.core.secrets('file')).set(staged, SECRET);
  const context = harness.context({ platform: 'darwin' });
  const flow: SlackFlow = {
    flowId: newFlowId(),
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    mode,
    state: 'fake-state',
    verifier: 'fake-verifier',
    port: 60433,
    redirectUrl: 'http://localhost:60433/slack/callback',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    clientSecretRef: staged,
    ...(mode === 'send' ? { consent: { kind: 'loosening-consent' as const, paths: ['accounts.acme.mode'] } } : {}),
  };
  await context.flows.save(flow);
  return { context, flow, staged };
}

test('it is exchanged with the client secret and no verifier, and keeps both tokens and the secret by app id', async () => {
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: scopesForMode('send'), bot: {} });
  const { context, flow, staged } = await secretFlow(harness, 'send');

  const view = await completeSignIn(context, flow.flowId, 'fake-code');

  const exchanged = harness.calls.at(-1)?.params ?? {};
  assert.equal(exchanged.client_secret, SECRET);
  assert.equal('code_verifier' in exchanged, false, 'a client-secret exchange sent a PKCE verifier');
  const account = (await harness.core.config.load()).accounts.acme as unknown as Record<string, unknown>;
  assert.equal(account.botUserId, 'U0BOT0001');
  assert.equal(account.clientSecretRef, clientSecretRefFor('A0001'));
  const secrets = await harness.core.secrets('file');
  assert.equal(await secrets.get(clientSecretRefFor('A0001')), SECRET, 'the secret is not kept by the app id');
  assert.equal(await secrets.get(staged), null, 'the staged secret was left behind');
  const user = parseBundle(await secrets.get(String(account.secretRef)), slackHandoffs());
  const bot = parseBundle(await secrets.get(botSecretRefFor(view.accountId)), slackHandoffs());
  assert.equal(bot?.accessToken, 'fake-bot-token-1');
  // A refresh token of an app that never enabled PKCE does not expire after 30 days, so none is recorded.
  assert.equal(user?.refreshExpiresAt, undefined);
  assert.equal(bot?.refreshExpiresAt, undefined);
  assert.equal(JSON.stringify(view).includes(SECRET), false, 'the result carries the secret');
});

test('a client-secret send sign-in that comes back with no bot token is refused, naming the manifest', async () => {
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const { context, flow } = await secretFlow(harness, 'send');
  await assert.rejects(completeSignIn(context, flow.flowId, 'fake-code'), (error: CommsError) => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.match(error.message, /bot/);
    assert.match(error.hint ?? '', /manifest/);
    return true;
  });
  assert.equal((await harness.core.config.load()).accounts.acme, undefined);
});

test('Slack refusing the localhost redirect says plainly to paste the bot token instead', async () => {
  const harness = await newHarness();
  harness.reply = () => ({ ok: false, error: 'bad_redirect_uri' });
  const { context, flow } = await secretFlow(harness, 'send');
  await assert.rejects(completeSignIn(context, flow.flowId, 'fake-code'), (error: CommsError) => {
    assert.match(error.message, /bad_redirect_uri/);
    assert.match(error.hint ?? '', /workspace bot/);
    assert.match(error.hint ?? '', /without --with-client-secret/);
    return true;
  });
});

test('a rotating token of such a workspace is renewed with the client secret, user and bot alike', async () => {
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: scopesForMode('send'), bot: {} });
  const { context, flow } = await secretFlow(harness, 'send');
  const view = await completeSignIn(context, flow.flowId, 'fake-code');
  const config = await harness.core.config.load();
  const account = config.accounts.acme;
  assert.ok(account);
  const secrets = await harness.core.secrets('file');
  // Both tokens due now.
  for (const ref of [account.secretRef, botSecretRefFor(view.accountId)]) {
    const bundle = parseBundle(await secrets.get(ref), slackHandoffs());
    assert.ok(bundle);
    await secrets.set(ref, serialiseBundle({ ...bundle, accessExpiresAt: new Date(Date.now() - 1000).toISOString() }));
  }
  harness.reply = (params) =>
    params.refresh_token === 'fake-bot-refresh-1'
      ? {
          ok: true,
          token_type: 'bot',
          access_token: 'fake-bot-token-2',
          refresh_token: 'fake-bot-refresh-2',
          expires_in: 43_200,
        }
      : slackOk({ authed_user: { access_token: 'fake-user-token-2', refresh_token: 'fake-refresh-token-2' } });

  assert.equal((await openWorkspace(context, 'acme')).call.token, 'fake-user-token-2');
  assert.equal((await openApp(context, 'acme', account)).token, 'fake-bot-token-2');
  const renewals = harness.calls.filter((call) => call.params.grant_type === 'refresh_token');
  assert.equal(renewals.length, 2);
  for (const renewal of renewals) assert.equal(renewal.params.client_secret, SECRET);
});

test('removing the workspace deletes its client secret when no other workspace uses the app', async () => {
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: scopesForMode('send'), bot: {} });
  const { context, flow } = await secretFlow(harness, 'send');
  await completeSignIn(context, flow.flowId, 'fake-code');
  const secrets = await harness.core.secrets('file');
  await removeWorkspace(
    {
      config: await harness.core.config.load(),
      secrets,
      update: (mutator) => harness.core.config.update(mutator),
      handoffs: slackHandoffs(),
    },
    'acme',
  );
  secrets.invalidate(clientSecretRefFor('A0001'));
  assert.equal(await secrets.get(clientSecretRefFor('A0001')), null);
});

test('the manifest for such an app leaves PKCE off; every other keeps it on', async () => {
  const harness = await newHarness();
  const context = harness.context({ platform: 'darwin' });
  const secretApp = await manifestFor(context, { mode: 'send', port: 51234, pkce: false });
  assert.equal(secretApp.manifest.oauth_config.pkce_enabled, false);
  assert.deepEqual(secretApp.manifest.oauth_config.scopes.bot, FOUR);
  const own = await manifestFor(context, { mode: 'send', port: 51234 });
  assert.equal(own.manifest.oauth_config.pkce_enabled, true);
});

test('the secret is asked for at a person’s terminal only: an agent, or no terminal, is refused before the prompt', async () => {
  const harness = await newHarness();
  const argv = ['workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', '51234', '--with-client-secret'];
  for (const [label, options] of [
    ['an agent', { tty: true, env: { CLAUDECODE: '1' } }],
    ['no terminal', { tty: false, env: {} }],
  ] as const) {
    let stderr = '';
    const err = new PassThrough();
    err.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const tty = { isTTY: options.tty };
    const code = await run(argv, {
      core: harness.core,
      env: { ...harness.env, ...options.env },
      exchange: (params) => harness.exchange(params),
      streams: {
        stdout: Object.assign(new PassThrough(), tty),
        stderr: Object.assign(err, tty),
        stdin: Object.assign(new PassThrough(), tty),
      },
      openBrowser: () => undefined,
      platform: 'darwin',
    });
    assert.notEqual(code, 0, label);
    assert.equal(stderr.includes('client secret (it is not shown'), false, `${label} was asked for the secret`);
    assert.match(stderr, label === 'an agent' ? /only a person/ : /interactive terminal/, label);
    assert.equal(harness.calls.length, 0, `${label} reached the exchange`);
  }
});
