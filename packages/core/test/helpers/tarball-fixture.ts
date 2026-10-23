import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/*
 * Release tarballs made here, for tests that read what a release declares (design 2026-10-22 P1, P3): an npm tarball
 * is a gzipped ustar archive whose every entry sits below `package/`, its manifest at `package/package.json`.
 *
 * Every byte is deterministic — mtime 0, owner 0, the gzip header's OS byte fixed — so two processes that build one
 * release's tarball build the same bytes, and the integrity a stand-in registry gives for it is the one its provenance
 * signs. Entries can be made that npm never writes (a pax header renaming the next entry, a GNU long name, a symlink,
 * a bad checksum), to test the reader's refusals one at a time.
 *
 * Nothing here uses the reader under test (`src/release-tarball.ts`): `unpackTarball` walks the archive itself, so a
 * fault in the reader cannot hide behind its own fixture.
 */

const BLOCK = 512;

/** One entry of an archive: a regular file by default (`'0'`); `'x'` and `'L'` apply to the entry after them. */
export interface FixtureEntry {
  path: string;
  data?: string | Buffer;
  type?: '0' | '2' | '5' | 'x' | 'L' | 'g';
  linkname?: string;
}

/** A pax extended header's records, each `<length> <key>=<value>\n` with its own length counted. */
export function paxRecords(records: Record<string, string>): string {
  return Object.entries(records)
    .map(([key, value]) => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      while (String(length).length + body.length !== length) length = String(length).length + body.length;
      return `${length}${body}`;
    })
    .join('');
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function put(header: Buffer, at: number, width: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > width) throw new Error(`a tar header field of ${width} bytes cannot hold ${bytes.length}`);
  bytes.copy(header, at);
}

/** Splits a path into ustar's prefix (155) and name (100), or throws: a longer one needs an `'x'` or `'L'` entry. */
function split(path: string): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path };
  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name };
  }
  throw new Error(`${path} is too long for a ustar header: give it an 'x' or 'L' entry`);
}

/** The header's checksum: the byte sum with its own eight bytes read as spaces, as six octal digits, NUL, space. */
function sealHeader(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
}

function headerOf(entry: FixtureEntry, size: number): Buffer {
  const type = entry.type ?? '0';
  const header = Buffer.alloc(BLOCK);
  const { prefix, name } = split(entry.path);
  put(header, 0, 100, name);
  put(header, 100, 8, octal(type === '5' ? 0o755 : type === '2' ? 0o777 : 0o644, 8));
  put(header, 108, 8, octal(0, 8));
  put(header, 116, 8, octal(0, 8));
  put(header, 124, 12, octal(size, 12));
  put(header, 136, 12, octal(0, 12));
  put(header, 156, 1, type);
  put(header, 157, 100, entry.linkname ?? '');
  put(header, 257, 6, 'ustar\0');
  put(header, 263, 2, '00');
  put(header, 345, 155, prefix);
  sealHeader(header);
  return header;
}

/**
 * A ustar archive of `entries`, in order, ended by two zero blocks. `badChecksumAt` spoils the checksum of that entry's
 * header (by index), and nothing else.
 */
export function ustar(entries: readonly FixtureEntry[], options: { badChecksumAt?: number } = {}): Buffer {
  const blocks: Buffer[] = [];
  entries.forEach((entry, index) => {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const header = headerOf(entry, data.length);
    if (index === options.badChecksumAt) header[148] = header[148] === 0x37 ? 0x36 : 0x37;
    blocks.push(header, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  });
  blocks.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(blocks);
}

/** Rewrites one header of a ustar archive (by its byte offset) and seals its checksum again. */
export function rewriteHeader(tar: Buffer, offset: number, change: (header: Buffer) => void): Buffer {
  const out = Buffer.from(tar);
  const header = out.subarray(offset, offset + BLOCK);
  change(header);
  sealHeader(header);
  return out;
}

/** Gzipped, deterministically: zlib's own header carries mtime 0; its OS byte is set to 255, "unknown", everywhere. */
export function gzip(bytes: Buffer): Buffer {
  const out = gzipSync(bytes, { level: 9 });
  out[9] = 0xff;
  return out;
}

/**
 * A release's tarball as npm packs one: `package/package.json` — the release's name and version, `declares` as its
 * `agentcommsRelease`, and `manifest`'s fields over those — then `files` (over a default `dist/cli.mjs`), each below
 * `package/`, sorted.
 */
export function releaseTarball(
  packageName: string,
  version: string,
  options: { declares?: unknown; manifest?: Record<string, unknown>; files?: Record<string, string | Buffer> } = {},
): Buffer {
  const manifest = {
    name: packageName,
    version,
    ...(options.declares !== undefined ? { agentcommsRelease: options.declares } : {}),
    ...options.manifest,
  };
  const files: Record<string, string | Buffer> = {
    'dist/cli.mjs': `// ${packageName}@${version}, packed for a test\nprocess.exit(0);\n`,
    ...options.files,
  };
  return gzip(
    ustar([
      { path: 'package/package.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
      ...Object.keys(files)
        .sort()
        .map((path) => ({ path: `package/${path}`, data: files[path] as string | Buffer })),
    ]),
  );
}

/** The integrity npm gives for `bytes`: `sha512-<base64>`. */
export function integrityOfBytes(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function field(header: Buffer, at: number, width: number): string {
  const raw = header.subarray(at, at + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? width : end).toString('utf8');
}

/**
 * Unpacks a tarball's regular files and folders, `package/*` into `into/*`, as npm would: for a stand-in that installs
 * one. Walks the archive itself (pax `path`, GNU long names); throws on anything it would not write.
 */
export async function unpackTarball(gz: Buffer, into: string): Promise<void> {
  const tar = gunzipSync(gz);
  let next: string | undefined;
  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = field(header, 156, 1) || '0';
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      next = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? next;
      continue;
    }
    if (type === 'L') {
      next = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    const prefix = field(header, 257, 6) === 'ustar' ? field(header, 345, 155) : '';
    const name = next ?? (prefix === '' ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`);
    next = undefined;
    const parts = name.replace(/^(\.\/)+/, '').split('/');
    if (parts[0] !== 'package' || parts.includes('..')) throw new Error(`${name} is not below package/`);
    const target = join(into, ...parts.slice(1));
    if (type === '5') await mkdir(target, { recursive: true });
    else if (type === '0') {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    } else throw new Error(`${name} is not a file or a folder`);
  }
}
