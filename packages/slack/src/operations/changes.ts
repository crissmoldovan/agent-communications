import {
  type AccountConfig,
  applySendPolicyChange,
  type ChangePolicy,
  type ChangeRequest,
  type CliHandoffs,
  CommsError,
  type Config,
  defaultChangePolicy,
  type FenceReport,
  findById,
  type GatedChange,
  type Handoff,
  handoffSentence,
  hasNames,
  type LegacyDrainReport,
  neutralise,
  type ProfileSlackTarget,
  parseName,
  refuseUnclaimedApproval,
  resolveProfileSlackTarget,
  type SendPolicy,
  withCredentialsLock,
} from '@agentcomms/core';
import type { SlackContext } from '../context.ts';
import { type InstallMode, parseMode } from '../manifest.ts';
import { appManifestFor, checkedPort, type ManifestResult, modeWanted } from './manifest.ts';
import { type ModeReport, modeReport, narrowingSteps, profileMoveSteps, wideningSteps } from './mode.ts';
import { retryPendingRevocations } from './revocations.ts';
import { type ListenerEntry, type StartedSignIn, startSignIn } from './signin.ts';
import {
  checkAliasFree,
  clientSecretRefOf,
  type RemovedWorkspace,
  removeWorkspace,
  requireWorkspace,
} from './workspaces.ts';

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
  /**
   * How it is finished once they have: the tool from a chat, the command at a terminal — this installation's own,
   * located, or why there is none here; written out as its text with `--json` and over MCP (`PrintedCommand.toJSON`).
   */
  readonly finish: { readonly tool: 'slack_workspace_finish'; readonly command: Handoff };
}

export function signInStarted(context: SlackContext, started: StartedSignIn, reauth: boolean): SignInStarted {
  return {
    flowId: started.flowId,
    alias: started.alias,
    mode: started.mode,
    reauth,
    authUrl: started.authUrl,
    expiresAt: started.expiresAt,
    finish: {
      tool: 'slack_workspace_finish',
      command: context.handoffs.own([
        'workspace',
        ...(reauth ? ['reauth', started.alias] : ['add']),
        '--finish',
        started.flowId,
      ]),
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

/** Preview the selected profile app and bind every stable part of it to the widening approval. */
function profileSignInEffects(profile: ProfileSlackTarget): string[] {
  const appId = profile.appId ?? 'not recorded yet';
  return [
    `uses ${profile.label}'s ${profile.role} Slack app for ${profile.workspaceName} (${profile.workspace})`,
    `binds the sign-in to organisation ${profile.organisation}, role ${profile.role}, workspace ${profile.workspace}, Client ID ${profile.clientId}, App ID ${appId}, port ${profile.redirectPort}, profile SHA-256 ${profile.sha256}`,
  ];
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
  /**
   * The app's client secret, typed at a person's hidden prompt: sign in with it rather than PKCE (design 2026-10-15 S1,
   * revised). The command's only — no tool takes a secret — and never part of what an approval binds or shows.
   */
  readonly clientSecret?: string | undefined;
}

/** What a sign-in with the app's client secret does, as the person reads it in the preview. */
const SECRET_SIGN_IN =
  "signs in with the app's client secret rather than PKCE, keeps the secret in this machine's secret store by the app's id, and in send mode keeps the app's bot token";

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
  type Selection = { clientId: string; port: number; profile?: ProfileSlackTarget };
  type ConnectRequest = ChangeRequest & { readonly selection: Selection };
  const { handoffs } = context;
  const createTheApp = () =>
    new CommsError('USAGE', 'the Slack app’s Client ID is needed', {
      hint: `${handoffSentence(
        handoffs.own(['manifest', '--port', '51234']),
        (command) => `Create the app first: ${command}.`,
        { instead: 'Create the app first, from the manifest slack_manifest prints.' },
      )} The Client ID is not a secret.`,
    });
  const checked = (config: Config): Selection => {
    checkAliasFree(config, input.alias, handoffs);
    if (input.clientId !== undefined) {
      if (!input.clientId) throw createTheApp();
      return { clientId: input.clientId, port: checkedPort(input.port) };
    }
    if (!hasNames(config)) throw createTheApp();
    if (input.port !== undefined) {
      throw new CommsError('USAGE', 'a profile sign-in uses the profile port; --port needs an explicit --client-id', {
        hint: 'Leave out --port to use the organisation app, or pass --client-id and --port for your own app.',
      });
    }
    const organisation = parseName(input.alias)?.org;
    if (!organisation) throw new CommsError('USAGE', 'a profile sign-in needs an organisation/slack name');
    const target = resolveProfileSlackTarget(config, organisation, mode, handoffs);
    const profile = {
      ...target,
      label: neutralise(target.label).text,
      workspaceName: neutralise(target.workspaceName).text,
    };
    return { clientId: target.clientId, port: target.redirectPort, profile };
  };
  return {
    plan: (config) => {
      const selection = checked(config);
      const { clientId } = selection;
      const after = structuredClone(config);
      after.accounts = { ...after.accounts, [input.alias]: arriving(mode) };
      const request: ConnectRequest = {
        account: input.alias,
        before: config,
        after,
        selection,
        summary:
          mode === 'send' ? `Connect ${input.alias} able to post to Slack` : `Connect ${input.alias} to read Slack`,
        effects:
          mode === 'send'
            ? [
                postingSignIn(input.alias, clientId),
                ...(selection.profile ? profileSignInEffects(selection.profile) : []),
                ...(input.clientSecret === undefined ? [] : [SECRET_SIGN_IN]),
              ]
            : [],
      };
      return request;
    },
    apply: async (consent, request) => {
      const { clientId, port, profile } = (request as ConnectRequest).selection;
      return startSignIn(context, {
        alias: input.alias,
        mode,
        clientId,
        port,
        ...(profile ? { profile } : {}),
        detached: input.detached,
        ...(consent ? { consent } : {}),
        ...(input.listenerCommand ? { listenerCommand: input.listenerCommand } : {}),
        ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
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
  /**
   * The app's client secret, typed at a person's hidden prompt (S1, revised). Left out, a workspace that already signs
   * in with its app's secret uses the one kept for it, and any other signs in with PKCE.
   */
  readonly clientSecret?: string | undefined;
}

/** A workspace that does not record its app, refused with the one way back: removed, and added again. */
function noRecordedApp(alias: string, handoffs: CliHandoffs): CommsError {
  return new CommsError('CONFIG', `"${alias}" does not record which Slack app it was connected through`, {
    hint: handoffSentence(
      handoffs.own(['workspace', 'remove', alias]),
      (command) => `Remove and add it again: ${command}.`,
      { instead: 'Remove and add it again: slack_workspace_remove, then slack_workspace_add, from a chat.' },
    ),
  });
}

function reauthTarget(config: Config, input: ReauthInput, handoffs: CliHandoffs) {
  const found = requireWorkspace(config, input.alias, handoffs);
  const clientId = found.account.oauthClientId;
  if (!clientId) throw noRecordedApp(found.alias, handoffs);
  // Checked, not assumed: a stored mode that is neither would otherwise be read as `send`, or skip the approval.
  const was = parseMode(found.account.mode ?? found.account.tier, `"${found.alias}"`);
  if (found.account.organisation) {
    const role = modeWanted(input.mode) ?? found.account.profileApp;
    if (!role) throw new CommsError('CONFIG', 'the profile account does not record its app role');
    if (input.port !== undefined) {
      throw new CommsError('USAGE', 'a profile sign-in uses the profile port');
    }
    const target = resolveProfileSlackTarget(config, found.account.organisation, role, handoffs);
    const profile = {
      ...target,
      label: neutralise(target.label).text,
      workspaceName: neutralise(target.workspaceName).text,
    };
    return { found, clientId: target.clientId, was, mode: role, port: target.redirectPort, profile };
  }
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
 * account — the same person and workspace. Own-app renewals keep their app; profile renewals select the recorded
 * role's current app, or the explicitly requested role, and snapshot that exact target before opening the browser.
 */
export function reauthWorkspace(context: SlackContext, input: ReauthInput): GatedChange<StartedSignIn> {
  // Refused before the workspace is looked up, as `connectWorkspace` refuses it.
  modeWanted(input.mode);
  return {
    plan: (config) => {
      const { found, was, mode, profile } = reauthTarget(config, input, context.handoffs);
      const after = structuredClone(config);
      after.accounts = { ...after.accounts, [found.alias]: { ...found.account, tier: mode, mode } };
      const widens = was === 'read' && mode === 'send';
      return {
        account: found.alias,
        before: config,
        after,
        summary: widens ? `Let ${found.alias} post to Slack` : `Sign ${found.alias} in to Slack again, in ${mode} mode`,
        effects: widens
          ? [
              postingSignIn(found.alias),
              ...(profile ? profileSignInEffects(profile) : []),
              ...(input.clientSecret === undefined ? [] : [SECRET_SIGN_IN]),
            ]
          : [],
      };
    },
    apply: async (consent, request) => {
      // From the configuration the approval was claimed against, so the account signed in is the one approved.
      const { found, clientId, mode, port, profile } = reauthTarget(request.before, input, context.handoffs);
      const { account } = found;
      return startSignIn(context, {
        alias: found.alias,
        mode,
        clientId,
        port,
        detached: input.detached,
        ...(profile ? { profile, transition: 'profile-app' as const } : {}),
        expect: {
          accountId: account.id,
          workspaceId: account.workspace,
          userId: account.userId,
          oauthClientId: account.oauthClientId,
          ...(account.appId ? { appId: account.appId } : {}),
          // The credential it replaces: the renewal keeps the id, so this is what says another renewal came first.
          secretRef: account.secretRef,
        },
        ...(consent ? { consent } : {}),
        ...(input.listenerCommand ? { listenerCommand: input.listenerCommand } : {}),
        // The secret just typed; else the one this workspace already signs in with, when it does (S1, revised).
        ...(input.clientSecret !== undefined
          ? { clientSecret: input.clientSecret }
          : clientSecretRefOf(account) !== undefined
            ? { clientSecretRef: clientSecretRefOf(account) }
            : {}),
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
   * Located, or why there is none here; written out as its text with `--json` and over MCP.
   */
  readonly terminalAlternative: Handoff | null;
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
  /**
   * The approval the call carries — `--approval`, `approvalId` — when it carries one. Only the widening claims it; any
   * other plan refuses it here, in the words of the surface that asked (`modeApprovalRefusal`).
   */
  readonly approvalId?: unknown;
}

/**
 * What `workspace mode <name> [read|send]` and `slack_mode_set` do, decided before anything is done.
 *
 * - The mode it already has, or none asked for: the report.
 * - A profile account changing mode: sign in through the requested role's app, approving only a widening.
 * - `read` from `send`: the procedure, and nothing changes. Slack never removes a scope from a token; only removing
 *   the app's installation in Slack's own settings does, and that is a person's step.
 * - `send` from `read`, while the recorded grant cannot show the app offers posting and the person has not said it
 *   does: the manifest and the link to the app's page, and nothing started. A sign-in now would grant `read` again.
 * - `send` from `read` otherwise: the widening, as a change approved before its sign-in starts.
 *
 * Only the widening claims an approval, so every other plan refuses one it is handed, here, where both surfaces meet
 * it: dropped, it had got the call past the update check's stop (core's `refuseUnclaimedApproval`).
 */
export async function planModeSet(
  context: SlackContext,
  alias: string,
  wanted: unknown,
  options: ModeSetOptions,
): Promise<ModeSetPlan> {
  const planned = await modeSetPlan(context, alias, wanted, options);
  if (planned.kind !== 'change') {
    refuseUnclaimedApproval(options.approvalId, modeApprovalRefusal(planned, context.surface, context.handoffs));
  }
  return planned;
}

async function modeSetPlan(
  context: SlackContext,
  alias: string,
  wanted: unknown,
  options: ModeSetOptions,
): Promise<ModeSetPlan> {
  const target = modeWanted(wanted);
  const config = await context.config();
  const { handoffs } = context;
  const found = requireWorkspace(config, alias, handoffs);
  const asked = options.port === undefined ? undefined : checkedPort(options.port);
  const report = modeReport(found.alias, found.account, handoffs, asked);
  if (target === undefined || target === report.mode) return { kind: 'report', report };
  if (found.account.organisation) {
    const input = { alias: found.alias, mode: target, ...options };
    reauthTarget(config, input, handoffs);
    return {
      kind: 'change',
      change: reauthWorkspace(context, input),
      steps: {
        alias: found.alias,
        mode: report.mode,
        changed: false,
        steps: profileMoveSteps(found.alias, target, handoffs),
      },
    };
  }
  if (target === 'read') {
    // The port is in two of the steps: the one asked for, else the one this workspace last signed in with.
    const steps = narrowingSteps(found.alias, handoffs, checkedPort(options.port, found.account.redirectPort), {
      knowsItsApp: found.account.oauthClientId !== undefined,
    });
    return { kind: 'steps', result: { alias: found.alias, mode: report.mode, changed: false, steps } };
  }
  if (!found.account.oauthClientId) throw noRecordedApp(found.alias, handoffs);
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
        steps: wideningSteps(found.alias, handoffs, port, found.account.appId),
        manifest: await appManifestFor(context, { mode: 'send', port, workspace: found.alias }),
        terminalAlternative: found.account.appId
          ? handoffs.own(['app', 'update', found.alias, '--mode', 'send', '--port', String(port)])
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
      steps: wideningSteps(found.alias, handoffs, port, found.account.appId),
    },
  };
}

/** Why a `mode` that changes nothing refuses the approval it is handed, in the words of the surface it came from. */
function modeApprovalRefusal(
  planned: Exclude<ModeSetPlan, { kind: 'change' }>,
  surface: 'cli' | 'mcp',
  handoffs: CliHandoffs,
): { message: string; hint: string } {
  const alias = planned.kind === 'report' ? planned.report.alias : planned.result.alias;
  const flag = surface === 'cli' ? '--approval' : 'approvalId';
  const tool = 'slack_mode_set with `mode: "send"` and `appUpdated: true`';
  // The command at a terminal, located; with none here, the tool from a chat and why there is no command.
  const widen = (say: (how: string) => string): string =>
    surface === 'cli'
      ? handoffSentence(handoffs.own(['workspace', 'mode', alias, 'send', '--app-updated']), say, {
          instead: say(tool),
        })
      : say(tool);
  switch (planned.kind) {
    case 'report':
      return {
        message: `this only reports ${alias}'s mode, so it takes no ${flag}`,
        hint: widen((how) => `An approval goes with the move to send it was prepared for: ${how}, with it.`),
      };
    case 'steps':
      return {
        message: `moving ${alias} to read changes nothing here, so it takes no ${flag}: Slack cannot take posting away from a token`,
        hint: `Leave out ${flag} for the steps; removing the app's installation in Slack is the person's own.`,
      };
    case 'app-update-needed':
      return {
        message: `${alias}'s app has to ask for the send scopes first, so this starts nothing and takes no ${flag}`,
        hint: widen(
          (how) =>
            `Once the person says its manifest does, ${how} — with ${flag} if they have already approved the move.`,
        ),
      };
  }
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
      const found = requireWorkspace(config, alias, context.handoffs);
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
      const expectId = requireWorkspace(request.before, alias, context.handoffs).account.id;
      const current = requireWorkspace(await context.config(), alias, context.handoffs);
      if (current.account.id !== expectId) {
        throw new CommsError('CONFIG', `"${alias}" changed after its removal was approved, so nothing was removed`);
      }
      // The retry engine takes the credentials lock for each status write. Finish it before the
      // current-secret-first removal takes that same lock around its whole transaction.
      const cleanup = await retryPendingRevocations(context, current.account.workspace);
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
            handoffs: context.handoffs,
          },
          alias,
          { expectId, cleanup },
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
  /** What became of the approvals an earlier release prepared, when this write retired them. Absent otherwise. */
  readonly legacyDrain?: LegacyDrainReport | undefined;
  /** When the send policy was set: what a change to `never` did to the approvals prepared before it, by id. */
  readonly fenced?: FenceReport | undefined;
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
export function policyReport(config: Config, alias: string, handoffs: CliHandoffs): PolicyResult {
  const found = requireWorkspace(config, alias, handoffs);
  const now = policiesOf(config, found.alias, found.account);
  return { ...now, changed: false, previous: { sendPolicy: now.sendPolicy, changePolicy: now.changePolicy } };
}

/**
 * Why a policy report refuses the approval it is handed, in the words of the surface it came from, as core's
 * `comms_change_policy` refuses one without `set`: only a policy to set claims it, and the report would drop it past
 * the update check's stop. See core's `refuseUnclaimedApproval`.
 */
export function policyApprovalRefusal(surface: 'cli' | 'mcp'): { message: string; hint: string } {
  return surface === 'cli'
    ? {
        message: 'an approval goes with a policy to set; without --send or --change this only reports',
        hint: 'Pass the policy the approval was prepared for — --send, --change or both — with it.',
      }
    : {
        message: 'an approval goes with a policy to set; without `sendPolicy` or `changePolicy` this only reports',
        hint: 'Pass the policy the approval was prepared for — `sendPolicy`, `changePolicy` or both — with it.',
      };
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
      const found = requireWorkspace(config, alias, context.handoffs);
      const after = structuredClone(config);
      after.accounts = { ...after.accounts, [found.alias]: setOn(found.account) };
      return { account: found.alias, before: config, after, summary: `${found.alias}: ${said}` };
    },
    apply: async (consent, request) => {
      // A send policy moves only with its send epoch, on version 3: converted first, an earlier release's retired.
      const { alias: name, account } = requireWorkspace(request.before, alias, context.handoffs);
      const previous = policiesOf(request.before, name, account);
      // The account as it was written, and the name it was written under: set inside the write, which is the one
      // place nothing can move between the read and the result.
      let written: { alias: string; account: AccountConfig } = { alias: name, account: setOn(account) };
      /*
       * By id, under whatever name it has at the write: a rename in between must not set the policy on an account
       * that took the old name, and an account that is gone is refused rather than recreated from the snapshot.
       */
      const write = (current: Config): Config => {
        const held = findById(current, 'account', account.id);
        if (!held) {
          throw new CommsError('CONFIG', `"${name}" changed while its policy was being set, so nothing was set`, {
            hint: handoffSentence(
              context.handoffs.own(['workspace', 'list']),
              (command) => `Check it with ${command}, then set the policy again.`,
              { instead: 'Check it with slack_workspaces_list from a chat, then set the policy again.' },
            ),
          });
        }
        written = { alias: held.alias, account: setOn(held.account) };
        return { ...current, accounts: { ...current.accounts, [held.alias]: written.account } };
      };
      /*
       * A send policy moves only with its send epoch, on version 3 (`applySendPolicyChange`): converted first, an
       * earlier release's records retired, the epoch raised in the same write as a `never`, and then — the config lock
       * let go — every approval it fenced revoked, and every one already being posted said so.
       */
      const changed =
        wanted.send === undefined
          ? undefined
          : await applySendPolicyChange(context.core, write, { consent, now: context.now });
      const config = changed?.config ?? (await context.core.config.update(write, consent ? { consent } : {}));
      const now = written.account;
      return {
        ...policiesOf(config, written.alias, now),
        changed: now.sendPolicy !== account.sendPolicy || now.changePolicy !== account.changePolicy,
        previous: { sendPolicy: previous.sendPolicy, changePolicy: previous.changePolicy },
        ...(changed?.legacyDrain === undefined ? {} : { legacyDrain: changed.legacyDrain }),
        ...(changed === undefined ? {} : { fenced: changed.fenced }),
      };
    },
  };
}
