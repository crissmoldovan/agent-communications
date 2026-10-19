import type { ApprovalRecord, Expectation } from './approvals.ts';
import type { Core } from './core.ts';
import { CommsError } from './errors.ts';
import { handoffSentence, requireHandoffs } from './handoffs.ts';
import { newApprovalId } from './ids.ts';
import {
  effectiveStanding,
  STANDING_ACTS,
  STANDING_DAY_MS,
  type StandingAct,
  type StandingContent,
  type StandingPlaces,
  standingDays,
  standingLimitReached,
  standingRefused,
} from './standing.ts';
import type { AckUse } from './standing-ledger.ts';

/**
 * Using a standing approval (design 2026-10-19-standing-approvals, S9): the one place a use is counted and its one-shot
 * child minted. The channel reads Slack first, with no lock held — the message, its thread, the place, the label's
 * route, the behaviour rules — and then calls this, which decides under the account's acknowledgement ledger lock and
 * then the standing record's, in that order and never the other way round:
 *
 * 1. the record's own refusal — revoked, expired, an epoch behind, its account gone, `never`;
 * 2. APPROVAL_PENDING until a person has approved it at a terminal;
 * 3. its narrowed expiry;
 * 4. the content: one it still holds, of the act's kind;
 * 5. the place: one it still covers, as narrowed — a narrowing made while Slack was read refuses here;
 * 6. the clock: never earlier than the account's last standing act, so moving it back frees nothing;
 * 7. the target: a message acknowledged once, under any standing approval;
 * 8. `perThread`, across every standing approval of the account;
 * 9. `perHour` and `perDay`, of this one;
 * 10. `perSender`: a day's acts on messages from one person, across every standing approval of the account;
 * 11. the `use` line written — the count spent — naming the child about to be minted;
 * 12. the child minted.
 *
 * Nothing ever removes a `use` line: a count is never refunded, whatever is refused after it, however the act ends.
 */

/** One use, as the channel read it: which approval, which act and content, the message, and the child's fields. */
export interface StandingUseRequest {
  standingId: string;
  accountId: string;
  inboxSub: string;
  act: StandingAct;
  /** The content's digest, as the standing approval names it: never its position. */
  contentDigest: string;
  /**
   * The message, and where it is: `places` is the kind of place its reads were checked against — the exact channel, or
   * a thread the person posted in — which the record must still cover under its lock.
   */
  target: {
    channel: string;
    ts: string;
    thread: string;
    textDigest: string;
    edited: boolean;
    places: StandingPlaces['kind'];
    /** Who wrote the message, by their Slack id: what `perSender` counts by. */
    sender: string;
  };
  child: { draftId: string; draftMessageId: string; contentDigest: string; expect: Expectation; riskFlags: string[] };
}

/** What a notification on the person's screen says (S10). */
export interface Notice {
  title: string;
  body: string;
}

/** Raises a notice, best effort: it never throws, and says why when it could not. */
export type Notifier = (notice: Notice) => Promise<{ raised: true } | { raised: false; reason: string }>;

const HOUR_MS = 60 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * What an agent is told when a standing approval does not cover an act: stop and ask the person, with the located
 * `standing list` — which shows what each covers — and never a command that makes or widens one.
 */
function askInstead(core: Core): string {
  return handoffSentence(
    requireHandoffs(core).core(['standing', 'list']),
    (command) =>
      `Stop, and ask the person instead: ${command}, or comms_standing, shows what each standing approval covers. Do not try again.`,
    {
      instead:
        'Stop, and ask the person instead; comms_standing shows what each standing approval covers. Do not try again.',
    },
  );
}

/**
 * Whether `places`, as in force, still covers a use in `channel` whose reads were checked against `checked`: an exact
 * place by its id, or `threads-i-am-in` — which the Slack reads alone can settle — only while the record is still that.
 */
export function useCovered(places: StandingPlaces, checked: StandingPlaces['kind'], channel: string): boolean {
  if (places.kind !== checked) return false;
  return places.kind === 'threads-i-am-in' || places.places.some((place) => place.id === channel);
}

/** The request's own shape, before any lock is taken: a programming error otherwise, and nothing counted. */
function checkedRequest(request: StandingUseRequest): void {
  const filled = (value: unknown) => typeof value === 'string' && value !== '';
  const { target, child } = request;
  if (
    !STANDING_ACTS.includes(request.act) ||
    !filled(request.contentDigest) ||
    !filled(target.channel) ||
    !filled(target.ts) ||
    !filled(target.thread) ||
    (target.places !== 'exact' && target.places !== 'threads-i-am-in') ||
    !filled(target.sender) ||
    !HEX64.test(target.textDigest) ||
    typeof target.edited !== 'boolean' ||
    !filled(child.draftId) ||
    !filled(child.draftMessageId) ||
    !HEX64.test(child.contentDigest)
  ) {
    throw new CommsError('UNEXPECTED', 'nothing was sent: a standing use was asked for without what it acts on', {
      hint: 'This is a bug — please report it.',
    });
  }
}

/**
 * Counts one use of a standing approval and mints its one-shot child (S9), in the order above, under both locks.
 *
 * The child is approved when it is made, bound to the standing id, the standing epoch and the send epoch the standing
 * record holds, and usable once, within `APPROVAL_LIFETIMES.standingChild`. It takes the unchanged send path: the
 * caller claims it with `claimForSend`, and the store refuses a second claim. If anything fails once the `use` line is
 * written — the child, the newest-message check after it, the act itself — the count stays spent.
 */
export async function mintStandingUse(
  core: Core,
  request: StandingUseRequest,
): Promise<{ child: ApprovalRecord; standing: ApprovalRecord; content: StandingContent }> {
  checkedRequest(request);
  return core.acks.withLock(request.accountId, (entries, append) =>
    core.approvals.withStanding(request.standingId, request.accountId, async (record, outcome) => {
      // 1. Whatever the record's state and the configuration refuse: revoked, expired, an epoch behind, never.
      if (outcome.error) throw outcome.error;
      // 2. Approved by a person, at a terminal, with the binding they approved — and for this account's user.
      if (record.state === 'pending') {
        throw new CommsError('APPROVAL_PENDING', 'nothing was sent: this standing approval waits for the person', {
          hint: 'It is approved only with the code typed at a terminal. Ask the person instead of acting.',
          details: { approvalId: record.approvalId, state: record.state },
        });
      }
      const standing = record.standing;
      if (
        record.state !== 'approved' ||
        standing === undefined ||
        record.approvedAt === undefined ||
        record.approvedVia !== 'terminal' ||
        record.approvedBindingDigest !== record.bindingDigest ||
        record.inboxSub !== request.inboxSub
      ) {
        throw new CommsError('APPROVAL_VOID', 'nothing was sent: this standing approval is not in force', {
          hint: askInstead(core),
          details: { approvalId: record.approvalId, state: record.state },
        });
      }
      const now = core.acks.now();
      const at = now.toISOString();
      const time = now.getTime();
      // 3. Its expiry as narrowed: the earlier of its own days and a narrowing's.
      const inForce = effectiveStanding(standing, record.narrowed);
      const ends = Date.parse(record.approvedAt) + standingDays(standing, record.narrowed) * STANDING_DAY_MS;
      if (time >= ends) {
        throw new CommsError('APPROVAL_EXPIRED', 'nothing was sent: this standing approval has ended', {
          hint: askInstead(core),
          details: { approvalId: record.approvalId, endedAt: new Date(ends).toISOString() },
        });
      }
      // 4. A content it still holds, of this act's kind, by its digest.
      const content = inForce.contents.find(
        (held) => held.digest === request.contentDigest && held.kind === request.act,
      );
      if (content === undefined) throw standingRefused('content-not-held', askInstead(core));
      const { channel, ts, thread } = request.target;
      // 5. A place it still covers, as in force now: narrowed while Slack was read, it is refused here, uncounted.
      if (!useCovered(inForce.places, request.target.places, channel)) {
        throw standingRefused('place-not-covered', askInstead(core));
      }
      // 6. Never before the account's last act: a clock moved back frees nothing.
      const newest = Math.max(Number.NEGATIVE_INFINITY, ...entries.map((entry) => Date.parse(entry.at)));
      if (time < newest) throw standingRefused('clock-behind', askInstead(core));
      // Only `use` lines count, all of them: an outcome — sent, failed, unknown — frees nothing.
      const used = entries.filter((entry): entry is AckUse => entry.kind === 'use');
      // 7. One message, acknowledged once, under any standing approval of the account.
      if (used.some((entry) => entry.channel === channel && entry.ts === ts)) {
        throw standingRefused('already-acknowledged', askInstead(core));
      }
      // 8. Per thread — or per message outside one — across every standing approval of the account.
      const inThread = used.filter((entry) => entry.channel === channel && entry.thread === thread).length;
      if (inThread >= inForce.limits.perThread) {
        throw standingLimitReached('perThread', inForce.limits.perThread, null, askInstead(core));
      }
      // 9. Per hour and per day, of this standing approval: each frees as its oldest use in the window leaves it.
      const mine = used.filter((entry) => entry.standingId === record.approvalId).map((entry) => Date.parse(entry.at));
      for (const [limit, window] of [
        ['perHour', HOUR_MS],
        ['perDay', STANDING_DAY_MS],
      ] as const) {
        const inWindow = mine.filter((when) => when > time - window);
        if (inWindow.length >= inForce.limits[limit]) {
          const freesAt = new Date(Math.min(...inWindow) + window).toISOString();
          throw standingLimitReached(limit, inForce.limits[limit], freesAt, askInstead(core));
        }
      }
      // 10. Per sender, a day, across every standing approval of the account: what one recipient can be told by which
      // of their messages are acknowledged is bounded by this, whatever else is allowed.
      const fromSender = used
        .filter((entry) => entry.sender === request.target.sender)
        .map((entry) => Date.parse(entry.at))
        .filter((when) => when > time - STANDING_DAY_MS);
      if (fromSender.length >= inForce.limits.perSender) {
        const freesAt = new Date(Math.min(...fromSender) + STANDING_DAY_MS).toISOString();
        throw standingLimitReached('perSender', inForce.limits.perSender, freesAt, askInstead(core));
      }
      // 11. The count spent, before the child exists: written under both locks, and never removed.
      const childId = newApprovalId();
      await append({
        kind: 'use',
        at,
        standingId: record.approvalId,
        childId,
        act: request.act,
        contentDigest: content.digest,
        channel,
        ts,
        thread,
        sender: request.target.sender,
        targetDigest: request.target.textDigest,
        edited: request.target.edited,
      });
      // 12. The child, under the id its count names.
      const child = await core.approvals.createStandingChild({
        approvalId: childId,
        standingId: record.approvalId,
        standingEpoch: record.standingEpoch as number,
        inboxId: request.accountId,
        inboxSub: request.inboxSub,
        draftId: request.child.draftId,
        draftMessageId: request.child.draftMessageId,
        contentDigest: request.child.contentDigest,
        sendEpoch: record.sendEpoch as number,
        riskFlags: [...request.child.riskFlags],
        expect: request.child.expect,
        use: { channel, thread, content: content.digest },
      });
      return { child, standing: record, content };
    }),
  );
}
