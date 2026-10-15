import {
  ACT_KINDS,
  type ActKind,
  AGENT_LABEL_WORDS,
  type AgentLabelRule,
  type AgentLabelSettings,
  type AgentLabelWord,
  agentLabelOf,
  classifyAgentLabelChange,
  DEFAULT_AGENT_LABEL_WORD,
  type IdentityQuery,
  isAgentLabelWord,
  labelPhrase,
  type MessageIdentity,
  readAgentLabelSettings,
  resolveIdentity,
} from '../agent-label.ts';
import type { GatedChange } from '../change-flow.ts';
import type { ChangeRequest, ChangeSurface } from '../changes.ts';
import { channelLabel, isChannel } from '../channel-servers.ts';
import { agentLabelRuleText, type Config, type ConnectedAccount, connectedAccounts } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { formerNameRefusal } from '../names.ts';

/**
 * Labelling what an agent sends (design 2026-10-15-agent-label, L5 and L6): `agentcomms label` and `comms_label`, one
 * operation each way — `labelReport` shows, `labelChange` changes.
 *
 * Showing asks nobody: the word, the name, every rule, and for each account and each kind of message who it will appear
 * to come from. A change goes through the one change flow (`gatedChange`): one that could leave a message unlabelled,
 * or that changes how the label looks — a `me` rule added, an `agent` rule removed, a new word, name or Slack icon — is
 * a loosening `classifyChange` lists, shown to the person with the phrase recipients will see, or the identity each
 * affected kind will now have, and applied only with their approval; a tightening applies at once.
 *
 * The settings are read as every channel reads them (`agentLabelOf`), so a value this release cannot read counts as the
 * stricter one; a change writes only the field it is about, and keeps every other key of `agentLabel` as it was.
 */

/** Who an agent's message appears to come from, as a person reads it. */
const AS_AGENT = 'as your agent';
const AS_YOU = 'as you, with no label';

/**
 * The channels whose sends are labelled, the kinds of act each has, and what a rule's conversation is there. A channel
 * not listed labels nothing through these tools — WhatsApp only drafts a link the person sends (§2) — so a rule for one
 * of its accounts is refused rather than kept to do nothing.
 */
const LABELLED: Readonly<Record<string, { kinds: readonly ActKind[]; conversation: 'slack' | 'mail' }>> = Object.freeze(
  {
    slack: { kinds: ['post', 'reply', 'reaction', 'edit', 'file'], conversation: 'slack' },
    gmail: { kinds: ['send', 'reply'], conversation: 'mail' },
    resend: { kinds: ['send', 'reply'], conversation: 'mail' },
  },
);

/**
 * The longest a phrase made with the name setting may be: a Slack `username`'s 80 characters, the shortest limit of
 * any channel (L2), so the setting works wherever a channel falls back to it. A channel's own name is held to its own
 * limit when it prepares.
 */
const NAME_SETTING_LIMIT = 80;

/** A Slack channel or DM (`C…`, `G…`, `D…`), or a person (`U…`, or `W…` on Enterprise Grid). */
const SLACK_CONVERSATION = /^[CGDUW][A-Z0-9]{2,}$/u;
/** An address, or `@domain` for every address there. */
const MAIL_CONVERSATION = /^(?:[^\s@<>(),;:"\\]+)?@[^\s@<>(),;:"\\]+$/u;

export interface LabelKindView {
  kind: ActKind;
  identity: MessageIdentity;
  /** `rule` when a rule decided it, `default` when none did. */
  source: 'rule' | 'default';
  /** The rule that decided it, in words. */
  rule?: string;
  /** What recipients see: the phrase, or that it is sent as the person. */
  appearsAs: string;
}

export interface LabelAccountView {
  account: string;
  platform: string;
  /** "Slack", "Gmail" — or the platform as written, for one this release does not know. */
  channel: string;
  /**
   * The phrase made with the name setting, for where this channel has no name of its own for the person; null when
   * no name is set, and a message there is then refused until one is.
   */
  phrase: string | null;
  /** Who each kind of message appears to come from, account-wide. Empty for a channel that labels nothing. */
  kinds: LabelKindView[];
  /** Rules for one conversation of this account, in words: they decide there, over `kinds`. */
  conversations: string[];
  /** Slack only: the icon of the app's posts — the agent emoji, or the person's Slack photo until one is set. */
  icon?: { emoji: string } | { photo: true };
  /** Why `kinds` is empty, or what limits it. */
  note?: string;
}

export interface LabelRuleView {
  rule: AgentLabelRule;
  text: string;
  /** False when it names no account connected now — renamed or removed — so it matches nothing (Review focus 2). */
  matches: boolean;
}

export interface LabelReport {
  word: AgentLabelWord;
  /** The words there are to choose from (L2). */
  words: readonly AgentLabelWord[];
  name: string | null;
  rules: LabelRuleView[];
  accounts: LabelAccountView[];
  /** Stored settings this release could not read, and so ignored: each counts as the stricter value. */
  ignored: string[];
}

/** A rule as a caller gives it: checked and normalised before it is planned. */
export interface LabelRuleInput {
  account: string;
  conversation?: string | undefined;
  kinds?: readonly string[] | undefined;
  as: string;
}

/** One change: `agentcomms label word twin` is `{ word: 'twin' }`, as `comms_label` takes it. */
export type LabelChangeRequest =
  | { word: string }
  | { name: string | null }
  | { addRule: LabelRuleInput }
  | { removeRule: LabelRuleInput }
  | { icon: { account: string; emoji: string | null } };

export type LabelChangeKind = 'word' | 'name' | 'addRule' | 'removeRule' | 'icon';

export const LABEL_CHANGE_KINDS: readonly LabelChangeKind[] = Object.freeze([
  'word',
  'name',
  'addRule',
  'removeRule',
  'icon',
]);

export interface LabelChangeResult extends LabelReport {
  change: LabelChangeKind;
  /** False when the settings already said this, and nothing was written. */
  changed: boolean;
  /** Why nothing was written, or what else the change did — a rule it replaced. Null when there is nothing to add. */
  note: string | null;
}

/** The label settings as they stand, and who each kind of message on each account will appear to come from. */
export async function labelReport(core: Core): Promise<LabelReport> {
  return reportOf(await core.config.load());
}

/**
 * One change to the label settings, as a change the flow asks for or applies: see the top of this file.
 *
 * What a request says on its own is checked here, before anything is read; what depends on the accounts is checked
 * when the change is planned, on both calls, so a claim for an account that has gone since is refused.
 */
export function labelChange(
  core: Core,
  request: LabelChangeRequest,
  surface: ChangeSurface,
): GatedChange<LabelChangeResult> {
  const change = checkedRequest(request);
  let planned: { changes: boolean; note: string | null; target: Target | null } | null = null;
  return {
    plan: (config) => {
      const outcome = planChange(config, change);
      planned = { changes: outcome.changes, note: outcome.note, target: outcome.target };
      const after = outcome.changes ? outcome.edit(config) : config;
      // The phrase or the identities, only for a change that waits: a tightening has nothing to show, and an effect
      // would make it wait.
      const loosens = classifyAgentLabelChange(agentLabelOf(config), agentLabelOf(after)).length > 0;
      return {
        ...(outcome.target?.kind === 'mail' ? { inbox: outcome.target.name } : {}),
        ...(outcome.target?.kind === 'channel' ? { account: outcome.target.name } : {}),
        before: config,
        after,
        summary: outcome.summary,
        effects: loosens ? effectsOf(config, after, change) : [],
      } satisfies ChangeRequest;
    },
    apply: async (consent) => {
      if (planned === null) throw new CommsError('UNEXPECTED', 'the label was changed before it was planned');
      const { note, target } = planned;
      if (!planned.changes) return { change: change.kind, changed: false, note, ...reportOf(await core.config.load()) };
      // Made again from the configuration read inside the store's lock: whatever else moved meanwhile stays as it is,
      // and a loosening that is no longer the one approved is the store's to refuse.
      const written = await core.config.update((config) => planChange(config, change).edit(config), {
        ...(consent ? { consent } : {}),
      });
      await core.audit.append({
        inboxId: target?.id ?? '',
        ...(target ? { alias: target.name } : {}),
        operation: AUDIT_OPERATIONS[change.kind],
        outcome: 'ok',
        surface,
        reason: auditReason(change),
      });
      return { change: change.kind, changed: true, note, ...reportOf(written) };
    },
  };
}

// ── The request ────────────────────────────────────────────────────────────────────────────────────────────────────

type CheckedChange =
  | { kind: 'word'; word: AgentLabelWord }
  | { kind: 'name'; name: string | null }
  | { kind: 'addRule'; rule: AgentLabelRule }
  | { kind: 'removeRule'; rule: AgentLabelRule }
  | { kind: 'icon'; account: string; emoji: string | null };

const AUDIT_OPERATIONS: Readonly<Record<LabelChangeKind, string>> = {
  word: 'label.word',
  name: 'label.name',
  addRule: 'label.rule.add',
  removeRule: 'label.rule.remove',
  icon: 'label.icon',
};

function auditReason(change: CheckedChange): string {
  switch (change.kind) {
    case 'word':
      return change.word;
    case 'name':
      return change.name === null ? 'cleared' : change.name;
    case 'addRule':
    case 'removeRule':
      return agentLabelRuleText(change.rule);
    case 'icon':
      return change.emoji ?? 'cleared';
  }
}

function checkedRequest(request: LabelChangeRequest): CheckedChange {
  const given = LABEL_CHANGE_KINDS.filter(
    (kind) => typeof request === 'object' && request !== null && Object.hasOwn(request, kind),
  );
  if (given.length !== 1) {
    throw new CommsError(
      'USAGE',
      given.length === 0
        ? 'name the change: a word, a name, a rule to add or remove, or a Slack icon'
        : `one change at a time: this asks for ${given.join(' and ')}`,
      { hint: 'Each change is shown, and approved when it loosens the label, on its own.' },
    );
  }
  const values = request as Record<string, unknown>;
  const [kind] = given as [LabelChangeKind];
  switch (kind) {
    case 'word':
      return { kind, word: checkedWord(values.word) };
    case 'name':
      return { kind, name: values.name === null ? null : checkedName(values.name) };
    case 'addRule':
    case 'removeRule':
      return { kind, rule: checkedRule(values[kind]) };
    case 'icon': {
      const icon = values.icon as { account?: unknown; emoji?: unknown } | null | undefined;
      if (typeof icon?.account !== 'string' || icon.account === '') {
        throw new CommsError('USAGE', 'name the Slack account the icon is for');
      }
      return { kind, account: icon.account, emoji: icon.emoji === null ? null : checkedEmoji(icon.emoji) };
    }
  }
}

function checkedWord(word: unknown): AgentLabelWord {
  if (isAgentLabelWord(word)) return word;
  throw new CommsError('USAGE', `${JSON.stringify(word)} is not one of the label's words`, {
    hint: `Choose one of: ${AGENT_LABEL_WORDS.join(', ')}, written exactly so.`,
  });
}

/** A name the contract can label and read back, with no word of its own: the word is added after it. */
function checkedName(name: unknown): string {
  if (typeof name !== 'string') throw new CommsError('USAGE', 'the name is text: your name, as people know it');
  // The contract's own rules, in its own words: empty, a space at either end, a forbidden or a hidden character.
  labelPhrase(name, DEFAULT_AGENT_LABEL_WORD, Number.POSITIVE_INFINITY);
  // What `labelPhrase` takes and the reader would not: a name that ends with a word in parentheses already.
  if (readAgentLabelSettings({ name }).name !== name) {
    throw new CommsError('USAGE', 'the name holds a parenthesis or one of <>"@,;:\\', {
      hint: 'Give the name alone: the word is added after it, in parentheses.',
    });
  }
  return name;
}

function checkedEmoji(emoji: unknown): string {
  // The contract reads an icon back only in this form, so it is the only form written.
  if (typeof emoji === 'string' && readAgentLabelSettings({ slackIcons: { x: emoji } }).slackIcons?.x === emoji) {
    return emoji;
  }
  throw new CommsError('USAGE', `${JSON.stringify(emoji)} is not a Slack emoji name`, {
    hint: 'Write the name between colons, in lower case, as Slack shows it: :jo-agent:.',
  });
}

function checkedRule(value: unknown): AgentLabelRule {
  const given = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const { account, conversation, kinds } = given;
  if (typeof account !== 'string' || account === '') {
    throw new CommsError('USAGE', 'a rule names the account it is for: organisation/platform');
  }
  if (given.as !== 'agent' && given.as !== 'me') {
    throw new CommsError(
      'USAGE',
      `a rule says who a message appears to come from: agent or me, not ${String(given.as)}`,
    );
  }
  const rule: { account: string; conversation?: string; kinds?: ActKind[]; as: MessageIdentity } = {
    account,
    as: given.as,
  };
  if (conversation !== undefined) {
    if (typeof conversation !== 'string' || conversation.trim() === '') {
      throw new CommsError('USAGE', 'a conversation is a Slack channel or person id, an address, or @domain');
    }
    // A mail rule is matched in lower case; kept that way, two spellings of one address are one rule.
    rule.conversation = conversation.includes('@') ? conversation.toLowerCase() : conversation;
  }
  if (kinds !== undefined) {
    if (!Array.isArray(kinds) || kinds.length === 0) {
      throw new CommsError('USAGE', 'name the kinds a rule is for, or leave kinds out for every kind', {
        hint: `The kinds are: ${ACT_KINDS.join(', ')}.`,
      });
    }
    const unknown = kinds.filter((kind) => !(ACT_KINDS as readonly unknown[]).includes(kind));
    if (unknown.length > 0) {
      throw new CommsError(
        'USAGE',
        `not a kind of message: ${unknown.map((kind) => JSON.stringify(kind)).join(', ')}`,
        {
          hint: `The kinds are: ${ACT_KINDS.join(', ')}.`,
        },
      );
    }
    // Each once, in the list's order: the same rule is written the same way however it was asked for.
    rule.kinds = ACT_KINDS.filter((kind) => kinds.includes(kind));
  }
  return rule;
}

// ── Planning ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Target {
  kind: ConnectedAccount['kind'];
  name: string;
  id: string;
}

interface Plan {
  changes: boolean;
  note: string | null;
  target: Target | null;
  summary: string;
  edit: (config: Config) => Config;
}

/** The stored `agentLabel`, as an object whose other keys a change keeps. */
function stored(config: Config): Record<string, unknown> {
  const raw = config.agentLabel;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

/** `config` with `agentLabel` made by `make` from what is stored, and nothing else touched. */
function withStored(make: (label: Record<string, unknown>) => Record<string, unknown>): (config: Config) => Config {
  return (config) => {
    const label = make(stored(config));
    const next = structuredClone(config);
    if (Object.keys(label).length === 0) delete next.agentLabel;
    else next.agentLabel = label;
    return next;
  };
}

function planChange(config: Config, change: CheckedChange): Plan {
  const settings = agentLabelOf(config);
  const raw = stored(config);
  switch (change.kind) {
    case 'word': {
      const { word } = change;
      const already =
        (settings.word ?? DEFAULT_AGENT_LABEL_WORD) === word && (raw.word === undefined || raw.word === word);
      // The name the setting holds, with this word, still has to fit every channel it fills in for.
      if (settings.name !== undefined) labelPhrase(settings.name, word, NAME_SETTING_LIMIT);
      return {
        changes: !already,
        note: already ? `The word is ${word} already. Nothing was changed.` : null,
        target: null,
        summary: `Label what an agent sends with the word "${word}"`,
        edit: withStored((label) => ({ ...label, word })),
      };
    }
    case 'name': {
      const { name } = change;
      if (name !== null) labelPhrase(name, settings.word ?? DEFAULT_AGENT_LABEL_WORD, NAME_SETTING_LIMIT);
      const already = name === null ? raw.name === undefined : raw.name === name;
      return {
        changes: !already,
        note: already
          ? name === null
            ? 'No name is set. Nothing was changed.'
            : `The name is ${name} already. Nothing was changed.`
          : null,
        target: null,
        summary:
          name === null
            ? 'Clear the name in the agent label'
            : `Label what an agent sends with the name "${name}", where a channel has none of its own for you`,
        edit: withStored(({ name: _cleared, ...label }) => (name === null ? label : { ...label, name })),
      };
    }
    case 'addRule': {
      const { rule } = change;
      const account = connectedAccount(config, rule.account);
      checkRuleFits(rule, account);
      const rules = readableRules(config);
      const same = rules.filter((held) => sameScope(held, rule));
      const already = same.length === 1 && same[0]?.as === rule.as;
      const replaced = same.filter((held) => held.as !== rule.as);
      return {
        changes: !already,
        note: already
          ? 'That rule is there already. Nothing was changed.'
          : replaced.length > 0
            ? `It replaced ${replaced.map(agentLabelRuleText).join(', ')}: one scope has one rule.`
            : null,
        target: targetOf(account),
        summary: `Send ${scopeText(rule)} ${rule.as === 'me' ? AS_YOU : `${AS_AGENT}, labelled`}`,
        edit: withStored((label) => ({
          ...label,
          rules: [...readableRules(config).filter((held) => !sameScope(held, rule)), rule],
        })),
      };
    }
    case 'removeRule': {
      const { rule } = change;
      const rules = readableRules(config);
      if (!rules.some((held) => sameRule(held, rule))) {
        throw new CommsError('NOT_FOUND', `there is no label rule ${agentLabelRuleText(rule)}`, {
          hint:
            rules.length > 0
              ? `The rules are: ${rules.map(agentLabelRuleText).join('; ')}. Give one as it is listed.`
              : 'There are no rules.',
        });
      }
      const account = connectedAccounts(config).find((entry) => entry.alias === rule.account);
      return {
        changes: true,
        note: null,
        target: account === undefined ? null : targetOf(account),
        summary: `Remove the label rule ${agentLabelRuleText(rule)}`,
        edit: withStored((label) => {
          const kept = readableRules(config).filter((held) => !sameRule(held, rule));
          const { rules: _removed, ...rest } = label;
          return kept.length > 0 ? { ...rest, rules: kept } : rest;
        }),
      };
    }
    case 'icon': {
      const account = connectedAccount(config, change.account);
      if (account.platform !== 'slack') {
        throw new CommsError(
          'USAGE',
          `${account.alias} is not a Slack workspace: only the app's Slack posts have an icon`,
        );
      }
      const icons = (typeof raw.slackIcons === 'object' && raw.slackIcons !== null ? raw.slackIcons : {}) as Record<
        string,
        unknown
      >;
      const { emoji } = change;
      const already = emoji === null ? !Object.hasOwn(icons, account.id) : icons[account.id] === emoji;
      return {
        changes: !already,
        note: already
          ? emoji === null
            ? 'No agent emoji is set for it. Nothing was changed.'
            : `Its agent emoji is ${emoji} already. Nothing was changed.`
          : null,
        target: targetOf(account),
        summary:
          emoji === null
            ? `Show your Slack photo as the icon of the agent's posts in ${account.alias}`
            : `Show ${emoji} as the icon of the agent's posts in ${account.alias}`,
        edit: withStored((label) => {
          const next = {
            ...(typeof label.slackIcons === 'object' && label.slackIcons !== null ? label.slackIcons : {}),
          } as Record<string, unknown>;
          if (emoji === null) delete next[account.id];
          else next[account.id] = emoji;
          const { slackIcons: _icons, ...rest } = label;
          return Object.keys(next).length > 0 ? { ...rest, slackIcons: next } : rest;
        }),
      };
    }
  }
}

/** The account a rule or an icon is for: connected now, by its current name — a former one is refused with it. */
function connectedAccount(config: Config, name: string): ConnectedAccount {
  const found = connectedAccounts(config).filter((entry) => entry.alias === name);
  if (found.length > 1) {
    throw new CommsError('CONFIG', `"${name}" names both a mailbox and an account`, {
      hint: 'Rename one of them first.',
    });
  }
  if (found[0] !== undefined) return found[0];
  const renamed = formerNameRefusal(config, 'account', name) ?? formerNameRefusal(config, 'inbox', name);
  if (renamed) throw renamed;
  const known = connectedAccounts(config).map((entry) => entry.alias);
  throw new CommsError('NOT_FOUND', `no mailbox or account is called "${name}"`, {
    hint: known.length > 0 ? `They are: ${known.join(', ')}.` : 'Nothing is connected yet.',
  });
}

function targetOf(account: ConnectedAccount): Target {
  return { kind: account.kind, name: account.alias, id: account.id };
}

/** What a rule names has to be something the account it is for can do: its kinds, and its kind of conversation. */
function checkRuleFits(rule: AgentLabelRule, account: ConnectedAccount): void {
  const acts = Object.hasOwn(LABELLED, account.platform) ? LABELLED[account.platform] : undefined;
  if (acts === undefined) {
    throw new CommsError('USAGE', `${account.alias} sends nothing through these tools, so there is nothing to label`);
  }
  const wrong = (rule.kinds ?? []).filter((kind) => !acts.kinds.includes(kind));
  if (wrong.length > 0) {
    throw new CommsError('USAGE', `${account.alias} does not ${wrong.join(' or ')}`, {
      hint: `Its kinds of message are: ${acts.kinds.join(', ')}.`,
    });
  }
  if (rule.conversation === undefined) return;
  if (acts.conversation === 'slack' && !SLACK_CONVERSATION.test(rule.conversation)) {
    throw new CommsError('USAGE', `${JSON.stringify(rule.conversation)} is not a Slack conversation`, {
      hint: 'Give a channel or DM id (C…, G…, D…), or a person (U…) for your DMs with them — as Slack shows it, not a name.',
    });
  }
  if (acts.conversation === 'mail' && !MAIL_CONVERSATION.test(rule.conversation)) {
    throw new CommsError('USAGE', `${JSON.stringify(rule.conversation)} is not an address or @domain`, {
      hint: 'Give an address, or @domain for everyone there: it matches a message when every recipient matches.',
    });
  }
}

/**
 * The rules as they are read, for a change to them. A stored list this release cannot read is read as no rules — and a
 * change written from that would drop it. So it is refused instead: written by a later release, or by hand.
 */
function readableRules(config: Config): AgentLabelRule[] {
  const raw = stored(config).rules;
  const rules = agentLabelOf(config).rules;
  if (raw !== undefined && rules === undefined) {
    throw new CommsError('CONFIG', 'the label rules in the configuration cannot be read by this release', {
      hint: 'They are ignored, so every message is labelled. Update agent-communications, or correct agentLabel.rules in config.json.',
    });
  }
  return [...(rules ?? [])];
}

const kindsKey = (rule: AgentLabelRule): string => (rule.kinds === undefined ? '*' : [...rule.kinds].sort().join(','));
const conversationKey = (rule: AgentLabelRule): string =>
  rule.conversation === undefined
    ? ''
    : rule.conversation.includes('@')
      ? rule.conversation.toLowerCase()
      : rule.conversation;

/** The same account, conversation and kinds — whichever identity each gives. */
function sameScope(a: AgentLabelRule, b: AgentLabelRule): boolean {
  return a.account === b.account && conversationKey(a) === conversationKey(b) && kindsKey(a) === kindsKey(b);
}

function sameRule(a: AgentLabelRule, b: AgentLabelRule): boolean {
  return sameScope(a, b) && a.as === b.as;
}

function scopeText(rule: AgentLabelRule): string {
  const kinds = rule.kinds === undefined ? 'every kind of message' : rule.kinds.join(' and ');
  return `${kinds} from ${rule.account}${rule.conversation === undefined ? '' : ` in ${rule.conversation}`}`;
}

// ── What a person reads ────────────────────────────────────────────────────────────────────────────────────────────

function channelOf(platform: string): string {
  return isChannel(platform) ? channelLabel(platform) : platform;
}

/** The phrase made with the name setting, or null when there is none or it cannot be made. */
function settingPhrase(settings: AgentLabelSettings): string | null {
  if (settings.name === undefined) return null;
  try {
    return labelPhrase(settings.name, settings.word ?? DEFAULT_AGENT_LABEL_WORD, NAME_SETTING_LIMIT);
  } catch {
    return null;
  }
}

/** What an agent's message reads as on a channel: its own name for the person, else the name setting's phrase. */
function agentPhrase(settings: AgentLabelSettings, platform: string): string {
  const word = settings.word ?? DEFAULT_AGENT_LABEL_WORD;
  const phrase = settingPhrase(settings);
  const own = `<your name in ${channelOf(platform)}> (${word})`;
  return phrase === null ? own : `${own}, or ${phrase} where it has none`;
}

function queryFor(account: ConnectedAccount, kind: ActKind, conversation?: string): IdentityQuery {
  if (conversation === undefined) return { account: account.alias, kind };
  const mail = Object.hasOwn(LABELLED, account.platform) && LABELLED[account.platform]?.conversation === 'mail';
  return mail
    ? { account: account.alias, kind, mail: { recipients: [conversation] } }
    : { account: account.alias, kind, slack: { channel: conversation, dmWith: conversation } };
}

function reportOf(config: Config): LabelReport {
  const settings = agentLabelOf(config);
  const raw = stored(config);
  const word = settings.word ?? DEFAULT_AGENT_LABEL_WORD;
  const accounts = connectedAccounts(config);
  const names = new Set(accounts.map((account) => account.alias));
  const rules = settings.rules ?? [];
  const ignored = [
    ...(raw.word !== undefined && settings.word === undefined
      ? [`word: ${JSON.stringify(raw.word)} is not a word on the list, so the word is agent`]
      : []),
    ...(raw.name !== undefined && settings.name === undefined
      ? ['name: it cannot be used in a label, so none is set']
      : []),
    ...(raw.rules !== undefined && settings.rules === undefined
      ? ['rules: one of them cannot be read, so no rule applies']
      : []),
  ];
  return {
    word,
    words: AGENT_LABEL_WORDS,
    name: settings.name ?? null,
    rules: rules.map((rule) => ({ rule, text: agentLabelRuleText(rule), matches: names.has(rule.account) })),
    accounts: accounts.map((account) => accountView(account, settings)),
    ignored,
  };
}

function accountView(account: ConnectedAccount, settings: AgentLabelSettings): LabelAccountView {
  const acts = Object.hasOwn(LABELLED, account.platform) ? LABELLED[account.platform] : undefined;
  const kinds = (acts?.kinds ?? []).map((kind): LabelKindView => {
    const decided = resolveIdentity(settings, queryFor(account, kind));
    return {
      kind,
      identity: decided.identity,
      source: decided.source === 'rule' ? 'rule' : 'default',
      ...(decided.rule ? { rule: agentLabelRuleText(decided.rule) } : {}),
      appearsAs: decided.identity === 'me' ? AS_YOU : `${AS_AGENT}: ${agentPhrase(settings, account.platform)}`,
    };
  });
  const emoji = settings.slackIcons?.[account.id];
  return {
    account: account.alias,
    platform: account.platform,
    channel: channelOf(account.platform),
    phrase: settingPhrase(settings),
    kinds,
    conversations: (settings.rules ?? [])
      .filter((rule) => rule.account === account.alias && rule.conversation !== undefined)
      .map(agentLabelRuleText),
    ...(account.platform === 'slack' ? { icon: emoji === undefined ? { photo: true as const } : { emoji } } : {}),
    ...(acts === undefined ? { note: 'It sends nothing through these tools, so nothing it does is labelled.' } : {}),
  };
}

/**
 * What a change that waits will do, one plain line each, for the preview — deterministic from the configuration, so
 * the claim makes the same lines and binds them: the phrase on each account for a word or a name, the identity each
 * affected kind will now have for a rule, the icon for an icon.
 */
function effectsOf(before: Config, after: Config, change: CheckedChange): string[] {
  const was = agentLabelOf(before);
  const now = agentLabelOf(after);
  switch (change.kind) {
    case 'word':
    case 'name': {
      const labelled = connectedAccounts(after).filter((account) => Object.hasOwn(LABELLED, account.platform));
      const word = now.word ?? DEFAULT_AGENT_LABEL_WORD;
      const fallback = settingPhrase(now);
      const line = (where: string, channel: string) =>
        fallback === null
          ? `${where}: <your name in ${channel}> (${word}); where ${channel} has no name for you, nothing is sent until a name is set`
          : `${where}: <your name in ${channel}> (${word}), or ${fallback} where ${channel} has no name for you`;
      return labelled.length > 0
        ? labelled.map((account) => line(account.alias, channelOf(account.platform)))
        : [line('Every channel', 'it')];
    }
    case 'addRule':
    case 'removeRule': {
      const { rule } = change;
      const account = connectedAccounts(after).find((entry) => entry.alias === rule.account);
      const acts = account && Object.hasOwn(LABELLED, account.platform) ? LABELLED[account.platform] : undefined;
      if (account === undefined || acts === undefined) {
        return [`${rule.account} is connected to nothing now, so no message changes who it appears to come from`];
      }
      const where = rule.conversation === undefined ? account.alias : `${account.alias} in ${rule.conversation}`;
      const lines = (rule.kinds ?? acts.kinds).flatMap((kind) => {
        const from = resolveIdentity(was, queryFor(account, kind, rule.conversation)).identity;
        const to = resolveIdentity(now, queryFor(account, kind, rule.conversation)).identity;
        if (from === to) return [];
        const said = (identity: MessageIdentity) => (identity === 'me' ? AS_YOU : AS_AGENT);
        return [`${where}, ${kind}: ${said(from)} → ${said(to)}`];
      });
      return lines.length > 0 ? lines : [`${where}: no kind of message changes who it appears to come from`];
    }
    case 'icon': {
      const account = connectedAccounts(after).find((entry) => entry.alias === change.account);
      const where = account?.alias ?? change.account;
      return [
        change.emoji === null
          ? `${where}: the app's posts will show your Slack photo as their icon`
          : `${where}: the app's posts will show ${change.emoji} as their icon, once it is uploaded to the workspace's emoji`,
      ];
    }
  }
}
