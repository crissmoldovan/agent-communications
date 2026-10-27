import {
  type ActDecision,
  actNotAllowed,
  allowedAct,
  allowedHereLine,
  type BehaviourAct,
  behaviourRefusalHint,
  type ChannelPreview,
  type CliHandoffs,
  CommsError,
  type Config,
  canonicalJson,
  escapeForDisplay,
  readBehaviourSettings,
  renderChannelPreview,
  sha256Hex,
} from '@agentcomms/core';
import { callSlack, type SlackCall } from '../api/call.ts';
import type { Channel, NameBook } from './people.ts';

/**
 * What an agent may do in Slack (design 2026-10-19-agent-behaviour-rules, B2–B4), as the gate asks it.
 *
 * Every post, reply, file, reaction, edit and deletion is asked twice: at prepare, before any approval is made or any
 * preview returned, and again just before its approval is claimed, on the configuration as it is then
 * (`claimOrHandOver`). What is asked is a {@link BehaviourCheck} — the acts, at their places — decided from what Slack
 * said of the act, and bound into the act's approval digest: so the second asking is of exactly what the person said yes
 * to, and a rule tightened after the yes stops it before Slack is asked to do anything. The decision itself is core's
 * (`allowedAct`), the one every channel makes.
 */

/**
 * One act's question of the rules: its acts, at its places.
 *
 * A place is one destination and its aliases, which match at the same level: a channel is `[C…]`, a DM `[D…, U…]` —
 * the DM, and the person it is with (a `U…` rule rules the DM with them, B4) — and a group DM one place for each of the
 * people in it, `[G…, U…]` (review of spec 2, finding 14). Every place must allow every act.
 */
export interface BehaviourCheck {
  readonly acts: readonly BehaviourAct[];
  readonly places: readonly (readonly string[])[];
  /**
   * Places whose people Slack did not say — a group DM's members, or whether a `G…` room that could not be read is a
   * group DM at all — so they are held to every person's rule as well (`heldPlaces`). Never bound: asked again from
   * Slack, and held again, wherever the act is checked.
   */
  readonly unread?: readonly string[] | undefined;
  /**
   * How each id is named to the person — `#eng` for `C1` — when a refusal or a preview line names a place: given, or
   * read only then (a reaction reads its room for it only when a rule names one). Display only, never bound.
   */
  readonly names?: Readonly<Record<string, string>> | (() => Promise<Readonly<Record<string, string>>>) | undefined;
  /**
   * Why these are the acts asked, when that is not what the agent meant — a reply whose thread Slack does not have,
   * asked as the post Slack would make of it. Said first in a refusal's hint (`behaviourRefusalHint`). Never bound.
   */
  readonly cause?: string | undefined;
}

/** What the gate decides with: the configuration as it is now, the account by its id and name, and its commands. */
export interface BehaviourDeps {
  readonly currentConfig: () => Promise<Config>;
  readonly accountId: string;
  readonly workspaceName: string;
  readonly handoffs: CliHandoffs;
}

/** A post's acts (B2): `reply` in a thread, `post` at the top of a conversation, and `file` as well for any file. */
export function postActs(inThread: boolean, files: number): BehaviourAct[] {
  return [inThread ? 'reply' : 'post', ...(files > 0 ? (['file'] as const) : [])];
}

/**
 * A post's question of the rules (B2, B4), its thread proven wherever the rules tell a post from a reply.
 *
 * `reply` is a message in a thread — but Slack posts one whose `thread_ts` names no message in that conversation as a
 * new message at its top, so a thread is never taken on the draft's word (review of spec 2, finding 9). Where the rules
 * as they are now allow a post and a reply alike, or neither, it does not matter which Slack makes of it: the post is
 * asked as both, `reply` first, so it is allowed only where both are — and the claim, asking again on the rules as they
 * are then, holds it to both as well, so no rule tightened in between lets either through. Only where they allow one and
 * not the other is the thread read from Slack, in that conversation (`threadIsThere`): a message there at that ts makes
 * it a `reply`; none, a `post`, and its refusal says why. So an account whose rules never tell the two apart — every
 * account without rules — asks Slack nothing it did not ask before.
 *
 * Nothing is bound for it: the digest binds the channel and the thread already, and this is asked again from them at
 * the approval screen and at the send — so a thread gone by the send is a post there, refused before the claim.
 */
export async function postCheck(
  deps: BehaviourDeps & { readonly call: SlackCall },
  post: { readonly channel: string; readonly threadTs: string | undefined; readonly files: number },
  where: Pick<BehaviourCheck, 'places' | 'unread' | 'names'>,
): Promise<BehaviourCheck> {
  const at = { places: where.places, unread: where.unread, names: where.names };
  const asPost: BehaviourCheck = { ...at, acts: postActs(false, post.files) };
  if (post.threadTs === undefined) return asPost;
  const asReply: BehaviourCheck = { ...at, acts: postActs(true, post.files) };
  const reply = await decideAct(deps, asReply);
  const top = await decideAct(deps, asPost);
  if (reply.allowed === top.allowed) return { ...at, acts: [...asReply.acts, 'post'] };
  if (await threadIsThere(deps.call, post.channel, post.threadTs)) return asReply;
  return {
    ...asPost,
    cause: `Slack has no message at ${post.threadTs} in this conversation for it to reply under, so it would be posted as a new message, not in a thread.`,
  };
}

/**
 * Whether `ts` is a message in `channel` that a reply can go under, as Slack says now: `conversations.replies` there,
 * for its first message, which answers for a message nobody has replied to as well.
 *
 * No — checked as a post — when Slack has no such thread for this account there (`thread_not_found`, or the room itself
 * not found), or answers without that message: a ts from another conversation, or a reply's own ts, which starts no
 * thread. A read that failed for a moment is neither: refused as TRANSIENT, with nothing sent, so it can be tried again
 * — never read as "not a reply" (as Gmail's proof of a reply, review finding 3). Any other refusal is Slack's own, and
 * goes out as it is: nothing is sent either way.
 */
async function threadIsThere(call: SlackCall, channel: string, ts: string): Promise<boolean> {
  let response: Record<string, unknown>;
  try {
    response = (await callSlack(call, 'conversations.replies', { channel, ts, limit: 1 })) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof CommsError)) throw error;
    if (error.code === 'NOT_FOUND') return false;
    if (!error.retryable) throw error;
    throw new CommsError(
      'TRANSIENT',
      `nothing was sent: Slack could not be asked whether ${ts} is a message in ${channel}, which decides whether this is a reply`,
      {
        hint: 'Try again in a moment: nothing was sent, and no approval was spent.',
        details: { channel, threadTs: ts, reason: 'thread-unread' },
        cause: error,
      },
    );
  }
  const messages = Array.isArray(response.messages) ? (response.messages as unknown[]) : [];
  return messages.some((message) => {
    if (typeof message !== 'object' || message === null) return false;
    const { ts: own, thread_ts: thread } = message as { ts?: unknown; thread_ts?: unknown };
    return own === ts && (thread === undefined || thread === ts);
  });
}

/** An edit's acts (B2): `edit`, and `file` as well when it adds files. Taking a file off is part of the edit. */
export function editActs(addsFiles: number): BehaviourAct[] {
  return ['edit', ...(addsFiles > 0 ? (['file'] as const) : [])];
}

/** Where an act lands, as the rules match it: its places, and those whose people Slack did not say. */
export interface Landing {
  readonly places: string[][];
  readonly unread: string[];
}

/**
 * Where an act lands, as the rules match it — from the room as `roomOf` read it and, for a group DM, the people Slack
 * says are in it (`landingOf`):
 * - a channel, the channel;
 * - a DM, the DM and the person it is with: one place. One whose person could not be read is the DM alone, which
 *   {@link heldPlaces} holds to every person's rule;
 * - a group DM, one place for each person in it but this account, each with the room (review of spec 2, finding 14):
 *   so a person's rule holds every group DM with them, as it holds the DM with them, and a rule for the room itself
 *   still wins over the account's where nobody's rule speaks. One whose people were not read is the room alone, and
 *   held to every person's rule;
 * - a `G…` room that could not be read may be a group DM, and is held so too.
 */
export function placesOf(
  channelId: string,
  channel: Channel | undefined,
  members?: readonly string[] | undefined,
  self?: string | undefined,
): Landing {
  if (channel?.isIm === true) {
    const person = channel.withUserId;
    return { places: [person === undefined ? [channelId] : [channelId, person]], unread: [] };
  }
  if (channel?.isMpim === true) {
    if (members === undefined) return { places: [[channelId]], unread: [channelId] };
    const people = [...new Set(members)].filter((member) => member !== self).sort();
    return { places: people.length === 0 ? [[channelId]] : people.map((person) => [channelId, person]), unread: [] };
  }
  return { places: [[channelId]], unread: channel === undefined && channelId.startsWith('G') ? [channelId] : [] };
}

/**
 * {@link placesOf}, reading a group DM's members from Slack — only where a person's rule could hold them: the
 * configuration as it is now names a person. Elsewhere they are not read, and the room is held instead, which adds
 * nothing while no rule names a person and every person's rule once one does — so a rule added before the claim still
 * holds it, and an account whose rules name nobody asks Slack nothing it did not ask before.
 */
export async function landingOf(
  deps: BehaviourDeps & { readonly call: SlackCall; readonly postingAs: string },
  channelId: string,
  channel: Channel | undefined,
): Promise<Landing> {
  if (channel?.isMpim !== true || !(await rulesNamePeople(deps))) return placesOf(channelId, channel);
  return placesOf(channelId, channel, await membersOf(deps.call, channelId), deps.postingAs);
}

/** Whether the rules as they are now name any person: only then can a group DM's members change what is allowed. */
export async function rulesNamePeople(deps: Pick<BehaviourDeps, 'currentConfig'>): Promise<boolean> {
  return personRules(await deps.currentConfig()).length > 0;
}

/** At most this many pages of `conversations.members` are read for a group DM's people: Slack holds nine at most. */
const MEMBER_PAGES = 10;

/**
 * Everyone in a conversation, read with the person's token and paged — or `undefined` when that could not be settled:
 * a read that failed, or pages that did not end. Never a guess, and never read as nobody.
 */
async function membersOf(call: SlackCall, channel: string): Promise<string[] | undefined> {
  const members: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MEMBER_PAGES; page += 1) {
    let response: Record<string, unknown>;
    try {
      response = (await callSlack(call, 'conversations.members', {
        channel,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      })) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const listed = Array.isArray(response.members) ? response.members : [];
    for (const member of listed) if (typeof member === 'string' && PERSON.test(member)) members.push(member);
    const next = (response.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (typeof next !== 'string' || next === '') return members;
    cursor = next;
  }
  return undefined;
}

/** How a room and, for a DM, its person are named to the person: `#eng`; `the direct message with Sam`, and `Sam`. */
export function placeNamesOf(
  channelId: string,
  channel: Channel | undefined,
  book?: NameBook | undefined,
): Record<string, string> {
  const names: Record<string, string> = {};
  if (channel?.isIm === true) {
    const person = channel.withUserId === undefined ? undefined : book?.person(channel.withUserId);
    const who = person?.displayName?.text || person?.realName?.text || undefined;
    names[channelId] = who === undefined ? `the direct message ${channelId}` : `the direct message with ${who}`;
    if (channel.withUserId !== undefined && who !== undefined) names[channel.withUserId] = who;
  } else if (channel?.name?.text) {
    names[channelId] = `#${channel.name.text}`;
  }
  return names;
}

/**
 * What an act's approval digest adds for the rules (B4), so the claim is of exactly the acts and places the person said
 * yes to.
 *
 * For an act in a channel, nothing: its digest already binds the channel, and everything its acts are decided from —
 * the thread and the files of a post, the files an edit adds, the message, the emoji. For one in a DM, the person the
 * DM is with, read from its room: the one part of where it lands that nothing else binds. So an act in a channel is
 * bound exactly as it was before the rules, and an approval outstanding across the upgrade is not voided by them — the
 * rule the golden digests in `send-files.test.ts` hold every post to.
 */
export function behaviourBinding(check: BehaviourCheck): { behaviour?: { places: string[][] } } {
  // A DM's person, and nothing for a group DM: its members are read only where a rule names a person (`landingOf`), so
  // binding them would make the digest hang on the rules. They are read and held again at the claim instead.
  if (!check.places.some((aliases) => aliases.length > 1 && DM.test(aliases[0] ?? ''))) return {};
  return { behaviour: { places: check.places.map((aliases) => [...aliases]) } };
}

/** A post's digest with what it adds for the rules (`behaviourBinding`): itself, for a post in a channel. */
export function boundDigest(digest: string, check: BehaviourCheck): string {
  const binding = behaviourBinding(check);
  return binding.behaviour === undefined ? digest : sha256Hex(canonicalJson({ digest, ...binding }));
}

const DM = /^D[A-Z0-9]+$/;
const PERSON = /^[UW][A-Z0-9]+$/;

/** Every person a rule names, whichever account's: a rule for another account matches nothing in `allowedAct`. */
function personRules(config: Config): string[] {
  return [
    ...new Set(
      readBehaviourSettings(config).rules.flatMap((rule) =>
        rule.conversation !== undefined && PERSON.test(rule.conversation) ? [rule.conversation] : [],
      ),
    ),
  ];
}

/**
 * The places as the rules are asked about them, failing closed (B3). A DM whose person Slack did not say — its room
 * could not be read — may be with anyone, so it is matched by every person a rule names as well as by itself, and only
 * what all of them allow holds. A room whose people Slack did not say (`unread`) — a group DM's members, or a `G…` room
 * that could not be read at all — may hold anyone, so it is asked as a group DM with every person a rule names in it.
 * A rule for another account matches nothing here: `allowedAct` reads only this one's.
 */
function heldPlaces(config: Config, check: BehaviourCheck): string[][] {
  const people = personRules(config);
  const unread = new Set(check.unread ?? []);
  return check.places.flatMap((aliases) => {
    const [only, ...more] = aliases;
    if (only === undefined || more.length > 0) return [[...aliases]];
    if (DM.test(only)) return [[only, ...people]];
    if (unread.has(only) && people.length > 0) return people.map((person) => [only, person]);
    return [[only]];
  });
}

/** B4's decision for `check`, on the configuration as it is now. */
export async function decideAct(deps: BehaviourDeps, check: BehaviourCheck): Promise<ActDecision> {
  const config = await deps.currentConfig();
  return allowedAct(config, {
    accountId: deps.accountId,
    account: deps.workspaceName,
    acts: [...check.acts],
    places: heldPlaces(config, check),
  });
}

async function namesFor(check: BehaviourCheck): Promise<Readonly<Record<string, string>>> {
  const { names } = check;
  if (names === undefined) return {};
  return typeof names === 'function' ? names() : names;
}

/**
 * How a place an id names is shown: its name, or — for a person matched only because a DM's could not be read — the
 * DM's, since that is where the act lands. `null` shows the id itself.
 */
async function shownPlace(check: BehaviourCheck, id: string | null | undefined): Promise<string | null> {
  if (id === null || id === undefined) return null;
  const names = await namesFor(check);
  const named = names[id];
  if (named !== undefined) return named;
  if (check.places.some((aliases) => aliases.includes(id))) return null;
  const unread = check.unread ?? [];
  const held = check.places.find(
    (aliases) => aliases.length === 1 && (DM.test(aliases[0] ?? '') || unread.includes(aliases[0] ?? '')),
  )?.[0];
  return held === undefined ? null : (names[held] ?? held);
}

/**
 * What a refusal tells the agent to do, in core's words for every channel (`behaviourRefusalHint`): look at the rules,
 * with the located command that shows them, or the tool that does from a chat. Never a command that changes them: a
 * loosening is the person's to start (B4).
 */
export function behaviourHint(handoffs: CliHandoffs): string {
  return behaviourRefusalHint(handoffs);
}

/** B4's refusal of `decision`, naming the place as the person knows it. */
export async function actRefusal(
  deps: BehaviourDeps,
  decision: Extract<ActDecision, { allowed: false }>,
  check: BehaviourCheck,
): Promise<CommsError> {
  return actNotAllowed(
    decision,
    { account: deps.workspaceName, place: await shownPlace(check, decision.place) },
    behaviourRefusalHint(deps.handoffs, check.cause),
  );
}

/** The decision, and the line every preview carries about it (B4): `Allowed here: …`. */
export interface AllowedHere {
  readonly decision: ActDecision;
  readonly line: string;
}

/** What is allowed where `check` lands, and its preview line, on the configuration as it is now. */
export async function allowedHere(deps: BehaviourDeps, check: BehaviourCheck): Promise<AllowedHere> {
  const decision = await decideAct(deps, check);
  const place = decision.rule?.conversation === undefined ? null : await shownPlace(check, decision.rule.conversation);
  return { decision, line: allowedHereLine(decision, { account: deps.workspaceName, place }) };
}

/** Refuses `check` when the rules as they are now do not allow it; otherwise its decision and line. */
export async function requireAllowed(deps: BehaviourDeps, check: BehaviourCheck): Promise<AllowedHere> {
  const here = await allowedHere(deps, check);
  if (!here.decision.allowed) throw await actRefusal(deps, here.decision, check);
  return here;
}

/**
 * A post's or an edit's preview, with the line saying what is allowed where it lands (B4) — and, for a post that
 * answers a message this session has taken, the line saying so (design 2026-10-26-taking-messages §6).
 */
export type SlackPreview = ChannelPreview & { readonly allowedHere: string; readonly taken?: string | undefined };

/**
 * A post's or an edit's preview as a person reads it: core's rendering, with the `Allowed here:` line at its foot,
 * beside what has to happen before it is made — the policy line, which stays last.
 */
export function renderSlackPreview(
  preview: ChannelPreview & { readonly allowedHere?: string | undefined; readonly taken?: string | undefined },
): string {
  if (preview.allowedHere === undefined) return renderChannelPreview(preview);
  const lines = [renderChannelPreview({ ...preview, policy: undefined }), escapeForDisplay(preview.allowedHere)];
  if (preview.taken !== undefined) lines.push(escapeForDisplay(preview.taken));
  if (preview.policy) lines.push(escapeForDisplay(preview.policy));
  return lines.join('\n');
}
