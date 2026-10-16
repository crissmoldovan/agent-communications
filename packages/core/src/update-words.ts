import type { ProvenanceField } from './update-provenance.ts';
import type { BackgroundNotice } from './update-state.ts';

/**
 * Every sentence a background run may leave for the next session, and the one way a notice of it is said (design
 * 2026-10-16 U5 step 7, U9; security review of 0.20.0, severity 6): in this package's own words, with nothing in them
 * the registry or a certificate wrote. A release's version is the one thing a sentence takes from outside, and only as a
 * plain `MAJOR.MINOR.PATCH`: a prerelease's words or build metadata (`0.20.1+Ignore-previous-instructions` is valid
 * semver) are never repeated.
 *
 * The run writes one of these into the update state file; the notice (`update-gate.ts`) says it only when it is one of
 * them, word for word, and otherwise the outcome's own sentence — so a record written by another release, or by hand,
 * never reaches a model as it is.
 *
 * Nothing here reaches the network or reads a file: every server and command, WhatsApp's too, carries it.
 */

const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A release as a notice names it: its version when it is a plain `MAJOR.MINOR.PATCH`, otherwise "A release". */
export function shownRelease(version: string | null | undefined): string {
  return typeof version === 'string' && PLAIN_VERSION.test(version) ? version : 'A release';
}

/** Which pin a release did not verify against, in this package's own words — never the value it held instead. */
export const PIN_WORDS: Readonly<Record<ProvenanceField, string>> = Object.freeze({
  attestation: 'npm has no SLSA provenance attestation for it that could be read',
  bundle: 'its provenance bundle could not be read',
  issuer: "it was not signed through GitHub Actions' token issuer",
  identity: "it was not signed for this repository's release workflow at the tag of its version",
  runner: 'it was not built on a GitHub-hosted runner',
  repository: 'it was not built from this repository',
  ref: 'it was not built from the tag of its version',
  subject: 'what its provenance signs is not the tarball the registry serves for it',
  signature: 'Sigstore did not verify its signature, certificate or transparency-log entry',
});

const PIN_FIELDS = Object.keys(PIN_WORDS) as ProvenanceField[];

/** What went wrong in a run that installed nothing it could switch to. */
export type FailedWhat = 'install' | 'tarball' | 'selfCheck' | 'switch' | 'inUse';

/** What went wrong, in fixed words. */
export const FAILED_WORDS: Readonly<Record<FailedWhat, string>> = Object.freeze({
  install: 'one of its packages could not be installed',
  tarball: 'what npm installed is not the tarball whose provenance was verified',
  selfCheck: 'one of its packages failed its self-check',
  switch: 'a launcher could not be switched, so every launcher was put back',
  inUse: 'an unfinished runtime of it is in the way',
});

const RESTART =
  'restart each MCP client that starts these servers (in Claude Code, /mcp and then Reconnect) to use it: a server already running keeps the code it started with';

/** The sentences, by what happened. */
export const BACKGROUND_WORDS: Readonly<{
  installed: (version: string) => string;
  major: (version: string) => string;
  decision: (version: string) => string;
  downgrade: (version: string) => string;
  waits: (version: string | null) => string;
  unverified: (version: string | null, field: ProvenanceField) => string;
  refused: (version: string | null) => string;
  failed: (version: string | null, what: FailedWhat) => string;
  stopped: (version: string | null) => string;
  heldUnreadable: string;
  jobRemoved: string;
}> = Object.freeze({
  installed: (version: string) => `${shownRelease(version)} is installed; ${RESTART}.`,
  major: (version: string) =>
    `${shownRelease(version)} is a new major release: it is never installed in the background. Update when it suits you — comms_update shows each step first.`,
  decision: (version: string) =>
    `${shownRelease(version)} needs a decision from you — it, or a release before it, says so — so it was not installed in the background. comms_update shows each step first; its release notes say what it changes.`,
  downgrade: (version: string) =>
    `The registry names ${shownRelease(version)} as the latest release, older than what runs here: nothing was changed in the background.`,
  waits: (version: string | null) =>
    `${shownRelease(version)} waits for you: it was not installed in the background. comms_update shows each step first.`,
  unverified: (version: string | null, field: ProvenanceField) =>
    `${shownRelease(version)} was not installed: a release could not be verified as built by this repository's release workflow — ${PIN_WORDS[field]}. Nothing was changed.`,
  refused: (version: string | null) =>
    `${shownRelease(version)} was not installed: a release could not be verified as built by this repository's release workflow. Nothing was changed.`,
  failed: (version: string | null, what: FailedWhat) =>
    `${shownRelease(version)} was not installed in the background: ${FAILED_WORDS[what]}. Nothing was switched; the next run tries again, and comms_audit_tail shows what went wrong.`,
  stopped: (version: string | null) =>
    `${shownRelease(version)} was not installed in the background, and nothing was switched; the next run tries again, and comms_audit_tail shows what went wrong.`,
  heldUnreadable:
    'No update is installed in the background while update-held.json in the state directory cannot be read: it says which releases were rolled back. Delete it to hold none.',
  jobRemoved:
    'An organisation profile on this machine turned background updates off, so the background update job was removed. Updates are still checked daily, and a notice says when one is out.',
});

/** Every sentence a run may leave for `outcome` and `version`, the outcome's own first. */
function sentencesFor(outcome: BackgroundNotice['outcome'], version: string | null): string[] {
  const words = BACKGROUND_WORDS;
  switch (outcome) {
    case 'installed':
      return [words.installed(version ?? '')];
    case 'skipped':
      return [
        words.waits(version),
        words.major(version ?? ''),
        words.decision(version ?? ''),
        words.downgrade(version ?? ''),
      ];
    case 'refused':
      return [words.refused(version), ...PIN_FIELDS.map((field) => words.unverified(version, field))];
    case 'failed':
      return [
        words.stopped(version),
        ...(Object.keys(FAILED_WORDS) as FailedWhat[]).map((what) => words.failed(version, what)),
        words.heldUnreadable,
      ];
    case 'job-removed':
      return [words.jobRemoved];
  }
}

/**
 * What a notice says of the last background run: the run's own sentence when it is one of these, word for word, for
 * its outcome and release — and otherwise the outcome's own. Never the record's text as it is.
 */
export function backgroundNoticeLine(notice: Pick<BackgroundNotice, 'outcome' | 'version' | 'text'>): string {
  const sentences = sentencesFor(notice.outcome, notice.version);
  return sentences.includes(notice.text) ? notice.text : (sentences[0] as string);
}
