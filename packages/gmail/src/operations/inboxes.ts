import { join } from 'node:path';
import {
  appendPrivateLine,
  CommsError,
  effectiveSendPolicy,
  findById,
  type InboxRuntimeState,
  keepAndReport,
  type LooseningConsent,
  RESERVED_ALIASES,
  renameEntry,
  type SendPolicy,
  withCredentialsLock,
  writeOutcome,
} from '@agentcomms/core';
import { revokeToken } from '../auth/oauth.ts';
import { type Capability, capabilitiesOf, tierOf } from '../auth/scopes.ts';
import type { GmailContext } from '../context.ts';
import { requireNewInboxName } from './inbox-names.ts';

export interface InboxView {
  alias: string;
  id: string;
  email: string;
  tier: string;
  capabilities: Capability[];
  contacts: boolean;
  sendPolicy: SendPolicy;
  /** True when the policy comes from `defaults`, not from the inbox itself. */
  sendPolicyInherited: boolean;
  client: string;
  identity: 'oidc' | 'legacy';
  createdAt: string;
  lastRefreshOkAt?: string | undefined;
  lastUsedAt?: string | undefined;
  health: 'ok' | 'needs-attention' | 'unknown';
  lastError?: InboxRuntimeState['lastError'];
}

function health(state: InboxRuntimeState): InboxView['health'] {
  if (state.lastError) return 'needs-attention';
  return state.lastRefreshOkAt ? 'ok' : 'unknown';
}

export async function inboxList(context: GmailContext): Promise<InboxView[]> {
  const config = await context.config();
  const views: InboxView[] = [];
  for (const [alias, inbox] of Object.entries(config.inboxes)) {
    const state = await context.core.states.get(inbox.id);
    views.push({
      alias,
      id: inbox.id,
      email: inbox.email,
      tier: tierOf(inbox.grantedScopes) ?? inbox.tier,
      capabilities: [...capabilitiesOf(inbox.grantedScopes)],
      contacts: inbox.contacts,
      sendPolicy: effectiveSendPolicy(config, alias),
      sendPolicyInherited: inbox.sendPolicy === undefined,
      client: inbox.client,
      identity: inbox.identity,
      createdAt: inbox.createdAt,
      lastRefreshOkAt: state.lastRefreshOkAt,
      lastUsedAt: state.lastUsedAt,
      health: health(state),
      lastError: state.lastError,
    });
  }
  return views.sort((a, b) => a.alias.localeCompare(b.alias));
}

export async function inboxShow(
  context: GmailContext,
  alias: string,
): Promise<InboxView & { grantedScopes: string[]; internalDomains: string[] }> {
  const { inbox } = await context.inbox(alias);
  const views = await inboxList(context);
  // By id: `inboxList` reads the config again, and a rename in between would pair this row with another's view.
  const view = views.find((candidate) => candidate.id === inbox.id);
  if (!view) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
  return { ...view, grantedScopes: inbox.grantedScopes, internalDomains: inbox.internalDomains };
}

export async function inboxRename(
  context: GmailContext,
  from: string,
  to: string,
): Promise<{ from: string; to: string; id: string }> {
  const { inbox } = await context.inbox(from);
  if (RESERVED_ALIASES.has(to)) {
    throw new CommsError('USAGE', `"${to}" is reserved: it means every inbox`, { hint: 'Choose another name.' });
  }
  requireNewInboxName(await context.config(), to, 'Choose another name.');
  await context.core.config.update((current) => {
    // By id, and the target checked again, under the lock: a rename is a write like any other, and the file may have
    // moved since it was read. In version 2 `renameEntry` also records the old name, for good.
    const now = findById(current, 'inbox', inbox.id);
    if (!now) throw new CommsError('NOT_FOUND', `no inbox called "${from}"`);
    requireNewInboxName(current, to, 'Choose another name.');
    return renameEntry(current, 'inbox', now.alias, to);
  });
  context.forgetTransports();
  await context.core.audit.append({
    inboxId: inbox.id,
    alias: to,
    operation: 'inbox.rename',
    outcome: 'ok',
    surface: context.surface,
    reason: `was ${from}`,
  });
  return { from, to, id: inbox.id };
}

/**
 * Sets the send policy of one inbox. Tightening (chat → confirm → never) is always allowed; loosening needs the
 * consent the CLI obtains from a person at a terminal, and the config store refuses it otherwise.
 */
export async function inboxPolicy(
  context: GmailContext,
  alias: string,
  sendPolicy: SendPolicy,
  consent?: LooseningConsent,
): Promise<{ alias: string; sendPolicy: SendPolicy; previous: SendPolicy }> {
  const config = await context.config();
  const { inbox } = await context.inbox(alias);
  const previous = effectiveSendPolicy(config, alias);
  await context.core.config.update(
    (current) => {
      const now = findById(current, 'inbox', inbox.id);
      if (!now) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
      return { ...current, inboxes: { ...current.inboxes, [now.alias]: { ...now.inbox, sendPolicy } } };
    },
    consent ? { consent } : {},
  );
  await context.core.audit.append({
    inboxId: inbox.id,
    alias,
    operation: 'inbox.policy',
    outcome: 'ok',
    surface: context.surface,
    reason: `${previous} → ${sendPolicy}`,
  });
  return { alias, sendPolicy, previous };
}

export interface InboxRemoveResult {
  alias: string;
  id: string;
  email: string;
  revoked: boolean;
  /** Set when the stored token could not be deleted. */
  orphanedSecret?: string | undefined;
  /** Whether that token was recorded for `doctor` to report. Recording can fail too, and then nothing will list it. */
  orphanRecorded?: boolean | undefined;
}

/**
 * Disconnects an inbox. The registry row goes first, so a server that is mid-call stops serving it immediately; the
 * token is deleted afterwards. Revocation is opt-in, because revoking one token can invalidate the whole
 * account-and-client grant, including other tools that share it.
 */
export async function inboxRemove(
  context: GmailContext,
  alias: string,
  options: { revoke?: boolean } = {},
): Promise<InboxRemoveResult> {
  const { inbox: named } = await context.inbox(alias);

  /*
   * Under the credentials lock, from the read to the secret deletion.
   *
   * This read a name, deleted `inboxes[name]` by key and then deleted the secret, holding no credentials lock. A
   * migration renaming every key in between left the deletion removing nothing and the secret deleted from under an
   * account that stayed configured; `secrets migrate` could interleave the same way. Held, neither can land in
   * between, and the row is found by its immutable id rather than by the name the command was given.
   */
  const removed = await withCredentialsLock(context.core.paths.configDir, async () => {
    const found = findById(await context.config(), 'inbox', named.id);
    if (!found) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
    const { inbox } = found;
    const secrets = await context.core.secrets();
    const refreshToken = options.revoke ? await secrets.get(inbox.secretRef) : null;

    try {
      await context.core.config.update((current) => {
        const now = findById(current, 'inbox', inbox.id);
        if (!now) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
        const inboxes = { ...current.inboxes };
        delete inboxes[now.alias];
        return { ...current, inboxes };
      });
    } catch (error) {
      /*
       * The row goes first and the secret second — the other order leaves a configured account with no credential.
       * But a rejected write may have committed (see `writeOutcome`), and skipping the deletion then strands a live
       * token that nothing records. So: look. Row gone, the write is in — carry on. Row still there, nothing was
       * written — say so. Unreadable — keep the token, and record it as unconfirmed, because `doctor` must not advise
       * deleting a credential whose mailbox may still be connected.
       */
      const gone = await writeOutcome(async () => findById(await context.config(), 'inbox', inbox.id) === null);
      if (gone === 'absent') throw error;
      if (gone === 'unknown') {
        await recordOrphan(context, { secretRef: inbox.secretRef, alias: found.alias, inboxId: inbox.id }, error, true);
        throw keepAndReport(error, inbox.secretRef, 'Run `agent-gmail inbox list`.');
      }
    }
    context.forgetTransports();

    let orphanedSecret: string | undefined;
    let orphanRecorded: boolean | undefined;
    try {
      await secrets.delete(inbox.secretRef);
    } catch (error) {
      // The row is already gone, so the inbox is disconnected either way; but a token still sitting in the keychain
      // is worth saying out loud rather than forgetting, so `doctor` can report it and the user can remove it.
      orphanedSecret = inbox.secretRef;
      orphanRecorded = await recordOrphan(
        context,
        { secretRef: inbox.secretRef, alias: found.alias, inboxId: inbox.id },
        error,
        false,
      );
    }
    return { name: found.alias, inbox, refreshToken, orphanedSecret, orphanRecorded };
  });

  // Revocation is a call to Google, so it runs after the lock is released: nothing should wait on a network round
  // trip to touch stored credentials. The token was read under the lock; the row is gone whatever this does.
  let revoked = false;
  if (options.revoke && removed.refreshToken) {
    try {
      await revokeToken(context.endpoints, removed.refreshToken);
      revoked = true;
    } catch {
      // Revocation is best effort: the row is already gone, and the user is told to check their Google account.
    }
  }

  await context.core.states.update(removed.inbox.id, { lastError: undefined });
  await context.core.audit.append({
    inboxId: removed.inbox.id,
    alias: removed.name,
    operation: 'inbox.remove',
    outcome: 'ok',
    surface: context.surface,
    reason: `${revoked ? 'token revoked' : 'token not revoked'}; ${
      removed.orphanedSecret ? `local token could not be deleted (${removed.orphanedSecret})` : 'local token deleted'
    }`,
  });
  return {
    alias: removed.name,
    id: removed.inbox.id,
    email: removed.inbox.email,
    revoked,
    orphanedSecret: removed.orphanedSecret,
    orphanRecorded: removed.orphanRecorded,
  };
}

/**
 * One line in the orphaned-secrets file `doctor` reads.
 *
 * `unconfirmed` marks a token kept because nobody could tell whether its mailbox was removed. `doctor` re-checks every
 * line against the config anyway, and only advises deleting a reference nothing still holds.
 */
async function recordOrphan(
  context: GmailContext,
  entry: { secretRef: string; alias: string; inboxId: string },
  error: unknown,
  unconfirmed: boolean,
): Promise<boolean> {
  try {
    await appendPrivateLine(
      orphanedSecretsPath(context),
      JSON.stringify({
        at: context.now().toISOString(),
        ...entry,
        ...(unconfirmed ? { unconfirmed: true } : {}),
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function orphanedSecretsPath(context: GmailContext): string {
  return join(context.core.paths.stateDir, 'orphaned-secrets.jsonl');
}

export interface WhoamiResult {
  alias: string;
  email: string;
  /** What Gmail says, which is the authority when it differs from the stored address. */
  profileEmail: string;
  matches: boolean;
  tier: string;
  capabilities: Capability[];
  sendPolicy: SendPolicy;
  messagesTotal: number;
  threadsTotal: number;
}

export async function whoami(context: GmailContext, alias: string): Promise<WhoamiResult> {
  const config = await context.config();
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);
  const profile = await transport.getProfile();
  await context.core.states.update(resolved.inbox.id, { lastUsedAt: context.now().toISOString() });
  return {
    alias,
    email: resolved.inbox.email,
    profileEmail: profile.emailAddress,
    matches: profile.emailAddress.toLowerCase() === resolved.inbox.email.toLowerCase(),
    tier: tierOf(resolved.inbox.grantedScopes) ?? resolved.inbox.tier,
    capabilities: [...capabilitiesOf(resolved.inbox.grantedScopes)],
    sendPolicy: effectiveSendPolicy(config, alias),
    messagesTotal: profile.messagesTotal,
    threadsTotal: profile.threadsTotal,
  };
}
