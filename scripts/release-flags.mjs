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
 * What core declares the release under `root` to be, from that tree's registry: `{ security, needsDecision }`, both
 * false when it declares nothing. A shape `scripts/channels.mjs` refuses throws, naming the file.
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

/** Each mismatch between `flags` and the section's markers, as a sentence; empty when they match. */
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
  return problems;
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
    `  ✓ ${version}: core declares security ${flags.security} and needsDecision ${flags.needsDecision}, as its changelog section says`,
  );
}
