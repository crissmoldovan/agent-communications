import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { asV2, type CommsError, renderChannelPreview, UNLABELLED_PREVIEW_LINE } from '@agentcomms/core';
import { parseBundle } from '../src/auth/bundle.ts';
import { beginApproval } from '../src/operations/approve.ts';
import { doctor } from '../src/operations/doctor.ts';
import { FALLBACK_REASONS, noAppReason } from '../src/operations/label.ts';
import { prepareDraftPost, sendPost } from '../src/operations/post.ts';
import { type SlackWorld, startFakeSlack, type WorldRoom } from './support/fake-slack.ts';
import { slackHandoffs } from './support/handoffs.ts';
import { newHarness } from './support/harness.ts';

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
  } = {},
): Promise<Labelled> {
  const harness = await newHarness();
  const account = await harness.addWorkspace({
    alias: 'acme',
    mode: 'send',
    identity: 'agent',
    ...(options.bot === false ? {} : { bot: { userId: 'U0BOT0001' } }),
    ...(options.sendPolicy ? { sendPolicy: options.sendPolicy } : {}),
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
      paths: ['agentLabel.rules', 'agentLabel.word', 'agentLabel.name', 'agentLabel.slackIcons'],
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
    'Jo Example · labelled "Sent by Jo Example (agent)" · the app is not a member of this channel',
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
    assert.match(prepared.preview.postingAs, /^Jo Example · labelled "Sent by Jo Example \(agent\)" · /, channel);
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

test('a workspace connected before the label takes the fallback, and doctor says how to update its app (Review focus 1)', async (t) => {
  const w = await labelled(t, { bot: false });
  const prepared = await prepare(w, { channel: 'C1' });
  assert.equal(prepared.label?.identity, 'agent', 'a workspace with no bot went out unlabelled');
  assert.equal(prepared.label?.route, 'fallback');
  assert.equal(prepared.label?.reason, noAppReason('send'));

  const report = doctor({
    config: await w.harness.core.config.load(),
    now: new Date(),
    handoffs: slackHandoffs(),
    bundles: await bundlesOf(w),
  });
  const check = report.checks.find((one) => one.id === 'app-identity');
  assert.equal(check?.status, 'warn');
  assert.match(check?.detail ?? '', /no bot user/);
  assert.match(String(check?.fix), /manifest/);
  assert.match(String(check?.fix), /workspace reauth/);

  // With its bot user, the same check is ok.
  const with_ = await labelled(t);
  const ok = doctor({
    config: await with_.harness.core.config.load(),
    now: new Date(),
    handoffs: slackHandoffs(),
    bundles: await bundlesOf(with_),
  }).checks.find((one) => one.id === 'app-identity');
  assert.equal(ok?.status, 'ok');
});

/** The workspace's stored credential, as doctor is handed it. */
async function bundlesOf(w: Labelled) {
  const account = (await w.harness.core.config.load()).accounts.acme;
  const raw = await (await w.harness.core.secrets('file')).get(account?.secretRef ?? '');
  return new Map([['acme', parseBundle(raw, slackHandoffs())]]);
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
