import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export type UstarType = '0' | '1' | '2' | '3' | '4' | '5' | '6' | 'x';

export interface UstarFixtureEntry {
  readonly path: string;
  readonly data?: string | Uint8Array;
  readonly type?: UstarType;
  readonly mode?: number;
  readonly rawName?: Uint8Array;
}

export interface RuntimeFixtureFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

function octal(value: number, width: number): Buffer {
  const text = value.toString(8);
  if (text.length + 1 > width) throw new Error(`fixture value does not fit in ${width} octal bytes`);
  return Buffer.from(`${text.padStart(width - 1, '0')}\0`, 'ascii');
}

function copyField(header: Buffer, offset: number, width: number, value: Uint8Array): void {
  if (value.length > width) throw new Error(`fixture field at ${offset} is too long`);
  Buffer.from(value).copy(header, offset);
}

function setChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  octal(checksum, 8).copy(header, 148);
}

function headerFor(entry: UstarFixtureEntry): Buffer {
  const payload = Buffer.from(entry.data ?? '');
  const header = Buffer.alloc(512);
  copyField(header, 0, 100, entry.rawName ?? Buffer.from(entry.path, 'utf8'));
  octal(entry.mode ?? 0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(payload.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header[156] = (entry.type ?? '0').charCodeAt(0);
  Buffer.from('ustar\0', 'ascii').copy(header, 257);
  Buffer.from('00', 'ascii').copy(header, 263);
  setChecksum(header);
  return header;
}

/** Generates a tiny synthetic gzip-compressed ustar fixture beneath a caller-owned temporary directory. */
export async function writeUstarFixture(
  directory: string,
  name: string,
  entries: readonly UstarFixtureEntry[],
  options: {
    readonly corruptChecksum?: boolean;
    readonly corruptHeader?: boolean;
    readonly corruptSize?: boolean;
  } = {},
): Promise<string> {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = headerFor(entry);
    if (options.corruptHeader) header[257] = 'x'.charCodeAt(0);
    if (options.corruptSize) header[124] = 'x'.charCodeAt(0);
    if (options.corruptHeader || options.corruptSize) setChecksum(header);
    if (options.corruptChecksum) {
      const firstChecksumByte = header[148];
      if (firstChecksumByte === undefined) throw new Error('fixture checksum field is missing');
      header[148] = firstChecksumByte ^ 0x01;
    }
    const payload = Buffer.from(entry.data ?? '');
    blocks.push(header, payload);
    const padding = (512 - (payload.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  const path = join(directory, name);
  await writeFile(path, gzipSync(Buffer.concat(blocks)));
  return path;
}

export function archiveChunks(path: string): AsyncIterable<Uint8Array> {
  return createReadStream(path);
}

export function runtimeFile(path: string, data: string | Uint8Array, executable = false): RuntimeFixtureFile {
  const bytes = Buffer.from(data);
  return {
    path,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    executable,
  };
}
