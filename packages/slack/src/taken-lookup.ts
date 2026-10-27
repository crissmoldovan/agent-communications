import { TAKE_ID_PATTERN, type TakenView, takenViews } from '@agentcomms/core';
import type { SlackContext } from './context.ts';
import { slackTakeGateFor } from './operations/take-gate.ts';
import { requireWorkspace } from './operations/workspaces.ts';

/*
 * Taking messages, a read's `taken` (design 2026-10-26-taking-messages §6, "Read results"): the lookup both surfaces
 * hand `readChannel`, `readThread` and `searchMessages`. A helper, not an operation: it lives outside `operations/`, so
 * the parity drive traces a read to the read alone.
 */

/** Who has each message a read returns, keyed `<channel>/<ts>`: one file look per message, never failing the read. */
export type TakenLookup = (
  messages: readonly { readonly channel: string; readonly ts: string }[],
) => Promise<Map<string, TakenView>>;

/**
 * The lookup a read's `taken` is answered with, for this workspace (§6, "Read results"): by the session the server or
 * the command is, in closed words. A workspace that cannot be named looks up nothing.
 */
export function takenLookupFor(context: SlackContext, alias: string): TakenLookup {
  return async (messages) => {
    try {
      const { account } = requireWorkspace(await context.config(), alias, context.handoffs);
      const caller = await slackTakeGateFor(context).caller();
      const refs = messages
        .map((message) => `${message.channel}/${message.ts}`)
        .filter((id) => TAKE_ID_PATTERN.test(id))
        .map((id) => ({ channel: 'slack' as const, accountId: account.id, id }));
      return await takenViews(context.core.takes, refs, caller);
    } catch {
      return new Map();
    }
  };
}
