import {
  type AckOutcome,
  type AckUse,
  type ApprovalRecord,
  approveStandingAtTerminal,
  asV2,
  type CommsError,
  type StandingAct,
} from '@agentcomms/core';
import { type AckRequest, type AckResult, ack } from '../../src/operations/ack.ts';
import { prepareStandingAdd, type StandingAddRequest } from '../../src/operations/standing.ts';
import type { Reply, WorldMessage } from './fake-slack.ts';
import { recordOf, SAM, type StandingWorld, terminal } from './standing.ts';

/**
 * Using a standing approval, against the stateful fake (design 2026-10-19-standing-approvals, S4–S10): standing
 * approvals made and approved the way a person makes them, messages that have just arrived, and a way to act between
 * the mint and the claim — where a rule, a label or another tool could land.
 */

let sequence = 0;

/** A Slack ts for a moment `ms` since the epoch, unique in this process. */
export function tsAt(ms: number): string {
  sequence += 1;
  return `${Math.floor(ms / 1000)}.${String(sequence).padStart(6, '0')}`;
}

/** A message that arrived `ago` milliseconds before now (ten seconds when left out), from Sam unless said otherwise. */
export function say(
  w: StandingWorld,
  message: Omit<Partial<WorldMessage>, 'ts'> & { readonly channel: string; readonly ago?: number },
): string {
  const { ago, ...rest } = message;
  const ts = tsAt(w.clock.now - (ago ?? 10_000));
  w.world.messages.push({ text: 'can someone look at the deploy?', user: SAM, via: 'user', ...rest, ts });
  return ts;
}

/** A standing approval, made as a person makes one at their terminal, and approved there with its code. */
export interface Standing {
  readonly id: string;
  readonly record: ApprovalRecord;
  /** The digest of the content of this kind and text, as `standing list` shows it. */
  digest(kind: StandingAct, text: string): string;
}

/**
 * Makes and approves a standing approval for `acme`, then moves the clock on a minute, so a message said after it is
 * fresh and newer than it.
 */
export async function standing(w: StandingWorld, request: StandingAddRequest): Promise<Standing> {
  const outcome = await prepareStandingAdd(w.context, 'acme', request, w.slack, { proposedBy: 'person' });
  if (outcome.status !== 'approval-required') throw new Error('a new standing approval was narrowed');
  const id = outcome.prepared.approvalId;
  await approveStandingAtTerminal(w.core, id, {}, { color: false, platform: 'darwin' }, terminal());
  const record = await recordOf(w, id);
  if (record.state !== 'approved') throw new Error(`standing approval ${id} is ${record.state}`);
  w.clock.now += 60_000;
  return {
    id,
    record,
    digest: (kind, text) => {
      const held = record.standing?.contents.find((content) => content.kind === kind && content.text === text);
      if (held === undefined) throw new Error(`standing approval ${id} holds no ${kind} "${text}"`);
      return held.digest;
    },
  };
}

/** One acknowledgement, as `slack_ack` and `agent-slack ack` make it. */
export function acknowledge(w: StandingWorld, request: AckRequest): Promise<AckResult> {
  return ack(w.context, 'acme', request, w.slack);
}

/** The refusal a promise rejects with — failing the test, with `what`, if it resolves. */
export async function refused(work: Promise<unknown>, what: string): Promise<CommsError> {
  return work.then(
    (value) => {
      throw new Error(`${what}: it went through — ${JSON.stringify(value)}`);
    },
    (error: unknown) => error as CommsError,
  );
}

/** The account's acknowledgement ledger, as it reads now. */
export async function ledger(w: StandingWorld): Promise<{ uses: AckUse[]; outcomes: AckOutcome[] }> {
  const accountId = (await w.context.config()).accounts.acme?.id as string;
  const entries = await w.core.acks.entries(accountId);
  return {
    uses: entries.filter((entry): entry is AckUse => entry.kind === 'use'),
    outcomes: entries.filter((entry): entry is AckOutcome => entry.kind === 'outcome'),
  };
}

/** Every standing child the store holds, as it reads now. */
export async function children(w: StandingWorld): Promise<ApprovalRecord[]> {
  return (await w.core.approvals.list())
    .map((stored) => asV2(stored))
    .filter((record): record is ApprovalRecord => record !== null && record.route === 'standing');
}

/**
 * Runs `between` once, after every Slack read an acknowledgement makes before its mint and before the mint takes its
 * first lock: where a narrowing, a revoke or another tool could land while Slack is being read.
 */
export function beforeMint(w: StandingWorld, between: () => Promise<void>): void {
  const acks = w.core.acks;
  const withLock = acks.withLock.bind(acks);
  let ran = false;
  acks.withLock = (async (...args: Parameters<typeof withLock>) => {
    if (!ran) {
      ran = true;
      await between();
    }
    return withLock(...args);
  }) as typeof acks.withLock;
}

/**
 * Runs `between` once, the first time Slack is asked to read a thread or a channel after a standing child has been
 * minted and before it is claimed: the read `ack` makes again just before the act. Whatever `between` asks Slack is
 * answered as usual, and does not run it again.
 */
export function betweenMintAndClaim(w: StandingWorld, between: (child: ApprovalRecord) => Promise<void>): void {
  let ran = false;
  let running = false;
  for (const method of ['conversations.replies', 'conversations.history'] as const) {
    const answer = w.fake.script[method] as Reply;
    w.fake.script[method] = async (request) => {
      if (!ran && !running) {
        const [child] = (await children(w)).filter((record) => record.state === 'approved');
        if (child !== undefined) {
          running = true;
          try {
            await between(child);
          } finally {
            running = false;
            ran = true;
          }
        }
      }
      return answer(request);
    };
  }
}
