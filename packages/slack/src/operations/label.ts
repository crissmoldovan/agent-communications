import {
  type ActKind,
  type AgentLabelSettings,
  agentLabelOf,
  CommsError,
  DEFAULT_AGENT_LABEL_WORD,
  fallbackLabelLine,
  fallbackTextPrefix,
  labelPhrase,
  type MessageIdentity,
  neutralise,
  resolveIdentity,
  slackStyleOf,
  truncateDisplay,
  UNLABELLED_PREVIEW_LINE,
} from '@agentcomms/core';
import { callSlack, type SlackCall } from '../api/call.ts';
import { type ComposedPayload, escapeForSlack, payloadOf } from '../compose/blocks.ts';
import type { Channel } from './people.ts';

/**
 * Who a Slack act appears to come from (design 2026-10-15 §3 and §4): the identity, the route that carries it, and the
 * phrase and icon an app post goes out with — decided at prepare, before the preview, from the account's own profile and
 * settings, and bound into the approval with the rest of the act. Nobody passes a name, an icon or blocks: the only
 * thing a caller may say is `as`, the person's own word for this one message.
 */

/** A Slack `username` holds at most this many characters; a phrase that does not fit is refused, never cut (L2). */
export const SLACK_USERNAME_LIMIT = 80;

/**
 * How an act reaches Slack (S2): the app's bot token posting as the app, the person's token with the label in the
 * message (S3), or the person's token as before this release, unlabelled. A workspace whose style is `labelled` (the
 * owner's decision, 2026-10-17) takes the second for every `agent` act, even where the app could post.
 */
export type SlackRoute = 'app' | 'fallback' | 'person';

/** The icon an app post carries (S4): the person's agent emoji when one is set for the account, else their photo. */
export type SlackIcon = { readonly emoji: string } | { readonly url: string };

/** One act's identity and route, as prepare decided it and the approval binds it. */
export interface SlackLabel {
  readonly identity: MessageIdentity;
  /** What decided it (L3): the message's `as`, a rule, or the default. Shown, not bound. */
  readonly source: 'message' | 'rule' | 'default';
  readonly route: SlackRoute;
  /** `<name> (<word>)`, for every `agent` act that carries words. */
  readonly phrase?: string | undefined;
  /** The name the phrase was made from, for the fallback's first line. */
  readonly name?: string | undefined;
  /** An app post's icon. */
  readonly icon?: SlackIcon | undefined;
  /** The bot user an app act is made as. */
  readonly botUserId?: string | undefined;
  /** Why an `agent` act goes out as the person: the fallback's reason, or a reaction that cannot be labelled. */
  readonly reason?: string | undefined;
}

/** The account's app: its bot user, and a call carrying its bot token, opened only when an act routes to it. */
export interface AppIdentity {
  readonly userId: string;
  readonly call: () => Promise<SlackCall>;
  /**
   * Forgets the bot token after Slack refused the token itself (CUE-493, `app-token.ts`): deleted, the bot user taken
   * off the account, and why recorded, so the next prepare takes the fallback.
   */
  readonly forget?: ((slackError: string) => Promise<void>) | undefined;
  /** The organisation whose profile connected the account, when one did: whose admin holds the agent app's token. */
  readonly organisation?: string | undefined;
}

/** What a gate needs to decide a label: whose rules, which settings, and the app when this account has one. */
export interface LabelDeps {
  /** The account's name, which rules name it by (L4). */
  readonly account: string;
  /** The account's id, which its agent emoji is recorded under (`agentLabel.slackIcons`). */
  readonly accountId: string;
  readonly settings: AgentLabelSettings;
  readonly app?: AppIdentity | undefined;
  /** Why there is no app, when there is none — said as the fallback's reason (S1, Review focus 1). */
  readonly noApp?: string | undefined;
}

/** The label settings of a loaded configuration — the contract's reader, over a config of any version. */
export function labelSettingsOf(config: object): AgentLabelSettings {
  return agentLabelOf(config as { readonly agentLabel?: unknown });
}

/** Why an `agent` post takes the labelled fallback, in the preview's words (S2, S7). Fixed strings: they are bound. */
export const FALLBACK_REASONS = {
  im: 'the app cannot post in a direct message between two people',
  self: 'the app cannot post in your own direct messages',
  mpim: 'the app cannot post in a group direct message',
  notMember: 'the app is not a member of this channel',
  unsettled: 'whether the app is a member of this channel could not be settled',
  unread: 'whether the app can post here could not be checked',
  file: 'a post with files goes out as you in this release',
  edit: 'an edit of a message you posted is made as you',
  tokenUnreadable: "the app's token could not be read on this machine",
  labelled: 'you chose labelled posts for this workspace',
} as const;

/** The reason a workspace with no app takes the fallback: one signed in before this release, or connected to read. */
export function noAppReason(mode: string | undefined): string {
  return mode === 'send'
    ? "this workspace's app has no bot token on this machine yet"
    : 'this workspace is connected to read';
}

/**
 * The reason a workspace whose app's bot token Slack refused takes the fallback (CUE-493): the token was forgotten when
 * an act made with it came back `token_revoked`, `invalid_auth` or `account_inactive`, and none has been pasted since.
 * A fixed string, as every reason is: it is bound.
 */
export function revokedAppReason(): string {
  return "this workspace's app token was revoked, and no new one is on this machine yet";
}

/** A request for one act's identity, as the message carries it (L3 step 1). */
export interface LabelRequest {
  readonly kind: ActKind;
  readonly channelId: string;
  /** The room, when the act has read it already. */
  readonly channel?: Channel | undefined;
  /**
   * Reads the room, for an act that has not: a reaction. Read only when the answer depends on it — a rule that names a
   * person (a DM with them), or an `agent` act whose route it decides — so an act as the person asks Slack nothing more.
   */
  readonly room?: (() => Promise<Channel | undefined>) | undefined;
  readonly requested?: MessageIdentity | undefined;
}

/** The person's name and photo, read with their own token (L1, S4). */
interface Profile {
  readonly displayName: string | undefined;
  readonly realName: string | undefined;
  readonly image192: string | undefined;
}

/** "Set the name the label uses with core's `label name`…" — the hint every refused name gives (L1). */
const LABEL_NAME_HINT =
  'Set the name the label uses with the core’s `label name` command, or comms_label from a chat, then prepare it again.';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The person's profile, or a refusal: a label is never made from a name nobody read. */
async function profileOf(call: SlackCall, userId: string): Promise<Profile> {
  let response: Record<string, unknown>;
  try {
    response = (await callSlack(call, 'users.info', { user: userId })) as Record<string, unknown>;
  } catch (error) {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'your Slack name could not be read, so the label cannot be made', {
      hint: 'Nothing was prepared. Try again in a moment.',
      details: { reason: 'profile-unread', cause: (error as Error).message },
    });
  }
  const user = (response.user as Record<string, unknown> | undefined) ?? {};
  const profile = (user.profile as Record<string, unknown> | undefined) ?? {};
  const image = text(profile.image_192);
  return {
    displayName: text(profile.display_name),
    realName: text(profile.real_name) ?? text(user.real_name),
    image192: image !== undefined && /^https:\/\//.test(image) ? image : undefined,
  };
}

/**
 * The phrase (L1, L2): the Slack display name, else the real name, else the name setting — the first that makes a
 * label that fits. Nothing is guessed, and nothing is cut short: with none, the prepare is refused, naming `label name`.
 */
function phraseOf(profile: Profile, settings: AgentLabelSettings): { phrase: string; name: string } {
  const word = settings.word ?? DEFAULT_AGENT_LABEL_WORD;
  const candidates = [profile.displayName, profile.realName, settings.name].filter(
    (name): name is string => name !== undefined,
  );
  let first: CommsError | undefined;
  for (const candidate of candidates) {
    try {
      const phrase = labelPhrase(candidate, word, SLACK_USERNAME_LIMIT);
      return { phrase, name: phrase.slice(0, -` (${word})`.length) };
    } catch (error) {
      if (!(error instanceof CommsError)) throw error;
      first ??= error;
    }
  }
  throw new CommsError(
    'USAGE',
    first?.message ?? 'nothing names you for the label: your Slack profile has no name, and no label name is set',
    { hint: LABEL_NAME_HINT, details: { reason: 'label-name', limit: SLACK_USERNAME_LIMIT } },
  );
}

/** At most this many pages of `conversations.members` are read looking for the bot (S2). */
const MEMBER_PAGES = 10;

/**
 * Whether the bot user is in the room, read with the person's token and paged until it is found (S2). Undefined when
 * that could not be settled — a failed read, or ten pages without it and more to come — which is never read as yes.
 */
async function botIsMember(call: SlackCall, channel: string, botUserId: string): Promise<boolean | undefined> {
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
    const members = Array.isArray(response.members) ? response.members : [];
    if (members.includes(botUserId)) return true;
    const next = (response.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (typeof next !== 'string' || next === '') return false;
    cursor = next;
  }
  return undefined;
}

/**
 * Who posts an `agent` act (S2): the app in a public channel not shared with another organisation, and in a private or
 * shared one whose members include its bot user; the person, labelled, everywhere else — a DM, a group DM, the person's
 * own DM, a room the app is not in or whose membership could not be settled, and every file.
 *
 * In a workspace whose style is `labelled` (the owner's decision, 2026-10-17), the person, labelled, wherever the room:
 * decided before it is read, so nothing asks Slack whether the app could have posted. A file and an edit keep their own
 * reasons, since what they are fixes their route whatever the style: the app posts no files in this release, and an
 * edit is made by whoever posted the message (S5).
 */
async function routeOf(
  call: SlackCall,
  postingAs: string,
  label: LabelDeps,
  request: LabelRequest,
  room: () => Promise<Channel | undefined>,
): Promise<{ route: 'app' | 'fallback'; reason?: string }> {
  const fallback = (reason: string) => ({ route: 'fallback' as const, reason });
  if (request.kind === 'file') return fallback(FALLBACK_REASONS.file);
  if (request.kind !== 'edit' && slackStyleOf(label.settings, label.accountId) === 'labelled') {
    return fallback(FALLBACK_REASONS.labelled);
  }
  if (label.app === undefined) return fallback(label.noApp ?? noAppReason('send'));
  const channel = await room();
  if (channel === undefined) return fallback(FALLBACK_REASONS.unread);
  if (channel.isIm) return fallback(channel.withUserId === postingAs ? FALLBACK_REASONS.self : FALLBACK_REASONS.im);
  if (channel.isMpim) return fallback(FALLBACK_REASONS.mpim);
  if (!channel.isPrivate && !channel.isShared) return { route: 'app' };
  const member = await botIsMember(call, request.channelId, label.app.userId);
  if (member === true) return { route: 'app' };
  return fallback(member === false ? FALLBACK_REASONS.notMember : FALLBACK_REASONS.unsettled);
}

/**
 * Decides one act's label, before anything is shown (L3, S2, S4). `as` wins, then the most specific rule, then
 * `agent`. An `agent` act with words gets its phrase from the person's own profile; an app post its icon — the agent
 * emoji set for this account, else the profile photo. A reaction carries no words, so it needs no name (S6).
 */
export async function decideLabel(
  deps: { readonly call: SlackCall; readonly postingAs: string; readonly label: LabelDeps },
  request: LabelRequest,
): Promise<SlackLabel> {
  const { label } = deps;
  let channel = request.channel;
  let read = request.room === undefined || channel !== undefined;
  const room = async (): Promise<Channel | undefined> => {
    if (!read) {
      read = true;
      channel = await request.room?.();
    }
    return channel;
  };
  // A rule naming a person matches a DM with them: only then does the identity depend on the room.
  const personRules = (label.settings.rules ?? []).some(
    (rule) => rule.account === label.account && /^[UW]/.test(rule.conversation ?? ''),
  );
  if (personRules) await room();
  const decision = resolveIdentity(label.settings, {
    account: label.account,
    accountId: label.accountId,
    kind: request.kind,
    requested: request.requested,
    slack: { channel: request.channelId, dmWith: channel?.withUserId },
  });
  if (decision.identity === 'me') return { identity: 'me', source: decision.source, route: 'person' };
  const { route, reason } = await routeOf(deps.call, deps.postingAs, label, request, room);
  if (request.kind === 'reaction') {
    return route === 'app'
      ? await withApp({ identity: 'agent', source: decision.source, route, botUserId: label.app?.userId }, label)
      : {
          identity: 'agent',
          source: decision.source,
          route: 'person',
          reason: `a reaction carries no words to label, and ${reason}`,
        };
  }
  const profile = await profileOf(deps.call, deps.postingAs);
  const { phrase, name } = phraseOf(profile, label.settings);
  if (route === 'fallback') return { identity: 'agent', source: decision.source, route, phrase, name, reason };
  const emoji = label.settings.slackIcons?.[label.accountId];
  const icon: SlackIcon | undefined =
    emoji !== undefined ? { emoji } : profile.image192 !== undefined ? { url: profile.image192 } : undefined;
  return withApp(
    {
      identity: 'agent',
      source: decision.source,
      route: 'app',
      phrase,
      name,
      ...(icon === undefined ? {} : { icon }),
      botUserId: label.app?.userId,
    },
    label,
    { phrase, name },
  );
}

/**
 * An app act, once its bot token is known to open: the app route only for a token this machine can read. One it
 * cannot is the labelled fallback for words, and the person's unlabelled reaction for a reaction — said, never hidden.
 */
async function withApp(
  decided: SlackLabel,
  label: LabelDeps,
  words?: { phrase: string; name: string },
): Promise<SlackLabel> {
  try {
    await label.app?.call();
    return decided;
  } catch {
    if (words === undefined) {
      return {
        identity: 'agent',
        source: decided.source,
        route: 'person',
        reason: `a reaction carries no words to label, and ${FALLBACK_REASONS.tokenUnreadable}`,
      };
    }
    return {
      identity: 'agent',
      source: decided.source,
      route: 'fallback',
      ...words,
      reason: FALLBACK_REASONS.tokenUnreadable,
    };
  }
}

/** Whether a label leaves an act exactly as it was before the label: as the person, unlabelled. */
export function unlabelled(label: SlackLabel | undefined): boolean {
  return label === undefined || (label.identity === 'me' && label.route === 'person');
}

/** What of a reaction's label its approval binds (S6): who reacts. A reaction carries no phrase and no icon. */
export function reactionBinding(label: SlackLabel): Record<string, unknown> {
  return { identity: label.identity, route: label.route, botUserId: label.botUserId ?? null };
}

/** The flags a reaction's approval carries, so the approval screen can say who reacts without asking Slack. */
export const REACTS_AS_APP = 'reacts-as-app';
export const REACTS_UNLABELLED = 'reacts-unlabelled';

export function reactionFlags(label: SlackLabel | undefined): string[] {
  if (label === undefined || label.identity === 'me') return [];
  return label.route === 'app' ? [REACTS_AS_APP] : [REACTS_UNLABELLED];
}

/**
 * A reaction's label, read back from its approval for the screen that cannot ask Slack (S6). Believed only once it
 * reproduces the approval's digest, as the rest of the reaction is.
 */
export function reactionLabelOf(flags: readonly string[], botUserId: string | undefined): SlackLabel | undefined {
  const identity: MessageIdentity = flags.includes(REACTS_AS_APP) || flags.includes(REACTS_UNLABELLED) ? 'agent' : 'me';
  if (identity === 'me') return undefined;
  return flags.includes(REACTS_AS_APP)
    ? { identity, source: 'default', route: 'app', botUserId }
    : { identity, source: 'default', route: 'person' };
}

/** A reaction's line, as its preview and its approval screen say who reacts (S6). */
export function reactionLine(label: SlackLabel | undefined): string {
  if (label === undefined || label.identity === 'me') return UNLABELLED_PREVIEW_LINE;
  if (label.route === 'app') return 'as the app, which shows it is your agent';
  return 'as you, with no label: a reaction carries no words, so nothing on it says your agent added it';
}

/** What of a label an approval binds (the plan's digest material): everything that changes what a recipient sees. */
export function labelBinding(label: SlackLabel): Record<string, unknown> {
  return {
    identity: label.identity,
    route: label.route,
    phrase: label.phrase ?? null,
    icon: label.icon ?? null,
    botUserId: label.botUserId ?? null,
    reason: label.reason ?? null,
  };
}

/** The preview's first line (S7), naming exactly who will appear to post. */
export function identityLine(label: SlackLabel, appName?: string | undefined): string {
  if (label.identity === 'me') return UNLABELLED_PREVIEW_LINE;
  if (label.route === 'app') {
    const app = appName === undefined ? 'the app' : `the app ${appName}`;
    return `${label.phrase ?? ''} · posted by ${app}`;
  }
  if (label.route === 'fallback') {
    return `${label.name ?? ''} · labelled "${fallbackTextPrefix(label.phrase ?? '').trimEnd()}" at the start of the message · ${label.reason ?? ''}`;
  }
  // An `agent` reaction the person makes: it carries no label at all, and says so.
  return `you, with no label · ${label.reason ?? ''}`;
}

/** The app's name in Slack, for the preview only: read with the person's token, neutralised, never bound. */
export async function appNameOf(call: SlackCall, botUserId: string): Promise<string | undefined> {
  try {
    const response = (await callSlack(call, 'users.info', { user: botUserId })) as Record<string, unknown>;
    const user = (response.user as Record<string, unknown> | undefined) ?? {};
    const profile = (user.profile as Record<string, unknown> | undefined) ?? {};
    const name = text(profile.real_name) ?? text(user.real_name) ?? text(profile.display_name);
    return name === undefined ? undefined : truncateDisplay(neutralise(name).text, 60);
  } catch {
    return undefined;
  }
}

/**
 * A labelled fallback's message (S3): `<phrase>: ` at the front of its words, in both places a reader meets them — the
 * one section a person sees, and `text`, which notifications show. The composer's own shape of the labelled words, so
 * the two halves say the same thing and reading reports no mismatch: a context block above the section, as this was
 * first written, made every labelled post read back as one saying something else in its notification — the very
 * signal a deception raises. A post with no words (files alone) is labelled `Sent by <phrase>`.
 */
export function labelledPayload(payload: ComposedPayload, phrase: string): ComposedPayload {
  const text =
    payload.text === ''
      ? escapeForSlack(fallbackLabelLine(phrase))
      : `${escapeForSlack(fallbackTextPrefix(phrase))}${payload.text}`;
  return payloadOf(text, payload.channel, payload.thread_ts);
}

/**
 * S3 for an edit (S5): `text` only — Slack shows "(edited)" only on a text update — so the prefix goes at the front of
 * its new words. Words that already begin with it are not labelled twice.
 */
export function labelledEditText(text: string, phrase: string): string {
  const prefix = escapeForSlack(fallbackTextPrefix(phrase));
  return text.startsWith(prefix) ? text : `${prefix}${text}`;
}

/**
 * Who an edit of a message the person posted appears to come from (S5): `agent` puts the fallback's prefix in its new
 * words, because an agent wrote the change; `me` changes them as the person, unlabelled. The person's token makes it
 * either way — `chat.update` changes only the caller's own messages.
 */
export function decideEditLabel(
  deps: { readonly call: SlackCall; readonly postingAs: string; readonly label: LabelDeps },
  request: Omit<LabelRequest, 'kind'>,
): Promise<SlackLabel> {
  return decideLabel(
    { ...deps, label: { ...deps.label, app: undefined, noApp: FALLBACK_REASONS.edit } },
    { ...request, kind: 'edit' },
  );
}

/** An edit's first line (S7): the label it puts in the words, or none. */
export function editLine(label: SlackLabel, appName?: string | undefined): string {
  if (label.identity === 'me') return identityLine(label, appName);
  if (label.route === 'app') return `${label.phrase ?? 'the app’s message'} · edited by the app, which posted it`;
  return `${label.name ?? ''} · labelled "${fallbackTextPrefix(label.phrase ?? '').trimEnd()}" at the start of the new words · ${label.reason ?? ''}`;
}

/** The risk flags that carry what the message asked for, so the gate decides the same way at send and approval. */
export const AS_ME = 'as-me';
export const AS_AGENT = 'as-agent';

export function requestFlags(requested: MessageIdentity | undefined): string[] {
  return requested === 'me' ? [AS_ME] : requested === 'agent' ? [AS_AGENT] : [];
}

/**
 * What the message asked for, read back from its approval's flags. The flags are not bound — the digest is — so a
 * flag changed by hand decides differently, hashes differently, and is refused.
 */
export function requestedOf(flags: readonly string[] | undefined): MessageIdentity | undefined {
  if (flags?.includes(AS_ME)) return 'me';
  if (flags?.includes(AS_AGENT)) return 'agent';
  return undefined;
}

/** Refuses anything but `agent` or `me` for `as`, before Slack is asked anything. */
export function checkedIdentity(value: unknown): MessageIdentity | undefined {
  if (value === undefined) return undefined;
  if (value === 'agent' || value === 'me') return value;
  throw new CommsError(
    'USAGE',
    `"${truncateDisplay(String(value), 40)}" is not who a message can appear to come from`,
    {
      hint: 'Pass `agent` (labelled, the default) or `me` (as you, unlabelled) — `me` only when the person said so for this message.',
      details: { reason: 'not-an-identity' },
    },
  );
}
