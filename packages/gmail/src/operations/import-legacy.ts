import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  CommsError,
  type Config,
  committedSecretsStore,
  defaultInternalDomains,
  duplicateInbox,
  expandHome,
  findById,
  findUngatedGmailServers,
  type GatedChange,
  homeDirectory,
  type InboxConfig,
  isValidAlias,
  keepAndReport,
  type LegacyServerFinding,
  listRegisteredServers,
  nameAvailable,
  newInboxId,
  PUBLIC_MAILBOX_DOMAINS,
  type SecretStore,
  type StoreKind,
  secretsStoreFor,
  withCredentialsLock,
  withdrawStaged,
  writeOutcome,
} from '@agentcomms/core';
import { parseClientJson } from '../auth/oauth.ts';
import { capabilitiesOf, parseGrantedScopes, tierOf } from '../auth/scopes.ts';
import { clientSecretRef, refreshTokenRef } from '../auth/session.ts';
import type { GmailContext } from '../context.ts';
import { getProfileWithToken } from '../gmail-api/profile.ts';
import { parseStore } from './clients.ts';
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
  /**
   * What a change approval covered, when one did: the import does that and nothing more.
   *
   * The preview a person approves lists the mailboxes a dry run found, and the import runs afterwards. In between a
   * credentials file can appear, a token can come to belong to another account, or a name can be taken so that a
   * mailbox would land under a different one. Each of those is skipped and says why, rather than imported on the
   * strength of an approval that did not mention it.
   */
  approved?: ApprovedImport | undefined;
}

/** An import as a surface hands it over: the store is a word, checked by `inboxImportChange`. */
export interface ImportRequest extends Omit<ImportOptions, 'store'> {
  store?: string | undefined;
}

export interface ApprovedImport {
  /** Whether registering the other server's OAuth client was part of what was approved. */
  registersClient: boolean;
  /** Each mailbox approved, by its credentials file, the name it was to have, and the address Google gave for it. */
  mailboxes: ReadonlyArray<{ file: string; alias: string; email: string }>;
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

/** Where the other server keeps its files: `--dir`, or its own default. */
export function importDirectory(context: GmailContext, dir: string | undefined): string {
  return expandHome(dir ?? '~/.gmail-mcp', homeDirectory(context.env));
}

/**
 * Importing another server's mailboxes, as one change both surfaces run through core's flow.
 *
 * It loosens no setting — an imported mailbox arrives at the defaults, as a connected one does — but it connects
 * accounts, stores their tokens and possibly an OAuth client's secret on this machine, and the design counts adding
 * an account as a change a person approves. So the plan is a dry run, and its findings are the effects: every
 * mailbox by name, address and file, and the client if it is new. What the dry run found is what `apply` imports.
 *
 * Asked for as a dry run, it is one: no effects, so nobody is asked, and nothing is written.
 */
export function inboxImportChange(context: GmailContext, request: ImportRequest): GatedChange<ImportResult> {
  // Checked before anything is read, dry run included, and before any approval could be prepared for it.
  const options: ImportOptions = { ...request, store: parseStore(request.store) };
  if (options.dryRun) {
    return {
      plan: (config) => ({ before: config, after: config, summary: 'Say what an import would do' }),
      apply: () => importLegacy(context, { ...options, dryRun: true, approved: undefined }),
    };
  }
  let approved: ApprovedImport | undefined;
  return {
    plan: async (config) => {
      // Refused here, before anybody is asked, when it names a store other than the one credentials are kept in.
      const { store } = secretsStoreFor(config, options.store);
      const found = await importLegacy(context, { ...options, dryRun: true, approved: undefined });
      const client = found.client;
      approved = {
        registersClient: client !== null && !client.alreadyPresent,
        mailboxes: found.imported.map((candidate) => ({
          file: candidate.file,
          alias: candidate.alias,
          email: candidate.email ?? '',
        })),
      };
      const directory = importDirectory(context, options.dir);
      const effects = [
        ...(approved.registersClient && client
          ? [
              `registers the OAuth client ${client.clientId} from ${join(directory, 'gcp-oauth.keys.json')} as "${client.name}", and keeps its secret in the ${store} store on this machine`,
            ]
          : []),
        ...found.imported.map(
          (candidate) =>
            `connects ${candidate.alias} (${candidate.email}) with ${candidate.tier} access, copying the token in ${candidate.file}; the file itself is left as it is`,
        ),
      ];
      const count = found.imported.length;
      /*
       * The write the import makes to the configuration itself, declared: registering the client records the store
       * its secret went into. Planned as the unchanged configuration, a store that loosened anything went unseen
       * until the last write refused it — after the secret had been stored. Declared, the classifier measures it
       * here, the preview shows it, and the approval binds it.
       */
      const after = approved.registersClient ? { ...config, secrets: { store } } : config;
      return {
        before: config,
        after,
        summary: `Import ${count} mailbox${count === 1 ? '' : 'es'} from ${directory}`,
        effects,
      };
    },
    apply: () => {
      // Never without the list: an import with no `approved` is an import of whatever is there now.
      if (!approved) throw new CommsError('UNEXPECTED', 'the import was not planned before it was applied');
      return importLegacy(context, { ...options, dryRun: false, approved });
    },
  };
}

export async function importLegacy(context: GmailContext, options: ImportOptions = {}): Promise<ImportResult> {
  const directory = importDirectory(context, options.dir);
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

  // An approval that did not include registering the client does not cover it: the client it expected has gone.
  const approved = dryRun ? undefined : options.approved;
  if (approved && !approved.registersClient && !existingClient) {
    throw new CommsError('CONFIG', `the OAuth client this import was approved to use is no longer registered`, {
      hint: 'Nothing was imported. Prepare the import again, and read the preview before approving it.',
    });
  }

  const credentialFiles = entries.filter((entry) => /^creds-.+\.json$/i.test(entry) || entry === 'credentials.json');
  const names = importNames(config, credentialFiles, options.renames ?? []);
  const imported: ImportCandidate[] = [];
  const skipped: ImportCandidate[] = [];

  // One backend, decided once. This opened the **file** store and then recorded **keychain** in config, so an
  // import into a fresh configuration wrote the refresh token to disk and left the registry pointing at a
  // keychain entry that was never created — a mailbox that looks connected and cannot read its own token. The
  // skill's own procedure runs `inbox import` before `client add`, which is exactly the case with no store set.
  //
  // And the one already in use wins over `--store`, which is refused when it differs (`secretsStoreFor`) — dry run
  // included, since that says what the import would do. It was silently ignored where a store was recorded, and
  // where none was but Slack had stored a token in the keychain, it was taken: the client's secret went into files,
  // and only the last write refused to record them.
  const { store } = secretsStoreFor(config, options.store);
  const secrets = dryRun ? null : await context.core.secrets(store);
  if (!dryRun && secrets && !existingClient) {
    const ref = clientSecretRef(clientKey);
    /*
     * Under the credentials lock, and the name checked again inside it before the secret is written.
     *
     * The secret's reference is derived from the client's name, so two imports racing for one name from two Google
     * projects write the same reference — and the loser, finding the other's row, would take it for its own. Inside
     * the lock the second finds the name taken before it writes anything. `secrets migrate` holds the same lock, so
     * the backend cannot move under this write either.
     */
    await withCredentialsLock(context.core.paths.configDir, async () => {
      const held = (await context.config()).clients;
      if (Object.hasOwn(held, clientKey)) {
        throw new CommsError('CONFIG', `an OAuth client called "${clientKey}" was added while this ran`, {
          hint: 'Run the import again.',
        });
      }
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
            requireStore(current, secrets.kind);
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
        async () => {
          const row = (await context.config()).clients[clientKey];
          return row?.secretRef === ref && row.clientId === parsedClient.clientId;
        },
        // Another client's row naming the same reference: never withdraw it, whoever wrote last.
        async () => {
          const row = (await context.config()).clients[clientKey];
          return row?.secretRef === ref && row.clientId !== parsedClient.clientId;
        },
      );
    });
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
    // Checked last, so a file the dry run skipped for its own reason is still reported with that reason.
    const outside = approved ? outsideApproval(approved, candidate) : null;
    if (outside) {
      skipped.push({ ...candidate, problem: outside });
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
            requireStore(existing, secrets.kind);
            // Re-checked under the lock: another add or import can connect the same account meanwhile, and two rows
            // for one account would share — and overwrite — one grant.
            const raced = duplicateInbox(existing, { client: clientKey, email });
            if (raced) {
              throw new CommsError('CONFIG', `${email} was connected as "${raced}" while this ran`, {
                hint: 'Run the import again.',
              });
            }
            // And the client these tokens were issued by is still the one registered under that name.
            if (existing.clients[clientKey]?.clientId !== parsedClient.clientId) {
              throw new CommsError('CONFIG', `the OAuth client "${clientKey}" changed while this ran`, {
                hint: 'Run the import again.',
              });
            }
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

/** Why a mailbox about to be imported is not the one an approval covered, or null when it is. */
function outsideApproval(approved: ApprovedImport, candidate: ImportCandidate): string | null {
  const allowed = approved.mailboxes.find((mailbox) => mailbox.file === candidate.file);
  if (!allowed) return 'it was not in the import that was approved';
  if (allowed.alias !== candidate.alias) {
    return `it would be called "${candidate.alias}" now, not the "${allowed.alias}" that was approved`;
  }
  if (allowed.email.toLowerCase() !== (candidate.email ?? '').toLowerCase()) {
    return `it is ${candidate.email ?? 'an unknown address'} now, not the ${allowed.email} that was approved`;
  }
  return null;
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
 * Refuses a write whose secret went into a backend that is no longer the one in use: recorded, or — with none
 * recorded — the keychain a token stored meanwhile commits this configuration to.
 */
function requireStore(config: Config, kind: StoreKind): void {
  if ((committedSecretsStore(config) ?? kind) !== kind) {
    throw new CommsError('TRANSIENT', 'the secret store was changed while this ran', {
      hint: 'Run the import again.',
    });
  }
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
  ownedByAnother?: () => Promise<boolean>,
): Promise<void> {
  try {
    await secrets.set(ref, value);
    await record();
  } catch (error) {
    const landed = await writeOutcome(recorded);
    if (landed === 'unknown') throw keepAndReport(error, ref, 'Run `agent-gmail inbox list`.');
    if (landed === 'absent') {
      /*
       * Not taken back if another row names it.
       *
       * A client's reference is derived from its name, so a writer that does not hold the credentials lock — an older
       * release — can register the same name in between. Deleting the reference would then delete the credential
       * that row depends on. Whose secret is there now cannot be known, so it is said, not guessed at.
       */
      if (ownedByAnother) {
        /*
         * A client's reference is never taken back. It is derived from the name, so a writer outside the lock can
         * register that name at any moment — including between a check and a delete — and a delete would then take a
         * credential that row depends on. The reference is kept and named, which is recoverable; a deleted secret
         * Google shows once is not.
         */
        const base = error instanceof CommsError ? error : new CommsError('UNEXPECTED', String(error));
        const contested = (await writeOutcome(ownedByAnother)) !== 'absent';
        throw new CommsError(base.code, base.message, {
          hint: contested
            ? `${base.hint ? `${base.hint} ` : ''}Something else registered this client name while the import ran, and ` +
              `both wrote \`${ref}\`, so it may now hold the wrong secret. Register that client again with ` +
              '`agent-gmail client add <its JSON> --replace`.'
            : `${base.hint ? `${base.hint} ` : ''}The client's secret was stored as \`${ref}\` but not registered. ` +
              'Run the import again, or delete it from your secret store.',
          details: contested ? { contestedSecretRef: ref } : { strandedSecretRef: ref },
          cause: error,
        });
      }
      throw await withdrawStaged(secrets, ref, error);
    }
  }
}
