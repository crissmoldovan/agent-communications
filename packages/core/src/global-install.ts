import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';
import {
  downloadVerifiedTarball,
  type TarballEntry,
  type TarballFetch,
  type TarballRelease,
  tarballEntries,
  tarballLocation,
} from './release-tarball.ts';
// Types only: sigstore-js stays out of whatever reaches this module. Verifying is the caller's, handed in.
import type { VerifiedProvenance } from './update-provenance.ts';
import { type Packument, type ReleaseRegistry, type ReleaseVerifier, releaseIntegrity } from './update-release.ts';
import { isPlainVersion } from './versions.ts';

/**
 * A global package, installed from its verified tarball and checked afterwards (design 2026-10-22 P3, §7.1).
 *
 * `npm install -g <package>@<version>` resolves the name again, from a fresh read of the registry, so what it installs
 * need not be what was verified before the preview; and npm keeps no lockfile for a global, so nothing could be checked
 * after it. So the update downloads the bytes whose sha512 is the verified provenance digest — from wherever the
 * registry or a mirror says, as `release-tarball.ts` reads them — writes them to a private file, and hands npm that
 * file. npm installs exactly those bytes.
 *
 * Then the installed package is walked, never through a link: every file of the verified tarball must be there with
 * the same bytes, and nothing outside its own `node_modules/` may be there that the tarball does not list. Every
 * package of this suite inside it, at any depth — Gmail carries core — must be a release whose provenance verifies,
 * and is held to its own verified tarball the same way. Other packages in `node_modules/` are npm's to check, against
 * the registry's integrity (SECURITY.md says so).
 *
 * A mismatch is said in fixed words that name no file — an installed path can be a hostile tarball's name. Every
 * package of this suite there that does not match is removed before the step fails (design §8.2): the global package
 * itself when it is the one, or each one inside it. A nested `@agentcomms/core` npm took from the registry would
 * otherwise stay, and a channel's day's check, handed to the core beside it (P2), would start it. A removal follows no
 * link — a link is removed as a link — and reaches nothing outside the folder `npm root -g` named. On Windows, where a
 * file another process holds open refuses deletion for a moment, a removal refused with EBUSY or EPERM is tried again
 * a few times first.
 *
 * Each global package a mismatch was found in is recorded, content-free, in `<state>/removed-globals.json`: its name,
 * the release being installed, and when. The next update by hand installs it again from its verified file, though npm
 * lists it at its latest release or no longer lists it at all, and the record is cleared once an install of that
 * package verifies; one that fails again keeps it. So "run the update again" does what it says.
 *
 * No Sigstore here, and nothing runs when this module is loaded: WhatsApp's bundle, which carries core's index, drops
 * it with everything that reads a tarball.
 */

export const GLOBAL_MISMATCH = (packageName: string): string =>
  `the global ${packageName} does not match its verified release`;

export interface GlobalInstallDeps {
  /** `npm install -g <spec>`; the spec is the path of the verified tarball, written for it. */
  install: (spec: string) => Promise<void>;
  /** `npm root -g`: the folder npm installs global packages in. */
  root: () => Promise<string>;
  registry: ReleaseRegistry | null;
  verify: ReleaseVerifier | null;
  tarballs?: TarballFetch | undefined;
  /**
   * Releases verified already, by package — an update's, before its preview. A package of this suite in the installed
   * one at exactly that release is held to that verification, and not verified again.
   */
  verified?: ReadonlyMap<string, VerifiedProvenance> | undefined;
  /**
   * The state directory, where a global package a mismatch was found in is recorded for the next update to reinstall
   * (`removed-globals.json`), and cleared once its install verifies. None: nothing is recorded or cleared.
   */
  stateDir?: string | undefined;
}

// ── What the next update reinstalls ─────────────────────────────────────────────────────────────────────────────

export const REMOVED_GLOBALS_FILE = 'removed-globals.json';

const REMOVED_GLOBALS_LOCK = '.removed-globals.lock';

/** A global package an update found a mismatch in, and removed what of it did not match: content-free. */
export interface RemovedGlobal {
  package: string;
  /** The release the update was installing. */
  version: string;
  /** When, ISO. */
  removedAt: string;
}

function isTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const at = new Date(value);
  return !Number.isNaN(at.getTime()) && at.toISOString() === value;
}

/**
 * The globals recorded for the next update to reinstall, each once: none when there is no record or it cannot be
 * read. Only a name of this suite and a plain release are read from it.
 */
export async function readRemovedGlobals(stateDir: string): Promise<RemovedGlobal[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(stateDir, REMOVED_GLOBALS_FILE), 'utf8'));
  } catch {
    return [];
  }
  const listed = typeof parsed === 'object' && parsed !== null ? (parsed as { removed?: unknown }).removed : undefined;
  if (!Array.isArray(listed)) return [];
  const removed: RemovedGlobal[] = [];
  for (const item of listed) {
    if (typeof item !== 'object' || item === null) continue;
    const { package: name, version, removedAt } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !SUITE_NAME.test(name) || typeof version !== 'string') continue;
    if (!isPlainVersion(version) || !isTime(removedAt)) continue;
    if (removed.some((one) => one.package === name)) continue;
    removed.push({ package: name, version, removedAt });
  }
  return removed;
}

/** The record changed by `change`, under its lock, written atomically; never in the way of the step it serves. */
async function changeRemovedGlobals(
  stateDir: string,
  change: (removed: RemovedGlobal[]) => RemovedGlobal[] | null,
): Promise<void> {
  try {
    await withFileLock(join(stateDir, REMOVED_GLOBALS_LOCK), async () => {
      const next = change(await readRemovedGlobals(stateDir));
      if (next === null) return;
      await writeFileAtomic(join(stateDir, REMOVED_GLOBALS_FILE), `${JSON.stringify({ removed: next }, null, 2)}\n`);
    });
  } catch {
    // A record that cannot be written leaves the step's own outcome as it is.
  }
}

/** A name of this suite, as npm writes one: only then is it said in a detail. */
const SUITE_NAME = /^@agentcomms\/[a-z0-9][a-z0-9._-]{0,213}$/;

/** A release as a detail names it: `<name>@<version>` when both are ours to say. */
function named(packageName: string, version?: string | null): string {
  if (!SUITE_NAME.test(packageName)) return 'a package of this suite';
  if (version === undefined) return packageName;
  return typeof version === 'string' && isPlainVersion(version)
    ? `${packageName}@${version}`
    : `${packageName} at a version that is not a plain release`;
}

type TreeProblem = 'differs' | 'missing' | 'extra';

/** Why a package is not its verified tarball, in fixed words: of the package itself (`who` null), or of one inside it. */
const WORDS = {
  differs: (who: string | null) =>
    who === null
      ? 'a file of it differs from its verified release'
      : `a file of ${who} in it differs from its verified release`,
  missing: (who: string | null) =>
    who === null
      ? 'a file of its verified release is missing'
      : `a file of the verified release of ${who} is missing from it`,
  extra: (who: string | null) =>
    who === null
      ? 'it holds a file its verified release does not'
      : `${who} in it holds a file its verified release does not`,
  link: (who: string | null) =>
    who === null ? 'it is a link, not the installed package' : `${who} in it is a link, not an installed package`,
  unread: (who: string | null) =>
    who === null ? 'its verified release could not be read' : `the verified release of ${who} in it could not be read`,
  unchecked: (who: string | null) =>
    who === null ? 'it could not be read to check it' : `${who} in it could not be read to check it`,
  unverified: (who: string) => `${who} in it could not be verified as built by this repository's release workflow`,
  undownloaded: (who: string) =>
    `the verified tarball of ${who} in it could not be downloaded, so it could not be checked`,
} as const;

function missingError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Why the files at `dir` are not `entries`, or null: each regular file of the tarball must be a regular file there,
 * reached through folders only, with the same bytes; and nothing may be there, outside `dir/node_modules/`, that the
 * tarball does not list. Links are never followed. Links and other entries in a tarball are not installed by npm, so
 * nothing on disk answers to them.
 */
async function treeProblem(dir: string, entries: readonly TarballEntry[]): Promise<TreeProblem | null> {
  const files = new Map<string, Buffer>();
  const folders = new Set<string>(['']);
  for (const entry of entries) {
    if (entry.type === 'file') files.set(entry.path, entry.data);
    else if (entry.type === 'directory') folders.add(entry.path);
  }
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let end = 1; end < parts.length; end += 1) folders.add(parts.slice(0, end).join('/'));
  }

  // What each path is, by lstat — a folder, a file, or anything else — or null when it is not there.
  const kinds = new Map<string, 'folder' | 'file' | 'other' | null>();
  const kindOf = async (path: string): Promise<'folder' | 'file' | 'other' | null> => {
    const known = kinds.get(path);
    if (known !== undefined) return known;
    let kind: 'folder' | 'file' | 'other' | null;
    try {
      const stat = await lstat(join(dir, ...path.split('/')));
      kind = stat.isSymbolicLink() ? 'other' : stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : 'other';
    } catch (error) {
      if (!missingError(error)) throw error;
      kind = null;
    }
    kinds.set(path, kind);
    return kind;
  };

  for (const [path, data] of files) {
    const parts = path.split('/');
    // Reached through folders only: a link on the way is not where npm put the file.
    let through = true;
    for (let end = 1; end < parts.length && through; end += 1) {
      through = (await kindOf(parts.slice(0, end).join('/'))) === 'folder';
    }
    const kind = through ? await kindOf(path) : null;
    if (kind === null) return 'missing';
    if (kind !== 'file') return 'differs';
    if (!(await readFile(join(dir, ...parts))).equals(data)) return 'differs';
  }

  const holdsMore = async (relative: string): Promise<boolean> => {
    const here = relative === '' ? dir : join(dir, ...relative.split('/'));
    for (const name of await readdir(here)) {
      const path = relative === '' ? name : `${relative}/${name}`;
      const stat = await lstat(join(here, name));
      const folder = stat.isDirectory() && !stat.isSymbolicLink();
      // npm's own: the packages it installed beside this one, which are not in the tarball.
      if (relative === '' && name === 'node_modules' && folder) continue;
      if (folder) {
        if (!folders.has(path) || (await holdsMore(path))) return true;
      } else if (!(stat.isFile() && !stat.isSymbolicLink() && files.has(path))) return true;
    }
    return false;
  };
  return (await holdsMore('')) ? 'extra' : null;
}

/** A package of this suite inside an installed one: where it is, its name as the folder says, and what that folder is. */
interface Inside {
  packageName: string;
  dir: string;
  folder: boolean;
}

/**
 * Every package of this suite below `top`, at any depth: each `node_modules/@agentcomms/*`, in `top`'s `node_modules`
 * and in that of every package in it. Walked by lstat, never through a link: a link to a package is found as a link,
 * and nothing behind it is read.
 */
async function suitePackagesIn(top: string): Promise<Inside[]> {
  const found: Inside[] = [];
  const realFolder = async (path: string): Promise<boolean> => {
    try {
      const stat = await lstat(path);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch (error) {
      if (missingError(error)) return false;
      throw error;
    }
  };
  const visit = async (packageDir: string): Promise<void> => {
    const modules = join(packageDir, 'node_modules');
    if (!(await realFolder(modules))) return;
    for (const name of await readdir(modules)) {
      const at = join(modules, name);
      // A scope named in any case: a file system that ignores case resolves `@agentcomms/core` to it.
      if (name.toLowerCase() === '@agentcomms') {
        if (!(await realFolder(at))) {
          found.push({ packageName: name, dir: at, folder: false });
          continue;
        }
        for (const inner of await readdir(at)) {
          const dir = join(at, inner);
          const folder = await realFolder(dir);
          found.push({ packageName: `${name}/${inner}`, dir, folder });
          if (folder) await visit(dir);
        }
        continue;
      }
      if (!(await realFolder(at))) continue;
      if (name.startsWith('@')) {
        for (const inner of await readdir(at)) {
          const dir = join(at, inner);
          if (await realFolder(dir)) await visit(dir);
        }
      } else await visit(at);
    }
  };
  await visit(top);
  return found;
}

/** The version an installed package's own manifest gives: a regular file of at most 1 MiB holding one. */
async function installedVersion(dir: string): Promise<string | null> {
  const path = join(dir, 'package.json');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown } | null;
    return typeof manifest?.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * The verified tarball's entries of a package of this suite at `version`, or the problem why not: verified already
 * (`deps.verified`, at exactly that version), or verified now against the registry's integrity for it; then downloaded,
 * by the verified digest, from where the registry says or npm's canonical address.
 */
async function verifiedEntries(
  packageName: string,
  version: string,
  deps: Pick<GlobalInstallDeps, 'registry' | 'verify' | 'tarballs' | 'verified'>,
): Promise<{ ok: true; entries: TarballEntry[] } | { ok: false; problem: 'unverified' | 'undownloaded' | 'unread' }> {
  let packument: Packument | null = null;
  try {
    packument = deps.registry === null ? null : (await deps.registry(packageName)).packument;
  } catch {
    packument = null;
  }
  const already = deps.verified?.get(packageName);
  let sha512: string;
  if (already !== undefined && already.package === packageName && already.version === version) {
    sha512 = already.sha512;
  } else {
    const integrity = packument === null ? null : releaseIntegrity(packument, version);
    if (integrity === null || deps.verify === null) return { ok: false, problem: 'unverified' };
    const verdict = await deps.verify({ packageName, version, integrity });
    if (!verdict.ok) return { ok: false, problem: 'unverified' };
    sha512 = verdict.provenance.sha512;
  }
  const download = await downloadVerifiedTarball(
    { packageName, version, sha512 },
    packument === null ? null : tarballLocation(packument, version),
    deps.tarballs === undefined ? {} : { fetch: deps.tarballs },
  );
  if (!download.ok) return { ok: false, problem: 'undownloaded' };
  const read = tarballEntries(download.bytes);
  return read.ok ? { ok: true, entries: read.entries } : { ok: false, problem: 'unread' };
}

/** A package of this suite in a global install that is not its verified release: where it is, and its name. */
interface Mismatching {
  dir: string;
  /** Its name as the folder says it; null for the global package itself. */
  packageName: string | null;
}

/**
 * What a check of a global install found: why it is not its verified release, in fixed words — the first reason found —
 * or null when it is; and every package of this suite there that is not its own verified release. That is the global
 * package alone when it is one itself, and otherwise each one inside it, outermost first, none inside another listed.
 */
export interface GlobalCheck {
  problem: string | null;
  mismatching: Mismatching[];
}

/** Whether `path` is below `folder`: both built from the same folder, so compared as paths. */
function below(path: string, folder: string): boolean {
  return path.startsWith(`${folder}${sep}`);
}

/**
 * Why a package of this suite inside a global install is not its own verified release, in fixed words, or null when it
 * is. `held` keeps each release's verified entries, so a release held by several packages is verified once.
 */
async function insideProblem(
  inside: Inside,
  held: Map<string, Awaited<ReturnType<typeof verifiedEntries>>>,
  deps: Pick<GlobalInstallDeps, 'registry' | 'verify' | 'tarballs' | 'verified'>,
): Promise<string | null> {
  if (!inside.folder) return WORDS.link(named(inside.packageName));
  const version = await installedVersion(inside.dir);
  const who = named(inside.packageName, version);
  if (version === null || !isPlainVersion(version) || !SUITE_NAME.test(inside.packageName)) {
    return WORDS.unverified(who);
  }
  const key = `${inside.packageName}@${version}`;
  let verified = held.get(key);
  if (verified === undefined) {
    verified = await verifiedEntries(inside.packageName, version, deps);
    held.set(key, verified);
  }
  if (!verified.ok) return WORDS[verified.problem](who);
  const problem = await treeProblem(inside.dir, verified.entries);
  return problem === null ? null : WORDS[problem](who);
}

/**
 * The package at `dir` checked against its verified tarball (`release`, with its bytes): the package itself, then every
 * package of this suite inside it, each against its own verified release, and every one that does not match found —
 * one that could not be read to check it included. Never follows a link; never changes anything; never throws.
 */
export async function globalCheck(
  dir: string,
  release: TarballRelease & { bytes: Buffer },
  deps: Pick<GlobalInstallDeps, 'registry' | 'verify' | 'tarballs' | 'verified'>,
): Promise<GlobalCheck> {
  const itself = (problem: string): GlobalCheck => ({ problem, mismatching: [{ dir, packageName: null }] });
  const read =
    createHash('sha512').update(release.bytes).digest('hex') === release.sha512.toLowerCase()
      ? tarballEntries(release.bytes)
      : null;
  if (read === null || !read.ok) return itself(WORDS.unread(null));
  let insides: Inside[];
  try {
    let stat: Stats;
    try {
      stat = await lstat(dir);
    } catch (error) {
      if (missingError(error)) return { problem: WORDS.missing(null), mismatching: [] };
      throw error;
    }
    if (stat.isSymbolicLink()) return itself(WORDS.link(null));
    if (!stat.isDirectory()) return itself(WORDS.differs(null));
    const own = await treeProblem(dir, read.entries);
    if (own !== null) return itself(WORDS[own](null));
    insides = await suitePackagesIn(dir);
  } catch {
    return itself(WORDS.unchecked(null));
  }

  let problem: string | null = null;
  const mismatching: Mismatching[] = [];
  // Each release once, however many packages here hold it.
  const held = new Map<string, Awaited<ReturnType<typeof verifiedEntries>>>();
  for (const inside of insides) {
    // Inside one that is removed already, and removed with it.
    if (mismatching.some((one) => below(inside.dir, one.dir))) continue;
    let found: string | null;
    try {
      found = await insideProblem(inside, held, deps);
    } catch {
      found = WORDS.unchecked(named(inside.packageName));
    }
    if (found === null) continue;
    problem ??= found;
    mismatching.push({ dir: inside.dir, packageName: inside.packageName });
  }
  return { problem, mismatching };
}

/**
 * Removes what is at `path` without following a link: a folder with everything in it, a file, or a link — the link
 * itself, never what it points to. Each entry is looked at with lstat, so nothing behind a link is reached.
 */
async function removeTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of await readdir(path)) await removeTree(join(path, name));
    await rmdir(path);
  } else {
    await unlink(path);
  }
}

/** How often a removal Windows refused for a moment is tried, in all, and how long it waits between tries. */
const WINDOWS_TRIES = 5;
const WINDOWS_PAUSE_MS = 100;

/** What Windows answers while another process — a running server, a virus scan — holds a file open. */
function refusedForNow(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'EBUSY' || code === 'EPERM';
}

export interface RemoveOptions {
  /** Removes what is at a path without following a link: `removeTree` when left out. For a test, one that refuses. */
  remove?: ((path: string) => Promise<void>) | undefined;
  /** The system it runs on: only Windows tries again. */
  platform?: NodeJS.Platform | undefined;
  /** Waits between tries. */
  pause?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Removes the package at `dir`, below `root` — the folder `npm root -g` named — without following a link. Refused
 * unless `dir` is below `root` and every folder between them is a folder and not a link, so nothing outside the global
 * root is reached by way of one; `root` itself is as npm named it. On Windows a removal refused with EBUSY or EPERM is
 * tried again, `WINDOWS_TRIES` times in all, `WINDOWS_PAUSE_MS` apart. True when nothing is left at `dir`.
 */
export async function removeInside(root: string, dir: string, options: RemoveOptions = {}): Promise<boolean> {
  const remove = options.remove ?? removeTree;
  const windows = (options.platform ?? process.platform) === 'win32';
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const path = relative(root, dir);
  if (path === '' || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return false;
  const parts = path.split(sep);
  try {
    for (let end = 1; end < parts.length; end += 1) {
      const stat = await lstat(join(root, ...parts.slice(0, end)));
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
  } catch (error) {
    return missingError(error) && !(await there(dir));
  }
  for (let tries = 1; ; tries += 1) {
    try {
      await remove(dir);
      return true;
    } catch (error) {
      if (missingError(error)) return !(await there(dir));
      if (!windows || !refusedForNow(error) || tries >= WINDOWS_TRIES) return false;
      await pause(WINDOWS_PAUSE_MS);
    }
  }
}

/** Whether anything is at `path`, a link included. */
async function there(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Names joined as a sentence lists them: `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Removes every mismatching package below `root`, and says what became of them, after the mismatch's own words: "so it
 * was removed" for the global package itself, "so @agentcomms/core was removed from it" for one inside it, and "and …
 * could not be removed" for what is still there. Names a package, never a file. Empty when there is nothing to remove.
 */
async function removeMismatching(root: string, mismatching: readonly Mismatching[]): Promise<string> {
  const removed = new Set<string>();
  const kept = new Set<string>();
  let itself: boolean | null = null;
  for (const one of mismatching) {
    const gone = await removeInside(root, one.dir);
    if (one.packageName === null) itself = gone;
    else (gone ? removed : kept).add(named(one.packageName));
  }
  if (itself !== null) return itself ? ', so it was removed' : ', and it could not be removed';
  const words: string[] = [];
  if (removed.size > 0) words.push(`so ${listed([...removed])} ${removed.size === 1 ? 'was' : 'were'} removed from it`);
  if (kept.size > 0) words.push(`and ${listed([...kept])} in it could not be removed`);
  return words.length === 0 ? '' : `, ${words.join(', ')}`;
}

/** A release's tarball's file name, as `npm pack` names one, from what is safe to put in a path. */
function fileName(packageName: string, version: string): string {
  const base = SUITE_NAME.test(packageName) ? packageName.slice(1).replace('/', '-') : 'release';
  return `${base}-${isPlainVersion(version) ? version : 'release'}.tgz`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Downloads the verified tarball of `request`, installs exactly it — written to a file of mode 0600, in a folder of
 * 0700, removed afterwards — then checks what npm installed against it (`globalCheck`). On a mismatch, every package of
 * this suite there that does not match is removed (`removeMismatching`), and the step fails saying so, with `again`,
 * what the person runs ("run <core's located update> again"). Nothing is handed to npm unless the bytes are the
 * verified ones and can be read.
 */
export async function installVerifiedGlobal(
  request: { packageName: string; version: string; provenance: VerifiedProvenance },
  deps: GlobalInstallDeps,
  again: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { packageName, version, provenance } = request;
  const release = named(packageName, version);
  if (provenance.package !== packageName || provenance.version !== version) {
    return { ok: false, detail: `${release} was not verified before the preview` };
  }
  let location: string | null = null;
  try {
    location = deps.registry === null ? null : tarballLocation((await deps.registry(packageName)).packument, version);
  } catch {
    // npm's canonical address is still tried: the bytes are known by their digest, not by where they come from.
  }
  const download = await downloadVerifiedTarball(
    { packageName, version, sha512: provenance.sha512 },
    location,
    deps.tarballs === undefined ? {} : { fetch: deps.tarballs },
  );
  if (!download.ok) {
    return {
      ok: false,
      detail: `the verified tarball of ${release} could not be downloaded, so nothing was installed`,
    };
  }
  if (!tarballEntries(download.bytes).ok) {
    return { ok: false, detail: `the verified tarball of ${release} could not be read, so nothing was installed` };
  }

  const folder = await mkdtemp(join(tmpdir(), 'agentcomms-global-'));
  try {
    await chmod(folder, 0o700);
    const file = join(folder, fileName(packageName, version));
    await writeFile(file, download.bytes, { mode: 0o600, flag: 'wx' });
    await deps.install(file);
  } catch (error) {
    return { ok: false, detail: message(error) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }

  let root: string;
  try {
    root = await deps.root();
  } catch {
    return {
      ok: false,
      detail: `the global ${packageName} could not be checked against its verified release: npm did not say where it installs global packages; ${again}`,
    };
  }
  const dir = join(root, ...packageName.split('/'));
  const check = await globalCheck(
    dir,
    { packageName, version, sha512: provenance.sha512, bytes: download.bytes },
    deps,
  );
  const stateDir = deps.stateDir;
  if (check.problem === null) {
    // Verified: nothing of it is left for the next update to reinstall.
    if (stateDir !== undefined) {
      await changeRemovedGlobals(stateDir, (removed) =>
        removed.some((one) => one.package === packageName)
          ? removed.filter((one) => one.package !== packageName)
          : null,
      );
    }
    return { ok: true };
  }
  const removal = await removeMismatching(root, check.mismatching);
  // Recorded whether or not all of it could be removed: either way, the next update installs it again.
  if (stateDir !== undefined && check.mismatching.length > 0) {
    const entry: RemovedGlobal = { package: packageName, version, removedAt: new Date().toISOString() };
    await changeRemovedGlobals(stateDir, (removed) => [...removed.filter((one) => one.package !== packageName), entry]);
  }
  return { ok: false, detail: `${GLOBAL_MISMATCH(packageName)} (${check.problem})${removal}: ${again}` };
}
