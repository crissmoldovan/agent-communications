import { CommsError } from '@agentcomms/core';
import { compareUtf8, isWellFormed, type RouteCandidate, utf8ByteLength } from '@agentcomms/events';
import { isKeptSenderDomain } from './sender-domain.ts';

/**
 * A project (workflows design §8.1, W11, W12): a GitHub repository, its folders on this Mac — checkouts and their
 * worktrees — a profile the person writes, and hints that choose it without a judge. Projects are the person's alone:
 * only the person adds, changes or removes one, at their terminal or in the app, and no agent reads the list. A
 * project's folders become authority only when an approved workflow's route step binds them, by value, as a candidate;
 * the profile and the hints only choose among candidates, and change at once.
 *
 * This module is the document's shape, pure: an id, a name, a repository folded to `github.com/<owner>/<name>`, a
 * profile of at most 2,000 characters, the hint lists (the person's words, each list at most 2,000 characters) and the
 * folders, written as absolute paths. That each folder is its own realpath, a checkout or worktree of that repository,
 * inside the relay's allowed roots and outside Agent Comms' own folders is checked by `runtime/projects.ts`, which can
 * look at the disk and run git.
 */

/** One of a project's folders, as `project show` gives it. */
export interface ProjectFolderV1 {
  readonly folder: string;
  readonly kind: 'checkout' | 'worktree';
  /** The branch a new worktree starts from by default; null for a worktree, or when the person gave none. */
  readonly defaultBranch: string | null;
  /** Where this checkout's worktrees go: null for `<checkout>-wt` beside it. Always null for a worktree. */
  readonly worktreeRoot: string | null;
}

/** What chooses a project without a judge: the person's words, matched exactly. */
export interface ProjectHintsV1 {
  /** Sender address domains, such as `acme.example`. */
  readonly senderDomains: readonly string[];
  /** Slack conversation ids, such as `C0123ABCD`. */
  readonly slackConversations: readonly string[];
  /** People, by their Slack user id (`U0123ABCD`) or their email address. */
  readonly people: readonly string[];
}

/** What `project add -` and `project update -` take. */
export interface ProjectDocument {
  readonly projectId: string;
  readonly name: string;
  readonly repo: string;
  readonly profile: string;
  readonly hints: ProjectHintsV1;
  readonly folders: readonly ProjectFolderV1[];
}

/** One project, as `project show` gives it and `projects list` lists it (plan I6). */
/**
 * A relay session working in one of a project's folders, or in a worktree a run made of it, as `project show` and
 * `projects list` give it: ids, a closed state and times. Never its title, which another client may have written.
 */
export interface ProjectSessionV1 {
  /** The relay session's id, `sess_<uuid>`. */
  readonly session: string;
  readonly provider: string;
  /** `busy` while a turn runs; `watched` for a window the relay only watches; else `idle`. */
  readonly state: 'idle' | 'busy' | 'watched';
  /** When it last started or ended a turn, or was made; null when the relay says neither. */
  readonly lastActiveAt: number | null;
  /** Its folder: one of the project's, or a run-made worktree's. */
  readonly folder: string;
}

export interface ProjectV1 extends ProjectDocument {
  readonly profileBy: 'person' | null;
  readonly profileAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * The relay sessions working in it (`project show`, `projects list`); null when the relay could not be asked, with
   * the closed reason in `sessionsReason`. Absent from what `project add` and `project update` answer.
   */
  readonly sessions?: readonly ProjectSessionV1[] | null;
  readonly sessionsReason?: string | null;
}

export interface ProjectsListResultV1 {
  readonly projects: readonly ProjectV1[];
}

export interface ProjectRemoveResultV1 {
  readonly projectId: string;
  readonly removed: true;
}

/** Why `project scan` passed a folder over. */
export const PROJECT_SCAN_SKIP_REASONS: readonly ['symlink', 'hidden', 'agent-comms', 'unreadable', 'depth'] =
  Object.freeze(['symlink', 'hidden', 'agent-comms', 'unreadable', 'depth'] as const);
export type ProjectScanSkipReason = (typeof PROJECT_SCAN_SKIP_REASONS)[number];

/** `project scan`: the checkouts found under the roots, by repository, and the folders passed over (plan I6). */
export interface ProjectScanResultV1 {
  readonly roots: readonly string[];
  readonly repos: readonly {
    readonly repo: string;
    /** The project that already names this repository, if any. */
    readonly known: string | null;
    readonly folders: readonly {
      readonly folder: string;
      readonly kind: 'checkout' | 'worktree';
      readonly defaultBranch: string | null;
    }[];
  }[];
  readonly skipped: readonly { readonly folder: string; readonly reason: ProjectScanSkipReason }[];
}

export const PROJECT_ID: RegExp = /^[a-z0-9-]{1,64}$/u;
export const PROJECT_LIMITS: {
  readonly name: 80;
  readonly profile: 2000;
  readonly hintList: 2000;
  readonly hintEntries: 64;
  readonly folders: 32;
  readonly folderBytes: 1024;
  readonly scanRoots: 8;
} = Object.freeze({
  name: 80,
  profile: 2000,
  hintList: 2000,
  hintEntries: 64,
  folders: 32,
  folderBytes: 1024,
  scanRoots: 8,
} as const);

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/u;
const NAME = /^[a-z0-9._-]{1,100}$/u;
const CONVERSATION_ID = /^[CDG][A-Z0-9]{2,31}$/u;
const PERSON_ID = /^[UW][A-Z0-9]{2,31}$/u;
const EMAIL = /^[^\s@<>"]{1,64}@[a-z0-9.-]{1,189}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are what the check refuses.
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are what the check refuses.
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
/** Fields the server sets: a document copied from `project show` may carry them, and they are not read. */
const SERVER_FIELDS: readonly string[] = [
  'profileBy',
  'profileAt',
  'createdAt',
  'updatedAt',
  'sessions',
  'sessionsReason',
];
const DOCUMENT_FIELDS: readonly string[] = ['projectId', 'name', 'repo', 'profile', 'hints', 'folders'];

function invalid(message: string): never {
  throw new CommsError('BAD_DATA', message, { details: { reason: 'PROJECT_DOCUMENT_INVALID' } });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Characters as SQLite's `length()` counts them: code points. */
function characters(text: string): number {
  return [...text].length;
}

/**
 * A GitHub repository in the one form a project keeps, `github.com/<owner>/<name>`, lower-cased, from the forms a
 * remote is written in: `https://github.com/o/n(.git)`, `ssh://git@github.com/o/n(.git)`, `git@github.com:o/n(.git)`,
 * `github.com/o/n`, or `o/n` as the person types it. Null for anything else: another host, a path, a query.
 */
export function foldGitHubRepo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300 || LINE_CONTROL.test(value)) return null;
  let rest = value.trim();
  const forms: readonly RegExp[] = [
    /^https:\/\/(?:[^@/]+@)?github\.com\/(.+)$/iu,
    /^ssh:\/\/git@github\.com(?::22)?\/(.+)$/iu,
    /^git@github\.com:(.+)$/iu,
    /^github\.com\/(.+)$/iu,
  ];
  const form = forms.map((pattern) => pattern.exec(rest)).find((match) => match !== null);
  if (form !== undefined && form !== null) rest = form[1] as string;
  else if (rest.includes(':') || rest.startsWith('/')) return null;
  rest = rest.replace(/\/+$/u, '').replace(/\.git$/iu, '');
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  const owner = (parts[0] as string).toLowerCase();
  const name = (parts[1] as string).toLowerCase();
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null;
  return `github.com/${owner}/${name}`;
}

/** An absolute folder as a project keeps one: POSIX, normal, no `.` or `..` step, no trailing `/`, at most 1 KiB. */
export function isProjectFolder(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.endsWith('/')) return false;
  if (utf8ByteLength(value) > PROJECT_LIMITS.folderBytes || LINE_CONTROL.test(value) || !isWellFormed(value))
    return false;
  return value
    .slice(1)
    .split('/')
    .every((step) => step !== '' && step !== '.' && step !== '..');
}

function hintList(value: unknown, what: string, normal: (entry: string) => string | null): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PROJECT_LIMITS.hintEntries)
    invalid(`a project's ${what} are a list of at most ${PROJECT_LIMITS.hintEntries}`);
  const entries = new Set<string>();
  for (const entry of value) {
    const normalised = typeof entry === 'string' ? normal(entry) : null;
    if (normalised === null) invalid(`${JSON.stringify(entry)} is not one of a project's ${what}`);
    entries.add(normalised);
  }
  const list = [...entries].sort(compareUtf8);
  if (list.reduce((total, entry) => total + characters(entry), 0) > PROJECT_LIMITS.hintList)
    invalid(`a project's ${what} are at most ${PROJECT_LIMITS.hintList} characters`);
  return list;
}

function hints(value: unknown): ProjectHintsV1 {
  if (value === undefined) return { senderDomains: [], slackConversations: [], people: [] };
  if (!isRecord(value)) invalid("a project's hints are { senderDomains, slackConversations, people }");
  for (const key of Object.keys(value))
    if (!['senderDomains', 'slackConversations', 'people'].includes(key)) invalid(`a project's hints have no ${key}`);
  return {
    senderDomains: hintList(value.senderDomains, 'sender domains', (entry) => {
      const domain = entry.trim().toLowerCase();
      return isKeptSenderDomain(domain) ? domain : null;
    }),
    slackConversations: hintList(value.slackConversations, 'Slack conversations', (entry) => {
      const id = entry.trim().toUpperCase();
      return CONVERSATION_ID.test(id) ? id : null;
    }),
    people: hintList(value.people, 'people', (entry) => {
      const trimmed = entry.trim();
      if (PERSON_ID.test(trimmed.toUpperCase())) return trimmed.toUpperCase();
      const address = trimmed.toLowerCase();
      return address.length <= 254 &&
        EMAIL.test(address) &&
        isKeptSenderDomain(address.slice(address.lastIndexOf('@') + 1))
        ? address
        : null;
    }),
  };
}

function folders(value: unknown): readonly ProjectFolderV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROJECT_LIMITS.folders)
    invalid(`a project has 1 to ${PROJECT_LIMITS.folders} folders`);
  const seen = new Set<string>();
  const found: ProjectFolderV1[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) invalid('a project folder is { folder, kind, defaultBranch, worktreeRoot }');
    for (const key of Object.keys(entry))
      if (!['folder', 'kind', 'defaultBranch', 'worktreeRoot'].includes(key)) invalid(`a project folder has no ${key}`);
    if (!isProjectFolder(entry.folder))
      invalid('a project folder is an absolute folder, written without . or .. steps or a trailing /');
    if (seen.has(entry.folder)) invalid(`the folder ${entry.folder} is listed once`);
    seen.add(entry.folder);
    if (entry.kind !== 'checkout' && entry.kind !== 'worktree') invalid('a project folder is a checkout or a worktree');
    const defaultBranch = entry.defaultBranch ?? null;
    if (
      defaultBranch !== null &&
      (typeof defaultBranch !== 'string' ||
        !BRANCH.test(defaultBranch) ||
        defaultBranch.includes('..') ||
        defaultBranch.endsWith('/') ||
        defaultBranch.endsWith('.lock'))
    )
      invalid("a folder's default branch is a branch name, or null");
    const worktreeRoot = entry.worktreeRoot ?? null;
    if (worktreeRoot !== null) {
      if (entry.kind !== 'checkout') invalid('only a checkout has a worktree root');
      if (!isProjectFolder(worktreeRoot))
        invalid("a checkout's worktree root is an absolute folder, or null for <checkout>-wt beside it");
    }
    found.push({
      folder: entry.folder,
      kind: entry.kind,
      defaultBranch: entry.kind === 'worktree' ? null : (defaultBranch as string | null),
      worktreeRoot: worktreeRoot as string | null,
    });
  }
  return found.sort((left, right) => compareUtf8(left.folder, right.folder));
}

/**
 * A project document, checked and in its one form: the hint lists sorted and unique, the folders sorted by their
 * bytes. Refused, `BAD_DATA`, naming what is wrong. Folders are checked against the disk by `Projects`, not here.
 */
export function canonicalProject(value: unknown): ProjectDocument {
  if (!isRecord(value)) invalid('a project document is one JSON object');
  for (const key of Object.keys(value))
    if (!DOCUMENT_FIELDS.includes(key) && !SERVER_FIELDS.includes(key))
      invalid(`a project document has no field ${key}`);
  if (typeof value.projectId !== 'string' || !PROJECT_ID.test(value.projectId))
    invalid("a project's id is 1 to 64 lowercase letters, digits and -");
  const name = value.name;
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    characters(name) > PROJECT_LIMITS.name ||
    LINE_CONTROL.test(name) ||
    !isWellFormed(name)
  )
    invalid(`a project's name is one line of 1 to ${PROJECT_LIMITS.name} characters`);
  const repo = foldGitHubRepo(value.repo);
  if (repo === null) invalid("a project's repository is a GitHub one: owner/name, or its https or ssh address");
  const profile = value.profile ?? '';
  if (
    typeof profile !== 'string' ||
    characters(profile) > PROJECT_LIMITS.profile ||
    TEXT_CONTROL.test(profile) ||
    !isWellFormed(profile)
  )
    invalid(`a project's profile is your own words, at most ${PROJECT_LIMITS.profile} characters`);
  return {
    projectId: value.projectId,
    name,
    repo,
    profile,
    hints: hints(value.hints),
    folders: folders(value.folders),
  };
}

/** A project id, or `USAGE`. */
export function projectIdArgument(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID.test(value))
    throw new CommsError('USAGE', "a project's id is 1 to 64 lowercase letters, digits and -");
  return value;
}

/**
 * The route candidate a project is, as an approved workflow binds it (W12): its id, name and every folder, sorted by
 * their bytes as `checkFlow` keeps a candidate's, and the worktree root of its first checkout.
 */
export function routeCandidateOf(project: ProjectDocument): RouteCandidate {
  const checkout = project.folders.find((folder) => folder.kind === 'checkout');
  return {
    projectId: project.projectId,
    name: project.name,
    folders: project.folders.map((folder) => folder.folder).sort(compareUtf8),
    worktreeRoot: checkout?.worktreeRoot ?? null,
  };
}
