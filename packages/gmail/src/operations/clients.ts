import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type ClientConfig,
  CommsError,
  expandHome,
  homeDirectory,
  keepAndReport,
  probeKeychain,
  type StoreKind,
  secretsStoreOf,
  withCredentialsLock,
  writeOutcome,
} from '@agentcomms/core';
import { parseClientJson, probeClientCredentials } from '../auth/oauth.ts';
import { clientSecretRef } from '../auth/session.ts';
import type { GmailContext } from '../context.ts';
import { MAX_CLIENT_BYTES, readSmallFile } from './small-file.ts';

export interface ClientView {
  name: string;
  clientId: string;
  projectId?: string | undefined;
  addedAt: string;
  /** Aliases of the inboxes signed in through this client. */
  inboxes: string[];
}

export interface ClientAddOptions {
  path: string;
  name?: string | undefined;
  /** Only meaningful for the first secret written to this config directory. */
  store?: StoreKind | undefined;
  /** Deletes the downloaded JSON once the secret is safely stored. */
  move?: boolean | undefined;
  /** Rotates the secret of an existing client with the same client id. */
  replace?: boolean | undefined;
  /** Skips the live check of the credentials (offline setup). */
  noProbe?: boolean | undefined;
}

export interface ClientAddResult extends ClientView {
  store: StoreKind;
  sourceRemoved: boolean;
  probed: boolean;
  probeSkippedReason?: string | undefined;
}

/**
 * Registers a Desktop OAuth client: the client id goes into config, the secret into the secret store, and the
 * downloaded file can be deleted. The secret is never printed, and never written to config.
 */
export async function clientAdd(context: GmailContext, options: ClientAddOptions): Promise<ClientAddResult> {
  const name = options.name ?? 'default';
  const path = resolve(expandHome(options.path, homeDirectory(context.env)));
  /*
   * A bounded read of a path somebody typed.
   *
   * `readFile` on a name will read whatever is at the end of it, and this name arrives from a person or from
   * `setup --client-json`: `/dev/zero` reads until the process dies, and a FIFO blocks until a writer appears
   * that may never come. Neither is a client JSON, and neither should be the way this command ends. The symlink
   * is followed here — unlike the download scan, this path is one the caller chose, so a link at it is theirs.
   */
  const file = await readSmallFile(path, { follow: true });
  if (!file.ok) {
    if (file.problem === 'missing') {
      throw new CommsError('NOT_FOUND', `no file at ${path}`, {
        hint: 'Download the client JSON from Google Cloud → Google Auth Platform → Clients, and pass its path.',
      });
    }
    throw new CommsError(
      'USAGE',
      file.problem === 'not-a-file'
        ? `${path} is not a file`
        : `${path} is far too large to be a client JSON (over ${Math.round(MAX_CLIENT_BYTES / 1024)}KB)`,
      { hint: 'Pass the JSON Google offered when the Desktop client was created; it is well under a kilobyte.' },
    );
  }
  const parsed = parseClientJson(file.text);
  const config = await context.config();
  const existing = config.clients[name];
  if (existing && !options.replace) {
    throw new CommsError('CONFIG', `an OAuth client called "${name}" is already registered`, {
      hint:
        existing.clientId === parsed.clientId
          ? `To rotate its secret, run the same command with --replace.`
          : `Choose another name with --name, or remove it first with \`agent-gmail client remove ${name}\`.`,
    });
  }
  if (existing && options.replace && existing.clientId !== parsed.clientId) {
    const users = inboxesOf(config.inboxes, name);
    if (users.length > 0) {
      throw new CommsError('CONFIG', `"${name}" is a different OAuth client, and ${users.length} inbox(es) use it`, {
        hint: `Replacing it would break ${users.join(', ')}. Add the new client under another name, then \`inbox reauth\` each inbox onto it.`,
      });
    }
  }

  // One backend per config directory: the first command that stores a secret picks it, and it cannot be mixed later.
  const chosen = await chooseStore(context, options.store);

  let probed = false;
  let probeSkippedReason: string | undefined;
  if (!options.noProbe) {
    const probe = await probeClientCredentials(context.endpoints, parsed);
    if (probe.ok) probed = true;
    else if (probe.fatal) throw probe.error;
    else probeSkippedReason = probe.reason;
  }

  const secrets = await context.core.secrets(chosen);
  const secretRef = clientSecretRef(name);
  /*
   * Under the credentials lock, and the name checked again inside it.
   *
   * The secret's reference is derived from the client's name, so a second writer of the same name — an import, or
   * another `client add` — writes the same reference. Held, whichever comes second finds the name taken before it
   * overwrites anything. The probe above is a network call and stays outside.
   */
  const client = await withCredentialsLock(context.core.paths.configDir, async () => {
    const fresh = await context.config();
    // The store was chosen before the lock; `secrets migrate` holds it too, and may have finished in between.
    if (fresh.secrets?.store && fresh.secrets.store !== chosen) {
      throw new CommsError('TRANSIENT', 'the secret store was changed while this ran', {
        hint: 'Run the command again.',
      });
    }
    const held = fresh.clients[name];
    if (held && !options.replace) {
      throw new CommsError('CONFIG', `an OAuth client called "${name}" was registered while this ran`, {
        hint: 'Run the command again to see what is there now.',
      });
    }
    // Re-checked here, not only on the snapshot: a sign-in completing in between can attach a mailbox to it.
    if (held && options.replace && held.clientId !== parsed.clientId && inboxesOf(fresh.inboxes, name).length > 0) {
      throw new CommsError('CONFIG', `"${name}" is a different OAuth client, and mailboxes use it`, {
        hint: 'Add the new client under another name, then `inbox reauth` each mailbox onto it.',
      });
    }
    if (held && options.replace && held.clientId !== existing?.clientId) {
      throw new CommsError('CONFIG', `the OAuth client "${name}" changed while this ran`, {
        hint: 'Run the command again to see what is there now.',
      });
    }
    // Kept, so a write that does not land can put the reference back as it was: the row would otherwise name this
    // client while the secret under it belongs to another — or a stray secret would be left under a name nothing uses.
    const previous = await secrets.get(secretRef);

    const row: ClientConfig = {
      provider: 'gmail',
      clientId: parsed.clientId,
      projectId: parsed.projectId,
      secretRef,
      addedAt: existing?.addedAt ?? context.now().toISOString(),
    };
    try {
      /*
       * Inside the boundary that puts it back: a keychain write can land after it has reported a timeout, so even a
       * failed write has to be reconciled rather than assumed not to have happened.
       */
      await secrets.set(secretRef, parsed.clientSecret);
      const stored = await secrets.get(secretRef);
      if (stored !== parsed.clientSecret) {
        throw new CommsError('SECRET_STORE_UNAVAILABLE', 'the secret did not read back the way it was written', {
          hint: 'Try again with `--store file` to keep secrets in owner-only files instead of the system keychain.',
        });
      }
      await context.core.config.update((current) => {
        // Never switch the store back: only `secrets migrate` changes it, and it moves the secrets with it.
        if (current.secrets?.store && current.secrets.store !== chosen) {
          throw new CommsError('TRANSIENT', 'the secret store was changed while this ran', {
            hint: 'Run the command again.',
          });
        }
        // The users are re-checked here as well as above: a sign-in completing between the two would otherwise
        // attach a mailbox to the client being replaced, and its token would not survive the replacement.
        const held = current.clients[name];
        if (held && held.clientId !== parsed.clientId && inboxesOf(current.inboxes, name).length > 0) {
          throw new CommsError('CONFIG', `"${name}" is a different OAuth client, and mailboxes use it`, {
            hint: 'Add the new client under another name, then `inbox reauth` each mailbox onto it.',
          });
        }
        return { ...current, secrets: { store: chosen }, clients: { ...current.clients, [name]: row } };
      });
    } catch (error) {
      // A rejected write may have committed (see `writeOutcome` in core). Only put the old secret back when it did
      // not, and say so if that fails: a client whose secret is the other one's cannot renew anything.
      const landed = await writeOutcome(
        async () => (await context.config()).clients[name]?.clientId === parsed.clientId,
      );
      if (landed === 'unknown') throw keepAndReport(error, secretRef, 'Run `agent-gmail client list`.');
      if (landed === 'absent') {
        // Exactly as it was: the previous secret, or nothing when there was none.
        try {
          if (previous === null) await secrets.delete(secretRef);
          else await secrets.set(secretRef, previous);
        } catch (restoreError) {
          const base = error instanceof CommsError ? error : new CommsError('UNEXPECTED', String(error));
          throw new CommsError(base.code, base.message, {
            hint: `${base.hint ? `${base.hint} ` : ''}The secret store could not be put back as it was: register the client again with \`agent-gmail client add <its JSON> --replace\`.`,
            details: { secretNotRestored: secretRef, restoreError: (restoreError as Error).message },
            cause: error,
          });
        }
      }
      if (landed !== 'present') throw error;
    }
    return row;
  });

  // Only once the secret is safely stored, and only if asked: the file is the one copy Google will ever show.
  let sourceRemoved = false;
  if (options.move) {
    await rm(path, { force: true });
    sourceRemoved = true;
  }

  return {
    ...view(name, client, await context.config().then((c) => inboxesOf(c.inboxes, name))),
    store: chosen,
    sourceRemoved,
    probed,
    probeSkippedReason,
  };
}

async function chooseStore(context: GmailContext, requested: StoreKind | undefined): Promise<StoreKind> {
  const config = await context.config();
  const current = config.secrets?.store;
  if (current) {
    if (requested && requested !== current) {
      throw new CommsError('CONFIG', `this configuration already keeps its secrets in the ${current} store`, {
        hint: `Everything here uses one store. To change it, run \`agentcomms secrets migrate --to ${requested}\`.`,
      });
    }
    return current;
  }
  const chosen = requested ?? 'keychain';
  if (chosen === 'keychain') {
    const probe = await probeKeychain();
    if (!probe.ok) {
      throw new CommsError('SECRET_STORE_UNAVAILABLE', `the system keychain cannot be used here: ${probe.reason}`, {
        hint: 'Run the command again with `--store file` to keep secrets in owner-only files in the config directory.',
      });
    }
  }
  return chosen;
}

export async function clientList(context: GmailContext): Promise<ClientView[]> {
  const config = await context.config();
  return Object.entries(config.clients).map(([name, client]) => view(name, client, inboxesOf(config.inboxes, name)));
}

export async function clientRemove(context: GmailContext, name: string): Promise<{ name: string }> {
  // Under the credentials lock, from the read to the secret deletion: `client add --replace` holds it too, and a
  // replacement landing in between would otherwise be re-added and then have its secret deleted from under it.
  return withCredentialsLock(context.core.paths.configDir, () => removeClientLocked(context, name));
}

async function removeClientLocked(context: GmailContext, name: string): Promise<{ name: string }> {
  const config = await context.config();
  const client = config.clients[name];
  if (!client) {
    throw new CommsError('NOT_FOUND', `no OAuth client called "${name}"`, {
      hint: Object.keys(config.clients).length
        ? `Known clients: ${Object.keys(config.clients).join(', ')}.`
        : 'None are registered yet.',
    });
  }
  const users = inboxesOf(config.inboxes, name);
  if (users.length > 0) {
    throw new CommsError('CONFIG', `${users.length} inbox(es) still sign in through "${name}"`, {
      hint: `Remove them first (${users.join(', ')}), or move them to another client with \`agent-gmail inbox reauth\`.`,
    });
  }
  try {
    await context.core.config.update((current) => {
      // The row this read, not whatever holds the name now.
      if (current.clients[name]?.clientId !== client.clientId) {
        throw new CommsError('CONFIG', `the OAuth client "${name}" changed while it was being removed`, {
          hint: 'Run the command again to see what is there now.',
        });
      }
      // And still used by nothing: a sign-in completing in between attaches a mailbox to it.
      const attached = inboxesOf(current.inboxes, name);
      if (attached.length > 0) {
        throw new CommsError(
          'CONFIG',
          `${attached.length} inbox(es) began using "${name}" while it was being removed`,
          { hint: `Remove them first (${attached.join(', ')}), or move them with \`agent-gmail inbox reauth\`.` },
        );
      }
      const clients = { ...current.clients };
      delete clients[name];
      return { ...current, clients };
    });
  } catch (error) {
    // A rejected write may have committed (see `writeOutcome` in core): only skip the deletion if the row is there.
    const gone = await writeOutcome(async () => (await context.config()).clients[name] === undefined);
    if (gone === 'absent') throw error;
    if (gone === 'unknown') throw keepAndReport(error, client.secretRef, 'Run `agent-gmail client list`.');
  }
  const secrets = await context.core.secrets();
  await secrets.delete(client.secretRef);
  return { name };
}

function inboxesOf(inboxes: Record<string, { client: string }>, name: string): string[] {
  return Object.entries(inboxes)
    .filter(([, inbox]) => inbox.client === name)
    .map(([alias]) => alias);
}

function view(name: string, client: ClientConfig, inboxes: string[]): ClientView {
  return {
    name,
    clientId: client.clientId,
    projectId: client.projectId,
    addedAt: client.addedAt,
    inboxes,
  };
}

/** The secret backend in use, for `doctor` and `inbox show`. */
export async function currentStore(context: GmailContext): Promise<StoreKind> {
  return secretsStoreOf(await context.config());
}
