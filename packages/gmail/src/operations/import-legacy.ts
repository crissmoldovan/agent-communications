import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  CommsError,
  type Config,
  defaultInternalDomains,
  duplicateInbox,
  expandHome,
  type InboxConfig,
  isValidAlias,
  newInboxId,
  PUBLIC_MAILBOX_DOMAINS,
  type StoreKind,
} from '@cloudpixel/comms-core';
import { parseClientJson } from '../auth/oauth.ts';
import { capabilitiesOf, parseGrantedScopes, tierOf } from '../auth/scopes.ts';
import { clientSecretRef, refreshTokenRef } from '../auth/session.ts';
import type { GmailContext } from '../context.ts';
import { getProfileWithToken } from '../gmail-api/profile.ts';
import { findUngatedGmailServers, type LegacyServerFinding, listRegisteredServers } from './client-configs.ts';

/**
 * Migration from `@artymclabin/gmail-mcp` (and the forks that share its layout), which keeps an OAuth client at
 * `~/.gmail-mcp/gcp-oauth.keys.json` and one credentials file per mailbox beside it.
 *
 * It copies, never moves: the old files stay exactly as they are, so the old server keeps working until the user
 * removes it themselves. Two things are deliberately **not** inherited — the account id (those tokens were issued
 * without `openid`, so the inbox is marked `legacy` until its first re-consent) and the ability to organise mail
 * (`readonly`+`compose` grants cannot label or archive). The import saves the setup, not the consent.
 */
export interface ImportCandidate {
  alias: string;
  file: string;
  email?: string | undefined;
  scopes: string[];
  tier: string;
  /** Why this one cannot be imported, when it cannot. */
  problem?: string | undefined;
  /** The alias it is already connected under. */
  duplicateOf?: string | undefined;
}

export interface ImportResult {
  dryRun: boolean;
  client: { name: string; clientId: string; imported: boolean; alreadyPresent: boolean } | null;
  imported: ImportCandidate[];
  skipped: ImportCandidate[];
  /** Other Gmail servers still registered on this machine: while these are connected, nothing here gates sending. */
  ungatedServers: LegacyServerFinding[];
  /** What to do next, in order. */
  nextSteps: string[];
}

export interface ImportOptions {
  dir?: string | undefined;
  clientName?: string | undefined;
  store?: StoreKind | undefined;
  dryRun?: boolean | undefined;
}

interface LegacyCredentials {
  refreshToken: string;
  scopes: string[];
}

/** Both shapes the legacy server has written: `{tokens: {...}, scopes: [...]}` and the older flat token object. */
export function parseLegacyCredentials(text: string): LegacyCredentials {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CommsError('BAD_DATA', 'the credentials file is not valid JSON');
  }
  const tokens = (json.tokens as Record<string, unknown> | undefined) ?? json;
  const refreshToken = tokens.refresh_token;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new CommsError('BAD_DATA', 'the credentials file has no refresh token');
  }
  const recorded = Array.isArray(json.scopes) ? (json.scopes as unknown[]).map(String) : [];
  const scopes =
    recorded.length > 0 ? parseGrantedScopes(recorded.join(' ')) : parseGrantedScopes(String(tokens.scope ?? ''));
  return { refreshToken, scopes };
}

/** `creds-work.json` → `work`; the default `credentials.json` → `default`. */
export function aliasFromCredentialsFile(file: string): string {
  const name = basename(file).replace(/\.json$/i, '');
  if (name === 'credentials') return 'default';
  const alias = name.replace(/^creds-/, '').toLowerCase();
  return isValidAlias(alias) ? alias : 'imported';
}

export async function importLegacy(context: GmailContext, options: ImportOptions = {}): Promise<ImportResult> {
  const directory = expandHome(options.dir ?? '~/.gmail-mcp', context.env.HOME ?? '');
  const clientName = options.clientName ?? 'imported';
  const dryRun = options.dryRun ?? false;

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    throw new CommsError('NOT_FOUND', `there is nothing to import from ${directory}`, {
      hint: 'Pass --dir if the other server keeps its files somewhere else.',
    });
  }

  const keysFile = entries.includes('gcp-oauth.keys.json') ? join(directory, 'gcp-oauth.keys.json') : null;
  if (!keysFile) {
    throw new CommsError('NOT_FOUND', `no gcp-oauth.keys.json in ${directory}`, {
      hint: 'That file holds the OAuth client the other server used; without it the tokens cannot be renewed.',
    });
  }
  const parsedClient = parseClientJson(await readFile(keysFile, 'utf8'));

  const config = await context.config();
  const existingClient = Object.entries(config.clients).find(([, row]) => row.clientId === parsedClient.clientId);
  const clientKey = existingClient?.[0] ?? clientName;

  const credentialFiles = entries.filter((entry) => /^creds-.+\.json$/i.test(entry) || entry === 'credentials.json');
  const imported: ImportCandidate[] = [];
  const skipped: ImportCandidate[] = [];

  const secrets = dryRun ? null : await context.core.secrets(config.secrets?.store ?? options.store ?? 'file');
  if (!dryRun && secrets && !existingClient) {
    await secrets.set(clientSecretRef(clientKey), parsedClient.clientSecret);
    await context.core.config.update((current) => ({
      ...current,
      // The same default `client add` uses. Defaulting to `file` here meant an import into a fresh configuration
      // silently chose the weaker backend, and said nothing about having done so.
      secrets: { store: current.secrets?.store ?? options.store ?? 'keychain' },
      clients: {
        ...current.clients,
        [clientKey]: {
          provider: 'gmail',
          clientId: parsedClient.clientId,
          projectId: parsedClient.projectId,
          secretRef: clientSecretRef(clientKey),
          addedAt: context.now().toISOString(),
        },
      },
    }));
  }

  for (const file of credentialFiles.sort()) {
    const path = join(directory, file);
    const alias = uniqueAlias(aliasFromCredentialsFile(file), await context.config());
    let credentials: LegacyCredentials;
    try {
      credentials = parseLegacyCredentials(await readFile(path, 'utf8'));
    } catch (error) {
      skipped.push({ alias, file: path, scopes: [], tier: 'read', problem: (error as CommsError).message });
      continue;
    }

    const candidate: ImportCandidate = {
      alias,
      file: path,
      scopes: credentials.scopes,
      tier: tierOf(credentials.scopes) ?? 'read',
    };
    if (!capabilitiesOf(credentials.scopes).has('read')) {
      skipped.push({ ...candidate, problem: 'this grant cannot read the mailbox' });
      continue;
    }

    // Ask Google who this is: the legacy files record no address, and none of them was issued with `openid`.
    let email: string;
    try {
      email = await identify(context, parsedClient, credentials.refreshToken);
    } catch (error) {
      skipped.push({ ...candidate, problem: (error as CommsError).message });
      continue;
    }
    candidate.email = email;

    const current = await context.config();
    const duplicate = duplicateInbox(current, { client: clientKey, email });
    if (duplicate) {
      skipped.push({ ...candidate, duplicateOf: duplicate, problem: `already connected as "${duplicate}"` });
      continue;
    }

    if (dryRun) {
      imported.push(candidate);
      continue;
    }

    const id = newInboxId();
    const inbox: InboxConfig = {
      id,
      provider: 'gmail',
      email,
      // No `sub`: these tokens were issued without `openid`, so the account id is unknown until a re-consent.
      identity: 'legacy',
      client: clientKey,
      tier: candidate.tier,
      contacts: capabilitiesOf(credentials.scopes).has('contacts'),
      grantedScopes: credentials.scopes,
      secretRef: refreshTokenRef(id),
      internalDomains: defaultInternalDomains(email, PUBLIC_MAILBOX_DOMAINS),
      createdAt: context.now().toISOString(),
    };
    await secrets?.set(inbox.secretRef, credentials.refreshToken);
    await context.core.config.update((existing: Config) => ({
      ...existing,
      inboxes: { ...existing.inboxes, [alias]: inbox },
    }));
    await context.core.audit.append({
      inboxId: id,
      alias,
      operation: 'inbox.import',
      outcome: 'ok',
      surface: context.surface,
      reason: `from ${path}`,
    });
    imported.push(candidate);
  }

  context.forgetTransports();
  const ungatedServers = findUngatedGmailServers(await listRegisteredServers(context.env));
  return {
    dryRun,
    client: {
      name: clientKey,
      clientId: parsedClient.clientId,
      imported: !dryRun && !existingClient,
      alreadyPresent: Boolean(existingClient),
    },
    imported,
    skipped,
    ungatedServers,
    nextSteps: nextSteps(imported, ungatedServers, dryRun),
  };
}

function nextSteps(imported: ImportCandidate[], ungated: LegacyServerFinding[], dryRun: boolean): string[] {
  const steps: string[] = [];
  if (dryRun) {
    steps.push('Run the same command without --dry-run to import these.');
    return steps;
  }
  const needsUpgrade = imported.filter((candidate) => candidate.tier !== 'organize');
  for (const candidate of needsUpgrade) {
    steps.push(
      `agent-gmail inbox reauth ${candidate.alias} --start  (to label and archive, and to record which account it is)`,
    );
  }
  for (const finding of ungated) {
    steps.push(`${finding.removal}  (while ${finding.packageName} is connected, an agent can send without approval)`);
  }
  if (imported.length > 0) steps.push('agent-gmail doctor');
  return steps;
}

/** Renews an imported token once, to prove it works and to learn which mailbox it is. */
async function identify(
  context: GmailContext,
  client: { clientId: string; clientSecret: string },
  refreshToken: string,
): Promise<string> {
  const response = await fetch(context.endpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  }).catch((error: unknown) => {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'could not reach Google to check the imported token', {
      cause: error,
    });
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) {
    throw new CommsError('AUTH_REQUIRED', `Google will not renew this token (${body.error ?? response.status})`, {
      hint: 'Connect the mailbox from scratch with `agent-gmail inbox add <name> --start`.',
    });
  }
  const profile = await getProfileWithToken(context.endpoints, body.access_token);
  return profile.emailAddress;
}

function uniqueAlias(wanted: string, config: Config): string {
  if (!config.inboxes[wanted]) return wanted;
  for (let suffix = 2; suffix < 50; suffix++) {
    const candidate = `${wanted}-${suffix}`;
    if (!config.inboxes[candidate]) return candidate;
  }
  return `${wanted}-${Date.now()}`;
}
