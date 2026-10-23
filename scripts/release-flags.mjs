#!/usr/bin/env node
/**
 * What a release declares must be what its changelog says (update provenance, hardened, P1).
 *
 * Core may declare a release a security fix, one that needs a decision before it installs, or both, with
 * `"agentcommsRelease": { "security": true, "needsDecision": true }` (either key alone, or both) in
 * `packages/core/package.json`. `scripts/channels.mjs` refuses any other shape and reads it as `releaseFlags`. An update
 * believes those flags only from the verified release, and they matter: a security fix is held 24 hours instead of 72
 * and announced at once, and a release that needs a decision never installs in the background.
 *
 * **Why they are held to the changelog.** Nothing else removes a flag once its release is out, so one left in
 * `package.json` would apply to the next release too. That release's section will not carry the flag's marker line, so
 * this check refuses it. Both ways: a flag needs its marker, and a marker needs its flag.
 *
 * - `"security": true` ⇔ a line of the version's section starts `**Security fix.**`;
 * - `"needsDecision": true` ⇔ a line of it starts `**Needs a decision before it installs.**`.
 *
 * A marker counts only at the very start of a line of the version's own section, the lines after `## <version>` up to
 * the next `## ` — the section `release-ci.mjs notes` prints for the GitHub release.
 *
 * **A needed decision is carried forward** (design 2026-10-22 §8.1). An update reads only the release it goes to, so
 * that release must say whether any release before it needed a decision: core's `"needsDecisionSince"` is the newest
 * release, up to and including this one, that declared `needsDecision`. A release that declares it carries its own
 * version; every other release carries the last one's, or nothing when no release ever declared one. A release that
 * dropped it would let a machine from before that decision go past it unasked.
 *
 * **The carry is read from the changelog**, not from the previous tag's `packages/core/package.json`. Each released
 * `## X.Y.Z` section's decision marker is what that release declared, since this check held its flag to it, so the
 * newest marked section before this version, by version, is the value the last release carried. The changelog is in
 * the tree both release paths check, the tag gate's shallow checkout included, which holds no earlier tag; and it
 * needs no git and no network. Releases before 0.26.0 could declare no flag, and no section of theirs has the marker.
 *
 * - `"needsDecision": true` ⇒ `"needsDecisionSince"` is this version;
 * - otherwise ⇒ it is the newest released version below this one whose section has the decision marker, or absent
 *   when none has.
 *
 * Run by `scripts/release.mjs` and by the tag gate in `.github/workflows/release.yml`, before anything is sent. Not by
 * `pnpm verify`: the changes being made sit under `## Unreleased`, which names no version to check.
 *
 *   node scripts/release-flags.mjs 0.26.0    # prints ::error:: for each problem and exits 1, or exits 0
 *
 * `RELEASE_CHANGELOG` names another changelog, as it does for `release-ci.mjs notes`.
 */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, ROOT } from './channels.mjs';

/** The line that says a release fixes a security problem. */
export const SECURITY_MARKER = '**Security fix.**';

/** The line that says a release needs a decision before it installs. */
export const DECISION_MARKER = '**Needs a decision before it installs.**';

/**
 * What core declares the release under `root` to be, from that tree's registry: `{ security, needsDecision,
 * needsDecisionSince }` — false, false and null when it declares nothing. A shape `scripts/channels.mjs` refuses
 * throws, naming the file.
 */
export function coreReleaseFlags(root = ROOT) {
  return loadRegistry(root).releaseFlags;
}

/** Each flag, with its marker, in the order problems are told. */
const FLAGS = Object.freeze([
  ['security', SECURITY_MARKER],
  ['needsDecision', DECISION_MARKER],
]);

/**
 * The lines after `## <version>` up to the next `## `, joined with `\n`; null when there is no such heading. The
 * heading is matched whole, as `release-ci.mjs notes` matches it, so `1.2` is not `1.2.0`.
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/**
 * Each mismatch between `flags` and the section's markers, and a needed decision not carried forward as the
 * changelog gives it, as a sentence each; empty when they match.
 */
export function releaseFlagProblems({ version, changelog, flags }) {
  const section = changelogSection(changelog, version);
  if (section === null) return [`CHANGELOG.md has no "## ${version}" section`];
  const lines = section.split('\n');
  const problems = [];
  for (const [key, marker] of FLAGS) {
    const declared = flags[key] === true;
    const marked = lines.some((line) => line.startsWith(marker));
    if (declared && !marked) {
      problems.push(
        `packages/core/package.json declares "${key}": true, but the ## ${version} section of CHANGELOG.md has no line starting ${marker}`,
      );
    } else if (!declared && marked) {
      problems.push(
        `the ## ${version} section of CHANGELOG.md has a line starting ${marker}, but packages/core/package.json does not declare "${key}": true`,
      );
    }
  }
  const carried = carryProblem({ version, changelog, flags });
  if (carried !== null) problems.push(carried);
  return problems;
}

/** The `X.Y.Z` of a version, as three numbers of any size; null for anything else. */
function releaseNumbers(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/.exec(String(version));
  return match === null ? null : match.slice(1, 4).map((part) => BigInt(part));
}

/** Negative, zero or positive, as `a`'s `X.Y.Z` comes before, is, or comes after `b`'s. */
function compareNumbers(a, b) {
  for (const index of [0, 1, 2]) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * The newest released version before `version`, by version, whose `## X.Y.Z` section has a line starting the
 * decision marker; null when none has. Only exact release headings count: what is under `## Unreleased` has not been
 * released. By version, not by place in the file, so a backport released after a newer line carries nothing of it.
 */
export function lastDecisionBefore(changelog, version) {
  const own = releaseNumbers(version);
  if (own === null) return null;
  let section = null;
  let newest = null;
  for (const line of changelog.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim();
      section = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(heading) ? heading : null;
      continue;
    }
    if (section === null || !line.startsWith(DECISION_MARKER)) continue;
    const numbers = releaseNumbers(section);
    if (compareNumbers(numbers, own) >= 0) continue;
    if (newest === null || compareNumbers(numbers, releaseNumbers(newest)) > 0) newest = section;
  }
  return newest;
}

/**
 * What is wrong with core's `needsDecisionSince` for `version`, as a sentence, or null when it is the carry: this
 * version when it declares `needsDecision`, otherwise the last decision before it (`lastDecisionBefore`), or none.
 */
function carryProblem({ version, changelog, flags }) {
  const since = flags.needsDecisionSince ?? null;
  const described = since === null ? 'declares none' : `is "${since}"`;
  if (flags.needsDecision === true) {
    return since === version
      ? null
      : `packages/core/package.json declares "needsDecision": true, so its "needsDecisionSince" must be "${version}", this release's own version, but it ${described}`;
  }
  const previous = lastDecisionBefore(changelog, version);
  if (previous === null) {
    return since === null
      ? null
      : `no ## X.Y.Z section of CHANGELOG.md before ${version} has a line starting ${DECISION_MARKER}, so packages/core/package.json must not declare "needsDecisionSince", but it is "${since}"`;
  }
  return since === previous
    ? null
    : `the ## ${previous} section of CHANGELOG.md is the newest before ${version} with a line starting ${DECISION_MARKER}, so packages/core/package.json must carry "needsDecisionSince": "${previous}" forward, but it ${described}`;
}

// Run directly: check the version named against this tree's core and changelog. Compared through realpath, as
// `scripts/packages.mjs` is, because a runner's temp directory can be a symlink.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  const version = process.argv[2];
  if (!version) {
    console.error('::error::usage: release-flags.mjs <version>');
    process.exit(1);
  }
  const changelog = await readFile(process.env.RELEASE_CHANGELOG || join(ROOT, 'CHANGELOG.md'), 'utf8');
  const flags = coreReleaseFlags();
  const problems = releaseFlagProblems({ version, changelog, flags });
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `  ✓ ${version}: core declares security ${flags.security}, needsDecision ${flags.needsDecision} and needsDecisionSince ${flags.needsDecisionSince ?? 'none'}, as its changelog says`,
  );
}
