import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

const BLOCK_SIZE = 512;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const EXECUTABLE_FILE_MODE = 0o700;

export type TarSource = AsyncIterable<Uint8Array>;

export interface RuntimeTreeFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

export type LayaTarErrorCode =
  | 'TAR_CHECKSUM'
  | 'TAR_DUPLICATE'
  | 'TAR_ENTRY_TYPE'
  | 'TAR_EXECUTABLE'
  | 'TAR_HASH'
  | 'TAR_HEADER'
  | 'TAR_MISSING'
  | 'TAR_PATH'
  | 'TAR_SIZE'
  | 'TAR_TRUNCATED';

export class LayaTarError extends Error {
  readonly code: LayaTarErrorCode;

  constructor(code: LayaTarErrorCode) {
    super(`Laya runtime archive refused: ${code}`);
    this.name = 'LayaTarError';
    this.code = code;
  }
}

interface TarEntry {
  readonly path: string;
  readonly size: number;
  readonly executable: boolean;
}

type RuntimePathKind = 'directory' | 'file';

interface RuntimePathIdentity {
  readonly path: string;
  readonly kind: RuntimePathKind;
}

class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #buffer = Buffer.alloc(0);

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async readExactly(size: number): Promise<Buffer> {
    while (this.#buffer.length < size) {
      const next = await this.#iterator.next();
      if (next.done) throw new LayaTarError('TAR_TRUNCATED');
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(next.value)]);
    }
    const value = this.#buffer.subarray(0, size);
    this.#buffer = this.#buffer.subarray(size);
    return value;
  }

  async ensureEndIsZero(): Promise<void> {
    while (true) {
      const next = await this.#iterator.next();
      if (next.done) break;
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(next.value)]);
    }
    if (this.#buffer.some((byte) => byte !== 0)) throw new LayaTarError('TAR_HEADER');
  }
}

class TarBody {
  readonly #reader: ByteReader;
  #remaining: number;

  constructor(reader: ByteReader, size: number) {
    this.#reader = reader;
    this.#remaining = size;
  }

  async *chunks(): AsyncGenerator<Buffer> {
    while (this.#remaining > 0) {
      const count = Math.min(this.#remaining, 64 * 1024);
      const chunk = await this.#reader.readExactly(count);
      this.#remaining -= chunk.length;
      yield chunk;
    }
  }

  async drain(): Promise<void> {
    for await (const _chunk of this.chunks()) {
      // The parser must always consume the archive entry before it reads its padding.
    }
  }
}

function isRegularFile(type: number): boolean {
  return type === 0 || type === '0'.charCodeAt(0);
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.endsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function textField(bytes: Buffer): string {
  const firstNul = bytes.indexOf(0);
  const textBytes = firstNul === -1 ? bytes : bytes.subarray(0, firstNul);
  if (firstNul !== -1 && bytes.subarray(firstNul).some((byte) => byte !== 0)) throw new LayaTarError('TAR_PATH');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(textBytes);
  } catch {
    throw new LayaTarError('TAR_PATH');
  }
}

function strictOctalField(bytes: Buffer): number {
  if (bytes.length < 2) throw new LayaTarError('TAR_HEADER');
  if (bytes.every((byte) => byte === 0)) return 0;
  const terminator = bytes[bytes.length - 1];
  if (terminator !== 0 && terminator !== 0x20) throw new LayaTarError('TAR_HEADER');

  let value = 0;
  let sawDigit = false;
  for (let index = 0; index < bytes.length - 1; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0x20) {
      if (sawDigit) throw new LayaTarError('TAR_HEADER');
      continue;
    }
    if (byte < '0'.charCodeAt(0) || byte > '7'.charCodeAt(0)) throw new LayaTarError('TAR_HEADER');
    const digit = byte - '0'.charCodeAt(0);
    if (value > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 8)) throw new LayaTarError('TAR_HEADER');
    value = value * 8 + digit;
    sawDigit = true;
  }
  if (!sawDigit) throw new LayaTarError('TAR_HEADER');
  return value;
}

function checksumField(bytes: Buffer): number {
  if (bytes.length !== 8) throw new LayaTarError('TAR_CHECKSUM');
  const standardLayout = bytes[6] === 0 && bytes[7] === 0x20;
  const archiverLayout = bytes[7] === 0 || bytes[7] === 0x20;
  if (!standardLayout && !archiverLayout) throw new LayaTarError('TAR_CHECKSUM');
  return strictOctalField(bytes.subarray(0, standardLayout ? 7 : 8));
}

function numericHeaderFields(header: Buffer): { readonly mode: number; readonly size: number } {
  const mode = strictOctalField(header.subarray(100, 108));
  strictOctalField(header.subarray(108, 116));
  strictOctalField(header.subarray(116, 124));
  const size = strictOctalField(header.subarray(124, 136));
  strictOctalField(header.subarray(136, 148));
  strictOctalField(header.subarray(329, 337));
  strictOctalField(header.subarray(337, 345));
  return { mode, size };
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return sum;
}

function packagePathIdentity(path: string): string {
  if (path !== path.normalize('NFC')) throw new LayaTarError('TAR_PATH');
  return path.toUpperCase().toLowerCase().normalize('NFC');
}

function recordPathIdentities(path: string, identities: Map<string, RuntimePathIdentity>): void {
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    const candidate = parts.slice(0, index).join('/');
    const kind: RuntimePathKind = index === parts.length ? 'file' : 'directory';
    const identity = packagePathIdentity(candidate);
    const previous = identities.get(identity);
    if (previous === undefined) {
      identities.set(identity, { path: candidate, kind });
      continue;
    }
    if (previous.path !== candidate || previous.kind !== kind) {
      throw new LayaTarError('TAR_DUPLICATE');
    }
    if (kind === 'file') throw new LayaTarError('TAR_DUPLICATE');
  }
}

function parseEntry(header: Buffer): TarEntry {
  if (
    !header.subarray(257, 263).equals(Buffer.from('ustar\0', 'ascii')) ||
    !header.subarray(263, 265).equals(Buffer.from('00'))
  ) {
    throw new LayaTarError('TAR_HEADER');
  }
  if (checksumField(header.subarray(148, 156)) !== headerChecksum(header)) throw new LayaTarError('TAR_CHECKSUM');
  const numeric = numericHeaderFields(header);
  const type = header[156] ?? 0;
  if (!isRegularFile(type)) throw new LayaTarError('TAR_ENTRY_TYPE');
  const prefix = textField(header.subarray(345, 500));
  const name = textField(header.subarray(0, 100));
  const path = prefix.length === 0 ? name : `${prefix}/${name}`;
  if (path.includes('\\') || !isSafeRelativePath(path)) throw new LayaTarError('TAR_PATH');
  if (!path.startsWith('package/')) throw new LayaTarError('TAR_PATH');
  const relative = path.slice('package/'.length);
  packagePathIdentity(relative);
  return { path: relative, size: numeric.size, executable: (numeric.mode & 0o111) !== 0 };
}

async function parseGzippedUstar(
  archive: Buffer,
  onEntry: (entry: TarEntry, body: TarBody) => Promise<void>,
): Promise<void> {
  const compressed = Readable.from([archive]);
  const gunzip = compressed.pipe(createGunzip());
  const reader = new ByteReader(gunzip);
  const allPathIdentities = new Map<string, RuntimePathIdentity>();
  while (true) {
    const header = await reader.readExactly(BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      const secondEndBlock = await reader.readExactly(BLOCK_SIZE);
      if (!secondEndBlock.every((byte) => byte === 0)) throw new LayaTarError('TAR_HEADER');
      await reader.ensureEndIsZero();
      return;
    }
    const entry = parseEntry(header);
    recordPathIdentities(entry.path, allPathIdentities);
    const body = new TarBody(reader, entry.size);
    await onEntry(entry, body);
    await body.drain();
    const padding = (BLOCK_SIZE - (entry.size % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) await reader.readExactly(padding);
  }
}

function expectedFiles(files: readonly RuntimeTreeFile[]): Map<string, RuntimeTreeFile> {
  const result = new Map<string, RuntimeTreeFile>();
  const identities = new Map<string, RuntimePathIdentity>();
  for (const file of files) {
    if (
      !isSafeRelativePath(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.executable !== 'boolean'
    ) {
      throw new LayaTarError('TAR_PATH');
    }
    recordPathIdentities(file.path, identities);
    if (result.has(file.path)) throw new LayaTarError('TAR_DUPLICATE');
    result.set(file.path, file);
  }
  return result;
}

/** Validates a complete runtime tree listing before it is used to create or inspect a filesystem tree. */
export function validateRuntimeTreeFiles(files: readonly RuntimeTreeFile[]): ReadonlyMap<string, RuntimeTreeFile> {
  return expectedFiles(files);
}

async function archiveBytes(source: TarSource): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function validateExpectedPackageArchive(
  archive: Buffer,
  expectedByPath: ReadonlyMap<string, RuntimeTreeFile>,
): Promise<void> {
  const found = new Set<string>();
  await parseGzippedUstar(archive, async (entry, body) => {
    const expected = expectedByPath.get(entry.path);
    if (expected === undefined) return;
    if (entry.size !== expected.size) throw new LayaTarError('TAR_SIZE');
    if (entry.executable !== expected.executable) throw new LayaTarError('TAR_EXECUTABLE');
    const hash = createHash('sha256');
    for await (const chunk of body.chunks()) hash.update(chunk);
    if (hash.digest('hex') !== expected.sha256) throw new LayaTarError('TAR_HASH');
    found.add(entry.path);
  });
  for (const path of expectedByPath.keys()) {
    if (!found.has(path)) throw new LayaTarError('TAR_MISSING');
  }
}

async function makeOwnerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  await chmod(path, OWNER_ONLY_DIRECTORY_MODE);
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten === 0) throw new LayaTarError('TAR_TRUNCATED');
    offset += bytesWritten;
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new LayaTarError('TAR_PATH');
}

/** Returns every safe regular file in a gzip-compressed ustar package archive for lock construction. */
export async function inspectPackageArchive(source: TarSource): Promise<readonly RuntimeTreeFile[]> {
  const archive = await archiveBytes(source);
  const files: RuntimeTreeFile[] = [];
  await parseGzippedUstar(archive, async (entry, body) => {
    const hash = createHash('sha256');
    for await (const chunk of body.chunks()) hash.update(chunk);
    files.push({ path: entry.path, size: entry.size, sha256: hash.digest('hex'), executable: entry.executable });
  });
  return files;
}

/** The largest `package.json` the release-only lock builder reads from a package archive. */
const PACKAGE_MANIFEST_MAX_BYTES = 1024 * 1024;

/**
 * A strict package archive's own `package.json`, or null when it has none, read through the same parser as every other
 * reader of the archive. Only the release-only lock builder calls it (E2 review round 1, A8), to refuse a tree that does
 * not carry a package one of its packages declares; the daemon never does.
 */
export async function readPackageArchiveManifest(source: TarSource): Promise<Buffer | null> {
  const archive = await archiveBytes(source);
  const found: Buffer[] = [];
  await parseGzippedUstar(archive, async (entry, body) => {
    if (entry.path !== 'package.json') return;
    if (entry.size > PACKAGE_MANIFEST_MAX_BYTES) throw new LayaTarError('TAR_SIZE');
    const chunks: Buffer[] = [];
    for await (const chunk of body.chunks()) chunks.push(chunk);
    found.push(Buffer.concat(chunks));
  });
  return found[0] ?? null;
}

/** Extracts only expected files from a strict package archive into a caller-owned owner-only partial tree. */
export async function extractPackageArchive(options: {
  readonly source: TarSource;
  readonly destination: string;
  readonly files: readonly RuntimeTreeFile[];
}): Promise<void> {
  const expectedByPath = expectedFiles(options.files);
  const archive = await archiveBytes(options.source);
  await validateExpectedPackageArchive(archive, expectedByPath);
  const written = new Set<string>();
  await makeOwnerOnlyDirectory(dirname(options.destination));
  await assertAbsent(options.destination);
  const staging = await mkdtemp(join(dirname(options.destination), `.${basename(options.destination)}.staging-`));
  await chmod(staging, OWNER_ONLY_DIRECTORY_MODE);
  let promoted = false;
  try {
    await parseGzippedUstar(archive, async (entry, body) => {
      const expected = expectedByPath.get(entry.path);
      if (expected === undefined) {
        return;
      }
      if (entry.size !== expected.size) throw new LayaTarError('TAR_SIZE');
      if (entry.executable !== expected.executable) throw new LayaTarError('TAR_EXECUTABLE');
      const target = join(staging, entry.path);
      await makeOwnerOnlyDirectory(dirname(target));
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        OWNER_ONLY_FILE_MODE,
      );
      const hash = createHash('sha256');
      try {
        for await (const chunk of body.chunks()) {
          hash.update(chunk);
          await writeAll(handle, chunk);
        }
      } finally {
        await handle.close();
      }
      const digest = hash.digest('hex');
      if (digest !== expected.sha256) {
        await rm(target, { force: true });
        throw new LayaTarError('TAR_HASH');
      }
      await chmod(target, expected.executable ? EXECUTABLE_FILE_MODE : OWNER_ONLY_FILE_MODE);
      written.add(entry.path);
    });
    for (const path of expectedByPath.keys()) {
      if (!written.has(path)) throw new LayaTarError('TAR_MISSING');
    }
    await assertAbsent(options.destination);
    await rename(staging, options.destination);
    promoted = true;
  } finally {
    if (!promoted) await rm(staging, { recursive: true, force: true });
  }
}
