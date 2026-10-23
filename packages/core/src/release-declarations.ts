import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';
import { downloadVerifiedTarball, type TarballFetch, type TarballProblem, tarballManifest } from './release-tarball.ts';
// Types only: sigstore-js stays out of whatever reaches this module. The provenance is verified by the caller.
import type { VerifiedProvenance } from './update-provenance.ts';
import { releaseDeclaration } from './update-release.ts';
import { isPlainVersion, isVersion } from './versions.ts';

/**
 * What a release declares — a security fix, a decision it needs from the person — read from its verified tarball, and
 * never from the registry (design 2026-10-22 P1). The registry's copy of a manifest is the registry's word: a mirror
 * could add or remove either flag on a genuine release. The tarball whose sha512 is the verified provenance digest is
 * the release's own.
 *
 * What was read is kept per integrity, content-free — the version, the integrity, the two flags and the release a
 * needed decision is carried from (design 2026-10-22 §8.1), never a word of the manifest — in
 * `<state>/release-declarations.json`, so neither the daily check nor the background run downloads a release it read.
 * A declaration that cannot be read is unknown: it is never cached, so the next check or run tries it again, and the
 * caller fails closed. The cache saves downloads, not verification: the caller verifies the release first, every time.
 */

export const DECLARATIONS_FILE = 'release-declarations.json';
const LOCK_FILE = '.release-declarations.lock';
/** How many declarations are kept, the newest last. */
const KEPT = 64;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** One release's declaration, as the cache keeps it. */
export interface DeclarationRecord {
  version: string;
  integrity: string;
  security: boolean;
  needsDecision: boolean;
  /** The newest release up to this one that declared `needsDecision`, as it carries it; null for none. */
  needsDecisionSince: string | null;
}

export type DeclarationRead =
  | {
      known: true;
      version: string;
      security: boolean;
      needsDecision: boolean;
      needsDecisionSince: string | null;
      from: 'cache' | 'tarball';
    }
  | { known: false; version: string; problem: TarballProblem };

export function declarationsPath(stateDir: string): string {
  return join(stateDir, DECLARATIONS_FILE);
}

/**
 * A record as the cache keeps it, or null for anything else: only these five keys, each of its type. One without
 * `needsDecisionSince`, as a build before it was carried wrote, is no record: it costs a download, never a decision.
 */
function recordOf(value: unknown): DeclarationRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { version, integrity, security, needsDecision, needsDecisionSince } = value as Record<string, unknown>;
  if (!isVersion(version) || typeof integrity !== 'string' || !INTEGRITY.test(integrity)) return null;
  if (typeof security !== 'boolean' || typeof needsDecision !== 'boolean') return null;
  if (needsDecisionSince !== null && !isPlainVersion(needsDecisionSince)) return null;
  return { version, integrity, security, needsDecision, needsDecisionSince };
}

/** The cache's records; a file that is missing or cannot be read counts as empty. */
async function readCache(stateDir: string): Promise<DeclarationRecord[]> {
  try {
    const held = JSON.parse(await readFile(declarationsPath(stateDir), 'utf8')) as { declarations?: unknown } | null;
    const listed = held?.declarations;
    if (!Array.isArray(listed)) return [];
    return listed.map(recordOf).filter((record): record is DeclarationRecord => record !== null);
  } catch {
    return [];
  }
}

/**
 * Adds one record, under the cache's lock, to the file as it is then — so two processes reading at once each keep
 * the other's — keeping the newest 64. Best effort: a write that fails changes no answer, and costs a download later.
 */
async function remember(stateDir: string, record: DeclarationRecord): Promise<void> {
  try {
    await withFileLock(join(stateDir, LOCK_FILE), async () => {
      const others = (await readCache(stateDir)).filter(
        (one) => one.integrity !== record.integrity || one.version !== record.version,
      );
      const declarations = [...others, record].slice(-KEPT);
      await writeFileAtomic(declarationsPath(stateDir), `${JSON.stringify({ declarations }, null, 2)}\n`);
    });
  } catch {
    // The answer stands; the next read downloads it again.
  }
}

/**
 * What a verified release declares: from the cache, by its integrity and version, or else from its tarball — the bytes
 * whose sha512 is `provenance.sha512`, from `location` or npm's canonical address — whose `package/package.json` must
 * name the release itself. Unknown, with the problem, when it cannot be read, or when `signal` ends the read first. A
 * known declaration is cached unless `writeCache` is false (a dry run); an unknown one never is.
 */
export async function readVerifiedDeclaration(
  provenance: Pick<VerifiedProvenance, 'package' | 'version' | 'sha512'>,
  location: string | null,
  options: { stateDir: string; fetch?: TarballFetch; writeCache?: boolean; timeoutMs?: number; signal?: AbortSignal },
): Promise<DeclarationRead> {
  const { version } = provenance;
  const integrity = `sha512-${Buffer.from(provenance.sha512, 'hex').toString('base64')}`;
  const hit = (await readCache(options.stateDir)).find(
    (record) => record.integrity === integrity && record.version === version,
  );
  if (hit !== undefined) {
    const { security, needsDecision, needsDecisionSince } = hit;
    return { known: true, version, security, needsDecision, needsDecisionSince, from: 'cache' };
  }
  const download = await downloadVerifiedTarball(
    { packageName: provenance.package, version, sha512: provenance.sha512 },
    location,
    {
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
  if (!download.ok) return { known: false, version, problem: download.problem };
  const read = tarballManifest(download.bytes);
  if (!read.ok) return { known: false, version, problem: read.problem };
  if (read.manifest.name !== provenance.package || read.manifest.version !== version) {
    return { known: false, version, problem: 'identity' };
  }
  const { security, needsDecision, needsDecisionSince } = releaseDeclaration(read.manifest);
  if (options.writeCache !== false) {
    await remember(options.stateDir, { version, integrity, security, needsDecision, needsDecisionSince });
  }
  return { known: true, version, security, needsDecision, needsDecisionSince, from: 'tarball' };
}
