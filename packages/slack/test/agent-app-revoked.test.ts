import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { asV2, CommsError } from '@agentcomms/core';
import { storeBotToken } from '../src/operations/bot-token.ts';
import { runDoctor } from '../src/operations/doctor.ts';
import { revokedAppReason } from '../src/operations/label.ts';
import {
  prepareDelete,
  prepareDraftPost,
  prepareEdit,
  react,
  sendDelete,
  sendEdit,
  sendPost,
} from '../src/operations/post.ts';
import { botSecretRefFor } from '../src/operations/workspaces.ts';
import { type Reply, type SlackRequest, type SlackWorld, startFakeSlack } from './support/fake-slack.ts';
import { slackInline } from './support/handoffs.ts';
import { newHarness } from './support/harness.ts';
import { newOrganisationHarness } from './support/organisation.ts';

/**
 * A stored bot token Slack no longer accepts (CUE-493, the lead's decision of 2026-10-16): an organisation's admin
 * regenerated the agent app's token when someone left, or an app was reinstalled. The act made with it is refused, as
 * any refusal is — never sent under the other identity, which would need a new preview — and the token is forgotten, so
 * the next prepare takes the labelled fallback (S2), and `doctor` says when and what fixes it.
 *
 * Nothing here reaches Slack: the fake refuses the bot token with each code, and records every request.
 */

const BOT = 'Bearer fake-bot-token-0';
const USER = 'Bearer fake-user-token-0';
const DEAD = ['token_revoked', 'invalid_auth', 'account_inactive'] as const;

async function labelled(t: TestContext) {
  const harness = await newHarness();
  const account = await harness.addWorkspace({
    alias: 'acme',
    mode: 'send',
    identity: 'agent',
    bot: { userId: 'U0BOT0001' },
  });
  const fake = await startFakeSlack();
  t.after(() => fake.close());
  const world: SlackWorld = fake.world({
    users: {
      U0001: { display_name: '', real_name: 'Jo Example' },
      U0BOT0001: { real_name: 'Acme Agent', is_bot: true },
    },
    rooms: {
      C1: { name: 'eng', members: ['U0001', 'U2'] },
      D1: { is_im: true, user: 'U2', members: ['U0001', 'U2'] },
    },
  });
  return {
    harness,
    context: harness.context({ platform: 'darwin' }),
    fake,
    world,
    slack: { fetch: fake.fetch },
    accountId: account.id,
  };
}

type Labelled = Awaited<ReturnType<typeof labelled>>;

const calls = (w: Labelled, method: string): SlackRequest[] =>
  w.fake.requests.filter((request) => request.method === method);

/** Slack refusing the bot token on `method` with `error`, and answering everything else as the world does. */
function refuseBot(w: Labelled, method: string, error: string): void {
  const before = w.fake.script[method] as Reply | undefined;
  w.fake.script[method] = (request) =>
    request.authorization === BOT
      ? { ok: false, error }
      : (before?.(request) ?? { ok: false, error: 'unknown_method' });
}

async function account(w: Labelled): Promise<Record<string, unknown>> {
  return (await w.harness.core.config.load()).accounts.acme as unknown as Record<string, unknown>;
}

async function botToken(w: Labelled): Promise<string | null> {
  const secrets = await w.harness.core.secrets('file');
  secrets.invalidate(botSecretRefFor(w.accountId));
  return secrets.get(botSecretRefFor(w.accountId));
}

/** The token is gone from the store and from the account, and why is recorded for `doctor`. */
async function assertForgotten(w: Labelled, slackError: string): Promise<void> {
  assert.equal(await botToken(w), null, 'the revoked bot token was kept');
  const held = await account(w);
  assert.equal(held.botUserId, undefined, 'the account still names the bot user, so the gate would route to the app');
  const revoked = held.appTokenRevoked as { at?: string; slackError?: string } | undefined;
  assert.equal(revoked?.slackError, slackError);
  assert.match(revoked?.at ?? '', /^\d{4}-\d{2}-\d{2}T/);
}

function refusal(pattern: { nothing: RegExp; next: RegExp }, w: Labelled) {
  const bot = slackInline(w.harness.core.paths, ['workspace', 'bot', 'acme'], 'darwin');
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.details?.reason, 'app-token-revoked');
    const said = `${error.message} ${error.hint ?? ''}`;
    assert.match(said, /the agent app's token was revoked/);
    assert.match(said, pattern.nothing);
    assert.match(said, pattern.next);
    assert.ok(said.includes(bot), `the paste command is located:\n${said}`);
    return true;
  };
}

async function preparePost(w: Labelled, channel = 'C1') {
  return prepareDraftPost(w.context, 'acme', { channel, text: 'shipping in ten minutes' }, w.slack);
}

async function send(w: Labelled, prepared: Awaited<ReturnType<typeof preparePost>>, channel = 'C1') {
  return sendPost(
    w.context,
    'acme',
    { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: channel },
    w.slack,
  );
}

// ── A post ─────────────────────────────────────────────────────────────────────────────────────────────────────────

for (const code of DEAD) {
  test(`an app post refused with ${code} is refused, posts nothing, and forgets the bot token`, async (t) => {
    const w = await labelled(t);
    const prepared = await preparePost(w);
    assert.equal(prepared.label?.route, 'app');
    refuseBot(w, 'chat.postMessage', code);
    await assert.rejects(
      send(w, prepared),
      refusal({ nothing: /nothing was posted/, next: /prepare it again to post as you, labelled/i }, w),
    );
    // One attempt, the app's, and nothing after it under the other identity.
    const sent = calls(w, 'chat.postMessage');
    assert.equal(sent.length, 1, 'a second post followed the refused one');
    assert.equal(sent[0]?.authorization, BOT);
    assert.equal(w.world.messages.length, 0);
    assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'failed');
    await assertForgotten(w, code);
  });
}

test('the next prepare finds no bot token, so it takes the labelled fallback, and posts as the person', async (t) => {
  const w = await labelled(t);
  refuseBot(w, 'chat.postMessage', 'token_revoked');
  await assert.rejects(send(w, await preparePost(w)));
  const again = await preparePost(w);
  assert.equal(again.label?.route, 'fallback');
  assert.equal(again.label?.reason, revokedAppReason());
  await send(w, again);
  const [, labelledPost] = calls(w, 'chat.postMessage');
  assert.equal(labelledPost?.authorization, USER, 'the fallback goes with the person’s token');
  assert.match(labelledPost?.params.get('text') ?? '', /^Jo Example \(agent\): /);
});

test('any other refusal of an app post keeps the bot token', async (t) => {
  for (const code of ['not_in_channel', 'missing_scope', 'channel_not_found']) {
    const w = await labelled(t);
    refuseBot(w, 'chat.postMessage', code);
    await assert.rejects(send(w, await preparePost(w)), (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.notEqual(error.details?.reason, 'app-token-revoked', code);
      return true;
    });
    assert.equal((await botToken(w)) === null, false, `${code} deleted the bot token`);
    assert.equal((await account(w)).botUserId, 'U0BOT0001', code);
    assert.equal((await account(w)).appTokenRevoked, undefined, code);
  }
});

test('the person’s own token refused on a labelled post keeps the app’s bot token: it was not the app’s that failed', async (t) => {
  const w = await labelled(t);
  const prepared = await preparePost(w, 'D1');
  assert.equal(prepared.label?.route, 'fallback');
  const before = w.fake.script['chat.postMessage'] as Reply;
  w.fake.script['chat.postMessage'] = (request) =>
    request.authorization === USER ? { ok: false, error: 'token_revoked' } : before(request);
  await assert.rejects(send(w, prepared, 'D1'), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.notEqual(error.details?.reason, 'app-token-revoked');
    return true;
  });
  assert.notEqual(await botToken(w), null);
  assert.equal((await account(w)).botUserId, 'U0BOT0001');
});

// ── A reaction, an edit, a deletion ────────────────────────────────────────────────────────────────────────────────

test('an app reaction refused with token_revoked is refused and forgets the bot token', async (t) => {
  const w = await labelled(t);
  refuseBot(w, 'reactions.add', 'token_revoked');
  await assert.rejects(
    react(w.context, 'acme', { channel: 'C1', ts: '1700000000.000100', name: 'eyes' }, undefined, w.slack),
    refusal({ nothing: /nothing was changed/, next: /prepare it again to react as you/i }, w),
  );
  assert.equal(w.world.reactions.length, 0);
  await assertForgotten(w, 'token_revoked');
});

async function appMessage(w: Labelled): Promise<string> {
  const prepared = await preparePost(w);
  const posted = await send(w, prepared);
  const ts = 'ts' in posted && posted.ts ? posted.ts : assert.fail('the app post has no ts');
  return ts;
}

test('an edit of the app’s message refused with invalid_auth is refused and forgets the bot token', async (t) => {
  const w = await labelled(t);
  const ts = await appMessage(w);
  const prepared = await prepareEdit(w.context, 'acme', { ts, channel: 'C1', text: 'shipping in five' }, w.slack);
  refuseBot(w, 'chat.update', 'invalid_auth');
  await assert.rejects(
    sendEdit(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1', ts },
      w.slack,
    ),
    refusal({ nothing: /nothing was changed/, next: /only the app can edit or delete its own message/i }, w),
  );
  assert.equal(w.world.messages[0]?.text, 'shipping in ten minutes', 'the message was changed');
  await assertForgotten(w, 'invalid_auth');
});

test('a deletion of the app’s message refused with account_inactive is refused and forgets the bot token', async (t) => {
  const w = await labelled(t);
  const ts = await appMessage(w);
  const deletion = await prepareDelete(w.context, 'acme', { channel: 'C1', ts }, w.slack);
  refuseBot(w, 'chat.delete', 'account_inactive');
  await assert.rejects(
    sendDelete(w.context, 'acme', { channel: 'C1', ts, approvalId: deletion.approvalId }, w.slack),
    refusal({ nothing: /nothing was changed/, next: /only the app can edit or delete its own message/i }, w),
  );
  assert.notEqual(w.world.messages[0]?.deleted, true, 'the message was deleted');
  await assertForgotten(w, 'account_inactive');
});

// ── What doctor says ───────────────────────────────────────────────────────────────────────────────────────────────

const REVOKED = { at: '2026-10-16T09:30:00.000Z', slackError: 'token_revoked' };

test('doctor says when an organisation’s agent app token was revoked, and to ask the admin, then workspace bot', async () => {
  const harness = await newOrganisationHarness({ port: 51234 });
  await harness.addWorkspace({ alias: 'rgc/slack', workspaceId: 'TRGC0001', mode: 'send', identity: 'agent' });
  await harness.updateConfig((config) => {
    const held = config.accounts['rgc/slack'];
    assert.ok(held);
    Object.assign(held, { organisation: 'rgc', profileApp: 'send', appTokenRevoked: REVOKED });
  });
  const report = await runDoctor(harness.context({ platform: 'darwin' }), { offline: true });
  const check = report.checks.find((one) => one.id === 'app-identity');
  assert.equal(check?.status, 'warn');
  assert.match(check?.detail ?? '', /revoked on 2026-10-16/);
  assert.match(check?.detail ?? '', /as you, labelled/);
  const fix = String(check?.fix);
  assert.match(fix, /ask your organisation's admin for the agent app's new token/i);
  assert.ok(fix.includes(slackInline(harness.core.paths, ['workspace', 'bot', 'rgc/slack'], 'darwin')), fix);
  assert.doesNotMatch(fix, /with-client-secret/);
});

test('for a person’s own app, doctor names the client-secret sign-in instead', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', identity: 'agent' });
  await harness.core.config.update((config) => {
    const held = config.accounts.acme;
    assert.ok(held);
    return {
      ...config,
      accounts: {
        ...config.accounts,
        acme: { ...held, clientSecretRef: 'slack/client-secret/A0001', appTokenRevoked: REVOKED },
      },
    };
  });
  const report = await runDoctor(harness.context({ platform: 'darwin' }), { offline: true });
  const check = report.checks.find((one) => one.id === 'app-identity');
  assert.equal(check?.status, 'warn');
  assert.match(check?.detail ?? '', /revoked on 2026-10-16/);
  const fix = String(check?.fix);
  assert.ok(
    fix.includes(
      slackInline(
        harness.core.paths,
        ['workspace', 'reauth', 'acme', '--mode', 'send', '--with-client-secret'],
        'darwin',
      ),
    ),
    fix,
  );
  // The organisation's wording, not a bare "admin": a Windows runner's account is runneradmin, and its home is in the command.
  assert.doesNotMatch(fix, /organisation['’]s admin/);
});

test('pasting the new token takes the record of the refused one away, and posts go as the app again', async (t) => {
  const w = await labelled(t);
  refuseBot(w, 'chat.postMessage', 'token_revoked');
  await assert.rejects(send(w, await preparePost(w)));
  await assertForgotten(w, 'token_revoked');
  const pasted = 'xoxb-fake-new-0001';
  w.fake.script['auth.test'] = (request) =>
    request.authorization === `Bearer ${pasted}`
      ? {
          status: 200,
          headers: { 'x-oauth-scopes': 'chat:write,chat:write.customize,chat:write.public,reactions:write' },
          body: { ok: true, team_id: 'T0001', user_id: 'U0BOT0001', bot_id: 'B0BOT0001' },
        }
      : { ok: false, error: 'invalid_auth' };
  await storeBotToken(w.context, 'acme', pasted, { fetch: w.fake.fetch });
  const held = await account(w);
  assert.equal(held.botUserId, 'U0BOT0001');
  assert.equal(held.appTokenRevoked, undefined, 'the refusal was still recorded after a new token was pasted');
  const report = await runDoctor(w.context, { offline: true });
  assert.equal(report.checks.find((one) => one.id === 'app-identity')?.status, 'ok');
});
