import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { ackNotice, type CommsError, EXIT_CODES, fallbackTextPrefix, sha256Hex } from '@agentcomms/core';
import { escapeForSlack } from '../src/compose/blocks.ts';
import { appPostRecordFor } from '../src/operations/app-posts.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { prepareDraftPost, react, sendDelete, sendEdit, sendPost } from '../src/operations/post.ts';
import {
  acknowledge,
  beforeMint,
  betweenMintAndClaim,
  children,
  ledger,
  refused,
  type Standing,
  say,
  standing,
  tsAt,
} from './support/ack.ts';
import { setRules } from './support/behaviour.ts';
import { DROP, type WorldMessage } from './support/fake-slack.ts';
import {
  ANA,
  BOT,
  cli,
  ENG,
  EXTONLY,
  GENERAL,
  GRIDROOM,
  MIXED,
  MPIM,
  mcp,
  OUTSIDER,
  PARTNERS,
  PRIVATE,
  recordOf,
  SAM,
  SAM_DM,
  SELF,
  STRANGE,
  type StandingWorld,
  type StandingWorldOptions,
  standingWorld,
  VENDORS,
} from './support/standing.ts';

/**
 * Using a standing approval: `agent-slack ack` and `slack_ack` (design 2026-10-19-standing-approvals, S2–S10). The
 * agent chooses whether to acknowledge a message that has just arrived, and with which content the person wrote; it
 * never writes the words, and it cannot pick an old message, one among many, or a new place. Every guard here is the
 * gate's, refused before anything reaches Slack — against the loopback fake: nothing here reaches the real Slack.
 */

const REPLY = 'Got it, I will look at this.';
/** Every Slack method that puts something in front of people. */
const WRITES = ['chat.postMessage', 'reactions.add', 'reactions.remove', 'chat.update', 'chat.delete'];
/** A user `users.info` calls a bot, though nothing on the message says so. */
const HELPER = 'U0HELPER';

/**
 * The two ways Slack may mark a post this product made with the person's own token: not at all — `user` the person's,
 * no `bot_id`, no `app_id` — or with its app's `bot_id` and `app_id`. What the design read did not settle which Slack
 * does, so every test of such a post runs under both. Under the first, nothing on the message tells it apart: the
 * audit's record of what was sent, the app-posts record and the label at the start of its words are what refuse it.
 */
const USER_TOKEN_POSTS = [
  { shape: 'with no mark', marks: undefined },
  { shape: "marked with its app's bot_id and app_id", marks: { bot_id: 'B0ACMEAPP', app_id: 'A0ACMEAPP' } },
] as const;

function nothingSent(w: StandingWorld, what: string): void {
  for (const method of WRITES) assert.equal(w.requests(method).length, 0, `${what}: Slack was asked ${method}`);
}

/** STANDING_REFUSED with `reason`, exit 10, its hint saying to ask the person — and never how to widen it. */
function assertRefused(error: CommsError, reason: string, what: string): void {
  assert.equal(error.code, 'STANDING_REFUSED', `${what}: ${error.code} ${error.message}`);
  assert.equal(error.details?.reason, reason, `${what}: ${error.message}`);
  assert.equal(error.exitCode, EXIT_CODES.APPROVAL);
  assert.equal(error.retryable, false);
  assert.match(error.message, /^nothing was sent: /);
  assert.match(error.hint ?? '', /ask the person/i, `${what}: the hint does not say to ask the person`);
  assert.match(error.hint ?? '', /standing list|comms_standing/, `${what}: the hint names no standing list`);
  assert.doesNotMatch(error.hint ?? '', /standing add|slack_standing_add/, `${what}: the hint names a widening`);
}

async function world(t: TestContext, options: StandingWorldOptions = {}): Promise<StandingWorld> {
  const w = await standingWorld(t, { sendPolicy: 'chat', ...options });
  w.world.users[HELPER] = { display_name: 'helper', is_bot: true };
  // A bot's own B… id, which users.info answers here as a person: only its shape refuses it.
  w.world.users.B0HELPER = { display_name: 'helper' };
  // Slackbot is a `U…` that `users.info` does not call a bot.
  w.world.users.USLACKBOT = { real_name: 'Slackbot' };
  return w;
}

/** A standing approval for `#eng` alone: `eyes`, and one reply. */
function inEng(w: StandingWorld, over: Partial<Parameters<typeof standing>[1]> = {}): Promise<Standing> {
  return standing(w, { reactions: ['eyes'], replies: [REPLY], places: [ENG], ...over });
}

const withEyes = (s: Standing, channel: string, ts: string) => ({
  standingId: s.id,
  channel,
  ts,
  content: s.digest('reaction', 'eyes'),
});
const withReply = (s: Standing, channel: string, ts: string, text = REPLY) => ({
  standingId: s.id,
  channel,
  ts,
  content: s.digest('reply', text),
});

/** A thread in `channel` the person posted in themselves, half an hour ago: Ana started it an hour ago. */
function myThread(w: StandingWorld, channel: string): string {
  const parent = say(w, { channel, user: ANA, ago: 3_600_000, text: 'the deploy is stuck' });
  say(w, { channel, user: SELF, thread_ts: parent, ago: 1_800_000, text: 'I can take a look' });
  return parent;
}

async function accountId(w: StandingWorld): Promise<string> {
  return (await w.context.config()).accounts.acme?.id as string;
}

/** The person chooses labelled posts for this workspace: every agent act goes as them, labelled — never as the app. */
async function chooseLabelled(w: StandingWorld): Promise<void> {
  const id = await accountId(w);
  await w.core.config.update(
    (config) => {
      const label = ((config as { agentLabel?: Record<string, unknown> }).agentLabel ?? {}) as Record<string, unknown>;
      return { ...config, agentLabel: { ...label, slackStyles: { [id]: 'labelled' } } } as typeof config;
    },
    { consent: { kind: 'loosening-consent', paths: ['agentLabel.slackStyles'] } },
  );
}

// ── Send policy (S2) ───────────────────────────────────────────────────────────────────────────────────────────

test('under never a standing act is refused', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: ENG });
  await w.core.config.update((config) => {
    const acme = config.accounts.acme;
    if (acme === undefined) throw new Error('no acme');
    return { ...config, accounts: { ...config.accounts, acme: { ...acme, sendPolicy: 'never' } } };
  });
  const error = await refused(acknowledge(w, withEyes(s, ENG, ts)), 'under never');
  assert.equal(error.code, 'POLICY_NEVER');
  nothingSent(w, 'under never');
  assert.equal((await ledger(w)).uses.length, 0, 'a use was counted under never');
});

test('under confirm it goes with no code', async (t) => {
  const w = await world(t, { sendPolicy: 'confirm' });
  const s = await inEng(w);
  const ts = say(w, { channel: ENG });
  const done = await acknowledge(w, withEyes(s, ENG, ts));
  assert.equal(done.act, 'reaction');
  assert.deepEqual(w.world.reactions, [{ channel: ENG, ts, name: 'eyes', via: 'bot', remove: false }]);
  assert.equal(done.approval.state, 'used');
  assert.equal((await recordOf(w, done.approvalId)).state, 'used');
});

test('under chat the standing path refuses what S4 to S6 refuse', async (t) => {
  const w = await world(t, { sendPolicy: 'chat' });
  const s = await inEng(w, { perHour: 1 });
  const stale = say(w, { channel: ENG, ago: 16 * 60_000 });
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, stale)), 'stale'), 'not-fresh', 'a stale message');

  const first = say(w, { channel: ENG, ago: 5_000 });
  await acknowledge(w, withEyes(s, ENG, first));
  w.clock.now += 60_000;
  const second = say(w, { channel: ENG, user: ANA });
  const limited = await refused(acknowledge(w, withEyes(s, ENG, second)), 'over the hour');
  assert.equal(limited.code, 'STANDING_LIMIT');
  assert.equal(limited.details?.limit, 'perHour');
  assert.equal(limited.details?.allowed, 1);
  assert.equal(typeof limited.details?.freesAt, 'string');
  assert.equal(w.requests('reactions.add').length, 1, 'only the first went');
});

// ── Which messages (S4) ────────────────────────────────────────────────────────────────────────────────────────

test('a message older than the standing approval is refused', async (t) => {
  const w = await world(t);
  // Said a moment before the standing approval was made: within fifteen minutes, but not after it.
  const ts = say(w, { channel: ENG, ago: 1_000 });
  const s = await inEng(w);
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, ts)), 'older'), 'not-fresh', 'older than it');
  nothingSent(w, 'older than it');
});

test('a message older than fifteen minutes is refused', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  w.clock.now += 20 * 60_000;
  // After the standing approval was made, and sixteen minutes ago.
  const ts = say(w, { channel: ENG, ago: 16 * 60_000 });
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, ts)), 'old'), 'not-fresh', 'sixteen minutes old');
  // Fourteen minutes ago it is still fresh, and the newest: it goes.
  const recent = say(w, { channel: ENG, user: ANA, ago: 14 * 60_000 });
  assert.equal((await acknowledge(w, withEyes(s, ENG, recent))).act, 'reaction');
});

test('a message that is not the newest from someone else in its thread is refused', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const parent = say(w, { channel: ENG, user: ANA, ago: 60_000 });
  const ts = say(w, { channel: ENG, thread_ts: parent, ago: 20_000 });
  say(w, { channel: ENG, user: ANA, thread_ts: parent, ago: 10_000, text: 'never mind, fixed' });
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, ts)), 'thread'), 'not-newest', 'in its thread');
  nothingSent(w, 'not newest in its thread');
  assert.equal((await ledger(w)).uses.length, 0, 'counted before it was found not the newest');
});

test('a message that is not the newest from someone else in its channel is refused', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: ENG, ago: 20_000 });
  say(w, { channel: ENG, user: ANA, ago: 10_000, text: 'also, lunch?' });
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, ts)), 'channel'), 'not-newest', 'in its channel');
  assert.equal((await ledger(w)).uses.length, 0, 'counted before it was found not the newest');
});

test('a message is the newest when only this account and its app have spoken since', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: ENG, ago: 30_000 });
  say(w, { channel: ENG, user: SELF, ago: 20_000, text: 'looking' });
  const app = say(w, { channel: ENG, user: BOT, bot_id: 'B0BOT0001', ago: 10_000, via: 'bot', text: 'noted' });
  await appPostRecordFor(w.core.paths.stateDir, await accountId(w)).add({
    channel: ENG,
    ts: app,
    approvalId: `ap_${'2'.repeat(26)}`,
    at: new Date(w.clock.now).toISOString(),
  });
  const done = await acknowledge(w, withEyes(s, ENG, ts));
  assert.equal(done.act, 'reaction');
});

interface Flaw {
  readonly name: string;
  readonly reason: 'not-human' | 'interactive';
  readonly message: Partial<WorldMessage>;
  /** The message is in this account's own record of what its app posted. */
  readonly appPost?: boolean;
  /**
   * Refused on the acknowledged message only: a thread's parent may be the person's own, which the tests of threads
   * the person started try on their own.
   */
  readonly messageOnly?: boolean;
}

/** Each way S4's allow-list refuses a message, tried on the message and on its thread's parent. */
const FLAWS: readonly Flaw[] = [
  { name: 'a bot_id', reason: 'not-human', message: { bot_id: 'B0HELPER' } },
  { name: 'an app_id', reason: 'not-human', message: { app_id: 'A0HELPER' } },
  { name: 'a bot_profile', reason: 'not-human', message: { bot_profile: { id: 'B0HELPER', name: 'helper' } } },
  { name: 'a subtype', reason: 'not-human', message: { subtype: 'bot_message' } },
  { name: 'a user starting B', reason: 'not-human', message: { user: 'B0HELPER' } },
  { name: 'a user users.info calls a bot', reason: 'not-human', message: { user: HELPER } },
  { name: 'Slackbot', reason: 'not-human', message: { user: 'USLACKBOT' } },
  { name: 'this account', reason: 'not-human', message: { user: SELF }, messageOnly: true },
  { name: "a message in this account's app-posts record", reason: 'not-human', message: {}, appPost: true },
  {
    name: 'a button',
    reason: 'interactive',
    message: {
      blocks: [
        {
          type: 'actions',
          elements: [{ type: 'button', text: { type: 'plain_text', text: 'Approve' }, action_id: 'approve' }],
        },
      ],
    },
  },
  {
    name: 'a select',
    reason: 'interactive',
    message: {
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Which environment?' },
          accessory: { type: 'static_select', action_id: 'environment', options: [] },
        },
      ],
    },
  },
  {
    name: "a workflow's message",
    reason: 'interactive',
    message: { bot_profile: { id: 'B0FLOW', name: 'Deploy request', is_workflow_bot: true } },
  },
  // The allow-list (the lead's call, after review): what a deny-list of names missed, and what Slack adds tomorrow.
  {
    name: 'context_actions with feedback_buttons',
    reason: 'interactive',
    message: {
      blocks: [
        {
          type: 'context_actions',
          elements: [
            {
              type: 'feedback_buttons',
              action_id: 'feedback',
              positive_button: { text: { type: 'plain_text', text: 'Good' }, value: 'good' },
              negative_button: { text: { type: 'plain_text', text: 'Bad' }, value: 'bad' },
            },
          ],
        },
      ],
    },
  },
  {
    name: 'an icon_button',
    reason: 'interactive',
    message: {
      blocks: [
        {
          type: 'context_actions',
          elements: [
            { type: 'icon_button', icon: 'trash', text: { type: 'plain_text', text: 'Delete' }, action_id: 'x' },
          ],
        },
      ],
    },
  },
  {
    name: 'a context holding an icon_button',
    reason: 'interactive',
    message: {
      blocks: [
        {
          type: 'context',
          elements: [
            { type: 'icon_button', icon: 'trash', text: { type: 'plain_text', text: 'Delete' }, action_id: 'x' },
          ],
        },
      ],
    },
  },
  {
    name: 'a block type this release does not know',
    reason: 'interactive',
    message: { blocks: [{ type: 'approval_card', text: { type: 'mrkdwn', text: 'Approve the deploy?' } }] },
  },
  {
    name: 'a section with an overflow menu',
    reason: 'interactive',
    message: {
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Deploy?' },
          accessory: { type: 'overflow', action_id: 'more', options: [] },
        },
      ],
    },
  },
  {
    name: "a legacy attachment's own blocks with a button",
    reason: 'interactive',
    message: {
      attachments: [
        {
          blocks: [
            {
              type: 'actions',
              elements: [{ type: 'button', text: { type: 'plain_text', text: 'Go' }, action_id: 'go' }],
            },
          ],
        },
      ],
    },
  },
];

for (const flaw of FLAWS) {
  for (const where of flaw.messageOnly === true ? (['message'] as const) : (['message', 'parent'] as const)) {
    const on = where === 'message' ? 'the message' : "its thread's parent";
    test(`${flaw.name} on ${on} is refused: ${flaw.reason}`, async (t) => {
      const w = await world(t);
      const s = await inEng(w);
      let flawed: string;
      let ts: string;
      if (where === 'message') {
        ts = say(w, { channel: ENG, ...flaw.message });
        flawed = ts;
      } else {
        flawed = say(w, { channel: ENG, ago: 60_000, ...flaw.message });
        ts = say(w, { channel: ENG, thread_ts: flawed });
      }
      if (flaw.appPost === true) {
        await appPostRecordFor(w.core.paths.stateDir, await accountId(w)).add({
          channel: ENG,
          ts: flawed,
          approvalId: `ap_${'3'.repeat(26)}`,
          at: new Date(w.clock.now).toISOString(),
        });
      }
      for (const request of [withEyes(s, ENG, ts), withReply(s, ENG, ts)]) {
        assertRefused(await refused(acknowledge(w, request), flaw.name), flaw.reason, `${flaw.name} on ${on}`);
      }
      nothingSent(w, `${flaw.name} on ${on}`);
      assert.equal((await ledger(w)).uses.length, 0, 'a refused act was counted');
    });
  }
}

test('a message whose blocks only show something is acknowledged: the allow-list holds what people write', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, {
    channel: ENG,
    blocks: [
      {
        type: 'rich_text',
        block_id: 'a1',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'can someone look at ', style: { bold: true } },
              { type: 'link', url: 'https://example.test/deploy', text: 'the deploy' },
              { type: 'emoji', name: 'eyes' },
              { type: 'user', user_id: SELF },
            ],
          },
          {
            type: 'rich_text_list',
            style: 'bullet',
            elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'one' }] }],
          },
          { type: 'rich_text_quote', elements: [{ type: 'text', text: 'quoted' }] },
          { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'npm test' }] },
        ],
      },
      { type: 'header', text: { type: 'plain_text', text: 'Deploy' } },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Status*' },
        fields: [{ type: 'plain_text', text: 'stuck' }],
        accessory: { type: 'image', image_url: 'https://example.test/a.png', alt_text: 'a graph' },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'by Sam' },
          { type: 'image', image_url: 'https://example.test/b.png', alt_text: 'Sam' },
        ],
      },
      { type: 'image', image_url: 'https://example.test/c.png', alt_text: 'the log' },
    ],
  });
  assert.equal((await acknowledge(w, withEyes(s, ENG, ts))).act, 'reaction');
});

test('a U user with a bot_profile is not human', async (t) => {
  // Another agent's bot: a `U…` user that `users.info` does not call a bot, with the bot_profile its app gives it.
  const w = await world(t);
  w.world.users.U0OTHERAGENT = { display_name: 'Other team agent' };
  const s = await inEng(w);
  const ts = say(w, {
    channel: ENG,
    user: 'U0OTHERAGENT',
    bot_profile: { id: 'B0OTHER', app_id: 'A0OTHER', name: 'Other team agent' },
    text: 'Got it, I will look at this.',
  });
  assertRefused(await refused(acknowledge(w, withReply(s, ENG, ts)), 'other agent'), 'not-human', 'a U user bot');
  nothingSent(w, 'another agent');
});

// ── Threads the person started (S4, the lead's call after build) ────────────────────────────────────────────────

const DAY = 86_400_000;

test('a thread the person started may be acknowledged', async (t) => {
  // The thread's parent is the person's own, posted by them: the message acknowledged is still another person's.
  const w = await world(t);
  const s = await inEng(w);
  const started = say(w, { channel: ENG, user: SELF, ago: 120_000, text: 'deploying at noon, shout if not' });
  const answer = say(w, { channel: ENG, thread_ts: started, ago: 20_000 });
  assert.equal((await acknowledge(w, withEyes(s, ENG, answer))).act, 'reaction');
  const other = say(w, { channel: ENG, user: SELF, ago: 90_000, text: 'the new build is out' });
  const question = say(w, { channel: ENG, user: ANA, thread_ts: other, ago: 10_000 });
  assert.equal((await acknowledge(w, withReply(s, ENG, question))).act, 'reply');
  assert.equal(w.requests('chat.postMessage').at(-1)?.params.get('thread_ts'), other);
  assert.equal(w.world.reactions.length, 1);
});

for (const { shape, marks } of USER_TOKEN_POSTS) {
  test(`a thread this product started for the person, or an app with their token, is not theirs: ${shape}`, async (t) => {
    const w = await world(t, marks === undefined ? {} : { userTokenMarks: marks });
    const s = await standing(w, { reactions: ['eyes'], replies: [REPLY], places: [ENG, PRIVATE] });
    // Posted by this product as the person, labelled — the app is not in #private — so in the audit, not in app-posts.
    const prepared = await prepareDraftPost(w.context, 'acme', { channel: PRIVATE, text: 'notes are up' }, w.slack);
    await sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: PRIVATE },
      w.slack,
    );
    const sent = w.world.messages.at(-1);
    assert.equal(sent?.user, SELF, 'the product posted as the person');
    assert.equal(sent?.bot_id, marks?.bot_id, `the post is ${shape}`);
    assert.equal(sent?.app_id, marks?.app_id, `the post is ${shape}`);
    w.clock.now += 1_000;
    const onSent = say(w, { channel: PRIVATE, thread_ts: sent?.ts, ago: 500 });

    // The person's message in this account's own app-posts record.
    const recorded = say(w, { channel: ENG, user: SELF, ago: 120_000, text: 'On it' });
    await appPostRecordFor(w.core.paths.stateDir, await accountId(w)).add({
      channel: ENG,
      ts: recorded,
      approvalId: `ap_${'5'.repeat(26)}`,
      at: new Date(w.clock.now).toISOString(),
    });
    const onRecorded = say(w, { channel: ENG, thread_ts: recorded, ago: 400 });
    // The person's user id on a message another app made with their token, which Slack marked with that app's bot_id.
    const appMade = say(w, { channel: ENG, user: SELF, bot_id: 'B0OTHERAPP', ago: 100_000, text: 'Logged' });
    const onAppMade = say(w, { channel: ENG, thread_ts: appMade, ago: 300 });

    const posts = w.requests('chat.postMessage').length;
    for (const [what, request] of [
      ['a parent this product sent as the person', withReply(s, PRIVATE, onSent)],
      ['a parent in the app-posts record', withEyes(s, ENG, onRecorded)],
      ['a parent in the app-posts record, replied to', withReply(s, ENG, onRecorded)],
      ['a parent an app made with their token', withEyes(s, ENG, onAppMade)],
    ] as const) {
      assertRefused(await refused(acknowledge(w, request), what), 'not-human', what);
    }
    assert.equal(w.requests('chat.postMessage').length, posts, 'a refused act posted');
    assert.equal(w.world.reactions.length, 0, 'a refused act reacted');
    assert.equal((await ledger(w)).uses.length, 0, 'a refused act was counted');
  });
}

test('a message that begins as an agent’s labelled post is never a person’s, whoever’s agent it was', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  // Another person's agent, posting as them with their token, labelled: no marker Slack sets says so.
  const theirAgent = say(w, { channel: ENG, text: `${escapeForSlack(fallbackTextPrefix('Sam Lee (agent)'))}On it` });
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, theirAgent)), 'their agent'), 'not-human', 'their agent');
  // Any label word, in any case, and a post with no words.
  for (const text of ['Sam (assistant): looking', 'sam (AI): done', 'Sent by Sam (bot)']) {
    w.clock.now += 1_000;
    const ts = say(w, { channel: ENG, text });
    assertRefused(await refused(acknowledge(w, withEyes(s, ENG, ts)), text), 'not-human', text);
  }
  // As a thread's first message: another's agent, or this product's labelled post as the person that no record holds.
  for (const [user, text] of [
    [SAM, 'Sam Lee (agent): the deploy is stuck'],
    [SELF, `${escapeForSlack(fallbackTextPrefix('Jo Example (agent)'))}deploying at noon`],
  ] as const) {
    w.clock.now += 1_000;
    const parent = say(w, { channel: ENG, user, text, ago: 60_000 });
    const ts = say(w, { channel: ENG, user: ANA, thread_ts: parent });
    assertRefused(await refused(acknowledge(w, withEyes(s, ENG, ts)), text), 'not-human', `a parent: ${text}`);
  }
  nothingSent(w, 'labelled posts');
  assert.equal((await ledger(w)).uses.length, 0);
});

test('the person’s post an app made, labelled, or this product sent under an old account, is not theirs', async (t) => {
  const w = await world(t);
  const anywhere = await standing(w, { reactions: ['eyes'], places: 'threads-i-am-in' });
  const exact = await standing(w, { reactions: ['eyes'], places: [ENG] });
  // Under threads-i-am-in, the person's only post in a thread, with each of the four marks or a label: not theirs.
  for (const [what, marks] of [
    ['an app_id', { app_id: 'A0OTHERAPP' }],
    ['a subtype', { subtype: 'thread_broadcast' }],
    ['a bot_profile', { bot_profile: { id: 'B0OTHER', name: 'logger' } }],
    ['a bot_id', { bot_id: 'B0OTHER' }],
    ['a label', { text: 'Jo Example (agent): I can take a look' }],
  ] as const) {
    w.clock.now += 1_000;
    const parent = say(w, { channel: ENG, user: ANA, ago: 600_000 });
    say(w, { channel: ENG, user: SELF, thread_ts: parent, ago: 300_000, text: 'I can take a look', ...marks });
    const ts = say(w, { channel: ENG, thread_ts: parent, ago: 5_000 });
    assertRefused(await refused(acknowledge(w, withEyes(anywhere, ENG, ts)), what), 'place-not-covered', what);
  }

  /*
   * This product's posts for the person under an account the workspace had before it was removed and added again:
   * the audit names the old account id, and — written by this release — the person's Slack user id and team; written
   * by an earlier release, neither. Each is this product's, not the person's.
   */
  const OLD = 'acc_OLDOLDOLDOLDOLDO';
  const posted = async (ids: Record<string, string>) =>
    w.core.audit.append({ inboxId: OLD, alias: 'acme', operation: 'slack.post', outcome: 'ok', ids });
  for (const [what, extra] of [
    ['recorded with the person and team', { user: SELF, team: w.world.teamId }],
    ['recorded by an earlier release', {}],
  ] as const) {
    w.clock.now += 1_000;
    // As a thread's first message.
    const parent = say(w, { channel: ENG, user: SELF, ago: 120_000, text: 'notes are up' });
    await posted({ channel: ENG, ts: parent, ...extra });
    const onParent = say(w, { channel: ENG, user: ANA, thread_ts: parent, ago: 5_000 });
    assertRefused(await refused(acknowledge(w, withEyes(exact, ENG, onParent)), what), 'not-human', `parent ${what}`);
    // As the person's post in a thread, under threads-i-am-in.
    w.clock.now += 1_000;
    const thread = say(w, { channel: ENG, user: ANA, ago: 600_000 });
    const mine = say(w, { channel: ENG, user: SELF, thread_ts: thread, ago: 300_000, text: 'on it' });
    await posted({ channel: ENG, ts: mine, ...extra });
    const inThread = say(w, { channel: ENG, thread_ts: thread, ago: 5_000 });
    assertRefused(
      await refused(acknowledge(w, withEyes(anywhere, ENG, inThread)), what),
      'place-not-covered',
      `post ${what}`,
    );
  }
  nothingSent(w, 'not the person’s');
  assert.equal((await ledger(w)).uses.length, 0);
});

test('a post this product makes records whom it was for: the person’s Slack id and team', async (t) => {
  const w = await world(t);
  const prepared = await prepareDraftPost(w.context, 'acme', { channel: PRIVATE, text: 'notes are up' }, w.slack);
  await sendPost(
    w.context,
    'acme',
    { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: PRIVATE },
    w.slack,
  );
  const [record] = (await w.core.audit.tail({ limit: 100 })).filter(
    (each) => each.operation === 'slack.post' && each.outcome === 'ok',
  );
  assert.equal(record?.ids?.user, SELF);
  assert.equal(record?.ids?.team, w.world.teamId);
});

test('a parent of the person’s whose ts cannot be read as a time is refused, not a crash', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const parent = 'not-a-ts';
  w.world.messages.push({ channel: ENG, ts: parent, user: SELF, via: 'user', text: 'deploying at noon' });
  const ts = say(w, { channel: ENG, thread_ts: parent });
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, ts)), 'odd ts'), 'not-human', 'an unreadable ts');
  nothingSent(w, 'an unreadable ts');
});

for (const { shape, marks } of USER_TOKEN_POSTS) {
  test(`a thread this product started for the person weeks ago is still not theirs: ${shape}`, async (t) => {
    // Older than threads-i-am-in looks back: what this product sent is read from the audit as far back as the parent.
    const w = await world(t, marks === undefined ? {} : { userTokenMarks: marks });
    w.clock.now -= 20 * DAY;
    const prepared = await prepareDraftPost(w.context, 'acme', { channel: PRIVATE, text: 'notes are up' }, w.slack);
    await sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: PRIVATE },
      w.slack,
    );
    const sent = w.world.messages.at(-1);
    assert.equal(sent?.user, SELF, 'the product posted as the person');
    assert.equal(sent?.bot_id, marks?.bot_id, `the post is ${shape}`);
    w.clock.now += 20 * DAY;
    const s = await standing(w, { replies: [REPLY], places: [PRIVATE] });
    const late = say(w, { channel: PRIVATE, thread_ts: sent?.ts, ago: 10_000 });
    const posts = w.requests('chat.postMessage').length;
    assertRefused(await refused(acknowledge(w, withReply(s, PRIVATE, late)), 'weeks ago'), 'not-human', 'weeks ago');
    assert.equal(w.requests('chat.postMessage').length, posts, 'a refused act posted');
    assert.equal((await ledger(w)).uses.length, 0, 'a refused act was counted');
  });
}

test('a thread already acknowledged under another standing approval', async (t) => {
  const w = await world(t);
  const first = await inEng(w);
  const second = await inEng(w, { reactions: ['raised_hands'], replies: [] });
  const parent = say(w, { channel: ENG, user: ANA, ago: 120_000 });
  const ts = say(w, { channel: ENG, thread_ts: parent });
  await acknowledge(w, withReply(first, ENG, ts));
  // The same message, under the other standing approval.
  assertRefused(
    await refused(
      acknowledge(w, { standingId: second.id, channel: ENG, ts, content: second.digest('reaction', 'raised_hands') }),
      'again',
    ),
    'already-acknowledged',
    'the same message',
  );
  // A new message in the same thread: once per thread, across every standing approval.
  w.clock.now += 1_000;
  const next = say(w, { channel: ENG, user: ANA, thread_ts: parent, ago: 500 });
  const limited = await refused(
    acknowledge(w, {
      standingId: second.id,
      channel: ENG,
      ts: next,
      content: second.digest('reaction', 'raised_hands'),
    }),
    'same thread',
  );
  assert.equal(limited.code, 'STANDING_LIMIT');
  assert.equal(limited.details?.limit, 'perThread');
  assert.equal(limited.details?.freesAt, null);
  assert.equal(w.requests('chat.postMessage').length, 1);
  assert.equal(w.requests('reactions.add').length, 0);
});

test('two acknowledgements at once cannot both acknowledge one thread, under two standing approvals', async (t) => {
  const w = await world(t);
  const first = await inEng(w);
  const second = await inEng(w, { reactions: ['raised_hands'], replies: [] });
  const ts = say(w, { channel: ENG });
  const outcomes = await Promise.allSettled([
    acknowledge(w, withEyes(first, ENG, ts)),
    acknowledge(w, { standingId: second.id, channel: ENG, ts, content: second.digest('reaction', 'raised_hands') }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
  assert.equal((rejected.reason as CommsError).details?.reason, 'already-acknowledged');
  assert.equal(w.world.reactions.length, 1, 'acknowledged twice');
  assert.equal((await ledger(w)).uses.length, 1);
});

// ── Places (S5) ────────────────────────────────────────────────────────────────────────────────────────────────

test('a reply always goes in a thread', async (t) => {
  const w = await world(t);
  const s = await inEng(w, { perThread: 1 });
  // A message outside any thread: the reply starts its thread.
  const alone = say(w, { channel: ENG, ago: 30_000 });
  await acknowledge(w, withReply(s, ENG, alone));
  // A reply in a thread: the acknowledgement goes in that thread, not under the reply.
  const parent = say(w, { channel: ENG, user: ANA, ago: 20_000 });
  const inThread = say(w, { channel: ENG, thread_ts: parent, ago: 10_000 });
  await acknowledge(w, withReply(s, ENG, inThread));
  const posts = w.requests('chat.postMessage');
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((post) => post.params.get('thread_ts')),
    [alone, parent],
    'every reply carries the thread it goes in',
  );
});

for (const { shape, marks } of USER_TOKEN_POSTS) {
  test(`a thread whose only message from the person this product sent does not count: ${shape}`, async (t) => {
    const w = await world(t, { sendPolicy: 'chat', ...(marks === undefined ? {} : { userTokenMarks: marks }) });
    const s = await standing(w, { replies: [REPLY], places: 'threads-i-am-in' });
    // The person's only message in this thread is one this product sent as them, labelled — in the audit, not in the
    // app-posts record: the app is not in #private, so it went with the person's token.
    const parent = say(w, { channel: PRIVATE, user: ANA, ago: 3_600_000 });
    const prepared = await prepareDraftPost(
      w.context,
      'acme',
      { channel: PRIVATE, text: 'on it', threadTs: parent },
      w.slack,
    );
    await sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: PRIVATE },
      w.slack,
    );
    const sent = w.world.messages.at(-1);
    assert.equal(sent?.user, SELF, 'the product posted as the person');
    assert.equal(sent?.bot_id, marks?.bot_id, `the post is ${shape}`);
    assert.equal(sent?.app_id, marks?.app_id, `the post is ${shape}`);
    w.clock.now += 1_000;
    const ts = say(w, { channel: PRIVATE, user: SAM, thread_ts: parent, ago: 500 });
    assertRefused(
      await refused(acknowledge(w, withReply(s, PRIVATE, ts)), 'product only'),
      'place-not-covered',
      'a thread the product posted in',
    );

    // A thread the person really posted in counts.
    const theirs = myThread(w, PRIVATE);
    const target = say(w, { channel: PRIVATE, thread_ts: theirs, ago: 400 });
    const done = await acknowledge(w, withReply(s, PRIVATE, target));
    assert.equal(done.act, 'reply');
  });
}

test('a thread where the person is only mentioned, or posted more than 14 days ago, does not count', async (t) => {
  const w = await world(t);
  const s = await standing(w, { reactions: ['eyes'], places: 'threads-i-am-in' });
  const mentioned = say(w, { channel: ENG, user: ANA, ago: 600_000, text: '<@U0001> can you look at this?' });
  const inMentioned = say(w, { channel: ENG, thread_ts: mentioned, ago: 30_000 });
  assertRefused(
    await refused(acknowledge(w, withEyes(s, ENG, inMentioned)), 'mention'),
    'place-not-covered',
    'mentioned only',
  );

  const old = say(w, { channel: ENG, user: ANA, ago: 20 * 86_400_000 });
  say(w, { channel: ENG, user: SELF, thread_ts: old, ago: 15 * 86_400_000, text: 'I can take a look' });
  const inOld = say(w, { channel: ENG, thread_ts: old, ago: 20_000 });
  assertRefused(
    await refused(acknowledge(w, withEyes(s, ENG, inOld)), 'old'),
    'place-not-covered',
    'posted 15 days ago',
  );
  // The person's own user id, on a message another app made with their token and Slack marked with its bot_id, is not
  // them. (Whether Slack marks one this product made is not settled: the tests above run both ways.)
  const appMade = say(w, { channel: ENG, user: ANA, ago: 500_000 });
  say(w, { channel: ENG, user: SELF, bot_id: 'B0OTHERAPP', thread_ts: appMade, ago: 400_000, text: 'Logged' });
  const inAppMade = say(w, { channel: ENG, thread_ts: appMade, ago: 15_000 });
  assertRefused(
    await refused(acknowledge(w, withEyes(s, ENG, inAppMade)), 'bot_id'),
    'place-not-covered',
    'the person’s message an app made',
  );
  // Nor is a message of theirs this account's own app-posts record holds.
  const recorded = say(w, { channel: ENG, user: ANA, ago: 300_000 });
  const theirs = say(w, { channel: ENG, user: SELF, thread_ts: recorded, ago: 200_000, text: 'On it' });
  await appPostRecordFor(w.core.paths.stateDir, await accountId(w)).add({
    channel: ENG,
    ts: theirs,
    approvalId: `ap_${'4'.repeat(26)}`,
    at: new Date(w.clock.now).toISOString(),
  });
  const inRecorded = say(w, { channel: ENG, thread_ts: recorded, ago: 12_000 });
  assertRefused(
    await refused(acknowledge(w, withEyes(s, ENG, inRecorded)), 'app-posts'),
    'place-not-covered',
    'the person’s message in the app-posts record',
  );
  // Thirteen days ago still counts.
  const recent = say(w, { channel: ENG, user: ANA, ago: 14 * 86_400_000 });
  say(w, { channel: ENG, user: SELF, thread_ts: recent, ago: 13 * 86_400_000, text: 'I can take a look' });
  const inRecent = say(w, { channel: ENG, thread_ts: recent, ago: 10_000 });
  assert.equal((await acknowledge(w, withEyes(s, ENG, inRecent))).act, 'reaction');
});

test('a reaction outside a qualifying thread is refused', async (t) => {
  const w = await world(t);
  const s = await standing(w, { reactions: ['eyes'], places: 'threads-i-am-in' });
  myThread(w, ENG);
  const alone = say(w, { channel: ENG });
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, alone)), 'alone'), 'place-not-covered', 'no thread');
  nothingSent(w, 'outside a thread');
});

test('a place this standing approval does not name is refused', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: GRIDROOM });
  assertRefused(
    await refused(acknowledge(w, withEyes(s, GRIDROOM, ts)), 'elsewhere'),
    'place-not-covered',
    'elsewhere',
  );
});

test('a place narrowed away while Slack is read is refused at the mint, and nothing is counted', async (t) => {
  for (const act of ['reaction', 'reply'] as const) {
    const w = await world(t);
    const s = await inEng(w, { places: [ENG, GRIDROOM] });
    const ts = say(w, { channel: ENG });
    // Every read found #eng covered; the person keeps only #grid before the mint.
    beforeMint(w, async () => {
      await w.core.approvals.narrowStanding(s.id, await accountId(w), { places: [GRIDROOM] });
    });
    const request = act === 'reaction' ? withEyes(s, ENG, ts) : withReply(s, ENG, ts);
    assertRefused(await refused(acknowledge(w, request), act), 'place-not-covered', `${act} narrowed away`);
    nothingSent(w, `${act} narrowed away`);
    assert.equal((await ledger(w)).uses.length, 0, `${act}: a refused act was counted`);
    assert.equal((await children(w)).length, 0, `${act}: a child was minted`);
  }
});

test('50 or more members not approved so, an unreadable count, and an exact place grown to 50 are each refused', async (t) => {
  const w = await world(t);
  // threads-i-am-in, in a room of 61.
  const anywhere = await standing(w, { reactions: ['eyes'], places: 'threads-i-am-in' });
  const big = say(w, { channel: GENERAL, thread_ts: myThread(w, GENERAL) });
  assertRefused(await refused(acknowledge(w, withEyes(anywhere, GENERAL, big)), 'big'), 'big-room', 'a big room');

  // Named exactly at 61, it is allowed: the person saw its count.
  const named = await standing(w, { reactions: ['eyes'], places: [GENERAL] });
  const inGeneral = say(w, { channel: GENERAL, user: ANA });
  assert.equal((await acknowledge(w, withEyes(named, GENERAL, inGeneral))).act, 'reaction');

  // Named at 4, and grown to 54 since.
  const small = await inEng(w);
  const room = w.world.rooms[ENG];
  if (room === undefined) throw new Error('no #eng');
  for (let index = 0; index < 50; index += 1) {
    const member = `U0N${String(index).padStart(3, '0')}`;
    w.world.users[member] = { display_name: member };
    room.members.push(member);
  }
  const grown = say(w, { channel: ENG });
  assertRefused(await refused(acknowledge(w, withEyes(small, ENG, grown)), 'grown'), 'big-room', 'grown to 54');

  // A count that cannot be read.
  w.world.rooms[ENG] = { ...room, num_members: null, members_unreadable: true };
  assertRefused(
    await refused(acknowledge(w, withEyes(small, ENG, grown)), 'unreadable'),
    'count-unreadable',
    'an unreadable count',
  );
  // A place that cannot be read at all.
  delete w.world.rooms[ENG];
  assertRefused(
    await refused(acknowledge(w, withEyes(small, ENG, grown)), 'gone'),
    'count-unreadable',
    'a place that cannot be read',
  );
  assert.deepEqual(
    w.world.reactions.map((reaction) => reaction.channel),
    [GENERAL],
    'only #general was acknowledged',
  );
  assert.equal((await ledger(w)).uses.length, 1, 'a refused room was counted');
});

test('another team_id, is_stranger or is_ext_shared refuses', async (t) => {
  const w = await world(t);
  const s = await standing(w, { reactions: ['eyes'], places: 'threads-i-am-in' });
  for (const [channel, what] of [
    [MIXED, 'an outsider'],
    [STRANGE, 'a stranger'],
    [EXTONLY, 'is_ext_shared'],
    [VENDORS, 'is_pending_ext_shared'],
  ] as const) {
    const ts = say(w, { channel, thread_ts: myThread(w, channel) });
    assertRefused(await refused(acknowledge(w, withEyes(s, channel, ts)), what), 'external', what);
  }
  nothingSent(w, 'another organisation');
});

test('a guest in the place, or a guest or another team writing, is someone from another organisation', async (t) => {
  const GUESTS = 'C0GUESTS';
  const SOLO = 'C0SOLO';
  const GUEST = 'U0GUEST';
  const SINGLE = 'U0SINGLE';
  const w = await world(t);
  w.world.users[GUEST] = { display_name: 'Gus', is_restricted: true };
  w.world.users[SINGLE] = { display_name: 'Sol', is_ultra_restricted: true };
  w.world.rooms[GUESTS] = { name: 'guests', members: [SELF, SAM, GUEST, BOT] };
  w.world.rooms[SOLO] = { name: 'solo', members: [SELF, SAM, SINGLE, BOT] };
  // In the room: a multi-channel guest, or a single-channel one, under threads-i-am-in.
  const anywhere = await standing(w, { reactions: ['eyes'], places: 'threads-i-am-in' });
  for (const [room, what] of [
    [GUESTS, 'a multi-channel guest'],
    [SOLO, 'a single-channel guest'],
  ] as const) {
    const ts = say(w, { channel: room, thread_ts: myThread(w, room) });
    assertRefused(await refused(acknowledge(w, withEyes(anywhere, room, ts)), what), 'external', what);
  }
  // Named exactly with nobody from outside, and a guest has joined since.
  const exact = await inEng(w);
  w.world.users[GUEST] = { display_name: 'Gus', is_restricted: true };
  w.world.rooms[ENG]?.members.push(GUEST);
  const joined = say(w, { channel: ENG });
  assertRefused(
    await refused(acknowledge(w, withEyes(exact, ENG, joined)), 'joined'),
    'shared-state-changed',
    'joined',
  );

  // A big room named exactly, whose members are not read one by one: who wrote it is read instead.
  const big = await standing(w, { reactions: ['eyes'], places: [GENERAL] });
  for (const [what, message] of [
    ['a guest writing', { user: GUEST }],
    ['a message from another team', { user_team: 'T0OTHER' }],
    ['a message posted from another team', { source_team: 'T0OTHER' }],
    ['a stranger writing', { user: 'U0STR' }],
  ] as const) {
    w.clock.now += 1_000;
    const ts = say(w, { channel: GENERAL, ...message });
    assertRefused(await refused(acknowledge(w, withEyes(big, GENERAL, ts)), what), 'external', what);
  }
  // A thread whose first message a guest wrote.
  w.clock.now += 1_000;
  const guestParent = say(w, { channel: GENERAL, user: GUEST, ago: 60_000 });
  const reply = say(w, { channel: GENERAL, thread_ts: guestParent });
  assertRefused(await refused(acknowledge(w, withEyes(big, GENERAL, reply)), 'parent'), 'external', 'a guest parent');
  nothingSent(w, 'from outside');
  assert.equal((await ledger(w)).uses.length, 0, 'a refused act was counted');
  // A person from here, with this workspace's own team on the message, still goes.
  w.clock.now += 1_000;
  const ours = say(w, { channel: GENERAL, user: ANA, user_team: w.world.teamId, source_team: w.world.teamId });
  assert.equal((await acknowledge(w, withEyes(big, GENERAL, ours))).act, 'reaction');
});

test('someone from another organisation writing is acknowledged only where the place was approved as shared', async (t) => {
  const w = await world(t);
  const shared = await standing(w, { reactions: ['eyes'], places: [PARTNERS] });
  const ts = say(w, { channel: PARTNERS, user: OUTSIDER, user_team: 'T0OTHER' });
  assert.equal((await acknowledge(w, withEyes(shared, PARTNERS, ts))).act, 'reaction');
});

test('a pending external share since creation refuses; is_org_shared alone does not', async (t) => {
  const w = await world(t);
  const exact = await standing(w, { reactions: ['eyes'], places: [ENG, GRIDROOM] });
  const room = w.world.rooms[ENG];
  if (room === undefined) throw new Error('no #eng');
  // An Enterprise Grid's own sharing, since: one organisation, nothing changed for the standing approval.
  w.world.rooms[ENG] = { ...room, is_org_shared: true };
  const first = say(w, { channel: ENG, ago: 20_000 });
  assert.equal((await acknowledge(w, withEyes(exact, ENG, first))).act, 'reaction');
  // An invitation to share it with another organisation, since.
  w.world.rooms[ENG] = { ...room, is_org_shared: true, is_pending_ext_shared: true };
  const second = say(w, { channel: ENG, user: ANA, ago: 10_000 });
  assertRefused(
    await refused(acknowledge(w, withEyes(exact, ENG, second)), 'pending'),
    'shared-state-changed',
    'a pending share since',
  );
  // threads-i-am-in, in a room shared across the Grid alone: not another organisation.
  const anywhere = await standing(w, { reactions: ['eyes'], places: 'threads-i-am-in' });
  const ts = say(w, { channel: GRIDROOM, thread_ts: myThread(w, GRIDROOM) });
  assert.equal((await acknowledge(w, withEyes(anywhere, GRIDROOM, ts))).act, 'reaction');
});

// ── Identity (S7) ──────────────────────────────────────────────────────────────────────────────────────────────

test('a reply goes as the app, or labelled, even under a me rule', async (t) => {
  // The person switched the label off for this workspace: an ordinary post would go as them, unlabelled.
  const w = await world(t, { identity: 'me' });
  const s = await standing(w, { replies: [REPLY], places: [ENG, PRIVATE] });
  const inEngTs = say(w, { channel: ENG, ago: 20_000 });
  const asApp = await acknowledge(w, withReply(s, ENG, inEngTs));
  assert.equal(asApp.label?.identity, 'agent');
  assert.equal(asApp.label?.route, 'app');
  const [appPost] = w.requests('chat.postMessage');
  assert.equal(appPost?.authorization, 'Bearer fake-bot-token-0', 'the app posted it');
  assert.equal(appPost?.params.get('username'), 'Jo (agent)');
  assert.equal(appPost?.params.get('text'), REPLY);

  // The app is not in #private: labelled, in the person's words, with their token.
  const inSecret = say(w, { channel: PRIVATE, ago: 10_000 });
  const labelled = await acknowledge(w, withReply(s, PRIVATE, inSecret));
  assert.equal(labelled.label?.route, 'fallback');
  const fallback = w.requests('chat.postMessage')[1];
  assert.equal(fallback?.authorization, 'Bearer fake-user-token-0');
  assert.equal(fallback?.params.get('text'), `${escapeForSlack(fallbackTextPrefix('Jo (agent)'))}${REPLY}`);
});

test('a reaction is refused wherever it would go as the person', async (t) => {
  for (const [what, options, place, setup] of [
    ['in a DM', {}, SAM_DM, undefined],
    ['in a group DM', {}, MPIM, undefined],
    ['in a room the app is not in', {}, PRIVATE, undefined],
    ['under the labelled style', {}, ENG, 'labelled'],
    ['with no bot token', { bot: false }, ENG, undefined],
  ] as const) {
    const w = await world(t, options);
    if (setup === 'labelled') await chooseLabelled(w);
    const s = await standing(w, { reactions: ['eyes'], places: [place] });
    const ts = say(w, { channel: place });
    assertRefused(await refused(acknowledge(w, withEyes(s, place, ts)), what), 'reaction-as-person', what);
    nothingSent(w, what);
    assert.equal((await ledger(w)).uses.length, 0, `${what}: counted`);
  }
});

test('a reaction where the app is not a member is refused before anything is counted', async (t) => {
  // A public channel the app has not joined: an app post may go there, but the app does not react where it is not.
  const QUIET = 'C0QUIET';
  const w = await world(t);
  w.world.rooms[QUIET] = { name: 'quiet', members: [SELF, SAM, ANA] };
  const s = await standing(w, { reactions: ['eyes'], places: [QUIET] });
  const ts = say(w, { channel: QUIET });
  const error = await refused(acknowledge(w, withEyes(s, QUIET, ts)), 'not a member');
  assertRefused(error, 'app-not-member', 'quiet');
  assert.equal(
    error.message,
    'nothing was sent: the agent app is not a member of this place, or whether it is could not be read',
  );
  nothingSent(w, 'the app not a member');
  assert.equal((await ledger(w)).uses.length, 0, 'a refused reaction was counted');
  assert.equal((await children(w)).length, 0, 'a child was minted');
});

test('a reaction where whether the app is a member cannot be read is refused', async (t) => {
  // A room of sixty, approved with its count, whose members cannot be paged: nobody can say the app is in it.
  const HALL = 'C0HALL';
  const w = await world(t);
  const crowd = Array.from({ length: 60 }, (_, index) => `U0H${String(index).padStart(3, '0')}`);
  w.world.rooms[HALL] = { name: 'hall', num_members: 60, members_unreadable: true, members: [SELF, ...crowd, BOT] };
  const s = await standing(w, { reactions: ['eyes'], places: [HALL] });
  const ts = say(w, { channel: HALL });
  assertRefused(await refused(acknowledge(w, withEyes(s, HALL, ts)), 'unsettled'), 'app-not-member', 'hall');
  nothingSent(w, 'membership unsettled');
  assert.equal((await ledger(w)).uses.length, 0, 'a refused reaction was counted');
});

test('slack_ack takes no remove and no draftId', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: ENG });
  const { client, call } = await mcp(w, t);
  const tool = (await client.listTools()).tools.find((each) => each.name === 'slack_ack');
  assert.ok(tool, 'slack_ack is a tool');
  for (const key of ['remove', 'draftId', 'approvalId', 'text']) {
    assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, key), false, `slack_ack takes ${key}`);
  }
  for (const extra of [{ remove: true }, { draftId: 'dft_AAAAAAAAAAAAAAAAAAAAAA' }]) {
    const result = await call('slack_ack', { workspace: 'acme', ...withEyes(s, ENG, ts), standingId: s.id, ...extra });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error.code, 'USAGE', JSON.stringify(extra));
  }
  nothingSent(w, 'slack_ack with remove');
  // The command takes neither either.
  for (const flag of ['--remove', '--draft']) {
    const command = await cli(w, [
      '--json',
      'ack',
      '--workspace',
      'acme',
      '--standing',
      s.id,
      '--channel',
      ENG,
      '--ts',
      ts,
      '--content',
      s.digest('reaction', 'eyes'),
      flag,
      ...(flag === '--draft' ? ['dft_AAAAAAAAAAAAAAAAAAAAAA'] : []),
    ]);
    assert.equal(command.code, EXIT_CODES.USAGE, `${flag}: ${command.stdout}`);
  }
  nothingSent(w, 'ack with remove');
});

test('a content named by anything but a digest it holds is refused', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: ENG });
  for (const content of ['1', 'eyes', `${'A'.repeat(64)}`]) {
    const error = await refused(acknowledge(w, { standingId: s.id, channel: ENG, ts, content }), content);
    assert.equal(error.code, 'USAGE', content);
    assert.match(error.message, /digest/);
  }
  const unknown = await refused(acknowledge(w, { standingId: s.id, channel: ENG, ts, content: 'f'.repeat(64) }), 'f');
  assertRefused(unknown, 'content-not-held', 'a digest it does not hold');
  nothingSent(w, 'a content not held');
  assert.equal(w.requests('conversations.replies').length, 0, 'Slack was read for a content not held');
});

// ── Spec 2's behaviour rules (S9, T9) ──────────────────────────────────────────────────────────────────────────

test('a rule forbidding reply or reaction refuses the standing act before the mint', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: ENG });
  await setRules(w.harness, [{ conversation: ENG, acts: ['post'] }]);
  for (const request of [withReply(s, ENG, ts), withEyes(s, ENG, ts)]) {
    const error = await refused(acknowledge(w, request), 'a rule');
    assert.equal(error.code, 'ACT_NOT_ALLOWED', error.message);
  }
  nothingSent(w, 'forbidden by a rule');
  assert.equal((await ledger(w)).uses.length, 0, 'counted before the rules were asked');
  assert.equal((await children(w)).length, 0, 'a child was minted');
});

test('a rule tightened after the mint refuses at the claim, and the count stays spent', async (t) => {
  for (const act of ['reply', 'reaction'] as const) {
    const w = await world(t);
    const s = await inEng(w);
    const ts = say(w, { channel: ENG });
    betweenMintAndClaim(w, () => setRules(w.harness, [{ conversation: ENG, acts: ['post'] }]));
    const error = await refused(
      acknowledge(w, act === 'reply' ? withReply(s, ENG, ts) : withEyes(s, ENG, ts)),
      `${act} tightened`,
    );
    assert.equal(error.code, 'ACT_NOT_ALLOWED', `${act}: ${error.message}`);
    nothingSent(w, `${act} after a rule tightened`);
    assert.equal((await ledger(w)).uses.length, 1, `${act}: the count was refunded`);
    const [child] = await children(w);
    assert.notEqual(child?.state, 'used', `${act}: the child was used`);
    assert.notEqual(child?.state, 'approved', `${act}: the child is still usable`);
  }
});

test('a standing approval ended or narrowed after the mint refuses at the claim, and the count stays spent', async (t) => {
  for (const change of ['revoked', 'narrowed'] as const) {
    const w = await world(t);
    const s = await inEng(w);
    const ts = say(w, { channel: ENG });
    betweenMintAndClaim(w, async () => {
      const id = await accountId(w);
      // The record alone: its children are left as they are, so the claim is what must notice.
      if (change === 'revoked') await w.core.approvals.revoke(s.id, 'ended by the person', { disposition: 'person' });
      else await w.core.approvals.narrowStanding(s.id, id, { keep: [s.digest('reply', REPLY)] });
    });
    const error = await refused(acknowledge(w, withEyes(s, ENG, ts)), change);
    assert.equal(error.code, 'APPROVAL_VOID', `${change}: ${error.message}`);
    assert.match(error.message, change === 'revoked' ? /has ended/ : /no longer holds what it sends/);
    nothingSent(w, `${change} after the mint`);
    assert.equal((await ledger(w)).uses.length, 1, `${change}: the count was refunded`);
    const [child] = await children(w);
    assert.equal(child?.state, 'revoked', `${change}: the child is still usable`);
  }
});

test('a message no longer the newest when it is read again after the mint is refused, and the count stays spent', async (t) => {
  for (const where of ['thread', 'channel'] as const) {
    const w = await world(t);
    const s = await inEng(w);
    const parent = where === 'thread' ? say(w, { channel: ENG, user: ANA, ago: 60_000 }) : undefined;
    const ts = say(w, { channel: ENG, ago: 20_000, ...(parent === undefined ? {} : { thread_ts: parent }) });
    // Someone else speaks between the first read and the claim.
    betweenMintAndClaim(w, async () => {
      say(w, { channel: ENG, user: ANA, ago: 5_000, ...(parent === undefined ? {} : { thread_ts: parent }) });
    });
    assertRefused(await refused(acknowledge(w, withEyes(s, ENG, ts)), where), 'not-newest', `in its ${where}`);
    nothingSent(w, `overtaken in its ${where}`);
    assert.equal((await ledger(w)).uses.length, 1, `${where}: the count was refunded`);
    const [child] = await children(w);
    assert.equal(child?.state, 'revoked', `${where}: the child is still usable`);
    const [outcome] = (await ledger(w)).outcomes;
    assert.equal(outcome?.outcome, 'failed');
  }
});

// ── No other path sends a standing child ───────────────────────────────────────────────────────────────────────

/** The refusal every ordinary path gives a standing child: APPROVAL_VOID, `standing-child`. */
async function refusesChild(w: StandingWorld, work: Promise<unknown>, what: string, childId: string): Promise<void> {
  const error = await refused(work, what);
  assert.equal(error.code, 'APPROVAL_VOID', `${what}: ${error.code} ${error.message}`);
  assert.equal(error.details?.reason, 'standing-child', `${what}: ${error.message}`);
  assert.equal((await recordOf(w, childId)).state, 'approved', `${what} spent the child`);
}

test('a reaction child is refused by react, slack_react_send, edit send and delete send, and only the ack makes it', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const mine = say(w, { channel: ENG, user: SELF, ago: 50_000, text: 'shipping at noon' });
  const ts = say(w, { channel: ENG });
  const { call } = await mcp(w, t);
  const draft = await createDraft(w.context, 'acme', { channel: ENG, text: 'shipping at one' });
  betweenMintAndClaim(w, async (child) => {
    const wanted = { channel: ENG, ts, name: 'eyes' };
    await refusesChild(w, react(w.context, 'acme', wanted, child.approvalId, w.slack), 'react', child.approvalId);
    const tool = await call('slack_react_send', {
      workspace: 'acme',
      channel: ENG,
      ts,
      emoji: 'eyes',
      approvalId: child.approvalId,
    });
    assert.equal(
      tool.structuredContent?.error.details.reason,
      'standing-child',
      JSON.stringify(tool.structuredContent),
    );
    await refusesChild(
      w,
      sendEdit(
        w.context,
        'acme',
        { draftId: draft.draftId, approvalId: child.approvalId, expectChannel: ENG, ts: mine },
        w.slack,
      ),
      'edit send',
      child.approvalId,
    );
    await refusesChild(
      w,
      sendDelete(w.context, 'acme', { channel: ENG, ts: mine, approvalId: child.approvalId }, w.slack),
      'delete send',
      child.approvalId,
    );
  });
  const done = await acknowledge(w, withEyes(s, ENG, ts));
  assert.equal(done.act, 'reaction');
  assert.deepEqual(w.world.reactions, [{ channel: ENG, ts, name: 'eyes', via: 'bot', remove: false }]);
  assert.equal(w.requests('chat.update').length + w.requests('chat.delete').length, 0);
});

test('a reply child is refused by post send and slack_post_send, and only the ack posts it', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: ENG });
  const { call } = await mcp(w, t);
  betweenMintAndClaim(w, async (child) => {
    const input = { draftId: child.draftId, approvalId: child.approvalId, expectChannel: ENG };
    await refusesChild(w, sendPost(w.context, 'acme', input, w.slack), 'post send', child.approvalId);
    const tool = await call('slack_post_send', { workspace: 'acme', ...input });
    assert.equal(
      tool.structuredContent?.error.details.reason,
      'standing-child',
      JSON.stringify(tool.structuredContent),
    );
    assert.equal((await recordOf(w, child.approvalId)).state, 'approved');
  });
  const done = await acknowledge(w, withReply(s, ENG, ts));
  assert.equal(done.act, 'reply');
  assert.equal(w.requests('chat.postMessage').length, 1, 'posted more than once');
});

// ── Counting (S6, S9) ──────────────────────────────────────────────────────────────────────────────────────────

test('SEND_OUTCOME_UNKNOWN keeps the count spent', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const parent = say(w, { channel: ENG, user: ANA, ago: 60_000 });
  const ts = say(w, { channel: ENG, thread_ts: parent, ago: 20_000 });
  w.fake.script['reactions.add'] = () => DROP;
  const error = await refused(acknowledge(w, withEyes(s, ENG, ts)), 'dropped');
  assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
  const { uses, outcomes } = await ledger(w);
  assert.equal(uses.length, 1);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.outcome),
    ['unknown'],
  );
  // Nothing was refunded: the thread's one acknowledgement is spent.
  const next = say(w, { channel: ENG, user: ANA, thread_ts: parent, ago: 10_000 });
  const limited = await refused(acknowledge(w, withEyes(s, ENG, next)), 'again');
  assert.equal(limited.code, 'STANDING_LIMIT');
  assert.equal(limited.details?.limit, 'perThread');
});

test('a payload with & is escaped, and one with < or > cannot be approved at all', async (t) => {
  const w = await world(t);
  const text = 'Got it & thanks, on it now.';
  const s = await inEng(w, { replies: [text] });
  const ts = say(w, { channel: ENG });
  await acknowledge(w, withReply(s, ENG, ts, text));
  assert.equal(w.requests('chat.postMessage')[0]?.params.get('text'), 'Got it &amp; thanks, on it now.');
  for (const words of ['a < b', 'a > b']) {
    const error = await refused(
      standing(w, { replies: [words], places: [ENG] }).then(() => undefined),
      `a reply with ${words}`,
    );
    assert.equal(error.code, 'BAD_DATA');
  }
});

test('a different label gives a different digest: a label changed after the mint voids the child', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: ENG });
  // Minted for the app's post; the person chooses labelled posts before the claim.
  betweenMintAndClaim(w, () => chooseLabelled(w));
  const error = await refused(acknowledge(w, withReply(s, ENG, ts)), 'relabelled');
  assert.equal(error.code, 'APPROVAL_VOID', error.message);
  nothingSent(w, 'relabelled');
  assert.equal((await ledger(w)).uses.length, 1, 'the count was refunded');
});

test('a clock earlier than the last act refuses', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const first = say(w, { channel: ENG, ago: 5_000 });
  await acknowledge(w, withEyes(s, ENG, first));
  // Moved back half a minute: still after the standing approval was made, and before its last act.
  w.clock.now -= 30_000;
  const parent = say(w, { channel: ENG, user: ANA, ago: 10_000 });
  const later = say(w, { channel: ENG, thread_ts: parent, ago: 1_000 });
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, later)), 'clock'), 'clock-behind', 'a clock moved back');
  assert.equal(w.world.reactions.length, 1);
});

// ── Less to say by choosing (S6, S9, the lead's call after review) ─────────────────────────────────────────────────

test('the act waits a pause after its count is spent, and the act’s own time is recorded beside the decision', async (t) => {
  let decidedAt: number | undefined;
  const seen: { uses: number; reactions: number }[] = [];
  const w: StandingWorld = await world(t, {
    pause: async () => {
      // The count is spent, and nothing is sent yet: the pause is between the two.
      seen.push({ uses: (await ledger(w)).uses.length, reactions: w.world.reactions.length });
      decidedAt = w.clock.now;
      w.clock.now += 17_000;
      return 17_000;
    },
  });
  const s = await inEng(w);
  const ts = say(w, { channel: ENG });
  const done = await acknowledge(w, withEyes(s, ENG, ts));
  assert.equal(done.act, 'reaction');
  assert.deepEqual(seen, [{ uses: 1, reactions: 0 }]);
  assert.deepEqual(w.pauses, [17_000]);
  const { uses, outcomes } = await ledger(w);
  assert.equal(uses[0]?.at, new Date(decidedAt as number).toISOString(), 'the use is when it was decided');
  assert.equal(outcomes[0]?.actAt, new Date((decidedAt as number) + 17_000).toISOString(), 'the act, after it');
  const [record] = (await w.core.audit.tail({ limit: 100 })).filter((each) => each.operation === 'slack.ack');
  assert.equal(record?.ids?.pausedMs, '17000');
  assert.equal(record?.ids?.actAt, outcomes[0]?.actAt);
});

test('a refusal before the count waits no pause', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const stale = say(w, { channel: ENG, ago: 16 * 60_000 });
  assertRefused(await refused(acknowledge(w, withEyes(s, ENG, stale)), 'stale'), 'not-fresh', 'stale');
  assert.deepEqual(w.pauses, [], 'a pause was taken for nothing');
});

test('a fourth act on one person’s messages in a day is refused, across standing approvals: perSender', async (t) => {
  const w = await world(t);
  const first = await inEng(w);
  const second = await inEng(w, { reactions: ['raised_hands'], replies: [] });
  for (const [index, s] of [first, second, first].entries()) {
    const ts = say(w, { channel: ENG, text: `question ${index}` });
    const content = s === first ? s.digest('reaction', 'eyes') : s.digest('reaction', 'raised_hands');
    await acknowledge(w, { standingId: s.id, channel: ENG, ts, content });
    w.clock.now += 60_000;
  }
  const fourth = say(w, { channel: ENG, text: 'question 3' });
  const limited = await refused(acknowledge(w, withEyes(first, ENG, fourth)), 'fourth');
  assert.equal(limited.code, 'STANDING_LIMIT', limited.message);
  assert.equal(limited.details?.limit, 'perSender');
  assert.equal(limited.details?.allowed, 3);
  assert.equal(typeof limited.details?.freesAt, 'string');
  assert.match(limited.message, /3 a day on messages from one person/);
  assert.equal(w.world.reactions.length, 3, 'the fourth was sent');
  // Someone else's is counted on its own.
  w.clock.now += 1_000;
  const other = say(w, { channel: ENG, user: ANA, text: 'and mine?' });
  assert.equal((await acknowledge(w, withEyes(first, ENG, other))).act, 'reaction');
});

// ── Seeing it (S10) ────────────────────────────────────────────────────────────────────────────────────────────

test('each act raises a notice saying what was sent, where, and under which standing approval', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const first = say(w, { channel: ENG, ago: 20_000 });
  const reacted = await acknowledge(w, withEyes(s, ENG, first));
  assert.equal(reacted.notice, 'raised');
  const parent = say(w, { channel: ENG, user: ANA, ago: 15_000 });
  const second = say(w, { channel: ENG, thread_ts: parent, ago: 10_000 });
  await acknowledge(w, withReply(s, ENG, second));
  assert.deepEqual(w.notices, [
    { title: 'agent-communications', body: `Your agent sent :eyes: in #eng (standing approval ${s.id})` },
    { title: 'agent-communications', body: `Your agent sent "${REPLY}" in #eng (standing approval ${s.id})` },
  ]);
  // Core's words, made by core's own function: the Slack package writes no notice of its own.
  assert.deepEqual(w.notices, [
    ackNotice({ act: 'reaction', text: 'eyes', place: '#eng', standingId: s.id }),
    ackNotice({ act: 'reply', text: REPLY, place: '#eng', standingId: s.id }),
  ]);
});

test('a notifier that throws or is missing leaves the act done', async (t) => {
  const throwing = await world(t, {
    notify: async () => {
      throw new Error('no display');
    },
  });
  const a = await inEng(throwing);
  const first = say(throwing, { channel: ENG });
  const thrown = await acknowledge(throwing, withEyes(a, ENG, first));
  assert.match(thrown.notice, /^failed: /);
  assert.equal(throwing.world.reactions.length, 1);

  const missing = await world(t, { notify: null });
  const b = await inEng(missing);
  const second = say(missing, { channel: ENG });
  const none = await acknowledge(missing, withEyes(b, ENG, second));
  assert.equal(none.notice, 'none');
  assert.equal(missing.world.reactions.length, 1);
  const [record] = (await missing.core.audit.tail({ limit: 100 })).filter((each) => each.operation === 'slack.ack');
  assert.equal(record?.outcome, 'ok');
  assert.equal(record?.ids?.notice, 'none');
});

test('the audit keeps the acknowledged text’s digest and edited state', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const text = 'can someone look at the deploy? (fixed a typo)';
  const ts = say(w, { channel: ENG, text, edited: { ts: tsAt(w.clock.now - 5_000) } });
  const done = await acknowledge(w, withEyes(s, ENG, ts));
  const [record] = (await w.core.audit.tail({ limit: 100 })).filter((each) => each.operation === 'slack.ack');
  assert.equal(record?.outcome, 'ok');
  assert.deepEqual(record?.ids, {
    standingId: s.id,
    childId: done.approvalId,
    contentDigest: s.digest('reaction', 'eyes'),
    channel: ENG,
    ts,
    targetDigest: sha256Hex(text),
    edited: 'true',
    // The pause between the decision and the act, and when the act started: the world's pause takes no time.
    pausedMs: '5000',
    actAt: new Date(w.clock.now).toISOString(),
    notice: 'raised',
  });
  const [use] = (await ledger(w)).uses;
  assert.equal(use?.targetDigest, sha256Hex(text));
  assert.equal(use?.edited, true);
});

test('the act is in the ledger standing list reads, with its outcome and its link', async (t) => {
  const w = await world(t);
  const s = await inEng(w);
  const ts = say(w, { channel: ENG });
  const done = await acknowledge(w, withEyes(s, ENG, ts));
  const { uses, outcomes } = await ledger(w);
  assert.deepEqual(
    uses.map((use) => [use.standingId, use.childId, use.act, use.channel, use.ts]),
    [[s.id, done.approvalId, 'reaction', ENG, ts]],
  );
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.childId, outcome.outcome, outcome.link, outcome.notice]),
    [[done.approvalId, 'sent', `https://acme.slack.com/archives/${ENG}/p${ts.replace('.', '')}`, 'raised']],
  );
});

// ── Both surfaces ──────────────────────────────────────────────────────────────────────────────────────────────

test('agent-slack ack and slack_ack do the same, as the agent, with no code', async (t) => {
  const w = await world(t, { sendPolicy: 'confirm' });
  const s = await inEng(w);
  const first = say(w, { channel: ENG, ago: 20_000 });
  const command = await cli(w, [
    '--json',
    'ack',
    '--workspace',
    'acme',
    '--standing',
    s.id,
    '--channel',
    ENG,
    '--ts',
    first,
    '--content',
    s.digest('reaction', 'eyes'),
  ]);
  assert.equal(command.code, EXIT_CODES.OK, command.stdout);
  const fromCli = command.json<{ act: string; label: { route: string } }>().data;
  const parent = say(w, { channel: ENG, user: ANA, ago: 15_000 });
  const second = say(w, { channel: ENG, thread_ts: parent, ago: 10_000 });
  const { call } = await mcp(w, t);
  const tool = await call('slack_ack', { workspace: 'acme', ...withEyes(s, ENG, second) });
  assert.notEqual(tool.isError, true, JSON.stringify(tool.structuredContent));
  const fromMcp = tool.structuredContent as { act: string; label: { route: string } };
  assert.deepEqual([fromCli?.act, fromCli?.label.route], [fromMcp.act, fromMcp.label.route]);
  assert.equal(w.world.reactions.length, 2);
  // A refusal reads the same from both.
  const stale = say(w, { channel: ENG, ago: 30 * 60_000 });
  const refusedCli = await cli(w, [
    '--json',
    'ack',
    '--workspace',
    'acme',
    '--standing',
    s.id,
    '--channel',
    ENG,
    '--ts',
    stale,
    '--content',
    s.digest('reaction', 'eyes'),
  ]);
  assert.equal(refusedCli.code, EXIT_CODES.APPROVAL);
  const refusedMcp = await call('slack_ack', { workspace: 'acme', ...withEyes(s, ENG, stale) });
  assert.deepEqual(refusedCli.json().error?.details, refusedMcp.structuredContent?.error.details);
  assert.equal(refusedCli.json().error?.message, refusedMcp.structuredContent?.error.message);
});
