import {
  type AccountConfig,
  CommsError,
  type Config,
  findById,
  lookupName,
  nameAvailable,
  neutralise,
  newAccountId,
  resolveName,
  secretsStoreOf,
} from '@agentcomms/core';
import { type ExchangedToken, scopeMismatch } from '../auth/authorize.ts';
import { BUNDLE_VERSION, serialiseBundle, type TokenBundle } from '../auth/bundle.ts';
import type { SlackFlow } from '../auth/flow.ts';
import type { InstallMode } from '../manifest.ts';
import { OUTWARD_SCOPES } from './mode.ts';

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

/** Everything known about one workspace — `workspace show` and `slack_workspace_show`. */
export function showWorkspace(config: Config, alias: string): WorkspaceView {
  const found = requireWorkspace(config, alias);
  return viewOf(found.alias, found.account);
}

export function requireWorkspace(config: Config, alias: string): { alias: string; account: AccountConfig } {
  const notFound = () =>
    new CommsError('NOT_FOUND', `no Slack workspace called "${alias}"`, {
      hint: 'List them with `agent-slack workspace list`.',
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
export function checkAliasFree(config: Config, alias: string): void {
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
      hint: 'Choose another name, or disconnect it first with `agent-slack workspace remove`.',
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
            ? `Nothing was saved, and "${alias}" is as it was. Update the app it signed in through: \`agent-slack manifest --workspace ${alias} --mode send\` (slack_manifest from a chat) prints the manifest and the link to its page, or \`agent-slack app update ${alias} --mode send --port ${flow.port}\` does it at a terminal with an app configuration token. Then sign in again.`
            : `Nothing was saved. Update the app first: paste \`agent-slack manifest --mode send --port ${flow.port}\` on its App Manifest page at https://api.slack.com/apps, and save. Then connect it again.`,
          details: { missing },
        },
      );
    }
    throw new CommsError('SCOPE_MISSING', `Slack did not grant: ${missing.join(', ')}`, {
      hint: 'Leave every permission ticked on the consent screen, or re-create the app from the manifest.',
    });
  }
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
          ? `Slack never takes a scope back from a token. \`agent-slack workspace mode ${existing.alias} read --port ${flow.port}\` says how to remove the app's installation first.`
          : 'Slack never takes a scope back from a token. Remove the app from the workspace in Slack (Workspace settings → Manage apps → the app → Remove app), then connect it again.',
        details: { returned: extra },
      });
    }
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
    redirectPort: flow.port,
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
  /** `kind` so the removal can tell whether the backend it deleted from is still the one in force. */
  readonly secrets: { readonly kind?: string; delete(ref: string): Promise<boolean> };
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
export async function removeWorkspace(
  deps: RemovalDeps,
  alias: string,
  options: { expectId?: string | undefined } = {},
): Promise<RemovedWorkspace> {
  const found = requireWorkspace(deps.config, alias);
  /*
   * The workspace a person approved removing, and no other.
   *
   * A removal is approved for the account that was shown, and the configuration is read again here, after the approval
   * was claimed. A renewal landing in between gives the name a new account id; a remove and an add, an unrelated
   * account. Either way this is not what the person agreed to delete, so nothing is deleted and they are asked again.
   */
  if (options.expectId !== undefined && found.account.id !== options.expectId) {
    throw new CommsError('CONFIG', `"${alias}" changed after its removal was approved, so nothing was removed`, {
      hint: `Look at it with \`agent-slack workspace show ${alias}\`, and remove it again if you still want it gone.`,
    });
  }
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
    /*
     * And the credential must have been deleted from the backend still in force.
     *
     * A migration that switched backends while this ran copied the credential across first — so deleting it from
     * the old backend and then dropping the entry would leave the copy in the new backend with nothing naming it.
     * Refusing keeps the entry, which still points at that copy; running `remove` again deletes both.
     */
    if (deps.secrets.kind && secretsStoreOf(config) !== deps.secrets.kind) {
      throw new CommsError('TRANSIENT', `the secret store changed while "${alias}" was being removed`, {
        hint: `Run \`agent-slack workspace remove ${alias}\` again.`,
      });
    }
    // By id, under whatever key it holds now: nothing may depend on the name staying put between the read and here.
    const held = findById(config, 'account', found.account.id);
    if (!held) {
      throw new CommsError('CONFIG', `"${alias}" was renewed while it was being removed`, {
        hint: `It is connected again. Run \`agent-slack workspace remove ${alias}\` once more if you still want it gone.`,
      });
    }
    const { [held.alias]: _removed, ...rest } = config.accounts;
    return { ...config, accounts: rest };
  });
  return { alias, accountId: found.account.id, removed: true };
}
