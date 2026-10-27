import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProcessProbe } from '../src/activity.ts';
import { CommsError } from '../src/errors.ts';
import {
  TAKE_LEASE_MS,
  TAKE_OFFER_MS,
  TAKE_OFFER_WAIT_MS,
  type TakeAct,
  type TakeHolder,
  type TakeMessage,
  TakeStore,
  type TakeStoreOptions,
  type TakeTerminal,
  type TakeWindow,
} from '../src/takes.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Taking messages, a delivery's offers (design 2026-10-26-taking-messages, T3, T4, §8): the event service offers a
 * message to the window a rule delivered it to — exclusive while the item waits for it, then fifteen minutes after it was
 * handed over — and its sweep writes down every lapse. Every test runs against a temporary state folder, synthetic ids
 * and synthetic sessions: nothing reads the real home, and no real process is probed.
 */

const ACCOUNT = 'acc_AAAAAAAAAAAAAAAA';
const MESSAGE: TakeMessage = { channel: 'slack', accountId: ACCOUNT, id: 'C0123/1729936800.000100', thread: null };
const OTHER_MESSAGE: TakeMessage = { ...MESSAGE, id: 'C0123/1729936900.000200' };
const ACT: TakeAct = {
  account: 'acme/slack',
  shown: 'C0123/1729936800.000100',
  act: 'slack.react',
  takeWith: 'slack_take (step "take")',
};
const TERMINAL: TakeTerminal = { folder: '/example/home/work', ancestors: ['zsh'] };
const BY = { rule: 'david-on-slack', delivery: '0f8c3e7a-1b2c-4d5e-8f90-0123456789ab' };
const SESSION_ID = '25f971a3-0c69-44e3-971c-3a4656afa986';

function holder(over: Partial<TakeHolder> = {}): TakeHolder {
  return {
    key: 'aaaaaaaaaaaaaaaa',
    grouped: true,
    process: 'a1a1a1a1a1a1',
    sessionId: null,
    parent: { pid: 4242, startedAt: 'Mon Oct 26 10:00:00 2026', name: 'claude' },
    folder: '/example/home/work/acme-site',
    client: { name: 'claude-code', version: '2.1.0' },
    ...over,
  };
}

/** The window a lane is bound to: its Claude Code session id and its grouped key. */
const DAVID = holder({ sessionId: SESSION_ID });
const BOB = holder({
  key: 'bbbbbbbbbbbbbbbb',
  process: 'b2b2b2b2b2b2',
  sessionId: 'f9423d69-c1d7-45a2-a979-a4343c34477f',
  parent: { pid: 5353, startedAt: 'Mon Oct 26 10:05:00 2026', name: 'claude' },
  folder: '/example/home/work/client-secret-project',
});
const DAVID_WINDOW: TakeWindow = {
  sessionId: SESSION_ID,
  key: DAVID.key,
  parent: null,
  folder: '/example/home/work/acme-site',
  client: { name: 'claude-code', version: '2.1.0' },
};

function storeAt(start = '2026-10-26T10:00:00.000Z', options: TakeStoreOptions = {}) {
  let now = Date.parse(start);
  const dir = tempDir('comms-take-offers-');
  const store = new TakeStore(dir, {
    now: () => new Date(now),
    running: () => true,
    probe: async () => null,
    pinLive: async () => false,
    ...options,
  });
  return {
    store,
    advance(ms: number) {
      now += ms;
    },
    at: () => new Date(now).toISOString(),
  };
}

async function refusal(promise: Promise<unknown>): Promise<CommsError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CommsError, `expected a CommsError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a refusal');
}

test('a delivery offers a message to its window: exclusive while the item waits, and still to be taken', async () => {
  const { store, at } = storeAt();
  const offered = await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
  assert.equal(offered.changed, true);
  assert.equal(offered.record?.state, 'offered');
  assert.deepEqual(offered.record?.offer, { to: DAVID_WINDOW, until: null, by: BY });
  assert.deepEqual(offered.record?.history, [
    {
      at: at(),
      kind: 'offered',
      by: 'service',
      windowKey: DAVID_WINDOW.key,
      window: { sessionId: SESSION_ID, folder: DAVID_WINDOW.folder, client: DAVID_WINDOW.client },
    },
  ]);
  // Exclusive: another session's take and act are refused, whether or not taking is required.
  assert.equal((await refusal(store.take(MESSAGE, BOB))).details?.reason, 'OFFERED');
  for (const required of [true, false]) {
    assert.equal((await refusal(store.gate(MESSAGE, BOB, ACT, { required }))).details?.reason, 'OFFERED');
  }
  // The offered window must still take it before acting — the acknowledgement the owner asked for.
  const notYet = await refusal(store.gate(MESSAGE, DAVID, ACT, { required: true }));
  assert.equal(notYet.code, 'TAKE_REQUIRED');
  assert.match(notYet.hint ?? '', /It is offered to this session: take it before acting, or hand it back\./);
  // While the item waits, the offer does not lapse by itself.
  const taken = await store.take(MESSAGE, DAVID);
  assert.equal(taken.view?.by, 'you');
  assert.deepEqual(
    taken.record.history.map((line) => [line.kind, line.by]),
    [
      ['offered', 'service'],
      ['taken', 'window'],
    ],
  );
});

test('a delivery’s offer never takes the message from anyone: a take, a done, the person’s keep, another offer', async () => {
  // Taken by another session.
  {
    const { store } = storeAt();
    await store.take(MESSAGE, BOB);
    const result = await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
    assert.equal(result.changed, false);
    assert.equal(result.record?.state, 'taken');
    assert.deepEqual(result.record?.holder, BOB, 'Bob still holds it');
    assert.equal(result.record?.offer, null);
  }
  // Done by another session.
  {
    const { store } = storeAt();
    await store.take(MESSAGE, BOB);
    await store.finish(MESSAGE, BOB, undefined, ACT);
    assert.equal((await store.offer(MESSAGE, DAVID_WINDOW, BY, null)).changed, false);
  }
  // Kept by the person.
  {
    const { store } = storeAt();
    await store.keep(MESSAGE, TERMINAL);
    const result = await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
    assert.equal(result.changed, false);
    assert.deepEqual(result.record?.holder, { person: true });
  }
  // Given by the person to another window: that offer stands.
  {
    const { store } = storeAt();
    const bobWindow: TakeWindow = { sessionId: BOB.sessionId, key: BOB.key, parent: null, folder: null, client: null };
    await store.give(MESSAGE, bobWindow, TERMINAL);
    const result = await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
    assert.equal(result.changed, false);
    assert.deepEqual(result.record?.offer?.to, bobWindow);
  }
  // The same delivery offering again — a retry — changes nothing.
  {
    const { store } = storeAt();
    await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
    const again = await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
    assert.equal(again.changed, false);
    assert.equal(again.record?.history.length, 1);
  }
});

test('an offer made after a hand-back, or after a lapse, is written: the message was open again', async () => {
  const { store, advance } = storeAt();
  await store.take(MESSAGE, BOB);
  await store.handBack(MESSAGE, BOB, 'not-mine', undefined, ACT);
  assert.equal((await store.offer(MESSAGE, DAVID_WINDOW, BY, null)).changed, true);
  // Another message, whose take lapsed sixty minutes after its last act.
  await store.take(OTHER_MESSAGE, BOB);
  advance(TAKE_LEASE_MS);
  const lapsed = await store.offer(OTHER_MESSAGE, DAVID_WINDOW, { ...BY, delivery: 'second-delivery' }, null);
  assert.equal(lapsed.changed, true);
  assert.deepEqual(
    lapsed.record?.history.map((line) => line.kind),
    ['taken', 'expired', 'offered'],
  );
});

test('handing it over starts the fifteen minutes; then the offer lapses, open again, the history saying when', async () => {
  const { store, advance, at } = storeAt();
  await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
  advance(5 * 60_000);
  const until = new Date(Date.parse(at()) + TAKE_OFFER_MS).toISOString();
  // Another delivery's hand-over is not this offer's.
  assert.equal((await store.handOffer(MESSAGE, 'another-delivery', until)).changed, false);
  const handed = await store.handOffer(MESSAGE, BY.delivery, until);
  assert.equal(handed.changed, true);
  assert.equal(handed.record?.offer?.until, until);
  // Handed over once; a second hand-over does not move it.
  const later = new Date(Date.parse(until) + 60_000).toISOString();
  assert.equal((await store.handOffer(MESSAGE, BY.delivery, later)).changed, false);
  // Still exclusive until then.
  advance(TAKE_OFFER_MS - 1);
  assert.equal((await refusal(store.take(MESSAGE, BOB))).details?.reason, 'OFFERED');
  advance(1);
  const read = await store.read(MESSAGE);
  assert.ok(read !== null && read !== 'unreadable');
  assert.equal(read.state, 'open');
  assert.deepEqual(read.history.at(-1), { at: until, kind: 'expired', by: 'service', windowKey: DAVID_WINDOW.key });
  // Anyone may take it now.
  assert.equal((await store.take(MESSAGE, BOB)).view?.by, 'you');
});

test('an offer made with its time already set — a prompt posted — lapses at that time', async () => {
  const { store, advance, at } = storeAt();
  const until = new Date(Date.parse(at()) + TAKE_OFFER_MS).toISOString();
  await store.offer(MESSAGE, { ...DAVID_WINDOW, key: null }, BY, until);
  advance(TAKE_OFFER_MS);
  assert.equal((await store.take(MESSAGE, BOB)).view?.by, 'you');
});

test('an offer whose item no longer waits lapses at once — only that delivery’s, and only while it waits', async () => {
  const { store, at } = storeAt();
  await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
  assert.equal((await store.lapseOffer(MESSAGE, 'another-delivery')).changed, false);
  const lapsed = await store.lapseOffer(MESSAGE, BY.delivery);
  assert.equal(lapsed.changed, true);
  assert.equal(lapsed.record?.state, 'open');
  assert.deepEqual(lapsed.record?.history.at(-1), {
    at: at(),
    kind: 'expired',
    by: 'service',
    windowKey: DAVID_WINDOW.key,
  });
  // A take, or an offer already handed over, is not ended this way.
  await store.take(MESSAGE, DAVID);
  assert.equal((await store.lapseOffer(MESSAGE, BY.delivery)).changed, false);
  await store.offer(OTHER_MESSAGE, DAVID_WINDOW, BY, null);
  await store.handOffer(OTHER_MESSAGE, BY.delivery, new Date(Date.parse(at()) + TAKE_OFFER_MS).toISOString());
  assert.equal((await store.lapseOffer(OTHER_MESSAGE, BY.delivery)).changed, false);
  // Nothing recorded: nothing to end, and nothing is made.
  assert.deepEqual(await store.lapseOffer({ ...MESSAGE, id: 'C0123/1729937000.000300' }, BY.delivery), {
    record: null,
    changed: false,
  });
});

test('an offer its window is never handed lapses by itself: at the account’s reminder window, or after an hour', async () => {
  // Security review of 0.35.0, M5: a lane offer had no end time until its window was woken, so a window that had gone
  // kept every other session off the message for as long as the queue kept its item — still refused days later.
  const DAY = 24 * 60 * 60_000;
  {
    const { store, advance, at } = storeAt();
    const start = at();
    await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
    advance(TAKE_OFFER_WAIT_MS - 1);
    assert.equal((await refusal(store.take(MESSAGE, BOB))).details?.reason, 'OFFERED', 'within the hour, it holds');
    advance(6 * DAY);
    // The sweep writes it down, at the time it lapsed; then anyone may take it.
    assert.deepEqual(await store.lapse(), { ended: 0, expired: 1 });
    const lapsed = await store.read(MESSAGE);
    assert.ok(lapsed !== null && lapsed !== 'unreadable');
    assert.equal(lapsed.state, 'open');
    assert.deepEqual(lapsed.history.at(-1), {
      at: new Date(Date.parse(start) + TAKE_OFFER_WAIT_MS).toISOString(),
      kind: 'expired',
      by: 'service',
      windowKey: DAVID_WINDOW.key,
    });
    assert.equal((await store.take(MESSAGE, BOB)).view?.by, 'you');
  }
  {
    // Where the account's reminder window is known — core reads it from the configuration — the offer lasts that long.
    const asked: string[] = [];
    const { store, advance, at } = storeAt('2026-10-26T10:00:00.000Z', {
      offerWait: async (accountId) => {
        asked.push(accountId);
        return 15 * 60_000;
      },
    });
    const start = at();
    await store.offer(MESSAGE, DAVID_WINDOW, BY, null);
    advance(15 * 60_000 - 1);
    assert.equal((await refusal(store.gate(MESSAGE, BOB, ACT, { required: false }))).details?.reason, 'OFFERED');
    advance(1);
    assert.deepEqual(await store.gate(MESSAGE, BOB, ACT, { required: false }), { held: false, line: null });
    const lapsed = await store.read(MESSAGE);
    assert.ok(lapsed !== null && lapsed !== 'unreadable');
    assert.equal(lapsed.state, 'open');
    assert.equal(lapsed.history.at(-1)?.at, new Date(Date.parse(start) + 15 * 60_000).toISOString());
    assert.ok(asked.includes(ACCOUNT));
    // Handed over before then, it lasts its fifteen minutes from the hand-over instead.
    const second = { ...BY, delivery: 'second-delivery' };
    await store.offer(OTHER_MESSAGE, DAVID_WINDOW, second, null);
    advance(10 * 60_000);
    await store.handOffer(OTHER_MESSAGE, second.delivery, new Date(Date.parse(at()) + TAKE_OFFER_MS).toISOString());
    advance(10 * 60_000);
    assert.equal((await refusal(store.take(OTHER_MESSAGE, BOB))).details?.reason, 'OFFERED', 'handed over');
  }
});

test('an offer names its window, rule and delivery as ids; anything else is refused before a file is named', async () => {
  const { store } = storeAt();
  const nobody: TakeWindow = { sessionId: null, key: null, parent: null, folder: null, client: null };
  assert.equal((await refusal(store.offer(MESSAGE, nobody, BY, null))).code, 'USAGE');
  assert.equal((await refusal(store.offer(MESSAGE, DAVID_WINDOW, { ...BY, delivery: 'a b' }, null))).code, 'USAGE');
  assert.equal((await refusal(store.offer(MESSAGE, DAVID_WINDOW, { ...BY, rule: '\u0007' }, null))).code, 'USAGE');
  assert.equal((await refusal(store.offer(MESSAGE, DAVID_WINDOW, BY, 'tomorrow'))).code, 'USAGE');
  assert.equal(await store.read(MESSAGE), null, 'nothing was written');
});

test('the sweep writes every lapse down, at the time it happened: ended, expired, and an offer past its time', async () => {
  let gone = false;
  // Each parent is still the process it was, until David's ends.
  const probe: ProcessProbe = async (pid) => ({
    ppid: 1,
    startedAt: pid === 4242 ? 'Mon Oct 26 10:00:00 2026' : 'Mon Oct 26 10:05:00 2026',
    name: 'claude',
  });
  const { store, advance, at } = storeAt('2026-10-26T10:00:00.000Z', {
    probe,
    running: (pid) => !(gone && pid === 4242),
  });
  const third: TakeMessage = { ...MESSAGE, id: 'C0123/1729937000.000300' };
  const fourth: TakeMessage = { ...MESSAGE, id: 'C0123/1729937100.000400' };
  const kept: TakeMessage = { ...MESSAGE, id: 'C0123/1729937200.000500' };
  // Bob's take, whose lease will run out; then David's, whose parent will end; an offer handed over; the person's keep.
  const start = at();
  await store.take(OTHER_MESSAGE, BOB);
  await store.offer(third, DAVID_WINDOW, BY, null);
  await store.handOffer(third, BY.delivery, new Date(Date.parse(start) + TAKE_OFFER_MS).toISOString());
  await store.keep(kept, TERMINAL);
  advance(10 * 60_000);
  await store.take(MESSAGE, DAVID);
  // Offered ten minutes on: still within the hour a waiting offer lasts, at the sweep below.
  await store.offer(fourth, DAVID_WINDOW, { ...BY, delivery: 'waiting-delivery' }, null);
  // Nothing has lapsed yet.
  assert.deepEqual(await store.lapse(), { ended: 0, expired: 0 });
  gone = true;
  advance(TAKE_LEASE_MS - 10 * 60_000);
  const sweptAt = at();
  assert.deepEqual(await store.lapse(), { ended: 1, expired: 2 });
  const lines = async (message: TakeMessage) => {
    const read = await store.read(message);
    assert.ok(read !== null && read !== 'unreadable');
    return { state: read.state, last: read.history.at(-1) };
  };
  assert.deepEqual(await lines(MESSAGE), {
    state: 'open',
    last: {
      at: sweptAt,
      kind: 'ended',
      by: 'service',
      windowKey: DAVID.key,
      window: { sessionId: SESSION_ID, folder: DAVID.folder, client: DAVID.client },
    },
  });
  const expired = await lines(OTHER_MESSAGE);
  assert.equal(expired.state, 'open');
  assert.equal(expired.last?.kind, 'expired');
  assert.equal(expired.last?.at, new Date(Date.parse(start) + TAKE_LEASE_MS).toISOString(), 'at the lease’s end');
  const offerLapsed = await lines(third);
  assert.deepEqual(offerLapsed, {
    state: 'open',
    last: {
      at: new Date(Date.parse(start) + TAKE_OFFER_MS).toISOString(),
      kind: 'expired',
      by: 'service',
      windowKey: DAVID_WINDOW.key,
    },
  });
  // An offer still waiting for its window, and the person's keep, stand.
  assert.equal((await lines(fourth)).state, 'offered');
  assert.equal((await lines(kept)).state, 'taken');
  // Written once: a second sweep finds nothing more.
  assert.deepEqual(await store.lapse(), { ended: 0, expired: 0 });
});
