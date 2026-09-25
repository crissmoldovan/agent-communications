import type { GatedChange } from '../change-flow.ts';
import {
  type AccountConfig,
  type ChangePolicy,
  type Config,
  defaultChangePolicy,
  type InboxConfig,
} from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { resolveName } from '../names.ts';

/**
 * The change policy — how a loosening is approved: `chat`, a yes in the conversation, or `confirm`, a code typed at
 * a terminal — reported and set: `agentcomms policy` and `comms_change_policy`, one operation.
 *
 * It is a safety setting itself (design §3.3). Tightening, `chat → confirm`, is applied at once. Loosening,
 * `confirm → chat`, is a change like any other, and the policy that decides how it is approved is the one in force
 * before it — `confirm` — so it always needs a code typed at a terminal, whichever surface asked. `classifyChange`
 * and `governingChangePolicy` already say both; this only builds the change they judge.
 */

export const CHANGE_POLICIES: readonly ChangePolicy[] = Object.freeze(['chat', 'confirm']);

/** Which policy: the default for the whole configuration, or one mailbox's or one workspace's own. */
export interface PolicyScope {
  inbox?: string | undefined;
  account?: string | undefined;
}

export interface PolicyOverride {
  kind: 'inbox' | 'account';
  name: string;
  changePolicy: ChangePolicy;
}

/** A mailbox or workspace that sets `chat` itself under a `confirm` default, and how to tighten it from either surface. */
export interface LooserOverride extends PolicyOverride {
  changePolicy: 'chat';
  tighten: {
    /** At a terminal. */
    command: string;
    /** From a chat: this tool, with these arguments. */
    tool: 'comms_change_policy';
    arguments: { inbox?: string; account?: string; set: 'confirm' };
  };
}

export interface ChangePolicyReport {
  scope: 'defaults' | 'inbox' | 'account';
  /** The mailbox or workspace, by the name it has now; null for the defaults. */
  name: string | null;
  /** The policy in force for this scope. */
  changePolicy: ChangePolicy;
  /** What this scope sets itself, or null when it takes the default — and, for the defaults, when none is set. */
  setHere: ChangePolicy | null;
  /** For the defaults: every mailbox and workspace that sets its own, since a default says nothing about those. */
  overrides?: PolicyOverride[];
  /**
   * For the defaults under `confirm`: every mailbox and workspace that still sets `chat` itself, with how to tighten
   * it. Absent when there is none.
   *
   * Setting `chat` on one of them under a `chat` default loosens nothing, so it asks nobody (design §3.3) — and it
   * outlives the default being tightened, since a default never overrides what an account sets. Listed as one more
   * override, it read as settled. Named here, with the command and the call, so the person tightening the default
   * sees what their `confirm` does not cover.
   */
  looser?: LooserOverride[];
  /** The same, as a sentence for the person. Absent when `looser` is. */
  warning?: string;
}

export function isChangePolicy(value: unknown): value is ChangePolicy {
  return typeof value === 'string' && (CHANGE_POLICIES as readonly string[]).includes(value);
}

/**
 * The scope named, by its current name, with the entry it names in `config`; a former name is refused with the one
 * it has now. Through `resolveName`, the one place a name is looked up, so an old name is never read as "not there".
 */
function resolveScope(
  config: Config,
  scope: PolicyScope,
): { kind: 'inbox' | 'account'; name: string; entry: InboxConfig | AccountConfig } | null {
  if (scope.inbox !== undefined && scope.account !== undefined) {
    throw new CommsError('USAGE', 'name one mailbox or one workspace, not both');
  }
  if (scope.inbox !== undefined) {
    return { kind: 'inbox', name: scope.inbox, entry: resolveName(config, 'inbox', scope.inbox).inbox };
  }
  if (scope.account !== undefined) {
    return { kind: 'account', name: scope.account, entry: resolveName(config, 'account', scope.account).account };
  }
  return null;
}

export function changePolicyReport(config: Config, scope: PolicyScope = {}): ChangePolicyReport {
  const target = resolveScope(config, scope);
  if (target === null) {
    const overrides: PolicyOverride[] = [
      ...Object.entries(config.inboxes).flatMap(([name, inbox]) =>
        inbox.changePolicy ? [{ kind: 'inbox' as const, name, changePolicy: inbox.changePolicy }] : [],
      ),
      ...Object.entries(config.accounts).flatMap(([name, account]) =>
        account.changePolicy ? [{ kind: 'account' as const, name, changePolicy: account.changePolicy }] : [],
      ),
    ];
    const changePolicy = defaultChangePolicy(config);
    const looser = changePolicy === 'confirm' ? overrides.flatMap(stillChat) : [];
    return {
      scope: 'defaults',
      name: null,
      changePolicy,
      setHere: config.defaults.changePolicy ?? null,
      overrides,
      ...(looser.length > 0 ? { looser, warning: looserWarning(looser) } : {}),
    };
  }
  const own = target.entry.changePolicy ?? null;
  return {
    scope: target.kind,
    name: target.name,
    changePolicy: own ?? defaultChangePolicy(config),
    setHere: own,
  };
}

/** An override that approves in chat, with how to tighten it; nothing for one that does not. */
function stillChat(override: PolicyOverride): LooserOverride[] {
  if (override.changePolicy !== 'chat') return [];
  // Names are held to a grammar of letters, digits, `-` and `/`, so they go into a command line as they are.
  const flag = override.kind === 'inbox' ? '--inbox' : '--account';
  return [
    {
      kind: override.kind,
      name: override.name,
      changePolicy: 'chat',
      tighten: {
        command: `agentcomms policy ${flag} ${override.name} confirm`,
        tool: 'comms_change_policy',
        arguments:
          override.kind === 'inbox'
            ? { inbox: override.name, set: 'confirm' }
            : { account: override.name, set: 'confirm' },
      },
    },
  ];
}

function looserWarning(looser: readonly LooserOverride[]): string {
  const named = looser.map((entry) => `${entry.kind === 'inbox' ? 'mailbox' : 'workspace'} ${entry.name}`);
  return looser.length === 1
    ? `The default is confirm, but ${named[0]} still approves a loosening with a yes in the chat: it sets chat itself, and a default never overrides that.`
    : `The default is confirm, but ${looser.length} still approve a loosening with a yes in the chat — ${named.join(', ')}: each sets chat itself, and a default never overrides that.`;
}

/**
 * An approval id with nothing to set is refused rather than ignored: a caller who passed one believed a change was
 * being applied, and a report in reply would read as though it had been.
 */
export function refuseApprovalWithoutChange(approvalId: string | undefined): void {
  if (approvalId !== undefined) {
    throw new CommsError('USAGE', 'an approval goes with a policy to set; without one this only reports', {
      hint: 'Pass the policy the approval was prepared for — `chat` or `confirm` — with it.',
    });
  }
}

/** `config` with the change policy of `scope` set to `to`, and nothing else touched. */
function withPolicy(config: Config, scope: PolicyScope, to: ChangePolicy): Config {
  const next = structuredClone(config);
  // Resolved in the copy, so the entry changed is the copy's own.
  const target = resolveScope(next, scope);
  if (target === null) next.defaults.changePolicy = to;
  else target.entry.changePolicy = to;
  return next;
}

/**
 * Setting the policy of `scope` to `to`, as a change.
 *
 * Its own write is made through `ConfigStore.update` with whatever consent the flow hands over, and is computed from
 * the configuration read inside that lock — so the refusal a loosening meets there, without an approval or with one
 * for a different change, is the store's, not this function's.
 */
export function changePolicyChange(core: Core, scope: PolicyScope, to: ChangePolicy): GatedChange<ChangePolicyReport> {
  if (!isChangePolicy(to)) {
    throw new CommsError('USAGE', `"${String(to)}" is not a change policy`, { hint: 'Use `chat` or `confirm`.' });
  }
  return {
    plan: (config) => {
      const before = changePolicyReport(config, scope);
      const where = before.name === null ? 'the default change policy' : `the change policy of ${before.name}`;
      return {
        ...(before.scope === 'inbox' ? { inbox: before.name ?? undefined } : {}),
        ...(before.scope === 'account' ? { account: before.name ?? undefined } : {}),
        before: config,
        after: withPolicy(config, scope, to),
        summary: `Set ${where} to ${to}${to === 'chat' ? ': a yes in the chat will approve a loosening' : ''}`,
      };
    },
    apply: async (consent) => {
      const written = await core.config.update((config) => withPolicy(config, scope, to), consent ? { consent } : {});
      return changePolicyReport(written, scope);
    },
  };
}
