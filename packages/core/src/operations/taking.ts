import type { GatedChange } from '../change-flow.ts';
import type { ChangeRequest, ChangeSurface } from '../changes.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { canonicalJson } from '../digest.ts';
import { CommsError } from '../errors.ts';
import { formerNameRefusal } from '../names.ts';
import {
  isTakingAcknowledgement,
  isUnclaimedMinutes,
  MAX_UNCLAIMED_MINUTES,
  MIN_UNCLAIMED_MINUTES,
  readTakingSettings,
  storedTakingEntries,
  type TakingAccountSettings,
  type TakingAcknowledgement,
  type TakingChannel,
  takingAccountsOf,
} from '../taking.ts';

/**
 * Taking messages, the settings (design 2026-10-26-taking-messages §5): `agentcomms taking` and `comms_taking`, one
 * operation each way — `takingReport` shows, `takingChange` changes.
 *
 * Showing asks nobody. A change goes through the one change flow (`gatedChange`), judged by `classifyChange`: letting
 * sessions act without taking a message first, and a 👀 on taking, wait for the person's yes — under the change policy,
 * and in the app through `--app-approval`; requiring a take, saying nothing, and when a message nobody took is reminded
 * of apply at once. One change at a time, as the activity settings and the behaviour rules take them.
 *
 * Written so that nothing a change is not about moves: the account's entry is replaced by one with the settings in
 * force for it now and the one field changed, and every other entry stays exactly as it was.
 */

/** One account's settings, as `taking` shows them. */
export interface TakingAccountView {
  readonly account: string;
  readonly channel: TakingChannel;
  readonly required: boolean;
  readonly acknowledge: TakingAcknowledgement;
  readonly unclaimed: { readonly afterMinutes: number; readonly notify: boolean };
  /** False when nothing is set for it, and these are the defaults. */
  readonly stored: boolean;
}

export interface TakingReport {
  readonly accounts: TakingAccountView[];
  /** Values in `config.json` read as something stricter, each in a sentence; empty when every value was read. */
  readonly problems: readonly string[];
}

/** One change: `agentcomms taking acme/slack --require on` is `{ account: 'acme/slack', required: true }`. */
export interface TakingChangeRequest {
  readonly account: string;
  readonly required?: boolean | undefined;
  readonly acknowledge?: TakingAcknowledgement | undefined;
  readonly afterMinutes?: number | undefined;
  readonly notify?: boolean | undefined;
}

export type TakingChangeKind = 'required' | 'acknowledge' | 'afterMinutes' | 'notify';
export const TAKING_CHANGE_KINDS: readonly TakingChangeKind[] = Object.freeze([
  'required',
  'acknowledge',
  'afterMinutes',
  'notify',
]);

export interface TakingChangeResult extends TakingReport {
  readonly change: TakingChangeKind;
  /** False when the settings already said this, and nothing was written. */
  readonly changed: boolean;
  /** What else to know: for a 👀, that it is made only under a standing approval — and not yet by this release. */
  readonly note: string | null;
}

function viewOf(account: TakingAccountSettings): TakingAccountView {
  return {
    account: account.account,
    channel: account.channel,
    required: account.required,
    acknowledge: account.acknowledge,
    unclaimed: { ...account.unclaimed },
    stored: account.stored,
  };
}

function reportOf(config: Config, only?: string): TakingReport {
  const settings = readTakingSettings(config);
  return {
    accounts: settings.accounts.filter((account) => only === undefined || account.accountId === only).map(viewOf),
    problems: [...settings.problems],
  };
}

/** The account a request names, connected now and one that takes messages; a former name is refused with its new one. */
function takingAccount(config: Config, name: string): { id: string; account: string; channel: TakingChannel } {
  if (typeof name !== 'string' || name === '') {
    throw new CommsError('USAGE', 'name the account: organisation/platform');
  }
  const found = takingAccountsOf(config).find((account) => account.account === name);
  if (found !== undefined) return found;
  const renamed = formerNameRefusal(config, 'account', name) ?? formerNameRefusal(config, 'inbox', name);
  if (renamed) throw renamed;
  const known = takingAccountsOf(config).map((account) => account.account);
  const connected = [...Object.keys(config.inboxes ?? {}), ...Object.keys(config.accounts ?? {})];
  if (connected.includes(name)) {
    throw new CommsError(
      'USAGE',
      `${name} sends nothing through these tools, so there is no message for a session to take there`,
      {
        hint: 'Taking messages is for Gmail mailboxes and Slack and Resend accounts.',
      },
    );
  }
  throw new CommsError('NOT_FOUND', `no mailbox or account is called "${name}"`, {
    hint:
      known.length > 0
        ? `Those that take messages are: ${known.join(', ')}.`
        : 'Nothing that takes messages is connected yet.',
  });
}

/** Every account's settings, or one's: whether a take is required, what a take says, when a message nobody took counts. */
export async function takingReport(
  core: Core,
  request: { readonly account?: string | undefined } = {},
): Promise<TakingReport> {
  const config = await core.config.load();
  if (request.account === undefined) return reportOf(config);
  return reportOf(config, takingAccount(config, request.account).id);
}

interface CheckedChange {
  readonly account: string;
  readonly kind: TakingChangeKind;
  readonly value: boolean | TakingAcknowledgement | number;
}

function checkedRequest(request: TakingChangeRequest): CheckedChange {
  const given = TAKING_CHANGE_KINDS.filter(
    (kind) =>
      typeof request === 'object' &&
      request !== null &&
      (request as unknown as Record<string, unknown>)[kind] !== undefined,
  );
  if (given.length !== 1) {
    throw new CommsError(
      'USAGE',
      given.length === 0
        ? 'name the change: whether a take is required, what a take says, or when a message nobody took counts'
        : `one change at a time: this asks for ${given.join(' and ')}`,
      { hint: 'Each change is shown, and approved when it loosens, on its own.' },
    );
  }
  const [kind] = given as [TakingChangeKind];
  const value = request[kind];
  if ((kind === 'required' || kind === 'notify') && typeof value !== 'boolean') {
    throw new CommsError('USAGE', `${kind === 'required' ? 'required' : 'notify'} is on or off`);
  }
  if (kind === 'acknowledge' && !isTakingAcknowledgement(value)) {
    throw new CommsError('USAGE', `what a take says is eyes or nothing, not "${String(value).slice(0, 40)}"`);
  }
  if (kind === 'afterMinutes' && !isUnclaimedMinutes(value)) {
    throw new CommsError(
      'USAGE',
      `a message nobody took counts after a whole number of minutes, ${MIN_UNCLAIMED_MINUTES} to ${MAX_UNCLAIMED_MINUTES}, not ${String(value).slice(0, 40)}`,
    );
  }
  return { account: request.account, kind, value: value as CheckedChange['value'] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summaryOf(change: CheckedChange, account: string): string {
  switch (change.kind) {
    case 'required':
      return change.value
        ? `In ${account}, a session must take a message before it acts on it`
        : `Let sessions act on messages in ${account} without taking them first: two sessions could then answer the same message`;
    case 'acknowledge':
      return change.value === 'eyes'
        ? `When a session takes a message in ${account}, say so to its sender with 👀 — only under a standing approval you made at your terminal`
        : `When a session takes a message in ${account}, say nothing to its sender`;
    case 'afterMinutes':
      return `In ${account}, a message nobody takes within ${change.value} minutes counts as not taken`;
    default:
      return change.value
        ? `In ${account}, remind me of a message nobody takes`
        : `In ${account}, do not remind me of a message nobody takes: it waits under Not taken`;
  }
}

/**
 * `config` with the account's entry replaced: the settings in force for it now (`readTakingSettings`, so a value read
 * as stricter is written as that), with the one field changed. Every entry that applied to it — by its id, or by its
 * name with an id no account holds — goes; every other entry stays as it is.
 */
function withEntry(config: Config, target: { id: string; account: string }, change: CheckedChange): Config {
  const entries = storedTakingEntries(config);
  if (entries === null) {
    throw new CommsError('CONFIG', 'taking in config.json cannot be read by this release', {
      hint: 'Until it can, every account must take a message first. Update agent-communications, or correct taking in config.json.',
    });
  }
  const held = new Set(takingAccountsOf(config).map((account) => account.id));
  const current = readTakingSettings(config).accounts.find((account) => account.accountId === target.id);
  if (current === undefined) throw new CommsError('UNEXPECTED', `${target.account} takes no messages`);
  const unclaimed = {
    afterMinutes: change.kind === 'afterMinutes' ? (change.value as number) : current.unclaimed.afterMinutes,
    notify: change.kind === 'notify' ? (change.value as boolean) : current.unclaimed.notify,
  };
  const entry = {
    accountId: target.id,
    account: target.account,
    required: change.kind === 'required' ? (change.value as boolean) : current.required,
    acknowledge: change.kind === 'acknowledge' ? (change.value as TakingAcknowledgement) : current.acknowledge,
    unclaimed,
  };
  const kept = entries.filter((raw) => {
    if (!isRecord(raw)) return true;
    if (raw.accountId === target.id) return false;
    const orphan = typeof raw.accountId !== 'string' || !held.has(raw.accountId);
    return !(orphan && raw.account === target.account);
  });
  const raw = config.taking;
  const block = isRecord(raw) ? { ...raw } : {};
  return { ...structuredClone(config), taking: { ...block, accounts: [...kept, entry] } };
}

/**
 * One change to one account's settings, as a change the flow asks for or applies: see the top of this file. A 👀 on an
 * account that is not Slack's is refused: a take of an email says nothing to its sender (§7).
 */
export function takingChange(
  core: Core,
  request: TakingChangeRequest,
  surface: ChangeSurface,
): GatedChange<TakingChangeResult> {
  const change = checkedRequest(request);
  let target: { id: string; account: string; channel: TakingChannel } | null = null;
  return {
    plan: (config) => {
      target = takingAccount(config, change.account);
      if (change.kind === 'acknowledge' && change.value === 'eyes' && target.channel !== 'slack') {
        throw new CommsError('USAGE', `${target.account} has no 👀: a take of an email says nothing to its sender`, {
          hint: 'A 👀 on taking is for Slack accounts, under a standing approval the person made there.',
        });
      }
      const after = withEntry(config, target, change);
      const same =
        canonicalJson(storedTakingEntries(config) ?? null) === canonicalJson(storedTakingEntries(after) ?? null);
      return {
        ...(target.channel === 'gmail' ? { inbox: target.account } : { account: target.account }),
        before: config,
        after: same ? config : after,
        summary: summaryOf(change, target.account),
      } satisfies ChangeRequest;
    },
    apply: async (consent, planned) => {
      const named = target;
      if (named === null)
        throw new CommsError('UNEXPECTED', 'the taking settings were changed before they were planned');
      const note =
        change.kind === 'acknowledge' && change.value === 'eyes'
          ? 'The 👀 is made only under a standing approval you made at your terminal, and not yet by this release: it records your choice.'
          : null;
      if (planned.after === planned.before) {
        return { change: change.kind, changed: false, note, ...reportOf(await core.config.load(), named.id) };
      }
      const written = await core.config.update(
        (config) => {
          // Made again from the configuration read inside the store's lock: whatever else moved meanwhile stays.
          const again = takingAccount(config, change.account);
          if (again.id !== named.id) {
            throw new CommsError(
              'LOOSENING_REFUSED',
              `this is not the change that was approved: ${named.account} is another account now`,
              {
                hint: 'The configuration changed after the approval was given. Nothing was written. Prepare the change again and ask again.',
                details: { paths: ['taking.accounts'] },
              },
            );
          }
          return withEntry(config, again, change);
        },
        { ...(consent ? { consent } : {}) },
      );
      await core.audit.append({
        inboxId: named.id,
        alias: named.account,
        operation: `taking.${change.kind}`,
        outcome: 'ok',
        surface,
        reason: String(change.value),
      });
      return { change: change.kind, changed: true, note, ...reportOf(written, named.id) };
    },
  };
}
