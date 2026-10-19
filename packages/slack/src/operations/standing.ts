import {
  CommsError,
  checkedContents,
  checkedLimits,
  type ExactPlace,
  prepareStanding,
  STANDING_PLACE_PATTERN,
  type StandingLimits,
  type StandingPlaces,
  truncateDisplay,
} from '@agentcomms/core';
import type { SlackContext } from '../context.ts';
import { readPlace } from './places.ts';
import { openWorkspace, type SessionDeps } from './session.ts';
import { requireWorkspace } from './workspaces.ts';

/**
 * Making a standing approval in Slack (design 2026-10-19-standing-approvals, S5, S8, and §8.1): `agent-slack standing
 * add` and `slack_standing_add`, one operation for both.
 *
 * Core has no Slack client, and the preview must show each place's name, how many are in it and who shares it — so
 * Slack reads each place (`readPlace`) and core prepares the record (`prepareStanding`), which only a person approves,
 * at a terminal, with its code, whatever the change policy. Nothing here approves, and nothing here sends.
 */

/** What a standing approval is asked for: the contents the person wrote, its places, and its limits. */
export interface StandingAddRequest {
  readonly reactions?: readonly string[] | undefined;
  readonly replies?: readonly string[] | undefined;
  /** `threads-i-am-in`, or channel and DM ids: `C…`, `G…`, `D…`. */
  readonly places: 'threads-i-am-in' | readonly string[];
  readonly perThread?: number | undefined;
  readonly perHour?: number | undefined;
  readonly perDay?: number | undefined;
  readonly expiresDays?: number | undefined;
  /** The standing approval this one replaces: a widening of it waits for the code; a narrowing applies at once. */
  readonly replaces?: string | undefined;
}

/** Who proposes it: an agent, unless the surface knows a person is at its terminal (no agent marker, and a prompt). */
export interface StandingAddOptions {
  readonly proposedBy?: 'agent' | 'person' | undefined;
}

/** The places asked for, before Slack is asked anything about them. USAGE for anything that is not one. */
function placesAsked(places: StandingAddRequest['places']): 'threads-i-am-in' | string[] {
  if (places === 'threads-i-am-in') return places;
  if (!Array.isArray(places) || places.length === 0) {
    throw new CommsError('USAGE', 'name the places: threads-i-am-in, or the ids of channels and DMs', {
      hint: 'Pass threads-i-am-in, or one or more ids such as C0123ABCD, comma-separated on the command line.',
    });
  }
  const ids = places.map((place) => (typeof place === 'string' ? place.trim() : ''));
  for (const id of ids) {
    if (!STANDING_PLACE_PATTERN.test(id)) {
      throw new CommsError('USAGE', `"${truncateDisplay(id, 60)}" is not a channel or DM id`, {
        hint: 'A standing approval names conversations by id — a channel’s C… or G…, a DM’s D… — or threads-i-am-in. A person is reached through the DM with them.',
        details: { place: id, reason: 'not-a-place' },
      });
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new CommsError('USAGE', 'a place is named twice', { hint: 'Name each place once.' });
  }
  return ids;
}

/** The limits asked for, as core's table reads them. */
function limitsAsked(request: StandingAddRequest): Partial<StandingLimits> {
  return {
    ...(request.perThread === undefined ? {} : { perThread: request.perThread }),
    ...(request.perHour === undefined ? {} : { perHour: request.perHour }),
    ...(request.perDay === undefined ? {} : { perDay: request.perDay }),
    ...(request.expiresDays === undefined ? {} : { expiresDays: request.expiresDays }),
  };
}

/**
 * Prepares a standing approval for the person to approve at their terminal (S8), or — when it replaces one and permits
 * nothing more — narrows that one at once (`prepareStanding`).
 *
 * The contents, the limits and the places' ids are checked first, before Slack is asked anything. Then each place named
 * exactly is read (S5): its name, its member count, and who shares it, all shown in the preview and bound into the
 * record. A place whose count cannot be read is refused — `count-unreadable` — and nothing is prepared: a person cannot
 * be asked to approve a room nobody counted. A big room, or one shared with another organisation, may be named: the
 * preview says what it is.
 */
export async function prepareStandingAdd(
  context: SlackContext,
  alias: string,
  request: StandingAddRequest,
  slack: SessionDeps = {},
  options: StandingAddOptions = {},
): ReturnType<typeof prepareStanding> {
  const contents = {
    ...(request.reactions === undefined ? {} : { reactions: [...request.reactions] }),
    ...(request.replies === undefined ? {} : { replies: [...request.replies] }),
  };
  checkedContents(contents);
  const limits = limitsAsked(request);
  checkedLimits(limits);
  const asked = placesAsked(request.places);

  const { alias: name, account } = requireWorkspace(await context.config(), alias, context.handoffs);
  let places: StandingPlaces;
  if (asked === 'threads-i-am-in') {
    places = { kind: 'threads-i-am-in' };
  } else {
    const session = await openWorkspace(context, name, slack);
    const read: ExactPlace[] = [];
    for (const id of asked) {
      const facts = await readPlace(session.call, id, session.teamId);
      if (facts.members === null) {
        throw new CommsError(
          'STANDING_REFUSED',
          `nothing was prepared: how many people are in ${id} could not be read`,
          {
            hint: 'A standing approval names only places whose members can be counted. Name another place, or try again in a moment.',
            details: { reason: 'count-unreadable', place: id },
          },
        );
      }
      read.push({ id, name: facts.name, members: facts.members, shared: facts.shared });
    }
    places = { kind: 'exact', places: read };
  }

  return prepareStanding(
    context.core,
    {
      account: name,
      accountId: account.id,
      inboxSub: account.userId,
      contents,
      places,
      limits,
      ...(request.replaces === undefined ? {} : { replaces: request.replaces }),
    },
    { surface: context.surface, proposedBy: options.proposedBy ?? 'agent', platform: context.platform },
  );
}
