import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CommsError } from './errors.ts';
import { displayUrl } from './mcp-clients.ts';
import { REGISTRY_TIMEOUT_MS, registryUrl } from './npm.ts';
// Types only from update-provenance.ts: what it imports at run time — sigstore-js, lazily — stays out of every module
// that reaches this one, a channel's bundle among them (WhatsApp's no-network test reads that graph).
import type { ProvenanceRelease, ProvenanceVerdict, VerifiedProvenance } from './update-provenance.ts';
import { PIN_WORDS } from './update-words.ts';
import { compareVersions, isPlainVersion, isVersion } from './versions.ts';

/**
 * What an update reads of a release on the registry, and what it may say of it (design 2026-10-16 U5, U7, U9): the
 * package's full document, what a release's core manifest declares, and the fixed words for a provenance pin that
 * failed. Which releases the document lists decides nothing (design 2026-10-22 §8.1): a needed decision is carried in
 * the release an update goes to.
 *
 * Everything the registry says is data. Nothing here returns a string the registry wrote: a declaration is read as
 * flags, a version only once it is one, and a refusal is said by the pin that failed, never by the value it found.
 *
 * Light on purpose: no Sigstore here. Every channel's bundle carries the daily check, which reads this; verifying is
 * handed in (`ReleaseVerifier`), by core, which carries sigstore-js.
 */

/**
 * What an update reads of a package's document on the registry: its tags, its versions' manifests, when each came out,
 * and where each version's tarball is (`dist.tarball`, read by `tarballLocation` in `release-tarball.ts`).
 */
export interface Packument {
  'dist-tags'?: Record<string, unknown> | undefined;
  versions?:
    | Record<string, { agentcommsRelease?: unknown; dist?: { integrity?: unknown; tarball?: unknown } } | undefined>
    | undefined;
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

/** What a release's core manifest declares under `agentcommsRelease`, as flags and a version, never words. */
export interface ReleaseFlags {
  security: boolean;
  needsDecision: boolean;
  /**
   * The newest release, up to and including this one, that declared `needsDecision` (design 2026-10-22 §8.1), carried
   * forward from release to release by the release check: so a decision any release before this one needs is found
   * in this release's own verified tarball, never by listing the releases the registry says there are. Null when it
   * carries none: no release up to it declared one. Always a plain `X.Y.Z`.
   */
  needsDecisionSince: string | null;
}

/**
 * What a release's core manifest declares under `agentcommsRelease` (U5, design 2026-10-22 §8.1): a security fix, a
 * decision it needs from the person, and the newest release up to it that needed one — as flags and a plain version
 * only. The manifest is the one in the release's verified tarball (`release-declarations.ts`, design 2026-10-22 P1),
 * never the registry's copy. The decision's own words are never read out: an update says that one is needed in its own
 * words. A declaration this release cannot read waits for the person, as it may be the decision it cannot see: a field
 * that is not an object, a `needsDecision` that is not false, or a `needsDecisionSince` that is not a plain version.
 */
export function releaseDeclaration(manifest: { agentcommsRelease?: unknown } | undefined): ReleaseFlags {
  const declared = manifest?.agentcommsRelease;
  if (declared === undefined || declared === null) {
    return { security: false, needsDecision: false, needsDecisionSince: null };
  }
  if (typeof declared !== 'object' || Array.isArray(declared)) {
    return { security: false, needsDecision: true, needsDecisionSince: null };
  }
  const { security, needsDecision, needsDecisionSince } = declared as Record<string, unknown>;
  const since = isPlainVersion(needsDecisionSince) ? needsDecisionSince : null;
  const unreadable = needsDecisionSince !== undefined && since === null;
  return {
    security: security === true,
    needsDecision: unreadable || !(needsDecision === undefined || needsDecision === null || needsDecision === false),
    needsDecisionSince: since,
  };
}

/**
 * The release a machine running `from` must decide on before it runs `declared` (design 2026-10-22 §8.1), or null when
 * there is none: `declared` itself when it declares `needsDecision`; otherwise the release its `needsDecisionSince`
 * names, when that is after `from` — a decision this machine has not taken. One at or before `from` was taken when
 * that release was installed. Nothing else counts: no release the registry lists, hidden or added, decides anything.
 * A `from` that is not known, or not a version, cannot be shown to be past it, so it waits; a `since` after
 * `declared`, which no release check lets through, is said as `declared`.
 */
export function decisionNeeded(
  declared: Pick<ReleaseFlags, 'needsDecision' | 'needsDecisionSince'> & { version: string },
  from: string | null,
): string | null {
  if (declared.needsDecision) return declared.version;
  const since = declared.needsDecisionSince;
  if (since === null) return null;
  if (from !== null && (compareVersions(since, from) ?? 1) <= 0) return null;
  return (compareVersions(since, declared.version) ?? 1) > 0 ? declared.version : since;
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
    if (!isPlainVersion(version) || typeof recorded !== 'string' || sha512Hex(recorded) === null) {
      return `${name}, which ${packageName} in ${runtime} depends on, cannot be shown to be a verified tarball: its lockfile records no plain release version or no SHA-512 integrity for it`;
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

/**
 * Where releases' documents are read and verified, for an update or a first install: the registry, the verifier its
 * caller handed in — core's CLI and server hand in one with npm's attestations and sigstore-js — and, where either is
 * missing, why nothing can be verified. Null where there is none: then every release is refused, and nothing reaches
 * the network.
 */
export interface ReleaseSources {
  registry: ReleaseRegistry | null;
  verify: ReleaseVerifier | null;
  why: string;
}

/** What is refused for want of provenance: what an update or a first install does, in its preview's first word. */
export type VerifiedAct = 'update' | 'install';

/**
 * The refusal of a whole update or install for one release that did not verify: which, and which pin — never what it
 * held. `hint` replaces the general one where there is more to say: where it can be verified, for a process that
 * cannot.
 */
export function unverifiedRelease(
  packageName: string,
  version: string,
  why: string,
  pin: string,
  act: VerifiedAct = 'update',
  hint?: string,
): CommsError {
  const which = act === 'update' ? 'An update installs' : 'An install fetches';
  // A release named only by its plain version: anything else is the registry's text, and is not repeated.
  const plain = isPlainVersion(version);
  const named = plain ? `${packageName}@${version}` : `${packageName} at a version that is not a plain release`;
  return new CommsError(
    'BAD_DATA',
    `nothing was installed or changed: ${named} could not be verified as built by this repository's release workflow — ${why}`,
    {
      hint:
        hint ??
        `${which} only a release whose Sigstore provenance shows it was built by this repository's release workflow at the tag of its version, on a GitHub-hosted runner, and nothing skips that check. Nothing was prepared to approve. A release published minutes ago can be without its attestation for a while: try again later. If it still does not verify, do not install it some other way; report it as SECURITY.md says.`,
      details: { package: packageName, ...(plain ? { version } : {}), pin },
    },
  );
}

/**
 * Verifies every release in `wanted` — its tarball's integrity as the registry gives it, and npm's attestation for it,
 * held to the pins the background run holds a release to (design 2026-10-16 U5 step 3). The first that does not verify
 * refuses the whole update or install (`unverifiedRelease`); what verified is returned by package, for the preview
 * and for the integrity check after install. Reads; changes nothing. With no registry or no verifier, the first
 * release is refused before anything is asked.
 */
export async function verifyReleaseSet(
  sources: ReleaseSources,
  wanted: ReadonlyMap<string, string>,
  act: VerifiedAct = 'update',
  noVerifierHint?: string,
): Promise<Map<string, VerifiedProvenance>> {
  const verified = new Map<string, VerifiedProvenance>();
  if (wanted.size === 0) return verified;
  const { registry, verify, why } = sources;
  for (const [packageName, version] of [...wanted].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!isPlainVersion(version)) {
      throw unverifiedRelease(packageName, version, 'it is not a plain release (MAJOR.MINOR.PATCH)', 'version', act);
    }
    if (registry === null || verify === null) {
      throw unverifiedRelease(packageName, version, why, 'verifier', act, noVerifierHint);
    }
    let integrity: string | null;
    try {
      integrity = releaseIntegrity((await registry(packageName)).packument, version);
    } catch (error) {
      throw new CommsError(
        'PROVIDER_UNAVAILABLE',
        `nothing was installed or changed: the registry's document of ${packageName} could not be read to verify ${version}: ${error instanceof Error ? error.message : String(error)}`,
        { hint: 'Try again once the registry can be reached.' },
      );
    }
    if (integrity === null) {
      throw unverifiedRelease(packageName, version, 'the registry gives no tarball integrity for it', 'subject', act);
    }
    const verdict = await verify({ packageName, version, integrity });
    if (!verdict.ok) throw unverifiedRelease(packageName, version, PIN_WORDS[verdict.field], verdict.field, act);
    verified.set(packageName, verdict.provenance);
  }
  return verified;
}
