import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isProductServer, listRegisteredServers } from '@agentcomms/core';
import { parseClientJson } from '../auth/oauth.ts';
import type { GmailContext } from '../context.ts';
import { GMAIL_MCP } from '../mcp/install.ts';
import { readSmallFile } from './small-file.ts';

/**
 * What has to happen before this software can read somebody's mail, and how much of it is already done.
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
 * ones out as a form without this file changing. The one thing no surface can avoid is the browser: the console
 * and the consent screen are both pages this code does not drive and cannot answer for.
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

/** How many files the scan will open and read. A download directory can hold thousands; the answer is in the newest few. */
const MAX_CANDIDATES = 40;

/**
 * How many it will take a date from first.
 *
 * `lstat` is cheap and reads no content, so a wider net here costs little and is what makes "the newest forty"
 * mean anything. Past this the directory is pathological and the newest file is somebody else's problem.
 */
const MAX_NAMES_DATED = 500;

/**
 * Desktop, web, or neither — decided by running the real parser, not by a check that resembles it.
 *
 * Saying "usable" about a file that is about to be rejected is worse than saying nothing, and this got there
 * twice. First `{"installed": true}` passed a truthiness test. Then a rewrite required a non-empty `client_id`
 * and still called a file usable when it had no `client_secret`, or an id without the
 * `.apps.googleusercontent.com` suffix — because it was a second implementation of the same rules, and a second
 * implementation drifts by definition.
 *
 * So it calls `parseClientJson` and reads the answer from whether it threw. There is nothing left to drift.
 */
function classifyClient(text: string): ClientKind {
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    // `JSON.parse` returns any JSON value, and `null` is one of them — `typeof null` is `'object'`, so the
    // obvious check lets it through and the next line reads a property off it. A file containing the four
    // characters `null` is valid JSON, and it threw a TypeError out of the whole scan: one piece of junk in a
    // download directory and `setup` could not tell you anything at all.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
    json = parsed as Record<string, unknown>;
  } catch {
    return 'unreadable';
  }
  // Named separately because it is the one wrong kind worth explaining: a Web client is a real, valid credential
  // that this cannot use, and "unreadable" would send somebody looking for a corrupt download.
  if (json.web && !json.installed) return 'web';
  try {
    parseClientJson(text);
    return 'desktop';
  } catch {
    return 'unreadable';
  }
}

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
  /**
   * Which OAuth client each mailbox signed in through, from the same read as everything else here.
   *
   * Carried rather than looked up, because the caller that needed it was loading the config a second time to get
   * it — and two reads are two moments. A mailbox removed in between produced an answer whose `inboxes` came
   * from one snapshot and whose verdict came from another, which is the bug this state object exists to avoid.
   */
  clientOf: Record<string, string>;
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
export interface FindClientOptions {
  /** How many matching names are dated before the newest are chosen. Defaults to {@link MAX_NAMES_DATED}. */
  maxDated?: number;
  /** How many of those are opened and read. Defaults to {@link MAX_CANDIDATES}. */
  maxOpened?: number;
}

export async function findClientJson(
  env: NodeJS.ProcessEnv = process.env,
  options: FindClientOptions = {},
): Promise<ClientCandidate[]> {
  const maxDated = options.maxDated ?? MAX_NAMES_DATED;
  const maxOpened = options.maxOpened ?? MAX_CANDIDATES;
  const home = env.HOME || env.USERPROFILE || homedir();
  const directory = env.XDG_DOWNLOAD_DIR || join(home, 'Downloads');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  /*
   * Dates first, then the newest forty — in that order, because the other way round is not "the newest forty".
   *
   * `readdir` returns names in whatever order the filesystem gives, which is not time. Slicing before reading any
   * date therefore took an arbitrary forty and called them recent: in a directory with more than forty matches,
   * the client somebody downloaded a minute ago could simply be absent, and the step whose entire job is to find
   * that file would say it was not there.
   *
   * `lstat` gives the date without opening anything and without following a link, so the wide pass is cheap. Only
   * the forty newest are then opened and read.
   */
  const matches = names.filter((name) => /^client_secret.*\.json$/i.test(name)).slice(0, maxDated);
  const dated = await Promise.all(
    matches.map(async (name) => {
      try {
        return { name, at: (await lstat(join(directory, name))).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const newest = dated
    .filter((entry): entry is { name: string; at: number } => entry !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, maxOpened);

  const found = await Promise.all(
    newest.map(async ({ name }): Promise<(ClientCandidate & { at: number }) | null> => {
      const path = join(directory, name);
      /*
       * A bounded read, and `follow: false`.
       *
       * Nothing here chose these paths: they are whatever is sitting in a directory other software writes to,
       * matched on their names. So a match can be a symlink, a FIFO, a directory or something enormous, and a
       * plain `readFile` on each would follow, block, throw or exhaust memory in turn. `readSmallFile` refuses
       * all four off one handle — which also removes the gap between a `stat` and a `readFile` by path, and
       * the file in question is a client secret.
       */
      const file = await readSmallFile(path, { follow: false });
      if (!file.ok) {
        // A file that is the wrong shape entirely is not listed; one that is merely too big to be a client
        // JSON is, because it is a file with the right name and saying nothing about it would be stranger.
        if (file.problem !== 'too-large') return null;
        return { path, kind: 'unreadable', modifiedAt: file.modifiedAt.toISOString(), at: file.modifiedMs };
      }
      const modifiedAt = file.modifiedAt.toISOString();
      // An unreadable file is listed rather than hidden: it may still be the one they meant, and saying so
      // beats saying nothing.
      return { path, kind: classifyClient(file.text), modifiedAt, at: file.modifiedMs };
    }),
  );

  const rank = (kind: ClientKind) => (kind === 'desktop' ? 0 : kind === 'web' ? 1 : 2);
  return found
    .filter((entry): entry is ClientCandidate & { at: number } => entry !== null)
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.at - a.at)
    .map(({ at: _at, ...candidate }) => candidate);
}

export interface SetupStateOptions {
  /**
   * Whether to scan the download directory for client files.
   *
   * On by default, because the answer to "what is next" usually needs it. Off where the candidates are thrown
   * away: the setup flow re-reads this state after every step, and a pinned MCP server drops the list entirely —
   * so both were paying for a few hundred `lstat`s and up to forty opened files to produce something nobody read.
   * The setup command alone did it five times in a row.
   */
  scanDownloads?: boolean;
}

/**
 * Whether a registered MCP server is one of ours.
 *
 * This decides whether the last setup step is behind you, and it has now been wrong in both directions.
 *
 * It began as `join(' ').includes('agentcomms/gmail')` — a substring test against a whole command line, which
 * `@notagentcomms/gmail-mcp` and `/opt/notagentcomms/gmail/…` also satisfy: somebody else's server reporting our
 * setup complete. Replacing it with a segment match fixed that and broke the common case instead, because the
 * managed installer — the default — writes `…/node_modules/@agentcomms/gmail/dist/cli.mjs`, and the segment is
 * `@agentcomms`, not `agentcomms`. A correctly registered default install reported `registeredWith: []`, so
 * setup would have said the agent step was still to do, forever.
 *
 * So it is written against what the installer actually emits, which is one of three shapes:
 *
 *   npx      `npx -y @agentcomms/gmail-mcp@<version> …`   → read from `packageName`
 *   managed  `node <data>/runtime/<v>-gmail/node_modules/@agentcomms/gmail/dist/cli.mjs mcp serve`
 *   local    `node <checkout>/packages/gmail/{src/cli.ts,dist/cli.mjs} mcp serve`
 *
 * The middle one is matched on the two consecutive segments `@agentcomms` and `gmail` — exactly, so
 * `gmail-evil` is not one of ours — and the last on this package's own directory followed by the entry it runs.
 */
export function isOurServer(server: { command: string; args: string[]; packageName?: string | undefined }): boolean {
  // One matcher, in core, shared with the installer: what counts as ours here is also what `mcp install --force`
  // may replace, and two copies of that rule are two chances for them to disagree.
  return isProductServer(server, GMAIL_MCP);
}

/** Where this machine is in the setup, what is already behind it, and the single next thing to do. */
export async function setupState(context: GmailContext, options: SetupStateOptions = {}): Promise<SetupState> {
  const config = await context.core.config.load();
  const clients = Object.keys(config.clients);
  const inboxes = Object.keys(config.inboxes);

  let registeredWith: string[] = [];
  try {
    const servers = await listRegisteredServers(context.env);
    registeredWith = [...new Set(servers.filter(isOurServer).map((server) => server.client))];
  } catch {
    // Unreadable client configs are not a setup failure; the MCP step simply cannot be skipped automatically.
  }

  const done: ('client' | 'inbox' | 'mcp')[] = [];
  if (clients.length > 0) done.push('client');
  if (inboxes.length > 0) done.push('inbox');
  if (registeredWith.length > 0) done.push('mcp');

  const next =
    clients.length === 0 ? 'client' : inboxes.length === 0 ? 'inbox' : registeredWith.length === 0 ? 'mcp' : 'done';
  const candidates = options.scanDownloads === false ? [] : await findClientJson(context.env);
  const clientOf = Object.fromEntries(Object.entries(config.inboxes).map(([alias, inbox]) => [alias, inbox.client]));
  return { next, done, clients, inboxes, clientOf, registeredWith, candidates };
}
