import { readVerifiedDeclaration } from './release-declarations.ts';
import { type TarballFetch, tarballLocation } from './release-tarball.ts';
import { type ReleaseRegistry, type ReleaseVerifier, releaseIntegrity, releasesBetween } from './update-release.ts';
import type { ReleaseFacts } from './update-state.ts';

/**
 * What the releases an update takes this machine past declare, believed only from their verified tarballs (design
 * 2026-10-22 P1, P2): for the daily check's record, `update --check`, and the by-hand update's preview.
 *
 * The registry's document is read once, for which releases there are, the integrity of each, and where each tarball
 * is — never for what one declares: a registry or a mirror can add or remove either flag on a genuine release. Each
 * release is verified, and then its declaration read (`readVerifiedDeclaration`) from the bytes whose sha512 its
 * verified provenance signs. One that does not verify, that the registry gives no integrity for, or whose tarball
 * cannot be read is *unread*, and counts for nothing either way: neither a security fix nor its absence, neither a
 * decision nor none.
 *
 * Only core reads these, since only core carries the verifier: a channel's process reads none (`releaseFactsReader`).
 * No Sigstore here, and nothing runs when this module is loaded: WhatsApp's bundle, which reaches the module that
 * imports this one, drops it.
 */

/** Where releases' documents, verdicts and tarballs come from, and the state folder the declarations are cached in. */
export interface DeclarationSources {
  registry: ReleaseRegistry;
  verify: ReleaseVerifier;
  stateDir: string;
  tarballs?: TarballFetch | undefined;
}

export interface DeclaredSince {
  /** The latest's, from its verified tarball; null when it could not be read. */
  security: boolean | null;
  /** True when any release read says so; false when every one was read and none does; null otherwise. */
  needsDecision: boolean | null;
  /** The releases read that say they need a decision, oldest first. */
  deciding: string[];
  /** The releases whose declaration could not be read, oldest first: unverified, no integrity, or unknown. */
  unread: string[];
}

/**
 * Every release after `from` up to `latest` (`latest` alone when `from` is null), each verified and its declaration
 * read: a decision any of them needs — a later release that does not say so again does not end it — and whether
 * `latest` is a security fix. Throws when the packument cannot be read.
 */
export async function declaredSince(
  sources: DeclarationSources,
  packageName: string,
  from: string | null,
  latest: string,
): Promise<DeclaredSince> {
  const { packument } = await sources.registry(packageName);
  const range = from === null ? [] : releasesBetween(packument, from, latest);
  const versions = [...new Set([...range, latest])];
  const deciding: string[] = [];
  const unread: string[] = [];
  let security: boolean | null = null;
  for (const version of versions) {
    const integrity = releaseIntegrity(packument, version);
    const verdict = integrity === null ? null : await sources.verify({ packageName, version, integrity });
    // The digest the bytes must have is the one the verified attestation signs, never the registry's word for it.
    const provenance = verdict?.ok === true ? verdict.provenance : null;
    if (provenance === null) {
      unread.push(version);
      continue;
    }
    const read = await readVerifiedDeclaration(provenance, tarballLocation(packument, version), {
      stateDir: sources.stateDir,
      ...(sources.tarballs !== undefined ? { fetch: sources.tarballs } : {}),
    });
    if (!read.known) {
      unread.push(version);
      continue;
    }
    if (read.needsDecision) deciding.push(version);
    if (version === latest) security = read.security;
  }
  return {
    security,
    needsDecision: deciding.length > 0 ? true : unread.length === 0 ? false : null,
    deciding,
    unread,
  };
}

/** The record's facts: null unless both `security` and `needsDecision` are known. */
export function factsOf(version: string, declared: DeclaredSince): ReleaseFacts | null {
  const { security, needsDecision } = declared;
  return security === null || needsDecision === null ? null : { version, security, needsDecision };
}
