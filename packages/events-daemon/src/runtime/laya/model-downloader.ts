import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { layaModelArtifactPaths } from './artifact-paths.ts';
import type { CanonicalLayaManifest, LayaManifestFile } from './contracts.ts';
import { type LayaArtifactFetcher, LayaFetchError } from './fetcher.ts';

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const MAX_FILE_ATTEMPTS = 5;

export type LayaModelDownloadErrorCode =
  | 'CANCELLED'
  | 'DEADLINE'
  | 'DISK_SPACE'
  | 'DOWNLOAD_FAILED'
  | 'LIFECYCLE_FENCE'
  | 'MODEL_EXISTS'
  | 'MODEL_PATH';

export class LayaModelDownloadError extends Error {
  readonly code: LayaModelDownloadErrorCode;

  constructor(code: LayaModelDownloadErrorCode) {
    super(`Laya model download refused: ${code}`);
    this.name = 'LayaModelDownloadError';
    this.code = code;
  }
}

export interface LayaArtifactFence {
  /** Must observe signal so a lifecycle fence cannot strand an aborted artifact write. */
  assertCurrent(stage: 'start' | 'retry' | 'promotion', signal: AbortSignal): Promise<void>;
  withArtifactLock<T>(work: () => Promise<T>): Promise<T>;
}

export interface LayaModelDownloadOptions {
  readonly signal: AbortSignal;
  readonly freeBytes?: (() => Promise<number>) | undefined;
}

async function ownerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LayaModelDownloadError('MODEL_PATH');
  await chmod(path, OWNER_ONLY_DIRECTORY_MODE);
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof LayaFetchError) throw downloadErrorForFetch(signal.reason);
  throw new LayaModelDownloadError('CANCELLED');
}

function awaitFenceWithSignal(wait: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      try {
        abortIfNeeded(signal);
      } catch (error) {
        reject(error);
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void wait.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function downloadErrorForFetch(error: LayaFetchError): LayaModelDownloadError {
  if (error.code === 'ABORTED') return new LayaModelDownloadError('CANCELLED');
  if (error.code === 'IDLE_TIMEOUT' || error.code === 'TOTAL_TIMEOUT') return new LayaModelDownloadError('DEADLINE');
  return new LayaModelDownloadError('DOWNLOAD_FAILED');
}

async function hashFile(path: string): Promise<{ readonly size: number; readonly sha256: string }> {
  const bytes = await readFile(path);
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function partialSize(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new LayaModelDownloadError('MODEL_PATH');
    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function verifyPartialFile(path: string, file: LayaManifestFile, size: number): Promise<void> {
  const actual = await hashFile(path);
  if (actual.size !== size || size > file.size) throw new LayaModelDownloadError('DOWNLOAD_FAILED');
  // Hashing is intentionally performed even though a prefix cannot equal the final
  // manifest SHA-256: it proves the resumed offset still names bytes we read.
  if (size === file.size && actual.sha256 !== file.sha256) throw new LayaModelDownloadError('DOWNLOAD_FAILED');
}

async function availableBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Downloads only the reviewed complete manifest tree, keeping every incomplete byte under one partial root. */
export class LayaModelDownloader {
  readonly #dataDirectory: string;
  readonly #manifest: Pick<CanonicalLayaManifest, 'manifestId' | 'files'>;
  readonly #fetcher: LayaArtifactFetcher;
  readonly #fence: LayaArtifactFence;

  constructor(options: {
    readonly dataDirectory: string;
    readonly manifest: Pick<CanonicalLayaManifest, 'manifestId' | 'files'>;
    readonly fetcher: LayaArtifactFetcher;
    readonly fence: LayaArtifactFence;
  }) {
    if (options.fence === undefined) throw new LayaModelDownloadError('LIFECYCLE_FENCE');
    this.#dataDirectory = options.dataDirectory;
    this.#manifest = options.manifest;
    this.#fetcher = options.fetcher;
    this.#fence = options.fence;
  }

  async download(
    options: LayaModelDownloadOptions,
  ): Promise<{ readonly root: string; readonly bytesVerified: number }> {
    const paths = layaModelArtifactPaths(this.#dataDirectory, this.#manifest.manifestId);
    try {
      abortIfNeeded(options.signal);
      await this.#assertCurrent('start', options.signal);
      await ownerOnlyDirectory(paths.models);
      if (!(await missing(paths.complete))) throw new LayaModelDownloadError('MODEL_EXISTS');
      await this.#assertCurrent('retry', options.signal);
      await ownerOnlyDirectory(paths.partial);
      const total = this.#manifest.files.reduce((sum, file) => sum + file.size, 0);
      const free = await (options.freeBytes ?? (() => availableBytes(paths.models)))();
      if (!Number.isSafeInteger(free) || free < Math.ceil(total * 1.1)) throw new LayaModelDownloadError('DISK_SPACE');
      let verified = 0;
      for (const file of this.#manifest.files) {
        abortIfNeeded(options.signal);
        await this.#assertCurrent('retry', options.signal);
        verified += await this.#downloadFile(paths.file(file, 'partial'), file, options.signal);
      }
      abortIfNeeded(options.signal);
      if (!(await missing(paths.complete))) throw new LayaModelDownloadError('MODEL_EXISTS');
      return this.#fence.withArtifactLock(async () => {
        abortIfNeeded(options.signal);
        if (!(await missing(paths.complete))) throw new LayaModelDownloadError('MODEL_EXISTS');
        await this.#assertCurrent('promotion', options.signal);
        await rename(paths.partial, paths.complete);
        return { root: paths.complete, bytesVerified: verified };
      });
    } catch (error) {
      await rm(paths.partial, { recursive: true, force: true });
      if (error instanceof LayaModelDownloadError) throw error;
      if (error instanceof LayaFetchError) throw downloadErrorForFetch(error);
      throw error;
    }
  }

  async cleanupPartial(): Promise<void> {
    const paths = layaModelArtifactPaths(this.#dataDirectory, this.#manifest.manifestId);
    await rm(paths.partial, { recursive: true, force: true });
  }

  async #assertCurrent(stage: 'start' | 'retry' | 'promotion', signal: AbortSignal): Promise<void> {
    await awaitFenceWithSignal(this.#fence.assertCurrent(stage, signal), signal);
  }

  async #downloadFile(path: string, file: LayaManifestFile, signal: AbortSignal): Promise<number> {
    await this.#assertCurrent('retry', signal);
    await ownerOnlyDirectory(dirname(path));
    for (let attempt = 0; attempt < MAX_FILE_ATTEMPTS; attempt += 1) {
      abortIfNeeded(signal);
      let current = await partialSize(path);
      if (current > 0) {
        try {
          await verifyPartialFile(path, file, current);
        } catch {
          await rm(path, { force: true });
          current = 0;
        }
      }
      try {
        let wrote = false;
        await this.#fetcher.fetchModelFileTo(
          file,
          current === 0 ? undefined : current,
          async (chunk, fetchSignal) => {
            abortIfNeeded(fetchSignal);
            await this.#assertCurrent('retry', fetchSignal);
            abortIfNeeded(fetchSignal);
            if (current === 0 && !wrote) {
              await writeFile(path, chunk, { mode: OWNER_ONLY_FILE_MODE, flag: 'wx' });
            } else {
              await appendFile(path, chunk, { mode: OWNER_ONLY_FILE_MODE });
            }
            abortIfNeeded(fetchSignal);
            wrote = true;
          },
          { signal },
        );
        abortIfNeeded(signal);
        await this.#assertCurrent('retry', signal);
        await chmod(path, OWNER_ONLY_FILE_MODE);
        const final = await hashFile(path);
        await this.#assertCurrent('retry', signal);
        if (final.size !== file.size || final.sha256 !== file.sha256)
          throw new LayaModelDownloadError('DOWNLOAD_FAILED');
        return final.size;
      } catch (error) {
        await rm(path, { force: true });
        if (error instanceof LayaFetchError) {
          const terminal = downloadErrorForFetch(error);
          if (terminal.code === 'CANCELLED' || terminal.code === 'DEADLINE') throw terminal;
        }
        if (error instanceof LayaModelDownloadError && (error.code === 'CANCELLED' || error.code === 'DEADLINE'))
          throw error;
        if (attempt + 1 === MAX_FILE_ATTEMPTS) {
          if (error instanceof LayaModelDownloadError) throw error;
          if (error instanceof LayaFetchError) throw downloadErrorForFetch(error);
          throw new LayaModelDownloadError('DOWNLOAD_FAILED');
        }
      }
    }
    throw new LayaModelDownloadError('DOWNLOAD_FAILED');
  }
}
