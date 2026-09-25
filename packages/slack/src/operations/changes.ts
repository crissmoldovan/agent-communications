import {
  type AccountConfig,
  type ChangePolicy,
  CommsError,
  type Config,
  defaultChangePolicy,
  findById,
  type GatedChange,
  type SendPolicy,
  withCredentialsLock,
} from '@agentcomms/core';
import type { SlackContext } from '../context.ts';
import { type InstallMode, parseMode } from '../manifest.ts';
import { checkedPort, type ManifestResult, manifestFor, modeWanted } from './manifest.ts';
import { type ModeReport, modeReport, narrowingSteps, wideningSteps } from './mode.ts';
import { type ListenerEntry, type StartedSignIn, startSignIn } from './signin.ts';
import { checkAliasFree, type RemovedWorkspace, removeWorkspace, requireWorkspace } from './workspaces.ts';

/**
 * Changing a workspace — connecting it, signing it in again, moving its mode, setting its policies, removing it — as
 * the one set of operations the CLI and the MCP server both run.
 *
 * Each is a `GatedChange` from core: `plan` says what would change, from the configuration as it stands, and `apply`
 * does it with whatever consent the approval gave. Core's flow decides whether anybody has to agree. A change that
 * loosens nothing and does nothing that cannot be taken back is applied at once — renewing a grant, narrowing,
 * tightening a policy, connecting a workspace that can only read. One that loosens — connecting or widening a
 * workspace to `send`, loosening a policy — or removes something is prepared as a change approval, which a person
 * gives in the conversation under the `chat` change policy or at a terminal under `confirm`, and applied on the call
 * that claims it. Both surfaces ask the same way because both run these.
 *
 * What stays the person's whatever the surface: Slack's consent screen, which every sign-in here stops at and returns
 * the link to; and the app's declared scopes, which only its manifest page or an app configuration token can change.
 */

/** A sign-in that has been started and waits for the person in Slack, as both surfaces report it. */
export interface SignInStarted {
  readonly flowId: string;
  readonly alias: string;
  readonly mode: InstallMode;
  /** True when this renews or widens a workspace already connected; false when it connects one. */
  readonly reauth: boolean;
  /** The person opens this and approves it in Slack. It expires with the sign-in, ten minutes after it started. */
  readonly authUrl: string;
  readonly expiresAt: string;
  /** How it is finished once they have: the tool from a chat, the command at a terminal. */
  readonly finish: { readonly tool: 'slack_workspace_finish'; readonly command: string };
}

export function signInStarted(started: StartedSignIn, reauth: boolean): SignInStarted {
  return {
    flowId: started.flowId,
    alias: started.alias,
    mode: started.mode,
    reauth,
    authUrl: started.authUrl,
    expiresAt: started.expiresAt,
    finish: {
      tool: 'slack_workspace_finish',
      command: `agent-slack workspace ${reauth ? `reauth ${started.alias}` : 'add'} --finish ${started.flowId}`,
    },
  };
}

/** How a sign-in's listener runs. */
export interface SignInSurface {
  /**
   * True to leave the listener in a detached process and return the link at once — always from MCP, whose calls
   * cannot wait on a browser, and with `--start` at the CLI. False keeps it in this process, which then waits.
   */
  readonly detached: boolean;
  /** The command that runs the detached listener; tests point it at the source entry. */
  readonly listenerCommand?: ListenerEntry | undefined;
}

/** The effect a posting sign-in has, as the person reads it in the preview. */
function postingSignIn(alias: string, clientId?: string): string {
  return clientId === undefined
    ? `signs in to Slack again as ${alias} and stores a token that can post, upload and react`
    : `signs in to Slack through the app with Client ID ${clientId} and stores a token for ${alias} that can post, upload and react`;
}

// ── Connecting ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ConnectInput extends SignInSurface {
  readonly alias: string;
  /** `read` or `send`, checked here: see `modeWanted`. */
  readonly mode: unknown;
  /** The app's Client ID, from its Basic Information page. Not a secret. */
  readonly clientId?: string | undefined;
  /** The loopback port in the app's manifest; checked, never guessed. */
  readonly port?: unknown;
}

/**
 * The account a sign-in will add, as the classifier sees it before Slack has said who it is.
 *
 * Only its mode matters: a new account arriving as `send` loosens `mode` from the `read` every account starts at, and
 * that is what the person approves. The identity fields are empty, so it can never be mistaken for the same person in
 * the same workspace as an account already connected — which would bind the approval to that account's id — and the
 * id is one no real account has. Neither id nor identity is part of the approval: a new account has no id before it
 * exists, and the sign-in's own checks decide who it is.
 */
function arriving(mode: InstallMode): AccountConfig {
  return {
    id: 'acc_notyetconnected',
    platform: 'slack',
    workspace: '',
    userId: '',
    tier: mode,
    mode,
    grantedScopes: [],
    secretRef: '',
    createdAt: new Date(0).toISOString(),
  };
}

/**
 * Connects a workspace: `workspace add` and `slack_workspace_add`.
 *
 * In `read` mode nothing loosens, so it starts at once — Slack's consent screen is the person's gate, and the token
 * cannot post. In `send` mode the new account loosens its mode, so the change is approved before the sign-in starts:
 * nobody is sent to a consent screen for a grant that would then not be recorded, and the consent the approval gives
 * travels on the flow to the write at the end, which `ConfigStore.update` refuses without it.
 */
export function connectWorkspace(context: SlackContext, input: ConnectInput): GatedChange<StartedSignIn> {
  // Checked once, before anything is read: a word that is not a mode is the caller's mistake whatever is connected.
  const mode = modeWanted(input.mode) ?? 'read';
  const checked = (config: Config): { clientId: string; port: number } => {
    checkAliasFree(config, input.alias);
    if (!input.clientId) {
      throw new CommsError('USAGE', 'the Slack app’s Client ID is needed', {
        hint: 'Create the app first: `agent-slack manifest --port 51234`. The Client ID is not a secret.',
      });
    }
    return { clientId: input.clientId, port: checkedPort(input.port) };
  };
  return {
    plan: (config) => {
      const { clientId } = checked(config);
      const after = structuredClone(config);
      after.accounts = { ...after.accounts, [input.alias]: arriving(mode) };
      return {
        account: input.alias,
        before: config,
        after,
        summary:
          mode === 'send' ? `Connect ${input.alias} able to post to Slack` : `Connect ${input.alias} to read Slack`,
        effects: mode === 'send' ? [postingSignIn(input.alias, clientId)] : [],
      };
    },
    apply: async (consent, request) => {
      const { clientId, port } = checked(request.before);
      return startSignIn(context, {
        alias: input.alias,
        mode,
        clientId,
        port,
        detached: input.detached,
        ...(consent ? { consent } : {}),
        ...(input.listenerCommand ? { listenerCommand: input.listenerCommand } : {}),
      });
    },
  };
}

// ── Signing in again ─────────────────────────────────────────────────────────────────────────────────────────

export interface ReauthInput extends SignInSurface {
  readonly alias: string;
  /**
   * The access to ask for, checked here: see `modeWanted`. Left out, the workspace's own: renewing a grant never quietly
   * changes what it can do.
   */
  readonly mode?: unknown;
  /** The loopback port; the one the workspace last signed in with when left out. */
  readonly port?: unknown;
}

function reauthTarget(config: Config, input: ReauthInput) {
  const found = requireWorkspace(config, input.alias);
  const clientId = found.account.oauthClientId;
  if (!clientId) {
    throw new CommsError('CONFIG', `"${found.alias}" does not record which Slack app it was connected through`, {
      hint: `Remove and add it again: \`agent-slack workspace remove ${found.alias}\`.`,
    });
  }
  // Checked, not assumed: a stored mode that is neither would otherwise be read as `send`, or skip the approval.
  const was = parseMode(found.account.mode ?? found.account.tier, `"${found.alias}"`);
  return {
    found,
    clientId,
    was,
    mode: modeWanted(input.mode) ?? was,
    port: checkedPort(input.port, found.account.redirectPort),
  };
}

/**
 * Signs a workspace in again: `workspace reauth` and `slack_workspace_reauth`, and the sign-in behind a move to `send`.
 *
 * Renewing in the same mode, or narrowing to `read`, loosens nothing and starts at once. `read` → `send` is a
 * widening, approved before the sign-in starts, as connecting in `send` is. Either way the sign-in is bound to this
 * account — the same person, the same workspace, the same app — so a browser signed in as somebody else is refused
 * rather than recorded under this name.
 */
export function reauthWorkspace(context: SlackContext, input: ReauthInput): GatedChange<StartedSignIn> {
  // Refused before the workspace is looked up, as `connectWorkspace` refuses it.
  modeWanted(input.mode);
  return {
    plan: (config) => {
      const { found, was, mode } = reauthTarget(config, input);
      const after = structuredClone(config);
      after.accounts = { ...after.accounts, [found.alias]: { ...found.account, tier: mode, mode } };
      const widens = was === 'read' && mode === 'send';
      return {
        account: found.alias,
        before: config,
        after,
        summary: widens ? `Let ${found.alias} post to Slack` : `Sign ${found.alias} in to Slack again, in ${mode} mode`,
        effects: widens ? [postingSignIn(found.alias)] : [],
      };
    },
    apply: async (consent, request) => {
      // From the configuration the approval was claimed against, so the account signed in is the one approved.
      const { found, clientId, mode, port } = reauthTarget(request.before, input);
      const { account } = found;
      return startSignIn(context, {
        alias: found.alias,
        mode,
        clientId,
        port,
        detached: input.detached,
        expect: {
          accountId: account.id,
          workspaceId: account.workspace,
          userId: account.userId,
          oauthClientId: clientId,
          ...(account.appId ? { appId: account.appId } : {}),
        },
        ...(consent ? { consent } : {}),
        ...(input.listenerCommand ? { listenerCommand: input.listenerCommand } : {}),
      });
    },
  };
}

// ── The mode ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A move that changes nothing here: the procedure a person follows instead, with the steps in order. */
export interface ModeSteps {
  readonly alias: string;
  /** The mode it is in, which this did not move. */
  readonly mode: InstallMode;
  readonly changed: false;
  readonly steps: readonly string[];
}

/** `read` → `send` before the app has been updated: the app step, with everything needed to take it. */
export interface AppUpdateNeeded extends ModeSteps {
  readonly appUpdateNeeded: true;
  /** The `send` manifest, for this workspace's port, and the link to its app's manifest page when the app is known. */
  readonly manifest: ManifestResult;
  /**
   * The same step at a terminal, with an app configuration token. A command for a person, never a tool: the token
   * would stay in the chat's transcript. Null when the app's id is not recorded, because `app update` would refuse.
   */
  readonly terminalAlternative: string | null;
}

export type ModeSetPlan =
  | { readonly kind: 'report'; readonly report: ModeReport }
  | { readonly kind: 'steps'; readonly result: ModeSteps }
  | { readonly kind: 'app-update-needed'; readonly result: AppUpdateNeeded }
  | {
      readonly kind: 'change';
      readonly change: GatedChange<StartedSignIn>;
      /**
       * The same move as steps, for a caller that only reports them: `slack_mode_request_send`, which changes nothing,
       * returns this where the command would go on to ask for the change.
       */
      readonly steps: ModeSteps;
    };

export interface ModeSetOptions extends SignInSurface {
  readonly port?: unknown;
  /**
   * The person says the app's manifest now asks for the `send` scopes.
   *
   * Needed only while the recorded grant has no posting scope, which is every `read` workspace whose app was never
   * `send`: nothing on this machine can see an app's manifest, so without their word the sign-in would go to Slack
   * and come back as `read` again.
   */
  readonly appUpdated?: boolean | undefined;
}

/**
 * What `workspace mode <name> [read|send]` and `slack_mode_set` do, decided before anything is done.
 *
 * - The mode it already has, or none asked for: the report.
 * - `read` from `send`: the procedure, and nothing changes. Slack never removes a scope from a token; only removing
 *   the app's installation in Slack's own settings does, and that is a person's step.
 * - `send` from `read`, while the recorded grant cannot show the app offers posting and the person has not said it
 *   does: the manifest and the link to the app's page, and nothing started. A sign-in now would grant `read` again.
 * - `send` from `read` otherwise: the widening, as a change approved before its sign-in starts.
 */
export async function planModeSet(
  context: SlackContext,
  alias: string,
  wanted: unknown,
  options: ModeSetOptions,
): Promise<ModeSetPlan> {
  const target = modeWanted(wanted);
  const found = requireWorkspace(await context.config(), alias);
  const asked = options.port === undefined ? undefined : checkedPort(options.port);
  const report = modeReport(found.alias, found.account, asked);
  if (target === undefined || target === report.mode) return { kind: 'report', report };
  if (target === 'read') {
    // The port is in two of the steps: the one asked for, else the one this workspace last signed in with.
    const steps = narrowingSteps(found.alias, checkedPort(options.port, found.account.redirectPort), {
      knowsItsApp: found.account.oauthClientId !== undefined,
    });
    return { kind: 'steps', result: { alias: found.alias, mode: report.mode, changed: false, steps } };
  }
  if (!found.account.oauthClientId) {
    throw new CommsError('CONFIG', `"${found.alias}" does not record which Slack app it was connected through`, {
      hint: `Remove and add it again: \`agent-slack workspace remove ${found.alias}\`.`,
    });
  }
  // Both steps name the port: the one asked for, else the one this workspace last signed in with — never a guess.
  const port = checkedPort(options.port, found.account.redirectPort);
  if (report.outwardScopes.length === 0 && options.appUpdated !== true) {
    return {
      kind: 'app-update-needed',
      result: {
        alias: found.alias,
        mode: report.mode,
        changed: false,
        appUpdateNeeded: true,
        steps: wideningSteps(found.alias, port, found.account.appId),
        manifest: await manifestFor(context, { mode: 'send', port, workspace: found.alias }),
        terminalAlternative: found.account.appId
          ? `agent-slack app update ${found.alias} --mode send --port ${port}`
          : null,
      },
    };
  }
  return {
    kind: 'change',
    change: reauthWorkspace(context, {
      alias: found.alias,
      mode: 'send',
      port,
      detached: options.detached,
      listenerCommand: options.listenerCommand,
    }),
    steps: {
      alias: found.alias,
      mode: report.mode,
      changed: false,
      steps: wideningSteps(found.alias, port, found.account.appId),
    },
  };
}

// ── Removing ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Disconnects a workspace from this machine: `workspace remove` and `slack_workspace_remove`.
 *
 * It loosens nothing, but it cannot be taken back — the token is deleted, and connecting again is a new sign-in in
 * Slack — so it is approved like a loosening, and the approval is bound to the account that was shown. The Slack app
 * stays installed in the workspace; removing it there is a person's step in Slack's settings.
 */
export function removeWorkspaceChange(context: SlackContext, alias: string): GatedChange<RemovedWorkspace> {
  return {
    plan: (config) => {
      const found = requireWorkspace(config, alias);
      const { [found.alias]: _removed, ...rest } = config.accounts;
      return {
        account: found.alias,
        before: config,
        after: { ...config, accounts: rest },
        summary: `Disconnect ${found.alias} from this machine`,
        effects: [`removes ${found.alias} and deletes its token from this machine`],
      };
    },
    apply: async (_consent, request) => {
      const expectId = requireWorkspace(request.before, alias).account.id;
      /*
       * Under the credentials lock, from reading the configuration to the last write.
       *
       * Removal deletes a credential and then drops the entry naming it, and a migration running in between saw an
       * account still configured whose credential was already gone — skipped it as having nothing to copy, switched
       * backends, and left the removal refusing because the backend had moved. The account stayed configured with
       * its credential in neither backend. Holding the lock makes the two strictly one after the other, and reading
       * the configuration inside it means the store chosen is the one actually in force.
       *
       * A sign-in does not take it, deliberately: it only ever *adds* a reference, which the migration's own check of
       * the reference set does see, and the sign-in checks the backend from its side. Making it wait here would spend
       * a one-shot authorisation code on a five-second lock timeout.
       */
      return withCredentialsLock(context.core.paths.configDir, async () =>
        removeWorkspace(
          {
            config: await context.config(),
            secrets: await context.secrets(),
            update: (mutator) => context.core.config.update(mutator),
          },
          alias,
          { expectId },
        ),
      );
    },
  };
}

// ── Policies ─────────────────────────────────────────────────────────────────────────────────────────────────

export const SEND_POLICIES: readonly SendPolicy[] = ['chat', 'confirm', 'never'];
export const CHANGE_POLICIES: readonly ChangePolicy[] = ['chat', 'confirm'];

/** How a workspace's posts and changes are approved, and whether each is its own setting or the default. */
export interface WorkspacePolicies {
  readonly alias: string;
  /** How a post or reaction is approved: in the chat, by a code at a terminal, or not at all. */
  readonly sendPolicy: SendPolicy;
  readonly sendPolicySetOn: 'workspace' | 'default';
  /** How a change to the workspace that loosens it, or removes it, is approved. */
  readonly changePolicy: ChangePolicy;
  readonly changePolicySetOn: 'workspace' | 'default';
}

export interface PolicyResult extends WorkspacePolicies {
  /** Whether the workspace's own settings changed. False for a report, and for setting what was already set. */
  readonly changed: boolean;
  /** The policies in force before, whether set on the workspace or inherited. */
  readonly previous: { readonly sendPolicy: SendPolicy; readonly changePolicy: ChangePolicy };
}

export interface PolicyWanted {
  readonly send?: SendPolicy | undefined;
  readonly change?: ChangePolicy | undefined;
}

function policiesOf(config: Config, alias: string, account: AccountConfig): WorkspacePolicies {
  return {
    alias,
    sendPolicy: account.sendPolicy ?? config.defaults.sendPolicy,
    sendPolicySetOn: account.sendPolicy === undefined ? 'default' : 'workspace',
    changePolicy: account.changePolicy ?? defaultChangePolicy(config),
    changePolicySetOn: account.changePolicy === undefined ? 'default' : 'workspace',
  };
}

/** The policies in force for a workspace, as a result that changed nothing: `workspace policy <name>`. */
export function policyReport(config: Config, alias: string): PolicyResult {
  const found = requireWorkspace(config, alias);
  const now = policiesOf(config, found.alias, found.account);
  return { ...now, changed: false, previous: { sendPolicy: now.sendPolicy, changePolicy: now.changePolicy } };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new CommsError('USAGE', `"${String(value)}" is not a ${what}`, { hint: `One of: ${allowed.join(', ')}.` });
}

/** The policies asked for, checked here so the command and the tool refuse the same values in the same words. */
export function policyWanted(input: { send?: unknown; change?: unknown }): PolicyWanted {
  return {
    ...(input.send === undefined ? {} : { send: oneOf(input.send, SEND_POLICIES, 'send policy') }),
    ...(input.change === undefined ? {} : { change: oneOf(input.change, CHANGE_POLICIES, 'change policy') }),
  };
}

/**
 * Sets a workspace's send policy, change policy, or both: `workspace policy` and `slack_workspace_policy`.
 *
 * Tightening — towards `never` for posts, towards `confirm` for changes — is applied at once, because it needs
 * nobody's consent. Loosening is a change approval, decided by the change policy in force *before* the change: moving
 * this workspace's change policy off `confirm` is itself approved at a terminal, so a policy cannot be used to approve
 * its own relaxation.
 */
export function policyChange(context: SlackContext, alias: string, wanted: PolicyWanted): GatedChange<PolicyResult> {
  const setOn = (account: AccountConfig): AccountConfig => ({
    ...account,
    ...(wanted.send === undefined ? {} : { sendPolicy: wanted.send }),
    ...(wanted.change === undefined ? {} : { changePolicy: wanted.change }),
  });
  const said = [
    wanted.send === undefined ? '' : `posts approved under ${wanted.send}`,
    wanted.change === undefined ? '' : `changes approved under ${wanted.change}`,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    plan: (config) => {
      const found = requireWorkspace(config, alias);
      const after = structuredClone(config);
      after.accounts = { ...after.accounts, [found.alias]: setOn(found.account) };
      return { account: found.alias, before: config, after, summary: `${found.alias}: ${said}` };
    },
    apply: async (consent, request) => {
      const { alias: name, account } = requireWorkspace(request.before, alias);
      const previous = policiesOf(request.before, name, account);
      // The account as it was written, and the name it was written under: set inside the write, which is the one
      // place nothing can move between the read and the result.
      let written: { alias: string; account: AccountConfig } = { alias: name, account: setOn(account) };
      /*
       * By id, under whatever name it has at the write: a rename in between must not set the policy on an account
       * that took the old name, and an account that is gone is refused rather than recreated from the snapshot.
       */
      const config = await context.core.config.update(
        (current) => {
          const held = findById(current, 'account', account.id);
          if (!held) {
            throw new CommsError('CONFIG', `"${name}" changed while its policy was being set, so nothing was set`, {
              hint: 'Check it with `agent-slack workspace list`, then set the policy again.',
            });
          }
          written = { alias: held.alias, account: setOn(held.account) };
          return { ...current, accounts: { ...current.accounts, [held.alias]: written.account } };
        },
        consent ? { consent } : {},
      );
      const now = written.account;
      return {
        ...policiesOf(config, written.alias, now),
        changed: now.sendPolicy !== account.sendPolicy || now.changePolicy !== account.changePolicy,
        previous: { sendPolicy: previous.sendPolicy, changePolicy: previous.changePolicy },
      };
    },
  };
}
