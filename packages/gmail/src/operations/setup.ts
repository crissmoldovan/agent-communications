import type { FileHandle } from 'node:fs/promises';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GmailContext } from '../context.ts';
import { listRegisteredServers } from './client-configs.ts';

/**
 * What a person has to do before this software can read their mail, and how much of it they have already done.
 *
 * This exists because `doctor` was standing in for it. `doctor` is a diagnostic — it answers "what is broken" for
 * an install that used to work — and pressing it into service as step one of onboarding produced advice written
 * for the wrong reader: its remedy for an unconfigured machine named a downloaded file the person did not have and
 * could not get without leaving the terminal. Repair instructions, handed to somebody who had not built the thing.
 *
 * So the order is inverted. This reports what is *next*, not what is *wrong*, and an empty machine is the expected
 * starting state rather than a fault.
 *
 * **Everything here is data, and none of it is prose for a terminal.** The steps, their fields and their traps are
 * structures a caller renders — the CLI prints them, and a settings pane or a web installer would lay the same
 * ones out as a form without this file changing. The one thing no surface can avoid is that a person has to be
 * present: the console needs a browser and the consent screen needs a human.
 */

export interface ConsoleStep {
  id: string;
  title: string;
  url: string;
  /** Why this screen exists at all, in one line. */
  why: string;
  /** Exactly what to do there, in order — each one a thing to type, choose or press. */
  actions: readonly string[];
  /** Things that look right and are not. Empty for steps that have none. */
  avoid: readonly string[];
}

/**
 * Google reorganised these screens in 2025; the old `APIs & Services → OAuth consent screen` paths are gone.
 *
 * The detail is deliberately field-by-field. Every one of these screens has inputs whose right answer is not
 * obvious, and two of them have a wrong answer that looks more correct than the right one — a "Web application"
 * client reads as the modern choice, and leaving an app in Testing reads as the cautious one. Both break things,
 * one of them a week later.
 */
export const CONSOLE_STEPS: readonly ConsoleStep[] = [
  {
    id: 'project',
    title: 'Create a project',
    url: 'https://console.cloud.google.com/projectcreate',
    why: 'Credentials belong to a project. This one holds nothing else.',
    actions: [
      'Project name: anything you will recognise later — "gmail-agent" is fine.',
      'Location / organisation: leave as it is.',
      'Press Create, then wait for it to become the selected project at the top of the page.',
    ],
    avoid: [],
  },
  {
    id: 'api',
    title: 'Enable the Gmail API',
    url: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
    why: 'A project can reach no Google API until you turn that one on.',
    actions: [
      'Check the project named at the top is the one you just made.',
      'Press Enable, and wait for it to say the API is enabled.',
      'For contact search, do the same at the People API: https://console.cloud.google.com/apis/library/people.googleapis.com',
    ],
    avoid: [],
  },
  {
    id: 'branding',
    title: 'Branding',
    url: 'https://console.cloud.google.com/auth/branding',
    why: 'The name and address here are what your own sign-in screen will show you later.',
    actions: [
      'App name: anything. You are the only person who will see it.',
      'User support email: your own address, from the dropdown.',
      'Developer contact information: your own address again.',
      'Leave the logo, authorised domains and links empty. Press Save.',
    ],
    avoid: ['Do not upload a logo. It triggers a verification review you do not need.'],
  },
  {
    id: 'audience',
    title: 'Audience — the step people get wrong',
    url: 'https://console.cloud.google.com/auth/audience',
    why: 'This decides whether your sign-in lasts, or stops working in seven days.',
    actions: [
      'User type: External.',
      'Find Publishing status, press PUBLISH APP, and confirm.',
      'When it is right, the status reads "In production".',
    ],
    avoid: [
      'Do NOT add yourself under "Test users" and stop there. Testing mode has two consequences, and you will ' +
        'meet one of them: only the project owner and accounts listed as test users can sign in at all — every ' +
        'other address is refused with "Access blocked … has not completed the Google verification process" — ' +
        "and any sign-in that does work expires seven days later, because Google expires a test user's " +
        'authorization and its refresh token with it.',
      'Publishing submits nothing for review and asks nothing of you. Verification only matters past 100 accounts.',
    ],
  },
  {
    id: 'client',
    title: 'Create the client',
    url: 'https://console.cloud.google.com/auth/clients',
    why: 'This is the credential itself — the file this tool reads.',
    actions: [
      'Press Create client.',
      'Application type: Desktop app.',
      'Name: anything. "Desktop client 1" is the default and is fine.',
      'Press Create, then download the JSON from the dialog that appears.',
    ],
    avoid: [
      'Application type must be Desktop app, NOT Web application. A Web client requires a registered redirect ' +
        'URI, and this signs in on a loopback address, so it is refused.',
      'Download the JSON from that dialog. Google shows the secret only when the client is created.',
    ],
  },
];

/** What a downloaded client file turns out to be, read rather than guessed from its name. */
export type ClientKind = 'desktop' | 'web' | 'unreadable';

export interface ClientCandidate {
  path: string;
  kind: ClientKind;
  /** When it was downloaded, so somebody choosing between several can tell which is the one they just made. */
  modifiedAt: string;
}

export interface SetupState {
  /** The one thing to do next, never a list of everything undone. */
  next: 'client' | 'inbox' | 'mcp' | 'done';
  /** What is already behind you, so a second run says what it is resuming instead of starting over silently. */
  done: readonly ('client' | 'inbox' | 'mcp')[];
  clients: string[];
  inboxes: string[];
  registeredWith: string[];
  /** Downloaded client files: Desktop first, then newest first. Empty is ordinary. */
  candidates: ClientCandidate[];
}

/**
 * Client JSONs in the download directory, classified by reading them rather than by their names.
 *
 * Sorting on the date alone offered a **Web application** client as the obvious choice, because it happened to be
 * the newest file matching `client_secret*.json`. `parseClientJson` refuses that a moment later, correctly — but
 * the person had created a Desktop client and was handed a complaint about a web one they never chose. So the
 * kind is read here, Desktop sorts first, and the caller shows the kind and the date rather than picking for them.
 *
 * `~/Downloads` is not reliable either — Windows can redirect it to OneDrive, Linux takes it from
 * `XDG_DOWNLOAD_DIR` and localises the name — so finding nothing is an ordinary outcome, and every caller must
 * still accept a path typed by hand.
 */
export async function findClientJson(env: NodeJS.ProcessEnv = process.env): Promise<ClientCandidate[]> {
  const home = env.HOME || env.USERPROFILE || homedir();
  const directory = env.XDG_DOWNLOAD_DIR || join(home, 'Downloads');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const found = await Promise.all(
    names
      .filter((name) => /^client_secret.*\.json$/i.test(name))
      .map(async (name): Promise<(ClientCandidate & { at: number }) | null> => {
        const path = join(directory, name);
        /*
         * Opened once, then both the date and the contents come off that handle.
         *
         * Two calls by path — `stat` then `readFile` — describe whatever the name pointed at each time, which can
         * be two different files. That matters more than usual here: this reads a client secret, and following a
         * name to something else is exactly the substitution `O_NOFOLLOW` exists to refuse elsewhere in this
         * package. One handle removes the gap, and costs nothing.
         */
        let handle: FileHandle;
        try {
          handle = await open(path, 'r');
        } catch {
          return null;
        }
        try {
          const info = await handle.stat();
          const at = info.mtimeMs;
          const modifiedAt = info.mtime.toISOString();
          try {
            const json = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
            const kind: ClientKind = json.installed ? 'desktop' : json.web ? 'web' : 'unreadable';
            return { path, kind, modifiedAt, at };
          } catch {
            // Listed anyway: an unreadable file may still be the one they meant, and saying so beats hiding it.
            return { path, kind: 'unreadable', modifiedAt, at };
          }
        } catch {
          return null;
        } finally {
          await handle.close();
        }
      }),
  );

  const rank = (kind: ClientKind) => (kind === 'desktop' ? 0 : kind === 'web' ? 1 : 2);
  return found
    .filter((entry): entry is ClientCandidate & { at: number } => entry !== null)
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.at - a.at)
    .map(({ at: _at, ...candidate }) => candidate);
}

/** Where this machine is in the setup, what is already behind it, and the single next thing to do. */
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

  const done: ('client' | 'inbox' | 'mcp')[] = [];
  if (clients.length > 0) done.push('client');
  if (inboxes.length > 0) done.push('inbox');
  if (registeredWith.length > 0) done.push('mcp');

  const next =
    clients.length === 0 ? 'client' : inboxes.length === 0 ? 'inbox' : registeredWith.length === 0 ? 'mcp' : 'done';
  return { next, done, clients, inboxes, registeredWith, candidates: await findClientJson(context.env) };
}
