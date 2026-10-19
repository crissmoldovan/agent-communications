import { type SharedState, STANDING_BIG_ROOM } from '@agentcomms/core';
import { callSlack, type SlackCall } from '../api/call.ts';
import { channelOf, personOf } from './people.ts';

/**
 * One place a standing approval may name, as Slack has it now (design 2026-10-19-standing-approvals, S5): what it is
 * called, how many people are in it, and who shares it — read when the approval is made, so the person approving sees
 * each, and again at every use, so a place that has grown, or been shared since, is refused until the person approves it
 * again.
 *
 * `isShared` is not used here (§3): it mixes another organisation's sharing with an Enterprise Grid's own. What counts
 * is the channel's `is_ext_shared` and `is_pending_ext_shared`, and each member: a `team_id` that is not this
 * workspace's, `is_stranger`, or a guest. An Enterprise Grid's `is_org_shared` is one organisation, and never counts.
 *
 * Nothing unread is guessed. A count that cannot be read is `null`, and so is the count of a place whose members cannot
 * all be looked at one by one: every caller refuses a place it cannot count.
 */

export interface PlaceFacts {
  readonly id: string;
  /** Its name, as Slack has it — someone in the workspace chose it, so it is shown neutralised. A DM's is its person's. */
  readonly name: string | null;
  readonly isIm: boolean;
  readonly isMpim: boolean;
  /** For a DM: the person it is with. */
  readonly dmWith?: string | undefined;
  /** How many people are in it, or `null` when that could not be read. */
  readonly members: number | null;
  /** Who shares it. `externalMembers` is `null` for a place of 50 or more, whose members are not read one by one. */
  readonly shared: SharedState;
}

/** At most this many pages of `conversations.members` are read: a place that needs more is not counted at all. */
const MEMBER_PAGES = 10;
const PAGE_SIZE = 200;

type Raw = Record<string, unknown>;

/** Everyone in the place, paged, or `null` when a page could not be read or there were more pages than are read. */
async function memberIds(call: SlackCall, channelId: string): Promise<string[] | null> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MEMBER_PAGES; page += 1) {
    let response: Raw;
    try {
      response = (await callSlack(call, 'conversations.members', {
        channel: channelId,
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      })) as Raw;
    } catch {
      return null;
    }
    if (!Array.isArray(response.members)) return null;
    for (const member of response.members) {
      if (typeof member !== 'string' || member === '') return null;
      ids.add(member);
    }
    const next = (response.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (typeof next !== 'string' || next === '') return [...ids];
    cursor = next;
  }
  return null;
}

/**
 * Whether anyone in `ids` is from outside: a `team_id` that is not `ourTeamId`, none at all, Slack's `is_stranger`, or a
 * guest — `is_restricted` or `is_ultra_restricted` (the lead's call, after review), who is let into a channel without
 * being a member of the organisation. `null` when anyone could not be looked up — whoever that is cannot be said to be
 * from here.
 */
async function anyoneExternal(call: SlackCall, ids: readonly string[], ourTeamId: string): Promise<boolean | null> {
  for (const id of ids) {
    let raw: Raw;
    try {
      raw = ((await callSlack(call, 'users.info', { user: id })).user as Raw | undefined) ?? {};
    } catch {
      return null;
    }
    const person = personOf(raw);
    if (person.id !== id) return null;
    if (person.isStranger || person.teamId !== ourTeamId || isGuest(raw)) return true;
  }
  return false;
}

/** A guest of the workspace, by Slack's own flags: a multi-channel guest (`is_restricted`) or a single-channel one. */
export function isGuest(raw: Raw): boolean {
  return raw.is_restricted === true || raw.is_ultra_restricted === true;
}

/** A DM's person, as the preview names the DM: their display or real name, or `null` when it cannot be read. */
async function personName(call: SlackCall, userId: string): Promise<string | null> {
  try {
    const person = personOf(((await callSlack(call, 'users.info', { user: userId })).user as Raw | undefined) ?? {});
    return person.displayName?.text || person.realName?.text || null;
  } catch {
    return null;
  }
}

/**
 * Reads one place (S5): `conversations.info` for what it is and how it is shared; its count from `num_members`, else
 * from paging `conversations.members`; and, for a place under 50, each member with `users.info`.
 *
 * Throws only what `conversations.info` throws — a place that cannot be read at all is not a place anyone approves. A
 * count, or a member, that cannot be read is `members: null`.
 */
export async function readPlace(call: SlackCall, channelId: string, ourTeamId: string): Promise<PlaceFacts> {
  const response = await callSlack(call, 'conversations.info', { channel: channelId, include_num_members: true });
  const channel = channelOf((response.channel as Raw | undefined) ?? {});
  const dmWith = channel.isIm ? channel.withUserId : undefined;
  const name =
    dmWith !== undefined ? await personName(call, dmWith) : channel.isIm ? null : (channel.name?.text ?? null);
  const facts = (members: number | null, externalMembers: boolean | null): PlaceFacts => ({
    id: channelId,
    name,
    isIm: channel.isIm,
    isMpim: channel.isMpim,
    ...(dmWith === undefined ? {} : { dmWith }),
    members,
    shared: {
      extShared: channel.isExtShared,
      pendingExtShared: channel.isPendingExtShared,
      externalMembers,
    },
  });
  const counted =
    typeof channel.memberCount === 'number' && Number.isSafeInteger(channel.memberCount) && channel.memberCount >= 0
      ? channel.memberCount
      : null;
  // A big room by Slack's own count: its members are not read one by one.
  if (counted !== null && counted >= STANDING_BIG_ROOM) return facts(counted, null);
  const ids = await memberIds(call, channelId);
  if (ids === null) return facts(null, null);
  const members = Math.max(counted ?? 0, ids.length);
  if (members >= STANDING_BIG_ROOM) return facts(members, null);
  const external = await anyoneExternal(call, ids, ourTeamId);
  return external === null ? facts(null, null) : facts(members, external);
}
