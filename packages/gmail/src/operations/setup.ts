import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GmailContext } from '../context.ts';
import { listRegisteredServers } from './client-configs.ts';

/**
 * What a person has to do before this software can read their mail, and how much of it they have already done.
 *
 * This exists because `doctor` was standing in for it. `doctor` is a diagnostic — it answers "what is broken" for
 * an install that used to work — and pressing it into service as step one of onboarding produced advice written
 * for the wrong reader: its remedy for an unconfigured machine is `client add ~/Downloads/client_secret_*.json`,
 * a command naming a file the person does not have and cannot get without leaving the terminal. It told someone
 * setting up for the first time to repair something they had not built yet.
 *
 * So the order is inverted. This reports what is *next*, not what is *wrong*, and nothing here is a failure: an
 * empty machine is the expected starting state rather than a fault to be reported.
 */

/** Google reorganised these screens in 2025; the old `APIs & Services` paths no longer exist. */
export const CONSOLE_STEPS: readonly { title: string; url: string; detail: string }[] = [
  {
    title: 'Create a project',
    url: 'https://console.cloud.google.com/projectcreate',
    detail: 'Any name. It holds the credentials, nothing else.',
  },
  {
    title: 'Enable the Gmail API',
    url: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
    detail: 'Press Enable. For contact search, enable the People API too.',
  },
  {
    title: 'Branding',
    url: 'https://console.cloud.google.com/auth/branding',
    detail: 'An app name and your own address as the support email is enough.',
  },
  {
    title: 'Audience — and this is the one people get wrong',
    url: 'https://console.cloud.google.com/auth/audience',
    detail:
      'Choose External, then press Publish app so it reads "In production". Left in Testing, Google expires ' +
      'every grant seven days after you make it, and every mailbox stops working in a week.',
  },
  {
    title: 'Create the client',
    url: 'https://console.cloud.google.com/auth/clients',
    detail: 'Create client → application type Desktop app → Create → download the JSON.',
  },
];

export interface SetupState {
  /** `client`, `inbox`, `mcp`, or `done` — the one thing to do next, never a list of everything undone. */
  next: 'client' | 'inbox' | 'mcp' | 'done';
  clients: string[];
  inboxes: string[];
  /** MCP clients this server is already registered with. */
  registeredWith: string[];
  /** A downloaded OAuth client JSON we can offer, newest first. Empty is normal and not a problem. */
  candidates: string[];
}

/**
 * Newest-first OAuth client JSONs sitting in the usual download directory.
 *
 * Offered, never used on its own: this reads a directory looking for a file containing a secret, so it asks before
 * doing anything with what it finds. `~/Downloads` is also not reliable — Windows can redirect it to OneDrive and
 * Linux takes it from `XDG_DOWNLOAD_DIR`, localised — so finding nothing here is an ordinary outcome and the
 * caller must still accept a path typed by hand.
 */
export async function findClientJson(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const home = env.HOME || env.USERPROFILE || homedir();
  const directory = env.XDG_DOWNLOAD_DIR || join(home, 'Downloads');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const matches = names.filter((name) => /^client_secret.*\.json$/i.test(name));
  const withTimes = await Promise.all(
    matches.map(async (name) => {
      const path = join(directory, name);
      try {
        return { path, at: (await stat(path)).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  return withTimes
    .filter((entry): entry is { path: string; at: number } => entry !== null)
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.path);
}

/** Where this machine is in the setup, and the single next thing to do. */
export async function setupState(context: GmailContext): Promise<SetupState> {
  const config = await context.core.config.load();
  const clients = Object.keys(config.clients);
  const inboxes = Object.keys(config.inboxes);

  let registeredWith: string[] = [];
  try {
    const servers = await listRegisteredServers(context.env);
    registeredWith = [
      ...new Set(
        servers
          .filter((server) => [server.command, ...server.args].join(' ').includes('agentcomms/gmail'))
          .map((server) => server.client),
      ),
    ];
  } catch {
    // Unreadable client configs are not a setup failure; the MCP step simply cannot be skipped automatically.
  }

  const next =
    clients.length === 0 ? 'client' : inboxes.length === 0 ? 'inbox' : registeredWith.length === 0 ? 'mcp' : 'done';
  return { next, clients, inboxes, registeredWith, candidates: await findClientJson(context.env) };
}
