import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { displayUrl } from './mcp-clients.ts';
import { REGISTRY_TIMEOUT_MS, registryUrl } from './npm.ts';
import { type ProvenanceRelease, type ProvenanceVerdict, sha512Hex } from './update-provenance.ts';
import { compareVersions, isPrerelease, isVersion } from './versions.ts';

/**
 * What an update reads of a release on the registry, and what it may say of it (design 2026-10-16 U5, U7, U9): the
 * package's full document, the releases between two versions, what a release's core manifest declares, and the fixed
 * words for a provenance pin that failed.
 *
 * Everything the registry says is data. Nothing here returns a string the registry wrote: a declaration is read as
 * flags, a version only once it is one, and a refusal is said by the pin that failed, never by the value it found.
 *
 * Light on purpose: no Sigstore here. Every channel's bundle carries the daily check, which reads this; verifying is
 * handed in (`ReleaseVerifier`), by core, which carries sigstore-js.
 */

/** What an update reads of a package's document on the registry: its tags, its versions' manifests, when each came out. */
export interface Packument {
  'dist-tags'?: Record<string, unknown> | undefined;
  versions?: Record<string, { agentcommsRelease?: unknown; dist?: { integrity?: unknown } } | undefined> | undefined;
  time?: Record<string, unknown> | undefined;
}

/** A package's document, and when the registry served it (its `Date`), when it said. */
export interface RegistryAnswer {
  packument: Packument;
  servedAt?: Date | undefined;
}

export type ReleaseRegistry = (packageName: string) => Promise<RegistryAnswer>;

/**
 * Verifies one release's provenance against the pins (`update-provenance.ts`): handed in where Sigstore can be loaded —
 * core's CLI and server — and nowhere else.
 */
export type ReleaseVerifier = (release: ProvenanceRelease) => Promise<ProvenanceVerdict>;

/**
 * The registry npm itself reads, asked for a package's full document — the one that says when each version came out.
 * A mirror's address with a user and password in it means basic authentication, as `npmLatestVersion` sends it. It
 * fails rather than guesses, naming the registry by its host only.
 */
export function npmRegistry(env: NodeJS.ProcessEnv): ReleaseRegistry {
  return async (packageName) => {
    const base = registryUrl(env);
    const where = displayUrl(base) ?? 'the npm registry';
    const url = new URL(packageName.replace('/', '%2f'), base);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (url.username || url.password) {
      const user = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      headers.authorization = `Basic ${Buffer.from(user).toString('base64')}`;
      url.username = '';
      url.password = '';
    }
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    } catch {
      throw new Error(`${where} could not be reached`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${where} answered ${response.status} for ${packageName}`);
    }
    let packument: Packument;
    try {
      packument = (await response.json()) as Packument;
    } catch {
      throw new Error(`${where} answered something that is not JSON for ${packageName}`);
    }
    const date = Date.parse(response.headers.get('date') ?? '');
    return { packument, ...(Number.isFinite(date) ? { servedAt: new Date(date) } : {}) };
  };
}

/** The tarball integrity the registry gives for one version, or null when it gives none. */
export function releaseIntegrity(packument: Packument, version: string): string | null {
  const integrity = packument.versions?.[version]?.dist?.integrity;
  return typeof integrity === 'string' && integrity.trim() !== '' ? integrity : null;
}

/**
 * What a release's core manifest declares under `agentcommsRelease` (U5): a security fix, and a decision it needs from
 * the person — as flags only. The decision's own words are never read out: they are the registry's, and an update says
 * that one is needed in its own words. A declaration this release cannot read waits for the person: it may be the
 * decision it cannot see.
 */
export function releaseDeclaration(manifest: { agentcommsRelease?: unknown } | undefined): {
  security: boolean;
  needsDecision: boolean;
} {
  const declared = manifest?.agentcommsRelease;
  if (declared === undefined || declared === null) return { security: false, needsDecision: false };
  if (typeof declared !== 'object' || Array.isArray(declared)) return { security: false, needsDecision: true };
  const { security, needsDecision } = declared as Record<string, unknown>;
  return {
    security: security === true,
    needsDecision: !(needsDecision === undefined || needsDecision === null || needsDecision === false),
  };
}

/**
 * Every release the registry lists after `from`, up to and including `to`, oldest first: what an update takes this
 * machine past. Prereleases are left out — no update installs one — and so is anything that is not a version.
 */
export function releasesBetween(packument: Packument, from: string, to: string): string[] {
  return Object.keys(packument.versions ?? {})
    .filter(
      (version) =>
        isVersion(version) &&
        !isPrerelease(version) &&
        (compareVersions(version, from) ?? 0) > 0 &&
        (compareVersions(version, to) ?? 1) <= 0,
    )
    .sort((a, b) => compareVersions(a, b) ?? 0);
}

/** A version's major number: what an update never crosses on its own. */
export function majorOf(version: string): string {
  return version.split('.')[0] ?? version;
}

/** The oldest of `versions` that are versions, or null. */
export function oldestVersion(versions: readonly (string | null | undefined)[]): string | null {
  return versions.reduce<string | null>(
    (oldest, version) =>
      isVersion(version) && (oldest === null || (compareVersions(version, oldest) ?? 0) < 0) ? version : oldest,
    null,
  );
}

export { PIN_WORDS } from './update-words.ts';

/** What a release that verified was built by, in one phrase: the preview's and the dry run's words. */
export const BUILT_BY =
  "this repository's release workflow (.github/workflows/release.yml) at the tag of its version, on a GitHub-hosted runner, as its Sigstore provenance shows";

/**
 * Why the runtime at `runtime` is not the release whose provenance was verified, or null when it is: the integrity npm
 * recorded for `packageName` in the runtime's own lockfile has to be the very SHA-512 the attestation signs. npm checks
 * the tarball it downloads against the integrity the registry gives it then, and records that; a registry that gave
 * another one to the install than to the check, or a runtime made some other way, is caught here.
 */
export async function runtimeIntegrityProblem(
  runtime: string,
  packageName: string,
  sha512: string,
): Promise<string | null> {
  let lock: { packages?: Record<string, { integrity?: unknown } | undefined> } | null;
  try {
    lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8')) as typeof lock;
  } catch {
    lock = null;
  }
  const integrity = lock?.packages?.[`node_modules/${packageName}`]?.integrity;
  if (typeof integrity !== 'string') {
    return `what is in ${runtime} cannot be shown to be the tarball whose provenance was verified: its lockfile records no integrity for ${packageName}`;
  }
  return sha512Hex(integrity) === sha512
    ? null
    : `what is in ${runtime} is not the tarball whose provenance was verified: its lockfile records another integrity for ${packageName}`;
}
