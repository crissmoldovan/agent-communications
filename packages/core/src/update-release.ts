import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { displayUrl } from './mcp-clients.ts';
import { REGISTRY_TIMEOUT_MS, registryUrl } from './npm.ts';
// Types only from update-provenance.ts: what it imports at run time — sigstore-js, lazily — stays out of every module
// that reaches this one, a channel's bundle among them (WhatsApp's no-network test reads that graph).
import type { ProvenanceRelease, ProvenanceVerdict } from './update-provenance.ts';
import { PIN_WORDS } from './update-words.ts';
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

/** The SHA-512 in a subresource-integrity string, as hex; null when it holds none. */
export function sha512Hex(integrity: string): string | null {
  for (const part of integrity.trim().split(/\s+/)) {
    if (!part.startsWith('sha512-')) continue;
    const bytes = Buffer.from(part.slice('sha512-'.length).split('?')[0] ?? '', 'base64');
    if (bytes.length === 64) return bytes.toString('hex');
  }
  return null;
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
 * machine past. Prereleases are left out — no update installs one — and so is anything that is not a version, or that
 * carries build metadata, which no published version does.
 */
export function releasesBetween(packument: Packument, from: string, to: string): string[] {
  return Object.keys(packument.versions ?? {})
    .filter(
      (version) =>
        isVersion(version) &&
        !isPrerelease(version) &&
        !version.includes('+') &&
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

/** The scope every package of this suite is published under, and so attested for. */
const SUITE = '@agentcomms/';

/**
 * Why the runtime at `runtime` is not what was verified, or null when it is (security review of 0.20.0, severity 5).
 *
 * Every package of this suite npm installed in it — `packageName` itself, and any of ours it depends on at any depth,
 * as Gmail depends on core — has to be, by the runtime's own lockfile, a tarball whose provenance verified: the one
 * whose SHA-512 is `sha512` for `packageName`, and for each other either one already verified (`known`, by
 * `package@version`, the SHA-512 it signs) or one `verify` verifies now, against the integrity npm recorded. npm checks
 * each tarball it downloads against the integrity the registry gives it then, and records that; a registry that gave
 * another one to the install than to the check, or a runtime made some other way, is caught here.
 *
 * The packages of others it holds are checked by npm alone, against the registry's integrity: no pin says who builds
 * them (SECURITY.md says so). No package's install script ran (`installManagedRuntime`).
 */
export async function runtimeIntegrityProblem(
  runtime: string,
  packageName: string,
  sha512: string,
  options: { verify?: ReleaseVerifier | null | undefined; known?: Map<string, string> | undefined } = {},
): Promise<string | null> {
  let lock: { packages?: Record<string, { version?: unknown; integrity?: unknown } | undefined> } | null;
  try {
    lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8')) as typeof lock;
  } catch {
    lock = null;
  }
  const own = `node_modules/${packageName}`;
  const integrity = lock?.packages?.[own]?.integrity;
  if (typeof integrity !== 'string') {
    return `what is in ${runtime} cannot be shown to be the tarball whose provenance was verified: its lockfile records no integrity for ${packageName}`;
  }
  if (sha512Hex(integrity) !== sha512) {
    return `what is in ${runtime} is not the tarball whose provenance was verified: its lockfile records another integrity for ${packageName}`;
  }
  const known = options.known ?? new Map<string, string>();
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (key === own) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!key.includes('node_modules/') || !name.startsWith(SUITE)) continue;
    const version = entry?.version;
    const recorded = entry?.integrity;
    if (!isVersion(version) || typeof recorded !== 'string' || sha512Hex(recorded) === null) {
      return `${name}, which ${packageName} in ${runtime} depends on, cannot be shown to be a verified tarball: its lockfile records no version or no SHA-512 integrity for it`;
    }
    const hex = sha512Hex(recorded) as string;
    if (known.get(`${name}@${version}`) === hex) continue;
    if (!options.verify) {
      return `${name}@${version}, which ${packageName} in ${runtime} depends on, cannot be verified here`;
    }
    const verdict = await options.verify({ packageName: name, version, integrity: recorded });
    if (!verdict.ok) {
      return `${name}@${version}, which ${packageName} in ${runtime} depends on, is not a tarball built by this repository's release workflow — ${PIN_WORDS[verdict.field]}`;
    }
    known.set(`${name}@${version}`, hex);
  }
  return null;
}

/** A release since the one installed that says it needs a decision, and whether its provenance verified. */
export interface DecidingRelease {
  version: string;
  verified: boolean;
}

/** What the releases an update takes this machine past declare, as far as each verified. */
export interface DeclaredSince {
  /** The latest says it is a security fix, and verified. */
  security: boolean;
  /** One of them says it needs a decision, and verified. */
  needsDecision: boolean;
  /** Every one that says it needs a decision, oldest first, each with whether it verified. */
  deciding: DecidingRelease[];
}

/**
 * What every release after `from`, up to `latest`, declares (design 2026-10-16 U5, U7; security review of 0.20.0,
 * severity 6): a decision any of them needs — a later release that does not say so again does not end it — and whether
 * `latest` is a security fix. Each declaration acted on is verified first, with `verify`; one that does not verify, or
 * where nothing here can verify (`verify` null: a channel's process, which carries no Sigstore), counts for nothing.
 * `from` null reads `latest` alone. Throws when the registry's document cannot be read.
 */
export async function declaredSince(
  registry: ReleaseRegistry,
  verify: ReleaseVerifier | null,
  packageName: string,
  from: string | null,
  latest: string,
): Promise<DeclaredSince> {
  const { packument } = await registry(packageName);
  const declared = (version: string) => releaseDeclaration(packument.versions?.[version]);
  const range = from === null ? [] : releasesBetween(packument, from, latest);
  const deciding = [...new Set([...range, latest])].filter((version) => declared(version).needsDecision);
  const verified = new Map<string, boolean>();
  const check = async (version: string): Promise<boolean> => {
    const known = verified.get(version);
    if (known !== undefined) return known;
    const integrity = releaseIntegrity(packument, version);
    const ok =
      verify !== null && integrity !== null && (await verify({ packageName, version, integrity }).then((v) => v.ok));
    verified.set(version, ok);
    return ok;
  };
  const decisions: DecidingRelease[] = [];
  for (const version of deciding) decisions.push({ version, verified: await check(version) });
  return {
    security: declared(latest).security && (await check(latest)),
    needsDecision: decisions.some((decision) => decision.verified),
    deciding: decisions,
  };
}
