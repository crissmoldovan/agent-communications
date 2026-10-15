/**
 * Labelling what an agent sends (design 2026-10-15-agent-label): the phrase `<name> (<word>)`, who a message appears to
 * come from, and which setting changes loosen that. Pure: nothing here reads the configuration or talks to a channel,
 * so every channel decides the same way from the same settings.
 */
import { isDangerous } from './chars.ts';
import { CommsError } from './errors.ts';

/** L2: the words a label may use, exactly as written. Adding one is a code change with its own review. */
export const AGENT_LABEL_WORDS: readonly ['agent', 'assistant', 'twin', 'minion', 'bot', 'fake', 'AI'] = Object.freeze([
  'agent',
  'assistant',
  'twin',
  'minion',
  'bot',
  'fake',
  'AI',
] as const);
export type AgentLabelWord = (typeof AGENT_LABEL_WORDS)[number];
export const DEFAULT_AGENT_LABEL_WORD: AgentLabelWord = 'agent';

/** L3: `agent` is labelled; `me` goes out as the person, unlabelled. */
export type MessageIdentity = 'agent' | 'me';

/** L4: the kinds of act a rule may name. Slack posts, replies, reacts, edits and shares files; mail sends and replies. */
export const ACT_KINDS: readonly ['post', 'reply', 'reaction', 'edit', 'file', 'send'] = Object.freeze([
  'post',
  'reply',
  'reaction',
  'edit',
  'file',
  'send',
] as const);
export type ActKind = (typeof ACT_KINDS)[number];

/** L4: a rule names an account, optionally a conversation and kinds, and gives the identity. */
export interface AgentLabelRule {
  readonly account: string;
  /**
   * The account's stable id (`ibx_…`, `acc_…`) when the rule was added. A rule that carries one matches only that
   * account, so an account connected later under a removed account's name never inherits its rules.
   */
  readonly accountId?: string;
  /** Slack: a channel or DM id (`C…`, `G…`, `D…`) or a person (`U…`). Mail: an address or `@domain`. */
  readonly conversation?: string;
  readonly kinds?: readonly ActKind[];
  readonly as: MessageIdentity;
}

/** L5: `config.json`'s `agentLabel`. Every field may be absent: absent means the word `agent` and no rules. */
export interface AgentLabelSettings {
  readonly word?: AgentLabelWord;
  readonly name?: string;
  readonly rules?: readonly AgentLabelRule[];
  /** S4: a Slack account id's agent emoji, `:name:`. */
  readonly slackIcons?: Readonly<Record<string, string>>;
}

/** What a channel knows about one act when it asks who it appears to come from. */
export interface IdentityQuery {
  readonly account: string;
  /** The account's stable id. A rule that recorded an id matches only a query that carries the same one. */
  readonly accountId?: string | undefined;
  readonly kind: ActKind;
  /** L3 step 1: what the person told the agent, passed to the prepare as `as`. */
  readonly requested?: MessageIdentity | undefined;
  readonly slack?: { readonly channel: string; readonly dmWith?: string | undefined } | undefined;
  readonly mail?: { readonly recipients: readonly string[] } | undefined;
}

export interface IdentityDecision {
  readonly identity: MessageIdentity;
  readonly source: 'message' | 'rule' | 'default';
  readonly rule?: AgentLabelRule;
}

/** L2's characters a name may not hold: parentheses would fake a second label, the rest break an address header. */
const FORBIDDEN_NAME_CHARACTERS = /[()<>"@,;:\\]/u;

export function isAgentLabelWord(value: unknown): value is AgentLabelWord {
  return typeof value === 'string' && (AGENT_LABEL_WORDS as readonly string[]).includes(value);
}

/** Why a name cannot be labelled, or undefined when it can. */
function nameProblem(name: string): string | undefined {
  if (name.length === 0) return 'the name is empty';
  if (name.trim() !== name) return 'the name starts or ends with a space';
  if (FORBIDDEN_NAME_CHARACTERS.test(name)) return 'the name holds a parenthesis or one of <>"@,;:\\';
  for (const char of name)
    if (isDangerous(char.codePointAt(0) ?? 0)) return 'the name holds a hidden or control character';
  return undefined;
}

/** L1: `<name> (<word>)`, refused rather than cut short when it does not fit `limit` characters. */
export function labelPhrase(name: string, word: AgentLabelWord, limit: number): string {
  const suffix = ` (${word})`;
  const bare = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  const problem = nameProblem(bare);
  if (problem !== undefined) throw new CommsError('USAGE', `the label cannot be made: ${problem}`);
  const phrase = `${bare}${suffix}`;
  if ([...phrase].length > limit)
    throw new CommsError('USAGE', `the label "${phrase}" is longer than this platform's ${limit} characters`, {
      hint: 'Set a shorter name with `label name`.',
    });
  return phrase;
}

/** S3: the context line above a labelled fallback message. */
export function fallbackLabelLine(phrase: string): string {
  return `Sent by ${phrase}`;
}

/** S3: what a labelled fallback's `text` begins with, so its notification carries the label too. */
export function fallbackTextPrefix(phrase: string): string {
  return `${phrase}: `;
}

/** L3's sentence for an unlabelled message, the first line of its preview. */
export const UNLABELLED_PREVIEW_LINE = 'Sent as you, with no label: it will look as if you wrote it yourself';

function addressMatches(pattern: string, address: string): boolean {
  const want = pattern.toLowerCase();
  const got = address.toLowerCase();
  return want.startsWith('@') ? got.endsWith(want) && got.indexOf('@') === got.length - want.length : got === want;
}

function ruleMatches(rule: AgentLabelRule, query: IdentityQuery): boolean {
  if (rule.account !== query.account) return false;
  if (rule.accountId !== undefined && rule.accountId !== query.accountId) return false;
  if (rule.kinds !== undefined && !rule.kinds.includes(query.kind)) return false;
  if (rule.conversation === undefined) return true;
  if (query.slack !== undefined)
    return rule.conversation === query.slack.channel || rule.conversation === query.slack.dmWith;
  if (query.mail !== undefined) {
    const conversation = rule.conversation;
    return (
      query.mail.recipients.length > 0 &&
      query.mail.recipients.every((address) => addressMatches(conversation, address))
    );
  }
  return false;
}

/** L4: conversation and kinds, then conversation, then kinds, then the bare account rule. */
function specificity(rule: AgentLabelRule): number {
  return (rule.conversation === undefined ? 0 : 2) + (rule.kinds === undefined ? 0 : 1);
}

/** L3: the message, then the most specific matching rule (`agent` winning a tie), then the default `agent`. */
export function resolveIdentity(settings: AgentLabelSettings | undefined, query: IdentityQuery): IdentityDecision {
  if (query.requested !== undefined) return { identity: query.requested, source: 'message' };
  let best: AgentLabelRule | undefined;
  for (const rule of settings?.rules ?? []) {
    if (!ruleMatches(rule, query)) continue;
    if (
      best === undefined ||
      specificity(rule) > specificity(best) ||
      (specificity(rule) === specificity(best) && rule.as === 'agent')
    )
      best = rule;
  }
  return best === undefined
    ? { identity: 'agent', source: 'default' }
    : { identity: best.as, source: 'rule', rule: best };
}

export interface AgentLabelLoosening {
  readonly path: 'agentLabel.word' | 'agentLabel.name' | 'agentLabel.rules' | 'agentLabel.slackIcons';
  readonly was: unknown;
  readonly now: unknown;
}

const ruleKey = (rule: AgentLabelRule): string =>
  JSON.stringify([
    rule.account,
    rule.accountId ?? null,
    rule.conversation ?? null,
    rule.kinds === undefined ? null : [...rule.kinds].sort(),
    rule.as,
  ]);

/**
 * L5: the changes that need the person's confirmation — anything that could leave a message unlabelled or change how
 * the label looks. Adding an `agent` rule or removing a `me` rule tightens, and is not listed.
 */
export function classifyAgentLabelChange(
  before: AgentLabelSettings | undefined,
  after: AgentLabelSettings | undefined,
): AgentLabelLoosening[] {
  const changes: AgentLabelLoosening[] = [];
  const wordBefore = before?.word ?? DEFAULT_AGENT_LABEL_WORD;
  const wordAfter = after?.word ?? DEFAULT_AGENT_LABEL_WORD;
  if (wordBefore !== wordAfter) changes.push({ path: 'agentLabel.word', was: wordBefore, now: wordAfter });
  if ((before?.name ?? null) !== (after?.name ?? null))
    changes.push({ path: 'agentLabel.name', was: before?.name, now: after?.name });
  const rulesBefore = new Map((before?.rules ?? []).map((rule) => [ruleKey(rule), rule] as const));
  const rulesAfter = new Map((after?.rules ?? []).map((rule) => [ruleKey(rule), rule] as const));
  const meAdded = [...rulesAfter].some(([key, rule]) => rule.as === 'me' && !rulesBefore.has(key));
  const agentRemoved = [...rulesBefore].some(([key, rule]) => rule.as === 'agent' && !rulesAfter.has(key));
  if (meAdded || agentRemoved)
    changes.push({ path: 'agentLabel.rules', was: before?.rules ?? [], now: after?.rules ?? [] });
  if (JSON.stringify(sorted(before?.slackIcons)) !== JSON.stringify(sorted(after?.slackIcons)))
    changes.push({ path: 'agentLabel.slackIcons', was: before?.slackIcons ?? {}, now: after?.slackIcons ?? {} });
  return changes;
}

function sorted(record: Readonly<Record<string, string>> | undefined): [string, string][] {
  return Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const EMOJI_NAME = /^:[a-z0-9_+'-]{1,100}:$/u;

function isRule(value: unknown): value is AgentLabelRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Record<string, unknown>;
  if (typeof rule.account !== 'string' || rule.account.length === 0) return false;
  if (rule.as !== 'agent' && rule.as !== 'me') return false;
  if (rule.accountId !== undefined && (typeof rule.accountId !== 'string' || rule.accountId.length === 0)) return false;
  if (rule.conversation !== undefined && (typeof rule.conversation !== 'string' || rule.conversation.length === 0))
    return false;
  if (
    rule.kinds !== undefined &&
    !(
      Array.isArray(rule.kinds) &&
      rule.kinds.length > 0 &&
      rule.kinds.every((kind) => (ACT_KINDS as readonly unknown[]).includes(kind))
    )
  )
    return false;
  return true;
}

/**
 * The stored `agentLabel`, read so that a bad value can only tighten. An unknown word reads as `agent`, an invalid
 * name as no name, and a rule list with any invalid rule is ignored whole: dropping one `agent` rule could leave a
 * broader `me` rule in charge. A malformed icon entry is dropped, falling back to the plain photo.
 */
export function readAgentLabelSettings(raw: unknown): AgentLabelSettings {
  if (typeof raw !== 'object' || raw === null) return {};
  const stored = raw as Record<string, unknown>;
  const settings: {
    word?: AgentLabelWord;
    name?: string;
    rules?: AgentLabelRule[];
    slackIcons?: Record<string, string>;
  } = {};
  if (isAgentLabelWord(stored.word)) settings.word = stored.word;
  if (typeof stored.name === 'string' && nameProblem(stored.name) === undefined) settings.name = stored.name;
  if (Array.isArray(stored.rules) && stored.rules.every(isRule))
    settings.rules = stored.rules.map((rule) => ({ ...rule }));
  if (typeof stored.slackIcons === 'object' && stored.slackIcons !== null) {
    const icons = Object.entries(stored.slackIcons as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && EMOJI_NAME.test(entry[1]),
    );
    if (icons.length > 0) settings.slackIcons = Object.fromEntries(icons);
  }
  return settings;
}

/** The person's label settings from a loaded configuration, read as `readAgentLabelSettings` reads them. */
export function agentLabelOf(config: { readonly agentLabel?: unknown }): AgentLabelSettings {
  return readAgentLabelSettings(config.agentLabel);
}
