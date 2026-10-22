import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * A mismatch is said in fixed words that name no file — an installed path can be a hostile tarball's name — and
 * nothing is uninstalled: the person runs the update again, which checks again.
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

/**
 * Why the package at `dir` is not its verified tarball (`release`, with its bytes), in fixed words, or null when it is:
 * the package itself, then every package of this suite inside it, each against its own verified release. Never follows
 * a link; never changes anything.
 */
export async function globalProblem(
  dir: string,
  release: TarballRelease & { bytes: Buffer },
  deps: Pick<GlobalInstallDeps, 'registry' | 'verify' | 'tarballs' | 'verified'>,
): Promise<string | null> {
  const read =
    createHash('sha512').update(release.bytes).digest('hex') === release.sha512.toLowerCase()
      ? tarballEntries(release.bytes)
      : null;
  if (read === null || !read.ok) return WORDS.unread(null);
  let stat: Stats;
  try {
    stat = await lstat(dir);
  } catch (error) {
    if (missingError(error)) return WORDS.missing(null);
    throw error;
  }
  if (stat.isSymbolicLink()) return WORDS.link(null);
  if (!stat.isDirectory()) return WORDS.differs(null);
  const own = await treeProblem(dir, read.entries);
  if (own !== null) return WORDS[own](null);

  // Each release once, however many packages here hold it.
  const held = new Map<string, Awaited<ReturnType<typeof verifiedEntries>>>();
  for (const inside of await suitePackagesIn(dir)) {
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
    if (problem !== null) return WORDS[problem](who);
  }
  return null;
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
 * 0700, removed afterwards — then checks what npm installed against it (`globalProblem`). Never uninstalls: on a
 * mismatch the step fails with `again`, what the person runs ("run <core's located update> again"). Nothing is handed
 * to npm unless the bytes are the verified ones and can be read.
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
  let problem: string | null;
  try {
    problem = await globalProblem(
      join(root, ...packageName.split('/')),
      { packageName, version, sha512: provenance.sha512, bytes: download.bytes },
      deps,
    );
  } catch {
    problem = 'it could not be read to check it';
  }
  return problem === null
    ? { ok: true }
    : { ok: false, detail: `${GLOBAL_MISMATCH(packageName)} (${problem}): ${again}` };
}
