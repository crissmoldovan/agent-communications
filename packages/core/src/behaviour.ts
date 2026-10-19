/**
 * What an agent may do (design 2026-10-19-agent-behaviour-rules, B1–B4): per account and per conversation, the acts a
 * person allows. This half is enforced — a tool refuses an act no rule allows before anything reaches a preview, an
 * approval or a send — where a writing profile is only guidance. Pure: nothing here writes the configuration or talks
 * to a channel, so every channel decides the same way from the same rules.
 *
 * Here "no rule" means everything is allowed, today's behaviour. So every reading fails closed (B3): a rule binds to its
 * account's id and follows a rename; one whose id no account holds any more still applies by name; an act this release
 * does not know is dropped, narrowing its rule; and a rule it cannot read at all makes its account allow nothing. No
 * value, however malformed, ever makes the rules vanish, as the label's reader may make the label's.
 *
 * `config.ts` imports this module to judge a change, so this one imports from it only types.
 */
import { MAIL_CONVERSATION_PATTERN, SLACK_CONVERSATION_PATTERN } from './agent-label.ts';
import type { Config } from './config.ts';

/** B2: the acts a rule may name — the label's kinds (`ACT_KINDS`), and `delete`. */
export const BEHAVIOUR_ACTS: readonly ['post', 'reply', 'reaction', 'edit', 'delete', 'file', 'send'] = Object.freeze([
  'post',
  'reply',
  'reaction',
  'edit',
  'delete',
  'file',
  'send',
] as const);
export type BehaviourAct = (typeof BEHAVIOUR_ACTS)[number];

/**
 * B3: here the agent may do these acts, and only these. `acts` may be empty, which allows nothing. `conversation` takes
 * the label's grammar — a Slack `C…`, `G…`, `D…`, `U…` or `W…`, or a mail address or `@domain` — and left out, the rule
 * covers the whole account. `accountId` is the account's stable id when the rule was added.
 */
export interface BehaviourRule {
  account: string;
  accountId?: string;
  conversation?: string;
  acts: BehaviourAct[];
}

export interface BehaviourSettings {
  rules: BehaviourRule[];
  /**
   * Rules that could not be read: their account allows nothing (B3). One with no account it can name — not an object,
   * or with no account in it, or a `behaviour` value that is no list of rules at all — could have been meant for any
   * account, so it holds every account. One carrying a readable account id holds that account by its id too, so a
   * rename never sheds it.
   */
  unreadable: { account: string | null; accountId?: string; reason: string }[];
}

/** A rule as a decision names it: the account it applied to, and its conversation when it has one. */
export interface RuleRef {
  account: string;
  conversation?: string;
}

/**
 * One act's question. A place is one destination — a channel, a DM, one mail recipient — and its aliases match at the
 * same specificity: a DM's `D…` and the person's `U…`. Every place must allow every act in `acts`.
 */
export interface ActQuery {
  accountId: string;
  account: string;
  places: string[][];
  acts: BehaviourAct[];
}

/**
 * Allowed, with what is allowed across every place and the rule that narrowed it most (none: everything, no rule); or
 * refused, naming the first act refused, the place it was refused at — the alias whose rule refused it, or the
 * destination when the account's rule did — that rule, and what is allowed there.
 */
export type ActDecision =
  | { allowed: true; rule: RuleRef | null; allowedActs: BehaviourAct[] | 'all' }
  | { allowed: false; act: BehaviourAct; place: string | null; rule: RuleRef; allowedActs: BehaviourAct[] };

/** What one level allowed before a change and after it. */
export interface BehaviourDelta {
  scope: RuleRef;
  before: BehaviourAct[] | 'all';
  after: BehaviourAct[] | 'all';
}

/** A connected account, as a change is judged against it: its stable id and its name. */
export interface BehaviourAccount {
  readonly id: string;
  readonly account: string;
}

export function isBehaviourAct(value: unknown): value is BehaviourAct {
  return typeof value === 'string' && (BEHAVIOUR_ACTS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ReadRule = { rule: BehaviourRule } | { unreadable: BehaviourSettings['unreadable'][number] };

/** One stored rule, or why it cannot be read. Reasons are fixed words: nothing from the file is repeated in them. */
function readRule(raw: unknown, index: number): ReadRule {
  const at = `rule ${index + 1}`;
  if (!isRecord(raw)) return { unreadable: { account: null, reason: `${at} is not an object` } };
  const account = typeof raw.account === 'string' && raw.account.length > 0 ? raw.account : null;
  const accountId = typeof raw.accountId === 'string' && raw.accountId.length > 0 ? raw.accountId : undefined;
  const unreadable = (reason: string): ReadRule => ({
    unreadable: { account, ...(accountId === undefined ? {} : { accountId }), reason: `${at} ${reason}` },
  });
  if (account === null) return unreadable('names no account');
  if (raw.accountId !== undefined && accountId === undefined) return unreadable('has an account id that is not one');
  if (!Array.isArray(raw.acts)) return unreadable('has no list of acts');
  let conversation: string | undefined;
  if (raw.conversation !== undefined) {
    const given = raw.conversation;
    if (typeof given !== 'string' || !(SLACK_CONVERSATION_PATTERN.test(given) || MAIL_CONVERSATION_PATTERN.test(given)))
      return unreadable('names a conversation that is not a Slack channel or person, an address or @domain');
    // As the label stores them: addresses and domains lower-cased, Slack ids as Slack writes them.
    conversation = given.includes('@') ? given.toLowerCase() : given;
  }
  const stored: readonly unknown[] = raw.acts;
  // An act this release does not know is dropped, which narrows the rule; the rest in their order, once each.
  const acts = BEHAVIOUR_ACTS.filter((act) => stored.includes(act));
  return {
    rule: {
      account,
      ...(accountId === undefined ? {} : { accountId }),
      ...(conversation === undefined ? {} : { conversation }),
      acts,
    },
  };
}

/** Nothing in the rules could be read: every account allows nothing until a person fixes them. */
function unreadableWhole(reason: string): BehaviourSettings {
  return { rules: [], unreadable: [{ account: null, reason }] };
}

/**
 * The stored `behaviour` (B3), read so that a bad value can only narrow: never throws, and returns copies. Absent — or
 * an object with no `rules` — is no rules at all.
 */
export function readBehaviourSettings(config: Config): BehaviourSettings {
  try {
    const stored: unknown = config.behaviour;
    if (stored === undefined) return { rules: [], unreadable: [] };
    if (!isRecord(stored)) return unreadableWhole('the behaviour setting is not an object');
    const rules: unknown = stored.rules;
    if (rules === undefined) return { rules: [], unreadable: [] };
    if (!Array.isArray(rules)) return unreadableWhole('the behaviour rules are not a list');
    const settings: BehaviourSettings = { rules: [], unreadable: [] };
    rules.forEach((raw: unknown, index) => {
      const read = readRule(raw, index);
      if ('rule' in read) settings.rules.push(read.rule);
      else settings.unreadable.push(read.unreadable);
    });
    return settings;
  } catch {
    return unreadableWhole('the behaviour rules could not be read');
  }
}

/** Who a rule is asked about: an account by its id and its name. An id no account holds stands for an account to come. */
interface Who {
  readonly accountId: string;
  readonly account: string;
}

/** By id; failing that, for a rule whose id no account holds (an orphan) or that carries none, by name. */
function appliesTo(rule: BehaviourRule, held: ReadonlySet<string>, who: Who): boolean {
  if (rule.accountId !== undefined) {
    if (rule.accountId === who.accountId) return true;
    if (held.has(rule.accountId)) return false;
  }
  return rule.account === who.account;
}

/** An unreadable rule holds its account by name or by id, and one that names none holds every account. */
function unreadableHolds(settings: BehaviourSettings, who: Who): boolean {
  return settings.unreadable.some(
    (entry) =>
      entry.account === null ||
      entry.account === who.account ||
      (entry.accountId !== undefined && entry.accountId === who.accountId),
  );
}

const NO_MATCH = -1;
const ACCOUNT_LEVEL = 0;
const DOMAIN_LEVEL = 1;
const PLACE_LEVEL = 2;

/**
 * How specifically `rule` names a place's alias: its own conversation (a Slack id, exactly; an address), its domain
 * (`@domain`, for an address there, or for a place that is that domain), or the whole account. Addresses compare
 * lower-cased, and an address's domain is what follows its last `@`, so a quoted local part holding one cannot hide it.
 */
function levelOf(rule: BehaviourRule, alias: string | undefined): number {
  if (rule.conversation === undefined) return ACCOUNT_LEVEL;
  if (alias === undefined) return NO_MATCH;
  if (!rule.conversation.includes('@')) return rule.conversation === alias ? PLACE_LEVEL : NO_MATCH;
  const wanted = rule.conversation.toLowerCase();
  const place = alias.toLowerCase();
  if (wanted.startsWith('@')) {
    const at = place.lastIndexOf('@');
    return at !== -1 && place.slice(at) === wanted ? DOMAIN_LEVEL : NO_MATCH;
  }
  return place === wanted ? PLACE_LEVEL : NO_MATCH;
}

interface Resolved {
  acts: BehaviourAct[] | 'all';
  /** The rules at the level that decides, each with the alias it matched, in the place's alias order. */
  deciders: { rule: BehaviourRule; alias: string | undefined }[];
}

function intersect(lists: readonly (readonly BehaviourAct[])[]): BehaviourAct[] {
  return BEHAVIOUR_ACTS.filter((act) => lists.every((acts) => acts.includes(act)));
}

/**
 * One place under `rules` (B3): the most specific level wins, and among the rules there — the aliases of one place, or
 * two rules for one place that a hand edit left — only the acts every one allows. No rule: everything.
 */
function resolvePlace(rules: readonly BehaviourRule[], aliases: readonly string[]): Resolved {
  let best = NO_MATCH;
  let deciders: Resolved['deciders'] = [];
  const consider = (rule: BehaviourRule, alias: string | undefined): void => {
    const level = levelOf(rule, alias);
    if (level === NO_MATCH || level < best) return;
    if (level > best) {
      best = level;
      deciders = [];
    }
    if (!deciders.some((decider) => decider.rule === rule)) deciders.push({ rule, alias });
  };
  for (const alias of aliases.length === 0 ? [undefined] : aliases) for (const rule of rules) consider(rule, alias);
  return {
    acts: deciders.length === 0 ? 'all' : intersect(deciders.map((decider) => decider.rule.acts)),
    deciders,
  };
}

function refOf(rule: BehaviourRule, account: string): RuleRef {
  return rule.conversation === undefined ? { account } : { account, conversation: rule.conversation };
}

/** The ids every connected account holds, mailboxes and the rest. */
function heldIds(config: Config): Set<string> {
  return new Set(behaviourAccountsOf(config).map((account) => account.id));
}

/** Every connected account, by id and name: what `classifyBehaviourChange` judges a configuration's change against. */
export function behaviourAccountsOf(config: Config): BehaviourAccount[] {
  return [...Object.entries(config.inboxes ?? {}), ...Object.entries(config.accounts ?? {})].map(
    ([account, entry]) => ({
      id: entry.id,
      account,
    }),
  );
}

function decide(settings: BehaviourSettings, held: ReadonlySet<string>, query: ActQuery): ActDecision {
  const who: Who = { accountId: query.accountId, account: query.account };
  if (unreadableHolds(settings, who)) {
    const [act] = query.acts;
    return act === undefined
      ? { allowed: true, rule: { account: query.account }, allowedActs: [] }
      : { allowed: false, act, place: query.places[0]?.[0] ?? null, rule: { account: query.account }, allowedActs: [] };
  }
  const rules = settings.rules.filter((rule) => appliesTo(rule, held, who));
  let allowedActs: BehaviourAct[] | 'all' = 'all';
  let narrowest: { size: number; rule: RuleRef } | undefined;
  for (const aliases of query.places.length === 0 ? [[]] : query.places) {
    const { acts, deciders } = resolvePlace(rules, aliases);
    if (acts === 'all') continue;
    const [first] = deciders as [Resolved['deciders'][number]];
    const refused = query.acts.find((act) => !acts.includes(act));
    if (refused !== undefined) {
      const decider = deciders.find((candidate) => !candidate.rule.acts.includes(refused)) ?? first;
      return {
        allowed: false,
        act: refused,
        place: decider.alias ?? aliases[0] ?? null,
        rule: refOf(decider.rule, query.account),
        allowedActs: acts,
      };
    }
    allowedActs = allowedActs === 'all' ? acts : allowedActs.filter((act) => acts.includes(act));
    if (narrowest === undefined || acts.length < narrowest.size)
      narrowest = { size: acts.length, rule: refOf(first.rule, query.account) };
  }
  return { allowed: true, rule: narrowest?.rule ?? null, allowedActs };
}

/**
 * B4: whether every act in `query` is allowed at every one of its places, by the rules in `config` — the one decision
 * every channel's prepare and execute make. A rule matches its account by id, or as an orphan by name; at each place the
 * most specific level wins (an address over its `@domain` over the account; a Slack conversation over the account), and
 * the aliases of one place matched at the same level give only the acts all of them allow.
 */
export function allowedAct(config: Config, query: ActQuery): ActDecision {
  return decide(readBehaviourSettings(config), heldIds(config), query);
}

function isSubset(acts: BehaviourAct[] | 'all', of: BehaviourAct[] | 'all'): boolean {
  if (of === 'all') return true;
  if (acts === 'all') return false;
  return acts.every((act) => of.includes(act));
}

function sameActs(a: BehaviourAct[] | 'all', b: BehaviourAct[] | 'all'): boolean {
  return isSubset(a, b) && isSubset(b, a);
}

/**
 * The accounts a change is judged against when none are given: every account id the rules carry, under the name its
 * rule gives on that side (or the other). Without a configuration, the rules are taken at their word.
 */
function accountsNamedBy(
  before: BehaviourSettings,
  after: BehaviourSettings,
): { before: BehaviourAccount[]; after: BehaviourAccount[] } {
  const names = new Map<string, { before?: string; after?: string }>();
  const collect = (side: 'before' | 'after', settings: BehaviourSettings): void => {
    for (const entry of [...settings.rules, ...settings.unreadable]) {
      if (entry.accountId === undefined || entry.account === null) continue;
      const named = names.get(entry.accountId) ?? {};
      named[side] ??= entry.account;
      names.set(entry.accountId, named);
    }
  };
  collect('before', before);
  collect('after', after);
  const list = (side: 'before' | 'after'): BehaviourAccount[] =>
    [...names].map(([id, named]) => ({
      id,
      account: (side === 'before' ? (named.before ?? named.after) : (named.after ?? named.before)) ?? id,
    }));
  return { before: list('before'), after: list('after') };
}

const byName = (a: BehaviourAccount, b: BehaviourAccount): number =>
  a.account < b.account ? -1 : a.account > b.account ? 1 : 0;

/** A Slack DM's conversation, and a person's: a DM is matched by both at once. */
const isDm = (conversation: string): boolean =>
  conversation.startsWith('D') && SLACK_CONVERSATION_PATTERN.test(conversation);
const isPerson = (conversation: string): boolean =>
  /^[UW]/u.test(conversation) && SLACK_CONVERSATION_PATTERN.test(conversation);

/**
 * B5: whether a change to the rules loosens, and what each level it moves allowed before and after. A change tightens
 * when, at every level it affects, the acts allowed after are a subset of those before; anything else loosens — an act
 * added, a rule removed whose fallback is wider, a conversation rule wider than its account's, an unreadable rule
 * mended. Every level that moved is listed, in either direction, so a preview shows the whole change.
 *
 * Judged per account, as `allowedAct` decides: `accounts` are the connected accounts on each side, by id and name
 * (`behaviourAccountsOf`), and `classifyChange` passes them. Without them, every account id the rules carry is taken as
 * connected under the name its rule gives. Measured are:
 * - every account there after, against what ruled it before: under its name then, or, for one the change connects,
 *   under the name it arrives with — orphans by that name ruled it before it existed, so connecting it loosens nothing;
 * - every account the change removes, as if it were still here: the removal moves nothing, a rule loosened beside it
 *   does;
 * - every name a rule gives that no account has on either side, as an account connected under it later;
 * - any other account, `*`, which only a rule naming no account holds.
 *
 * The levels of an account are the account and every conversation a rule names for it, on either side. A Slack DM is
 * also matched by a `D…` rule and a `U…` rule together, where only what both allow holds; that pair is measured too, and
 * listed as `D… with U…` when it widens though neither of its levels does — a `D…` rule removed beneath a wider `U…`.
 */
export function classifyBehaviourChange(
  before: BehaviourSettings,
  after: BehaviourSettings,
  accounts?: { readonly before: readonly BehaviourAccount[]; readonly after: readonly BehaviourAccount[] },
): { loosens: boolean; deltas: BehaviourDelta[] } {
  const known = accounts ?? accountsNamedBy(before, after);
  const heldBefore = new Set(known.before.map((account) => account.id));
  const heldAfter = new Set(known.after.map((account) => account.id));
  const deltas: BehaviourDelta[] = [];
  let loosens = false;

  const measure = (
    shown: string,
    was: Who,
    now: Who,
    held: { readonly before: ReadonlySet<string>; readonly after: ReadonlySet<string> },
  ): void => {
    const rulesBefore = before.rules.filter((rule) => appliesTo(rule, held.before, was));
    const rulesAfter = after.rules.filter((rule) => appliesTo(rule, held.after, now));
    const noneBefore = unreadableHolds(before, was);
    const noneAfter = unreadableHolds(after, now);
    const at = (aliases: readonly string[]): { was: BehaviourAct[] | 'all'; now: BehaviourAct[] | 'all' } => ({
      was: noneBefore ? [] : resolvePlace(rulesBefore, aliases).acts,
      now: noneAfter ? [] : resolvePlace(rulesAfter, aliases).acts,
    });
    const scope = (conversation: string | undefined): RuleRef =>
      conversation === undefined ? { account: shown } : { account: shown, conversation };
    const conversations = [
      ...new Set(
        [...rulesBefore, ...rulesAfter].flatMap((rule) => (rule.conversation === undefined ? [] : [rule.conversation])),
      ),
    ].sort();
    const widened = new Set<string>();
    for (const conversation of [undefined, ...conversations]) {
      const level = at(conversation === undefined ? [] : [conversation]);
      if (sameActs(level.was, level.now)) continue;
      if (!isSubset(level.now, level.was)) {
        loosens = true;
        if (conversation !== undefined) widened.add(conversation);
      }
      deltas.push({ scope: scope(conversation), before: level.was, after: level.now });
    }
    for (const dm of conversations.filter(isDm)) {
      for (const person of conversations.filter(isPerson)) {
        if (widened.has(dm) || widened.has(person)) continue;
        const pair = at([dm, person]);
        if (isSubset(pair.now, pair.was)) continue;
        loosens = true;
        deltas.push({ scope: scope(`${dm} with ${person}`), before: pair.was, after: pair.now });
      }
    }
  };

  const sides = { before: heldBefore, after: heldAfter };
  for (const now of [...known.after].sort(byName)) {
    const was = known.before.find((account) => account.id === now.id);
    measure(
      now.account,
      { accountId: now.id, account: was?.account ?? now.account },
      { accountId: now.id, account: now.account },
      sides,
    );
  }
  for (const gone of known.before.filter((account) => !heldAfter.has(account.id)).sort(byName)) {
    const who: Who = { accountId: gone.id, account: gone.account };
    measure(gone.account, who, who, { before: heldBefore, after: new Set([...heldAfter, gone.id]) });
  }
  const live = new Set([...known.before, ...known.after].map((account) => account.account));
  const named = new Set(
    [...before.rules, ...after.rules, ...before.unreadable, ...after.unreadable].flatMap((entry) =>
      entry.account === null ? [] : [entry.account],
    ),
  );
  for (const name of [...named].filter((candidate) => !live.has(candidate)).sort()) {
    const who: Who = { accountId: '', account: name };
    measure(name, who, who, sides);
  }
  const anyOther: Who = { accountId: '', account: '' };
  measure('*', anyOther, anyOther, sides);
  return { loosens, deltas };
}
