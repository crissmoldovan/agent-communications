import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { asV2, type CommsError, renderChannelPreview, UNLABELLED_PREVIEW_LINE } from '@agentcomms/core';
import type { TokenBundle } from '../src/auth/bundle.ts';
import { beginApproval } from '../src/operations/approve.ts';
import { runDoctor } from '../src/operations/doctor.ts';
import { FALLBACK_REASONS, noAppReason } from '../src/operations/label.ts';
import { prepareDraftPost, sendPost } from '../src/operations/post.ts';
import { botSecretRefFor } from '../src/operations/workspaces.ts';
import { type SlackWorld, startFakeSlack, type WorldRoom } from './support/fake-slack.ts';
import { newHarness } from './support/harness.ts';
import { newOrganisationHarness } from './support/organisation.ts';

/**
 * Who a post appears to come from, decided at prepare and bound (design 2026-10-15 L3, S2, S4, S7).
 *
 * Every route S2 names, through the operation both surfaces run — `prepareDraftPost`, over a harness and the fake's
 * stateful workspace — and the one rule that holds them together: the identity, the route, the phrase and the icon are
 * in the approval's digest, so a change to any of them after the preview refuses the post. Nothing here reaches Slack.
 */

const PHOTO = 'https://avatars.example.test/u0001-192.png';

/** The rooms of the world: one per route S2 names. */
function rooms(): Record<string, WorldRoom> {
  return {
    // A public channel the app has not joined: `chat:write.public` lets it post.
    C1: { name: 'eng', members: ['U0001', 'U2'] },
    // A private one the app is in, found on the second page of members.
    G1: { name: 'secret', is_private: true, members: ['U0001', 'U2', 'U3', 'U0BOT0001'] },
    // A private one it is not in.
    G2: { name: 'other', is_private: true, members: ['U0001', 'U2', 'U3'] },
    // Shared with another organisation, and the app not in it.
    C2: { name: 'partners', is_ext_shared: true, members: ['U0001', 'U9'] },
    D1: { is_im: true, user: 'U2', members: ['U0001', 'U2'] },
    D2: { is_im: true, user: 'U0001', members: ['U0001'] },
    M1: { name: 'mpdm-a--b--c', is_mpim: true, members: ['U0001', 'U2', 'U3'] },
  };
}

interface Labelled {
  harness: Awaited<ReturnType<typeof newHarness>>;
  context: ReturnType<Awaited<ReturnType<typeof newHarness>>['context']>;
  world: SlackWorld;
  fake: Awaited<ReturnType<typeof startFakeSlack>>;
  slack: { fetch: Awaited<ReturnType<typeof startFakeSlack>>['fetch'] };
  accountId: string;
}

async function labelled(
  t: TestContext,
  options: {
    bot?: boolean;
    sendPolicy?: 'chat' | 'confirm';
    users?: SlackWorld['users'];
    agentLabel?: Record<string, unknown>;
    /** The person's own credential, laid over the harness's — which rotates, as every sign-in's does. */
    bundle?: Partial<TokenBundle>;
  } = {},
): Promise<Labelled> {
  const harness = await newHarness();
  const account = await harness.addWorkspace({
    alias: 'acme',
    mode: 'send',
    identity: 'agent',
    ...(options.bot === false ? {} : { bot: { userId: 'U0BOT0001' } }),
    ...(options.sendPolicy ? { sendPolicy: options.sendPolicy } : {}),
    ...(options.bundle ? { bundle: options.bundle } : {}),
  });
  if (options.agentLabel) await setLabel(harness, options.agentLabel);
  const fake = await startFakeSlack();
  t.after(() => fake.close());
  const world = fake.world({
    users: options.users ?? {
      U0001: { display_name: '', real_name: 'Jo Example', image_192: PHOTO },
      U0BOT0001: { real_name: 'Acme Agent', is_bot: true },
    },
    rooms: rooms(),
    pageSize: 2,
  });
  const context = harness.context({ platform: 'darwin' });
  return { harness, context, world, fake, slack: { fetch: fake.fetch }, accountId: account.id };
}

/** The person's label settings, as `label` writes them — with the consent a loosening needs once the core judges it. */
async function setLabel(harness: Labelled['harness'], agentLabel: Record<string, unknown>): Promise<void> {
  await harness.core.config.update((config) => ({ ...config, agentLabel }), {
    consent: {
      kind: 'loosening-consent',
      paths: [
        'agentLabel.rules',
        'agentLabel.word',
        'agentLabel.name',
        'agentLabel.slackIcons',
        'agentLabel.slackStyles',
      ],
    },
  });
}

const prepare = (w: Labelled, request: Record<string, unknown>) =>
  prepareDraftPost(w.context, 'acme', { text: 'shipping in ten minutes', ...request }, w.slack);

const posted = (w: Labelled) => w.fake.requests.filter((request) => request.method === 'chat.postMessage');

// ── The app route ──────────────────────────────────────────────────────────────────────────────────────────────────

test('a public channel not shared with another organisation goes to the app, with the phrase and the photo (S2, S4)', async (t) => {
  const w = await labelled(t);
  const prepared = await prepare(w, { channel: 'C1' });
  assert.equal(prepared.label?.identity, 'agent');
  assert.equal(prepared.label?.route, 'app');
  assert.equal(prepared.label?.phrase, 'Jo Example (agent)');
  assert.deepEqual(prepared.label?.icon, { url: PHOTO }, 'with no agent emoji set, the icon is the plain photo');
  // S7: the first line names the identity exactly, and the app by its name in Slack.
  assert.equal(prepared.preview.postingAs, 'Jo Example (agent) · posted by the app Acme Agent');
  assert.match(
    renderChannelPreview(prepared.preview).split('\n')[1] ?? '',
    /^From: +Jo Example \(agent\) · posted by the app Acme Agent$/,
  );
  assert.deepEqual(posted(w), [], 'preparing posted something');
});

test('a private channel whose members include the bot goes to the app, paged until it is found (S2)', async (t) => {
  const w = await labelled(t);
  const prepared = await prepare(w, { channel: 'G1' });
  assert.equal(prepared.label?.route, 'app');
  const pages = w.fake.requests.filter((request) => request.method === 'conversations.members');
  assert.equal(pages.length, 2, 'the bot is on the second page, and the members were read once each');
  assert.equal(pages[1]?.params.get('cursor'), '2');
  // Read with the person's token: the bot token reads nothing.
  for (const page of pages) assert.equal(page.authorization, 'Bearer fake-user-token-0');
});

test('the same channel without the bot takes the labelled fallback, with the reason (S2, S7)', async (t) => {
  const w = await labelled(t);
  const prepared = await prepare(w, { channel: 'G2' });
  assert.equal(prepared.label?.route, 'fallback');
  assert.equal(prepared.label?.reason, FALLBACK_REASONS.notMember);
  assert.equal(
    prepared.preview.postingAs,
    'Jo Example · labelled "Jo Example (agent):" at the start of the message · the app is not a member of this channel',
  );
  assert.ok(
    (prepared.preview.warnings ?? []).some((warning) => /labelled in the message/.test(warning)),
    'the preview does not say the fallback puts the label in the message',
  );
  // A channel shared with another organisation is the same: the app posts there only once it has joined.
  const shared = await prepare(w, { channel: 'C2' });
  assert.equal(shared.label?.route, 'fallback');
  assert.equal(shared.label?.reason, FALLBACK_REASONS.notMember);
});

// ── The fallback route ─────────────────────────────────────────────────────────────────────────────────────────────

test('a DM, a group DM and the person’s own DM take the labelled fallback, each with its reason (S2)', async (t) => {
  const w = await labelled(t);
  const reasons: Record<string, string> = {
    D1: FALLBACK_REASONS.im,
    D2: FALLBACK_REASONS.self,
    M1: FALLBACK_REASONS.mpim,
  };
  for (const [channel, reason] of Object.entries(reasons)) {
    const prepared = await prepare(w, { channel });
    assert.equal(prepared.label?.route, 'fallback', channel);
    assert.equal(prepared.label?.reason, reason, channel);
    assert.match(
      prepared.preview.postingAs,
      /^Jo Example · labelled "Jo Example \(agent\):" at the start of the message · /,
      channel,
    );
  }
  // No room the app cannot be in was asked about its members.
  assert.equal(w.fake.requests.filter((request) => request.method === 'conversations.members').length, 0);
});

test('a post with files always takes the labelled fallback (S2)', async (t) => {
  const w = await labelled(t);
  const docs = join(w.harness.home, 'docs');
  mkdirSync(docs);
  const path = join(docs, 'notes.txt');
  writeFileSync(path, 'the notes\n');
  const prepared = await prepare(w, { channel: 'C1', files: [realpathSync.native(path)] });
  assert.equal(prepared.label?.route, 'fallback');
  assert.equal(prepared.label?.reason, FALLBACK_REASONS.file);
});

test('a send workspace with no bot token takes the fallback, and doctor names a way to give it one (Review focus 1)', async (t) => {
  const w = await labelled(t, { bot: false });
  const prepared = await prepare(w, { channel: 'C1' });
  assert.equal(prepared.label?.identity, 'agent', 'a workspace with no bot went out unlabelled');
  assert.equal(prepared.label?.route, 'fallback');
  assert.equal(prepared.label?.reason, noAppReason('send'));

  const check = await appIdentityCheck(w);
  assert.equal(check?.status, 'warn');
  assert.match(check?.detail ?? '', /as you, labelled/);

  // With its bot token stored, the same check is ok.
  assert.equal((await appIdentityCheck(await labelled(t)))?.status, 'ok');
});

/** The three steps to a new app that signs in with its client secret, each located, in order. */
const NEW_APP_STEPS = [
  / manifest --mode send --with-client-secret(`|\s|$)/,
  / workspace remove acme(`|\s|$)/,
  / workspace add acme --mode send --client-id <id> --port <port> --with-client-secret(`|\s|$)/,
];

test("a person's own PKCE app gets the steps to a new app, and no command Slack or this would refuse", async (t) => {
  // The standard manifest's app: PKCE, which cannot be turned off on it, and tokens that rotate.
  const check = await appIdentityCheck(await labelled(t, { bot: false }));
  assert.equal(check?.status, 'warn');
  const fix = String(check?.fix);
  const lines = fix.split('\n');
  NEW_APP_STEPS.forEach((step, index) => {
    const at = lines.findIndex((line) => step.test(line));
    assert.ok(at >= 0, `step ${index + 1} is missing: ${fix}`);
    assert.match(lines[at] ?? '', new RegExp(`^${index + 1}\\. `), `step ${index + 1} is not numbered in order`);
  });
  assert.match(fix, /picks its own free port/);
  assert.match(fix, /free plan holds at most 10 apps/);
  assert.match(fix, /one connection per person per workspace/i);
  // Slack refuses bot scopes to a PKCE app, and `workspace bot` refuses a rotating token: neither is named.
  const said = `${check?.detail} ${fix}`;
  assert.doesNotMatch(said, /workspace reauth/);
  assert.doesNotMatch(said, / workspace bot /);
  assert.match(said, /PKCE/);
  assert.match(said, /rotate/);
});

test("a person's own app connected with its client secret, missing only its bot token, gets the client-secret sign-in", async (t) => {
  const w = await labelled(t, { bot: false });
  await plant(w, { clientSecretRef: 'slack/client-secret/A0001' });
  const check = await appIdentityCheck(w);
  assert.equal(check?.status, 'warn');
  const fix = String(check?.fix);
  assert.match(fix, / workspace reauth acme --mode send --with-client-secret(`|\s|$)/);
  // Its app already brings a bot token at sign-in: no new app, and no paste of a token that rotates.
  for (const step of NEW_APP_STEPS) assert.doesNotMatch(fix, step);
  assert.doesNotMatch(fix, / workspace bot /);
});

test("doctor offers paste-once too for a person's own app whose tokens do not rotate", async (t) => {
  const nonRotating = { refreshToken: undefined, refreshExpiresAt: undefined };
  const pkce = String((await appIdentityCheck(await labelled(t, { bot: false, bundle: nonRotating })))?.fix);
  assert.match(pkce, / workspace bot acme(`|\s|$)/);
  for (const step of NEW_APP_STEPS) assert.match(pkce, step);
  assert.doesNotMatch(pkce, /workspace reauth/);

  const w = await labelled(t, { bot: false, bundle: nonRotating });
  await plant(w, { clientSecretRef: 'slack/client-secret/A0001' });
  const secret = String((await appIdentityCheck(w))?.fix);
  assert.match(secret, / workspace bot acme(`|\s|$)/);
  assert.match(secret, / workspace reauth acme --mode send --with-client-secret(`|\s|$)/);
});

test("a workspace connected through an organisation's app gets a note that names no command it would refuse", async (t) => {
  for (const bundle of [undefined, { refreshToken: undefined, refreshExpiresAt: undefined }]) {
    const w = await labelled(t, { bot: false, ...(bundle ? { bundle } : {}) });
    // As a profile sign-in records it: the organisation whose app made the account, and that app's role.
    await plant(w, { organisation: 'rgc', profileApp: 'send' });
    const check = await appIdentityCheck(w);
    // A note: posting as the person, labelled, is how an organisation's workspace works, and nothing here changes it.
    assert.equal(check?.status, 'ok', 'a profile workspace warned about something its person cannot change');
    assert.equal(check?.fix, null, 'a profile workspace was given a command to run');
    assert.match(check?.detail ?? '', /as you, labelled/);
    assert.match(check?.detail ?? '', /organisation’s shared app/);
    // Paste-once refuses its rotating tokens; the client-secret sign-in refuses a profile account outright.
    const said = `${check?.detail} ${check?.fix}`;
    assert.doesNotMatch(said, /workspace bot/);
    assert.doesNotMatch(said, /with-client-secret|client secret/);
  }
});

/**
 * Doctor's finding for a member connected through RGC's profile (CUE-493): the profile may name the organisation's agent
 * app, and the member may have pasted its bot token.
 */
async function organisationAppIdentity(options: { agentApp?: string; pasted?: boolean } = {}) {
  const harness = await newOrganisationHarness({ port: 51234 });
  await harness.addWorkspace({
    alias: 'rgc/slack',
    workspaceId: 'TRGC0001',
    mode: 'send',
    identity: 'agent',
    // A pasted agent app token does not rotate: no refresh token, and an expiry nothing reaches.
    ...(options.pasted
      ? {
          bot: {
            userId: 'U0BOT0001',
            bundle: {
              refreshToken: undefined,
              refreshExpiresAt: undefined,
              accessExpiresAt: '9999-12-31T23:59:59.999Z',
            },
          },
        }
      : {}),
  });
  await harness.updateConfig((config) => {
    const held = config.accounts['rgc/slack'];
    assert.ok(held);
    Object.assign(held, { organisation: 'rgc', profileApp: 'send' });
    const apps = config.organisations?.rgc?.slack?.apps;
    assert.ok(apps);
    if (options.agentApp !== undefined) apps.agent = { appId: options.agentApp, sha256: 'c'.repeat(64) };
  });
  const report = await runDoctor(harness.context({ platform: 'darwin' }), { offline: true });
  return report.checks.find((one) => one.id === 'app-identity');
}

test('with the profile naming its agent app and no token here, doctor says to ask the admin for it, then workspace bot', async () => {
  const check = await organisationAppIdentity({ agentApp: 'A0AGENT0001' });
  assert.equal(check?.status, 'warn', 'something the member can do, so not a note');
  const fix = String(check?.fix);
  assert.match(fix, /ask your organisation's admin for the agent app's token/i);
  assert.match(fix, / workspace bot rgc\/slack(`|\s|$)/);
  assert.match(check?.detail ?? '', /A0AGENT0001/);
  assert.match(check?.detail ?? '', /as you, labelled/);
  // Neither way an organisation's shared app refuses: its client secret, or a new app of the member's own.
  const said = `${check?.detail} ${fix}`;
  assert.doesNotMatch(said, /with-client-secret|client secret/);
  for (const step of NEW_APP_STEPS) assert.doesNotMatch(said, step);
});

test('without the field, a profile workspace keeps today’s note; with the token pasted, the usual ok', async () => {
  const none = await organisationAppIdentity();
  assert.equal(none?.status, 'ok');
  assert.equal(none?.fix, null);
  assert.match(none?.detail ?? '', /organisation’s shared app/);
  assert.doesNotMatch(`${none?.detail}`, /workspace bot/);

  const pasted = await organisationAppIdentity({ agentApp: 'A0AGENT0001', pasted: true });
  assert.equal(pasted?.status, 'ok');
  assert.equal(pasted?.fix, null);
  assert.match(pasted?.detail ?? '', /go out as the app \(bot user U0BOT0001\)/);
});

test('doctor checks the bot token is stored, not only that a bot user is recorded', async (t) => {
  const w = await labelled(t);
  await (await w.harness.core.secrets('file')).delete(botSecretRefFor(w.accountId));
  const check = await appIdentityCheck(w);
  assert.equal(check?.status, 'warn', 'a bot user with no stored token read as able to post as the app');
  assert.match(String(check?.fix), / workspace remove acme(`|\s|$)/);
});

/** Lays fields over the workspace's account, as a sign-in records them. */
async function plant(w: Labelled, fields: Record<string, unknown>): Promise<void> {
  await w.harness.core.config.update((config) => {
    const acme = config.accounts.acme;
    assert.ok(acme);
    return { ...config, accounts: { ...config.accounts, acme: { ...acme, ...fields } } };
  });
}

/** Doctor's app-identity finding for the workspace, read as `doctor` reads everything, offline. */
async function appIdentityCheck(w: Labelled) {
  const report = await runDoctor(w.harness.context({ platform: 'darwin' }), { offline: true });
  return report.checks.find((one) => one.id === 'app-identity');
}

// ── Identity ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('`as: "me"` goes as the person, its first line saying so — under `confirm` too, at the terminal (L3, Review focus 5)', async (t) => {
  const w = await labelled(t, { sendPolicy: 'confirm' });
  const prepared = await prepare(w, { channel: 'C1', as: 'me' });
  assert.equal(prepared.label?.identity, 'me');
  assert.equal(prepared.label?.route, 'person');
  assert.equal(prepared.preview.postingAs, UNLABELLED_PREVIEW_LINE);
  assert.equal(prepared.approval.route, 'confirm', 'a confirm workspace’s post went to the chat');
  // The terminal screen decides as prepare did, from the approval's own record, and shows the same first line.
  const screen = await beginApproval(w.context, prepared.approvalId, w.slack);
  assert.match(screen.preview.split('\n')[1] ?? '', new RegExp(`^From: +${UNLABELLED_PREVIEW_LINE}$`));
});

test('`as` takes nothing but agent or me', async (t) => {
  const w = await labelled(t);
  await assert.rejects(prepare(w, { channel: 'C1', as: 'bot' }), (error: CommsError) => {
    assert.equal(error.code, 'USAGE');
    return true;
  });
});

test('a rule for the person a DM is with decides that DM (L4)', async (t) => {
  const w = await labelled(t, { agentLabel: { rules: [{ account: 'acme', conversation: 'U2', as: 'me' }] } });
  const dm = await prepare(w, { channel: 'D1' });
  assert.equal(dm.label?.identity, 'me', 'the rule for U2 did not decide the DM with U2');
  assert.equal(dm.preview.postingAs, UNLABELLED_PREVIEW_LINE);
  // Anywhere else, the default.
  const elsewhere = await prepare(w, { channel: 'C1' });
  assert.equal(elsewhere.label?.identity, 'agent');
});

// ── Binding ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Prepares a post, changes one thing, and shows the send is refused with nothing posted. */
async function refusedAfter(t: TestContext, channel: string, change: (w: Labelled) => Promise<void> | void) {
  const w = await labelled(t);
  const prepared = await prepare(w, { channel });
  const before = asV2(await w.context.core.approvals.get(prepared.approvalId))?.contentDigest;
  await change(w);
  await assert.rejects(
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: channel },
      w.slack,
    ),
    (error: CommsError) => {
      assert.match(error.code, /APPROVAL_VOID|INTEGRITY|APPROVAL/);
      return true;
    },
  );
  assert.deepEqual(posted(w), [], 'a post went out after its label changed');
  assert.ok(before, 'the approval was not stored');
}

test('the route is bound: an app removed from the room after the preview refuses the post (S2)', async (t) => {
  await refusedAfter(t, 'G1', (w) => {
    const room = w.world.rooms.G1 as WorldRoom;
    room.members = room.members.filter((member) => member !== 'U0BOT0001');
  });
});

test('the icon is bound: an agent emoji set after the preview refuses the post (S4)', async (t) => {
  await refusedAfter(t, 'C1', (w) => setLabel(w.harness, { slackIcons: { [w.accountId]: ':jo-agent:' } }));
});

test('the phrase is bound: a name changed after the preview refuses the post (L1)', async (t) => {
  await refusedAfter(t, 'C1', (w) => {
    (w.world.users as Record<string, unknown>).U0001 = {
      display_name: 'Jojo',
      real_name: 'Jo Example',
      image_192: PHOTO,
    };
  });
});

test('the identity is bound: a rule switching the label off after the preview refuses the post (L3)', async (t) => {
  await refusedAfter(t, 'C1', (w) => setLabel(w.harness, { rules: [{ account: 'acme', as: 'me' }] }));
});

test('an agent emoji set before the preview is the icon, over the photo (S4)', async (t) => {
  const w = await labelled(t);
  await setLabel(w.harness, { slackIcons: { [w.accountId]: ':jo-agent:' } });
  const prepared = await prepare(w, { channel: 'C1' });
  assert.deepEqual(prepared.label?.icon, { emoji: ':jo-agent:' });
});

// ── The name ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('an empty display name uses the real name; one that cannot make a label falls through to the next (L1)', async (t) => {
  const w = await labelled(t, {
    users: {
      U0001: { display_name: 'Jo (she/her)', real_name: 'Jo Example', image_192: PHOTO },
      U0BOT0001: { real_name: 'Acme Agent', is_bot: true },
    },
  });
  const prepared = await prepare(w, { channel: 'C1' });
  assert.equal(prepared.label?.phrase, 'Jo Example (agent)', 'a parenthesis in the display name made a second label');
  // And the word is the person's own setting.
  await setLabel(w.harness, { word: 'twin' });
  assert.equal((await prepare(w, { channel: 'C1' })).label?.phrase, 'Jo Example (twin)');
});

test('a phrase longer than 80 characters is refused, naming `label name`, and is never cut short (L2, Review focus 4)', async (t) => {
  const long = 'A'.repeat(73);
  const w = await labelled(t, {
    users: { U0001: { display_name: long, real_name: long }, U0BOT0001: { real_name: 'Acme Agent', is_bot: true } },
  });
  await assert.rejects(prepare(w, { channel: 'C1' }), (error: CommsError) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /80 characters/);
    assert.match(error.hint ?? '', /`label name`/);
    return true;
  });
  assert.deepEqual(await w.context.core.approvals.list(), [], 'a refused label left an approval');
  // The name setting fills the gap the profile cannot (L1).
  await setLabel(w.harness, { name: 'Jo Example' });
  assert.equal((await prepare(w, { channel: 'C1' })).label?.phrase, 'Jo Example (agent)');
});

test("a rule that recorded this workspace's id applies, and one that recorded another account's id does not", async (t) => {
  const w = await labelled(t);
  const id = (await w.context.core.config.load()).accounts.acme?.id;
  assert.ok(id);
  await setLabel(w.harness, { rules: [{ account: 'acme', accountId: id, as: 'me' }] });
  assert.equal((await prepare(w, { channel: 'C1' })).label?.identity, 'me');
  await setLabel(w.harness, { rules: [{ account: 'acme', accountId: 'acc_ZZZZZZZZZZZZZZZZ', as: 'me' }] });
  assert.equal((await prepare(w, { channel: 'C1' })).label?.identity, 'agent');
});

// ── The workspace's style (the owner's decision, 2026-10-17) ─────────────────────────────────────────────────────

/** This workspace's style set to `labelled`, as `label style` writes it once the person has said yes. */
const chooseLabelled = (w: Labelled) => setLabel(w.harness, { slackStyles: { [w.accountId]: 'labelled' } });

const LABELLED_LINE =
  'Jo Example · labelled "Jo Example (agent):" at the start of the message · you chose labelled posts for this workspace';

test('the default style is app: with none recorded, or one this release cannot read, the app posts', async (t) => {
  const w = await labelled(t);
  assert.equal((await prepare(w, { channel: 'C1' })).label?.route, 'app');
  await setLabel(w.harness, { slackStyles: { [w.accountId]: 'fancy' } });
  assert.equal((await prepare(w, { channel: 'C1' })).label?.route, 'app', 'an unknown style was read as labelled');
  // Another workspace's choice is not this one's.
  await setLabel(w.harness, { slackStyles: { acc_ZZZZZZZZZZZZZZZZ: 'labelled' } });
  assert.equal((await prepare(w, { channel: 'C1' })).label?.route, 'app');
});

test('labelled: a public channel the app could post in goes as the person, labelled, naming the choice (S2, S7)', async (t) => {
  const w = await labelled(t);
  await chooseLabelled(w);
  const prepared = await prepare(w, { channel: 'C1' });
  assert.equal(prepared.label?.identity, 'agent');
  assert.equal(prepared.label?.route, 'fallback');
  assert.equal(prepared.label?.phrase, 'Jo Example (agent)');
  assert.equal(prepared.label?.icon, undefined, 'a post as the person carries no app icon');
  assert.equal(prepared.label?.reason, FALLBACK_REASONS.labelled);
  assert.equal(FALLBACK_REASONS.labelled, 'you chose labelled posts for this workspace');
  // S7: the first line names the reason, as the preview renders it.
  assert.equal(prepared.preview.postingAs, LABELLED_LINE);
  const from = renderChannelPreview(prepared.preview).split('\n')[1] ?? '';
  assert.match(from, /^From: +/);
  assert.equal(from.replace(/^From: +/, ''), LABELLED_LINE);
  assert.ok(
    (prepared.preview.warnings ?? []).some((warning) =>
      warning.includes('The app does not post it, because you chose labelled posts for this workspace.'),
    ),
    'the preview does not say why the app does not post it',
  );
  // A private room the app is in goes the same way, and nobody asked Slack whether the app is in it.
  const inside = await prepare(w, { channel: 'G1' });
  assert.equal(inside.label?.route, 'fallback');
  assert.equal(inside.label?.reason, FALLBACK_REASONS.labelled);
  assert.equal(w.fake.requests.filter((request) => request.method === 'conversations.members').length, 0);
  // A DM too: the person's choice decides it before the room does.
  assert.equal((await prepare(w, { channel: 'D1' })).label?.reason, FALLBACK_REASONS.labelled);
  // A post with files keeps its own reason: no style lets the app post files in this release.
  const docs = join(w.harness.home, 'docs');
  mkdirSync(docs);
  const path = join(docs, 'notes.txt');
  writeFileSync(path, 'the notes\n');
  const files = await prepare(w, { channel: 'C1', files: [realpathSync.native(path)] });
  assert.equal(files.label?.route, 'fallback');
  assert.equal(files.label?.reason, FALLBACK_REASONS.file);
  assert.deepEqual(posted(w), [], 'preparing posted something');
});

test('labelled: a workspace with no bot token goes the same way, for the same reason', async (t) => {
  const w = await labelled(t, { bot: false });
  await chooseLabelled(w);
  const prepared = await prepare(w, { channel: 'C1' });
  assert.equal(prepared.label?.route, 'fallback');
  assert.equal(prepared.label?.reason, FALLBACK_REASONS.labelled);
});

test('labelled: `as: "me"` is as it was — the person, unlabelled, its first line saying so (L3)', async (t) => {
  const w = await labelled(t);
  await chooseLabelled(w);
  const prepared = await prepare(w, { channel: 'C1', as: 'me' });
  assert.equal(prepared.label?.identity, 'me');
  assert.equal(prepared.label?.route, 'person');
  assert.equal(prepared.preview.postingAs, UNLABELLED_PREVIEW_LINE);
});

test('the style is bound: labelled chosen after the preview refuses the app post (S2)', async (t) => {
  await refusedAfter(t, 'C1', chooseLabelled);
});

test('the style is bound: app chosen after a labelled preview refuses the labelled post (S2)', async (t) => {
  const w = await labelled(t);
  await chooseLabelled(w);
  const prepared = await prepare(w, { channel: 'C1' });
  assert.equal(prepared.label?.route, 'fallback');
  // Back to app: a tightening, written at once.
  await w.harness.core.config.update((config) => ({ ...config, agentLabel: {} }));
  await assert.rejects(
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1' },
      w.slack,
    ),
    (error: CommsError) => {
      assert.match(error.code, /APPROVAL_VOID|INTEGRITY|APPROVAL/);
      return true;
    },
  );
  assert.deepEqual(posted(w), [], 'a post went out after its style changed');
});

// ── Doctor and the workspace's style ─────────────────────────────────────────────────────────────────────────────

/** What doctor says of the app, and what it offers, in one string: no step of any way to a bot token may be in it. */
const BOT_TOKEN_STEPS = [
  /workspace bot/,
  /workspace reauth/,
  /with-client-secret|client secret/,
  /manifest/,
  /no app bot token/,
  /Bot User OAuth Token/,
  /admin/,
];

test('labelled: doctor says posts go out as the person, labelled, by its choice, and offers no way to a bot token', async (t) => {
  const nonRotating = { refreshToken: undefined, refreshExpiresAt: undefined };
  const worlds: { name: string; make: () => Promise<Labelled> }[] = [
    { name: 'a PKCE app with no bot token', make: () => labelled(t, { bot: false }) },
    { name: 'one whose tokens do not rotate', make: () => labelled(t, { bot: false, bundle: nonRotating }) },
    {
      name: 'one connected with its client secret',
      make: async () => {
        const w = await labelled(t, { bot: false });
        await plant(w, { clientSecretRef: 'slack/client-secret/A0001' });
        return w;
      },
    },
    {
      name: 'one whose bot token Slack revoked',
      make: async () => {
        const w = await labelled(t, { bot: false });
        await plant(w, { appTokenRevoked: { at: '2026-10-16T09:00:00.000Z', slackError: 'token_revoked' } });
        return w;
      },
    },
    { name: 'one whose bot token is stored', make: () => labelled(t) },
  ];
  for (const { name, make } of worlds) {
    const w = await make();
    await chooseLabelled(w);
    const check = await appIdentityCheck(w);
    assert.equal(check?.status, 'ok', `${name}: ${check?.detail}`);
    assert.equal(check?.fix, null, `${name}: offered something to do`);
    assert.match(check?.detail ?? '', /you chose labelled posts for this workspace/, name);
    assert.match(check?.detail ?? '', /as you, labelled/, name);
    assert.doesNotMatch(check?.detail ?? '', /go out as the app/, name);
    const said = `${check?.detail} ${check?.fix}`;
    for (const step of [...BOT_TOKEN_STEPS, ...NEW_APP_STEPS]) assert.doesNotMatch(said, step, `${name}: ${said}`);
    // One finding about the app, as under app.
    const report = await runDoctor(w.harness.context({ platform: 'darwin' }), { offline: true });
    assert.equal(report.checks.filter((one) => one.id === 'app-identity').length, 1, name);
  }
});

test('app: doctor is as it was — chosen, unreadable or another workspace’s labelled, the same findings and steps', async (t) => {
  for (const styles of [
    (id: string) => ({ [id]: 'app' }),
    (id: string) => ({ [id]: 'fancy' }),
    (_id: string) => ({ acc_ZZZZZZZZZZZZZZZZ: 'labelled' }),
  ]) {
    const pkce = await labelled(t, { bot: false });
    await setLabel(pkce.harness, { slackStyles: styles(pkce.accountId) });
    const steps = await appIdentityCheck(pkce);
    assert.equal(steps?.status, 'warn');
    assert.match(steps?.detail ?? '', /no app bot token is stored for it/);
    assert.doesNotMatch(steps?.detail ?? '', /you chose labelled/);
    for (const step of NEW_APP_STEPS) assert.match(String(steps?.fix), step);

    const stored = await labelled(t);
    await setLabel(stored.harness, { slackStyles: styles(stored.accountId) });
    const app = await appIdentityCheck(stored);
    assert.equal(app?.status, 'ok');
    assert.match(app?.detail ?? '', /go out as the app \(bot user U0BOT0001\)/);
  }
});
