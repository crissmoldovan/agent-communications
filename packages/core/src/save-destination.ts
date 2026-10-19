import { randomBytes } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { access, type FileHandle, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { approveAndWaitSentence } from './approval-handoffs.ts';
import { downloadExpiredWords, withApproval } from './approval-outcome.ts';
import { asV2, integrityRefusal, kindOf } from './approval-stored.ts';
import { validateV2 } from './approval-validate.ts';
import {
  type ApprovalRecord,
  type DownloadBinding,
  type DownloadRequest,
  downloadClaimRefusal,
  type ListedFile,
  otherVersionRefusal,
  type RecordedSaveAnswer,
} from './approvals.ts';
import { agentMarker, canPrompt, defaultStreams, paint, type Streams } from './cli-runtime.ts';
import type { ChangePolicy } from './config.ts';
import type { Core } from './core.ts';
import { CommsError } from './errors.ts';
import { type CliHandoffs, type Handoff, handoffSentence, handoffSentenceToFill, requireHandoffs } from './handoffs.ts';
import { APPROVAL_ID_PATTERN } from './ids.ts';
import { createUniqueFile } from './jail.ts';
import { DOWNLOADS_KNOWN_FOLDER, knownFolder } from './known-folders.ts';
import { expandHome, homeOf } from './paths.ts';
import { sizeOf, truncateDisplay } from './render.ts';
import {
  checkSaveFolder,
  refusedFolder,
  type SaveDenyInput,
  saveFolderRefusal,
  windowsPathProblem,
} from './save-deny.ts';
import { DOWNLOAD_SUFFIX, fileWarnings } from './saved-files.ts';

/**
 * Where a download is saved: the person's to say, every time.
 *
 * A Gmail attachment or a Slack file is a stranger's file, and where it lands on this machine is not a thing a tool
 * should decide for the person — nor an agent, which is who calls the tool. So a download asks first. The first call
 * reads what the request names and saves nothing: it lists the files, by name and size, and offers three places — the
 * person's Downloads folder (or the one they set as `defaults.downloadsDir`), the folder the command or the server
 * was started in, or a folder they name — each of the first two by its exact path, or as unavailable, with the
 * reason, when it is a folder no download may be written into (`save-deny.ts`). The question is kept in the approval
 * store as a `download` record, so it expires, is claimed once, and is bound to the account, the request and the files
 * it listed. The second call carries the person's answer and the question's id, and only then is anything written.
 *
 * The question is held to the change policy of the mailbox or workspace the files come from. Under `chat` the answer
 * an agent relays from the conversation is the person's, as every other approval here is under `chat`. Under
 * `confirm` it has to come from where an agent cannot answer: the person at their own terminal — the channel's
 * `approve` with the question's id, or the download command itself asking them there — or a form a trusted client
 * shows them. An answer passed as a tool argument or a flag is then refused, and the question left open.
 *
 * At a terminal with a person at it the command asks there and then (`downloadAtTerminal`); a person at a terminal
 * may also answer by flag, `--to`, with nobody to ask; an agent, a pipe or `--json` gets the question and the id, as
 * over MCP, and runs the command again with the answer.
 *
 * Nothing here is an operation: the channels' `downloadAttachments` and `downloadFiles` are, and both surfaces reach
 * them. This is what they share of the asking.
 */

/** The three answers: the two folders the question shows by path, and one the person names. */
export type SaveChoice = 'downloads' | 'current' | 'other';

/** The two folders a question offers, as absolute paths. */
export interface SaveFolders {
  /** The person's Downloads folder (see `downloadsFolder`), or `defaults.downloadsDir` when they set one. */
  downloads: string;
  /** The folder the process was started in: the client's for a server, the shell's for a command. */
  current: string;
}

/** The two folders, with anything their paths alone say is wrong with them. */
export interface OfferedFolders extends SaveFolders {
  /** Why either could never be saved into, known from the path as it was written: a Windows share, say. */
  unusable?: Partial<Record<'downloads' | 'current', string>> | undefined;
}

/** An answer, checked for its form: a word, or a folder that is absolute or starts with `~`. */
export type SaveAnswer = { choice: 'downloads' } | { choice: 'current' } | { choice: 'other'; folder: string };

/** What a download is called with, beside its request: the person's answer, the question's id, or neither. */
export interface DownloadAnswer {
  /** `downloads`, `current`, or a folder: the person's answer to the question. */
  saveTo?: unknown;
  /** The id the question came with. */
  choiceId?: unknown;
  /**
   * The person decided by a flag at their own terminal — `--to` without `--choice`, with stdin and stdout both a
   * terminal and no agent marker set. Only the CLI says so; a tool call never does, so an agent over MCP cannot.
   */
  personChose?: boolean | undefined;
}

/**
 * A download's answer, once its form is checked: none yet; one to a question — the person's own words relayed, or
 * `null` when they answered it where it was asked, at a terminal or in a form, and the question carries it; or one a
 * person gave by flag at their terminal.
 */
export type CheckedAnswer =
  | { readonly kind: 'none' }
  | { readonly kind: 'choice'; readonly answer: SaveAnswer | null; readonly choiceId: string }
  | { readonly kind: 'person'; readonly answer: SaveAnswer };

/** Which surface asked, so a refusal names the argument as that surface spells it. */
export type DownloadSurface = 'cli' | 'mcp';

function words(surface: DownloadSurface) {
  return surface === 'mcp'
    ? { saveTo: '`saveTo`', choiceId: '`choiceId`', out: '`out`' }
    : { saveTo: '`--to`', choiceId: '`--choice`', out: '`--out`' };
}

/** A value a caller gave, quoted and cut, for a refusal that has to say which one it was. */
function quoted(value: string): string {
  return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value);
}

/** The path functions of the platform the folders are for: the host's, unless a test names another. */
function pathsFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

// ── The folders ────────────────────────────────────────────────────────────────────────────────────────────────

export interface SaveFoldersInput {
  /** `defaults.downloadsDir`, when the person set it. */
  configured?: string | undefined;
  /** The resolved `--downloads-dir`, which wins without changing `defaults.downloadsDir`. */
  pinnedDownloads?: string | undefined;
  env: NodeJS.ProcessEnv;
  /** The working directory of the process: a server's, a command's. */
  cwd: string;
  platform?: NodeJS.Platform | undefined;
  /**
   * Where Windows says the person's Downloads folder is. Read from the registry when left out — on Windows, and only
   * for the profile of the user running this: see {@link downloadsFolder}.
   */
  knownDownloads?: (() => string | undefined) | undefined;
}

/**
 * The two folders a question offers, by their absolute paths.
 *
 * Downloads is the person's own Downloads folder ({@link downloadsFolder}), not a folder of this package's inside it:
 * a file the person asked for belongs where they look for downloads. A `defaults.downloadsDir` they set is that folder
 * instead, since setting it is how they said where their downloads go. Either may turn out to be one no download is
 * written into; the question says so rather than offering it.
 */
export function saveFolders(input: SaveFoldersInput): OfferedFolders {
  const platform = input.platform ?? process.platform;
  const paths = pathsFor(platform);
  const home = homeOf(input.env, platform);
  const unusable: Partial<Record<'downloads' | 'current', string>> = {};
  const selected = input.pinnedDownloads ?? input.configured;
  if (platform === 'win32') {
    const configured = selected === undefined ? null : windowsPathProblem(selected);
    if (configured !== null) unusable.downloads = configured;
  }
  const folders: OfferedFolders = {
    downloads: selected
      ? paths.resolve(expandHome(selected, home, paths.join))
      : downloadsFolder(input.env, platform, input.knownDownloads),
    current: paths.resolve(input.cwd),
  };
  if (Object.keys(unusable).length > 0) folders.unusable = unusable;
  return folders;
}

/**
 * The person's Downloads folder, where their system keeps it — the home read from the environment as every other
 * path here is (`HOME`, `USERPROFILE` on Windows), never the real one of whoever runs a test.
 *
 * - On Linux and the other Unixes, the XDG user directories: `XDG_DOWNLOAD_DIR` in the environment, then the line of
 *   that name in `user-dirs.dirs` under `XDG_CONFIG_HOME` (or `~/.config`). A desktop in another language names the
 *   folder in it — `~/Téléchargements`, `~/Descargas` — and `~/Downloads` is then a folder nobody looks in. A value of
 *   `$HOME` alone means the person turned it off, and is not taken.
 * - On Windows, the Downloads known folder, which a person or a domain can move to another drive: its entry under
 *   `User Shell Folders` in the registry (`known-folders.ts`), read only when the home named is the running user's own
 *   profile, since the registry says nothing about any other.
 * - Anywhere else, and whenever those say nothing usable, `<home>/Downloads`.
 */
export function downloadsFolder(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  knownDownloads?: (() => string | undefined) | undefined,
): string {
  const paths = pathsFor(platform);
  const home = homeOf(env, platform);
  const fallback = paths.resolve(home, 'Downloads');
  if (platform === 'win32') {
    const known = (knownDownloads ?? (() => knownFolder(env, DOWNLOADS_KNOWN_FOLDER)))();
    return known !== undefined && path.win32.isAbsolute(known) && windowsPathProblem(known) === null
      ? path.win32.resolve(known)
      : fallback;
  }
  if (platform === 'darwin') return fallback;
  return xdgDownloads(env, home) ?? fallback;
}

/** The XDG Downloads folder the environment or `user-dirs.dirs` names, or undefined. */
function xdgDownloads(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const expand = (value: string): string | undefined => {
    const text = value.trim();
    // The two spellings a shell reads the variable by; the file is read by shells, and either may be in it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: `${HOME}` is the file's text, not a template
    for (const prefix of ['$HOME/', '${HOME}/']) {
      if (text.startsWith(prefix) && text.length > prefix.length)
        return path.posix.join(home, text.slice(prefix.length));
    }
    // `$HOME` alone is the directory turned off; anything relative is not a folder the spec allows.
    return path.posix.isAbsolute(text) && text !== '/' ? path.posix.normalize(text) : undefined;
  };
  if (env.XDG_DOWNLOAD_DIR) {
    const named = expand(env.XDG_DOWNLOAD_DIR);
    if (named !== undefined) return named;
  }
  const configHome =
    env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : path.posix.join(home, '.config');
  let text: string;
  try {
    text = readFileSync(path.posix.join(configHome, 'user-dirs.dirs'), 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (match) return expand((match[1] ?? '').replace(/\\(.)/g, '$1'));
  }
  return undefined;
}

// ── The answer ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The person's answer, held to its form: `downloads`, `current`, or a folder — absolute, or from `~`.
 *
 * A relative folder is refused rather than resolved. It would mean one folder where the server runs and another where
 * the command does, and neither need be the one the person meant; asking them costs a sentence. So is `~user/…`,
 * which names another account's home, and — for Windows — a network share, a device path, or a path that names no
 * drive or only a drive's current folder (`save-deny.ts`, `windowsPathProblem`).
 */
export function parseSaveAnswer(
  value: unknown,
  surface: DownloadSurface,
  platform: NodeJS.Platform = process.platform,
): SaveAnswer {
  const { saveTo } = words(surface);
  const hint =
    'Pass `downloads`, `current`, or the folder the person named — absolute (/srv/invoices, D:\\Invoices) or starting with ~ (~/Invoices).';
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CommsError('USAGE', `${saveTo} takes the person’s answer: downloads, current, or a folder`, { hint });
  }
  const text = value.trim();
  if (text === 'downloads' || text === 'current') return { choice: text };
  if (text.includes('\u0000')) throw new CommsError('USAGE', `${saveTo} is not a folder: it holds a NUL`, { hint });
  const fromHome = text === '~' || text.startsWith('~/') || text.startsWith('~\\');
  if (!fromHome && platform === 'win32') {
    const problem = windowsPathProblem(text);
    if (problem !== null) {
      throw new CommsError('USAGE', `${quoted(text)} is not a folder a download is saved into: ${problem}`, {
        hint: `Ask the person for the folder with its drive, such as D:\\Invoices. ${hint}`,
        details: { saveTo: text },
      });
    }
  }
  if (fromHome || pathsFor(platform).isAbsolute(text)) return { choice: 'other', folder: text };
  throw new CommsError(
    'USAGE',
    `${quoted(text)} is a relative path: a folder the person names is absolute, or starts with ~`,
    {
      hint: `A relative folder means a different place wherever this runs, so it is never guessed at. Ask the person which folder they meant. ${hint}`,
      details: { saveTo: text },
    },
  );
}

/**
 * The answer and the question's id, checked before anything is read.
 *
 * An answer without an id is refused unless a person gave it by flag at their terminal (`personChose`, which only the
 * CLI sets): where a stranger's files land is the person's to say, and an agent that picks a folder itself has not
 * asked them. An id alone is taken: the person may have answered where the question was put to them — at a terminal,
 * or in a form — and the question then carries the answer; a question that carries none is refused before it is
 * spent (`settleDestination`).
 */
export function checkDownloadAnswer(
  given: DownloadAnswer,
  surface: DownloadSurface,
  platform: NodeJS.Platform = process.platform,
): CheckedAnswer {
  const { saveTo, choiceId } = words(surface);
  if (given.choiceId !== undefined) {
    if (typeof given.choiceId !== 'string' || !APPROVAL_ID_PATTERN.test(given.choiceId)) {
      throw new CommsError('USAGE', `${quoted(String(given.choiceId))} is not a choice id`, {
        hint: `Pass the ${choiceId} the download’s question came with: ap_ and 26 letters and digits.`,
      });
    }
    return {
      kind: 'choice',
      answer: given.saveTo === undefined ? null : parseSaveAnswer(given.saveTo, surface, platform),
      choiceId: given.choiceId,
    };
  }
  if (given.saveTo === undefined) return { kind: 'none' };
  if (given.personChose === true) return { kind: 'person', answer: parseSaveAnswer(given.saveTo, surface, platform) };
  throw new CommsError(
    'USAGE',
    `${saveTo} answers the download’s question, and needs its ${choiceId}: where the files go is the person’s to say, not an agent’s`,
    {
      hint:
        surface === 'mcp'
          ? 'Call without `saveTo` first: nothing is saved, and the answer carries a question and a `choiceId`. Show the person the question, then call again with their answer as `saveTo` and that `choiceId`.'
          : 'Run it without --to first: it saves nothing, and prints the question and a choice id (exit 10). Show the person the question, then run it again with --to <their answer> --choice <id>. Only a person at a terminal answers with --to alone.',
    },
  );
}

/**
 * Refuses `out` / `--out`, which named a folder inside the old downloads root. The person chooses the folder now, so
 * it is refused with what replaced it rather than dropped, and nothing is read or saved.
 */
export function refuseRetiredOut(out: unknown, surface: DownloadSurface): void {
  if (out === undefined) return;
  throw new CommsError('USAGE', `${words(surface).out} is no longer taken: the person chooses where the files go`, {
    hint: retiredOutHint(surface),
  });
}

/** What replaced `out`, in the words of the surface that was given it: the hint `strictToolArguments` gives too. */
export function retiredOutHint(surface: DownloadSurface): string {
  return surface === 'mcp'
    ? 'Leave out `out`. The first call asks where to save — Downloads, the current folder, or a folder the person names — and saves nothing; call again with their answer as `saveTo` and the `choiceId` it came with.'
    : 'Leave out --out. At a terminal the command asks where to save; a person there may answer with --to downloads, --to current, or --to <folder>.';
}

/**
 * Whether a bare `--to` is a person's own answer: stdin and stdout both a terminal — a person who could as well be
 * asked — nothing that forbids asking (`--json`, `--no-input`, CI), and no agent marker set. The marker is a second
 * refusal, never the only one: it is absent from an agent that does not set it, and from one that unsets it.
 */
export function personAtTerminal(
  env: NodeJS.ProcessEnv,
  streams: Streams,
  output: { json?: boolean | undefined; noInput?: boolean | undefined },
): boolean {
  return (
    agentMarker(env) === null &&
    canPrompt(env, streams, { json: output.json === true, noInput: output.noInput === true })
  );
}

// ── The folder the answer names ────────────────────────────────────────────────────────────────────────────────

/** The folder an answer names, as an absolute path: one of the two the question showed, or the person's own. */
export function folderFor(
  answer: SaveAnswer | RecordedSaveAnswer,
  folders: SaveFolders,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (answer.choice !== 'other') return answer.choice === 'downloads' ? folders.downloads : folders.current;
  const paths = pathsFor(platform);
  return paths.resolve(expandHome(answer.folder, homeOf(env, platform), paths.join));
}

/** An answer as a question records it: the person's folder resolved where they typed it, so it means what they read. */
export function recordedAnswer(
  answer: SaveAnswer,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): RecordedSaveAnswer {
  if (answer.choice !== 'other') return { choice: answer.choice };
  return { choice: 'other', folder: folderFor(answer, { downloads: '', current: '' }, env, platform) };
}

/**
 * Refuses a folder that is something else — a file, or a path through one — before the question is spent on it. A
 * folder that is not there yet is fine: it is made when the files are saved. What is not there is followed up to the
 * nearest part that is, as {@link checkWritable} does: Windows says a path through a file is not there (`ENOENT`),
 * where Unix says `ENOTDIR`.
 */
export async function checkFolder(folder: string): Promise<void> {
  let existing = folder;
  for (;;) {
    try {
      const info = await stat(existing);
      if (info.isDirectory()) return;
      throw notAFolder(folder, existing === folder ? 'it is a file' : 'part of the path is a file');
    } catch (error) {
      if (error instanceof CommsError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR') throw notAFolder(folder, 'part of the path is a file');
      const parent = path.dirname(existing);
      if (code !== 'ENOENT' || parent === existing) throw notAFolder(folder, fileSystemReason(error));
      existing = parent;
    }
  }
}

/**
 * Refuses a folder the files could not be written into, before the question is spent on it.
 *
 * `checkFolder` said only that the folder was not a file, so a read-only folder — a mounted image, a folder of
 * another user's, the root a client started the server in — passed, the question was spent, and the first file then
 * failed with a bare `EACCES` naming the sender's file. A folder that is there is proved by making a file in it, with
 * the same exclusive, link-refusing create a download uses, and removing it again: nothing else says as surely that a
 * file can be made there. One that is not there yet has to be made in the nearest folder that is, so that one is asked
 * whether it can be written into; nothing is made before the question is claimed.
 */
export async function checkWritable(folder: string): Promise<void> {
  let existing = folder;
  for (;;) {
    try {
      const info = await stat(existing);
      if (!info.isDirectory())
        throw notAFolder(folder, existing === folder ? 'it is a file' : 'part of the path is a file');
      break;
    } catch (error) {
      if (error instanceof CommsError) throw error;
      const parent = path.dirname(existing);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) {
        throw notAFolder(folder, fileSystemReason(error));
      }
      existing = parent;
    }
  }
  if (existing !== folder) {
    try {
      await access(existing, constants.W_OK | constants.X_OK);
    } catch (error) {
      throw notAFolder(folder, `it cannot be made in ${existing}: ${fileSystemReason(error)}`);
    }
    return;
  }
  const probe = path.join(folder, `.agentcomms-probe-${randomBytes(6).toString('hex')}`);
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  try {
    const handle = await open(probe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    await handle.close();
  } catch (error) {
    throw notAFolder(folder, `nothing can be written in it: ${fileSystemReason(error)}`);
  }
  await unlink(probe).catch(() => undefined);
}

/** Which folder on which disk: the two numbers that stay with a folder whatever its path is made to point to. */
export interface FolderIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * The folder to save into, made when it is missing — private, as every folder this package makes is — and resolved.
 *
 * Resolved through its links: the person named it, so a link in it goes where they meant. What is not followed is
 * anything at a file's own name inside it, which `createUniqueFile` refuses to open through. What comes back is the
 * real path, which is where each file is then created — and which the deny list is held to again, by the caller — and
 * the folder's identity, which each file created is held to (`createSavedFile`).
 */
export async function openFolder(folder: string): Promise<string> {
  return (await openFolderWithIdentity(folder)).path;
}

async function openFolderWithIdentity(folder: string): Promise<{ path: string; identity: FolderIdentity }> {
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const real = await realpath(folder);
    const info = await stat(real, { bigint: true });
    if (!info.isDirectory()) throw notAFolder(folder, 'it is a file');
    return { path: real, identity: { dev: info.dev, ino: info.ino } };
  } catch (error) {
    if (error instanceof CommsError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw notAFolder(
      folder,
      code === 'EEXIST' ? 'it is a file' : code === 'ENOTDIR' ? 'part of the path is a file' : fileSystemReason(error),
    );
  }
}

function notAFolder(folder: string, why: string): CommsError {
  return new CommsError('BAD_DATA', `cannot save into ${folder}: ${why}`, {
    hint: 'Nothing was saved. Ask the person for another folder.',
    details: { folder },
  });
}

/**
 * What the file system said, in words and its code, and never its message: a message from `open` or `write` carries
 * the path it failed on, and a path in a download's folder ends in the sender's words.
 */
export function fileSystemReason(error: unknown): string {
  const code = typeof (error as NodeJS.ErrnoException)?.code === 'string' ? (error as NodeJS.ErrnoException).code : '';
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `permission denied (${code})`;
    case 'EROFS':
      return 'the disk is read-only (EROFS)';
    case 'ENOSPC':
      return 'the disk is full (ENOSPC)';
    case 'EDQUOT':
      return 'the disk quota is used up (EDQUOT)';
    case 'ENOENT':
      return 'a folder on the way is not there (ENOENT)';
    case 'ENOTDIR':
      return 'part of the path is a file (ENOTDIR)';
    case 'EISDIR':
      return 'a folder is in the way (EISDIR)';
    case 'ELOOP':
      return 'a link is in the way (ELOOP)';
    case 'ENAMETOOLONG':
      return 'the path is too long (ENAMETOOLONG)';
    case 'EMFILE':
    case 'ENFILE':
      return `too many files are open (${code})`;
    case 'EIO':
      return 'the disk reported an error (EIO)';
    default:
      return code ? `the file system refused (${code})` : 'the file system refused';
  }
}

/**
 * A file that could not be saved, as an error that names only the folder and the file's id — the platform's, never
 * the name its sender gave it. A refusal of this package's own is passed on as it is.
 */
export function saveFailure(error: unknown, where: { folder: string; fileId: string }): CommsError {
  if (error instanceof CommsError) return error;
  return new CommsError('CONFIG', `could not save ${where.fileId} in ${where.folder}: ${fileSystemReason(error)}`);
}

// ── The question, and its answer ───────────────────────────────────────────────────────────────────────────────

/**
 * One of the three places a question offers. The first two carry their path, and `unavailable` with the reason when
 * no download may be saved there; the third is the person's to name.
 */
export interface SaveOption {
  choice: SaveChoice;
  path?: string;
  default?: boolean;
  /** Why this folder is not offered: it is one no download is written into (`save-deny.ts`). */
  unavailable?: string;
}

/** What a download answers with before anything is saved: the question to put to the person, and its id. */
export interface DestinationQuestion {
  /** Always true here: nothing was saved, and the person has to say where. */
  destinationRequired: true;
  /** Pass back as `choiceId` (`--choice`), beside the person's answer. */
  choiceId: string;
  /** The question, in words to show the person as they are. The files are listed beside it. */
  question: string;
  options: SaveOption[];
  /**
   * The change policy the answer is held to: `chat`, and the person's answer relayed from the conversation saves;
   * `confirm`, and the person answers it themselves, at their own terminal or in a trusted client's form.
   */
  policy: ChangePolicy;
  expiresAt: string;
  /** What to do next, in words an agent can follow. */
  next: string;
}

export interface AskInput {
  /** The manifest channel the files come from, recorded on the question's approval and bound. */
  channel: string;
  /** The download the question is about, as it will be claimed. */
  request: DownloadRequest;
  folders: OfferedFolders;
  /** Whether the Downloads option is a folder the person set, rather than their Downloads folder. */
  configured: boolean;
  /** How many files, and how many bytes they declare, for the question's first line. */
  count: number;
  bytes: number;
  /**
   * The files by the names they would be saved under, their sizes, why a name has `.download` after it, and their
   * risk flags — kept for a terminal or a form to show again, and each rename and flag said in the question.
   */
  listing: ListedFile[];
  /** The change policy of the mailbox or workspace the files come from, as it stands now. */
  policy: ChangePolicy;
  surface: DownloadSurface;
  /** The tool to call again, over MCP. */
  tool: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
}

/** The deny list's view of this machine: this package's own folders, and the home the environment names. */
export function denyInputOf(core: Core, env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): SaveDenyInput {
  return { paths: core.paths, env, platform };
}

/**
 * Why a folder offered by default plainly cannot be written in — a server a client started in a read-only folder, say
 * — or null. Asked of the folder, or of the nearest one that is there, with `access` alone: nothing is written before
 * the person has answered, so a folder that passes here is still proved, by making a file in it, before the question
 * is claimed (`checkWritable`).
 */
async function unwritable(folder: string): Promise<string | null> {
  let existing = folder;
  for (;;) {
    try {
      if (!(await stat(existing)).isDirectory())
        return existing === folder ? 'it is a file' : 'part of the path is a file';
      break;
    } catch (error) {
      const parent = path.dirname(existing);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) return fileSystemReason(error);
      existing = parent;
    }
  }
  try {
    await access(existing, constants.W_OK | constants.X_OK);
    return null;
  } catch (error) {
    return `nothing can be written in ${existing === folder ? 'it' : existing}: ${fileSystemReason(error)}`;
  }
}

/** The first two options, each with its path, and why it cannot be used when it cannot. */
async function offered(
  folders: OfferedFolders,
  deny: SaveDenyInput,
): Promise<{ downloads: SaveOption; current: SaveOption; other: SaveOption }> {
  const option = async (choice: 'downloads' | 'current'): Promise<SaveOption> => {
    const why =
      folders.unusable?.[choice] ??
      (await saveFolderRefusal(folders[choice], deny)) ??
      (await unwritable(folders[choice]));
    return why === null ? { choice, path: folders[choice] } : { choice, path: folders[choice], unavailable: why };
  };
  const downloads = await option('downloads');
  const current = await option('current');
  // The default is the first that can be used: Enter at a terminal means it.
  const first = [downloads, current].find((entry) => entry.unavailable === undefined);
  if (first !== undefined) first.default = true;
  return { downloads, current, other: { choice: 'other' } };
}

/** The question's words: the files, the three places — each offered or said to be unavailable — and its warnings. */
function questionText(input: {
  count: number;
  bytes: number;
  account: string;
  configured: boolean;
  options: readonly SaveOption[];
  warnings: readonly string[];
  policy: ChangePolicy;
  /** The printing package's `approve` with this choice id: what answers the question at a terminal, under `confirm`. */
  approve?: Handoff | undefined;
}): string {
  const files = `${input.count} ${input.count === 1 ? 'file' : 'files'}`;
  const [downloads, current] = input.options;
  const line = (index: number, label: string, option: SaveOption | undefined) =>
    option?.unavailable !== undefined
      ? `  ${index}. ${label} — ${option.path} — not available: ${option.unavailable}`
      : `  ${index}. ${label} — ${option?.path}${option?.default ? ' (the default)' : ''}`;
  const lines = [
    `Where should the ${files} (${sizeOf(input.bytes)}) from ${input.account} be saved?`,
    line(1, input.configured ? 'Your downloads folder' : 'Downloads', downloads),
    line(2, 'The current folder', current),
    '  3. Another folder — one you name, absolute or starting with ~',
  ];
  for (const warning of input.warnings) lines.push(`  ! ${warning}`);
  if (input.policy !== 'chat' && input.approve !== undefined) {
    lines.push(
      handoffSentence(
        input.approve,
        (command) =>
          `The change policy of ${input.account} is confirm: answer this yourself, at your own terminal — ${command} — or in the form your client shows you.`,
      ),
    );
  }
  return lines.join('\n');
}

/**
 * What a question warns about the files it lists: each one saved with `.download` after its name, and why, and each
 * other one with a risk flag — see core's `fileWarnings`. Said in the question itself, before the person answers, and
 * again in what the agent is told to do, so that a person who is shown only the question still reads them.
 */
export function listingWarnings(listing: readonly ListedFile[]): string[] {
  return fileWarnings(
    listing.map((file, index) => ({
      // The sender's name made safe is the saved name without the suffix the rename put after it.
      given:
        file.renamed !== undefined && file.name.endsWith(DOWNLOAD_SUFFIX)
          ? file.name.slice(0, -DOWNLOAD_SUFFIX.length)
          : file.name,
      savedAs: file.name,
      renamed: file.renamed,
      flags: file.flags ?? [],
      position: index + 1,
    })),
    'question',
  );
}

/**
 * Who answers a question under `confirm`, and how the agent learns they have (design 2026-10-05 §D7): `ask` them to run
 * the printing package's own `approve` in their own terminal and answer there, then wait for the answer with its wait —
 * the tool over MCP, the located command at the command line — each located, or why there is none here.
 */
function answerThere(maker: CliHandoffs, surface: DownloadSurface, choiceId: string, ask: string): string {
  return approveAndWaitSentence(
    maker,
    surface,
    choiceId,
    (approve, wait) =>
      `${ask} to run ${approve} in their own terminal and answer there${
        wait === undefined ? '.' : `; wait for their answer with ${wait}.`
      }`,
  );
}

/**
 * Asks where to save, and keeps the question: a `download` record in the approval store, bound to the request and the
 * files, held to the account's change policy, that expires as an approval does and is claimed once. Nothing is written
 * anywhere else.
 */
export async function askWhereToSave(core: Core, input: AskInput): Promise<DestinationQuestion> {
  const account = input.request.target.name;
  const files = `${input.count} ${input.count === 1 ? 'file' : 'files'}`;
  const deny = denyInputOf(core, input.env, input.platform);
  const { downloads, current, other } = await offered(input.folders, deny);
  const binding: DownloadBinding = {
    ...input.request,
    summary: `where to save ${files} from ${account}`,
    folders: { downloads: input.folders.downloads, current: input.folders.current },
    listing: input.listing,
  };
  const record = await core.approvals.createDownload({
    channel: input.channel,
    download: binding,
    policy: input.policy,
  });
  const choiceId = record.approvalId;
  const options = [downloads, current, other];
  const warnings = listingWarnings(input.listing);
  // The printing package's own `approve` answers it (`core.handoffs`).
  const maker = requireHandoffs(core, input.platform);
  const approve = maker.own(['approve', choiceId]);
  const question = questionText({
    count: input.count,
    bytes: input.bytes,
    account,
    configured: input.configured,
    options,
    warnings,
    policy: record.requiredPolicy === 'chat' ? 'chat' : 'confirm',
    approve,
  });
  const choices = [downloads, current]
    .filter((option) => option.unavailable === undefined)
    .map((option) => (input.surface === 'mcp' ? `"${option.choice}"` : `--to ${option.choice}`));
  const answers = [
    ...choices,
    input.surface === 'mcp' ? 'the folder they name (absolute, or starting with ~)' : '--to <the folder they name>',
  ];
  const policy: ChangePolicy = record.requiredPolicy === 'chat' ? 'chat' : 'confirm';
  // The warnings again, in what the agent is told to do: a question relayed in a sentence of its own loses them.
  const warned =
    warnings.length === 0
      ? ''
      : ` Tell them what the question warns about — ${warnings.join('; ')} — and never open or rename a file for them.`;
  const next =
    policy === 'chat'
      ? input.surface === 'mcp'
        ? `Nothing has been saved. Show the person this question and the files — each name and size — and wait for their answer; never choose for them.${warned} Then call ${input.tool} again with the same arguments, choiceId "${choiceId}", and saveTo: ${answers.join(', ')}.`
        : `Nothing has been saved. Show the person this question and the files, and wait for their answer; never choose for them.${warned} Then run the same command again with --choice ${choiceId} and ${answers.join(', ')}.`
      : input.surface === 'mcp'
        ? `Nothing has been saved. The change policy of ${account} is confirm, so the person answers this themselves — you cannot answer it for them, and a saveTo you pass is refused. Show them the question and the files, and ${answerThere(maker, input.surface, choiceId, 'ask them')}${warned} Then call ${input.tool} again with the same arguments and choiceId "${choiceId}" alone. A client trusted to show approval forms asks them in a form on that call instead.`
        : `Nothing has been saved. The change policy of ${account} is confirm, so the person answers this themselves: ${answerThere(maker, input.surface, choiceId, 'ask them')}${warned} Then run the same command again with --choice ${choiceId} alone.`;
  return {
    destinationRequired: true,
    choiceId,
    question,
    options,
    policy,
    expiresAt: record.expiresAt,
    next,
  };
}

/** Where an answered download saves: the folder, made and resolved, and how it was chosen. */
export interface SaveDestination {
  /** The real path of the folder, where every file is created. */
  folder: string;
  /** The folder as it was opened and checked: every file created is held to it (`createSavedFile`). */
  identity: FolderIdentity;
  choice: SaveChoice;
  /** The question the answer was to, or null when a person decided by flag. */
  choiceId: string | null;
  /**
   * Where the answer came from: the conversation (`chat`), the person's own terminal, a trusted client's form, or a
   * flag a person gave at their terminal.
   */
  answeredVia: 'chat' | 'terminal' | 'elicitation' | 'flag';
}

export interface SettleInput {
  answer: Exclude<CheckedAnswer, { kind: 'none' }>;
  /** The download as it would be claimed now: the same account, request and files the question listed. */
  request: DownloadRequest;
  /** The two folders as they are now, for an answer given by flag, which no question offered. */
  folders: () => OfferedFolders;
  /**
   * The change policy of the mailbox or workspace as the download read it: an answer is held to it, and to the policy
   * the question was asked under, before any folder is looked at. The claim decides again, by the same matrix, against
   * the policy it reads under the question's lock.
   */
  policy: ChangePolicy;
  surface: DownloadSurface;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
  /**
   * The download's cancellation, for the claim to ask under the approval store's lock: a call cancelled while the claim
   * waits for it saves nothing and leaves the question unused (see `ClaimOptions.signal`). Absent from a command line.
   */
  signal?: AbortSignal | undefined;
}

/** Whether a relayed answer is the one the person recorded: the same choice, and for a folder the same folder. */
function sameAnswer(
  recorded: RecordedSaveAnswer,
  given: SaveAnswer,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  if (recorded.choice !== given.choice) return false;
  if (recorded.choice !== 'other' || given.choice !== 'other') return true;
  const paths = pathsFor(platform);
  return paths.resolve(recorded.folder) === folderFor(given, { downloads: '', current: '' }, env, platform);
}

/** A recorded answer as the person reads it back: `downloads`, `current`, or the folder. */
function spoken(answer: RecordedSaveAnswer): string {
  return answer.choice === 'other' ? answer.folder : answer.choice;
}

/**
 * The folder an answer saves into, the question claimed on the way.
 *
 * An answer to a question, in this order, each before the question is spent: the change policy — under `confirm` only
 * an answer the person recorded at a terminal or in a trusted form will do, and one passed in arguments is refused
 * with the command that answers it; then which answer — the recorded one, which a relayed answer must match, or the
 * relayed one; then the folder — never one on the deny list (`save-deny.ts`), never a file, and one a file can be
 * made in. Then the question is claimed, once, and only for the request and the files it listed, and the folder made;
 * the folder as made and resolved is held to the deny list again, so a link put in its place meanwhile is refused.
 *
 * An answer a person gave by flag at their terminal has no question to claim, names today's folders, and is held to
 * the same checks of the folder.
 */
export async function settleDestination(core: Core, input: SettleInput): Promise<SaveDestination> {
  const { answer, env } = input;
  const platform = input.platform ?? process.platform;
  const deny = denyInputOf(core, env, platform);
  const spent = 'Nothing was saved; the question was spent on it, so the download asks again.';
  if (answer.kind === 'person') {
    const folders = input.folders();
    const folder = folderFor(answer.answer, folders, env, platform);
    const unusable = answer.answer.choice === 'other' ? undefined : folders.unusable?.[answer.answer.choice];
    if (unusable !== undefined) throw refusedFolder(folder, unusable, 'Nothing was saved. Name another folder.');
    await checkSaveFolder(folder, deny, 'Nothing was saved. Name another folder.');
    await checkFolder(folder);
    await checkWritable(folder);
    const opened = await openFolderWithIdentity(folder);
    await checkSaveFolder(opened.path, deny, 'Nothing was saved. Name another folder.');
    return {
      folder: opened.path,
      identity: opened.identity,
      choice: answer.answer.choice,
      choiceId: null,
      answeredVia: 'flag',
    };
  }

  const { saveTo, choiceId: choiceWord } = words(input.surface);
  // The person's `approve`, and the wait that learns when they have answered: the printing package's own (§D7).
  const pendingHint = approveAndWaitSentence(
    requireHandoffs(core, platform),
    input.surface,
    answer.choiceId,
    (command, wait) =>
      `Ask the person to run ${command} in their own terminal and answer there${
        wait === undefined ? '' : `; wait for their answer with ${wait}`
      }, then ${
        input.surface === 'mcp'
          ? `call again with the same arguments and choiceId "${answer.choiceId}" alone.`
          : `run this again with --choice ${answer.choiceId} alone.`
      }`,
  );
  // Only a valid version-2 question reaches the checks below; any other form is no open question here, and the claim
  // that follows refuses it.
  const asked = asV2(await core.approvals.get(answer.choiceId).catch(() => null));
  if (
    asked !== null &&
    asked.kind === 'download' &&
    asked.download !== undefined &&
    (asked.state === 'pending' || asked.state === 'approved')
  ) {
    const refusal = downloadClaimRefusal(asked, input.policy, pendingHint);
    // Refused before the claim, and so before the store could say where the question stands: said here (§D8).
    if (refusal !== null) throw withApproval(refusal, await core.approvals.approvalOf(asked));
    const recorded = asked.download.answer;
    if (recorded !== undefined && answer.answer !== null && !sameAnswer(recorded, answer.answer, env, platform)) {
      throw new CommsError(
        'USAGE',
        `nothing was saved: the person answered this question themselves, with ${spoken(recorded)}`,
        {
          hint: `Leave out ${saveTo}: pass ${choiceWord} alone, and the files are saved where they said.`,
          details: { choiceId: answer.choiceId },
        },
      );
    }
    const chosen = recorded ?? answer.answer;
    if (chosen === null) {
      throw new CommsError('USAGE', `${choiceWord} needs the person’s answer beside it`, {
        hint: `Pass ${saveTo} too: downloads, current, or the folder they named.`,
        details: { choiceId: answer.choiceId },
      });
    }
    const folder = folderFor(chosen, asked.download.folders, env, platform);
    await checkSaveFolder(folder, deny);
    await checkFolder(folder);
    await checkWritable(folder);
  }
  const claimed = await core.approvals.claimForDownload(answer.choiceId, input.request, {
    pendingHint,
    signal: input.signal,
    platform,
  });
  /*
   * The save path comes from the claimed question itself, so it is checked again from it before anything is made: the
   * folders it offered and the listing it showed are the ones its binding was made over, and the answer it carries is
   * the one a person recorded at a terminal or in a form — bound to it by its digest — or none at all, for an answer
   * from the chat, which is never kept. A question that is not what it binds saves nothing, and makes no folder.
   */
  const verified = validateV2(claimed, answer.choiceId);
  if (!verified.ok) {
    throw integrityRefusal({
      form: 'corrupt',
      approvalId: answer.choiceId,
      reason: verified.reason,
      attribution: verified.attribution,
      safe: null,
    });
  }
  // The person's recorded answer wins over a relayed one: it is theirs, given where no agent could give it.
  const chosen = claimed.download.answer ?? answer.answer;
  if (chosen === null) {
    throw new CommsError('USAGE', `${choiceWord} needs the person’s answer beside it`, {
      hint: `${spent} Pass ${saveTo} too, next time: downloads, current, or the folder they named.`,
    });
  }
  const folder = folderFor(chosen, claimed.download.folders, env, platform);
  /*
   * Checked again as it is opened — made, and resolved through its links — because the checks before the claim were
   * of a path, and a path can become a link between then and now. This one is of the real folder every file is then
   * created in, so a link put in its place at any moment up to this one is refused; the most such a race can leave is
   * an empty folder made on the way, never a file.
   */
  const opened = await openFolderWithIdentity(folder);
  await checkSaveFolder(opened.path, deny, spent);
  // A question is answered at a terminal or in a form; `standing` is a standing approval's child's, never a download's.
  const recorded = claimed.approvedVia === 'elicitation' ? 'elicitation' : 'terminal';
  const via = claimed.download.answer === undefined ? 'chat' : recorded;
  return {
    folder: opened.path,
    identity: opened.identity,
    choice: chosen.choice,
    choiceId: answer.choiceId,
    answeredVia: via,
  };
}

/**
 * A file created for a download in the folder it was answered with — and proved, once created, to be in that folder.
 *
 * The folder was checked against the deny list as it was opened, by its real path; each file is then created by that
 * path, exclusively and never through a link at its own name. What that cannot see is the folder itself being swapped
 * for a link to another — `~/.ssh` — between the check and a create, which takes a process on this machine working in
 * that folder, but no more. So once each file is made, the folder at that path is looked at again, without following
 * a link, and has to be the very folder that was opened and checked — the same disk, the same inode — and the file at
 * the new path has to be the one just opened. A file made anywhere else is removed, when it is still the file this
 * made, and the download stops: nothing more is written until the folder is asked about again.
 */
export async function createSavedFile(
  destination: Pick<SaveDestination, 'folder' | 'identity'>,
  name: string,
  where: { fileId: string },
): Promise<{ path: string; handle: FileHandle }> {
  const created = await createUniqueFile(destination.folder, name).catch((error: unknown) => {
    throw saveFailure(error, { folder: destination.folder, fileId: where.fileId });
  });
  let moved: string | null = null;
  try {
    const folder = await lstat(destination.folder, { bigint: true });
    const opened = await created.handle.stat({ bigint: true });
    const atPath = await lstat(created.path, { bigint: true });
    if (!folder.isDirectory() || folder.isSymbolicLink()) moved = 'it is no longer a folder but a link';
    else if (folder.dev !== destination.identity.dev || folder.ino !== destination.identity.ino) {
      moved = 'it is no longer the folder that was checked';
    } else if (atPath.dev !== opened.dev || atPath.ino !== opened.ino) {
      moved = 'the file made is not the one at its path';
    }
    if (moved !== null) {
      // Removed only while the path still names the file this made: never whatever else a swap put there.
      if (atPath.dev === opened.dev && atPath.ino === opened.ino) await unlink(created.path).catch(() => undefined);
    }
  } catch (error) {
    moved = `it could not be looked at again: ${fileSystemReason(error)}`;
  }
  if (moved === null) return created;
  await created.handle.close().catch(() => undefined);
  throw new CommsError(
    'BAD_DATA',
    `stopped saving into ${destination.folder}: ${moved} while the files were being saved`,
    {
      hint: 'Something changed the folder while the download was writing into it. Nothing more was saved; make the download again, and look at the folder first.',
      details: { folder: destination.folder, fileId: where.fileId },
    },
  );
}

// ── At a terminal ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a download's own record goes: this package's state directory, `downloads/<time>_<question id>.json` — never
 * the folder the person chose, where nothing is written but the files.
 */
export function downloadRecordPath(core: Core, at: Date, choiceId: string | null): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return path.join(
    core.paths.stateDir,
    'downloads',
    `${stamp}_${choiceId ?? `by-flag-${randomBytes(6).toString('hex')}`}.json`,
  );
}

/** A question, told from a result by its one field that is always `true`. */
export function isDestinationQuestion(value: unknown): value is DestinationQuestion {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { destinationRequired?: unknown }).destinationRequired === true
  );
}

export interface DownloadAtTerminalOptions<Q extends DestinationQuestion> {
  core: Core;
  /** The command's operation, with an answer or without: it asks without one, and saves with one. */
  download: (answer: DownloadAnswer) => Promise<unknown>;
  /** `--to`, as given. */
  to?: string | undefined;
  /** `--choice`, as given. */
  choice?: string | undefined;
  env: NodeJS.ProcessEnv;
  output: { json?: boolean | undefined; color: boolean; platform?: NodeJS.Platform | undefined };
  noInput?: boolean | undefined;
  /**
   * The words of this command after its program — `['attachments', 'download', …, '--inbox', 'acme/gmail']` — to run
   * again with the answer: located as the printing package's own CLI (`core.handoffs`), the downloads folder pinned.
   */
  rerun: readonly string[];
  /** The question with its files, as a person reads it. */
  render: (question: Q) => string;
  streams?: Streams | undefined;
}

/**
 * A download at the command line.
 *
 * With `--choice` it is an answer to that question: with `--to`, the answer relayed; alone, the answer the person
 * gave at their terminal. With `--to` alone it is a person's own decision, taken only from a person at a terminal
 * ({@link personAtTerminal}); from anything else — an agent, a pipe, `--json` — the operation refuses it for want of
 * a question. Without either it asks: a person at a terminal is shown the files and the three places and answers 1,
 * 2 or 3 (3 asks for the folder), their answer is recorded on the question as given at a terminal, and the files are
 * saved; an agent, or anything without a terminal, gets the question and its choice id and exits 10, as a change
 * waiting for a person does, and runs the command again with the answer.
 *
 * Returns what the operation saved, or what it answered without asking — a request with nothing in it to save.
 */
export async function downloadAtTerminal<Q extends DestinationQuestion>(
  options: DownloadAtTerminalOptions<Q>,
): Promise<unknown> {
  const streams = options.streams ?? defaultStreams;
  const { env } = options;
  if (options.to !== undefined || options.choice !== undefined) {
    return options.download({
      saveTo: options.to,
      choiceId: options.choice,
      personChose:
        options.choice === undefined &&
        personAtTerminal(env, streams, { json: options.output.json, noInput: options.noInput }),
    });
  }
  const asked = await options.download({});
  if (!isDestinationQuestion(asked)) return asked;
  const question = asked as Q;
  // Shown only while its record is the question that was asked: one no longer what it binds — its listing, the
  // folders it offers — is refused before anything of it is printed, to a person or to an agent.
  await intactQuestion(options.core, question.choiceId);
  if (!personAtTerminal(env, streams, { json: options.output.json, noInput: options.noInput })) {
    // The question is what the agent has to show the person, so it is printed, not only tucked into the envelope.
    if (options.output.json !== true) streams.stdout.write(`${options.render(question)}\n\n`);
    /*
     * What follows the command is the agent's to fill in — `--to <downloads|current|folder>` stands for the person's
     * answer — so it goes after the printed line as written, never quoted as a word: quoted, the placeholder reads as
     * the value itself, and on Windows its `<` and `|` would leave no line to print at all. A command whose own words
     * cannot be printed safely is still shown as its words in JSON, with these after them.
     */
    const maker = requireHandoffs(options.core, options.output.platform);
    const runWith = (say: (command: string) => string, ...words: string[]) =>
      handoffSentenceToFill(maker.own(options.rerun, { downloads: true }), words, say);
    throw new CommsError('APPROVAL_PENDING', 'nothing was saved: where to save the files is the person’s to say', {
      hint:
        question.policy === 'chat'
          ? `Show the person the question and the files. ${runWith((run) => `Once they answer, run ${run}.`, '--to', '<downloads|current|folder>', '--choice', question.choiceId)}`
          : `The change policy is confirm: ${answerThere(maker, 'cli', question.choiceId, 'ask the person')} ${runWith((run) => `Then run ${run}.`, '--choice', question.choiceId)}`,
      details: { ...(question as unknown as Record<string, unknown>) },
    });
  }
  streams.stdout.write(`${options.render(question)}\n\n`);
  const deny = denyInputOf(options.core, env);
  const answer = await askSaveAnswer(streams, options.output.color, question.options, (given) =>
    answerRefusal(given, question.options, deny, env),
  );
  if (answer === null) {
    await options.core.approvals.revoke(question.choiceId, 'cancelled at the terminal', { disposition: 'person' });
    throw new CommsError('USAGE', 'cancelled: nothing was saved');
  }
  // Given at this terminal, by the person at it: recorded on the question as such, so it holds under `confirm` too.
  await options.core.approvals.answerDownload(
    question.choiceId,
    'terminal',
    recordedAnswer(answer, env),
    options.output.platform ?? process.platform,
  );
  return options.download({ choiceId: question.choiceId });
}

/**
 * Why an answer typed at a terminal cannot be used — an option shown as unavailable, a folder on the deny list, a
 * file, or one that cannot be written — or null. Asked before the answer is recorded, so the person can give another.
 */
async function answerRefusal(
  answer: SaveAnswer,
  options: readonly SaveOption[],
  deny: SaveDenyInput,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const offeredOption = options.find((option) => option.choice === answer.choice);
  if (answer.choice !== 'other' && offeredOption?.unavailable !== undefined) return offeredOption.unavailable;
  const folder =
    answer.choice === 'other' ? folderFor(answer, { downloads: '', current: '' }, env) : (offeredOption?.path ?? '');
  try {
    await checkSaveFolder(folder, deny);
    await checkFolder(folder);
    await checkWritable(folder);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The person's answer at the terminal: 1 for the first folder, 2 for the second, Enter for the default, and for 3 the
 * folder they type. An answer that cannot be used — a folder shown as unavailable, one no download is written into,
 * a relative one — is said so, and asked again, up to three times. Anything else cancels, and so do three answers
 * refused: null.
 */
async function askSaveAnswer(
  streams: Streams,
  color: boolean,
  options: readonly SaveOption[],
  refusal: (answer: SaveAnswer) => Promise<string | null>,
): Promise<SaveAnswer | null> {
  const bold = (text: string) => paint(color, 'bold', text);
  const fallback = options.find((option) => option.default)?.choice;
  const defaultIndex = fallback === 'downloads' ? '1' : fallback === 'current' ? '2' : null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const choice = (
      await askLine(
        streams,
        `Save them to ${bold('1')}, ${bold('2')} or ${bold('3')}? (${defaultIndex === null ? 'Enter cancels' : `Enter for ${defaultIndex}`}; anything else cancels) `,
      )
    ).trim();
    const picked = choice === '' ? defaultIndex : choice;
    let answer: SaveAnswer | null = null;
    if (picked === '1') answer = { choice: 'downloads' };
    else if (picked === '2') answer = { choice: 'current' };
    else if (picked === '3') answer = await askFolder(streams);
    else return null;
    if (answer === null) return null;
    const why = await refusal(answer);
    if (why === null) return answer;
    streams.stderr.write(`That cannot be used: ${why}\n`);
  }
  return null;
}

/** The folder the person types for 3: asked again, up to three times, while it is not one a download takes. */
async function askFolder(streams: Streams): Promise<SaveAnswer | null> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const folder = (await askLine(streams, 'Which folder? (absolute, or starting with ~) ')).trim();
    if (folder === '') return null;
    try {
      const parsed = parseSaveAnswer(folder, 'cli');
      // A word is an answer of its own; typed here it names a folder called that, which is relative.
      if (parsed.choice === 'other') return parsed;
      streams.stderr.write(
        `That is option ${parsed.choice === 'downloads' ? '1' : '2'}; type a folder, or press Enter to cancel.\n`,
      );
    } catch (error) {
      streams.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return null;
}

async function askLine(streams: Streams, question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({
    input: streams.stdin as NodeJS.ReadableStream,
    output: streams.stderr as NodeJS.WritableStream,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// ── Answered at a terminal, by `approve` ───────────────────────────────────────────────────────────────────────

export interface AnswerAtTerminalOptions {
  env: NodeJS.ProcessEnv;
  color: boolean;
  /** The shell syntax used if the stored record is another kind of approval. */
  platform?: NodeJS.Platform | undefined;
  streams?: Streams | undefined;
}

/**
 * A download's question answered by the person at their own terminal: `agent-gmail approve <choiceId>`, `agent-slack
 * approve <choiceId>` — the channel through which a question under `confirm` is answered, since an agent cannot type
 * into it.
 *
 * The caller has already refused agents and anything without a terminal, as it does for a send or a change. This shows
 * the question again from what the record keeps — the account, the files by the names they would be saved under, and
 * the two folders, each checked against the deny list now — asks 1, 2 or 3, and records the answer on the question as
 * given at a terminal. The download that asked is then made again with the choice id alone, and saves where this
 * says. Anything else cancels, and revokes the question.
 */
export async function answerDownloadAtTerminal(
  core: Core,
  choiceId: string,
  options: AnswerAtTerminalOptions,
): Promise<{ state: 'approved' | 'revoked'; answer?: RecordedSaveAnswer }> {
  const streams = options.streams ?? defaultStreams;
  const asked = await storedQuestion(core, choiceId, options.env, options.color);
  streams.stdout.write(`${asked.text}\n\n`);
  const answer = await askSaveAnswer(streams, options.color, asked.options, (given) =>
    answerRefusal(given, asked.options, asked.deny, options.env),
  );
  if (answer === null) {
    await core.approvals.revoke(choiceId, 'cancelled at the terminal', { disposition: 'person' });
    return { state: 'revoked' };
  }
  const recorded = recordedAnswer(answer, options.env);
  await core.approvals.answerDownload(choiceId, 'terminal', recorded, options.platform ?? process.platform);
  return { state: 'approved', answer: recorded };
}

/**
 * A download's question as its record keeps it, valid — read before anything of it is shown. One that cannot be read,
 * or is not what it binds (its listing, the folders it offered, an answer), says only that it is corrupt; one an
 * earlier release asked is never answered here; anything else, or nothing, is no question.
 */
async function intactQuestion(core: Core, choiceId: string): Promise<ApprovalRecord & { download: DownloadBinding }> {
  const stored = await core.approvals.get(choiceId);
  const notFound = () =>
    new CommsError('NOT_FOUND', `no question ${choiceId} about where to save files`, {
      hint: 'Make the download again; a question expires thirty minutes after it is asked.',
    });
  if (stored === null) throw notFound();
  if (stored.form === 'corrupt' || stored.form === 'unreadable') throw integrityRefusal(stored);
  if (kindOf(stored) !== 'download') throw notFound();
  if (stored.form === 'legacy') throw otherVersionRefusal(stored.view);
  const record = stored.record;
  if (record.download === undefined) throw notFound();
  return record as ApprovalRecord & { download: DownloadBinding };
}

/**
 * A question still waiting for its answer, shown again from what its record keeps: the files by the names they would
 * be saved under — escaped, since they are the sender's words and this is printed where a person reads it — and the
 * three places, the first two checked against the deny list as they stand now.
 */
async function storedQuestion(
  core: Core,
  choiceId: string,
  env: NodeJS.ProcessEnv,
  color: boolean,
): Promise<{ text: string; options: SaveOption[]; deny: SaveDenyInput }> {
  const record = await intactQuestion(core, choiceId);
  if (record.state !== 'pending') {
    const refusal = (code: 'APPROVAL_EXPIRED' | 'APPROVAL_VOID', why: string) =>
      new CommsError(code, `nothing was saved: ${why}`, {
        hint: 'Make the download again without an answer, and answer the new question.',
        details: { choiceId, state: record.state },
      });
    if (record.state === 'expired') {
      throw refusal('APPROVAL_EXPIRED', downloadExpiredWords(record.approvedVia !== undefined));
    }
    if (record.state === 'revoked') {
      throw refusal('APPROVAL_VOID', `the question was voided (${record.reason ?? 'revoked'})`);
    }
    throw refusal('APPROVAL_VOID', 'the question was answered already, and it is answered once');
  }
  const download: DownloadBinding = record.download;
  const deny = denyInputOf(core, env);
  const { downloads, current, other } = await offered(download.folders, deny);
  const listing = download.listing ?? [];
  const lines = listing.map(
    (file, index) =>
      `${paint(color, 'dim', String(index + 1).padStart(2))} ${file.size === null ? 'size unknown' : sizeOf(file.size)} · ${truncateDisplay(file.name, 120)}`,
  );
  lines.push(
    '',
    questionText({
      count: download.files.length,
      bytes: listing.reduce((sum, file) => sum + (file.size ?? 0), 0),
      account: download.target.name,
      configured: false,
      options: [downloads, current, other],
      warnings: listingWarnings(listing),
      // Shown where the person answers it, the line about where to answer would only repeat itself.
      policy: 'chat',
    }),
  );
  return { text: lines.join('\n'), options: [downloads, current, other], deny };
}

// ── Answered in a form ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A download's question as a form puts it to the person: the message — the files and the three places, as `approve`
 * shows them at a terminal — and the choices they may pick, an option shown as unavailable left out.
 *
 * For a channel whose MCP server raises forms only for clients trusted to show them to a person
 * (`defaults.confirm.elicitationClients`): under `confirm`, that form is the other place a question can be answered
 * where an agent cannot answer it.
 */
export async function downloadQuestionForm(
  core: Core,
  choiceId: string,
  env: NodeJS.ProcessEnv,
): Promise<{ message: string; choices: SaveChoice[] }> {
  const asked = await storedQuestion(core, choiceId, env, false);
  const choices = asked.options.filter((option) => option.unavailable === undefined).map((option) => option.choice);
  return {
    message: `${asked.text}\n\nChoose where to save them. For another folder, type it — absolute, or starting with ~. Cancel and nothing is saved.`,
    choices,
  };
}

/**
 * Records the answer a person gave in a trusted client's form, checked as an answer typed at a terminal is — an option
 * shown as unavailable, a folder on the deny list, a file, a folder nothing can be written in, each refused before
 * anything is recorded, and the question left open for another answer.
 */
export async function answerDownloadInForm(
  core: Core,
  choiceId: string,
  content: { choice?: unknown; folder?: unknown },
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<RecordedSaveAnswer> {
  const asked = await storedQuestion(core, choiceId, env, false);
  let answer: SaveAnswer;
  if (content.choice === 'downloads' || content.choice === 'current') answer = { choice: content.choice };
  else if (content.choice === 'other') {
    const parsed = parseSaveAnswer(content.folder, 'mcp');
    if (parsed.choice !== 'other') {
      throw new CommsError('USAGE', 'nothing was saved: the folder typed in the form is a word, not a folder', {
        hint: 'Answer the question again, and type the folder itself — absolute, or starting with ~.',
      });
    }
    answer = parsed;
  } else {
    throw new CommsError('USAGE', 'nothing was saved: the form did not say where', {
      hint: 'Answer the question again: downloads, current, or another folder.',
    });
  }
  const why = await answerRefusal(answer, asked.options, asked.deny, env);
  if (why !== null) {
    throw new CommsError('BAD_DATA', `nothing was saved: ${why}`, {
      hint: 'The question is still open: make the download again with the same choiceId, and the form asks again.',
      details: { choiceId },
    });
  }
  const recorded = recordedAnswer(answer, env);
  await core.approvals.answerDownload(choiceId, 'elicitation', recorded, platform);
  return recorded;
}
