import {
  type AccountConfig,
  CommsError,
  type Config,
  connectedAccounts,
  isValidAlias,
  neutralise,
  newAccountId,
} from '@agentcomms/core';
import { type ExchangedToken, scopeMismatch } from '../auth/authorize.ts';
import { BUNDLE_VERSION, serialiseBundle, type TokenBundle } from '../auth/bundle.ts';
import type { SlackFlow } from '../auth/flow.ts';
import type { InstallMode } from '../manifest.ts';

/**
 * Connecting, inspecting and disconnecting workspaces.
 *
 * Two rules run through all of it. **Nothing is written until everything has been checked** — a label applied to
 * a token nobody re-examined is not a guarantee — and **a reauth may not change who the account is**, because
 * "re-authorise" means the same person and the same workspace, and a browser will happily authorise somebody
 * else if the person is signed into two accounts.
 */

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
  readonly createdAt: string;
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
export function viewOf(alias: string, account: AccountConfig): WorkspaceView {
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
    createdAt: account.createdAt,
  };
}

export function listWorkspaces(config: Config): WorkspaceView[] {
  return Object.entries(config.accounts)
    .filter(([, account]) => account.platform === 'slack')
    .map(([alias, account]) => viewOf(alias, account))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

export function requireWorkspace(config: Config, alias: string): { alias: string; account: AccountConfig } {
  const account = config.accounts[alias];
  if (account?.platform !== 'slack') {
    throw new CommsError('NOT_FOUND', `no Slack workspace called "${alias}"`, {
      hint: 'List them with `agent-slack workspace list`.',
    });
  }
  return { alias, account };
}

/**
 * Checks an alias is usable and free, across **both** config maps.
 *
 * `inboxes` and `accounts` share one namespace — S1 decided that rather than renaming `inboxes`, so a mailbox
 * called `work` and a workspace called `work` cannot both exist and leave every later lookup ambiguous.
 */
export function checkAliasFree(config: Config, alias: string): void {
  if (!isValidAlias(alias)) {
    // The rule is `core`'s, and the hint quotes it rather than paraphrasing: an earlier draft said "starting with
    // a letter", which is not what `ALIAS_PATTERN` says — it allows a leading digit — and a hint that describes a
    // stricter rule than the code sends people to rename things that were fine.
    throw new CommsError('USAGE', `"${alias}" is not a usable name`, {
      hint: 'Lower-case letters, digits and dashes, up to 32 characters, not starting with a dash.',
    });
  }
  if (connectedAccounts(config).some((entry) => entry.alias === alias)) {
    throw new CommsError('CONFIG', `"${alias}" is already connected`, {
      hint: 'Choose another name, or disconnect it first with `agent-slack workspace remove`.',
    });
  }
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
}): void {
  const { token, mode, flow, existing } = options;

  /*
   * Exact scopes, both directions.
   *
   * Missing ones mean a broken install. **Extra** ones mean the label is a lie: a token from an app that once
   * had `chat:write`, stored as `read`, would have everything downstream reporting a workspace that cannot post
   * while holding a token that can. D1's guarantee is Slack's, and only if this holds.
   */
  const { missing, extra } = scopeMismatch(mode, token.scopes);
  if (missing.length > 0) {
    throw new CommsError('SCOPE_MISSING', `Slack did not grant: ${missing.join(', ')}`, {
      hint: 'Leave every permission ticked on the consent screen, or re-create the app from the manifest.',
    });
  }
  if (extra.length > 0) {
    throw new CommsError('CONFIG', `Slack granted more than "${mode}" asks for: ${extra.join(', ')}`, {
      hint: `The app requests more than this mode allows. Re-create it from \`agent-slack manifest --mode ${mode}\`.`,
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
    if (expected.oauthClientId && flow.clientId !== expected.oauthClientId) {
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
    if (expected.appId && token.appId !== expected.appId) {
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
    if (account.oauthClientId && flow.clientId !== account.oauthClientId) {
      throw new CommsError('CONFIG', `"${existing.alias}" was connected through a different Slack app`, {
        hint: 'Re-authorise through the same app, or remove and add the workspace again.',
      });
    }
    if (account.appId && token.appId !== account.appId) {
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
      hint: `To renew it, use \`agent-slack workspace reauth ${duplicate[0]}\`.`,
    });
  }
}

/** The credential, as one value, from what Slack returned. */
export function bundleFrom(token: ExchangedToken, now: Date): TokenBundle {
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
    refreshExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
    issuedAt: now.toISOString(),
  };
}

/** Where a workspace's credential lives. Distinct per account id, so a reauth can stage a new one beside the old. */
export function secretRefFor(accountId: string): string {
  return `slack/token/${accountId}`;
}

export function accountFrom(options: {
  token: ExchangedToken;
  mode: InstallMode;
  flow: SlackFlow;
  accountId: string;
  now: Date;
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
    secretRef: secretRefFor(accountId),
    oauthClientId: flow.clientId,
    ...(token.appId ? { appId: token.appId } : {}),
    createdAt: now.toISOString(),
  };
}

export { newAccountId, serialiseBundle };

export interface RemovedWorkspace {
  readonly alias: string;
  readonly accountId: string;
  readonly removed: true;
}

/** What `workspace remove` needs, named explicitly so the order below can be tested with a store that fails. */
export interface RemovalDeps {
  readonly config: Config;
  readonly secrets: { delete(ref: string): Promise<boolean> };
  readonly update: (mutator: (config: Config) => Config) => Promise<Config>;
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
export async function removeWorkspace(deps: RemovalDeps, alias: string): Promise<RemovedWorkspace> {
  const found = requireWorkspace(deps.config, alias);
  await deps.secrets.delete(found.account.secretRef);
  await deps.update((config) => {
    /*
     * Remove the account that was looked at, not whatever holds the name now.
     *
     * The credential above was deleted from a snapshot. A reauth finishing in between installs a *new* account
     * under the same alias with a new credential — and removing by name alone would then delete that entry
     * while leaving its fresh credential in the secret store, named by nothing. So the entry is removed only if
     * it is still the one whose credential was just deleted; otherwise the renewal wins and remove says so.
     */
    const held = config.accounts[alias];
    if (!held || held.id !== found.account.id) {
      throw new CommsError('CONFIG', `"${alias}" was renewed while it was being removed`, {
        hint: `It is connected again. Run \`agent-slack workspace remove ${alias}\` once more if you still want it gone.`,
      });
    }
    const { [alias]: _removed, ...rest } = config.accounts;
    return { ...config, accounts: rest };
  });
  return { alias, accountId: found.account.id, removed: true };
}
