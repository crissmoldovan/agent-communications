import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import { type LockOptions, withFileLock } from './lock.ts';
import { homeDirectory } from './paths.ts';

const RECEIPT_VERSION = 1 as const;
const RECEIPT_FILE = 'managed-shims.json';
const MUTATION_LOCK_FILE = 'managed-shims.lock';
const POSIX_SHIM_MODE = 0o755;

export interface ManagedShimContext {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  platform?: NodeJS.Platform | undefined;
  /** Deterministic mutation-boundary hooks used only by ownership race tests. */
  hooks?: {
    beforeReplace?: ((path: string) => void | Promise<void>) | undefined;
    beforeRemove?: ((path: string) => void | Promise<void>) | undefined;
  };
  /** Short lock timings used only by crash-recovery tests. */
  lockOptions?: LockOptions | undefined;
}

export interface ManagedShimSpec {
  binary: string;
  /** The locator's complete command words, before the caller's forwarded arguments. */
  command: readonly string[];
  entry: string;
}

interface ShimReceipt {
  path: string;
  digest: string;
  node: string;
  entry: string;
}

interface ReceiptFile {
  version: typeof RECEIPT_VERSION;
  shims: Record<string, ShimReceipt>;
}

export type ManagedShimStatus = 'current' | 'missing' | 'stale' | 'foreign';

export interface ManagedShimInspection {
  binary: string;
  path: string;
  status: ManagedShimStatus;
  detail: string;
  node?: string | undefined;
  entry?: string | undefined;
}

export interface ManagedShimWriteResult {
  path: string;
  directory: string;
  status: 'created' | 'updated' | 'foreign';
  onPath: boolean;
  pathNotice?: string | undefined;
}

export const WINDOWS_SHIM_NOTICE =
  'Managed CLI shims are not offered on Windows yet because cmd.exe re-parses arguments forwarded through .cmd files, including shell metacharacters. Use the full-path command or the labelled PowerShell & line the result provides.';

function platformOf(context: Pick<ManagedShimContext, 'platform'>): NodeJS.Platform {
  return context.platform ?? process.platform;
}

/** Why the selected platform has no managed shim in this release. */
export function managedShimUnsupportedNotice(context: Pick<ManagedShimContext, 'platform'> = {}): string {
  return platformOf(context) === 'win32'
    ? WINDOWS_SHIM_NOTICE
    : 'Managed CLI shims are offered only on macOS and Linux in this release. Use the full-path command the result provides.';
}

/** The per-user directory managed installs put their command shims in. */
export function managedShimDirectory(context: ManagedShimContext): string {
  if (!managedShimsSupported(context)) {
    throw new CommsError('CONFIG', managedShimUnsupportedNotice(context));
  }
  return join(homeDirectory(context.env), '.local', 'bin');
}

/** Managed CLI shims are POSIX-only until Windows has an argument-forwarding form that does not re-parse input. */
export function managedShimsSupported(context: Pick<ManagedShimContext, 'platform'> = {}): boolean {
  const platform = platformOf(context);
  return platform === 'darwin' || platform === 'linux';
}

/** A managed shim's name: one plain command word, never a path, so joining it to the directory stays inside it. */
function isSafeBinary(binary: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(binary);
}

function checkedBinary(binary: string): string {
  if (!isSafeBinary(binary)) {
    throw new CommsError('CONFIG', `${JSON.stringify(binary)} is not a safe managed CLI binary name`);
  }
  return binary;
}

/** The exact path for one declared binary's managed shim. */
export function managedShimPath(context: ManagedShimContext, binary: string): string {
  return join(managedShimDirectory(context), checkedBinary(binary));
}

function receiptPath(context: ManagedShimContext): string {
  return join(context.dataDir, RECEIPT_FILE);
}

function emptyReceipt(): ReceiptFile {
  return { version: RECEIPT_VERSION, shims: {} };
}

async function readReceipt(context: ManagedShimContext): Promise<ReceiptFile | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(receiptPath(context), 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? emptyReceipt() : null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== RECEIPT_VERSION ||
    typeof (parsed as { shims?: unknown }).shims !== 'object' ||
    (parsed as { shims?: unknown }).shims === null
  ) {
    return null;
  }
  const shims: Record<string, ShimReceipt> = {};
  for (const [binary, value] of Object.entries((parsed as { shims: Record<string, unknown> }).shims)) {
    // A key that is not a plain command name would join onto the shim directory as a path out of it, and prune would
    // move and delete whatever file that path names: such a receipt is not this installation's, so none of it is.
    if (
      !isSafeBinary(binary) ||
      typeof value !== 'object' ||
      value === null ||
      !['path', 'digest', 'node', 'entry'].every(
        (key) => typeof (value as unknown as Record<string, unknown>)[key] === 'string',
      )
    ) {
      return null;
    }
    shims[binary] = value as ShimReceipt;
  }
  return { version: RECEIPT_VERSION, shims };
}

async function writeReceipt(context: ManagedShimContext, receipt: ReceiptFile): Promise<void> {
  await writeFileAtomic(receiptPath(context), `${JSON.stringify(receipt, null, 2)}\n`);
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function posixWord(word: string): string {
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}

function shimSource(spec: ManagedShimSpec): string {
  return `#!/bin/sh\n# managed CLI shim v1\nexec ${spec.command.map(posixWord).join(' ')} "$@"\n`;
}

interface PinnedShimDirectory {
  /** The path a person puts on PATH; it may itself be a symlink. */
  public: string;
  /** The directory every filesystem mutation uses for this operation. */
  resolved: string;
}

async function pinShimDirectory(context: ManagedShimContext, create: boolean): Promise<PinnedShimDirectory | null> {
  const publicDirectory = managedShimDirectory(context);
  if (create) await mkdir(publicDirectory, { recursive: true, mode: 0o755 });
  let resolved: string;
  try {
    resolved = await realpath(publicDirectory);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return { public: publicDirectory, resolved };
}

async function assertPinnedDirectory(directory: PinnedShimDirectory): Promise<void> {
  let now: string;
  try {
    now = await realpath(directory.public);
  } catch {
    throw new CommsError(
      'CONFIG',
      `the managed shim directory's resolved directory changed from ${directory.resolved} during the operation`,
      { hint: 'Nothing was changed. Inspect the directory link, then run the install, update or prune again.' },
    );
  }
  if (now !== directory.resolved) {
    throw new CommsError(
      'CONFIG',
      `the managed shim directory's resolved directory changed from ${directory.resolved} to ${now} during the operation`,
      { hint: 'Nothing was changed. Inspect the directory link, then run the install, update or prune again.' },
    );
  }
}

async function regularFileBytes(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Serialize this installation's receipt and shim mutations across its processes. */
async function withMutationLock<T>(context: ManagedShimContext, change: () => Promise<T>): Promise<T> {
  await mkdir(context.dataDir, { recursive: true, mode: 0o700 });
  return withFileLock(join(context.dataDir, MUTATION_LOCK_FILE), change, {
    timeoutMs: 5_000,
    staleMs: 30_000,
    renewMs: 10_000,
    ...context.lockOptions,
  });
}

/** Publish complete shim bytes only if the target is still absent. */
async function createShimExclusive(directory: PinnedShimDirectory, path: string, source: string): Promise<void> {
  const nonce = randomBytes(6).toString('hex');
  const temp = join(directory.resolved, `.${basename(path)}.${nonce}.tmp`);
  await assertPinnedDirectory(directory);
  const handle = await open(temp, 'wx', POSIX_SHIM_MODE);
  try {
    await handle.writeFile(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertPinnedDirectory(directory);
  await chmod(temp, POSIX_SHIM_MODE);
  try {
    // A hard link is the conditional, atomic publish Node exposes: unlike rename, it cannot replace a raced file.
    await assertPinnedDirectory(directory);
    await link(temp, path);
  } finally {
    await assertPinnedDirectory(directory);
    await rm(temp, { force: true });
  }
}

/** Restore an object moved aside without ever replacing a raced object at its public path. */
async function restoreMoved(directory: PinnedShimDirectory, path: string, moved: string): Promise<boolean> {
  try {
    await assertPinnedDirectory(directory);
    await link(moved, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  await assertPinnedDirectory(directory);
  await rm(moved);
  return true;
}

/**
 * Move the exact current object aside atomically, then prove that object still has the owned digest. A raced foreign
 * file is put back; if another object has already occupied its path, both are preserved and the change is refused.
 */
async function moveOwned(
  directory: PinnedShimDirectory,
  path: string,
  digest: string,
  suffix: string,
  before?: ((path: string) => void | Promise<void>) | undefined,
): Promise<string | null> {
  await before?.(path);
  await assertPinnedDirectory(directory);
  const moved = join(directory.resolved, `.${basename(path)}.${randomBytes(6).toString('hex')}.${suffix}`);
  try {
    await rename(path, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const bytes = await regularFileBytes(moved);
  if (bytes !== null && sha256(bytes) === digest) return moved;
  if (!(await restoreMoved(directory, path, moved))) {
    throw new CommsError(
      'CONFIG',
      `${path} changed during a managed shim operation; its bytes were preserved at ${moved}`,
      {
        hint: 'Resolve the two files by hand, then run the install, update or prune again.',
      },
    );
  }
  return null;
}

/** Remove only the exact object whose bytes prove it is still owned. */
async function removeOwned(
  directory: PinnedShimDirectory,
  path: string,
  digest: string,
  before?: ((path: string) => void | Promise<void>) | undefined,
): Promise<boolean> {
  const moved = await moveOwned(directory, path, digest, 'remove', before);
  if (moved === null) return false;
  await assertPinnedDirectory(directory);
  await rm(moved);
  return true;
}

function normalPath(path: string, platform: NodeJS.Platform): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function directoryOnPath(context: ManagedShimContext, directory: string): boolean {
  const platform = platformOf(context);
  const value = context.env.PATH ?? context.env.Path ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  return value
    .split(separator)
    .filter(Boolean)
    .some((part) => normalPath(part, platform) === normalPath(directory, platform));
}

function pathNotice(directory: string): string {
  const quoted = posixWord(directory);
  return `The shim directory ${directory} is not on PATH. For this shell, run: export PATH=${quoted}:"$PATH". No shell profile was edited.`;
}

/** Inspect one expected managed shim without changing it. */
export async function inspectManagedShim(
  context: ManagedShimContext,
  options: { binary: string; expectedEntry?: string | undefined },
): Promise<ManagedShimInspection> {
  const publicPath = managedShimPath(context, options.binary);
  const directory = await pinShimDirectory(context, false);
  if (directory === null) {
    return {
      binary: options.binary,
      path: publicPath,
      status: 'missing',
      detail: 'the managed shim is missing',
    };
  }
  const path = join(directory.resolved, basename(publicPath));
  const receipt = await readReceipt(context);
  const recorded = receipt?.shims[options.binary];
  if (receipt === null || recorded === undefined || recorded.path !== path) {
    return (await pathExists(path))
      ? {
          binary: options.binary,
          path: publicPath,
          status: 'foreign',
          detail: 'the file was not written by this installation',
        }
      : { binary: options.binary, path: publicPath, status: 'missing', detail: 'the managed shim is missing' };
  }
  const bytes = await regularFileBytes(path);
  if (bytes === null) {
    return {
      ...recorded,
      binary: options.binary,
      path: publicPath,
      status: 'missing',
      detail: 'the managed shim is missing',
    };
  }
  if (sha256(bytes) !== recorded.digest) {
    return {
      ...recorded,
      binary: options.binary,
      path: publicPath,
      status: 'foreign',
      detail: 'the file changed after this installation wrote it',
    };
  }
  if (options.expectedEntry !== undefined && recorded.entry !== options.expectedEntry) {
    return {
      ...recorded,
      binary: options.binary,
      path: publicPath,
      status: 'stale',
      detail: `the shim starts ${recorded.entry}, not ${options.expectedEntry}`,
    };
  }
  if (!(await pathExists(recorded.node)) || !(await pathExists(recorded.entry))) {
    return {
      ...recorded,
      binary: options.binary,
      path: publicPath,
      status: 'stale',
      detail: 'the managed Node or CLI entry the shim starts is missing',
    };
  }
  return {
    ...recorded,
    binary: options.binary,
    path: publicPath,
    status: 'current',
    detail: 'the managed shim is current',
  };
}

/** Create or repoint one shim, but only while its target is free or still matches this installation's receipt. */
export async function writeManagedShim(
  context: ManagedShimContext,
  spec: ManagedShimSpec,
): Promise<ManagedShimWriteResult> {
  checkedBinary(spec.binary);
  const directory = await pinShimDirectory(context, true);
  if (directory === null) throw new CommsError('UNEXPECTED', 'the managed shim directory was not created');
  const publicPath = join(directory.public, spec.binary);
  const path = join(directory.resolved, spec.binary);
  const result = (status: ManagedShimWriteResult['status']): ManagedShimWriteResult => {
    const onPath = directoryOnPath(context, directory.public);
    return {
      path: publicPath,
      directory: directory.public,
      status,
      onPath,
      ...(onPath ? {} : { pathNotice: pathNotice(directory.public) }),
    };
  };
  return withMutationLock(context, async () => {
    const receipt = await readReceipt(context);
    const recorded = receipt?.shims[spec.binary];
    const current = await regularFileBytes(path);
    const owned =
      receipt !== null &&
      recorded !== undefined &&
      recorded.path === path &&
      current !== null &&
      sha256(current) === recorded.digest;
    if ((await pathExists(path)) && !owned) return result('foreign');
    if (receipt === null || (recorded !== undefined && recorded.path !== path)) return result('foreign');

    const node = spec.command[0];
    if (node === undefined) throw new CommsError('CONFIG', 'the managed shim command has no program');
    const source = shimSource(spec);
    const digest = sha256(source);
    let previous: string | null = null;
    if (owned) {
      previous = await moveOwned(directory, path, recorded.digest, 'old', context.hooks?.beforeReplace);
      if (previous === null) return result('foreign');
    }
    try {
      await createShimExclusive(directory, path, source);
    } catch (error) {
      if (previous !== null) {
        const restored = await restoreMoved(directory, path, previous);
        if (!restored) {
          throw new CommsError(
            'CONFIG',
            `${path} was occupied while its owned shim was being updated; the old shim remains at ${previous}`,
            {
              hint: 'Resolve the two files by hand, then run the managed install again.',
              cause: error,
            },
          );
        }
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return result('foreign');
      throw error;
    }

    receipt.shims[spec.binary] = { path, digest, node, entry: spec.entry };
    try {
      await assertPinnedDirectory(directory);
      await writeReceipt(context, receipt);
    } catch (error) {
      const removed = await removeOwned(directory, path, digest);
      if (previous !== null && removed && !(await restoreMoved(directory, path, previous))) {
        throw new CommsError(
          'CONFIG',
          `the shim receipt failed and the old shim could not be restored from ${previous}`,
          {
            hint: 'Restore that file to the reported shim path, then run the managed install again.',
            cause: error,
          },
        );
      }
      throw error;
    }
    if (previous !== null) {
      await assertPinnedDirectory(directory);
      await rm(previous);
    }
    return result(owned ? 'updated' : 'created');
  });
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

/** Remove unchanged owned shims whose recorded entry is inside one of the runtimes prune removed. */
export async function removeManagedShimsForRuntimes(
  context: ManagedShimContext,
  runtimes: readonly string[],
  options: { dryRun?: boolean | undefined } = {},
): Promise<{ removed: string[]; kept: string[] }> {
  if (!managedShimsSupported(context)) return { removed: [], kept: [] };
  const directory = await pinShimDirectory(context, false);
  if (directory === null) return { removed: [], kept: [] };
  return withMutationLock(context, async () => {
    const receipt = await readReceipt(context);
    if (receipt === null) return { removed: [], kept: [] };
    const removed: string[] = [];
    const kept: string[] = [];
    let changed = false;
    for (const [binary, recorded] of Object.entries(receipt.shims)) {
      if (!runtimes.some((runtime) => isWithin(runtime, recorded.entry))) continue;
      const publicPath = join(directory.public, binary);
      const path = join(directory.resolved, binary);
      if (recorded.path !== path) {
        kept.push(recorded.path);
        continue;
      }
      if (options.dryRun) {
        const bytes = await regularFileBytes(path);
        if (bytes !== null && sha256(bytes) === recorded.digest) removed.push(publicPath);
        else if (await pathExists(path)) kept.push(publicPath);
        continue;
      }
      if (await removeOwned(directory, path, recorded.digest, context.hooks?.beforeRemove)) {
        delete receipt.shims[binary];
        changed = true;
        removed.push(publicPath);
      } else if (!(await pathExists(path))) {
        delete receipt.shims[binary];
        changed = true;
      } else {
        kept.push(publicPath);
      }
    }
    if (changed) {
      await assertPinnedDirectory(directory);
      await writeReceipt(context, receipt);
    }
    return { removed, kept };
  });
}
