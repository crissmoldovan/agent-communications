/**
 * Taking messages, the settings (design 2026-10-26-taking-messages, §4 and §5): for each Gmail mailbox and each Slack
 * and Resend account, whether a session must take a message before it acts on it, whether a take says so to the sender
 * with 👀, and when a message nobody has taken is reminded of.
 *
 * `config.json` keeps them as `taking: { accounts: [ { accountId, account, required, acknowledge, unclaimed } ] }`, a
 * key the schemas do not name, so every release sharing the file keeps it through its writes, as it keeps `behaviour`.
 * An entry is bound to its account by id, as a behaviour rule is, and follows a rename.
 *
 * Read only through `readTakingSettings`, which fails closed (as behaviour B3 does): a value this release cannot read
 * counts as the stricter one — `required: true`, `acknowledge: 'nothing'`, the soonest reminder, a reminder on — and
 * `doctor` says so. So a hand edit or a later release's word can only make this release demand more.
 *
 * Four changes loosen, and a person approves them (`classifyChange`): `required` from true to false, `acknowledge` from
 * `nothing` to `eyes`, a longer `unclaimed.afterMinutes`, and `unclaimed.notify` from true to false — the last two let a
 * message nobody took go unnoticed for longer, or for good, so an agent cannot quiet the person's oversight at once
 * (security review of 0.35.0). Everything else applies at once — `required` on, `acknowledge: 'nothing'`, a shorter
 * wait, and a reminder on.
 *
 * `config.ts` imports this module to judge a change, so this one imports from it only types.
 */
import type { Config } from './config.ts';

/** The channels whose accounts take messages: WhatsApp sends nothing, so there is no act to gate (T11). */
export const TAKING_CHANNELS: readonly ['gmail', 'slack', 'resend'] = Object.freeze([
  'gmail',
  'slack',
  'resend',
] as const);
export type TakingChannel = (typeof TAKING_CHANNELS)[number];

/** What a take says to the sender: a 👀 under a Slack message (§7), or nothing. Mail says nothing. */
export const TAKING_ACKNOWLEDGEMENTS: readonly ['eyes', 'nothing'] = Object.freeze(['eyes', 'nothing'] as const);
export type TakingAcknowledgement = (typeof TAKING_ACKNOWLEDGEMENTS)[number];

/** How long a message may wait with nobody taking it before the person is reminded, in minutes (§4). */
export const MIN_UNCLAIMED_MINUTES = 5;
export const MAX_UNCLAIMED_MINUTES = 240;
export const DEFAULT_UNCLAIMED_MINUTES = 15;

/** One account's settings, as they apply. */
export interface TakingSetting {
  /** A session must take a message before it acts on it (§6). Off by default: nothing changes until it is turned on. */
  readonly required: boolean;
  readonly acknowledge: TakingAcknowledgement;
  /** A message nobody took within `afterMinutes`: the person is reminded (`notify`), or it only waits under Not taken. */
  readonly unclaimed: { readonly afterMinutes: number; readonly notify: boolean };
}

/** Every account's settings until the person changes them: today's behaviour, with a reminder after 15 minutes. */
export const DEFAULT_TAKING: TakingSetting = Object.freeze({
  required: false,
  acknowledge: 'nothing' as const,
  unclaimed: Object.freeze({ afterMinutes: DEFAULT_UNCLAIMED_MINUTES, notify: true }),
});

/** What an account's settings are read as when they cannot be read: every stricter value (B3's rule, here). */
const FAIL_CLOSED: TakingSetting = Object.freeze({
  required: true,
  acknowledge: 'nothing' as const,
  unclaimed: Object.freeze({ afterMinutes: MIN_UNCLAIMED_MINUTES, notify: true }),
});

/** An account that takes messages: its id, its name and its channel. */
export interface TakingAccount {
  readonly id: string;
  readonly account: string;
  readonly channel: TakingChannel;
}

/** One account's settings as `readTakingSettings` read them, and whether the file says anything of it. */
export interface TakingAccountSettings extends TakingSetting {
  readonly accountId: string;
  readonly account: string;
  readonly channel: TakingChannel;
  /** False for an account the file says nothing of: its settings are the defaults. */
  readonly stored: boolean;
}

export interface TakingSettings {
  /** Every connected account that takes messages, by name. */
  readonly accounts: readonly TakingAccountSettings[];
  /** One sentence for each value read as something stricter than the file says — for `doctor` to show. */
  readonly problems: readonly string[];
}

export function isTakingAcknowledgement(value: unknown): value is TakingAcknowledgement {
  return value === 'eyes' || value === 'nothing';
}

export function isUnclaimedMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_UNCLAIMED_MINUTES &&
    value <= MAX_UNCLAIMED_MINUTES
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every connected account that takes messages: each Gmail mailbox, and each Slack and Resend account, by name. */
export function takingAccountsOf(config: Pick<Config, 'inboxes' | 'accounts'>): TakingAccount[] {
  const mail = Object.entries(config.inboxes ?? {})
    .filter(([, inbox]) => inbox.provider === 'gmail')
    .map(([account, inbox]) => ({ id: inbox.id, account, channel: 'gmail' as const }));
  const others = Object.entries(config.accounts ?? {}).flatMap(([account, entry]) =>
    entry.platform === 'slack' || entry.platform === 'resend'
      ? [{ id: entry.id, account, channel: entry.platform as TakingChannel }]
      : [],
  );
  return [...mail, ...others].sort((a, b) => a.account.localeCompare(b.account));
}

/** The `taking` block's entries as the file holds them, raw — or null when the block cannot be read as a list. */
export function storedTakingEntries(config: { readonly taking?: unknown }): unknown[] | null {
  const raw = config.taking;
  if (raw === undefined) return [];
  if (!isRecord(raw)) return null;
  const accounts = raw.accounts;
  if (accounts === undefined) return [];
  return Array.isArray(accounts) ? [...accounts] : null;
}

/** A stored value in a sentence: short, and never more than a few dozen characters of whatever the file held. */
function describe(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value) ?? value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** An entry's own name for its account, made safe to put in a sentence. */
function nameOf(entry: Record<string, unknown>): string {
  return typeof entry.account === 'string' ? describe(entry.account) : 'an account';
}

interface ReadEntry {
  readonly setting: TakingSetting;
  /** True when the entry's account is not connected now, and it applies by its name (`readTakingSettings`). */
  readonly orphan: boolean;
}

/**
 * One stored entry as it applies, each field failing closed on its own. An `eyes` on an account that is not Slack's is
 * read as nothing: a standing approval covers Slack only (§7), so mail has no 👀 to say.
 */
function readEntry(entry: Record<string, unknown>, channel: TakingChannel, problems: string[]): TakingSetting {
  let required = DEFAULT_TAKING.required;
  if (entry.required !== undefined) {
    if (typeof entry.required === 'boolean') required = entry.required;
    else {
      required = true;
      problems.push(
        `taking for ${nameOf(entry)}: required is ${describe(entry.required)}, not true or false, so a session must take a message first`,
      );
    }
  }
  let acknowledge: TakingAcknowledgement = DEFAULT_TAKING.acknowledge;
  if (entry.acknowledge !== undefined) {
    if (isTakingAcknowledgement(entry.acknowledge)) acknowledge = entry.acknowledge;
    else {
      problems.push(
        `taking for ${nameOf(entry)}: acknowledge is ${describe(entry.acknowledge)}, not eyes or nothing, so a take says nothing`,
      );
    }
  }
  if (channel !== 'slack') acknowledge = 'nothing';
  let afterMinutes = DEFAULT_TAKING.unclaimed.afterMinutes;
  let notify = DEFAULT_TAKING.unclaimed.notify;
  const unclaimed = entry.unclaimed;
  if (unclaimed !== undefined) {
    if (!isRecord(unclaimed)) {
      afterMinutes = MIN_UNCLAIMED_MINUTES;
      problems.push(
        `taking for ${nameOf(entry)}: unclaimed is ${describe(unclaimed)}, not an object, so a message nobody took is reminded of after ${MIN_UNCLAIMED_MINUTES} minutes`,
      );
    } else {
      if (unclaimed.afterMinutes !== undefined) {
        if (isUnclaimedMinutes(unclaimed.afterMinutes)) afterMinutes = unclaimed.afterMinutes;
        else {
          afterMinutes = MIN_UNCLAIMED_MINUTES;
          problems.push(
            `taking for ${nameOf(entry)}: unclaimed.afterMinutes is ${describe(unclaimed.afterMinutes)}, not a whole number from ${MIN_UNCLAIMED_MINUTES} to ${MAX_UNCLAIMED_MINUTES}, so ${MIN_UNCLAIMED_MINUTES} minutes`,
          );
        }
      }
      if (unclaimed.notify !== undefined) {
        if (typeof unclaimed.notify === 'boolean') notify = unclaimed.notify;
        else {
          problems.push(
            `taking for ${nameOf(entry)}: unclaimed.notify is ${describe(unclaimed.notify)}, not true or false, so the person is reminded`,
          );
        }
      }
    }
  }
  return { required, acknowledge, unclaimed: { afterMinutes, notify } };
}

/** Two entries for one account, held to what both demand: either's `required`, `eyes` only where both say it. */
function stricter(a: TakingSetting, b: TakingSetting): TakingSetting {
  return {
    required: a.required || b.required,
    acknowledge: a.acknowledge === 'eyes' && b.acknowledge === 'eyes' ? 'eyes' : 'nothing',
    unclaimed: {
      afterMinutes: Math.min(a.unclaimed.afterMinutes, b.unclaimed.afterMinutes),
      notify: a.unclaimed.notify || b.unclaimed.notify,
    },
  };
}

/**
 * The settings in force for every connected account that takes messages, failing closed:
 * - no `taking`, or an account it says nothing of: the defaults;
 * - a block that is not an object, or whose `accounts` is not a list, or an entry that is not an object: every account
 *   held to the stricter values — it may have been about any of them;
 * - an entry is its account's by id; one whose id no account holds now applies by its name, and then only its
 *   `required: true` — a restriction held more widely is safe, a 👀 is not carried to an account nobody chose it for;
 * - a field this release cannot read is the stricter value, and named in `problems`.
 *
 * Never throws: `classifyChange` reads it for every write of the configuration.
 */
export function readTakingSettings(
  config: Pick<Config, 'inboxes' | 'accounts'> & { readonly taking?: unknown },
): TakingSettings {
  const problems: string[] = [];
  const accounts = takingAccountsOf(config);
  const entries = storedTakingEntries(config);
  if (entries === null) {
    problems.push('taking in config.json is not { accounts: [ … ] }, so every account must take a message first');
    return {
      accounts: accounts.map((account) => ({ ...account, accountId: account.id, ...FAIL_CLOSED, stored: true })),
      problems,
    };
  }
  const held = new Map(accounts.map((account) => [account.id, account]));
  const byName = new Map(accounts.map((account) => [account.account, account]));
  const found = new Map<string, ReadEntry>();
  let wholeUnreadable = false;
  const add = (id: string, read: ReadEntry) => {
    const before = found.get(id);
    if (before === undefined) found.set(id, read);
    else found.set(id, { setting: stricter(before.setting, read.setting), orphan: before.orphan && read.orphan });
  };
  for (const raw of entries) {
    if (!isRecord(raw)) {
      wholeUnreadable = true;
      problems.push(
        `an entry in taking.accounts is ${describe(raw)}, not an object, so every account must take a message first`,
      );
      continue;
    }
    const byId = typeof raw.accountId === 'string' ? held.get(raw.accountId) : undefined;
    if (byId !== undefined) {
      add(byId.id, { setting: readEntry(raw, byId.channel, problems), orphan: false });
      continue;
    }
    const named = typeof raw.account === 'string' ? byName.get(raw.account) : undefined;
    if (named === undefined) continue;
    // Its account is gone, or it names none by id: by name, and only what it demands (see above).
    const read = readEntry(raw, named.channel, problems);
    add(named.id, {
      setting: { ...DEFAULT_TAKING, required: read.required },
      orphan: true,
    });
  }
  return {
    accounts: accounts.map((account) => {
      const read = found.get(account.id);
      const setting = wholeUnreadable
        ? read === undefined
          ? FAIL_CLOSED
          : stricter(read.setting, FAIL_CLOSED)
        : (read?.setting ?? DEFAULT_TAKING);
      return {
        accountId: account.id,
        account: account.account,
        channel: account.channel,
        required: setting.required,
        acknowledge: setting.acknowledge,
        unclaimed: { ...setting.unclaimed },
        stored: wholeUnreadable || read !== undefined,
      };
    }),
    problems,
  };
}

/**
 * One account's settings, by its id, as every gate asks them: the account's, or — for an id no account that takes
 * messages holds — the defaults. Never throws.
 */
export function takingFor(
  config: Pick<Config, 'inboxes' | 'accounts'> & { readonly taking?: unknown },
  accountId: string,
): TakingSetting {
  const found = readTakingSettings(config).accounts.find((account) => account.accountId === accountId);
  return found ?? DEFAULT_TAKING;
}

/**
 * How long a delivery's offer waits for its window to be handed it in an account, in milliseconds (security review of
 * 0.35.0, M5): the account's reminder window, `unclaimed.afterMinutes`, as it applies. An offer its window was never
 * handed lapses then, and the message counts as not taken. Never throws.
 */
export function offerWaitMs(
  config: Pick<Config, 'inboxes' | 'accounts'> & { readonly taking?: unknown },
  accountId: string,
): number {
  return takingFor(config, accountId).unclaimed.afterMinutes * 60_000;
}

/** One loosening a change to the settings makes: its path, by the account's name, the values, and the account's id. */
export interface TakingLoosening {
  readonly path: string;
  readonly was: boolean | TakingAcknowledgement | number;
  readonly now: boolean | TakingAcknowledgement | number;
  readonly id: string;
}

/**
 * The loosenings a change from `before` to `after` makes, judged per account by its id, by the settings in force on
 * each side: `required` from true to false, `acknowledge` from `nothing` to `eyes`, a longer `unclaimed.afterMinutes`,
 * and `unclaimed.notify` from true to false. An account new in `after` is judged against the defaults.
 */
export function classifyTakingChange(
  before: Pick<Config, 'inboxes' | 'accounts'> & { readonly taking?: unknown },
  after: Pick<Config, 'inboxes' | 'accounts'> & { readonly taking?: unknown },
): TakingLoosening[] {
  const was = new Map(readTakingSettings(before).accounts.map((account) => [account.accountId, account]));
  const loosenings: TakingLoosening[] = [];
  for (const now of readTakingSettings(after).accounts) {
    const then: TakingSetting = was.get(now.accountId) ?? DEFAULT_TAKING;
    if (then.required && !now.required) {
      loosenings.push({ path: `taking.${now.account}.required`, was: true, now: false, id: now.accountId });
    }
    if (then.acknowledge === 'nothing' && now.acknowledge === 'eyes') {
      loosenings.push({ path: `taking.${now.account}.acknowledge`, was: 'nothing', now: 'eyes', id: now.accountId });
    }
    if (now.unclaimed.afterMinutes > then.unclaimed.afterMinutes) {
      loosenings.push({
        path: `taking.${now.account}.unclaimed.afterMinutes`,
        was: then.unclaimed.afterMinutes,
        now: now.unclaimed.afterMinutes,
        id: now.accountId,
      });
    }
    if (then.unclaimed.notify && !now.unclaimed.notify) {
      loosenings.push({ path: `taking.${now.account}.unclaimed.notify`, was: true, now: false, id: now.accountId });
    }
  }
  return loosenings;
}
