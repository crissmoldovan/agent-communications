import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SENDING_LEASE_MS } from '../src/approval-binding.ts';
import { asV2 } from '../src/approval-stored.ts';
import type { ApprovalRecord, Expectation } from '../src/approvals.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import {
  type ApprovalWait,
  MAX_WAITS,
  type WaitClock,
  type WaitOptions,
  waitForApproval,
} from '../src/operations/approval-wait.ts';
import { type LiveConfig, type LiveConfigState, liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Waiting for an approval (CUE-404 Task 10; design 2026-10-05 §D3): short, bounded, on every surface — and never
 * anything but a look. Everything here runs on a clock of its own: a wait's sleeps advance it, so a five-minute wait
 * takes no time and every read is at a known moment.
 */

const START = Date.parse('2026-10-05T09:00:00.000Z');
const OWNER = 'ibx_AAAAAAAAAAAAAAAA';
const OTHER = 'ibx_BBBBBBBBBBBBBBBB';
const EXPECT: Expectation = { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' };

interface World {
  core: Core;
  config: LiveConfig;
  clock: WaitClock & { at(): number; advance(ms: number): void };
  /** The moment, in clock time, of every look the wait made at the approval. */
  reads: number[];
  /** Runs before each look: what happens between two of them. */
  between: ((read: number) => Promise<void> | void) | null;
}

const owners = (over: Partial<LiveConfigState> = {}): LiveConfigState => ({
  sendPolicy: 'chat',
  changePolicy: 'chat',
  inboxes: { 'acme/gmail': { id: OWNER }, 'beta/gmail': { id: OTHER } },
  ...over,
});

function world(state: LiveConfigState = owners()): World {
  const dir = tempDir();
  let t = START;
  const config = liveConfig(dir, state);
  const core = openCore({
    env: { AGENT_COMMS_CONFIG_DIR: config.dir, HOME: dir, USERPROFILE: dir },
    now: () => new Date(t),
    caller: CORE_CALLER,
  });
  const w: World = {
    core,
    config,
    reads: [],
    between: null,
    clock: {
      now: () => t,
      at: () => t,
      advance: (ms) => {
        t += ms;
      },
      // A sleep moves the clock, and lets anything waiting on the event loop run — as a real one would.
      sleep: async (ms, signal) => {
        if (signal?.aborted) return;
        t += Math.max(0, ms);
        await new Promise((settle) => setImmediate(settle));
      },
    },
  };
  // Every look the wait makes, counted and timed — and the place a test makes something happen between two of them.
  const inspect = core.approvals.inspect.bind(core.approvals);
  core.approvals.inspect = async (...args: Parameters<typeof inspect>) => {
    await w.between?.(w.reads.length);
    w.reads.push(t);
    return inspect(...args);
  };
  return w;
}

function send(w: World, policy: 'chat' | 'confirm' = 'chat', owner = OWNER): Promise<ApprovalRecord> {
  return w.core.approvals.create({
    channel: 'gmail',
    inboxId: owner,
    inboxSub: 'sub-1',
    draftId: 'r-draft-1',
    draftMessageId: 'msg-v1',
    contentDigest: 'a'.repeat(64),
    sendEpoch: 0,
    policy,
    requiredPolicy: policy,
    riskFlags: [],
    expect: EXPECT,
  });
}

const LIVE = { draftMessageId: 'msg-v1', contentDigest: 'a'.repeat(64) };

async function approveAtTerminal(w: World, approvalId: string): Promise<void> {
  await w.core.approvals.approve(approvalId, 'terminal', LIVE, await w.core.approvals.issueChallenge(approvalId));
}

function wait(w: World, approvalId: string, options: Omit<WaitOptions, 'clock'> = {}): Promise<ApprovalWait> {
  return waitForApproval(w.core, approvalId, { ...options, clock: w.clock });
}

async function refusal(attempt: Promise<unknown>): Promise<CommsError> {
  return attempt.then(
    () => assert.fail('the wait was not refused'),
    (error: unknown) => {
      assert.ok(error instanceof CommsError, String(error));
      return error;
    },
  );
}

const bytes = (w: World, approvalId: string) =>
  readFileSync(join(w.core.approvals.directory, `${approvalId}.json`), 'utf8');

/** Every look at least a second after the one before it. */
function oncePerSecond(reads: readonly number[]): void {
  for (let index = 1; index < reads.length; index += 1) {
    const gap = (reads[index] as number) - (reads[index - 1] as number);
    assert.ok(gap >= 1000, `two looks ${gap} ms apart: ${reads.map((read) => read - START).join(', ')}`);
  }
}

// ── Shapes and limits ──────────────────────────────────────────────────────────────────────────────────────────────

test('zero seconds is the status now, one look; thirty is the default, three hundred the most, and nothing else is taken (D3-a)', async () => {
  const w = world(owners({ sendPolicy: 'confirm' }));
  const record = await send(w, 'confirm');
  const now = await wait(w, record.approvalId, { waitSeconds: 0 });
  assert.equal(now.approvalId, record.approvalId);
  assert.deepEqual([now.state, now.claimable, now.ended], ['pending', false, 'now']);
  assert.equal(now.approval.id, record.approvalId);
  assert.equal(now.approval.expiresAt, record.expiresAt);
  assert.equal(w.reads.length, 1, 'one look');

  w.reads.length = 0;
  const started = w.clock.at();
  const byDefault = await wait(w, record.approvalId);
  assert.deepEqual([byDefault.state, byDefault.ended], ['pending', 'timeout']);
  assert.equal(w.clock.at() - started, 30_000, 'thirty seconds, by default');
  assert.equal(byDefault.waitedSeconds, 30);

  for (const bad of [-1, 301, 1.5, Number.NaN]) {
    const error = await refusal(wait(w, record.approvalId, { waitSeconds: bad }));
    assert.equal(error.code, 'USAGE', String(bad));
  }
  // Three hundred is taken: the record's own deadline (thirty minutes) is later still, so the wait runs it out.
  const longest = await wait(w, record.approvalId, { waitSeconds: 300 });
  assert.deepEqual([longest.state, longest.ended], ['pending', 'timeout']);
  assert.equal(longest.waitedSeconds, 300);
});

test('a chat-route pending send is claimable at once: the wait returns on its first look (D3-c)', async () => {
  const w = world();
  const record = await send(w, 'chat');
  const seen = await wait(w, record.approvalId, { waitSeconds: 30 });
  assert.deepEqual([seen.state, seen.claimable, seen.ended], ['pending', true, 'claimable']);
  assert.equal(w.reads.length, 1);
});

test('a confirm-route wait keeps looking, and a terminal approval ends it approved and claimable, written by nobody else (D3-f, D3-j)', async () => {
  const w = world(owners({ sendPolicy: 'confirm' }));
  const record = await send(w, 'confirm');
  let approvedBytes = '';
  w.between = async (read) => {
    if (read === 4) {
      await approveAtTerminal(w, record.approvalId);
      approvedBytes = bytes(w, record.approvalId);
    }
  };
  const seen = await wait(w, record.approvalId, { waitSeconds: 30 });
  assert.deepEqual([seen.state, seen.claimable, seen.ended], ['approved', true, 'claimable']);
  assert.ok(seen.approval.usableUntil, 'with when it can be used until');
  assert.equal(w.reads.length, 5, 'four looks while it waited, the fifth saw the approval');
  assert.equal(bytes(w, record.approvalId), approvedBytes, 'the wait wrote nothing over the approval');
  oncePerSecond(w.reads);
});

test('a wait never looks past a pending deadline, nor past a sending record’s lease — renewed or not (D3-b)', async () => {
  // A chat route tightened to confirm waits inside its own ten minutes: a five-minute wait started at minute nine ends
  // at minute ten, expired, and looks no further.
  const w = world(owners({ sendPolicy: 'confirm' }));
  w.config.write(owners());
  const record = await send(w, 'chat');
  w.config.write(owners({ sendPolicy: 'confirm' }));
  w.clock.advance(9 * 60_000 + 500);
  const deadline = Date.parse(record.expiresAt);
  const expired = await wait(w, record.approvalId, { waitSeconds: 300 });
  assert.deepEqual([expired.state, expired.ended], ['expired', 'final']);
  assert.equal(expired.approval.expiredAt, record.expiresAt);
  assert.ok((w.reads.at(-1) as number) < deadline + 1000, 'the look after the deadline was the last');
  assert.ok(w.clock.at() < deadline + 1000);
  oncePerSecond(w.reads);

  // A send under way whose claimant stopped renewing: the wait ends at its lease boundary, with `unknown` written.
  const v = world();
  const sending = await send(v, 'chat');
  const { claimToken } = await v.core.approvals.claimForSend(sending.approvalId, {
    ...LIVE,
    inboxId: OWNER,
    inboxSub: 'sub-1',
    expect: EXPECT,
  });
  // A renewal a minute in moves the boundary on, and the wait follows it.
  v.between = async () => {
    if (v.clock.at() - START >= 60_000 && v.clock.at() - START < 61_000) {
      await v.core.approvals.heartbeat(sending.approvalId, claimToken);
    }
  };
  const lost = await wait(v, sending.approvalId, { waitSeconds: 300 });
  assert.deepEqual([lost.state, lost.ended], ['unknown', 'final']);
  const renewed = asV2(await v.core.approvals.get(sending.approvalId))?.sendingHeartbeatAt;
  assert.ok(renewed, 'the renewal landed beneath the wait');
  const boundary = Date.parse(renewed) + SENDING_LEASE_MS;
  assert.ok((v.reads.at(-1) as number) >= boundary && (v.reads.at(-1) as number) < boundary + 1000);
  assert.equal(asV2(await v.core.approvals.get(sending.approvalId))?.state, 'unknown', 'persisted at the boundary');
});

test('a wait that first sees a send under way follows it to used, to failed and to unknown, never saying to prepare again (D3-g)', async () => {
  for (const end of ['used', 'failed', 'unknown'] as const) {
    const w = world();
    const record = await send(w, 'chat');
    const { claimToken } = await w.core.approvals.claimForSend(record.approvalId, {
      ...LIVE,
      inboxId: OWNER,
      inboxSub: 'sub-1',
      expect: EXPECT,
    });
    w.between = async (read) => {
      if (read === 3 && end !== 'unknown') {
        await w.core.approvals.complete(
          record.approvalId,
          claimToken,
          end === 'used' ? { sentMessageId: 'sent-1' } : { error: 'Gmail refused it' },
        );
      }
    };
    const seen = await wait(w, record.approvalId, { waitSeconds: 300 });
    assert.equal(seen.state, end, end);
    assert.equal(seen.claimable, false);
    assert.doesNotMatch(`${seen.hint ?? ''}`, /prepare/i, `${end}: no prepare-again guidance`);
    assert.ok(w.reads.length >= (end === 'unknown' ? 120 : 4), `${end}: it kept looking while it was sending`);
  }
});

test('a timeout says where it stands: pending with the same id and whether it can be claimed, or sending with its lease (D3-e)', async () => {
  const w = world(owners({ sendPolicy: 'confirm' }));
  const record = await send(w, 'confirm');
  const pending = await wait(w, record.approvalId, { waitSeconds: 5 });
  assert.deepEqual(
    [pending.approvalId, pending.state, pending.claimable, pending.ended],
    [record.approvalId, 'pending', false, 'timeout'],
  );
  assert.doesNotMatch(pending.hint ?? '', /prepare/i);

  const v = world();
  const sending = await send(v, 'chat');
  await v.core.approvals.claimForSend(sending.approvalId, {
    ...LIVE,
    inboxId: OWNER,
    inboxSub: 'sub-1',
    expect: EXPECT,
  });
  const under = await wait(v, sending.approvalId, { waitSeconds: 5 });
  assert.deepEqual([under.state, under.claimable, under.ended], ['sending', false, 'timeout']);
  assert.ok(under.approval.sendingAt);
  assert.ok(under.approval.unknownAt);
  assert.doesNotMatch(under.hint ?? '', /prepare/i);
});

test('a wait stops at once on an approved send the live policy will not let be claimed, on a final state, and on expiry (D3-h)', async () => {
  const w = world(owners({ sendPolicy: 'confirm' }));
  const approved = await send(w, 'confirm');
  await approveAtTerminal(w, approved.approvalId);
  w.config.write(owners({ inboxes: { 'acme/gmail': { id: OWNER, sendPolicy: 'never' } } }));
  w.reads.length = 0;
  const blocked = await wait(w, approved.approvalId, { waitSeconds: 300 });
  assert.deepEqual([blocked.state, blocked.claimable, blocked.ended], ['approved', false, 'blocked']);
  assert.equal(w.reads.length, 1);

  w.config.write(owners());
  const revoked = await send(w, 'chat');
  await w.core.approvals.revoke(revoked.approvalId, 'the person said no', { disposition: 'person' });
  const no = await wait(w, revoked.approvalId, { waitSeconds: 300 });
  assert.deepEqual([no.state, no.ended], ['revoked', 'final']);
});

test('a download’s question: answered when the person answers it, expired when it runs out, never with a window of its own (D3-d)', async () => {
  const w = world(owners({ changePolicy: 'confirm' }));
  const question = await w.core.approvals.createDownload({
    channel: 'gmail',
    download: {
      summary: 'where to save 1 file from acme/gmail',
      target: { kind: 'inbox', name: 'acme/gmail', id: OWNER },
      operation: 'attachments.download',
      request: { selection: { kind: 'messages', ids: ['m1'] } },
      files: ['m1/1'],
      names: ['invoice.pdf'],
      folders: { downloads: '/srv/sam/Downloads', current: '/srv/sam/work' },
    },
    policy: 'confirm',
  });
  w.between = async (read) => {
    if (read === 2) await w.core.approvals.answerDownload(question.approvalId, 'terminal', { choice: 'downloads' });
  };
  const answered = await wait(w, question.approvalId, { waitSeconds: 30 });
  assert.deepEqual([answered.state, answered.claimable, answered.ended], ['answered', true, 'claimable']);
  assert.equal(answered.approval.usableUntil, undefined, 'a question has no window of its own');

  w.between = null;
  w.clock.advance(31 * 60_000);
  const late = await wait(w, question.approvalId, { waitSeconds: 30 });
  assert.deepEqual([late.state, late.claimable], ['expired', false]);
  assert.equal(late.approval.usableUntil, undefined);
});

test('a wait writes only what reading derives, lets a claimant’s renewals land beneath it, and never moves unknown (D3-i, D1sl-f)', async () => {
  const w = world();
  const record = await send(w, 'chat');
  const { claimToken } = await w.core.approvals.claimForSend(record.approvalId, {
    ...LIVE,
    inboxId: OWNER,
    inboxSub: 'sub-1',
    expect: EXPECT,
  });
  const writes: string[] = [];
  w.between = async (read) => {
    writes.push(bytes(w, record.approvalId));
    if (read % 20 === 10) await w.core.approvals.heartbeat(record.approvalId, claimToken);
  };
  await wait(w, record.approvalId, { waitSeconds: 60 });
  const states = new Set(writes.map((text) => (JSON.parse(text) as { state: string }).state));
  assert.deepEqual([...states], ['sending'], 'only the claimant’s renewals changed it');

  // Persisted unknown: status and a wait leave it exactly as it is.
  w.clock.advance(SENDING_LEASE_MS + 1000);
  await wait(w, record.approvalId, { waitSeconds: 0 });
  const unknown = bytes(w, record.approvalId);
  assert.equal((JSON.parse(unknown) as { state: string }).state, 'unknown');
  w.between = null;
  for (const waitSeconds of [0, 5]) {
    const seen = await wait(w, record.approvalId, { waitSeconds });
    assert.equal(seen.state, 'unknown');
    assert.equal(bytes(w, record.approvalId), unknown, `a ${waitSeconds}s wait wrote nothing`);
  }
});

test('a state change against a timeout or a cancellation is decided by the final locked look (D3-k)', async () => {
  const w = world(owners({ sendPolicy: 'confirm' }));
  const record = await send(w, 'confirm');
  // Approved in the last second of a five-second wait: the final look sees it.
  w.between = async () => {
    if (w.clock.at() - START === 5000) await approveAtTerminal(w, record.approvalId);
  };
  const atTheEnd = await wait(w, record.approvalId, { waitSeconds: 5 });
  assert.deepEqual([atTheEnd.state, atTheEnd.claimable, atTheEnd.ended], ['approved', true, 'claimable']);

  // Cancelled, and approved before the final look: the approval is what it says.
  const v = world(owners({ sendPolicy: 'confirm' }));
  const other = await send(v, 'confirm');
  const cancel = new AbortController();
  v.between = async (read) => {
    if (read === 3) {
      cancel.abort();
      await approveAtTerminal(v, other.approvalId);
    }
  };
  const decided = await wait(v, other.approvalId, { waitSeconds: 30, signal: cancel.signal });
  assert.deepEqual([decided.state, decided.claimable], ['approved', true]);

  // Cancelled with nothing changed: the wait was cancelled, not the approval.
  const u = world(owners({ sendPolicy: 'confirm' }));
  const third = await send(u, 'confirm');
  const stop = new AbortController();
  u.between = (read) => {
    if (read === 3) stop.abort();
  };
  const cancelled = await wait(u, third.approvalId, { waitSeconds: 30, signal: stop.signal });
  assert.deepEqual([cancelled.state, cancelled.claimable, cancelled.ended], ['cancelled', false, 'cancelled']);
  assert.equal(cancelled.approval.state, 'pending', 'the approval is as it was');
  assert.equal(asV2(await u.core.approvals.get(third.approvalId))?.state, 'pending');
});

// ── Resources ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Waits held open until `release` is called: a clock whose sleeps do not end until then, and then move time on. */
function heldWaits(w: World) {
  let release!: () => void;
  const released = new Promise<void>((settle) => {
    release = settle;
  });
  const held: WaitClock = {
    now: () => w.clock.at(),
    sleep: async (ms) => {
      await released;
      w.clock.advance(ms);
      await new Promise((settle) => setImmediate(settle));
    },
  };
  return { held, release };
}

test('the ninth wait at once in a process is refused, as a retryable TRANSIENT "too many waits" (D3r-a)', async () => {
  const w = world(owners({ sendPolicy: 'confirm' }));
  const record = await send(w, 'confirm');
  const { held, release } = heldWaits(w);
  const open = Array.from({ length: MAX_WAITS }, () =>
    waitForApproval(w.core, record.approvalId, { waitSeconds: 5, clock: held }),
  );
  const ninth = await refusal(waitForApproval(w.core, record.approvalId, { waitSeconds: 0, clock: w.clock }));
  assert.equal(ninth.code, 'TRANSIENT');
  assert.match(ninth.message, /too many waits/);
  assert.equal(ninth.retryable, true);
  release();
  await Promise.all(open);
  // All eight ended: eight at once fit again.
  const again = await Promise.all(
    Array.from({ length: MAX_WAITS }, () =>
      waitForApproval(w.core, record.approvalId, { waitSeconds: 0, clock: w.clock }),
    ),
  );
  assert.equal(again.length, MAX_WAITS);
});

test('every way a wait ends — success, timeout, cancellation, an error — frees its place for an eighth (D3r-b)', async () => {
  for (const how of ['success', 'timeout', 'cancellation', 'error'] as const) {
    const w = world(owners({ sendPolicy: 'confirm' }));
    const record = await send(w, 'confirm');
    const { held, release } = heldWaits(w);
    const open = Array.from({ length: MAX_WAITS - 1 }, () =>
      waitForApproval(w.core, record.approvalId, { waitSeconds: 5, clock: held }),
    );
    // Each open wait makes one look and then holds. Every one has made it before the wait that ends starts, so the
    // read the error case breaks is that wait's own, never an open wait's that a slow machine let run late (CUE-472).
    while (w.reads.length < MAX_WAITS - 1) await new Promise((settle) => setImmediate(settle));
    const cancel = new AbortController();
    if (how === 'cancellation') cancel.abort();
    if (how === 'error') {
      w.between = (read) => {
        if (read >= MAX_WAITS) throw new CommsError('LOCK_TIMEOUT', 'the approval could not be read');
      };
    }
    const ended = await waitForApproval(w.core, record.approvalId, {
      waitSeconds: how === 'success' ? 0 : 3,
      ...(how === 'cancellation' ? { signal: cancel.signal } : {}),
      clock: w.clock,
    }).then(
      (result) => result.ended,
      (error: unknown) => (error as CommsError).code,
    );
    assert.equal(ended, { success: 'now', timeout: 'timeout', cancellation: 'cancelled', error: 'LOCK_TIMEOUT' }[how]);
    w.between = null;
    // Its place is free: an eighth is admitted, and only a ninth is refused.
    const eighth = waitForApproval(w.core, record.approvalId, { waitSeconds: 5, clock: held });
    const ninth = await refusal(waitForApproval(w.core, record.approvalId, { waitSeconds: 0, clock: w.clock }));
    assert.equal(ninth.code, 'TRANSIENT', how);
    release();
    await Promise.all([...open, eighth]);
  }
});

test('progress comes every fifteen seconds to a caller that asked for it, and to nobody else (D3r-d)', async () => {
  const w = world(owners({ sendPolicy: 'confirm' }));
  const record = await send(w, 'confirm');
  const progress: number[] = [];
  await wait(w, record.approvalId, {
    waitSeconds: 40,
    onProgress: (step) => {
      progress.push(step.waitedSeconds);
    },
  });
  assert.deepEqual(progress, [15, 30]);
  // Without a listener, the same wait reports nothing, and is the same wait.
  const quiet = await wait(w, record.approvalId, { waitSeconds: 40 });
  assert.equal(quiet.ended, 'timeout');
});

test('a wait looks at the approval at most once a second, and reads nothing else of it (D3r-e)', async () => {
  const w = world(owners({ sendPolicy: 'confirm' }));
  const record = await send(w, 'confirm');
  await wait(w, record.approvalId, { waitSeconds: 20 });
  assert.equal(w.reads.length, 21, 'one look a second, the first at once and the last at the end');
  oncePerSecond(w.reads);
});

test('an id nobody prepared, another owner’s, and one pinned to an owner since removed are the one NOT_FOUND (D3r-f, R33e)', async () => {
  const w = world();
  const theirs = await send(w, 'chat', OTHER);
  const envelopes: string[] = [];
  for (const [id, owner] of [
    [`ap_${'7'.repeat(26)}`, OWNER],
    [theirs.approvalId, OWNER],
  ] as const) {
    const error = await refusal(wait(w, id, { waitSeconds: 30, owner }));
    assert.equal(error.code, 'NOT_FOUND');
    assert.deepEqual(error.details, { approval: null });
    envelopes.push(JSON.stringify({ m: error.message, h: error.hint, d: error.details }).replaceAll(id, 'ID'));
  }
  // Pinned to the owner it was prepared for, which has since been removed: that owner is nobody's now.
  w.config.write(owners({ inboxes: { 'acme/gmail': { id: OWNER } } }));
  const removed = await refusal(wait(w, theirs.approvalId, { waitSeconds: 30, owner: OTHER }));
  assert.equal(removed.code, 'NOT_FOUND');
  envelopes.push(
    JSON.stringify({ m: removed.message, h: removed.hint, d: removed.details }).replaceAll(theirs.approvalId, 'ID'),
  );
  assert.equal(new Set(envelopes).size, 1, 'one envelope, byte for byte');
});

test('a removed owner’s record: status and a wait show it revoked at once, owner removed, and write nothing (R33b)', async () => {
  const w = world();
  const record = await send(w, 'chat');
  w.config.write(owners({ inboxes: { 'beta/gmail': { id: OTHER } } }));
  const before = bytes(w, record.approvalId);
  for (const waitSeconds of [0, 30]) {
    const seen = await wait(w, record.approvalId, { waitSeconds });
    assert.deepEqual([seen.state, seen.claimable, seen.approval.ownerRemoved], ['revoked', false, true]);
    assert.notEqual(seen.ended, 'timeout', 'it returned at once');
  }
  assert.equal(bytes(w, record.approvalId), before, 'a look writes no revocation');
});

test('the hint after a timeout names how to wait again on the surface that asked, from its manifest', async () => {
  const w = world(owners({ sendPolicy: 'confirm' }));
  const record = await send(w, 'confirm');
  const core = await wait(w, record.approvalId, { waitSeconds: 1 });
  assert.match(core.hint ?? '', /comms_approval_wait/);
  const gmail = await wait(w, record.approvalId, { waitSeconds: 1, channel: 'gmail' });
  assert.match(gmail.hint ?? '', /the Gmail server’s wait/);
  assert.doesNotMatch(gmail.hint ?? '', /comms_approval_wait/);
});

test('a question’s wait follows the live change policy: one asked in the chat waits while the policy is tightened and stops as it is loosened again; one asked for the terminal waits however loose it is made (R21b)', async () => {
  const question = (w: World, policy: 'chat' | 'confirm') =>
    w.core.approvals.createDownload({
      channel: 'gmail',
      download: {
        summary: 'where to save 1 file from acme/gmail',
        target: { kind: 'inbox', name: 'acme/gmail', id: OWNER },
        operation: 'attachments.download',
        request: { selection: { kind: 'messages', ids: ['m1'] } },
        files: ['m1/1'],
        names: ['invoice.pdf'],
        folders: { downloads: '/srv/sam/Downloads', current: '/srv/sam/work' },
      },
      policy,
    });

  // Asked in the chat, then the policy tightened: it waits for the terminal — until the policy is loosened mid-wait.
  const chat = world(owners({ changePolicy: 'chat' }));
  const asked = await question(chat, 'chat');
  chat.config.write(owners({ changePolicy: 'confirm' }));
  chat.between = (read) => {
    if (read === 3) chat.config.write(owners({ changePolicy: 'chat' }));
  };
  const loosened = await wait(chat, asked.approvalId, { waitSeconds: 30 });
  assert.deepEqual([loosened.state, loosened.claimable, loosened.ended], ['pending', true, 'claimable']);
  assert.equal(chat.reads.length, 4, 'it stopped at the first look after the policy was loosened');
  // Tightened again before it is used: a wait waits for a person once more, and times out still waiting.
  chat.between = null;
  chat.config.write(owners({ changePolicy: 'confirm' }));
  const tightened = await wait(chat, asked.approvalId, { waitSeconds: 5 });
  assert.deepEqual([tightened.state, tightened.claimable, tightened.ended], ['pending', false, 'timeout']);

  // Asked for the terminal: loosening the policy mid-wait changes nothing; only the person's answer ends it.
  const terminal = world(owners({ changePolicy: 'confirm' }));
  const held = await question(terminal, 'confirm');
  terminal.between = async (read) => {
    if (read === 2) terminal.config.write(owners({ changePolicy: 'chat' }));
    if (read === 6) await terminal.core.approvals.answerDownload(held.approvalId, 'terminal', { choice: 'downloads' });
  };
  const answered = await wait(terminal, held.approvalId, { waitSeconds: 30 });
  assert.deepEqual([answered.state, answered.claimable, answered.ended], ['answered', true, 'claimable']);
  assert.equal(terminal.reads.length, 7, 'it went on waiting after the policy was loosened');
});
