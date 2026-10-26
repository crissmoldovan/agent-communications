/**
 * Taking messages, what every channel does the same way (design 2026-10-26-taking-messages §5, §6): a channel's
 * `take` tool and command run `takeStep`, every act that answers a message asks `gateTake` at prepare and again at the
 * claim, and every read asks `takenViews` for the `taken` it adds to each message. The channel brings what only it
 * can: the message read from its provider and checked as inbound (T5), and its own words for how to take it.
 */

import type { Config } from './config.ts';
import { CommsError } from './errors.ts';
import { type CliHandoffs, handoffSentence } from './handoff-text.ts';
import {
  checkedNote,
  HAND_BACK_REASONS,
  type HandBackReason,
  isHandBackReason,
  isPerson,
  MAX_TAKEN_MESSAGES,
  TAKE_LEASE_MS,
  type TakeAct,
  type TakeCaller,
  type TakeGatePass,
  type TakeMessage,
  type TakeMessageRef,
  type TakenView,
  type TakeOutcome,
  type TakeRecord,
  type TakeStore,
} from './takes.ts';
import { takingFor } from './taking.ts';

/** §5: what a channel's take tool does, told apart by `step`. */
export const TAKE_STEPS: readonly ['take', 'hand-back', 'done'] = Object.freeze(['take', 'hand-back', 'done'] as const);
export type TakeStep = (typeof TAKE_STEPS)[number];

/** A step as a tool or a command hands it over, before it is checked. */
export interface TakeStepRequest {
  readonly step?: unknown;
  readonly reason?: unknown;
  readonly note?: unknown;
}

export interface CheckedTakeStep {
  readonly step: TakeStep;
  readonly reason?: HandBackReason | undefined;
  readonly note?: string | undefined;
}

/** A step checked as USAGE before anything is read: its word, a hand-back's closed reason, and a note's length. */
export function checkedTakeStep(request: TakeStepRequest): CheckedTakeStep {
  const step = request.step ?? 'take';
  if (typeof step !== 'string' || !(TAKE_STEPS as readonly string[]).includes(step)) {
    throw new CommsError('USAGE', `step is take, hand-back or done, not "${String(step).slice(0, 40)}"`);
  }
  if (step === 'hand-back') {
    if (!isHandBackReason(request.reason)) {
      throw new CommsError(
        'USAGE',
        request.reason === undefined
          ? 'a hand-back says why, in closed words'
          : `"${String(request.reason).slice(0, 40)}" is not a reason a message is handed back for`,
        { hint: `The reasons are: ${HAND_BACK_REASONS.join(', ')}. A note, for the person alone, may say more.` },
      );
    }
  } else if (request.reason !== undefined) {
    throw new CommsError('USAGE', 'a reason goes with a hand-back only');
  }
  if (step === 'take' && request.note !== undefined) {
    throw new CommsError('USAGE', 'a note goes with a hand-back or a done, for the person: a take carries none');
  }
  const note = checkedNote(request.note);
  return {
    step: step as TakeStep,
    ...(step === 'hand-back' ? { reason: request.reason as HandBackReason } : {}),
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * The person at their own terminal takes nothing (T2): a take is held by an agent session, and the person is never held
 * to taking. They keep a message with core's `takes keep`.
 */
export function personTakesNothing(handoffs: CliHandoffs | undefined, account: string, message: string): CommsError {
  const instead = 'To handle the message yourself, keep it with core’s takes keep, so every session leaves it.';
  return new CommsError(
    'USAGE',
    'this command runs at your own terminal, which is never held to taking: a take is held by an agent session',
    {
      hint:
        handoffs === undefined
          ? instead
          : handoffSentence(
              handoffs.core(['takes', 'keep', account, message]),
              (command) => `To handle the message yourself, keep it with ${command}, so every session leaves it.`,
            ),
    },
  );
}

/** What a take step did, as a channel's tool and command return it: content-free (§5). */
export interface TakeStepResult {
  /** The provider's id of the message. */
  readonly message: string;
  /** Its thread, as the record keeps it; null when it has none or is not known. */
  readonly thread: string | null;
  readonly step: TakeStep;
  /** Where it stands now: `taken` after a take, `open` after a hand-back, `done` after a done. */
  readonly state: TakeRecord['state'];
  /** True while this session holds it. */
  readonly you: boolean;
  /** When this session's take lapses with no further act; null while an approval holds it, or when it holds none. */
  readonly leaseUntil: string | null;
  /** False when a take only renewed this session's own, or a done was already done. */
  readonly changed: boolean;
  /** Who has it, in closed words (T7). */
  readonly taken: TakenView;
}

function resultOf(step: TakeStep, outcome: TakeOutcome): TakeStepResult {
  const record = outcome.record;
  const you = outcome.view !== null && outcome.view.by === 'you';
  const leaseUntil =
    you && record.state === 'taken' && record.lastActAt !== null && record.pins.length === 0 && !isPerson(record.holder)
      ? new Date(Date.parse(record.lastActAt) + TAKE_LEASE_MS).toISOString()
      : null;
  return {
    message: record.message.id,
    thread: record.message.thread,
    step,
    state: record.state,
    you,
    leaseUntil,
    changed: outcome.changed,
    taken: outcome.view,
  };
}

/**
 * One take step for one message (§5): `take` reads the message first, through the channel (`verify`, which refuses one
 * that is missing or not inbound, T5) and takes it; `hand-back` and `done` need the record a take made, and only the
 * holder may. `caller` null — the person — is refused (`personTakesNothing`). A take, a hand-back and a done write no
 * activity line (T10): the record's history is the story.
 */
export async function takeStep(
  store: TakeStore,
  args: {
    readonly caller: TakeCaller;
    readonly request: CheckedTakeStep;
    readonly ref: TakeMessageRef;
    readonly act: TakeAct;
    readonly verify: () => Promise<TakeMessage>;
    readonly handoffs?: CliHandoffs | undefined;
  },
): Promise<TakeStepResult> {
  const { caller, request, ref, act } = args;
  if (caller === null) throw personTakesNothing(args.handoffs, act.account, ref.id);
  switch (request.step) {
    case 'take':
      return resultOf('take', await store.take(await args.verify(), caller));
    case 'hand-back':
      return resultOf(
        'hand-back',
        await store.handBack(ref, caller, request.reason as HandBackReason, request.note, act),
      );
    default:
      return resultOf('done', await store.finish(ref, caller, request.note, act));
  }
}

/**
 * §6: an act that answers a message, asked at prepare and again at the claim. Whether a take is required is read from
 * the configuration as it is now, for the account by its id, failing closed (`takingFor`). The person passes; a session
 * passes when it holds the message — renewing its lease, and pinning it under `approvalId` while that approval waits —
 * and is refused otherwise: `TAKEN_ELSEWHERE` when anyone else has it, `TAKE_REQUIRED` when a take is required and it
 * has none.
 */
export async function gateTake(
  store: TakeStore,
  config: Config,
  args: {
    readonly ref: TakeMessageRef;
    readonly caller: TakeCaller;
    readonly act: TakeAct;
    readonly approvalId?: string | undefined;
  },
): Promise<TakeGatePass> {
  const required = takingFor(config, args.ref.accountId).required;
  return store.gate(args.ref, args.caller, args.act, {
    required,
    ...(args.approvalId === undefined ? {} : { approvalId: args.approvalId }),
  });
}

/** §6: whether a take is required in an account, as the gates read it. Never throws. */
export function takeRequiredIn(config: Config, accountId: string): boolean {
  return takingFor(config, accountId).required;
}

/** The messages a `taken` asks about, checked: at most fifty, each once. */
export function checkedTakenIds(ids: readonly unknown[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids)) throw new CommsError('USAGE', 'messages is a list of message ids');
  if (ids.length > MAX_TAKEN_MESSAGES) {
    throw new CommsError('USAGE', `taken asks about at most ${MAX_TAKEN_MESSAGES} messages at once, not ${ids.length}`);
  }
  const strings = ids.map((id) => {
    if (typeof id !== 'string' || id === '') throw new CommsError('USAGE', 'a message id is text');
    return id;
  });
  return [...new Set(strings)];
}

/**
 * Who has each of these messages (T7), for a read's `taken`: one file look per message, nothing written, and never a
 * reason to fail the read — a look that fails is `null`, as a message nobody has taken is.
 */
export async function takenViews(
  store: TakeStore,
  refs: readonly TakeMessageRef[],
  caller: TakeCaller,
): Promise<Map<string, TakenView>> {
  try {
    return await store.views(refs, caller);
  } catch {
    return new Map(refs.map((ref) => [ref.id, null]));
  }
}
