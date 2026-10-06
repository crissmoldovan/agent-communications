#!/usr/bin/env node
/**
 * The packages this repository publishes, in the order they must be published. The one list — in two widths.
 *
 * Every release path used to carry its own copy, and they drifted: 0.4.0's workflow published three packages while
 * `@agentcomms/slack` sat on disk, and after that was fixed `scripts/release.mjs` still named three — so the local
 * fallback would have repeated the same omission and reported success. A list written down in four places is four
 * lists. Everything that walks the packages now reads this file. `test/release-packages.test.mjs` fails if a
 * publishable package is missing from it, if the order breaks a dependency, or if any consumer stops reading it.
 *
 * **Two widths** (events phase A plan, decision 1). A package can be held back from a release with
 * `"agentcommsRelease": { "hold": "<why>" }` in its own `package.json` (`scripts/channels.mjs` reads it):
 *
 * - `PUBLISHABLE` — every package the registry publishes, held or not: what is proven publishable, by being built,
 *   version-synced, licence-checked and consumer-checked on every `pnpm verify`.
 * - `HELD` — the held packages, each with why.
 * - `PACKAGES` — `PUBLISHABLE` less `HELD`, in the same order: what a `v*` tag publishes. Running this file prints it,
 *   and the release path reads it and nothing wider — the workflow's publish and confirm loops (by running this file),
 *   `scripts/release.mjs` and the OIDC preflight's `scripts/release-ci.mjs` — so a held package is never read from
 *   the registry, proven, sent or confirmed. The release path's code did not change to learn this: it reads the list
 *   it always read, and that list is narrower while something is held.
 *
 * **The order is load-bearing.** A consumer installing `gmail` must find the exact `core` it pins already on the
 * registry, so a package comes after everything it depends on. That is checked, not trusted. No package a tag
 * publishes may depend at runtime on a held one, which the registry would never have; that is checked too.
 *
 * **Derived from the manifests** (`scripts/channels.mjs`): every package that declares a channel, every package a
 * channel's server is run through, and every declared library, in an order computed from their dependencies. A new
 * package is published by declaring itself — there is no list here to add it to, and the test above still fails when
 * a publishable package is not in the result.
 *
 *   node scripts/packages.mjs      # prints PACKAGES, e.g. core gmail gmail-mcp resend slack whatsapp
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REGISTRY, SCOPE } from './channels.mjs';

export { SCOPE };

/**
 * Every package the registry publishes, held or not, in publish order: directory names under `packages/`, which are
 * also the unscoped package names.
 *
 * The first frozen array in this file, on purpose: a test empties it to prove an empty list fails the release, and
 * emptying it empties `PACKAGES` with it.
 */
export const PUBLISHABLE = Object.freeze([...REGISTRY.packages]);

/** The packages held back from release, by directory name, each to the one-line reason its manifest gives. */
export const HELD = Object.freeze(
  Object.fromEntries(REGISTRY.held.map(({ directory, reason }) => [directory, reason])),
);

/** What a tag publishes: `PUBLISHABLE` less `HELD`, in the same order. */
export const PACKAGES = Object.freeze(PUBLISHABLE.filter((name) => !Object.hasOwn(HELD, name)));

// Run directly, print the list for a shell loop. Compared through realpath because a runner's temp directory can be
// a symlink (macOS `/tmp` → `/private/tmp`), and a plain string comparison would then print nothing — which a
// `for package in $(…)` loop reads as "no packages", and finishes green having published none.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${PACKAGES.join(' ')}\n`);
}
