import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { asV2 } from '../src/approval-stored.ts';
import type { ApprovalRecord } from '../src/approvals.ts';
import type { Streams } from '../src/cli-runtime.ts';
import type { AccountConfig } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { applySendPolicyChange } from '../src/send-epoch.ts';
import { type ExactPlace, raiseStandingEpoch, type StandingAct, type StandingLimits } from '../src/standing.ts';
import { approveStandingAtTerminal, endStanding, prepareStanding } from '../src/standing-flow.ts';
import { AckLedger, type AckOutcome, type AckUse } from '../src/standing-ledger.ts';
import { mintStandingUse, type StandingUseRequest } from '../src/standing-use.ts';
import { liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The acknowledgement ledger and the mint (design 2026-10-19-standing-approvals, S6, S9): every use counted once, under
 * the account's ledger lock and then the standing record's, and never refunded — not for a refusal after the count, a
 * failed act or one whose outcome is unknown. Time comes from the clock the core was opened with.
 */

const ACME = 'acc_AAAAAAAAAAAAAAAA';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ROOM: ExactPlace = {
  id: 'C0ROOM',
  name: 'support',
  members: 12,
  shared: { extShared: false, pendingExtShared: false, externalMembers: false },
};

/** A machine on a clock the test moves, with the account `acme/slack` posting under `chat`. */
function machine() {
  const clock = { now: Date.parse('2026-10-19T09:00:00.000Z') };
  const home = tempDir('comms-standing-use-');
  const config = liveConfig(home, { accounts: { 'acme/slack': { id: ACME } } });
  const env = { HOME: home, USERPROFILE: home, AGENT_COMMS_CONFIG_DIR: config.dir, AGENT_COMMS_UPDATE_CHECK: 'off' };
  const core = openCore({ env, caller: CORE_CALLER, now: () => new Date(clock.now) });
  return { clock, core, config };
}

function terminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  stdout.resume();
  stderr.on('data', (chunk) => {
    const code = /Type (\w{4}) to approve/.exec(String(chunk))?.[1];
    if (code !== undefined) stdin.write(`${code}\n`);
  });
  return { stdin, stdout, stderr } as unknown as Streams;
}

/** A standing approval approved at a terminal, with these limits: `eyes` and one reply, in #support or `places`. */
async function standing(
  core: Core,
  limits: Partial<StandingLimits> = {},
  places: ExactPlace[] = [ROOM],
): Promise<ApprovalRecord> {
  const outcome = await prepareStanding(
    core,
    {
      account: 'acme/slack',
      accountId: ACME,
      inboxSub: 'U_ME',
      contents: { reactions: ['eyes'], replies: ['Got it, I will look'] },
      places: { kind: 'exact', places },
      limits,
    },
    { surface: 'cli', proposedBy: 'person' },
  );
  assert.equal(outcome.status, 'approval-required');
  if (outcome.status !== 'approval-required') throw new Error('unreachable');
  await approveStandingAtTerminal(core, outcome.prepared.approvalId, {}, { color: false }, terminal());
  return asV2(await core.approvals.get(outcome.prepared.approvalId)) as ApprovalRecord;
}

const digestOf = (record: ApprovalRecord, act: StandingAct) =>
  record.standing?.contents.find((content) => content.kind === act)?.digest as string;

/** A use of `record` on message `ts` in thread `thread` of #support. */
function use(
  record: ApprovalRecord,
  target: {
    ts: string;
    thread?: string;
    act?: StandingAct;
    contentDigest?: string;
    childDigest?: string;
    channel?: string;
    places?: 'exact' | 'threads-i-am-in';
    /** Who wrote it: a sender of its own for each message unless named, so only the per-sender test meets that limit. */
    sender?: string;
  },
): StandingUseRequest {
  const act = target.act ?? 'reaction';
  return {
    standingId: record.approvalId,
    accountId: ACME,
    inboxSub: 'U_ME',
    act,
    contentDigest: target.contentDigest ?? digestOf(record, act),
    target: {
      channel: target.channel ?? 'C0ROOM',
      ts: target.ts,
      thread: target.thread ?? target.ts,
      textDigest: 'e'.repeat(64),
      edited: false,
      places: target.places ?? 'exact',
      sender: target.sender ?? `U_${target.ts}`,
    },
    child: {
      draftId: `reaction:C0ROOM:${target.ts}`,
      draftMessageId: 'd'.repeat(64),
      contentDigest: target.childDigest ?? 'd'.repeat(64),
      expect: { to: ['C0ROOM'], cc: [], bcc: [], subject: `:eyes: on ${target.ts}` },
      riskFlags: ['AS_AGENT', 'REACTS_AS_APP'],
    },
  };
}

const refusedWith = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(error instanceof CommsError, String(error));
  assert.equal(error.code, code, error.message);
  if (details !== undefined) {
    for (const [key, value] of Object.entries(details)) assert.deepEqual(error.details?.[key], value, key);
  }
  return true;
};

const uses = async (core: Core) =>
  (await core.acks.entries(ACME)).filter((entry): entry is AckUse => entry.kind === 'use');

test('a use is counted, the child minted after the count, and the child names it', async () => {
  const { core } = machine();
  const record = await standing(core);
  const minted = await mintStandingUse(core, use(record, { ts: '1760864000.000100' }));
  assert.equal(minted.standing.approvalId, record.approvalId);
  assert.equal(minted.content.kind, 'reaction');
  assert.equal(minted.content.text, 'eyes');
  assert.equal(minted.child.kind, 'send');
  assert.equal(minted.child.route, 'standing');
  assert.equal(minted.child.state, 'approved');
  assert.equal(minted.child.standingId, record.approvalId);
  const [line] = await uses(core);
  assert.deepEqual(line, {
    kind: 'use',
    at: '2026-10-19T09:00:00.000Z',
    standingId: record.approvalId,
    childId: minted.child.approvalId,
    act: 'reaction',
    contentDigest: digestOf(record, 'reaction'),
    channel: 'C0ROOM',
    ts: '1760864000.000100',
    thread: '1760864000.000100',
    sender: 'U_1760864000.000100',
    targetDigest: 'e'.repeat(64),
    edited: false,
  });
  assert.equal(existsSync(join(core.paths.stateDir, 'standing', `${ACME}.jsonl`)), true);
});

test('a place narrowed away while Slack was read is refused at the mint, and nothing is counted', async () => {
  const { core } = machine();
  const LOBBY: ExactPlace = { ...ROOM, id: 'C0LOBBY', name: 'lobby' };
  const record = await standing(core, {}, [ROOM, LOBBY]);
  // The channel read and found covered; then, before the mint, the person keeps only #lobby.
  await core.approvals.narrowStanding(record.approvalId, ACME, { places: ['C0LOBBY'] });
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '5.000100' })),
    refusedWith('STANDING_REFUSED', { reason: 'place-not-covered' }),
  );
  // Read as threads-i-am-in, a record of exact places covers nothing.
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '5.000200', channel: 'C0LOBBY', places: 'threads-i-am-in' })),
    refusedWith('STANDING_REFUSED', { reason: 'place-not-covered' }),
  );
  assert.deepEqual(await uses(core), [], 'a refused use was counted');
  assert.deepEqual(
    (await core.approvals.list()).map((stored) => asV2(stored)?.route).filter((route) => route === 'standing'),
    [],
    'a child was minted',
  );
  // The place it kept still goes.
  await mintStandingUse(core, use(record, { ts: '5.000300', channel: 'C0LOBBY' }));
  assert.equal((await uses(core)).length, 1);
});

test('per sender: a day of acts on one person’s messages, across every standing approval, then it frees', async () => {
  const { core, clock } = machine();
  const first = await standing(core, { perHour: 30 });
  const second = await standing(core, { perHour: 30 });
  const firstAt = clock.now;
  // Three of Sam's messages, in three threads, under two standing approvals: the default allows three a day.
  await mintStandingUse(core, use(first, { ts: '20.000100', sender: 'U0SAM' }));
  clock.now += MINUTE;
  await mintStandingUse(core, use(second, { ts: '20.000200', sender: 'U0SAM' }));
  clock.now += MINUTE;
  await mintStandingUse(core, use(first, { ts: '20.000300', sender: 'U0SAM' }));
  clock.now += MINUTE;
  for (const record of [first, second]) {
    await assert.rejects(
      mintStandingUse(core, use(record, { ts: `20.0004${record === first ? '1' : '2'}0`, sender: 'U0SAM' })),
      refusedWith('STANDING_LIMIT', {
        limit: 'perSender',
        allowed: 3,
        freesAt: new Date(firstAt + DAY).toISOString(),
      }),
    );
  }
  // Anyone else is counted on their own.
  await mintStandingUse(core, use(first, { ts: '20.000500', sender: 'U0ANA' }));
  // A day after the first, one frees.
  clock.now = firstAt + DAY + 1;
  await mintStandingUse(core, use(second, { ts: '20.000600', sender: 'U0SAM' }));
  assert.equal((await uses(core)).filter((entry) => entry.sender === 'U0SAM').length, 4);
});

test('a lower per-sender limit, narrowed, holds at once', async () => {
  const { core } = machine();
  const record = await standing(core, { perSender: 2 });
  assert.equal(record.standing?.limits.perSender, 2);
  await core.approvals.narrowStanding(record.approvalId, ACME, { limits: { perSender: 1 } });
  await mintStandingUse(core, use(record, { ts: '21.000100', sender: 'U0SAM' }));
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '21.000200', sender: 'U0SAM' })),
    refusedWith('STANDING_LIMIT', { limit: 'perSender', allowed: 1 }),
  );
});

test('each of per thread, per hour and per day is reached and refused with when it frees', async () => {
  // Per thread: one by default, and it never frees.
  const thread = machine();
  const once = await standing(thread.core, { expiresDays: 30 });
  await mintStandingUse(thread.core, use(once, { ts: '1.000100', thread: '1.000000' }));
  await assert.rejects(
    mintStandingUse(thread.core, use(once, { ts: '1.000200', thread: '1.000000' })),
    refusedWith('STANDING_LIMIT', { limit: 'perThread', allowed: 1, freesAt: null }),
  );
  thread.clock.now += 30 * DAY - 2 * MINUTE;
  await assert.rejects(
    mintStandingUse(thread.core, use(once, { ts: '1.000300', thread: '1.000000' })),
    refusedWith('STANDING_LIMIT', { limit: 'perThread' }),
  );

  // Per hour: frees an hour after the oldest use in the hour.
  const hour = machine();
  const hourly = await standing(hour.core, { perThread: 3, perHour: 2, perDay: 100 });
  const first = new Date(hour.clock.now).toISOString();
  await mintStandingUse(hour.core, use(hourly, { ts: '2.000100' }));
  hour.clock.now += 10 * MINUTE;
  await mintStandingUse(hour.core, use(hourly, { ts: '2.000200' }));
  await assert.rejects(
    mintStandingUse(hour.core, use(hourly, { ts: '2.000300' })),
    refusedWith('STANDING_LIMIT', {
      limit: 'perHour',
      allowed: 2,
      freesAt: new Date(Date.parse(first) + HOUR).toISOString(),
    }),
  );
  hour.clock.now = Date.parse(first) + HOUR + 1;
  await mintStandingUse(hour.core, use(hourly, { ts: '2.000400' }));

  // Per day: frees a day after the oldest use in the day.
  const day = machine();
  const daily = await standing(day.core, { perThread: 3, perHour: 2, perDay: 3 });
  const morning = new Date(day.clock.now).toISOString();
  await mintStandingUse(day.core, use(daily, { ts: '3.000100' }));
  await mintStandingUse(day.core, use(daily, { ts: '3.000200' }));
  day.clock.now += 2 * HOUR;
  await mintStandingUse(day.core, use(daily, { ts: '3.000300' }));
  day.clock.now += 2 * HOUR;
  await assert.rejects(
    mintStandingUse(day.core, use(daily, { ts: '3.000400' })),
    refusedWith('STANDING_LIMIT', {
      limit: 'perDay',
      allowed: 3,
      freesAt: new Date(Date.parse(morning) + DAY).toISOString(),
    }),
  );
  // The refusal says to ask the person, by the located list, and names nothing that widens one.
  await mintStandingUse(day.core, use(daily, { ts: '3.000500' })).catch((error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.match(error.hint ?? '', /ask the person/i);
    assert.match(error.hint ?? '', /standing list/);
    assert.doesNotMatch(error.hint ?? '', /standing add|--replaces|slack_standing_add/);
  });
});

/** A ledger that waits, after reading under its lock, before it lets the use go on: a race made wide. */
class SlowLedger extends AckLedger {
  override withLock<T>(
    accountId: string,
    fn: (entries: (AckUse | AckOutcome)[], append: (entry: AckUse) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return super.withLock(accountId, async (entries, append) => {
      await sleep(60);
      return fn(entries, append);
    });
  }
}

const withLedger = (core: Core, acks: AckLedger): Core => ({ ...core, acks });

test('two concurrent uses cannot both take the last count', async () => {
  const { core, clock } = machine();
  const record = await standing(core, { perThread: 1, perHour: 1, perDay: 1 });
  const slow = withLedger(core, new SlowLedger(core.paths.stateDir, () => new Date(clock.now)));
  const results = await Promise.allSettled([
    mintStandingUse(slow, use(record, { ts: '4.000100' })),
    mintStandingUse(slow, use(record, { ts: '4.000200' })),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(results));
  const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(refusedWith('STANDING_LIMIT')(refused.reason));
  assert.equal((await uses(core)).length, 1);
});

test('two concurrent uses cannot acknowledge one thread under two approvals', async () => {
  const { core, clock } = machine();
  const one = await standing(core);
  const two = await standing(core);
  const slow = withLedger(core, new SlowLedger(core.paths.stateDir, () => new Date(clock.now)));
  // Two messages of one thread: perThread counts across every standing approval of the account.
  const results = await Promise.allSettled([
    mintStandingUse(slow, use(one, { ts: '5.000100', thread: '5.000000' })),
    mintStandingUse(slow, use(two, { ts: '5.000200', thread: '5.000000' })),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(results));
  assert.ok(
    refusedWith('STANDING_LIMIT', { limit: 'perThread' })(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ),
  );
  // The same message under two approvals is acknowledged once.
  const again = await Promise.allSettled([
    mintStandingUse(slow, use(one, { ts: '6.000100' })),
    mintStandingUse(slow, use(two, { ts: '6.000100' })),
  ]);
  assert.equal(again.filter((result) => result.status === 'fulfilled').length, 1);
  const twice = (again.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason;
  assert.ok(twice instanceof CommsError && ['STANDING_REFUSED', 'STANDING_LIMIT'].includes(twice.code));
  await assert.rejects(
    mintStandingUse(core, use(two, { ts: '6.000100' })),
    refusedWith('STANDING_REFUSED', { reason: 'already-acknowledged' }),
  );
});

test('the ledger lock is taken before the standing record’s, and both are held when the use is written', async () => {
  const { core, clock } = machine();
  const record = await standing(core);
  const ledgerLock = join(core.paths.stateDir, 'standing', `${ACME}.jsonl.lock`);
  const standingLock = join(core.approvals.directory, `${record.approvalId}.json.lock`);
  const seen: string[] = [];
  class Watching extends AckLedger {
    override withLock<T>(
      accountId: string,
      fn: (entries: (AckUse | AckOutcome)[], append: (entry: AckUse) => Promise<void>) => Promise<T>,
    ): Promise<T> {
      return super.withLock(accountId, (entries, append) => {
        seen.push(`ledger held:${existsSync(ledgerLock)} standing held:${existsSync(standingLock)}`);
        return fn(entries, async (entry) => {
          seen.push(`writing: ledger held:${existsSync(ledgerLock)} standing held:${existsSync(standingLock)}`);
          await append(entry);
        });
      });
    }
  }
  await mintStandingUse(
    withLedger(core, new Watching(core.paths.stateDir, () => new Date(clock.now))),
    use(record, { ts: '7.1' }),
  );
  assert.deepEqual(seen, ['ledger held:true standing held:false', 'writing: ledger held:true standing held:true']);
});

test('a revoke that lands during a mint waits for it, and then ends the child it minted', async () => {
  const { core, clock } = machine();
  const record = await standing(core);
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  class Pausing extends AckLedger {
    override withLock<T>(
      accountId: string,
      fn: (entries: (AckUse | AckOutcome)[], append: (entry: AckUse) => Promise<void>) => Promise<T>,
    ): Promise<T> {
      return super.withLock(accountId, (entries, append) =>
        fn(entries, async (entry) => {
          entered();
          await released;
          await append(entry);
        }),
      );
    }
  }
  const minting = mintStandingUse(
    withLedger(core, new Pausing(core.paths.stateDir, () => new Date(clock.now))),
    use(record, { ts: '8.1' }),
  );
  await inside;
  const ending = endStanding(core, record.approvalId, 'ended by the person');
  await sleep(150);
  release();
  const minted = await minting;
  await ending;
  assert.equal(asV2(await core.approvals.get(record.approvalId))?.state, 'revoked');
  assert.equal(asV2(await core.approvals.get(minted.child.approvalId))?.state, 'revoked', 'the end reached its child');
});

test('a clock behind the last act refuses', async () => {
  const { core, clock } = machine();
  const record = await standing(core, { perThread: 3 });
  clock.now += 10 * MINUTE;
  await mintStandingUse(core, use(record, { ts: '9.1' }));
  // Back a second: still after the approval, so the store's own clock check passes; the ledger's does not.
  clock.now -= 1000;
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '9.2' })),
    refusedWith('STANDING_REFUSED', { reason: 'clock-behind' }),
  );
  // The same instant is not behind.
  clock.now += 1000;
  await mintStandingUse(core, use(record, { ts: '9.3' }));
});

test('a revoked or expired approval is refused at the mint', async () => {
  const revoked = machine();
  const ended = await standing(revoked.core);
  await endStanding(revoked.core, ended.approvalId, 'ended by the person');
  await assert.rejects(mintStandingUse(revoked.core, use(ended, { ts: '10.1' })), refusedWith('APPROVAL_VOID'));

  const expired = machine();
  const week = await standing(expired.core, { expiresDays: 7 });
  expired.clock.now += 7 * DAY;
  await assert.rejects(mintStandingUse(expired.core, use(week, { ts: '10.2' })), refusedWith('APPROVAL_EXPIRED'));

  // Narrowed to fewer days, it ends then.
  const narrowed = machine();
  const short = await standing(narrowed.core, { expiresDays: 7 });
  await narrowed.core.approvals.narrowStanding(short.approvalId, ACME, { limits: { expiresDays: 1 } });
  narrowed.clock.now += DAY;
  await assert.rejects(mintStandingUse(narrowed.core, use(short, { ts: '10.3' })), refusedWith('APPROVAL_EXPIRED'));

  // Ended by raising the standing epoch, or by `never`.
  const epoch = machine();
  const raised = await standing(epoch.core);
  await raiseStandingEpoch(epoch.core);
  await assert.rejects(mintStandingUse(epoch.core, use(raised, { ts: '10.4' })), refusedWith('APPROVAL_VOID'));
  const never = machine();
  const off = await standing(never.core);
  await applySendPolicyChange(never.core, (config) => {
    (config.accounts['acme/slack'] as AccountConfig).sendPolicy = 'never';
    return config;
  });
  await assert.rejects(mintStandingUse(never.core, use(off, { ts: '10.5' })), refusedWith('POLICY_NEVER'));
  // Nothing refused before the count is counted.
  for (const { core } of [revoked, expired, narrowed, epoch, never]) assert.deepEqual(await uses(core), []);
});

test("a content named by a digest the approval doesn't hold is refused", async () => {
  const { core } = machine();
  const record = await standing(core, { perThread: 3 });
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '11.1', contentDigest: 'f'.repeat(64) })),
    refusedWith('STANDING_REFUSED', { reason: 'content-not-held' }),
  );
  // A reply's digest is not a reaction, nor a reaction's a reply.
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '11.2', act: 'reaction', contentDigest: digestOf(record, 'reply') })),
    refusedWith('STANDING_REFUSED', { reason: 'content-not-held' }),
  );
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '11.3', act: 'reply', contentDigest: digestOf(record, 'reaction') })),
    refusedWith('STANDING_REFUSED', { reason: 'content-not-held' }),
  );
  // Nor one narrowed away since.
  await core.approvals.narrowStanding(record.approvalId, ACME, { keep: [digestOf(record, 'reply')] });
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '11.4' })),
    refusedWith('STANDING_REFUSED', { reason: 'content-not-held' }),
  );
  await mintStandingUse(core, use(record, { ts: '11.5', act: 'reply' }));
  assert.equal((await uses(core)).length, 1);
});

test('an outcome line, failed or unknown, never frees a count', async () => {
  const { core } = machine();
  const record = await standing(core, { perThread: 1, perHour: 2 });
  const first = await mintStandingUse(core, use(record, { ts: '12.1', thread: '12.0' }));
  await core.acks.recordOutcome(ACME, {
    kind: 'outcome',
    at: '2026-10-19T09:00:00.000Z',
    childId: first.child.approvalId,
    outcome: 'failed',
    notice: 'none',
  });
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '12.2', thread: '12.0' })),
    refusedWith('STANDING_LIMIT', { limit: 'perThread' }),
  );
  const second = await mintStandingUse(core, use(record, { ts: '12.3' }));
  await core.acks.recordOutcome(ACME, {
    kind: 'outcome',
    at: '2026-10-19T09:00:00.000Z',
    childId: second.child.approvalId,
    outcome: 'unknown',
    notice: 'none',
  });
  await assert.rejects(
    mintStandingUse(core, use(record, { ts: '12.4' })),
    refusedWith('STANDING_LIMIT', { limit: 'perHour' }),
  );
  // A malformed request is refused before anything is counted.
  const other = machine();
  const counted = await standing(other.core);
  await assert.rejects(
    mintStandingUse(other.core, use(counted, { ts: '13.1', childDigest: 'not-a-digest' })),
    refusedWith('UNEXPECTED'),
  );
  assert.deepEqual(await uses(other.core), []);
  // And a use refused after it was counted — here, a child the store could not write — stays counted.
  const failing = {
    ...other.core,
    approvals: {
      withStanding: other.core.approvals.withStanding.bind(other.core.approvals),
      createStandingChild: async () => {
        throw new CommsError('UNEXPECTED', 'the disk is full');
      },
    } as unknown as Core['approvals'],
  };
  await assert.rejects(mintStandingUse(failing, use(counted, { ts: '13.1' })), refusedWith('UNEXPECTED'));
  assert.equal((await uses(other.core)).length, 1, 'counted before the child was minted');
  await assert.rejects(
    mintStandingUse(other.core, use(counted, { ts: '13.1' })),
    refusedWith('STANDING_REFUSED', { reason: 'already-acknowledged' }),
  );
});

test('an unreadable ledger line refuses every use: nothing uncounted is guessed at', async () => {
  const { core } = machine();
  const record = await standing(core, { perThread: 3 });
  await mintStandingUse(core, use(record, { ts: '14.1' }));
  appendFileSync(join(core.paths.stateDir, 'standing', `${ACME}.jsonl`), '{"kind":"use","at":\n');
  await assert.rejects(mintStandingUse(core, use(record, { ts: '14.2' })), refusedWith('BAD_DATA'));
  // A report still reads what it can.
  assert.equal((await core.acks.entries(ACME)).length, 1);
});

test("the ledger path refuses an id that isn't an account id", async () => {
  const { core } = machine();
  for (const id of ['../escape', 'ibx_AAAAAAAAAAAAAAAA', 'acc_aaaaaaaaaaaaaaaa', '', 'acc_AAAAAAAAAAAAAAAA/x']) {
    await assert.rejects(core.acks.entries(id), refusedWith('USAGE'), id);
    await assert.rejects(
      core.acks.withLock(id, async () => undefined),
      refusedWith('USAGE'),
      id,
    );
    await assert.rejects(
      core.acks.recordOutcome(id, {
        kind: 'outcome',
        at: '2026-10-19T09:00:00.000Z',
        childId: 'x',
        outcome: 'sent',
        notice: 'none',
      }),
      refusedWith('USAGE'),
      id,
    );
  }
  assert.equal(existsSync(join(core.paths.stateDir, 'escape')), false);
});
