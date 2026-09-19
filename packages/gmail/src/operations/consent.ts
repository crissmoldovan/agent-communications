import {
  type ClientConfig,
  CommsError,
  type Config,
  defaultInternalDomains,
  duplicateInbox,
  findInboxById,
  type InboxConfig,
  newInboxId,
  PUBLIC_MAILBOX_DOMAINS,
} from '@cloudpixel/comms-core';
import type { OAuthFlow } from '../auth/flows.ts';
import { exchangeCode, type TokenResponse } from '../auth/oauth.ts';
import { capabilitiesOf, tierOf } from '../auth/scopes.ts';
import { refreshTokenRef, TokenSource } from '../auth/session.ts';
import type { GmailContext } from '../context.ts';
import { getProfileWithToken } from '../gmail-api/profile.ts';

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
    ? reauthorise(context, flow, config, tokens, identity, granted, missingScopes)
    : addInbox(context, flow, config, tokens, identity, granted, missingScopes);
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
  if (config.inboxes[flow.alias]) {
    throw new CommsError('CONFIG', `an inbox called "${flow.alias}" already exists`, {
      hint: `Choose another name, or re-authorise the existing one with \`agent-gmail inbox reauth ${flow.alias}\`.`,
    });
  }

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
  await secrets.set(inbox.secretRef, tokens.refreshToken);
  try {
    await context.core.config.update((current) => ({
      ...current,
      inboxes: { ...current.inboxes, [flow.alias]: inbox },
    }));
  } catch (error) {
    await secrets.delete(inbox.secretRef).catch(() => undefined);
    throw error;
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
): Promise<ConsentResult> {
  const inboxId = flow.expect.inboxId;
  const existing = inboxId ? findInboxById(config, inboxId) : null;
  if (!inboxId || !existing) {
    throw new CommsError('NOT_FOUND', 'the inbox this sign-in was for no longer exists', {
      hint: 'Add it again with `agent-gmail inbox add <alias>`.',
    });
  }

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
    ([alias, inbox]) => alias !== existing.alias && identity.sub !== undefined && inbox.sub === identity.sub,
  );
  if (clash) {
    throw new CommsError('CONFIG', `that account is already connected as "${clash[0]}"`, {
      hint: `Remove "${clash[0]}" first if you want it under another name.`,
    });
  }

  const secrets = await context.core.secrets();
  await secrets.set(existing.inbox.secretRef, tokens.refreshToken);
  const updated: InboxConfig = {
    ...existing.inbox,
    email: identity.email,
    sub: identity.sub ?? existing.inbox.sub,
    identity: identity.sub ? 'oidc' : existing.inbox.identity,
    tier: tierOf(granted) ?? existing.inbox.tier,
    contacts: capabilitiesOf(granted).has('contacts'),
    grantedScopes: granted,
  };
  await context.core.config.update((current) => ({
    ...current,
    inboxes: { ...current.inboxes, [existing.alias]: updated },
  }));
  await context.core.states.update(existing.inbox.id, {
    lastRefreshOkAt: context.now().toISOString(),
    grantedScopes: granted,
    lastError: undefined,
  });
  await context.core.audit.append({
    inboxId: existing.inbox.id,
    alias: existing.alias,
    operation: 'inbox.reauth',
    outcome: 'ok',
    surface: context.surface,
  });
  context.forgetTransports();
  return { alias: existing.alias, inbox: updated, missingScopes, reauthorised: true };
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
