import {
  CommsError,
  checkedTakenIds,
  checkedTakeStep,
  TAKE_ID_PATTERN,
  type TakeMessage,
  type TakeMessageRef,
  type TakenView,
  type TakeStepRequest,
  type TakeStepResult,
  takenViews,
  takeStep,
  takingFor,
} from '@agentcomms/core';
import type { SlackContext } from '../context.ts';
import { appPostRecordFor } from './app-posts.ts';
import { messageAt, requireMessageAt } from './message.ts';
import { openWorkspace, type SessionDeps } from './session.ts';
import { slackTakeGateFor, takeWithOf } from './take-gate.ts';
import { requireWorkspace } from './workspaces.ts';

/**
 * Taking messages in Slack (design 2026-10-26-taking-messages §5, T2, T5, T7): `agent-slack take` and `slack_take`,
 * `agent-slack taken` and `slack_taken`, one operation each way.
 *
 * - **Take** reads the message from Slack first: it must be there, and someone else's — not this account's user's, and
 *   not one its app posted by its own record (T5) — so an id for a message that has not arrived cannot be squatted.
 *   What is recorded is ids only: the message as `<channel>/<ts>`, and its thread as `<channel>/<parent ts>`.
 * - **Hand back** and **done** read nothing from Slack: they need the record a take made, and only the holder may.
 * - **Taken** says who has each message in closed words, one file look each; with no messages, this session's own.
 *
 * Who is acting is worked out by the server or the command itself (`takerIdentity`), never from an argument. A take,
 * a hand-back and a done write no activity line (T10): the record's history is the story.
 *
 * Phase 1 says nothing to the sender: a 👀 on taking (§7) is made under a standing approval, by `ack`, in a later
 * release. With the account's `acknowledge` at `eyes`, a take says it made none.
 */

export interface SlackTakeRequest extends TakeStepRequest {}

/** What a take step did, in Slack's workspace. */
export interface SlackTakeResult extends TakeStepResult {
  readonly workspace: string;
  /** With `acknowledge: eyes`: the 👀 this release does not make yet (§7). */
  readonly acknowledged?: { readonly made: false; readonly why: 'not-in-this-release' } | undefined;
}

export interface SlackTakenResult {
  readonly workspace: string;
  /** Each message asked about — or, with none asked, each this session holds or is offered — and who has it. */
  readonly messages: { readonly id: string; readonly taken: TakenView }[];
}

/** A Slack message as a take names it: `<channelId>/<ts>`. */
const SLACK_MESSAGE = /^([CDG][A-Z0-9]{1,40})\/(\d{1,12}\.\d{1,8})$/;

/**
 * Takes, hands back or finishes one message: `step` is `take` (or a renewal of this session's own), `hand-back` with a
 * closed reason and a note for the person, or `done`.
 */
export async function takeMessage(
  context: SlackContext,
  alias: string,
  channel: string,
  ts: string,
  request: SlackTakeRequest,
  slack: SessionDeps = {},
): Promise<SlackTakeResult> {
  const checked = checkedTakeStep(request);
  requireMessageAt({ channel, ts }, alias, context.handoffs);
  const config = await context.config();
  const { alias: name, account } = requireWorkspace(config, alias, context.handoffs);
  const id = `${channel}/${ts}`;
  if (!TAKE_ID_PATTERN.test(id)) throw new CommsError('USAGE', `"${id.slice(0, 60)}" is not a message`);
  const ref: TakeMessageRef = { channel: 'slack', accountId: account.id, id };
  const gate = slackTakeGateFor(context);
  const result = await takeStep(context.core.takes, {
    caller: await gate.caller(),
    request: checked,
    ref,
    act: { account: name, shown: id, act: 'slack.take', takeWith: takeWithOf(context)(channel, ts) },
    handoffs: context.handoffs,
    verify: async (): Promise<TakeMessage> => {
      // T5: the message, as Slack has it now — there, and someone else's.
      const { call } = await openWorkspace(context, name, slack);
      const message = await messageAt(call, { channel, ts });
      const ownApp = await appPostRecordFor(context.core.paths.stateDir, account.id).holds({ channel, ts });
      if (message.userId === account.userId || ownApp) {
        throw new CommsError('USAGE', `this account posted ${id}: a session takes a message someone else sent`, {
          hint: 'Taking says which session answers a message that arrived. Your own messages need no take.',
          details: { reason: 'own-message' },
        });
      }
      const parent = message.threadTs ?? (message.replyCount > 0 ? ts : undefined);
      return { ...ref, thread: parent === undefined ? null : `${channel}/${parent}` };
    },
  });
  // §7, phase 1: nothing is said to the sender. Where `acknowledge` is `eyes`, a fresh take is where `ack` — under a
  // standing approval the person made, through `mintStandingUse` and the claim every act makes — would say it with 👀.
  const eyes = checked.step === 'take' && result.changed && takingFor(config, account.id).acknowledge === 'eyes';
  return {
    workspace: name,
    ...result,
    ...(eyes ? { acknowledged: { made: false as const, why: 'not-in-this-release' as const } } : {}),
  };
}

/**
 * Who has these messages (T7), each `<channel>/<ts>`, at most fifty; with none, the messages this session holds or is
 * offered in the workspace. Reads only this machine's records.
 */
export async function takenMessages(
  context: SlackContext,
  alias: string,
  messages?: readonly string[] | undefined,
): Promise<SlackTakenResult> {
  const ids = checkedTakenIds(messages);
  for (const id of ids ?? []) {
    if (!SLACK_MESSAGE.test(id)) {
      throw new CommsError('USAGE', `"${id.slice(0, 60)}" is not a Slack message`, {
        hint: 'Name each as <channelId>/<ts>, as a read gives them: C0123/1729936800.000100.',
      });
    }
  }
  const config = await context.config();
  const { alias: name, account } = requireWorkspace(config, alias, context.handoffs);
  const caller = await slackTakeGateFor(context).caller();
  if (ids === undefined) {
    // The person at their own terminal holds nothing: a take is a session's.
    if (caller === null) return { workspace: name, messages: [] };
    const mine = await context.core.takes.mine('slack', account.id, caller);
    return { workspace: name, messages: mine.map((held) => ({ id: held.id, taken: held.view })) };
  }
  const views = await takenViews(
    context.core.takes,
    ids.map((id) => ({ channel: 'slack' as const, accountId: account.id, id })),
    caller,
  );
  return { workspace: name, messages: ids.map((id) => ({ id, taken: views.get(id) ?? null })) };
}
