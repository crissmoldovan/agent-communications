import {
  type ActDecision,
  actNotAllowed,
  allowedAct,
  allowedHereLine,
  type BehaviourAct,
  type ChannelPreview,
  type CliHandoffs,
  type CommsError,
  type Config,
  canonicalJson,
  escapeForDisplay,
  handoffSentence,
  readBehaviourSettings,
  renderChannelPreview,
  sha256Hex,
} from '@agentcomms/core';
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
 * the DM, and the person it is with (a `U…` rule rules the DM with them, B4). Every place must allow every act.
 */
export interface BehaviourCheck {
  readonly acts: readonly BehaviourAct[];
  readonly places: readonly (readonly string[])[];
  /**
   * How each id is named to the person — `#eng` for `C1` — when a refusal or a preview line names a place: given, or
   * read only then (a reaction reads its room for it only when a rule names one). Display only, never bound.
   */
  readonly names?: Readonly<Record<string, string>> | (() => Promise<Readonly<Record<string, string>>>) | undefined;
}

/** What the gate decides with: the configuration as it is now, the account by its id and name, and its commands. */
export interface BehaviourDeps {
  readonly currentConfig: () => Promise<Config>;
  readonly accountId: string;
  readonly workspaceName: string;
  readonly handoffs: CliHandoffs;
}

/** A post's acts (B2): `reply` in a thread, `post` at the top of a conversation, and `file` as well for any file. */
export function postActs(threadTs: string | undefined, files: number): BehaviourAct[] {
  return [threadTs === undefined ? 'post' : 'reply', ...(files > 0 ? (['file'] as const) : [])];
}

/** An edit's acts (B2): `edit`, and `file` as well when it adds files. Taking a file off is part of the edit. */
export function editActs(addsFiles: number): BehaviourAct[] {
  return ['edit', ...(addsFiles > 0 ? (['file'] as const) : [])];
}

/**
 * Where an act lands, as the rules match it: the channel, or for a DM the DM and the person it is with — from the room
 * as `roomOf` read it. A DM whose person could not be read is the DM alone, which {@link heldPlaces} holds to every
 * person's rule.
 */
export function placesOf(channelId: string, channel: Channel | undefined): string[][] {
  const person = channel?.isIm === true ? channel.withUserId : undefined;
  return [person === undefined ? [channelId] : [channelId, person]];
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
  if (!check.places.some((aliases) => aliases.length > 1)) return {};
  return { behaviour: { places: check.places.map((aliases) => [...aliases]) } };
}

/** A post's digest with what it adds for the rules (`behaviourBinding`): itself, for a post in a channel. */
export function boundDigest(digest: string, check: BehaviourCheck): string {
  const binding = behaviourBinding(check);
  return binding.behaviour === undefined ? digest : sha256Hex(canonicalJson({ digest, ...binding }));
}

const DM = /^D[A-Z0-9]+$/;
const PERSON = /^[UW][A-Z0-9]+$/;

/**
 * The places as the rules are asked about them, failing closed (B3): a DM whose person Slack did not say — its room
 * could not be read — may be with anyone, so it is matched by every person a rule names as well as by itself, and only
 * what all of them allow holds. A rule for another account matches nothing here: `allowedAct` reads only this one's.
 */
function heldPlaces(config: Config, places: readonly (readonly string[])[]): string[][] {
  const people = [
    ...new Set(
      readBehaviourSettings(config).rules.flatMap((rule) =>
        rule.conversation !== undefined && PERSON.test(rule.conversation) ? [rule.conversation] : [],
      ),
    ),
  ];
  return places.map((aliases) => {
    const [only, ...more] = aliases;
    return only !== undefined && more.length === 0 && DM.test(only) ? [only, ...people] : [...aliases];
  });
}

/** B4's decision for `check`, on the configuration as it is now. */
export async function decideAct(deps: BehaviourDeps, check: BehaviourCheck): Promise<ActDecision> {
  const config = await deps.currentConfig();
  return allowedAct(config, {
    accountId: deps.accountId,
    account: deps.workspaceName,
    acts: [...check.acts],
    places: heldPlaces(config, check.places),
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
  const dm = check.places.find((aliases) => aliases.length === 1 && DM.test(aliases[0] ?? ''))?.[0];
  return dm === undefined ? null : (names[dm] ?? dm);
}

/**
 * What a refusal tells the agent to do: look at the rules, with the located command that shows them, or the tool that
 * does from a chat. Never a command that changes them: a loosening is the person's to start (B4).
 */
export function behaviourHint(handoffs: CliHandoffs): string {
  return handoffSentence(
    handoffs.core(['behaviour']),
    (command) =>
      `Nothing was done. ${command} shows the rules and what each lets an agent do here, as comms_behaviour does from a chat. Tell the person which rule stopped this: changing it is theirs to do, not an agent’s.`,
    {
      instead:
        'Nothing was done. comms_behaviour shows the rules and what each lets an agent do here, from a chat. Tell the person which rule stopped this: changing it is theirs to do, not an agent’s.',
    },
  );
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
    behaviourHint(deps.handoffs),
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

/** A post's or an edit's preview, with the line saying what is allowed where it lands (B4). */
export type SlackPreview = ChannelPreview & { readonly allowedHere: string };

/**
 * A post's or an edit's preview as a person reads it: core's rendering, with the `Allowed here:` line at its foot,
 * beside what has to happen before it is made — the policy line, which stays last.
 */
export function renderSlackPreview(preview: ChannelPreview & { readonly allowedHere?: string | undefined }): string {
  if (preview.allowedHere === undefined) return renderChannelPreview(preview);
  const lines = [renderChannelPreview({ ...preview, policy: undefined }), escapeForDisplay(preview.allowedHere)];
  if (preview.policy) lines.push(escapeForDisplay(preview.policy));
  return lines.join('\n');
}
