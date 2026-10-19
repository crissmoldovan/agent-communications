import { MAIL_CONVERSATION_PATTERN, SLACK_CONVERSATION_PATTERN } from '../agent-label.ts';
import {
  allowedAct,
  BEHAVIOUR_ACTS,
  type BehaviourAct,
  type BehaviourRule,
  type BehaviourSettings,
  behaviourAccountsOf,
  isBehaviourAct,
  normaliseMailConversation,
  readBehaviourSettings,
} from '../behaviour.ts';
import type { GatedChange } from '../change-flow.ts';
import type { ChangeRequest, ChangeSurface } from '../changes.ts';
import { type Config, connectedAccounts } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { formerNameRefusal, lookupName } from '../names.ts';

/**
 * What an agent may do (design 2026-10-19-agent-behaviour-rules, B3–B5): `agentcomms behaviour` and `comms_behaviour`,
 * one operation each way — `behaviourReport` shows, `behaviourChange` changes.
 *
 * Showing asks nobody: every rule, whether its account is still connected, and for each account that acts on other
 * people what an agent may start there, across the account and in each conversation a rule names. A change goes through
 * the one change flow (`gatedChange`): `classifyChange` judges it per account, as every channel decides an act, so one
 * that allows more anywhere — an act added, a rule removed whose fallback is wider, a conversation allowed more than its
 * account — waits for the person's yes, with each level it moves before → after in the preview; one that only narrows
 * applies at once.
 *
 * The rules are read as every channel reads them (`readBehaviourSettings`), and written so that nothing a change is not
 * about moves: a rule this release cannot read is kept exactly as it is — it holds its account to nothing, and dropping
 * it would be a loosening nobody asked for — and so is every other key of `behaviour`.
 */

/**
 * The channels whose accounts act on other people, the acts each has (B2), and what a rule's conversation is there. A
 * channel not listed does nothing through these tools — WhatsApp only drafts a link the person sends — so a rule for one
 * of its accounts is refused rather than kept to do nothing. Resend has no threads here, so it only sends.
 */
const ACTING: Readonly<Record<string, { acts: readonly BehaviourAct[]; conversation: 'slack' | 'mail' }>> =
  Object.freeze({
    slack: { acts: ['post', 'reply', 'reaction', 'edit', 'delete', 'file'], conversation: 'slack' },
    gmail: { acts: ['reply', 'send'], conversation: 'mail' },
    resend: { acts: ['send'], conversation: 'mail' },
  });

/** What the first rule on a machine says (B4): a server already running has not read the code that enforces it. */
const FIRST_RULE_NOTE = 'servers started before 0.22.0 do not enforce this until their client restarts them';

export interface BehaviourRuleView {
  account: string;
  conversation?: string;
  acts: BehaviourAct[];
  /**
   * True when no account connected now holds its id — removed, and perhaps connected again under the same name — or,
   * for a rule with no id, its name. It still holds by name (B3): a restriction applied more widely is safe.
   */
  orphan: boolean;
}

export interface BehaviourAccountView {
  account: string;
  /** What an agent may start across the account: `all` where no rule holds, `[]` for nothing. */
  allowed: BehaviourAct[] | 'all';
  /** Each conversation a rule names for this account, and what may be started there. */
  conversations: { conversation: string; allowed: BehaviourAct[] | 'all' }[];
}

export interface BehaviourReport {
  rules: BehaviourRuleView[];
  /** Rules this release cannot read: each holds its account — or, naming none, every account — to nothing. */
  unreadable: BehaviourSettings['unreadable'];
  /** Every connected account that acts on other people, by name. */
  accounts: BehaviourAccountView[];
}

/** One change: `agentcomms behaviour allow acme/slack reply,reaction` is `{ setRule: { … } }`, as the tool takes it. */
export type BehaviourChangeRequest =
  | { setRule: { account: string; conversation?: string | undefined; acts: BehaviourAct[] } }
  | { removeRule: { account: string; conversation?: string | undefined } };

export type BehaviourChangeKind = 'setRule' | 'removeRule';

export const BEHAVIOUR_CHANGE_KINDS: readonly BehaviourChangeKind[] = Object.freeze(['setRule', 'removeRule']);

export interface BehaviourChangeResult extends BehaviourReport {
  change: BehaviourChangeKind;
  /** False when the rules already said this, and nothing was written. */
  changed: boolean;
  /**
   * Why nothing was written, what else the change did — a rule it replaced — or, for the first rule on this machine,
   * that servers started before 0.22.0 do not enforce it until restarted. Null when there is nothing to add.
   */
  note: string | null;
}

/** The rules as they stand, and what each account allows. */
export async function behaviourReport(core: Core): Promise<BehaviourReport> {
  return reportOf(await core.config.load());
}

/**
 * One change to the rules, as a change the flow asks for or applies: see the top of this file.
 *
 * What a request says on its own is checked here, before anything is read; what depends on the accounts is checked
 * when the change is planned, on both calls, so a claim for an account that has gone since is refused.
 */
export function behaviourChange(
  core: Core,
  request: BehaviourChangeRequest,
  surface: ChangeSurface,
): GatedChange<BehaviourChangeResult> {
  const change = checkedRequest(request);
  let planned: { changes: boolean; note: string | null; target: Target | null } | null = null;
  return {
    plan: (config) => {
      const outcome = planChange(config, change);
      planned = { changes: outcome.changes, note: outcome.note, target: outcome.target };
      return {
        ...(outcome.target?.kind === 'mail' ? { inbox: outcome.target.name } : {}),
        ...(outcome.target?.kind === 'channel' ? { account: outcome.target.name } : {}),
        before: config,
        after: outcome.changes ? outcome.edit(config) : config,
        summary: outcome.summary,
        // The levels it moves are the loosening `classifyChange` lists, so a preview shows them: no effect is added,
        // since one would make a tightening wait.
        effects: [],
      } satisfies ChangeRequest;
    },
    apply: async (consent) => {
      if (planned === null) throw new CommsError('UNEXPECTED', 'the rules were changed before they were planned');
      const { note, target } = planned;
      if (!planned.changes) return { change: change.kind, changed: false, note, ...reportOf(await core.config.load()) };
      // Made again from the configuration read inside the store's lock: whatever else moved meanwhile stays as it is,
      // and a loosening that is no longer the one approved is the store's to refuse.
      const written = await core.config.update(
        (config) => {
          const again = planChange(config, change);
          /*
           * The account by its id, as the approval binds it. The levels the store compares name an account as the person
           * knows it, and the change looks the account up by that name: if the name came to mean another account
           * between the claim and this write, the rule would land on that other account. Refused.
           */
          if ((again.target?.id ?? null) !== (target?.id ?? null)) {
            const name = target?.name ?? again.target?.name ?? 'that account';
            throw new CommsError(
              'LOOSENING_REFUSED',
              `this is not the change that was approved: ${name} is another account now`,
              {
                hint: 'The configuration changed after the approval was given. Nothing was written. Prepare the change again and ask again.',
                details: { paths: ['behaviour.rules'] },
              },
            );
          }
          return again.edit(config);
        },
        { ...(consent ? { consent } : {}) },
      );
      await core.audit.append({
        inboxId: target?.id ?? '',
        ...(target ? { alias: target.name } : {}),
        operation: change.kind === 'setRule' ? 'behaviour.rule.set' : 'behaviour.rule.remove',
        outcome: 'ok',
        surface,
        reason: change.kind === 'setRule' ? ruleText(change.rule) : placeText(change.rule),
      });
      return { change: change.kind, changed: true, note, ...reportOf(written) };
    },
  };
}

// ── The request ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Place {
  account: string;
  conversation?: string;
}

type CheckedChange = { kind: 'setRule'; rule: Place & { acts: BehaviourAct[] } } | { kind: 'removeRule'; rule: Place };

function checkedRequest(request: BehaviourChangeRequest): CheckedChange {
  const given = BEHAVIOUR_CHANGE_KINDS.filter(
    (kind) => typeof request === 'object' && request !== null && Object.hasOwn(request, kind),
  );
  if (given.length !== 1) {
    throw new CommsError(
      'USAGE',
      given.length === 0
        ? 'name the change: a rule to set (setRule) or one to remove (removeRule)'
        : `one change at a time: this asks for ${given.join(' and ')}`,
      { hint: 'Each change is shown, and approved when it lets an agent do more, on its own.' },
    );
  }
  const [kind] = given as [BehaviourChangeKind];
  const value = (request as Record<string, unknown>)[kind];
  const place = checkedPlace(value);
  if (kind === 'removeRule') return { kind, rule: place };
  return { kind, rule: { ...place, acts: checkedActs((value as { acts?: unknown }).acts) } };
}

function checkedPlace(value: unknown): Place {
  const given = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const { account, conversation } = given;
  if (typeof account !== 'string' || account === '') {
    throw new CommsError('USAGE', 'a rule names the account it is for: organisation/platform');
  }
  if (conversation === undefined) return { account };
  if (typeof conversation !== 'string' || conversation.trim() === '') {
    throw new CommsError('USAGE', 'a conversation is a Slack channel or person id, an address, or @domain');
  }
  if (!conversation.includes('@')) return { account, conversation };
  // A mail rule is kept in the one form it is matched in — lower-cased, its domain in ASCII, no trailing dot — so two
  // spellings of one address or domain are one rule. One whose domain is not one is refused where its kind is checked
  // (`checkRuleFits`), in the words of the account it is for.
  return { account, conversation: normaliseMailConversation(conversation) ?? conversation.toLowerCase() };
}

function checkedActs(acts: unknown): BehaviourAct[] {
  if (!Array.isArray(acts)) {
    throw new CommsError('USAGE', 'name the acts an agent may do there, or none for nothing at all', {
      hint: `The acts are: ${BEHAVIOUR_ACTS.join(', ')}.`,
    });
  }
  const unknown = acts.filter((act) => !isBehaviourAct(act));
  if (unknown.length > 0) {
    throw new CommsError('USAGE', `not an act: ${unknown.map((act) => JSON.stringify(act)).join(', ')}`, {
      hint: `The acts are: ${BEHAVIOUR_ACTS.join(', ')} — or none, for nothing at all.`,
    });
  }
  // Each once, in the list's order: the same rule is written the same way however it was asked for.
  return BEHAVIOUR_ACTS.filter((act) => acts.includes(act));
}

// ── Planning ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Target {
  kind: 'mail' | 'channel';
  name: string;
  id: string;
  platform: string;
}

interface Plan {
  changes: boolean;
  note: string | null;
  target: Target | null;
  summary: string;
  edit: (config: Config) => Config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The stored rules, raw, for a change to them. A `behaviour` this release cannot read as a list of rules holds every
 * account to nothing, and a change written over it would drop that. So it is refused instead: written by a later
 * release, or by hand.
 */
function storedRules(config: Config): { behaviour: Record<string, unknown>; rules: unknown[] } {
  const raw = config.behaviour;
  if (raw === undefined) return { behaviour: {}, rules: [] };
  const rules = isRecord(raw) ? raw.rules : undefined;
  if (!isRecord(raw) || (rules !== undefined && !Array.isArray(rules))) {
    throw new CommsError('CONFIG', 'the behaviour rules in the configuration cannot be read by this release', {
      hint: 'Until they can, every account allows nothing. Update agent-communications, or correct behaviour.rules in config.json.',
    });
  }
  return { behaviour: { ...raw }, rules: [...((rules as unknown[] | undefined) ?? [])] };
}

/** One stored rule as every channel reads it (`readBehaviourSettings`), or null when this release cannot read it. */
function readStored(raw: unknown): BehaviourRule | null {
  const [rule] = readBehaviourSettings({ behaviour: { rules: [raw] } } as unknown as Config).rules;
  return rule ?? null;
}

/** `config` with these rules, every other key of `behaviour` as it was — and no `behaviour` once nothing is left. */
function withRules(config: Config, behaviour: Record<string, unknown>, rules: unknown[]): Config {
  const next = structuredClone(config);
  const { rules: _replaced, ...rest } = behaviour;
  const kept = rules.length > 0 ? { ...rest, rules } : rest;
  if (Object.keys(kept).length === 0) delete next.behaviour;
  else next.behaviour = kept;
  return next;
}

/** The ids every connected account holds now. */
function heldIds(config: Config): Set<string> {
  return new Set(behaviourAccountsOf(config).map((account) => account.id));
}

/**
 * Whether `rule` holds `account`, as `allowedAct` matches them (behaviour.ts): by its id; failing that — an id no
 * account holds, or none — by name.
 */
function holds(rule: BehaviourRule, held: ReadonlySet<string>, account: { id: string; name: string }): boolean {
  if (rule.accountId !== undefined) {
    if (rule.accountId === account.id) return true;
    if (held.has(rule.accountId)) return false;
  }
  return rule.account === account.name;
}

/** One place, one rule: the same conversation (or none) — the account is matched by `holds`. */
const samePlace = (rule: BehaviourRule, place: Place): boolean => rule.conversation === place.conversation;

function planChange(config: Config, change: CheckedChange): Plan {
  const { behaviour, rules } = storedRules(config);
  const held = heldIds(config);
  const place = change.rule;
  if (change.kind === 'setRule') {
    const target = connectedAccount(config, place.account);
    checkRuleFits(change.rule, target);
    const at = (raw: unknown): boolean => {
      const rule = readStored(raw);
      return rule !== null && samePlace(rule, place) && holds(rule, held, target);
    };
    const same = rules.flatMap((raw) => (at(raw) ? [readStored(raw) as BehaviourRule] : []));
    const { acts } = change.rule;
    const already =
      same.length === 1 &&
      same[0]?.accountId === target.id &&
      same[0].account === target.name &&
      sameActs(same[0].acts, acts);
    const where = placeText({ ...place, account: target.name });
    // The account's id goes with the rule, so it follows a rename and an account connected later under this name
    // never inherits it as its own.
    const rule = {
      account: target.name,
      accountId: target.id,
      ...(place.conversation === undefined ? {} : { conversation: place.conversation }),
      acts,
    };
    return {
      changes: !already,
      note: already
        ? 'That rule is there already. Nothing was changed.'
        : same.length > 0
          ? `It replaced ${same.map(ruleText).join(', ')}: one place has one rule.`
          : rules.length === 0
            ? FIRST_RULE_NOTE
            : null,
      target,
      summary:
        acts.length === 0 ? `Let an agent do nothing in ${where}` : `Let an agent only ${acts.join(', ')} in ${where}`,
      edit: (current) => withRules(current, behaviour, [...rules.filter((raw) => !at(raw)), rule]),
    };
  }
  // A rule is removed for the account connected under this name now, or — gone — for the orphans that name it.
  const target = findConnected(config, place.account);
  const at = (raw: unknown): boolean => {
    const rule = readStored(raw);
    if (rule === null || !samePlace(rule, place)) return false;
    return target === null
      ? rule.account === place.account && !(rule.accountId !== undefined && held.has(rule.accountId))
      : holds(rule, held, target);
  };
  if (!rules.some(at)) {
    const readable = readBehaviourSettings(config).rules;
    throw new CommsError('NOT_FOUND', `there is no behaviour rule for ${placeText(place)}`, {
      hint:
        readable.length > 0
          ? `The rules are: ${readable.map(ruleText).join('; ')}. Give one as it is listed.`
          : 'There are no rules.',
    });
  }
  return {
    changes: true,
    note: null,
    target,
    summary: `Remove the behaviour rule for ${placeText(place)}`,
    edit: (current) =>
      withRules(
        current,
        behaviour,
        rules.filter((raw) => !at(raw)),
      ),
  };
}

function sameActs(a: readonly BehaviourAct[], b: readonly BehaviourAct[]): boolean {
  return a.length === b.length && a.every((act) => b.includes(act));
}

/** The account connected under exactly this name now, mailbox or other, or null. */
function findConnected(config: Config, name: string): Target | null {
  const inbox = lookupName(config, 'inbox', name);
  const account = lookupName(config, 'account', name);
  if (inbox !== undefined && account !== undefined) {
    throw new CommsError('CONFIG', `"${name}" names both a mailbox and an account`, {
      hint: 'Rename one of them first.',
    });
  }
  if (inbox !== undefined) return { kind: 'mail', name, id: inbox.id, platform: inbox.provider };
  if (account !== undefined) return { kind: 'channel', name, id: account.id, platform: account.platform };
  return null;
}

/** The account a rule is for: connected now, by its current name — a former one is refused with it. */
function connectedAccount(config: Config, name: string): Target {
  const found = findConnected(config, name);
  if (found !== null) return found;
  const renamed = formerNameRefusal(config, 'account', name) ?? formerNameRefusal(config, 'inbox', name);
  if (renamed) throw renamed;
  const known = connectedAccounts(config).map((entry) => entry.alias);
  throw new CommsError('NOT_FOUND', `no mailbox or account is called "${name}"`, {
    hint: known.length > 0 ? `They are: ${known.join(', ')}.` : 'Nothing is connected yet.',
  });
}

/** What a rule names has to be something the account it is for can do: its acts, and its kind of conversation. */
function checkRuleFits(rule: Place & { acts: readonly BehaviourAct[] }, account: Target): void {
  const acting = Object.hasOwn(ACTING, account.platform) ? ACTING[account.platform] : undefined;
  if (acting === undefined) {
    throw new CommsError(
      'USAGE',
      `${account.name} sends nothing through these tools, so there is nothing for a rule to allow there`,
    );
  }
  const wrong = rule.acts.filter((act) => !acting.acts.includes(act));
  if (wrong.length > 0) {
    throw new CommsError('USAGE', `${account.name} does not ${wrong.join(' or ')}`, {
      hint: `Its acts are: ${acting.acts.join(', ')}.`,
    });
  }
  if (rule.conversation === undefined) return;
  if (acting.conversation === 'slack' && !SLACK_CONVERSATION_PATTERN.test(rule.conversation)) {
    throw new CommsError('USAGE', `${JSON.stringify(rule.conversation)} is not a Slack conversation`, {
      hint: 'Give a channel or DM id (C…, G…, D…), or a person (U…) for your DMs with them — as Slack shows it, not a name.',
    });
  }
  if (acting.conversation === 'mail' && !MAIL_CONVERSATION_PATTERN.test(rule.conversation)) {
    throw new CommsError('USAGE', `${JSON.stringify(rule.conversation)} is not an address or @domain`, {
      hint: 'Give an address, or @domain for everyone there: a message with any recipient there is held to it.',
    });
  }
  if (acting.conversation === 'mail' && normaliseMailConversation(rule.conversation) === null) {
    throw new CommsError('USAGE', `the domain of ${JSON.stringify(rule.conversation)} is not one`, {
      hint: 'Give the domain as it is written in an address — in Unicode or in its xn-- form, either is the same domain.',
    });
  }
}

/** A place in words: `acme/slack`, or `acme/slack in C0GENERAL`. */
function placeText(place: Place): string {
  return place.conversation === undefined ? place.account : `${place.account} in ${place.conversation}`;
}

/** A rule in words: `acme/slack in C0GENERAL: reply, reaction`, or `…: nothing`. */
function ruleText(rule: Place & { acts: readonly BehaviourAct[] }): string {
  return `${placeText(rule)}: ${rule.acts.length === 0 ? 'nothing' : rule.acts.join(', ')}`;
}

// ── What a person reads ────────────────────────────────────────────────────────────────────────────────────────────

/** Whether no account connected now holds `rule` as its own: not its id, or — a rule with none — not its name. */
function isOrphan(rule: BehaviourRule, held: ReadonlySet<string>, names: ReadonlySet<string>): boolean {
  return rule.accountId !== undefined ? !held.has(rule.accountId) : !names.has(rule.account);
}

/**
 * The rules whose account is not connected now, each of which still holds by name (B3): a restriction applied more
 * widely is safe. For the report and the doctor, which list them.
 */
export function orphanedBehaviourRules(config: Config): BehaviourRule[] {
  const held = heldIds(config);
  const names = new Set(behaviourAccountsOf(config).map((account) => account.account));
  return readBehaviourSettings(config).rules.filter((rule) => isOrphan(rule, held, names));
}

function reportOf(config: Config): BehaviourReport {
  const settings = readBehaviourSettings(config);
  const held = heldIds(config);
  const names = new Set(behaviourAccountsOf(config).map((account) => account.account));
  const accounts = connectedAccounts(config)
    .filter((account) => Object.hasOwn(ACTING, account.platform))
    .map((account): BehaviourAccountView => {
      const query = { accountId: account.id, account: account.alias, acts: [] as BehaviourAct[] };
      const conversations = [
        ...new Set(
          settings.rules
            .filter(
              (rule) => rule.conversation !== undefined && holds(rule, held, { id: account.id, name: account.alias }),
            )
            .map((rule) => rule.conversation as string),
        ),
      ].sort();
      return {
        account: account.alias,
        allowed: allowedAct(config, { ...query, places: [] }).allowedActs,
        conversations: conversations.map((conversation) => ({
          conversation,
          allowed: allowedAct(config, { ...query, places: [[conversation]] }).allowedActs,
        })),
      };
    });
  return {
    rules: settings.rules.map((rule) => ({
      account: rule.account,
      ...(rule.conversation === undefined ? {} : { conversation: rule.conversation }),
      acts: [...rule.acts],
      orphan: isOrphan(rule, held, names),
    })),
    unreadable: settings.unreadable,
    accounts,
  };
}
