import { readVerifiedDeclaration } from './release-declarations.ts';
import { type TarballFetch, tarballLocation } from './release-tarball.ts';
import {
  decisionNeeded,
  type ReleaseFlags,
  type ReleaseRegistry,
  type ReleaseVerifier,
  releaseIntegrity,
} from './update-release.ts';
import type { ReleaseFacts } from './update-state.ts';

/**
 * What the release an update goes to declares, believed only from its verified tarball (design 2026-10-22 P1, P2,
 * §8.1): for the daily check's record, `update --check`, and the by-hand update's preview.
 *
 * Only that one release is read. A needed decision is carried forward from release to release in core's
 * `agentcommsRelease.needsDecisionSince`, which the release check holds to the changelog, so the release an update goes
 * to says itself whether a release on the way needed one: which versions the registry lists decides nothing. A registry
 * or mirror that leaves out the release needing a decision, adds an unverifiable one, or lists five hundred, changes no
 * fact and costs no request.
 *
 * The registry's document is read once, for that release's integrity and where its tarball is — never for what it
 * declares: a registry or a mirror can add or remove either flag on a genuine release. The release is verified, and
 * then its declaration read (`readVerifiedDeclaration`) from the bytes whose sha512 its verified provenance signs. One
 * that does not verify, that the registry gives no integrity for, whose tarball cannot be read, or whose read is cut off
 * by its deadline is *unknown*, and counts for nothing either way: neither a security fix nor its absence, neither a
 * decision nor none.
 *
 * Only core reads these, since only core carries the verifier: a channel's process reads none (`releaseFactsReader`).
 * No Sigstore here, and nothing runs when this module is loaded: WhatsApp's bundle, which reaches the module that
 * imports this one, drops it.
 */

/**
 * How long a check gives its target's declaration — its document, its verification and its tarball, from both places —
 * before it counts it unknown (review B of 0.26.0, finding 2). A check runs under a claim of `UPDATE_CHECK_LEASE_MS`,
 * two minutes, which also holds the registry's ten seconds for `latest`, `npm ls`'s minute and up to 15 seconds for
 * the record's lock: 30 seconds beside them still records inside the lease, where a tarball's two tries of a minute
 * each did not, and the check's finding was dropped as superseded.
 */
export const DECLARATION_DEADLINE_MS: number = 30_000;

/** Where a release's document, verdict and tarball come from, and the state folder the declarations are cached in. */
export interface DeclarationSources {
  registry: ReleaseRegistry;
  verify: ReleaseVerifier;
  stateDir: string;
  tarballs?: TarballFetch | undefined;
}

/** What one release declares, from its verified tarball; unknown when it could not be read. */
export type TargetDeclaration = ({ known: true; version: string } & ReleaseFlags) | { known: false; version: string };

/**
 * What `version` declares, read from its verified tarball, and nothing of any other release. Unknown when the
 * registry's document cannot be read or gives no integrity for it, when it does not verify, when its tarball cannot be
 * read, or when `signal` ends the read first. Never throws.
 */
export async function targetDeclaration(
  sources: DeclarationSources,
  packageName: string,
  version: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<TargetDeclaration> {
  const unknown = { known: false, version } as const;
  try {
    const { packument } = await sources.registry(packageName);
    const integrity = releaseIntegrity(packument, version);
    if (integrity === null || options.signal?.aborted) return unknown;
    const verdict = await sources.verify({ packageName, version, integrity });
    // The digest the bytes must have is the one the verified attestation signs, never the registry's word for it.
    if (!verdict.ok || options.signal?.aborted) return unknown;
    const read = await readVerifiedDeclaration(verdict.provenance, tarballLocation(packument, version), {
      stateDir: sources.stateDir,
      ...(sources.tarballs !== undefined ? { fetch: sources.tarballs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (!read.known) return unknown;
    const { security, needsDecision, needsDecisionSince } = read;
    return { known: true, version, security, needsDecision, needsDecisionSince };
  } catch {
    return unknown;
  }
}

/**
 * `read`, given `deadlineMs` at most: unknown once that has passed, and the read cut off then — never a guess of
 * `false`. The timer is cleared as soon as the read is done.
 */
export async function withinDeadline(
  read: (signal: AbortSignal) => Promise<TargetDeclaration>,
  version: string,
  deadlineMs: number = DECLARATION_DEADLINE_MS,
): Promise<TargetDeclaration> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<TargetDeclaration>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ known: false, version });
    }, deadlineMs);
  });
  try {
    return await Promise.race([read(controller.signal), passed]);
  } finally {
    clearTimeout(timer);
  }
}

/** What an update from `from` to the release `declared` describes: its flags for this machine, or what is unknown. */
export interface DeclaredFor {
  /** The release's own; null when its declaration could not be read. */
  security: boolean | null;
  /** Whether this machine must decide before it runs the release; null when its declaration could not be read. */
  needsDecision: boolean | null;
  /** The release that needs the decision — the target, or the one it carries — or null. */
  deciding: string | null;
  /** Whether the target's declaration could not be read. */
  unread: boolean;
}

/**
 * What the release declares for a machine whose oldest release is `from` (design 2026-10-22 §8.1): its own security
 * flag, and a decision when it declares one or carries one after `from` (`decisionNeeded`).
 */
export function declaredFor(declared: TargetDeclaration, from: string | null): DeclaredFor {
  if (!declared.known) return { security: null, needsDecision: null, deciding: null, unread: true };
  const deciding = decisionNeeded(declared, from);
  return { security: declared.security, needsDecision: deciding !== null, deciding, unread: false };
}

/** The record's facts for `version`: null unless its declaration was read. */
export function factsOf(version: string, declared: DeclaredFor): ReleaseFacts | null {
  const { security, needsDecision } = declared;
  return security === null || needsDecision === null ? null : { version, security, needsDecision };
}
