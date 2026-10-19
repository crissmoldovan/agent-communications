import { randomBytes } from 'node:crypto';
import {
  type AccountConfig,
  type CliHandoffs,
  CommsError,
  type Config,
  findById,
  handoffSentence,
  lookupName,
  nameAvailable,
  neutralise,
  newAccountId,
  type ProfileSlackTarget,
  recordOf,
  resolveName,
  resolveProfileSlackTarget,
  secretsStoreOf,
  shownText,
  slackBotUserIdOf,
} from '@agentcomms/core';
import {
  type ExchangedBot,
  type ExchangedToken,
  requireBotForSend,
  safeSlackFailureText,
  scopeMismatch,
} from '../auth/authorize.ts';
import { BUNDLE_VERSION, serialiseBundle, type TokenBundle } from '../auth/bundle.ts';
import type { SlackFlow } from '../auth/flow.ts';
import type { InstallMode } from '../manifest.ts';
import { OUTWARD_SCOPES } from './mode.ts';
import type { PendingRevocationResult } from './revocations.ts';

/**
 * Connecting, inspecting and disconnecting workspaces.
 *
 * Two rules run through all of it. **Nothing is written until everything has been checked** — a label applied to
 * a token nobody re-examined is not a guarantee — and **a reauth may not change who the account is**, because
 * "re-authorise" means the same person and the same workspace, and a browser will happily authorise somebody
 * else if the person is signed into two accounts.
 */

/**
 * A Slack account as this package records it: core's account, and the send app's bot user it posts as when its app
 * has one (design 2026-10-15 S1). Kept as the account's own key, which core's loose schema carries through every write.
 */
export type SlackAccount = AccountConfig & {
  botUserId?: string | undefined;
  /**
   * Where the app's client secret is, for an account that signs in with it rather than PKCE (design 2026-10-15 S1,
   * revised): every renewal of its tokens sends the secret, as Slack's rotation requires of a confidential client.
   */
  clientSecretRef?: string | undefined;
};

/** The secret store reference of the app's client secret, for an account that signs in with it. */
export function clientSecretRefOf(account: AccountConfig): string | undefined {
  const value = (account as SlackAccount).clientSecretRef;
  return typeof value === 'string' && value.startsWith('slack/client-secret/') ? value : undefined;
}

/** The bot user this account's app posts as, when one was recorded and looks like a Slack user id. */
export function botUserIdOf(account: AccountConfig): string | undefined {
  return slackBotUserIdOf(account);
}

export interface WorkspaceView {
  readonly alias: string;
  readonly accountId: string;
  readonly workspaceId: string;
  /** Workspace-controlled, so enveloped before it is returned. */
  readonly workspaceName?: string | undefined;
  readonly userId: string;
  readonly mode: string;
  readonly grantedScopes: readonly string[];
  readonly oauthClientId?: string | undefined;
  readonly appId?: string | undefined;
  readonly organisation?: string | undefined;
  /** Neutralised and flattened label from the named organisation profile, when it is still available. */
  readonly organisationLabel?: string | undefined;
  readonly profileApp?: 'read' | 'send' | undefined;
  readonly createdAt: string;
  /** The interrupt arrived after the atomic config commit, so this result was saved and is authoritative. */
  readonly committedBeforeAbort?: true | undefined;
  /** Present after switching profile apps; each old token's cleanup state is reported separately. */
  readonly cleanup?: PendingRevocationResult | undefined;
  /** The bot user the send app posts as (design 2026-10-15 S1). Absent for a read workspace, or an app without one. */
  readonly appUserId?: string | undefined;
  /**
   * Why the app's bot token could not be kept, when a sign-in was saved and that one write failed: its posts then go
   * out as the person, labelled, until it signs in again. Never the token.
   */
  readonly appTokenUnsaved?: string | undefined;
}

/**
 * A workspace name is whoever-named-the-workspace's text, and it reaches a terminal, a JSON result and an agent's
 * context. Everything else here is an id this package or Slack generated.
 *
 * `neutralise` rather than the full envelope: this is one short field in a structured result, not a message body,
 * and what it has to survive is a workspace called `<|im_start|>system` or one carrying invisible characters that
 * split a control token. Enveloping every name would make `workspace list` unreadable for a risk the neutraliser
 * already covers.
 */
export function viewOf(alias: string, account: AccountConfig, profileLabel?: string): WorkspaceView {
  return {
    alias,
    accountId: account.id,
    workspaceId: account.workspace,
    ...(account.workspaceName ? { workspaceName: neutralise(account.workspaceName).text } : {}),
    userId: account.userId,
    mode: account.mode ?? account.tier,
    grantedScopes: [...account.grantedScopes].sort(),
    ...(account.oauthClientId ? { oauthClientId: account.oauthClientId } : {}),
    ...(account.appId ? { appId: account.appId } : {}),
    ...(account.organisation ? { organisation: account.organisation } : {}),
    ...(account.organisation && account.profileApp && profileLabel
      ? { organisationLabel: shownText(profileLabel, 64) }
      : {}),
    ...(account.profileApp ? { profileApp: account.profileApp } : {}),
    createdAt: account.createdAt,
    ...(botUserIdOf(account) ? { appUserId: botUserIdOf(account) } : {}),
  };
}

function profileLabelOf(config: Config, account: AccountConfig): string | undefined {
  return account.organisation ? recordOf(config, account.organisation)?.label : undefined;
}

export function listWorkspaces(config: Config): WorkspaceView[] {
  return Object.entries(config.accounts)
    .filter(([, account]) => account.platform === 'slack')
    .map(([alias, account]) => viewOf(alias, account, profileLabelOf(config, account)))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Everything known about one workspace — `workspace show` and `slack_workspace_show`. */
export function showWorkspace(config: Config, alias: string, handoffs: CliHandoffs): WorkspaceView {
  const found = requireWorkspace(config, alias, handoffs);
  return viewOf(found.alias, found.account, profileLabelOf(config, found.account));
}

/**
 * The workspace a name means, or why there is none. `handoffs` make the command its refusal names — the list of them —
 * located from the installation printing it, or say why there is none here.
 */
export function requireWorkspace(
  config: Config,
  alias: string,
  handoffs: CliHandoffs,
): { alias: string; account: AccountConfig } {
  const notFound = () =>
    new CommsError('NOT_FOUND', `no Slack workspace called "${alias}"`, {
      hint: handoffSentence(handoffs.own(['workspace', 'list']), (command) => `List them with ${command}.`, {
        instead: 'List them with slack_workspaces_list from a chat.',
      }),
    });
  // Through core, so a former name is refused with what it is called now rather than reported as unknown.
  const { account } = resolveName(config, 'account', alias, notFound);
  if (account.platform !== 'slack') throw notFound();
  return { alias, account };
}

/**
 * Checks an alias is usable and free, across **both** config maps.
 *
 * `inboxes` and `accounts` share one namespace — S1 decided that rather than renaming `inboxes`, so a mailbox
 * called `work` and a workspace called `work` cannot both exist and leave every later lookup ambiguous.
 */
export function checkAliasFree(config: Config, alias: string, handoffs: CliHandoffs): void {
  /*
   * The rule is core's — for either config version — and so is its wording, except for a name that is already
   * connected, where the fix is one only this package can suggest.
   *
   * Version 1: a plain name free in both maps, as before. Version 2: `organisation/slack`, free in both maps, and
   * never a former name of anything.
   */
  const check = nameAvailable(config, 'account', alias, 'slack');
  if (check.ok) return;
  if (lookupName(config, 'account', alias) || lookupName(config, 'inbox', alias)) {
    throw new CommsError('CONFIG', `"${alias}" is already connected`, {
      hint: handoffSentence(
        handoffs.own(['workspace', 'remove', alias]),
        (command) => `Choose another name, or disconnect it first with ${command}.`,
        { instead: 'Choose another name, or disconnect it first with slack_workspace_remove from a chat.' },
      ),
    });
  }
  throw check.error;
}

/**
 * Everything that must be true of a token before it is stored, checked in one place.
 *
 * Called on `add` and on `reauth`, and repeated by `doctor` as drift — the same function, so the three cannot
 * disagree about what a valid install is.
 */
export function validateExchange(options: {
  token: ExchangedToken;
  mode: InstallMode;
  flow: SlackFlow;
  config: Config;
  /** The account being replaced, on a reauth. */
  existing?: { alias: string; account: AccountConfig } | undefined;
  /** The commands a refusal names, located from the installation printing them (`SlackContext.handoffs`). */
  handoffs: CliHandoffs;
}): void {
  const { token, mode, flow, existing, handoffs } = options;
  const profileTransition = flow.transition === 'profile-app';
  if (
    profileTransition &&
    (!flow.profile ||
      !flow.expect?.secretRef ||
      !existing ||
      existing.alias !== flow.alias ||
      existing.account.id !== flow.expect.accountId ||
      existing.account.secretRef !== flow.expect.secretRef ||
      existing.account.organisation !== flow.profile.organisation ||
      existing.account.oauthClientId !== flow.expect.oauthClientId ||
      existing.account.appId !== flow.expect.appId)
  ) {
    throw new CommsError('CONFIG', 'the source account changed during the profile sign-in');
  }

  if (flow.profile) {
    const profile = flow.profile;
    if (!token.appId || !/^A[A-Z0-9]{2,20}$/.test(token.appId)) {
      throw new CommsError('CONFIG', 'Slack returned a missing or invalid app id for the profile sign-in', {
        hint: 'Nothing was saved. Check the organisation app and sign in again.',
      });
    }
    if (token.workspaceId !== profile.workspace) {
      throw new CommsError(
        'CONFIG',
        'Slack returned a token for another workspace than the organisation profile names',
        {
          hint: 'Nothing was saved. Sign in to the workspace named by the organisation profile.',
        },
      );
    }
    if (flow.clientId !== profile.clientId || flow.port !== profile.redirectPort || mode !== profile.role) {
      throw new CommsError('CONFIG', 'the profile sign-in target changed before it could be checked', {
        hint: 'Nothing was saved. Start the sign-in again from the organisation profile.',
      });
    }
    const live = profileTargetFor(flow, options.config, handoffs);
    if ((profile.appId && token.appId !== profile.appId) || (live.appId && token.appId !== live.appId)) {
      throw new CommsError('CONFIG', 'Slack returned a token for another app than the organisation profile names', {
        hint: 'Nothing was saved. Check the organisation app and sign in again.',
      });
    }
  }

  /*
   * Exact scopes, both directions.
   *
   * Missing ones mean a broken install. **Extra** ones mean the label is a lie: a token from an app that once
   * had `chat:write`, stored as `read`, would have everything downstream reporting a workspace that cannot post
   * while holding a token that can. D1's guarantee is Slack's, and only if this holds.
   */
  const { missing, extra } = scopeMismatch(mode, token.scopes);
  if (flow.profile && (missing.length > 0 || extra.length > 0)) {
    throw new CommsError(
      missing.length > 0 ? 'SCOPE_MISSING' : 'CONFIG',
      `Slack granted permissions that do not match the organisation's ${mode} app: ${[
        ...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
        ...(extra.length > 0 ? [`unexpected ${extra.join(', ')}`] : []),
      ].join('; ')}`,
      {
        hint: `Nothing was saved${existing ? `, and "${existing.alias}" is as it was` : ''}. Ask your organisation administrator to check the profile's ${mode} app permissions, then sign in again.`,
        details: { missing, returned: extra },
      },
    );
  }
  if (missing.length > 0) {
    /*
     * Asking for `send` and getting only reading back is not a person unticking boxes. A token can only be granted what
     * its app declares, so an app still carrying the `read` manifest answers a `send` sign-in with `read` — which is
     * what happens when the app step of a widening was skipped, or saved on a different app. Said as that, with the
     * way to do the step, because the generic advice here sent people to create a new app, which changes no
     * installation.
     */
    const alias = existing?.alias ?? flow.alias;
    if (mode === 'send' && missing.every((scope) => OUTWARD_SCOPES.includes(scope))) {
      throw new CommsError(
        'SCOPE_MISSING',
        `Slack granted no posting scope, so the app's manifest was not updated to send: it did not grant ${missing.join(', ')}`,
        {
          hint: existing
            ? `Nothing was saved, and "${alias}" is as it was. ${updateTheApp(alias, flow.port, handoffs)} Then sign in again.`
            : `Nothing was saved. ${handoffSentence(
                handoffs.own(['manifest', '--mode', 'send', '--port', String(flow.port)]),
                (command) =>
                  `Update the app first: paste ${command} on its App Manifest page at https://api.slack.com/apps, and save.`,
                {
                  instead:
                    'Update the app first: paste the manifest slack_manifest prints for send on its App Manifest page at https://api.slack.com/apps, and save.',
                },
              )} Then connect it again.`,
          details: { missing },
        },
      );
    }
    throw new CommsError('SCOPE_MISSING', `Slack did not grant: ${missing.join(', ')}`, {
      hint: 'Leave every permission ticked on the consent screen, or re-create the app from the manifest.',
    });
  }
  // A client-secret sign-in asked for the bot scopes: a send one must come back with the bot token (S1, revised).
  if (flow.clientSecretRef !== undefined) requireBotForSend(token, mode, handoffs);

  if (extra.length > 0) {
    /*
     * Asking for `read` and getting posting back is not a broken app. Slack adds every scope a person has granted this
     * app before to each new token, and takes none away until the app's installation is removed — so this is what a
     * narrowing looks like until that has happened. The advice here used to be to re-create the app, which changes no
     * installation and so would have met this same refusal again.
     */
    if (mode === 'read' && extra.every((scope) => OUTWARD_SCOPES.includes(scope))) {
      throw new CommsError('CONFIG', `Slack returned posting scopes it granted this app before: ${extra.join(', ')}`, {
        hint: existing
          ? `Slack never takes a scope back from a token. ${handoffSentence(
              handoffs.own(['workspace', 'mode', existing.alias, 'read', '--port', String(flow.port)]),
              (command) => `${command} says how to remove the app's installation first.`,
              { instead: "slack_mode_narrow says how to remove the app's installation first, from a chat." },
            )}`
          : 'Slack never takes a scope back from a token. Remove the app from the workspace in Slack (Workspace settings → Manage apps → the app → Remove app), then connect it again.',
        details: { returned: extra },
      });
    }
    throw new CommsError('CONFIG', `Slack granted more than "${mode}" asks for: ${extra.join(', ')}`, {
      hint: `The app requests more than this mode allows. ${handoffSentence(
        handoffs.own(['manifest', '--mode', mode]),
        (command) => `Re-create it from ${command}.`,
        { instead: `Re-create it from the manifest slack_manifest prints for ${mode}.` },
      )}`,
    });
  }

  /*
   * A reauth must not change who this is.
   *
   * "The workspace's own app" binds the client; it does not bind the person. A browser signed into two accounts
   * will authorise whichever one is active, and an account that silently starts acting as somebody else is the
   * worst possible outcome of a command whose name means "the same, again".
   *
   * Checked against **both** the flow and the account it names, and they are different questions. `flow.expect`
   * is who this sign-in set out to renew, recorded before the browser opened and unchangeable since. The account
   * is who holds that alias now — and up to ten minutes and a process boundary sit between the two, so the alias
   * can have been re-pointed at somebody else in the gap. Checking only the second would bind the grant to
   * whatever the alias means at the moment it lands.
   */
  if (flow.expect) {
    const expected = flow.expect;
    if (token.workspaceId !== expected.workspaceId) {
      throw new CommsError('CONFIG', `that sign-in is for a different workspace than "${flow.alias}"`, {
        hint: 'Re-authorising must use the same workspace. To connect another, use `workspace add`.',
      });
    }
    if (token.userId !== expected.userId) {
      throw new CommsError('CONFIG', `that sign-in is a different Slack account than "${flow.alias}" uses`, {
        hint: 'Sign in as the same person, or connect the other account separately with `workspace add`.',
      });
    }
    if (!profileTransition && expected.oauthClientId && flow.clientId !== expected.oauthClientId) {
      // The Gmail bug, in its Slack form: a reauth through a different app changes what the account can do.
      throw new CommsError('CONFIG', `"${flow.alias}" was connected through a different Slack app`, {
        hint: 'Re-authorise through the same app, or remove and add the workspace again.',
      });
    }
    /*
     * A recorded app id must be matched, not merely not-contradicted.
     *
     * This compared the two only when both were present, so a response that simply omitted `app_id` dropped the
     * binding and passed — and a silent way to skip a check is worse than not having it, because the check is
     * still written down and still believed.
     */
    if (!profileTransition && expected.appId && token.appId !== expected.appId) {
      throw new CommsError('CONFIG', `that sign-in is from a different Slack app than "${flow.alias}" uses`, {
        hint: 'Re-authorise through the same app, or remove and add the workspace again.',
      });
    }
  }

  if (existing) {
    const account = existing.account;
    if (token.workspaceId !== account.workspace) {
      throw new CommsError('CONFIG', `that sign-in is for a different workspace than "${existing.alias}"`, {
        hint: 'Re-authorising must use the same workspace. To connect another, use `workspace add`.',
      });
    }
    if (token.userId !== account.userId) {
      throw new CommsError('CONFIG', `that sign-in is a different Slack account than "${existing.alias}" uses`, {
        hint: 'Sign in as the same person, or connect the other account separately with `workspace add`.',
      });
    }
    if (!profileTransition && account.oauthClientId && flow.clientId !== account.oauthClientId) {
      throw new CommsError('CONFIG', `"${existing.alias}" was connected through a different Slack app`, {
        hint: 'Re-authorise through the same app, or remove and add the workspace again.',
      });
    }
    if (!profileTransition && account.appId && token.appId !== account.appId) {
      throw new CommsError('CONFIG', `that sign-in is from a different Slack app than "${existing.alias}" uses`, {
        hint: 'Re-authorise through the same app, or remove and add the workspace again.',
      });
    }
    return;
  }

  /*
   * On `add`, the same workspace-and-person may not be connected twice.
   *
   * Two aliases sharing one identity means two credentials for one person, two send ledgers, and no way to tell
   * which one an agent used. If the intent was to replace, that is what `reauth` is for.
   */
  const duplicate = Object.entries(options.config.accounts).find(
    ([, account]) =>
      account.platform === 'slack' && account.workspace === token.workspaceId && account.userId === token.userId,
  );
  if (duplicate) {
    throw new CommsError('CONFIG', `that account is already connected as "${duplicate[0]}"`, {
      hint: handoffSentence(
        handoffs.own(['workspace', 'reauth', duplicate[0]]),
        (command) => `To renew it, use ${command}.`,
        { instead: 'To renew it, use slack_workspace_reauth from a chat.' },
      ),
    });
  }
}

/**
 * "Run <core's org update>, then start the sign-in again." — core's command, from this installation's own core, located;
 * with no command, comms_org_update from a chat and why.
 */
function reconcileProfile(organisation: string, handoffs: CliHandoffs): string {
  return handoffSentence(
    handoffs.core(['org', 'update', organisation]),
    (command) => `Run ${command}, then start the sign-in again.`,
    { instead: 'Call comms_org_update from a chat, then start the sign-in again.' },
  );
}

/**
 * "Update the app it signed in through: …" — the manifest and the terminal's `app update`, located; with no command,
 * slack_manifest from a chat and why.
 */
function updateTheApp(alias: string, port: number, handoffs: CliHandoffs): string {
  const manifest = handoffs.own(['manifest', '--workspace', alias, '--mode', 'send']);
  const appUpdate = handoffs.own(['app', 'update', alias, '--mode', 'send', '--port', String(port)]);
  return handoffSentence(
    manifest,
    (shown) =>
      handoffSentence(
        appUpdate,
        (update) =>
          `Update the app it signed in through: ${shown} (slack_manifest from a chat) prints the manifest and the link to its page, or ${update} does it at a terminal with an app configuration token.`,
        {
          instead: `Update the app it signed in through: ${shown} (slack_manifest from a chat) prints the manifest and the link to its page.`,
        },
      ),
    {
      instead:
        'Update the app it signed in through: slack_manifest from a chat prints the manifest and the link to its page.',
    },
  );
}

/** Re-resolve the whole selected profile target, accepting only a concurrent learning of the same app id. */
export function profileTargetFor(flow: SlackFlow, config: Config, handoffs: CliHandoffs): ProfileSlackTarget {
  const expected = flow.profile;
  if (!expected) throw new CommsError('CONFIG', 'this is not a profile sign-in');
  let live: ProfileSlackTarget;
  try {
    live = resolveProfileSlackTarget(config, expected.organisation, expected.role, handoffs);
  } catch {
    throw new CommsError('CONFIG', 'the organisation profile changed during the Slack sign-in', {
      hint: reconcileProfile(expected.organisation, handoffs),
    });
  }
  const selected = {
    organisation: live.organisation,
    role: live.role,
    label: safeSlackFailureText(live.label),
    workspace: live.workspace,
    workspaceName: safeSlackFailureText(live.workspaceName),
    redirectPort: live.redirectPort,
    clientId: live.clientId,
    sha256: live.sha256,
  };
  const snapshot = {
    organisation: expected.organisation,
    role: expected.role,
    label: safeSlackFailureText(expected.label),
    workspace: expected.workspace,
    workspaceName: safeSlackFailureText(expected.workspaceName),
    redirectPort: expected.redirectPort,
    clientId: expected.clientId,
    sha256: expected.sha256,
  };
  if (JSON.stringify(selected) !== JSON.stringify(snapshot) || (expected.appId && expected.appId !== live.appId)) {
    throw new CommsError('CONFIG', 'the organisation profile changed during the Slack sign-in', {
      hint: reconcileProfile(expected.organisation, handoffs),
    });
  }
  return live;
}

/**
 * The credential, as one value, from what Slack returned. `refreshExpires` is false for an app that signs in with its
 * client secret: Slack's PKCE page says it is PKCE that makes refresh tokens "expire in 30 days instead of lasting
 * indefinitely", so no expiry is recorded for one that never enabled it.
 */
export function bundleFrom(
  token: ExchangedToken,
  now: Date,
  options: { refreshExpires?: boolean | undefined } = {},
): TokenBundle {
  return {
    v: BUNDLE_VERSION,
    state: 'ready',
    accessToken: token.accessToken,
    /*
     * Slack's own number, never a default.
     *
     * This used to fall back to twelve hours when `expires_in` was absent. That is a guess written down as a
     * fact: everything afterwards — `isDue`, `doctor`, the refresh schedule — reads it as what Slack said. A
     * grant with no expiry is now refused at the exchange, so there is nothing left to guess.
     */
    accessExpiresAt: new Date(now.getTime() + token.expiresInSeconds * 1000).toISOString(),
    refreshToken: token.refreshToken,
    /*
     * 30 days, computed rather than reported.
     *
     * Slack does not put this in the response — "all refresh tokens issued to your app will expire in 30 days"
     * is a property of the app, not a field. Recorded rather than inferred later, because the only other way to
     * discover it is a refresh that fails.
     */
    ...(options.refreshExpires === false
      ? {}
      : { refreshExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString() }),
    issuedAt: now.toISOString(),
  };
}

/** Where a newly connected workspace's credential lives. */
export function secretRefFor(accountId: string): string {
  return `slack/token/${accountId}`;
}

/**
 * Where the send app's bot token lives, beside the user token (design 2026-10-15 S1): one place per account, written
 * after the sign-in that issued it is saved, and deleted — never revoked — when the account narrows to read or is
 * removed, because the token is the workspace's and others who installed the same app hold it too.
 */
export function botSecretRefFor(accountId: string): string {
  return `slack/bot-token/${accountId}`;
}

/**
 * Where a Slack app's client secret is kept, for the sign-in that uses it (design 2026-10-15 S1, revised): by the app's
 * id, which a renewal finds it by. Typed at a person's terminal, kept in the core's secret store, never printed.
 */
export function clientSecretRefFor(appId: string): string {
  return `slack/client-secret/${appId}`;
}

/**
 * Where a first sign-in keeps the secret until Slack has said which app it is: by the Client ID it was started with,
 * which names the same app. Moved under the app's id once the sign-in is saved, and deleted when its flow ends.
 */
export function pendingClientSecretRefFor(clientId: string): string {
  return `slack/client-secret/pending/${clientId}`;
}

/** The bot token, as one value the refresh machinery can renew: the user token's shape (S1). */
export function botBundleFrom(
  bot: ExchangedBot,
  now: Date,
  options: { refreshExpires?: boolean | undefined } = {},
): TokenBundle {
  return bundleFrom(
    {
      accessToken: bot.accessToken,
      refreshToken: bot.refreshToken,
      expiresInSeconds: bot.expiresInSeconds,
    } as ExchangedToken,
    now,
    options,
  );
}

/**
 * Where a renewed credential lives: beside the one it replaces, never over it, under the same account id.
 *
 * A reauth stages the new credential under its own reference and moves the pointer in one config write, so the old
 * credential is authoritative until the exact moment the new one is — the mode can change across a reauth, and an
 * overwrite would open a window where the configuration says `read` while the credential behind it can post. It used
 * to get that reference by minting a new account id, which also moved everything filed under the id: a server pinned
 * to the workspace, its drafts, its approvals. Random rather than counted, so two renewals of one account racing each
 * other never stage into the same reference.
 */
export function renewedSecretRefFor(accountId: string): string {
  return `${secretRefFor(accountId)}/${randomBytes(9).toString('base64url')}`;
}

export function accountFrom(options: {
  token: ExchangedToken;
  mode: InstallMode;
  flow: SlackFlow;
  accountId: string;
  now: Date;
  /** Where its credential is stored; a new account's own reference when left out. */
  secretRef?: string | undefined;
  provenance?: { organisation: string; profileApp: 'read' | 'send' } | undefined;
  /** Where the app's client secret is, for an account that signs in with it (S1, revised). */
  clientSecretRef?: string | undefined;
}): AccountConfig {
  const { token, mode, flow, accountId, now } = options;
  return {
    id: accountId,
    platform: 'slack',
    workspace: token.workspaceId,
    ...(token.workspaceName ? { workspaceName: token.workspaceName } : {}),
    userId: token.userId,
    tier: mode,
    mode,
    grantedScopes: [...token.scopes].sort(),
    secretRef: options.secretRef ?? secretRefFor(accountId),
    oauthClientId: flow.clientId,
    ...(token.appId ? { appId: token.appId } : {}),
    ...(options.provenance ?? {}),
    redirectPort: flow.port,
    createdAt: now.toISOString(),
    // The bot user the send app posts as (S1); its token is stored apart, under `botSecretRefFor`.
    ...(mode === 'send' && token.bot ? { botUserId: token.bot.userId } : {}),
    ...(options.clientSecretRef === undefined ? {} : { clientSecretRef: options.clientSecretRef }),
  } as SlackAccount;
}

export { newAccountId, serialiseBundle };

export interface RemovedWorkspace {
  readonly alias: string;
  readonly accountId: string;
  readonly removed: true;
  /** The attempted old-token cleanup; unfinished entries remain available to doctor after removal. */
  readonly cleanup: readonly PendingRevocationResult[];
}

/** What `workspace remove` needs, named explicitly so the order below can be tested with a store that fails. */
export interface RemovalDeps {
  readonly config: Config;
  /** `kind` so the removal can tell whether the backend it deleted from is still the one in force. */
  readonly secrets: { readonly kind?: string; delete(ref: string): Promise<boolean> };
  readonly update: (mutator: (config: Config) => Config) => Promise<Config>;
  /** The commands a refusal names, located from the installation printing them (`SlackContext.handoffs`). */
  readonly handoffs: CliHandoffs;
}

/**
 * Disconnects a workspace from this machine. Local only: the Slack app stays installed in the workspace.
 *
 * **The credential goes first, and the order is the whole content of this function.** Either order leaves a
 * window if the second step fails, and the two windows are not equally bad. Deleting the credential first and
 * then failing to write the config leaves an entry whose credential is gone — which `doctor` reports as
 * `credential: fail` and `reauth` repairs. Writing the config first and then failing to delete leaves a live
 * Slack token in the secret store that no command lists, refreshes or removes, and that nothing will ever
 * mention again.
 */
export async function removeWorkspace(
  deps: RemovalDeps,
  alias: string,
  options: { expectId?: string | undefined; cleanup?: readonly PendingRevocationResult[] | undefined } = {},
): Promise<RemovedWorkspace> {
  const found = requireWorkspace(deps.config, alias, deps.handoffs);
  /*
   * The workspace a person approved removing, and no other.
   *
   * A removal is approved for the account that was shown, and the configuration is read again here, after the approval
   * was claimed. A remove and an add in between put an unrelated account under the name, which is not what the person
   * agreed to delete, so nothing is deleted and they are asked again. A renewal in between keeps the id: it is the same
   * person in the same workspace through the same app, and removing it — with the credential it holds now — is what
   * was agreed to.
   */
  if (options.expectId !== undefined && found.account.id !== options.expectId) {
    throw new CommsError('CONFIG', `"${alias}" changed after its removal was approved, so nothing was removed`, {
      hint: handoffSentence(
        deps.handoffs.own(['workspace', 'show', alias]),
        (command) => `Look at it with ${command}, and remove it again if you still want it gone.`,
        { instead: 'Look at it with slack_workspace_show from a chat, and remove it again if you still want it gone.' },
      ),
    });
  }
  /*
   * The app's bot token first: deleted, never revoked (design 2026-10-15 S1). It is the workspace's, and everyone who
   * installed the same app holds it, so revoking it would stop their posts too. A sign-in stores one only after the
   * account naming its bot user is saved, so an account that names none has none to delete.
   */
  if (botUserIdOf(found.account) !== undefined) await deps.secrets.delete(botSecretRefFor(found.account.id));
  await deps.secrets.delete(found.account.secretRef);
  await deps.update((config) => {
    /*
     * Remove the account that was looked at, not whatever holds the name now.
     *
     * The credential above was deleted from a snapshot. A reauth finishing in between gives the account a new
     * credential — under the same id, since a renewal keeps it — and removing it then would delete that entry while
     * leaving its fresh credential in the secret store, named by nothing. So the entry is removed only if it still
     * holds the credential that was just deleted; otherwise the renewal wins and remove says so.
     */
    /*
     * And the credential must have been deleted from the backend still in force.
     *
     * A migration that switched backends while this ran copied the credential across first — so deleting it from
     * the old backend and then dropping the entry would leave the copy in the new backend with nothing naming it.
     * Refusing keeps the entry, which still points at that copy; running `remove` again deletes both.
     */
    if (deps.secrets.kind && secretsStoreOf(config) !== deps.secrets.kind) {
      throw new CommsError('TRANSIENT', `the secret store changed while "${alias}" was being removed`, {
        hint: handoffSentence(deps.handoffs.own(['workspace', 'remove', alias]), (command) => `Run ${command} again.`, {
          instead: 'Call slack_workspace_remove again from a chat.',
        }),
      });
    }
    // By id, under whatever key it holds now: nothing may depend on the name staying put between the read and here.
    const held = findById(config, 'account', found.account.id);
    if (!held || held.account.secretRef !== found.account.secretRef) {
      throw new CommsError('CONFIG', `"${alias}" was renewed while it was being removed`, {
        hint: `It is connected again. ${handoffSentence(
          deps.handoffs.own(['workspace', 'remove', alias]),
          (command) => `Run ${command} once more if you still want it gone.`,
          { instead: 'Call slack_workspace_remove once more from a chat if you still want it gone.' },
        )}`,
      });
    }
    const { [held.alias]: _removed, ...rest } = config.accounts;
    return { ...config, accounts: rest };
  });
  /*
   * The app's client secret, once no workspace left signs in with it (S1, revised). After the entry is gone, not before:
   * it posts nothing, and an entry left without it could not renew its tokens. Best effort — a secret left behind is
   * the app's, not a token, and the next sign-in with it writes it again.
   */
  const secretRef = clientSecretRefOf(found.account);
  if (secretRef !== undefined) {
    const others = Object.values(deps.config.accounts).filter(
      (account) => account.id !== found.account.id && clientSecretRefOf(account) === secretRef,
    );
    if (others.length === 0) await deps.secrets.delete(secretRef).catch(() => undefined);
  }
  return { alias, accountId: found.account.id, removed: true, cleanup: options.cleanup ?? [] };
}
