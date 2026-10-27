import {
  type CliHandoffs,
  type Config,
  describeOtherSlackServer,
  findOtherSlackServers,
  handoffSentence,
  handoffSentenceToFill,
  isCommand,
  isProductServer,
  listRegisteredServers,
  lookupName,
  missingEntryFile,
  organisationAgentApp,
  otherSlackServerRemoval,
  type RegisteredServer,
  type Remedy,
  registrationVersion,
  remedy,
  type SecretStore,
  shownText,
  slackStyleOf,
  toCommsError,
} from '@agentcomms/core';
import { scopeMismatch } from '../auth/authorize.ts';
import { isDue, isExpired, parseBundle, REFRESH_EXPIRY_WARNING_MS, type TokenBundle } from '../auth/bundle.ts';
import type { SlackContext } from '../context.ts';
import { handoffsSentence } from '../handoffs.ts';
import type { InstallMode } from '../manifest.ts';
import { SLACK_MCP } from '../mcp/install.ts';
import { VERSION } from '../version.ts';
import { appTokenRevokedOf } from './app-token.ts';
import { type AgentAppProbe, probeAgentApp } from './bot-token.ts';
import { type ProbeFetch, probeIdentity } from './identity.ts';
import { labelSettingsOf } from './label.ts';
import { type PendingRevocationResult, pendingRevocationResult, retryPendingRevocations } from './revocations.ts';
import { openWorkspace, type SessionDeps } from './session.ts';
import { botSecretRefFor, clientSecretRefOf, listWorkspaces, requireWorkspace } from './workspaces.ts';

/**
 * What has to be true for this to work, and the commands or actions that fix each thing that is not.
 *
 * Every check here is answerable from what is already on disk or from one cheap call. That is a constraint
 * rather than an accident — see `rate-limit` below, which is the check that taught it.
 */

/**
 * `unknown` is not a shade of `ok`.
 *
 * Three states made every check that had not been performed print green, because green was the only thing left
 * to print. A reader takes green as "checked, and fine" — so a diagnostic with nothing to say has to say that,
 * and a warning would be worse: something that warns on every healthy install is something people stop reading.
 */
export interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: 'ok' | 'unknown' | 'warn' | 'fail';
  readonly detail: string;
  /**
   * What fixes it, a step a line: this installation's own commands, core's, a client's own — each located, or why
   * there is none here — and the words around them (`remedy`). Null when there is nothing to do.
   */
  readonly fix: Remedy | null;
  readonly workspace: string | null;
}

export interface DoctorResult {
  readonly healthy: boolean;
  readonly summary: { ok: number; unknown: number; warn: number; fail: number };
  readonly checks: readonly Check[];
  readonly cleanup?: readonly PendingRevocationResult[];
}

/** The secret store would not answer, and why, in its own words. Says nothing about the credential inside it. */
export interface StoreUnavailable {
  readonly storeUnavailable: string;
}

/** What one `auth.test` came back with, or why it could not be made. */
export type IdentityProbe =
  | { readonly kind: 'ok'; readonly workspaceId: string; readonly userId: string; readonly scopes?: readonly string[] }
  | { readonly kind: 'rejected'; readonly error: string }
  | { readonly kind: 'unreachable'; readonly why: string };

export interface DoctorInput {
  readonly config: Config;
  readonly now: Date;
  /**
   * Every repair command in the report — Slack's own, core's — located from the installation printing it and quoted for
   * the shell the output is for (`SlackContext.handoffs`), or the sentence saying why there is none here.
   */
  readonly handoffs: CliHandoffs;
  /**
   * The stored credential per alias, already read.
   *
   * Three outcomes, not two. `null` means the secret store holds nothing under that reference; `'unreadable'`
   * means it holds something this cannot parse. Collapsing the second into the first sent somebody to
   * `workspace add` — connect it, it is not connected — when the truthful answer is that it *is* connected and
   * the credential is corrupt, which `reauth` repairs and `add` refuses outright as a duplicate.
   *
   * And a fourth: `{ storeUnavailable }`, the secret store itself would not answer — a locked keychain, a prompt
   * nobody has approved, a missing keyring module. That was reported as `'unreadable'`, whose fix is `reauth`: the
   * one piece of advice that throws away a refresh token which is almost certainly fine, to cure a keychain that
   * only needed unlocking.
   */
  readonly bundles: ReadonlyMap<string, TokenBundle | null | 'unreadable' | StoreUnavailable>;
  /**
   * What ordinary traffic has already observed about rate limiting. Empty until S3 does any reading.
   *
   * Passed in rather than measured here, for the reason in the check itself.
   */
  readonly rateEvidence?:
    | { readonly lastThrottledAt?: string | undefined; readonly retryAfterSeconds?: number }
    | undefined;
  /**
   * Every MCP server registered with the clients on this machine, from core's scanner.
   *
   * Absent and empty are different answers and are reported differently: printing "none registered" for a scan
   * that never happened would be a clean bill of health for something nobody looked at.
   */
  readonly registeredServers?: readonly RegisteredServer[] | undefined;
  /** For each of our registered entries whose interpreter or script is gone, the path that is missing. */
  readonly missingFiles?: ReadonlyMap<RegisteredServer, string> | undefined;
  /**
   * What Slack says about each stored credential, when it was asked.
   *
   * Absent for an alias means nothing asked — offline, or no usable token — and that is reported as unknown
   * rather than as health. This identity call is one part of online `doctor`, and it is the whole difference between
   * "a credential is stored" and "the credential works, and belongs to who this says it does".
   */
  readonly identities?: ReadonlyMap<string, IdentityProbe> | undefined;
  /**
   * Whether each send workspace's app bot token is in the secret store (design 2026-10-15 S1, revised): `stored`,
   * `missing`, or `unknown` when the store would not say. Absent for an alias means nobody looked, which is reported as
   * unknown for a workspace that records a bot user — never as able to post as the app.
   */
  readonly appTokens?: ReadonlyMap<string, 'stored' | 'missing' | 'unknown'> | undefined;
  /**
   * For each send workspace whose organisation's profile names its agent app and that stores a bot token: whether that
   * token is the agent app's, as Slack says (`probeAgentApp`). Absent for an alias means nobody asked — offline — which
   * is reported as unknown, never as the agent app's.
   */
  readonly agentApps?: ReadonlyMap<string, AgentAppProbe> | undefined;
  /**
   * Check only this workspace, by its current name. The checks about the machine — the rate limit, the MCP entries —
   * are reported either way, as Gmail's doctor reports them for one mailbox.
   */
  readonly workspace?: string | undefined;
  readonly cleanup?: readonly PendingRevocationResult[] | undefined;
}

/**
 * Scopes Slack adds to every user token without being asked, and so never counts as drift.
 *
 * Found by the first real sign-in, 2026-09-22, against a real workspace. The grant Slack returned at sign-in
 * held exactly the eleven `read` scopes — the exchange refuses anything wider, and it passed — but the
 * `x-oauth-scopes` header on `auth.test` listed `identify` as well. So `doctor` reported every healthy install
 * as "more than read allows: identify", with a fix that could not work, since re-authorising gets the same
 * answer. Nothing a test against a fake Slack could have shown.
 *
 * `identify` lets a token read its own identity, which is what `auth.test` does anyway. It posts nothing, so
 * disregarding it leaves the read-only guarantee exactly where it was. Anything *else* Slack reports beyond the
 * mode's scopes is still drift.
 */
export const IMPLICIT_USER_SCOPES: readonly string[] = ['identify'];

export function doctor(input: DoctorInput): DoctorResult {
  const checks: Check[] = [];
  const { handoffs } = input;
  const command = (...words: string[]): Remedy => remedy(handoffs.own(words));
  // A workspace removed and connected again: the command, or with none here, the tools that do it and why not.
  const removeThenAdd = (alias: string): Remedy => {
    const remove = handoffs.own(['workspace', 'remove', alias]);
    return isCommand(remove)
      ? remedy([remove, ', then add it again'])
      : remedy(`slack_workspace_remove from a chat, then add it again. ${remove.message}`);
  };
  const workspaces = listWorkspaces(input.config).filter(
    (view) => input.workspace === undefined || view.alias === input.workspace,
  );

  for (const result of input.cleanup ?? []) {
    const tokens = result.tokens
      .map((token) => `${token.kind} ${token.status} (deadline ${token.deadline})`)
      .join('; ');
    checks.push({
      id: 'pending-revocation',
      title: `Old Slack credential cleanup for ${result.workspace}`,
      status: result.issue || result.tokens.some((token) => token.status === 'pending') ? 'warn' : 'ok',
      detail: `${tokens}; ${result.cleaned ? 'old bundle cleaned up' : 'pending revocation ledger entry retained for doctor'}${result.issue ? `; ${result.issue.message}` : ''}. Revoking these tokens does not remove the Slack app installation.`,
      fix: result.cleaned ? null : command('doctor'),
      workspace: null,
    });
  }

  if (workspaces.length === 0) {
    checks.push({
      id: 'workspaces',
      title: 'Workspaces',
      status: 'warn',
      detail: 'none connected yet',
      // The first step, not the last: `workspace add` needs a Client ID that does not exist until an app does,
      // and a fix somebody cannot run is not a fix.
      fix: remedy(
        handoffs.own(['manifest', '--port', '51234']),
        // Help reads no folder of this suite, so none is pinned.
        handoffs.own(['workspace', 'add', '--help'], { uses: [] }),
      ),
      workspace: null,
    });
  }

  for (const workspace of workspaces) {
    const bundle = input.bundles.get(workspace.alias) ?? null;

    if (bundle !== null && typeof bundle === 'object' && 'storeUnavailable' in bundle) {
      checks.push({
        id: 'credential',
        title: `Credential for ${workspace.alias}`,
        status: 'fail',
        detail: `the secret store could not be read, so the credential was not checked: ${bundle.storeUnavailable}`,
        // Not `reauth`: nothing says the credential is wrong, and re-authorising would discard a working one.
        fix: remedy(
          handoffsSentence(
            [handoffs.own(['doctor']), handoffs.core(['doctor'])],
            ([again, store]) =>
              `Unlock the keychain or approve its prompt, then run ${again} again; ${store} checks the store itself.`,
            'Unlock the keychain or approve its prompt, then call slack_doctor again; comms_doctor checks the store itself.',
          ),
        ),
        workspace: workspace.alias,
      });
      continue;
    }

    if (bundle === null || bundle === 'unreadable') {
      checks.push({
        id: 'credential',
        title: `Credential for ${workspace.alias}`,
        status: 'fail',
        detail:
          bundle === 'unreadable'
            ? 'the stored credential cannot be read; it is corrupt or from a newer version'
            : 'the configuration names a workspace with no stored token',
        fix: command('workspace', 'reauth', workspace.alias),
        workspace: workspace.alias,
      });
      continue;
    }

    /*
     * The token's own state, which is the one thing a person cannot see any other way.
     *
     * `refresh-uncertain` is not a transient error to retry past: it means a refresh token may already have been
     * spent, and the only safe recovery is a new authorisation. Saying so here is the difference between a
     * puzzling failure in a week and an instruction now.
     */
    if (bundle.state === 'refresh-uncertain') {
      /*
       * Why, when the credential says. The first real refresh failure has to be diagnosable from here, and
       * "interrupted" was printed for a token Slack had refused by name just as for a process killed mid-call.
       */
      const reason = bundle.reason;
      const why =
        reason?.kind === 'dead'
          ? reason.slackError
            ? `Slack said the refresh token is no longer valid (${reason.slackError})`
            : 'Slack renewed the token, but its reply held no credential this could use'
          : reason?.kind === 'uncertain'
            ? `a token refresh did not complete (${[
                reason.stage,
                reason.slackError,
                reason.httpStatus,
                reason.networkCode,
              ]
                .filter((part) => part !== undefined)
                .join(', ')}), and Slack refresh tokens cannot be retried safely`
            : 'a token refresh was interrupted, and Slack refresh tokens cannot be retried safely';
      checks.push({
        id: 'credential-state',
        title: `Sign-in for ${workspace.alias}`,
        status: 'fail',
        detail: reason?.at ? `${why}; at ${reason.at}` : why,
        fix: command('workspace', 'reauth', workspace.alias),
        workspace: workspace.alias,
      });
    } else if (bundle.state === 'refreshing') {
      checks.push({
        id: 'credential-state',
        title: `Sign-in for ${workspace.alias}`,
        status: 'warn',
        detail: 'a refresh is in flight',
        fix: null,
        workspace: workspace.alias,
      });
    } else {
      /*
       * An expired or unreadable expiry is not "valid until".
       *
       * This printed the stored string whatever it said, so a token that expired last week reported as valid
       * until last week — in the one command somebody runs to find out why nothing works.
       */
      const expiresAt = Date.parse(bundle.accessExpiresAt);
      checks.push({
        id: 'credential-state',
        title: `Sign-in for ${workspace.alias}`,
        status: Number.isFinite(expiresAt) ? (expiresAt > input.now.getTime() ? 'ok' : 'warn') : 'fail',
        detail: !Number.isFinite(expiresAt)
          ? `the stored expiry is not a date: ${bundle.accessExpiresAt}`
          : expiresAt > input.now.getTime()
            ? `access token valid until ${bundle.accessExpiresAt}`
            : `the access token expired ${bundle.accessExpiresAt}; it is renewed on the next call`,
        fix: Number.isFinite(expiresAt) ? null : command('workspace', 'reauth', workspace.alias),
        workspace: workspace.alias,
      });
    }

    /*
     * What Slack says this credential is, which is the only check here that can tell a revoked token from a
     * working one.
     *
     * Everything else reads files this package wrote, so it can only ever confirm that we still agree with
     * ourselves. A token revoked in Slack's own admin screens, or one belonging to somebody who has left the
     * workspace, looks perfect from disk.
     *
     * Not reaching Slack is reported as not having asked. An install is not broken because a laptop is on a
     * train, and a `doctor` that fails on a plane is one people learn to ignore.
     */
    const identity = input.identities?.get(workspace.alias);
    if (identity === undefined || identity.kind === 'unreachable') {
      checks.push({
        id: 'identity',
        title: `Slack's view of ${workspace.alias}`,
        status: 'unknown',
        detail: identity ? `could not ask Slack: ${identity.why}` : 'not asked',
        fix: null,
        workspace: workspace.alias,
      });
    } else if (identity.kind === 'rejected') {
      checks.push({
        id: 'identity',
        title: `Slack's view of ${workspace.alias}`,
        status: 'fail',
        detail: `Slack refused the stored token: ${identity.error}`,
        fix: command('workspace', 'reauth', workspace.alias),
        workspace: workspace.alias,
      });
    } else if (identity.workspaceId !== workspace.workspaceId || identity.userId !== workspace.userId) {
      /*
       * The token works and is somebody else's.
       *
       * Worse than a broken one, and invisible from disk: every later command would act as that account while
       * naming this one, and the audit trail would say what the configuration says rather than what happened.
       */
      checks.push({
        id: 'identity',
        title: `Slack's view of ${workspace.alias}`,
        status: 'fail',
        detail: `the stored token acts as ${identity.userId} in ${identity.workspaceId}, not ${workspace.userId} in ${workspace.workspaceId}`,
        fix: removeThenAdd(workspace.alias),
        workspace: workspace.alias,
      });
    } else {
      checks.push({
        id: 'identity',
        title: `Slack's view of ${workspace.alias}`,
        status: 'ok',
        detail: `Slack agrees: ${identity.userId} in ${identity.workspaceId}`,
        fix: null,
        workspace: workspace.alias,
      });
    }

    /*
     * The 30-day one, warned about before it bites.
     *
     * Slack expires refresh tokens issued to a PKCE app after 30 days. A workspace nobody has touched for a
     * month simply stops working, and the failure gives no hint that the clock was the cause — so the warning
     * has to arrive while re-authorising is still a choice.
     */
    if (bundle.refreshExpiresAt) {
      const remaining = Date.parse(bundle.refreshExpiresAt) - input.now.getTime();
      if (remaining <= 0) {
        checks.push({
          id: 'refresh-expiry',
          title: `Re-authorisation for ${workspace.alias}`,
          status: 'fail',
          detail: 'the refresh token expired; Slack expires them 30 days after they are issued',
          fix: command('workspace', 'reauth', workspace.alias),
          workspace: workspace.alias,
        });
      } else if (remaining <= REFRESH_EXPIRY_WARNING_MS) {
        checks.push({
          id: 'refresh-expiry',
          title: `Re-authorisation for ${workspace.alias}`,
          status: 'warn',
          detail: `the refresh token expires ${bundle.refreshExpiresAt}`,
          fix: command('workspace', 'reauth', workspace.alias),
          workspace: workspace.alias,
        });
      }
    }

    /*
     * Scope drift, checked with the same function `add` and `reauth` use.
     *
     * The scopes on a token can change under us: an admin can narrow an app, and Slack's optional scopes let a
     * person grant less than was asked for. `read` claiming to be unable to post is only true while this holds.
     */
    /*
     * A mode that is neither `read` nor `send` is a finding, not a crash — and not a guess.
     *
     * `doctor` is what somebody runs because something is wrong, so it must survive the thing being wrong. It
     * also must not quietly assume `read`: that would report a hand-edited typo as a healthy read-only install.
     */
    if (workspace.mode !== 'read' && workspace.mode !== 'send') {
      checks.push({
        id: 'scopes',
        title: `Permissions for ${workspace.alias}`,
        status: 'fail',
        detail: `the stored mode "${workspace.mode}" is neither "read" nor "send"`,
        fix: removeThenAdd(workspace.alias),
        workspace: workspace.alias,
      });
      continue;
    }
    const mode: InstallMode = workspace.mode;
    /*
     * Slack's list when Slack gave one, ours otherwise.
     *
     * Comparing the recorded scopes against the mode they were recorded for can only ever agree with itself —
     * it catches a bug in this package and nothing that happened in Slack. An admin narrowing an app is exactly
     * the drift this check is named for, and it is invisible from disk.
     */
    /*
     * What Slack reported, split into what is compared and what Slack adds on its own — kept apart so the result
     * can say both. Reporting the filtered count as "exactly as Slack reports them" was an understatement by one
     * scope in text people read to check what a token can do.
     */
    const reported = identity?.kind === 'ok' ? identity.scopes : undefined;
    const observed = reported?.filter((scope) => !IMPLICIT_USER_SCOPES.includes(scope));
    const implicit = reported?.filter((scope) => IMPLICIT_USER_SCOPES.includes(scope)) ?? [];
    const { missing, extra } = scopeMismatch(mode, observed ?? workspace.grantedScopes);
    if (missing.length > 0 || extra.length > 0) {
      checks.push({
        id: 'scopes',
        title: `Permissions for ${workspace.alias}`,
        status: 'fail',
        detail: [
          missing.length > 0 ? `missing ${missing.join(', ')}` : '',
          extra.length > 0 ? `more than "${mode}" allows: ${extra.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; '),
        fix: command('workspace', 'reauth', workspace.alias, '--mode', mode),
        workspace: workspace.alias,
      });
    } else {
      checks.push({
        id: 'scopes',
        title: `Permissions for ${workspace.alias}`,
        status: 'ok',
        detail: observed
          ? `${mode}: the ${observed.length} scopes it asked for, as Slack reports them${
              implicit.length > 0 ? ` (plus ${implicit.join(', ')}, which Slack adds to every user token)` : ''
            }`
          : `${mode}: ${workspace.grantedScopes.length} scopes, exactly as recorded at sign-in`,
        fix: null,
        workspace: workspace.alias,
      });
    }

    /*
     * Whether a file can be posted, from the same scopes as above. A read install that cannot is working as the
     * person chose, so it is `ok` and says so in words — a warning there would warn on every healthy read install.
     * A send install without `files:write` can post words but not files, and only a sign-in brings the scope back.
     */
    const scopes = observed ?? workspace.grantedScopes;
    checks.push(
      mode === 'read'
        ? {
            id: 'files',
            title: `Sending files from ${workspace.alias}`,
            status: 'ok',
            detail: 'read mode: it cannot post or send files, by choice',
            fix: null,
            workspace: workspace.alias,
          }
        : scopes.includes('files:write')
          ? {
              id: 'files',
              title: `Sending files from ${workspace.alias}`,
              status: 'ok',
              detail: 'can send files: send mode, and files:write is granted',
              fix: null,
              workspace: workspace.alias,
            }
          : {
              id: 'files',
              title: `Sending files from ${workspace.alias}`,
              status: 'fail',
              detail: 'send mode, but files:write is not granted: it can post words and cannot send files',
              fix: command('workspace', 'reauth', workspace.alias, '--mode', 'send'),
              workspace: workspace.alias,
            },
    );

    /*
     * Whether an agent's posts can go out as the app (design 2026-10-15 S1, revised; Review focus 1). The PKCE sign-in
     * cannot ask Slack for bot scopes, so a send workspace has the app's bot token only once it was pasted or came with
     * a client-secret sign-in — and only if it is actually stored here, which is read, not inferred from the bot user
     * the account records. Until then its agent's posts take the labelled fallback: never unlabelled, never refused.
     */
    if (mode === 'send') {
      const token = input.appTokens?.get(workspace.alias);
      const title = `Posting as the app from ${workspace.alias}`;
      /*
       * The workspace's style (the owner's decision, 2026-10-17, S2): under `labelled`, every agent post goes out as the
       * person, labelled, wherever the app could post, because they chose it. So the app's token changes nothing an
       * agent posts, and there is nothing to do: a note, as a profile workspace's is, with no way to a bot token offered
       * and no warning that the app has none. Under `app`, the default, the findings below are as they were.
       */
      const labelled = slackStyleOf(labelSettingsOf(input.config), workspace.accountId) === 'labelled';
      if (labelled) {
        checks.push({
          id: 'app-identity',
          title,
          status: 'ok',
          detail:
            "you chose labelled posts for this workspace, so an agent's posts go out as you, labelled in their text, even where the app could post. The core's `label style` (comms_label with `style`) set back to app posts as the app where it can",
          fix: null,
          workspace: workspace.alias,
        });
      } else if (workspace.appUserId !== undefined && token === 'stored') {
        checks.push({
          id: 'app-identity',
          title,
          status: 'ok',
          detail: `an agent's posts go out as the app (bot user ${workspace.appUserId}), named after you and labelled, where the app can post`,
          fix: null,
          workspace: workspace.alias,
        });
      } else if (workspace.appUserId !== undefined && (token === undefined || token === 'unknown')) {
        checks.push({
          id: 'app-identity',
          title,
          status: 'unknown',
          detail:
            "whether the app's bot token is stored could not be read, so whether posts go out as the app is not known",
          fix: null,
          workspace: workspace.alias,
        });
      } else if (
        workspace.appUserId === undefined &&
        appTokenRevokedOf(lookupName(input.config, 'account', workspace.alias)) !== undefined
      ) {
        /*
         * Slack refused the stored bot token on an act made with it, and it was forgotten (CUE-493): say when, and what
         * brings one back. A profile's agent app has one token its admin reissues; a person's own app connected with
         * its client secret gets a new one from that sign-in; one whose token was pasted gets it pasted again.
         */
        const account = lookupName(input.config, 'account', workspace.alias);
        const revoked = appTokenRevokedOf(account);
        const on = revoked?.at.slice(0, 10) ?? 'an unknown date';
        const paste = handoffs.own(['workspace', 'bot', workspace.alias]);
        const fix =
          workspace.organisation !== undefined
            ? handoffSentence(
                paste,
                (command) =>
                  `Ask your organisation's admin for the agent app's new token, then run ${command} in your own terminal and paste it there, never into a chat.`,
                {
                  instead:
                    "Ask your organisation's admin for the agent app's new token, then paste it with `workspace bot` in your own terminal.",
                },
              )
            : account !== undefined && clientSecretRefOf(account) !== undefined
              ? handoffSentence(
                  handoffs.own(['workspace', 'reauth', workspace.alias, '--mode', 'send', '--with-client-secret']),
                  (command) =>
                    `Sign in again with the app's client secret, which brings a new bot token: ${command}, in your own terminal.`,
                  { instead: "Sign in again with the app's client secret, at your own terminal." },
                )
              : handoffSentence(
                  paste,
                  (command) =>
                    `Copy the app's new "Bot User OAuth Token" from its OAuth & Permissions page, then run ${command} in your own terminal and paste it there.`,
                  { instead: "Paste the app's new bot token with `workspace bot` in your own terminal." },
                );
        checks.push({
          id: 'app-identity',
          title,
          status: 'warn',
          detail: `the app's bot token was revoked on ${on} (Slack said ${displayed(revoked?.slackError)} when an act was made with it), so it was removed from this machine, and an agent's posts go out as you, labelled in their text`,
          fix: remedy(fix),
          workspace: workspace.alias,
        });
      } else if (
        workspace.organisation !== undefined &&
        organisationAgentApp(input.config, workspace.organisation, workspace.workspaceId) !== undefined
      ) {
        /*
         * Connected through an organisation profile that names its agent app (CUE-493): the organisation's bot-only
         * app, whose one non-rotating token its admin shares. Pasting it is the one way, and changes nothing else of the
         * member's connection. A warning, as an own app missing its token is: there is something to do, and it is
         * theirs to choose — a member who does nothing keeps the labelled fallback.
         */
        const agent = organisationAgentApp(input.config, workspace.organisation, workspace.workspaceId);
        checks.push({
          id: 'app-identity',
          title,
          status: 'warn',
          detail: `no app bot token is stored for it, so an agent's posts go out as you, labelled in their text. Your organisation's profile names its agent app (${displayed(agent?.appId)}), whose bot token its admin shares with members: pasted here once, an agent's posts go out as that app`,
          fix: remedy(
            handoffSentence(
              handoffs.own(['workspace', 'bot', workspace.alias]),
              (command) =>
                `Ask your organisation's admin for the agent app's token, then run ${command} in your own terminal and paste it there, never into a chat.`,
              {
                instead:
                  "Ask your organisation's admin for the agent app's token, then paste it with `workspace bot` in your own terminal, never into a chat.",
              },
            ),
          ),
          workspace: workspace.alias,
        });
      } else if (workspace.organisation !== undefined) {
        /*
         * Connected through an organisation profile's shared app, whose profile names no agent app. Neither way works
         * for the shared app itself: the client-secret sign-in refuses a profile account — the administrator holds the
         * secret, not its members — and paste-once refuses the rotating token an organisation's app has. So this names
         * no command. What can change it is the organisation's (CUE-493): its admin adds an agent app to its profile,
         * and this check then says what the member does. And it is `ok`, a note rather than a warning, as the read
         * install's `files` row is: posting as the person, labelled, is how such a workspace works until then, nothing
         * its person can do changes that, and a warning on every healthy one is one people stop reading.
         */
        checks.push({
          id: 'app-identity',
          title,
          status: 'ok',
          detail:
            "connected through an organisation profile, so an agent's posts go out as you, labelled in their text. Posting as an app becomes possible once your organisation's admin adds an agent app to its profile; this check then says what to do",
          fix: null,
          workspace: workspace.alias,
        });
      } else {
        /*
         * A person's own app, and only a way that can work for it.
         *
         * - Connected with its client secret, it lacks only its bot token: signing in again with the secret brings it.
         * - Connected by PKCE, as the standard manifest's app is, it cannot get one: Slack refuses bot scopes to a PKCE
         *   app, and PKCE cannot be turned off on an existing one. What the 2026-10-16 live check proved works is a new
         *   app with PKCE off, connected in place of this one, since one connection per person per workspace is kept.
         * - Paste-once, either way, only where its credential does not rotate: rotation is the app's setting, so a
         *   rotating credential says the bot token on the app's page rotates too, and paste-once refuses that.
         */
        const account = lookupName(input.config, 'account', workspace.alias);
        const secretApp = account !== undefined && clientSecretRefOf(account) !== undefined;
        const pasteOnce = !rotates(bundle);
        const reauth = handoffs.own(['workspace', 'reauth', workspace.alias, '--mode', 'send', '--with-client-secret']);
        const way = secretApp
          ? 'sign in again with its client secret, which brings the bot token'
          : 'connect it through a new app with PKCE off, in three steps: it signs in with PKCE, Slack gives a PKCE app no bot token, and PKCE cannot be turned off on an existing app';
        const notPasted = pasteOnce
          ? ''
          : ". Pasting its bot token is not offered: this app's tokens rotate, so a pasted one would stop working within twelve hours, and pasting refuses it";
        const newApp = [
          handoffSentence(
            handoffs.own(['manifest', '--mode', 'send', '--with-client-secret']),
            (command) =>
              `1. Create a new app from ${command}, which picks its own free port (a workspace on Slack's free plan holds at most 10 apps).`,
            {
              instead:
                "1. Create a new app from the send manifest with PKCE off (slack_manifest with mode send and pkce false), which picks its own free port (a workspace on Slack's free plan holds at most 10 apps).",
            },
          ),
          handoffSentence(
            handoffs.own(['workspace', 'remove', workspace.alias]),
            (command) => `2. Remove this connection: ${command}. Only one connection per person per workspace is kept.`,
            {
              instead:
                '2. Remove this connection with slack_workspace_remove. Only one connection per person per workspace is kept.',
            },
          ),
          handoffSentenceToFill(
            handoffs.own(['workspace', 'add', workspace.alias, '--mode', 'send']),
            ['--client-id', '<id>', '--port', '<port>', '--with-client-secret'],
            (command) =>
              `3. Connect the new app, in your own terminal, with its Client ID and port: ${command}. It asks for the Client Secret without showing it.`,
            {
              instead:
                '3. Connect the new app in your own terminal, with `workspace add`, its Client ID and port, and `--with-client-secret`.',
            },
          ),
        ];
        const paste = [
          handoffs.own(['workspace', 'bot', workspace.alias]),
          ' — paste the "Bot User OAuth Token" once, from the app’s OAuth & Permissions page after Install to Workspace; or',
        ];
        checks.push({
          id: 'app-identity',
          title,
          status: 'warn',
          detail: `no app bot token is stored for it, so an agent's posts go out as you, labelled in their text. To post as the app, ${
            pasteOnce ? 'paste its bot token once, or ' : ''
          }${way}${notPasted}`,
          fix: secretApp
            ? remedy(...(pasteOnce ? [paste] : []), [reauth, ' — sign in again with the app’s client secret'])
            : remedy(...(pasteOnce ? [paste] : []), ...newApp),
          workspace: workspace.alias,
        });
      }

      /*
       * The stored token against the agent app the profile names now (CUE-493). The paste checks it against the agent
       * app the profile named then — and a token pasted before the organisation added its agent-app file was checked
       * against none. So doctor asks again, as the paste asks, and says when it is another app's: posts go out as
       * that app, under the APP badge, not as the organisation's. Not under the `labelled` style, where no agent post
       * goes out as any app: switched back to `app`, it is asked again.
       */
      const agent =
        workspace.organisation === undefined || labelled
          ? undefined
          : organisationAgentApp(input.config, workspace.organisation, workspace.workspaceId);
      if (agent !== undefined && token === 'stored') {
        const probe = input.agentApps?.get(workspace.alias);
        const agentTitle = `The agent app for ${workspace.alias}`;
        const expected = displayed(agent.appId);
        if (probe?.kind === 'match') {
          checks.push({
            id: 'agent-app',
            title: agentTitle,
            status: 'ok',
            detail: `the bot token stored is ${displayed(workspace.organisation)}'s agent app's (${expected}), as Slack says`,
            fix: null,
            workspace: workspace.alias,
          });
        } else if (probe?.kind === 'other') {
          checks.push({
            id: 'agent-app',
            title: agentTitle,
            status: 'warn',
            detail: `the bot token stored is the app ${probe.appId}${probe.name ? ` ("${probe.name}")` : ''}'s, not ${displayed(workspace.organisation)}'s agent app, ${expected}, which its profile names: an agent's posts go out as that other app`,
            fix: remedy(
              handoffSentence(
                handoffs.own(['workspace', 'bot', workspace.alias]),
                (command) =>
                  `Ask your organisation's admin for the agent app's token, then run ${command} in your own terminal and paste it there, never into a chat.`,
                {
                  instead:
                    "Ask your organisation's admin for the agent app's token, then paste it with `workspace bot` in your own terminal, never into a chat.",
                },
              ),
            ),
            workspace: workspace.alias,
          });
        } else {
          checks.push({
            id: 'agent-app',
            title: agentTitle,
            status: 'unknown',
            detail:
              probe === undefined
                ? `whether the bot token stored is ${displayed(workspace.organisation)}'s agent app's (${expected}) was not checked: Slack was not asked`
                : `whether the bot token stored is ${displayed(workspace.organisation)}'s agent app's (${expected}) could not be checked: ${probe.why}`,
            fix: null,
            workspace: workspace.alias,
          });
        }
      }
    }
  }

  /*
   * The rate-limit tier: expected, and observed only from evidence already gathered.
   *
   * This wanted to be a probe, and it cannot be one. Slack publishes no remaining/limit headers, states burst
   * tolerance deliberately loosely, and says `conversations.history` may return fewer items than asked for even
   * when more remain — so a short page proves nothing and a single 429 proves throttling rather than a tier. The
   * only way to observe the cap is to spend the budget being measured, and a diagnostic that degrades what it
   * diagnoses is worse than one that says it does not know.
   *
   * So: what an internal customer-built app should have, and whatever ordinary reads have already seen. Until
   * S3 does any reading there is nothing in the second half, and it says so rather than implying health.
   */
  const evidence = input.rateEvidence;
  checks.push({
    id: 'rate-limit',
    title: 'Rate limit',
    status: evidence?.lastThrottledAt ? 'warn' : 'unknown',
    detail: evidence?.lastThrottledAt
      ? `expected Tier 3; throttled at ${evidence.lastThrottledAt}${
          evidence.retryAfterSeconds ? ` (Retry-After ${evidence.retryAfterSeconds}s)` : ''
        }`
      : 'expected Tier 3 for an internal app; not yet observed',
    fix: evidence?.lastThrottledAt
      ? remedy('If this repeats, check the app is still internal to your workspace rather than distributed.')
      : null,
    workspace: null,
  });

  checks.push(...registrationChecks(input));

  const summary = {
    ok: checks.filter((check) => check.status === 'ok').length,
    unknown: checks.filter((check) => check.status === 'unknown').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
  };
  return { healthy: summary.fail === 0, summary, checks, ...(input.cleanup ? { cleanup: input.cleanup } : {}) };
}

/** A value read back from the configuration, as a finding shows it: neutralised and on one line. */
function displayed(value: unknown): string {
  return shownText(value, 64);
}

/** Whether the person's own credential shows its app rotates tokens: a refresh token, a refresh expiry, or a refresh under way or spent. */
function rotates(bundle: TokenBundle): boolean {
  return bundle.refreshToken !== undefined || bundle.refreshExpiresAt !== undefined || bundle.state !== 'ready';
}

export interface DoctorRun {
  /** Ask Slack nothing; report only what the files say. */
  readonly offline?: boolean | undefined;
  /** Check only this workspace. A name that is not connected is refused, not reported as a clean install. */
  readonly workspace?: string | undefined;
  /** The fetch `auth.test` goes through. Injected so a test never reaches the real Slack. */
  readonly probe?: ProbeFetch | undefined;
  /**
   * The session the agent-app check goes through (`probeAgentApp`): `auth.test` with the stored bot token, and
   * `bots.info` with the member's own. Injected so a test never reaches the real Slack.
   */
  readonly session?: SessionDeps | undefined;
}

/**
 * Reads everything `doctor` judges, and judges it — for `agent-slack doctor` and `slack_doctor` alike.
 *
 * The reading used to live in the CLI command, and `doctor` above only judged what it was handed. A tool that
 * gathered its own inputs would have been a second reading of the same files, free to disagree with the first about
 * a locked keychain or a token that is due; so the command and the tool both call this, and get one answer.
 */
export async function runDoctor(context: SlackContext, options: DoctorRun = {}): Promise<DoctorResult> {
  let config = await context.config();
  // Resolved first, so a name that is not connected is an error and not an empty, healthy report.
  const { handoffs } = context;
  const only =
    options.workspace === undefined ? undefined : requireWorkspace(config, options.workspace, handoffs).alias;
  const workspaceId = only === undefined ? undefined : requireWorkspace(config, only, handoffs).account.workspace;
  const cleanup =
    options.offline === true
      ? Object.freeze(
          (config.pendingRevocations ?? [])
            .filter(
              (entry) => entry.platform === 'slack' && (workspaceId === undefined || entry.workspace === workspaceId),
            )
            .map((entry) => pendingRevocationResult(entry, false)),
        )
      : await retryPendingRevocations(context, workspaceId);
  if (options.offline !== true) config = await context.config();
  const bundles = new Map<string, TokenBundle | null | 'unreadable' | StoreUnavailable>();
  const appTokens = new Map<string, 'stored' | 'missing' | 'unknown'>();
  /*
   * A store that will not open is one finding per workspace, not a crash: a keychain module missing, or a keychain
   * that is locked, says nothing about any credential inside it.
   */
  let secrets: SecretStore | null = null;
  let storeProblem: string | null = null;
  try {
    secrets = await context.secrets();
  } catch (error) {
    storeProblem = toCommsError(error).message;
  }
  for (const view of listWorkspaces(config)) {
    if (only !== undefined && view.alias !== only) continue;
    const account = lookupName(config, 'account', view.alias);
    if (!account) continue;
    // Whether the app's bot token is stored, for a send workspace (S1, revised): read, never inferred.
    if ((account.mode ?? account.tier) === 'send') {
      if (secrets === null) appTokens.set(view.alias, 'unknown');
      else {
        try {
          appTokens.set(view.alias, (await secrets.get(botSecretRefFor(account.id))) === null ? 'missing' : 'stored');
        } catch {
          appTokens.set(view.alias, 'unknown');
        }
      }
    }
    if (secrets === null) {
      bundles.set(view.alias, { storeUnavailable: storeProblem ?? 'the secret store could not be opened' });
      continue;
    }
    let raw: string | null;
    try {
      raw = await secrets.get(account.secretRef);
    } catch (error) {
      /*
       * The store refusing is not the credential being corrupt.
       *
       * Both were reported as unreadable, whose fix is `reauth` — which, for a keychain that only wanted unlocking
       * or a prompt approving, throws away a refresh token that was fine all along.
       */
      bundles.set(view.alias, { storeUnavailable: toCommsError(error).message });
      continue;
    }
    try {
      bundles.set(view.alias, parseBundle(raw, handoffs));
    } catch {
      /*
       * An unreadable credential is a finding, not a crash — `doctor` is what somebody runs *because* something is
       * wrong, so it has to survive the thing being wrong.
       *
       * Reported as unreadable rather than as absent, which is a different problem with a different fix. Collapsing
       * the two said "no stored token" for a credential that is very much stored, and sent people to
       * `workspace add` — which then refuses it as already connected.
       */
      bundles.set(view.alias, 'unreadable');
    }
  }
  /*
   * One call per workspace, and only for a credential that could possibly work.
   *
   * `offline` leaves identity and pending revocation requests unsent, while still reporting what the files know.
   * Somebody diagnosing a machine with no network deserves those local findings. A failure to reach Slack is
   * reported as not having asked, never as a problem with the install.
   */
  const identities = new Map<string, IdentityProbe>();
  if (options.offline !== true && secrets !== null) {
    for (const [alias, bundle] of bundles) {
      if (bundle === null || typeof bundle !== 'object' || 'storeUnavailable' in bundle) continue;
      /*
       * Renewed first when it is due, then asked about.
       *
       * This used to skip any token past its expiry, on the reasoning that Slack would refuse it and the refusal
       * would read as a credential problem. True, and it meant the ordinary state of a workspace nobody had used
       * today — expired, and perfectly refreshable — was never checked at all. A refresh is what the next read would
       * do anyway, through exactly the same locks, so `doctor` does it and then checks the token that results.
       *
       * Only a `ready` credential is renewed. One that is `refresh-uncertain` must not be, and the credential-state
       * check already says what is wrong with it.
       */
      let token = bundle.accessToken;
      if (isExpired(bundle, context.now()) || (bundle.state === 'ready' && isDue(bundle, context.now()))) {
        if (bundle.state !== 'ready') continue;
        try {
          token = (await openWorkspace(context, alias)).call.token;
        } catch (error) {
          const failure = toCommsError(error);
          identities.set(alias, { kind: 'unreachable', why: `the token could not be renewed: ${failure.message}` });
        }
        // Whatever the refresh left behind is what the state check should describe.
        try {
          const account = lookupName(config, 'account', alias);
          if (account) {
            secrets.invalidate(account.secretRef);
            bundles.set(alias, parseBundle(await secrets.get(account.secretRef), handoffs));
          }
        } catch {
          // The earlier read stands; the identity check below says whether the token works.
        }
        if (identities.has(alias)) continue;
      }
      identities.set(
        alias,
        await probeIdentity({ ...bundle, accessToken: token }, options.probe ? { fetch: options.probe } : {}),
      );
    }
  }
  /*
   * A stored bot token against the agent app its organisation's profile names (CUE-493), asked as the paste asks: one
   * pasted before the profile named the app was checked against nothing. Online only, and only where there is
   * something to check.
   */
  const agentApps = new Map<string, AgentAppProbe>();
  if (options.offline !== true && secrets !== null) {
    for (const view of listWorkspaces(config)) {
      if (only !== undefined && view.alias !== only) continue;
      const account = lookupName(config, 'account', view.alias);
      if (!account || appTokens.get(view.alias) !== 'stored' || view.organisation === undefined) continue;
      // Under the `labelled` style no agent post goes out as any app, and doctor reports nothing of it: Slack is not asked.
      if (slackStyleOf(labelSettingsOf(config), view.accountId) === 'labelled') continue;
      const agent = organisationAgentApp(config, view.organisation, view.workspaceId);
      if (agent === undefined) continue;
      let stored: string | undefined;
      try {
        stored = parseBundle(await secrets.get(botSecretRefFor(account.id)), handoffs)?.accessToken;
      } catch {
        stored = undefined;
      }
      agentApps.set(
        view.alias,
        stored === undefined
          ? { kind: 'unknown', why: 'the stored bot token could not be read' }
          : await probeAgentApp(context, view.alias, view.organisation, stored, agent.appId, options.session),
      );
    }
  }
  /*
   * What the MCP clients have registered: other Slack servers, and whether our own entries run this release and
   * still start. Read from their config files, so it needs no network and is done offline too.
   */
  const registeredServers = await listRegisteredServers(context.env);
  const missingFiles = new Map<RegisteredServer, string>();
  for (const server of registeredServers.filter((entry) => isProductServer(entry, SLACK_MCP))) {
    const missing = await missingEntryFile(server);
    if (missing) missingFiles.set(server, missing);
  }
  return doctor({
    config,
    now: context.now(),
    handoffs,
    bundles,
    appTokens,
    agentApps,
    identities,
    registeredServers,
    missingFiles,
    cleanup,
    ...(only === undefined ? {} : { workspace: only }),
  });
}

/**
 * The command that re-registers *this* entry, not a default one.
 *
 * A generic `mcp install --force` would turn a server registered under its own name, or pinned to one workspace,
 * into the default: every workspace, under another name. That is a widening of what an agent may reach, not a
 * repair — so the flags are read back off the entry that is there.
 */
function repairCommand(server: RegisteredServer, handoffs: CliHandoffs): Remedy {
  // Every write targets user scope; a project-scoped entry cannot be reached by any flag, so the honest answer
  // is the manual one.
  if (server.scope === 'project') {
    const byHand = `remove "${server.name}" from the project entry in ${server.path} by hand`;
    return remedy(
      handoffSentence(
        handoffs.own(['mcp', 'install', '--client', server.client, '--standalone']),
        (command) => `${byHand}, then re-run ${command}`,
        { instead: `${byHand}, then register it again.` },
      ),
    );
  }
  // An entry of its own, repaired as one: `mcp install` alone puts Slack into the app's connection (D17).
  const words = ['mcp', 'install', '--client', server.client, '--standalone'];
  if (server.name !== SLACK_MCP.defaultServerName) words.push('--name', server.name);
  const pinned = server.args[server.args.indexOf('--workspace') + 1];
  if (server.args.includes('--workspace') && pinned) words.push('--workspace', pinned);
  if (server.args.some((argument) => argument.startsWith(`${SLACK_MCP.npxPackage}@`))) {
    words.push('--launcher', 'npx');
  }
  words.push('--force');
  return remedy(handoffs.own(words));
}

/**
 * What the MCP clients on this machine have registered: other Slack servers, and our own entries' versions.
 *
 * An entry pins an exact version, so that upgrading the package elsewhere cannot change what an agent runs. The
 * silent half of that trade is that a new release reaches no client until somebody re-registers, and nothing
 * said so: the Slack entry on the author's machine would have gone on running 0.4.0 through every upgrade.
 */
function registrationChecks(input: DoctorInput): Check[] {
  const servers = input.registeredServers;
  if (servers === undefined) {
    return [
      {
        id: 'other-slack-servers',
        title: 'Other Slack MCP servers',
        status: 'unknown',
        detail: 'not checked on this machine',
        fix: null,
        workspace: null,
      },
      {
        id: 'registered-server-version',
        title: 'Registered server version',
        status: 'unknown',
        detail: 'not checked on this machine',
        fix: null,
        workspace: null,
      },
    ];
  }
  const checks: Check[] = [];

  const others = findOtherSlackServers(servers, SLACK_MCP);
  checks.push({
    id: 'other-slack-servers',
    title: 'Other Slack MCP servers',
    status: others.length > 0 ? 'warn' : 'ok',
    detail:
      others.length > 0
        ? `also registered: ${others.map(describeOtherSlackServer).join(', ')}; an agent can post through those without any approval here`
        : // What a config-file scan cannot see, said rather than implied away.
          'none in the MCP clients’ config files (servers added by plugins, claude.ai connectors or bridges are not visible from here)',
    // Called with the server alone: handed to `map` directly, its index would be taken for the shell to quote for.
    fix:
      others.length > 0
        ? remedy(...others.map((server) => otherSlackServerRemoval(server, input.handoffs.platform)))
        : null,
    workspace: null,
  });

  const ours = servers.filter((server) => isProductServer(server, SLACK_MCP));
  const stale = ours
    .map((server) => ({
      server,
      // What it pins, or — for the stable launcher — the release its pointer names (design 2026-10-16, U6).
      version: registrationVersion(server, SLACK_MCP),
    }))
    .filter((entry): entry is { server: RegisteredServer; version: string } => Boolean(entry.version))
    .filter((entry) => entry.version !== VERSION);
  /*
   * A scan that found none of ours is a finding, not a pass. It was `ok` with "not registered with any MCP client"
   * beside it — green, over a machine where no client could reach the server — and green is read as "checked, and
   * fine". So it warns, with the command that registers it: something to look at rather than a fault, since a
   * plugin or an extension can start the server where this scan of config files cannot see, and a machine used only
   * from the command line needs no registration. A scan that never ran is `unknown` above, not this.
   */
  const none = ours.length === 0;
  checks.push({
    id: 'registered-server-version',
    title: 'Registered server version',
    status: stale.length > 0 || none ? 'warn' : 'ok',
    detail:
      stale.length > 0
        ? stale
            .map(
              (entry) =>
                `${entry.server.client} runs ${entry.version} as "${entry.server.name}"; this release is ${VERSION}`,
            )
            .join('; ')
        : none
          ? "none registered: no MCP client's config file starts this server (one a plugin or an extension starts is not visible from here)"
          : `this release, ${VERSION}`,
    fix:
      stale.length > 0
        ? remedy(...stale.map((entry) => repairCommand(entry.server, input.handoffs)))
        : none
          ? // Help reads no folder of this suite, so none is pinned.
            remedy(input.handoffs.own(['mcp', 'install', '--help'], { uses: [] }))
          : null,
    workspace: null,
  });

  for (const server of ours) {
    const missing = input.missingFiles?.get(server);
    checks.push({
      id: 'mcp-command',
      title: `MCP entry "${server.name}" (${server.client})`,
      status: missing ? 'fail' : 'ok',
      detail: missing ? `${missing} is not there any more` : [server.command, ...server.args].join(' '),
      fix: missing ? repairCommand(server, input.handoffs) : null,
      workspace: null,
    });
  }
  return checks;
}
