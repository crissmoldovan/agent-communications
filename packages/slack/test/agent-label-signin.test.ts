import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBundle } from '../src/auth/bundle.ts';
import { newFlowId, type SlackFlow } from '../src/auth/flow.ts';
import { scopesForMode } from '../src/manifest.ts';
import { completeSignIn } from '../src/operations/signin.ts';
import { botSecretRefFor, removeWorkspace } from '../src/operations/workspaces.ts';
import { slackHandoffs } from './support/handoffs.ts';
import { type Harness, newHarness, slackOk, TEST_CLIENT_ID } from './support/harness.ts';

/**
 * The send app's bot token, from the sign-in that issues it to the removal that forgets it (design 2026-10-15 S1).
 *
 * A send sign-in must come back with a bot token holding exactly the four posting scopes, and it is kept beside the
 * user token, under `slack/bot-token/<accountId>`, with the bot user it posts as on the account. Narrowing to read and
 * removing the workspace delete that local copy and never revoke it: the bot token is the workspace's, and others who
 * installed the same organisation app hold it too. No test here talks to Slack: the exchange is the harness's.
 */

/** A flow as `startSignIn` saves one, ready to be finished with any code. */
async function savedFlow(
  harness: Harness,
  options: { mode: 'read' | 'send'; expect?: SlackFlow['expect'] },
): Promise<{ flow: SlackFlow; context: ReturnType<Harness['context']>; methods: string[] }> {
  const methods: string[] = [];
  // Every Slack request but the exchange goes through here: none is expected, and `auth.revoke` above all.
  const context = harness.context({
    platform: 'darwin',
    fetch: async (input) => {
      methods.push(String(input instanceof Request ? input.url : input).split('/api/')[1] ?? '');
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  const flow: SlackFlow = {
    flowId: newFlowId(),
    alias: 'acme',
    clientId: TEST_CLIENT_ID,
    mode: options.mode,
    state: 'fake-state',
    verifier: 'fake-verifier',
    port: 60431,
    redirectUrl: 'http://localhost:60431/slack/callback',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(options.expect ? { expect: options.expect } : {}),
    // A new workspace that can post carries the person's consent, as `workspace add --mode send` gives it.
    ...(options.mode === 'send' && !options.expect
      ? { consent: { kind: 'loosening-consent' as const, paths: ['accounts.acme.mode'] } }
      : {}),
  };
  await context.flows.save(flow);
  return { flow, context, methods };
}

test('a send sign-in whose reply carries a bot token anyway keeps it under slack/bot-token/<accountId>', async () => {
  // The PKCE sign-in asks for no bot scope (S1, revised), so Slack should send none; one with exactly the four is kept.
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: scopesForMode('send'), bot: {} });
  const { flow, context, methods } = await savedFlow(harness, { mode: 'send' });

  const view = await completeSignIn(context, flow.flowId, 'fake-code');

  const account = (await harness.core.config.load()).accounts.acme as unknown as Record<string, unknown>;
  assert.equal(account.botUserId, 'U0BOT0001', 'the bot user the app posts as is the account’s own key');
  const secrets = await harness.core.secrets('file');
  const bot = parseBundle(await secrets.get(botSecretRefFor(view.accountId)), slackHandoffs());
  assert.equal(bot?.accessToken, 'fake-bot-token-1');
  assert.equal(bot?.refreshToken, 'fake-bot-refresh-1');
  assert.equal(botSecretRefFor(view.accountId), `slack/bot-token/${view.accountId}`);
  // The user token is where it always was, and is not the bot's.
  const user = parseBundle(await secrets.get(account.secretRef as string), slackHandoffs());
  assert.equal(user?.accessToken, 'fake-user-token-1');
  // What the sign-in reports names the bot user, and never a token.
  assert.equal(view.appUserId, 'U0BOT0001');
  assert.equal(/fake-(bot|user|refresh)/.test(JSON.stringify(view)), false, 'the result carries a token');
  assert.deepEqual(methods, [], 'the sign-in asked Slack for something besides the exchange');
});

test('a send sign-in with no bot token is saved, and names no bot user (S1, revised)', async () => {
  // The ordinary PKCE send sign-in: user scopes only. Its posts take the labelled fallback until a bot token comes.
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const { flow, context } = await savedFlow(harness, { mode: 'send' });

  const view = await completeSignIn(context, flow.flowId, 'fake-code');

  const account = (await harness.core.config.load()).accounts.acme as unknown as Record<string, unknown>;
  assert.equal(account.mode, 'send');
  assert.equal(account.botUserId, undefined, 'a sign-in with no bot token named a bot user');
  assert.equal(view.appUserId, undefined);
  const secrets = await harness.core.secrets('file');
  assert.equal(await secrets.get(botSecretRefFor(view.accountId)), null);
});

test('narrowing to read deletes the local bot token, and never revokes it (S1)', async () => {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme', mode: 'send', bot: { userId: 'U0BOT0001' } });
  const secrets = await harness.core.secrets('file');
  assert.ok(await secrets.get(botSecretRefFor(account.id)), 'the planted bot token is not there');
  // The reauth that narrows: the app's installation removed in Slack, and the workspace signed in again to read.
  harness.reply = () => slackOk({ scopes: scopesForMode('read') });
  const { flow, context, methods } = await savedFlow(harness, {
    mode: 'read',
    expect: {
      accountId: account.id,
      workspaceId: account.workspace,
      userId: account.userId,
      oauthClientId: TEST_CLIENT_ID,
      appId: 'A0001',
      secretRef: account.secretRef,
    },
  });

  await completeSignIn(context, flow.flowId, 'fake-code');

  secrets.invalidate(botSecretRefFor(account.id));
  assert.equal(await secrets.get(botSecretRefFor(account.id)), null, 'the bot token outlived the narrowing');
  const after = (await harness.core.config.load()).accounts.acme as unknown as Record<string, unknown>;
  assert.equal(after.mode, 'read');
  assert.equal(after.botUserId, undefined, 'a read workspace still names a bot user');
  assert.equal(methods.includes('auth.revoke'), false, 'the workspace’s bot token was revoked');
});

test('removing a workspace deletes its local bot token, and never revokes it (S1)', async () => {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme', mode: 'send', bot: { userId: 'U0BOT0001' } });
  const secrets = await harness.core.secrets('file');
  const deleted: string[] = [];
  const removed = await removeWorkspace(
    {
      config: await harness.core.config.load(),
      secrets: {
        kind: secrets.kind,
        async delete(ref) {
          deleted.push(ref);
          return secrets.delete(ref);
        },
      },
      update: (mutator) => harness.core.config.update(mutator),
      handoffs: slackHandoffs(),
    },
    'acme',
  );
  assert.equal(removed.removed, true);
  assert.ok(deleted.includes(botSecretRefFor(account.id)), 'the bot token was not deleted');
  secrets.invalidate(botSecretRefFor(account.id));
  assert.equal(await secrets.get(botSecretRefFor(account.id)), null);
  // Removal is local: the only thing it may touch at Slack is nothing — it has no fetch to reach one with.
  assert.equal((await harness.core.config.load()).accounts.acme, undefined);
});
