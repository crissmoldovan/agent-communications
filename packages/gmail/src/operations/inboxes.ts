import { join } from 'node:path';
import {
  ALIAS_PATTERN,
  appendPrivateLine,
  CommsError,
  effectiveSendPolicy,
  type InboxRuntimeState,
  isValidAlias,
  type LooseningConsent,
  RESERVED_ALIASES,
  type SendPolicy,
} from '@agent-communications/core';
import { revokeToken } from '../auth/oauth.ts';
import { type Capability, capabilitiesOf, tierOf } from '../auth/scopes.ts';
import type { GmailContext } from '../context.ts';

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
  const view = views.find((candidate) => candidate.alias === alias);
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
  if (!isValidAlias(to)) {
    throw new CommsError('USAGE', `"${to}" is not a valid name`, {
      hint: `Names match ${ALIAS_PATTERN.source}: lowercase letters, digits and hyphens.`,
    });
  }
  await context.core.config.update((current) => {
    if (current.inboxes[to]) {
      throw new CommsError('CONFIG', `an inbox called "${to}" already exists`);
    }
    const inboxes = { ...current.inboxes };
    const row = inboxes[from];
    if (!row) throw new CommsError('NOT_FOUND', `no inbox called "${from}"`);
    delete inboxes[from];
    return { ...current, inboxes: { ...inboxes, [to]: row } };
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
      const row = current.inboxes[alias];
      if (!row) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
      return { ...current, inboxes: { ...current.inboxes, [alias]: { ...row, sendPolicy } } };
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
  /** Set when the stored token could not be deleted; it is recorded for `doctor` to report. */
  orphanedSecret?: string | undefined;
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
  const { inbox } = await context.inbox(alias);
  const secrets = await context.core.secrets();
  const refreshToken = options.revoke ? await secrets.get(inbox.secretRef) : null;

  await context.core.config.update((current) => {
    const inboxes = { ...current.inboxes };
    delete inboxes[alias];
    return { ...current, inboxes };
  });
  context.forgetTransports();

  let revoked = false;
  if (options.revoke && refreshToken) {
    try {
      await revokeToken(context.endpoints, refreshToken);
      revoked = true;
    } catch {
      // Revocation is best effort: the row is already gone, and the user is told to check their Google account.
    }
  }

  let orphanedSecret: string | undefined;
  try {
    await secrets.delete(inbox.secretRef);
  } catch (error) {
    // The row is already gone, so the inbox is disconnected either way; but a token still sitting in the keychain is
    // worth saying out loud rather than forgetting, so `doctor` can report it and the user can remove it.
    orphanedSecret = inbox.secretRef;
    await appendPrivateLine(
      orphanedSecretsPath(context),
      JSON.stringify({
        at: context.now().toISOString(),
        secretRef: inbox.secretRef,
        alias,
        reason: error instanceof Error ? error.message : String(error),
      }),
    ).catch(() => undefined);
  }
  await context.core.states.update(inbox.id, { lastError: undefined });
  await context.core.audit.append({
    inboxId: inbox.id,
    alias,
    operation: 'inbox.remove',
    outcome: 'ok',
    surface: context.surface,
    reason: revoked ? 'token revoked' : 'token deleted locally',
  });
  return { alias, id: inbox.id, email: inbox.email, revoked, orphanedSecret };
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
