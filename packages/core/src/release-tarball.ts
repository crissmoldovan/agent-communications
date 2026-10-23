import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { Packument } from './update-release.ts';

/**
 * A release's own tarball, read for what it declares and installed from (design 2026-10-22 P1, P3, §7.1).
 *
 * Verification proves where a tarball came from; the registry's copy of its manifest proves nothing. So what a
 * release declares is read from the tarball itself, and only from the bytes whose sha512 is the **verified** provenance
 * digest. Where those bytes come from adds nothing: any `http:` or `https:` address the packument names, a mirror's or
 * a CDN's, through at most five redirects, and once more from npm's canonical address if that fails. npm itself trusts
 * the integrity, not the origin.
 *
 * Everything is bounded: 32 MiB arriving within 60 seconds, 128 MiB once gunzipped, 1 MiB of manifest. The archive is
 * walked here, header by header — no tar library — and anything this reader does not know how to apply is a refusal:
 * a bad checksum, a base-256 size, a path outside `package/` or with a `..` in it, a global pax header. A refusal is
 * a problem word, never what the bytes held.
 *
 * No Sigstore here, and nothing runs when this module is loaded: verifying is the caller's, and WhatsApp's bundle,
 * which may carry a module that imports this one, drops it. No credential is sent with a tarball request, and nothing
 * here reads the person's npm configuration.
 */

export const TARBALL_MAX_BYTES: number = 32 * 1024 * 1024;
export const TARBALL_TIMEOUT_MS: number = 60_000;
export const TARBALL_MAX_REDIRECTS: number = 5;
export const UNPACKED_MAX_BYTES: number = 128 * 1024 * 1024;
export const MANIFEST_MAX_BYTES: number = 1024 * 1024;

/** How a tarball is asked for: one request, its redirects handed back rather than followed. */
export type TarballFetch = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

/** Why a tarball's declaration could not be read, in this package's words. */
export type TarballProblem = 'download' | 'size' | 'digest' | 'gzip' | 'archive' | 'manifest' | 'identity';

/** The release a tarball must be: its package, its version, and the sha512 its provenance verified. */
export interface TarballRelease {
  packageName: string;
  version: string;
  /** verified, hex */
  sha512: string;
}

/** One entry of a release's archive. */
export interface TarballEntry {
  /** below `package/`, POSIX */
  path: string;
  type: 'file' | 'directory' | 'link' | 'other';
  data: Buffer;
}

const NPM_REGISTRY = 'https://registry.npmjs.org/';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BLOCK = 512;

/** Where npm's own registry serves a release's tarball: `https://registry.npmjs.org/<name>/-/<file>-<version>.tgz`. */
export function canonicalTarballUrl(packageName: string, version: string): string {
  return `${NPM_REGISTRY}${packageName}/-/${packageName.split('/').at(-1) ?? packageName}-${version}.tgz`;
}

/** `value` as an absolute `http:` or `https:` address (against `base` when given), without a user or password. */
function httpAddress(value: unknown, base?: string): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.username = '';
  url.password = '';
  return url.href;
}

/**
 * `dist.tarball` of `version` when it is an absolute http(s) URL; otherwise null. A user and password in it are left
 * out: no credential is sent with a tarball request, so a mirror that needs one falls back to npm's address.
 */
export function tarballLocation(packument: Packument, version: string): string | null {
  return httpAddress(packument.versions?.[version]?.dist?.tarball);
}

/**
 * The fetch a tarball is asked with, unless a caller hands in another: Node's own, asking for the bytes as they are
 * stored (`accept-encoding: identity` — otherwise it asks for a compressed transfer and decodes it), with no
 * credential and no cookie.
 */
export const fetchTarball: TarballFetch = (url, init) =>
  fetch(url, { ...init, headers: { 'accept-encoding': 'identity' }, credentials: 'omit' });

type Fetched = { ok: true; bytes: Buffer } | { ok: false; problem: 'download' | 'size' };

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** One location: its redirects followed by hand, at most five, each to http(s); its body counted as it arrives. */
async function fetchOne(ask: TarballFetch, url: string, timeoutMs: number): Promise<Fetched> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await ask(current, { redirect: 'manual', signal });
      if (REDIRECTS.has(response.status)) {
        discard(response);
        const next = httpAddress(response.headers.get('location'), current);
        if (next === null || redirects >= TARBALL_MAX_REDIRECTS) return { ok: false, problem: 'download' };
        current = next;
        continue;
      }
      if (!response.ok) {
        discard(response);
        return { ok: false, problem: 'download' };
      }
      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > TARBALL_MAX_BYTES) {
        discard(response);
        return { ok: false, problem: 'size' };
      }
      if (response.body === null) return { ok: true, bytes: Buffer.alloc(0) };
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > TARBALL_MAX_BYTES) {
          void reader.cancel().catch(() => undefined);
          return { ok: false, problem: 'size' };
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
      return { ok: true, bytes: Buffer.concat(chunks, total) };
    }
  } catch {
    // Unreachable, refused, cut off, or past its time: the signal aborts the request and its body alike.
    return { ok: false, problem: 'download' };
  }
}

/** Of two failed downloads, the one that says more: bytes that came and were not the release's, then too many. */
const RANK: Readonly<Record<'download' | 'size' | 'digest', number>> = { download: 0, size: 1, digest: 2 };

/**
 * The release's tarball: from `location`, then — if that fails in any way — once from npm's canonical address, which
 * is never asked twice. Kept only when its sha512 is the verified one; otherwise the problem that says the most of the
 * two tries.
 *
 * `deadline`, by `Date.now()`, is when the caller stops waiting: a request still going then is cut off, and no address
 * is asked after it (0.26.0 review B). Each address keeps its own `timeoutMs` too.
 */
export async function downloadVerifiedTarball(
  release: TarballRelease,
  location: string | null,
  options: { fetch?: TarballFetch; timeoutMs?: number; deadline?: number } = {},
): Promise<{ ok: true; bytes: Buffer } | { ok: false; problem: 'download' | 'size' | 'digest' }> {
  const ask = options.fetch ?? fetchTarball;
  const timeoutMs = options.timeoutMs ?? TARBALL_TIMEOUT_MS;
  const want = release.sha512.toLowerCase();
  const canonical = canonicalTarballUrl(release.packageName, release.version);
  const first = location === null ? null : httpAddress(location);
  let problem: 'download' | 'size' | 'digest' = 'download';
  for (const place of first === null || first === canonical ? [canonical] : [first, canonical]) {
    const left = options.deadline === undefined ? timeoutMs : Math.min(timeoutMs, options.deadline - Date.now());
    if (!(left > 0)) break;
    const fetched = await fetchOne(ask, place, left);
    let failed: 'download' | 'size' | 'digest';
    if (fetched.ok) {
      if (createHash('sha512').update(fetched.bytes).digest('hex') === want) return fetched;
      failed = 'digest';
    } else failed = fetched.problem;
    if (RANK[failed] > RANK[problem]) problem = failed;
  }
  return { ok: false, problem };
}

// ── The archive ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A header field's text: its bytes up to the first NUL. */
function fieldText(header: Buffer, at: number, width: number): string {
  const raw = header.subarray(at, at + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? width : end).toString('utf8');
}

/** A header's octal number, spaces around it allowed; null for base-256 (the high bit set) or anything not octal. */
function octalField(header: Buffer, at: number, width: number): number | null {
  if (((header[at] as number) & 0x80) !== 0) return null;
  const digits = fieldText(header, at, width).trim();
  if (digits === '') return 0;
  if (!/^[0-7]+$/.test(digits)) return null;
  const value = Number.parseInt(digits, 8);
  return Number.isSafeInteger(value) ? value : null;
}

/** The checksum ustar stores at 148: the header's byte sum, its own eight bytes read as spaces. */
function checksumHolds(header: Buffer): boolean {
  const stored = octalField(header, 148, 8);
  if (stored === null) return false;
  let sum = 0;
  for (let at = 0; at < BLOCK; at += 1) sum += at >= 148 && at < 156 ? 0x20 : (header[at] as number);
  return sum === stored;
}

/** A pax extended header's records, `<length> <key>=<value>\n` each; null when one is not that. */
function paxRecords(data: Buffer): Map<string, string> | null {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    if (data.subarray(at).every((byte) => byte === 0)) break;
    const space = data.indexOf(0x20, at);
    if (space === -1) return null;
    const length = data.subarray(at, space).toString('latin1');
    if (!/^[1-9]\d*$/.test(length)) return null;
    const end = at + Number(length);
    if (end > data.length || end <= space + 1 || data[end - 1] !== 0x0a) return null;
    const record = data.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) return null;
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at = end;
  }
  return records;
}

/**
 * An entry's path below `package/`, POSIX, with any leading `./` gone and empty or `.` segments dropped: `''` for the
 * folder itself. Null for anything outside `package/`, a `..` segment, or a backslash, which no npm pack writes and
 * which some file systems read as a separator.
 */
function belowPackage(name: string): string | null {
  let rest = name;
  while (rest.startsWith('./')) rest = rest.slice(2);
  if (rest.includes('\\')) return null;
  const parts = rest.split('/');
  if (parts[0] !== 'package' || parts.includes('..')) return null;
  return parts
    .slice(1)
    .filter((part) => part !== '' && part !== '.')
    .join('/');
}

function entryType(flag: string): TarballEntry['type'] {
  if (flag === '0' || flag === '\0') return 'file';
  if (flag === '1' || flag === '2') return 'link';
  if (flag === '5') return 'directory';
  return 'other';
}

/**
 * Every entry of a release's archive, in order: gunzipped with `node:zlib`, stopping past 128 MiB, then walked as
 * ustar — 512-byte headers, each checksum checked, to the first all-zero block. A pax `x` header's `path` and `size`,
 * and a GNU `L` long name, apply to the next entry. `package/` itself is not listed.
 */
export function tarballEntries(
  gz: Buffer,
): { ok: true; entries: TarballEntry[] } | { ok: false; problem: 'gzip' | 'archive' } {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: UNPACKED_MAX_BYTES });
  } catch {
    return { ok: false, problem: 'gzip' };
  }
  const broken = { ok: false, problem: 'archive' } as const;
  const entries: TarballEntry[] = [];
  let pax: { path?: string; size?: number } = {};
  let longName: string | undefined;
  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumHolds(header)) return broken;
    const ownSize = octalField(header, 124, 12);
    if (ownSize === null) return broken;
    const flag = String.fromCharCode(header[156] as number);
    const meta = flag === 'x' || flag === 'L' || flag === 'K' || flag === 'g';
    const size = meta ? ownSize : (pax.size ?? ownSize);
    const start = offset + BLOCK;
    if (start + size > tar.length) return broken;
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === 'g') return broken;
    if (flag === 'x') {
      const records = paxRecords(data);
      if (records === null) return broken;
      const path = records.get('path');
      const paxSize = records.get('size');
      if (paxSize !== undefined && !/^\d+$/.test(paxSize)) return broken;
      pax = {
        ...pax,
        ...(path !== undefined ? { path } : {}),
        ...(paxSize !== undefined ? { size: Number(paxSize) } : {}),
      };
      if (pax.size !== undefined && !Number.isSafeInteger(pax.size)) return broken;
      continue;
    }
    if (flag === 'L') {
      const end = data.indexOf(0);
      longName = data.subarray(0, end === -1 ? data.length : end).toString('utf8');
      continue;
    }
    if (flag === 'K') continue;

    // POSIX ustar's magic, `ustar\0`: only then is 345 a prefix (GNU's `ustar ` keeps other fields there).
    const prefix = fieldText(header, 257, 6) === 'ustar' ? fieldText(header, 345, 155) : '';
    const own = fieldText(header, 0, 100);
    const name = pax.path ?? longName ?? (prefix === '' ? own : `${prefix}/${own}`);
    pax = {};
    longName = undefined;
    const path = belowPackage(name);
    const type = entryType(flag);
    if (path === null) return broken;
    if (path === '') {
      if (type === 'directory') continue;
      return broken;
    }
    entries.push({ path, type, data });
  }
  return { ok: true, entries };
}

/**
 * The release's `package/package.json`, as an object: exactly one entry by that name (in any case), a regular file of
 * at most 1 MiB, holding a JSON object. Anything else is `manifest`; an archive that cannot be walked, `archive`.
 */
export function tarballManifest(
  gz: Buffer,
): { ok: true; manifest: Record<string, unknown> } | { ok: false; problem: 'gzip' | 'archive' | 'manifest' } {
  const read = tarballEntries(gz);
  if (!read.ok) return read;
  const none = { ok: false, problem: 'manifest' } as const;
  const named = read.entries.filter((entry) => entry.path.toLowerCase() === 'package.json');
  const [entry] = named;
  if (named.length !== 1 || entry === undefined) return none;
  if (entry.path !== 'package.json' || entry.type !== 'file' || entry.data.length > MANIFEST_MAX_BYTES) return none;
  let manifest: unknown;
  try {
    manifest = JSON.parse(entry.data.toString('utf8').replace(/^﻿/, ''));
  } catch {
    return none;
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return none;
  return { ok: true, manifest: manifest as Record<string, unknown> };
}
