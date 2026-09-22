import {
  type ClientConfig,
  CommsError,
  type Config,
  defaultInternalDomains,
  duplicateInbox,
  findById,
  type InboxConfig,
  keepAndReport,
  newInboxId,
  PUBLIC_MAILBOX_DOMAINS,
  secretsStoreOf,
  withCredentialsLock,
  withdrawStaged,
  writeOutcome,
} from '@agentcomms/core';
import type { OAuthFlow } from '../auth/flows.ts';
import { exchangeCode, type TokenResponse } from '../auth/oauth.ts';
import { capabilitiesOf, tierOf } from '../auth/scopes.ts';
import { refreshTokenRef, TokenSource } from '../auth/session.ts';
import type { GmailContext } from '../context.ts';
import { getProfileWithToken } from '../gmail-api/profile.ts';
import { requireNewInboxName } from './inbox-names.ts';

export interface ConsentResult {
  alias: string;
  inbox: InboxConfig;
  /** Scopes asked for that the account did not grant (granular consent lets people untick boxes). */
  missingScopes: string[];
  /** True when this completed a `reauth` rather than adding an inbox. */
  reauthorised: boolean;
}

/**
 * Everything between "the browser came back with a code" and "the inbox is usable", in the order that keeps a wrong
 * account from ever being written:
 *
 *   1. exchange the code (PKCE verifier from the flow file);
 *   2. read what was actually granted — a user can untick scopes — and stop if the tier's read scope is missing;
 *   3. confirm which account this is, from the ID token and then from Gmail itself;
 *   4. refuse a mismatch with what was asked for, or a second inbox for an account already connected;
 *   5. only then store the refresh token, and only then write the registry row.
 */
export async function completeConsent(context: GmailContext, flow: OAuthFlow, code: string): Promise<ConsentResult> {
  const client = await context.client(flow.clientName);
  const tokens = await exchangeCode({
    client: { clientId: client.clientId, clientSecret: await clientSecret(context, client, flow.clientName) },
    endpoints: context.endpoints,
    code,
    codeVerifier: flow.codeVerifier,
    redirectUri: flow.redirectUri,
  });

  const granted = tokens.grantedScopes;
  if (!capabilitiesOf(granted).has('read')) {
    throw new CommsError('SCOPE_MISSING', 'permission to read the mailbox was not granted, so nothing was saved', {
      hint: 'Sign in again and leave every box ticked on the consent screen.',
      details: { granted },
    });
  }
  const missingScopes = flow.scopes.filter((scope) => !granted.includes(scope));

  const identity = await verifyIdentity(context, tokens);
  const config = await context.config();

  return flow.mode === 'reauth'
    ? reauthorise(context, flow, config, tokens, identity, granted, missingScopes, client.clientId)
    : addInbox(context, flow, config, tokens, identity, granted, missingScopes, client.clientId);
}

async function clientSecret(context: GmailContext, client: ClientConfig, name: string): Promise<string> {
  const store = await context.core.secrets();
  const secret = await store.get(client.secretRef);
  if (secret) return secret;
  throw new CommsError('CONFIG', `the secret for OAuth client "${name}" is not in the secret store`, {
    hint: 'Add the client again: `agent-gmail client add <client_secret.json>`.',
  });
}

export interface VerifiedIdentity {
  sub: string | undefined;
  email: string;
}

/**
 * Who signed in. The ID token comes from our own token-endpoint response over TLS, so its claims are read without a
 * signature check; Gmail's own `getProfile` is then the authority on the address, because the account chooser can
 * hand back an account the user did not mean to pick.
 */
async function verifyIdentity(context: GmailContext, tokens: TokenResponse): Promise<VerifiedIdentity> {
  const profile = await getProfileWithToken(context.endpoints, tokens.accessToken);
  const email = profile.emailAddress || tokens.idClaims.email || '';
  if (!email) {
    throw new CommsError('AUTH_REQUIRED', 'Google did not say which address this is, so nothing was saved');
  }
  return { sub: tokens.idClaims.sub, email };
}

function refuseWrongAccount(expected: string, actual: string, alias: string): never {
  throw new CommsError('AUTH_REQUIRED', `that sign-in was ${actual}, not ${expected}; nothing was saved`, {
    hint: `The account chooser picks whoever is already signed in. Run it again and choose ${expected}, or sign in to Google as ${expected} first.`,
    details: { alias, expected, actual },
  });
}

async function addInbox(
  context: GmailContext,
  flow: OAuthFlow,
  config: Config,
  tokens: TokenResponse,
  identity: VerifiedIdentity,
  granted: string[],
  missingScopes: string[],
  clientId: string,
): Promise<ConsentResult> {
  if (flow.expect.email && flow.expect.email.toLowerCase() !== identity.email.toLowerCase()) {
    refuseWrongAccount(flow.expect.email, identity.email, flow.alias);
  }
  const duplicate = duplicateInbox(config, {
    client: flow.clientName,
    sub: identity.sub,
    email: identity.email,
  });
  if (duplicate) {
    throw new CommsError('CONFIG', `${identity.email} is already connected as "${duplicate}"`, {
      hint: `Use it as "${duplicate}", rename it (\`agent-gmail inbox rename ${duplicate} ${flow.alias}\`), or remove it first.`,
    });
  }
  requireNewInboxName(config, flow.alias);

  const id = newInboxId();
  const inbox: InboxConfig = {
    id,
    provider: 'gmail',
    email: identity.email,
    sub: identity.sub,
    identity: identity.sub ? 'oidc' : 'legacy',
    client: flow.clientName,
    tier: tierOf(granted) ?? flow.tier,
    contacts: capabilitiesOf(granted).has('contacts'),
    grantedScopes: granted,
    secretRef: refreshTokenRef(id),
    internalDomains: defaultInternalDomains(identity.email, PUBLIC_MAILBOX_DOMAINS),
    createdAt: context.now().toISOString(),
  };

  // The token first: a registry row pointing at a secret that is not there would look connected and fail on use.
  const secrets = await context.core.secrets();
  try {
    // Inside the boundary that takes it back: a keychain write can finish after it reported a timeout.
    await secrets.set(inbox.secretRef, tokens.refreshToken);
    await context.core.config.update((current) => {
      /*
       * Checked again under the lock, against the file as it is now.
       *
       * Up to ten minutes pass between starting a sign-in and finishing it, and the checks above ran on a snapshot.
       * In between, the name can be taken, the same account connected under another name, or every name migrated
       * to the organisation/platform form — in which case a plain name that was fine when the flow started is not
       * one any more, and the flow is refused here rather than writing a name the file no longer allows.
       */
      requireNewInboxName(current, flow.alias);
      requireSameClient(current, flow.clientName, clientId);
      // The backend the token went into must still be the one in force: `secrets migrate` switches backends, and a
      // row written after the switch would name a credential that only exists in the store nothing reads any more.
      if (secretsStoreOf(current) !== secrets.kind) {
        throw new CommsError('TRANSIENT', 'the secret store was changed while this sign-in was completing', {
          hint: 'Nothing was saved. Sign in again.',
        });
      }
      const raced = duplicateInbox(current, { client: flow.clientName, sub: identity.sub, email: identity.email });
      if (raced) throw new CommsError('CONFIG', `${identity.email} was connected as "${raced}" while this finished`);
      return { ...current, inboxes: { ...current.inboxes, [flow.alias]: inbox } };
    });
  } catch (error) {
    /*
     * Look before undoing: a rejected write may have committed (see `writeOutcome`). This used to delete the token on
     * any error, which turned a sign-in whose lock release failed into a connected mailbox with no credential — and
     * swallowed a failed deletion, which left a live token nothing named and nobody was told about.
     */
    const landed = await writeOutcome(
      async () => findById(await context.config(), 'inbox', id)?.inbox.secretRef === inbox.secretRef,
    );
    if (landed === 'unknown') throw keepAndReport(error, inbox.secretRef, 'Run `agent-gmail inbox list`.');
    if (landed === 'absent') throw await withdrawStaged(secrets, inbox.secretRef, error);
    // 'present': the write is in and only the lock's cleanup failed. The mailbox is connected.
  }
  await context.core.states.update(id, {
    lastRefreshOkAt: context.now().toISOString(),
    grantedScopes: granted,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt
      ? new Date(tokens.refreshTokenExpiresAt).toISOString()
      : undefined,
  });
  await context.core.audit.append({
    inboxId: id,
    alias: flow.alias,
    operation: 'inbox.add',
    outcome: 'ok',
    surface: context.surface,
  });
  context.forgetTransports();
  return { alias: flow.alias, inbox, missingScopes, reauthorised: false };
}

async function reauthorise(
  context: GmailContext,
  flow: OAuthFlow,
  config: Config,
  tokens: TokenResponse,
  identity: VerifiedIdentity,
  granted: string[],
  missingScopes: string[],
  clientId: string,
): Promise<ConsentResult> {
  // Whether the row still exists is decided inside the lock below, not on the snapshot `config` was read into.
  void config;
  const inboxId = flow.expect.inboxId;
  if (!inboxId) throw inboxGone();

  /*
   * Under the credentials lock, taken only now that the code is spent.
   *
   * A reauth overwrites an existing account's token, under the same reference. Outside the lock, a removal that
   * finished first would have its deleted token written back — and then either its row recreated under the old name,
   * undoing the removal, or no row at all and a live token nothing references. Removal and `secrets migrate` hold
   * this lock, so inside it the row read below is the row the token is written for.
   *
   * Taken after the exchange rather than before, because waiting on a lock with an unspent one-shot code would lose
   * the code to a timeout. A timeout here loses only the new token, and the person gets it again by retrying.
   */
  let result: { alias: string; inbox: InboxConfig };
  let entered = false;
  try {
    result = await withCredentialsLock(context.core.paths.configDir, () => {
      entered = true;
      return writeReauth(context, flow, inboxId, tokens, identity, granted, clientId);
    });
  } catch (error) {
    // Only a lock that could not be taken means nothing was saved. A timeout from inside — the config lock, after
    // the token was written — is reported as itself.
    if (!entered && error instanceof CommsError && error.code === 'LOCK_TIMEOUT') {
      throw new CommsError('TRANSIENT', 'another operation on stored credentials is running, so nothing was saved', {
        hint: `Run \`agent-gmail inbox reauth ${flow.alias}\` again in a moment.`,
        cause: error,
      });
    }
    throw error;
  }

  await context.core.states.update(inboxId, {
    lastRefreshOkAt: context.now().toISOString(),
    grantedScopes: granted,
    lastError: undefined,
  });
  await context.core.audit.append({
    inboxId,
    alias: result.alias,
    operation: 'inbox.reauth',
    outcome: 'ok',
    surface: context.surface,
  });
  context.forgetTransports();
  return { alias: result.alias, inbox: result.inbox, missingScopes, reauthorised: true };
}

function inboxGone(): CommsError {
  return new CommsError('NOT_FOUND', 'the inbox this sign-in was for no longer exists', {
    hint: 'Add it again with `agent-gmail inbox add <alias>`.',
  });
}

/** What a grant sets on an inbox row. Everything else — the send policy, the internal domains — carries over. */
function grantFields(
  flow: OAuthFlow,
  identity: VerifiedIdentity,
  granted: string[],
  previous: InboxConfig,
): Partial<InboxConfig> {
  return {
    email: identity.email,
    sub: identity.sub ?? previous.sub,
    identity: identity.sub ? 'oidc' : previous.identity,
    // The client the token was actually issued to. `completeConsent` exchanged the code with `flow.clientName`, so
    // after `inbox reauth <alias> --client desktop` the stored refresh token belongs to `desktop` while the row
    // still said whatever it said before — and every later refresh then presented the new token to the old client.
    // That breaks the one recovery the shipped troubleshooting guide prescribes for a deleted or mismatched OAuth
    // client, which is this exact command.
    client: flow.clientName,
    tier: tierOf(granted) ?? previous.tier,
    contacts: capabilitiesOf(granted).has('contacts'),
    grantedScopes: granted,
  };
}

/** The part of a reauth that must run under the credentials lock: read the row, write the token, write the row. */
async function writeReauth(
  context: GmailContext,
  flow: OAuthFlow,
  inboxId: string,
  tokens: TokenResponse,
  identity: VerifiedIdentity,
  granted: string[],
  clientId: string,
): Promise<{ alias: string; inbox: InboxConfig }> {
  // Read inside the lock, by id: the row as it is now, under whatever name it has now.
  const config = await context.config();
  const existing = findById(config, 'inbox', inboxId);
  if (!existing) throw inboxGone();

  // The same account, or nothing is written: a re-consent must not quietly point an alias at a different mailbox.
  //
  // **Both** the account id and the address, not either alone. The `sub` comes from an `id_token` this code decodes
  // without verifying its signature — safe today because the token arrives in the body of our own TLS POST to
  // Google, and that is the whole reason it is safe. Making one unverified claim the sole decision about which
  // mailbox an alias points at leaves nothing behind it if that assumption ever stops holding. The address is
  // resolved separately, from Gmail's own profile endpoint, so requiring both means two independent answers have
  // to agree.
  if (existing.inbox.sub && identity.sub !== existing.inbox.sub) {
    refuseWrongAccount(existing.inbox.email, identity.email, existing.alias);
  }
  if (existing.inbox.email.toLowerCase() !== identity.email.toLowerCase()) {
    refuseWrongAccount(existing.inbox.email, identity.email, existing.alias);
  }
  // A sub that already belongs to another alias would leave two aliases sharing one grant.
  const clash = Object.entries(config.inboxes).find(
    ([, inbox]) => inbox.id !== inboxId && identity.sub !== undefined && inbox.sub === identity.sub,
  );
  if (clash) {
    throw new CommsError('CONFIG', `that account is already connected as "${clash[0]}"`, {
      hint: `Remove "${clash[0]}" first if you want it under another name.`,
    });
  }

  const secrets = await context.core.secrets();
  // Kept, so a write that does not land can put it back: the row would otherwise still name the old client and grant
  // while the token under it belongs to the new ones — after `--client`, a mailbox that no longer renews.
  const previous = await secrets.get(existing.inbox.secretRef);
  let written: { alias: string; inbox: InboxConfig } = {
    alias: existing.alias,
    inbox: { ...existing.inbox, ...grantFields(flow, identity, granted, existing.inbox) },
  };
  /*
   * Whether the write refused itself, rather than failing around itself.
   *
   * The reconciliation below exists for a write that may have committed and then reported a failure — a lock it
   * could not release. A check inside the mutator is the opposite: it wrote nothing, on purpose. A reauth that
   * changes nothing produces a row identical to the one already there, and its token is already stored, so without
   * this the refusal would look exactly like a write that landed, and a deliberate refusal would be reported as
   * success.
   */
  let refused = false;
  try {
    // Inside the boundary that puts things back: a keychain write can land after it reported a timeout.
    await secrets.set(existing.inbox.secretRef, tokens.refreshToken);
    await context.core.config.update((current) => {
      // By id, under whatever key it holds now: a rename is followed rather than undone.
      const now = findById(current, 'inbox', inboxId);
      refused = true;
      if (!now) throw inboxGone();
      requireSameClient(current, flow.clientName, clientId);
      /*
       * And no other mailbox on this client is the same account.
       *
       * Checked on the snapshot above and again here: an add or an import completing in between can connect this
       * account under another name, and two rows for one account share — and overwrite — one grant. Legacy rows
       * have no `sub`, so the address decides for them, exactly as `duplicateInbox` does.
       */
      const twin = Object.entries(current.inboxes).find(
        ([, row]) =>
          row.id !== inboxId &&
          row.client === flow.clientName &&
          ((identity.sub !== undefined && row.sub === identity.sub) ||
            (row.sub === undefined && row.email.toLowerCase() === identity.email.toLowerCase())),
      );
      if (twin) {
        throw new CommsError('CONFIG', `${identity.email} was connected as "${twin[0]}" while this ran`, {
          hint: `Remove "${twin[0]}" first if you want it under this name.`,
        });
      }
      refused = false;
      written = { alias: now.alias, inbox: { ...now.inbox, ...grantFields(flow, identity, granted, now.inbox) } };
      return { ...current, inboxes: { ...current.inboxes, [now.alias]: written.inbox } };
    });
  } catch (error) {
    // A check inside the write refused it: nothing was written, whatever the row and the store now look like.
    if (refused) throw await restorePrevious(secrets, existing.inbox.secretRef, previous, error);
    /*
     * The row existed, under this lock, when the token was written — and nothing that holds the lock can have removed
     * it since. So normally the token stays referenced whatever the write did. The exception is a release that does
     * not know this lock (0.1.x removes without it): if the row is gone now, the token just written is referenced by
     * nothing and is taken back.
     */
    const landed = await writeOutcome(async () => findById(await context.config(), 'inbox', inboxId) !== null);
    if (landed === 'unknown') throw keepAndReport(error, existing.inbox.secretRef, 'Run `agent-gmail inbox list`.');
    if (landed === 'absent') throw await withdrawStaged(secrets, existing.inbox.secretRef, error);
    /*
     * Present — but was it this write?
     *
     * The token lives under the same reference either way, so its presence proves nothing; and a reauth that changes
     * nothing — the same client, the same scopes — writes a row identical to the one already there, so the row alone
     * proves nothing either. A write that failed before storing the token would then be reported as a reauth that
     * worked, while the mailbox still holds the old token. So both: the row this reauth built, and the store actually
     * holding the token it minted, read fresh.
     */
    const after = findById(await context.config(), 'inbox', inboxId);
    /*
     * And the proof itself can be unavailable.
     *
     * A keychain write that timed out is not cancelled — the store refuses every call while it is still in flight,
     * so this read fails rather than answering. That is not "the token was not stored": the write may land a moment
     * later. Nothing is restored on an unknown, because restoring would race the write that may still be coming;
     * what the mailbox holds is said plainly instead.
     */
    let holdsNewToken: boolean;
    try {
      secrets.invalidate(existing.inbox.secretRef);
      holdsNewToken = (await secrets.get(existing.inbox.secretRef)) === tokens.refreshToken;
    } catch (unreadable) {
      // What the configuration says is known — it was read a line ago — so it is reported rather than assumed: the
      // write may well have committed and only its lock release failed.
      const settingsUpdated = Boolean(after && sameRow(after.inbox, written.inbox));
      const base = error instanceof CommsError ? error : new CommsError('UNEXPECTED', String(error));
      throw new CommsError(base.code, base.message, {
        hint:
          `${base.hint ? `${base.hint} ` : ''}Whether the new token reached the secret store could not be confirmed. ` +
          `This mailbox's settings ${settingsUpdated ? 'were updated' : 'were not changed'}. Run ` +
          `\`agent-gmail inbox reauth ${after?.alias ?? existing.alias}\` again when the store is available; ` +
          '`agent-gmail doctor` says whether the mailbox still works.',
        details: {
          tokenStateUnknown: existing.inbox.secretRef,
          settingsUpdated,
          storeError: (unreadable as Error).message,
        },
        cause: error,
      });
    }
    if (!after || !sameRow(after.inbox, written.inbox) || !holdsNewToken)
      throw await restorePrevious(secrets, existing.inbox.secretRef, previous, error);
    // The row is exactly what this reauth wrote: the write is in and only the lock's cleanup failed.
  }
  return written;
}

/**
 * Puts the reference back as it was before a reauth whose row was not written — and says so if that fails.
 *
 * As it was means the previous token, or no token when there was none: the row still describes the old client and
 * grant, and a new token left under it — issued to another client, after `--client` — would be one it cannot use.
 */
async function restorePrevious(
  secrets: Awaited<ReturnType<GmailContext['core']['secrets']>>,
  ref: string,
  previous: string | null,
  original: unknown,
): Promise<unknown> {
  try {
    if (previous === null) await secrets.delete(ref);
    else await secrets.set(ref, previous);
    return original;
  } catch (error) {
    const base = original instanceof CommsError ? original : new CommsError('UNEXPECTED', String(original));
    return new CommsError(base.code, base.message, {
      hint: `${base.hint ? `${base.hint} ` : ''}The previous token could not be put back, so the mailbox may not renew: run \`agent-gmail inbox reauth\` for it again.`,
      details: { tokenNotRestored: ref, restoreError: (error as Error).message },
      cause: original,
    });
  }
}

/**
 * Refuses a row whose OAuth client is no longer the one this sign-in exchanged its code with.
 *
 * The row records a client by name, and the token it names belongs to whichever client actually issued it — so a
 * `client add --replace` or a `client remove` landing in between would leave a mailbox pointing at a client that
 * cannot renew its token.
 */
function requireSameClient(config: Config, name: string, clientId: string): void {
  const held = config.clients[name];
  if (held?.clientId === clientId) return;
  throw new CommsError('CONFIG', `the OAuth client "${name}" changed while this sign-in was being completed`, {
    hint: held
      ? `Run \`agent-gmail inbox reauth\` for this mailbox again, through the client it should use.`
      : `Register it again with \`agent-gmail client add\`, then run the sign-in again.`,
  });
}

/** Whether two rows are the same, field for field, whatever order their keys were written in. */
function sameRow(a: InboxConfig, b: InboxConfig): boolean {
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(',')}]`
      : value !== null && typeof value === 'object'
        ? `{${Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
            .join(',')}}`
        : JSON.stringify(value);
  return canonical(a) === canonical(b);
}

/** Confirms a stored inbox still works, used by `doctor` and after a sign-in. */
export async function checkInbox(context: GmailContext, alias: string): Promise<{ email: string; scopes: string[] }> {
  const resolved = await context.inbox(alias);
  const client = await context.client(resolved.inbox.client);
  const source = new TokenSource({
    core: context.core,
    endpoints: context.endpoints,
    inbox: resolved.inbox,
    client,
    alias,
  });
  const token = await source.accessToken();
  const transport = await context.transport(alias);
  const profile = await transport.getProfile();
  return { email: profile.emailAddress, scopes: token.scopes };
}
