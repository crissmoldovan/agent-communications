import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  CommsError,
  type Config,
  defaultInternalDomains,
  duplicateInbox,
  expandHome,
  findById,
  homeDirectory,
  type InboxConfig,
  isValidAlias,
  keepAndReport,
  nameAvailable,
  newInboxId,
  PUBLIC_MAILBOX_DOMAINS,
  type SecretStore,
  type StoreKind,
  withdrawStaged,
  writeOutcome,
} from '@agentcomms/core';
import { parseClientJson } from '../auth/oauth.ts';
import { capabilitiesOf, parseGrantedScopes, tierOf } from '../auth/scopes.ts';
import { clientSecretRef, refreshTokenRef } from '../auth/session.ts';
import type { GmailContext } from '../context.ts';
import { getProfileWithToken } from '../gmail-api/profile.ts';
import { findUngatedGmailServers, type LegacyServerFinding, listRegisteredServers } from './client-configs.ts';
import { requireNewInboxName } from './inbox-names.ts';
import { readSmallFile } from './small-file.ts';

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
  /**
   * `<legacy name>=<name>`, one per mailbox to name differently. The legacy name is the one the file implies —
   * `creds-work.json` is `work` — so a person can see it in `--dry-run` and override exactly that one.
   */
  renames?: readonly string[] | undefined;
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
  const directory = expandHome(options.dir ?? '~/.gmail-mcp', homeDirectory(context.env));
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
  /*
   * Bounded, and the symlink refused.
   *
   * These names come from reading somebody else's directory, not from this process choosing them, and what they
   * hold is an OAuth client and a set of refresh tokens — the same payload class, and the same exposure, as the
   * download scan that `setup` does.
   */
  const keysContent = await readSmallFile(keysFile, { follow: false });
  if (!keysContent.ok) {
    throw new CommsError('BAD_DATA', `${keysFile} is not a readable client JSON`, {
      hint: 'It should be the small JSON the other server was given by Google Cloud.',
    });
  }
  const parsedClient = parseClientJson(keysContent.text);

  const config = await context.config();
  const existingClient = Object.entries(config.clients).find(([, row]) => row.clientId === parsedClient.clientId);
  const clientKey = existingClient?.[0] ?? clientName;
  /*
   * A different client already under this name is refused, not overwritten.
   *
   * This wrote `clientSecretRef(clientKey)` and replaced the row whenever no client had the same *id* — so a second
   * import from a different Google project, under the default name `imported`, silently replaced the first project's
   * secret, and every mailbox signed in through it stopped renewing. With failed writes now taken back, it would also
   * have deleted that secret.
   */
  if (!existingClient && Object.hasOwn(config.clients, clientKey)) {
    throw new CommsError(
      'CONFIG',
      `an OAuth client called "${clientKey}" already exists, for a different Google project`,
      {
        hint: 'Import it under another name with `--name <name>`.',
      },
    );
  }

  const credentialFiles = entries.filter((entry) => /^creds-.+\.json$/i.test(entry) || entry === 'credentials.json');
  const names = importNames(config, credentialFiles, options.renames ?? []);
  const imported: ImportCandidate[] = [];
  const skipped: ImportCandidate[] = [];

  // One backend, decided once. This opened the **file** store and then recorded **keychain** in config, so an
  // import into a fresh configuration wrote the refresh token to disk and left the registry pointing at a
  // keychain entry that was never created — a mailbox that looks connected and cannot read its own token. The
  // skill's own procedure runs `inbox import` before `client add`, which is exactly the case with no store set.
  const store = config.secrets?.store ?? options.store ?? 'keychain';
  const secrets = dryRun ? null : await context.core.secrets(store);
  if (!dryRun && secrets && !existingClient) {
    const ref = clientSecretRef(clientKey);
    await storeThenRecord(
      secrets,
      ref,
      parsedClient.clientSecret,
      () =>
        context.core.config.update((current) => {
          if (Object.hasOwn(current.clients, clientKey)) {
            throw new CommsError('CONFIG', `an OAuth client called "${clientKey}" was added while this ran`, {
              hint: 'Run the import again.',
            });
          }
          return {
            ...current,
            // The same value the store above was opened with, so the two can never disagree.
            secrets: { store: current.secrets?.store ?? store },
            clients: {
              ...current.clients,
              [clientKey]: {
                provider: 'gmail',
                clientId: parsedClient.clientId,
                projectId: parsedClient.projectId,
                secretRef: ref,
                addedAt: context.now().toISOString(),
              },
            },
          };
        }),
      async () => (await context.config()).clients[clientKey]?.secretRef === ref,
    );
  }

  for (const file of credentialFiles.sort()) {
    const path = join(directory, file);
    const alias = names.get(file) ?? aliasFromCredentialsFile(file);
    let credentials: LegacyCredentials;
    try {
      const content = await readSmallFile(path, { follow: false });
      if (!content.ok) throw new CommsError('BAD_DATA', `${path} is not a readable credentials file`);
      credentials = parseLegacyCredentials(content.text);
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
    if (secrets) {
      await storeThenRecord(
        secrets,
        inbox.secretRef,
        credentials.refreshToken,
        () =>
          context.core.config.update((existing: Config) => {
            // Checked again under the lock: the names were chosen from a snapshot, before any network call.
            requireNewInboxName(existing, alias, 'Run the import again.');
            return { ...existing, inboxes: { ...existing.inboxes, [alias]: inbox } };
          }),
        async () => findById(await context.config(), 'inbox', id)?.inbox.secretRef === inbox.secretRef,
      );
    }
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

/**
 * What each credentials file will be called, decided before anything is written.
 *
 * Version 1 keeps the plain name the file implies, made unique with `-2`, `-3`… Version 2 proposes
 * `<legacy name>/gmail`, made unique with a qualifier — `work/gmail-2`. `--rename work=acme/gmail` overrides one, by
 * the legacy name. Every problem — an override naming no file, a target the config cannot take, two files given one
 * name — is collected and refused together, so nothing is half-imported under names somebody would have to undo.
 */
export function importNames(config: Config, files: readonly string[], renames: readonly string[]): Map<string, string> {
  const problems: string[] = [];
  // Several files can imply one legacy name — anything unreadable as a name becomes `imported` — so this is per file.
  const byLegacy = new Map<string, string[]>();
  for (const file of files) {
    const from = aliasFromCredentialsFile(file);
    byLegacy.set(from, [...(byLegacy.get(from) ?? []), file]);
  }
  const overrides = new Map<string, string>();
  for (const rename of renames) {
    const at = rename.indexOf('=');
    const from = rename.slice(0, at);
    const to = rename.slice(at + 1);
    if (at <= 0 || !to) problems.push(`"${rename}" is not <legacy name>=<name>`);
    else if (!byLegacy.has(from)) problems.push(`no credentials file is called "${from}"`);
    else if ((byLegacy.get(from)?.length ?? 0) > 1)
      problems.push(`"${from}" is more than one file, so it cannot be renamed`);
    else if (overrides.has(from)) problems.push(`"${from}" is renamed more than once`);
    else overrides.set(from, to);
  }

  const taken = new Set<string>();
  const free = (name: string) => !taken.has(name) && nameAvailable(config, 'inbox', name, 'gmail').ok;
  const names = new Map<string, string>();
  for (const file of [...files].sort()) {
    const from = aliasFromCredentialsFile(file);
    const override = overrides.get(from);
    let name: string;
    if (override !== undefined) {
      const check = nameAvailable(config, 'inbox', override, 'gmail');
      if (!check.ok) problems.push(`${from}: ${check.error.message}`);
      else if (taken.has(override)) problems.push(`"${override}" is given to more than one mailbox`);
      name = override;
    } else {
      const base = config.version === 2 ? `${from}/gmail` : from;
      const variant = (n: number) => (config.version === 2 ? `${from}/gmail-${n}` : `${from}-${n}`);
      name = base;
      for (let n = 2; !free(name) && n < 50; n++) name = variant(n);
      if (!free(name)) problems.push(`${from}: no free name near "${base}" — choose one with --rename ${from}=<name>`);
    }
    taken.add(name);
    names.set(file, name);
  }
  if (problems.length > 0) {
    throw new CommsError(
      'USAGE',
      `nothing was imported: ${problems.length === 1 ? problems[0] : `${problems.length} problems`}`,
      { hint: problems.map((problem) => `- ${problem}`).join('\n'), details: { problems } },
    );
  }
  return names;
}

/**
 * Stores a secret, then the config row naming it — and if the row's write is rejected, looks before undoing.
 *
 * A rejected write may have committed (see `writeOutcome` in core). The secret is kept when the row is there, taken
 * back when it is not, and kept and reported when nobody can tell.
 */
async function storeThenRecord(
  secrets: SecretStore,
  ref: string,
  value: string,
  record: () => Promise<unknown>,
  recorded: () => Promise<boolean>,
): Promise<void> {
  try {
    await secrets.set(ref, value);
    await record();
  } catch (error) {
    const landed = await writeOutcome(recorded);
    if (landed === 'unknown') throw keepAndReport(error, ref, 'Run `agent-gmail inbox list`.');
    if (landed === 'absent') throw await withdrawStaged(secrets, ref, error);
  }
}
