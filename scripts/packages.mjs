#!/usr/bin/env node
/**
 * The packages this repository publishes, in the order they must be published. The one list.
 *
 * Every release path used to carry its own copy, and they drifted: 0.4.0's workflow published three packages while
 * `@agentcomms/slack` sat on disk, and after that was fixed `scripts/release.mjs` still named three — so the local
 * fallback would have repeated the same omission and reported success. A list written down in four places is four
 * lists. Everything that walks the packages now reads this one: the release workflow (by running this file, which
 * prints the names), `scripts/release.mjs`, `scripts/sync-versions.mjs`, `scripts/verify-package.mjs --all` and the
 * OIDC preflight. `test/release-packages.test.mjs` fails if a publishable package is missing from it, if the order
 * breaks a dependency, or if any of those consumers stops reading it.
 *
 * **The order is load-bearing.** A consumer installing `gmail` must find the exact `core` it pins already on the
 * registry, so a package comes after everything it depends on. That is checked, not trusted.
 *
 *   node scripts/packages.mjs      # prints: core gmail gmail-mcp slack
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCOPE = '@agentcomms';

/** Directory names under `packages/`, which are also the unscoped package names. */
export const PACKAGES = Object.freeze(['core', 'gmail', 'gmail-mcp', 'slack']);

// Run directly, print the list for a shell loop. Compared through realpath because a runner's temp directory can be
// a symlink (macOS `/tmp` → `/private/tmp`), and a plain string comparison would then print nothing — which a
// `for package in $(…)` loop reads as "no packages", and finishes green having published none.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${PACKAGES.join(' ')}\n`);
}
