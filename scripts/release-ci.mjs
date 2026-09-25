#!/usr/bin/env node
/**
 * The parts of the release workflow worth testing, kept out of YAML so they can be.
 *
 *   node scripts/release-ci.mjs pending 0.4.1 <commit>     # what this commit still has to publish, or fails
 *   node scripts/release-ci.mjs preflight 0.4.1 <commit>   # each of those trusts this workflow, or nothing is sent
 *   node scripts/release-ci.mjs notes 0.4.1                # prints the CHANGELOG section for a version, or fails
 *
 * All three run in `.github/workflows/release.yml`, and `test/release-packages.test.mjs` runs them against a fake
 * registry and a scratch changelog.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES, SCOPE } from './packages.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [command, ...rest] = process.argv.slice(2);

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function registryUrl() {
  return new URL(process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org');
}

/**
 * The packages this commit still has to publish at `version`, in the shared list's order, and those it already has.
 * Refuses, with nothing sent, if any package is already at that version from a different commit.
 *
 * **Why the commit, not just the version.** A package already at the version is skipped rather than re-sent, so that
 * a re-run after a partial failure finishes the release, and a tag pushed after a local `pnpm release:publish` gets
 * its GitHub release. But "already at this version" is not "already published from this tag". A GitHub re-run keeps
 * the commit it started with, so a fix that needs a commit can only get in by moving the tag, and the skip then
 * passed the packages the first run had built from the old commit: a green release of one version made of two
 * builds, with provenance naming both. pnpm's own recursive publish also passes over a version it can resolve, with
 * one line of info and whichever commit it came from, so this is the only thing that asks where it came from.
 *
 * **What records the commit.** `gitHead` in the version's manifest on the registry. `npm publish` writes it; pnpm
 * does not, so every publish here goes through `scripts/record-git-head.cjs`, which adds it. A version with no
 * `gitHead` was published some other way, and cannot be matched to this commit, so it is refused rather than assumed.
 */
async function unpublished(subcommand, version, commit) {
  if (!version || !COMMIT.test(commit ?? '')) fail(`usage: release-ci.mjs ${subcommand} <version> <commit>`);
  const todo = [];
  const done = [];
  const foreign = [];
  for (const name of PACKAGES) {
    const full = `${SCOPE}/${name}`;
    const manifest = await registryManifest(full, version);
    if (manifest === null) todo.push(name);
    else if (manifest.gitHead === commit) done.push(full);
    else if (typeof manifest.gitHead === 'string')
      foreign.push(`${full}@${version} was published from ${manifest.gitHead}`);
    else foreign.push(`${full}@${version} has no commit recorded`);
  }
  if (foreign.length > 0) {
    fail(
      `${foreign.join('; ')} — already on the registry, and not from this tag's commit, ${commit}. Nothing was ` +
        'published. A version cannot be sent twice, so once any package of it is out the tag must not move: put it ' +
        'back on the commit those packages came from and re-run for a failure outside the repository, or release a ' +
        'new version for one that needs a commit.',
    );
  }
  return { todo, done };
}

/**
 * The registry's manifest for one version of a package, or null when it has none.
 *
 * An answer it cannot read fails the run rather than being taken for "not published": that would let a package out
 * from another commit through without the check above, to be refused by npm only after the packages before it went.
 */
async function registryManifest(full, version) {
  const url = new URL(`/${full.replace('/', '%2f')}`, registryUrl());
  let last = 'no answer';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (response.status === 404) return null;
      if (response.ok) return (await response.json())?.versions?.[version] ?? null;
      last = `HTTP ${response.status}`;
      if (response.status < 500) break;
    } catch (error) {
      last = error?.cause?.code ?? error?.message ?? String(error);
    }
  }
  fail(`could not read ${full} from the registry (${last}); nothing was published. Re-run the job.`);
}

/** Prints what this commit still has to publish, space-separated for the workflow's publish loop. */
async function pending(version, commit) {
  const { todo, done } = await unpublished('pending', version, commit);
  for (const full of done) console.error(`  – ${full}@${version} is already out from this commit; skipping it`);
  process.stdout.write(`${todo.join(' ')}\n`);
}

/**
 * Proves npm trusted publishing works for every package still to publish, before any of them is published.
 *
 * **Why it exists.** Each package on npm has its own trusted-publisher configuration, and nothing public says whether
 * one is set. When it is missing, pnpm's publish only prints "Skipped OIDC" and falls back to a registry token this
 * workflow deliberately does not have, so that one package's PUT is refused — after the packages before it in the
 * list have gone out. For `@agentcomms/slack`, last in the list and first published by hand, that would have left
 * core, gmail and gmail-mcp at the new version and slack not, with no way to finish the release at that version.
 *
 * **How.** Exactly what the publish itself does, minus the publish: ask GitHub for an ID token with the audience
 * `npm:<registry host>`, then POST it to `/-/npm/v1/oidc/token/exchange/package/<escaped name>`. npm answers 200 with
 * a short-lived publish token only if that package names this repository, workflow file and environment as its
 * trusted publisher; otherwise it refuses. The token is read to confirm it exists and then dropped: it is never
 * printed, written or kept, and it expires on its own. A fresh ID token is asked for per package, because npm may
 * refuse an ID token it has already exchanged, and this must not be the thing that spends the publish's one.
 *
 * **Only for what will be sent.** A package already at this version from this commit is not published again, so its
 * trust proves nothing and is not asked for. That is what lets the tag after a local `pnpm release:publish` finish:
 * the local fallback is most likely to be used while a package has no trusted publisher, and exchanging for it
 * anyway failed the run and skipped the GitHub release for a version that was already on npm.
 */
async function preflight(version, commit) {
  if (!version || !commit) fail('usage: release-ci.mjs preflight <version> <commit>');
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    fail(
      'no GitHub OIDC request credentials in the environment. The publish job needs `permissions: id-token: write`; ' +
        'without it npm trusted publishing cannot work either, so nothing would publish.',
    );
  }
  const registry = registryUrl();
  const audience = `npm:${registry.hostname}`;

  const { todo, done } = await unpublished('preflight', version, commit);
  for (const full of done) console.log(`  – ${full}@${version} is already out from this commit; nothing to prove`);
  if (todo.length === 0) {
    console.log(`Every package is already at ${version} from this commit: nothing to publish, so nothing to prove.`);
    return;
  }

  const refused = [];
  for (const name of todo) {
    const full = `${SCOPE}/${name}`;
    const verdict = await exchange({ requestUrl, requestToken, audience, registry, full });
    if (verdict === true) {
      console.log(`  ✓ ${full} trusts this workflow`);
    } else {
      console.log(`  ✗ ${full}: ${verdict}`);
      refused.push(full);
    }
  }
  if (refused.length > 0) {
    fail(
      `${refused.join(', ')} ${refused.length === 1 ? 'has' : 'have'} no trusted publisher for this workflow; ` +
        'nothing was published. The package owner adds one on npmjs.com → the package → Settings → Trusted ' +
        'publishing (this repository, `release.yml`, environment `release`), then re-runs this job.',
    );
  }
  console.log(`All ${todo.length} package(s) still to publish accept this workflow's identity.`);
}

/** One package's exchange. Returns true, or a sentence saying why not; never the token. */
async function exchange({ requestUrl, requestToken, audience, registry, full }) {
  // Transient failures (the network, a 5xx) are retried: failing here costs nothing but a re-run, yet a flaky answer
  // should not be what stops a release. A 4xx is npm's verdict, and is not retried.
  let last = 'no answer';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const idUrl = new URL(requestUrl);
      idUrl.searchParams.set('audience', audience);
      const idResponse = await fetch(idUrl, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
      });
      if (!idResponse.ok) {
        last = `GitHub refused an ID token (HTTP ${idResponse.status})`;
        if (idResponse.status < 500) return last;
        continue;
      }
      const idToken = (await idResponse.json())?.value;
      if (typeof idToken !== 'string' || idToken === '') return 'GitHub answered without an ID token';

      const escaped = full.replace('/', '%2f');
      const response = await fetch(new URL(`/-/npm/v1/oidc/token/exchange/package/${escaped}`, registry), {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${idToken}`, 'Content-Length': '0' },
        body: '',
      });
      const body = await response.json().catch(() => null);
      if (response.ok) {
        // A 200 without a token is not a pass: pnpm treats it as a failed exchange too.
        return typeof body?.token === 'string' && body.token !== '' ? true : 'npm answered 200 without a token';
      }
      // npm's refusal carries a message, not a secret; it is what says which claim did not match.
      const said = typeof body?.message === 'string' ? `: ${body.message.slice(0, 200)}` : '';
      last = `npm refused the exchange (HTTP ${response.status})${said}`;
      if (response.status < 500) return last;
    } catch (error) {
      last = `could not reach the registry or GitHub (${error?.cause?.code ?? error?.message ?? error})`;
    }
  }
  return last;
}

/**
 * Prints the changelog section for one version: the lines after `## <version>` up to the next `## `.
 *
 * Used twice. The tag gate runs it **before** publishing, so a tag with no entry stops there rather than publishing and
 * then failing to make its release page. The GitHub release job runs it again for the body.
 */
async function notes(version) {
  if (!version) fail('usage: release-ci.mjs notes <version>');
  const changelog = await readFile(process.env.RELEASE_CHANGELOG || join(ROOT, 'CHANGELOG.md'), 'utf8');
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) fail(`CHANGELOG.md has no "## ${version}" section. Write the entry before tagging.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
  if (!body) fail(`CHANGELOG.md has a "## ${version}" heading with nothing under it.`);
  process.stdout.write(`${body}\n`);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (command === 'pending') await pending(rest[0], rest[1]);
else if (command === 'preflight') await preflight(rest[0], rest[1]);
else if (command === 'notes') await notes(rest[0]);
else fail('usage: release-ci.mjs pending <version> <commit> | preflight <version> <commit> | notes <version>');
