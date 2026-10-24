#!/usr/bin/env node
/**
 * The parts of the release workflow worth testing, kept out of YAML so they can be.
 *
 *   node scripts/release-ci.mjs pending 0.4.1 <commit>     # what this commit still has to publish, or fails
 *   node scripts/release-ci.mjs preflight 0.4.1 <commit>   # each of those trusts this workflow, or nothing is sent
 *   node scripts/release-ci.mjs tag v0.4.1 <commit>        # the tag on origin still names this commit, or fails
 *   node scripts/release-ci.mjs notes 0.4.1                # prints the CHANGELOG section for a version, or fails
 *   node scripts/release-ci.mjs verified <commit>          # a green dry run of this commit's exact tree, or none
 *
 * All five run in `.github/workflows/release.yml`. `test/release-packages.test.mjs` runs the first four against a fake
 * registry, a fake `git` and a scratch changelog, and `test/release-verified.test.mjs` runs `verified` against a fake
 * GitHub API and a scratch repository.
 */
import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PACKAGES, SCOPE } from './packages.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const execFileAsync = promisify(execFile);

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
  // An empty list would print nothing to publish, which the publish step reads as "all out already" and passes.
  if (PACKAGES.length === 0) fail('scripts/packages.mjs lists no packages, so there is nothing this release can check');
  const todo = [];
  const done = [];
  const foreign = [];
  // Packages the registry has never heard of: their first version cannot come from this workflow (see `preflight`).
  const absent = new Set();
  for (const name of PACKAGES) {
    const full = `${SCOPE}/${name}`;
    const packument = await registryPackument(full);
    if (packument === null) absent.add(name);
    const manifest = packument?.versions?.[version] ?? null;
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
  return { todo, done, absent };
}

/**
 * The registry's document for a package — every version it has, each with the commit it records — or null when
 * the registry has no such package at all (a 404: it has never been published).
 *
 * An answer it cannot read fails the run rather than being taken for "not published": that would let a package out
 * from another commit through without the check above, to be refused by npm only after the packages before it went.
 */
async function registryPackument(full) {
  const url = new URL(`/${full.replaceAll('/', '%2f')}`, registryUrl());
  let last = 'no answer';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (response.status === 404) return null;
      if (response.ok) return (await response.json()) ?? {};
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
 *
 * **A package npm has never seen cannot be published from here at all.** npm keeps trusted publishers per package
 * and will not hold one for a package that does not exist, so a new package's first version has to be sent by a
 * person. When the registry answers 404 for a package, the preflight does not ask for an exchange that cannot work:
 * it says the package has never been published and prints the exact command for the hand publish from this commit
 * — through `scripts/record-git-head.cjs`, so the version records this commit as its `gitHead` and this job then
 * skips it — and fails with nothing sent. Telling the owner to add a trusted publisher first, as it used to, asked
 * for something npm refuses.
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

  const { todo, done, absent } = await unpublished('preflight', version, commit);
  for (const full of done) console.log(`  – ${full}@${version} is already out from this commit; nothing to prove`);
  if (todo.length === 0) {
    console.log(`Every package is already at ${version} from this commit: nothing to publish, so nothing to prove.`);
    return;
  }

  const refused = [];
  const unborn = [];
  for (const name of todo) {
    const full = `${SCOPE}/${name}`;
    if (absent.has(name)) {
      console.log(`  ✗ ${full}: never published — npm has no such package, so it cannot trust this workflow yet`);
      unborn.push(full);
      continue;
    }
    const verdict = await exchange({ requestUrl, requestToken, audience, registry, full });
    if (verdict === true) {
      console.log(`  ✓ ${full} trusts this workflow`);
    } else {
      console.log(`  ✗ ${full}: ${verdict}`);
      refused.push(full);
    }
  }
  const trustedPublisher =
    'npmjs.com → the package → Settings → Trusted publishing (this repository, `release.yml`, environment `release`)';
  const problems = [];
  if (unborn.length > 0) {
    // The same publish the workflow and `scripts/release.mjs` run, for one package, so the version records this
    // commit as its `gitHead`. Not `npm publish` in the package's directory: npm records no gitHead from a git
    // worktree, and a version with no commit recorded is one this job can never finish.
    const tag = version.includes('-') ? 'next' : 'latest';
    console.log(
      `\nFirst publish, by hand, from this commit (${commit}): in a checkout of it, from the repository root, after ` +
        "`pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime' && pnpm build`, run",
    );
    for (const full of unborn) {
      console.log(
        `  pnpm --config.pnpmfile=scripts/record-git-head.cjs --filter ${full} publish --access public --no-git-checks --tag ${tag}`,
      );
    }
    problems.push(
      `${unborn.join(', ')} ${unborn.length === 1 ? 'has' : 'have'} never been published, and npm cannot hold a ` +
        'trusted publisher for a package that does not exist, so a first version cannot come from this workflow. ' +
        `Publish ${unborn.length === 1 ? 'it' : 'each'} once by hand from this commit with the ` +
        `${unborn.length === 1 ? 'command' : 'commands'} above, which record ${commit} as its gitHead so this job ` +
        `skips it; add ${unborn.length === 1 ? 'its' : 'each one’s'} trusted publisher on ${trustedPublisher}; ` +
        'then re-run this job.',
    );
  }
  if (refused.length > 0) {
    problems.push(
      `${refused.join(', ')} ${refused.length === 1 ? 'has' : 'have'} no trusted publisher for this workflow; ` +
        `nothing was published. The package owner adds one on ${trustedPublisher}, then re-runs this job.`,
    );
  }
  if (problems.length > 0) fail(`Nothing was published. ${problems.join(' ')}`);
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

      const escaped = full.replaceAll('/', '%2f');
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
 * Fails unless the tag that started this run still names, on origin, the commit this run is building.
 *
 * **Why it exists.** A run builds the commit its tag named when it started, whatever the tag names later, and a re-run
 * keeps that commit too. Moving a tag whose run had published nothing was the documented way past a failed verify
 * leg, but a run still in its verify legs has also published nothing. Moved to a fix then, the tag left that run to
 * publish every package from the old commit and make its GitHub release on the tag where it pointed by then, the new
 * commit, while the run for the fix was refused only afterwards. So the workflow asks just before the preflight, again
 * just before the first publish, and before making the release page, and stops at whichever finds the tag moved or
 * gone.
 *
 * **What it compares.** `git ls-remote` prints an annotated tag as the tag object and then, named `<tag>^{}`, the
 * commit it points to; a lightweight tag is one line, the commit itself. `GITHUB_SHA` is a commit, so the peeled line
 * is the one compared when there is one. Both names are asked for, because the pattern `refs/tags/v1.2.3` does not
 * match `refs/tags/v1.2.3^{}`, and only those exact names are read, because ls-remote matches a pattern against the
 * tail of any ref.
 *
 * It asks origin as the checkout left it, with no credentials: the repository has to be public for provenance, and the
 * workflow stops before this when it is not.
 */
async function tag(name, commit) {
  if (!name || !COMMIT.test(commit ?? '')) fail('usage: release-ci.mjs tag <tag> <commit>');
  const ref = `refs/tags/${name}`;
  const listed = new Map();
  for (const line of (await lsRemote(name, [ref, `${ref}^{}`])).split(/\r?\n/)) {
    const [object, listedRef] = line.split('\t');
    if (object && listedRef) listed.set(listedRef, object);
  }
  const points = listed.get(`${ref}^{}`) ?? listed.get(ref);
  const stop =
    'This run stops here: it publishes nothing more and makes no release page. If any package of this version is ' +
    `already out from ${commit}, the tag must name that commit: put it back there and re-run this job.`;
  if (!points) fail(`${name} is no longer on origin. ${stop}`);
  if (points !== commit) fail(`${name} now names ${points}, not ${commit}, the commit this run started from. ${stop}`);
  console.log(`  ✓ ${name} still names ${commit}`);
}

/**
 * Whether a green dry run already verified this commit's exact tree, so that the tag's run need not verify it again.
 *
 * **Why.** A release is checked twice: the dry run on the pull request's head runs every verify leg, and the tag's run
 * ran them all again on the merge commit, whose tree is the same when `main` had not moved: about 80 minutes of the
 * same work. Git names a tree by the hash of every file in it, `.github/workflows/release.yml` included, so a dry run of
 * a commit with this tree ran these very legs over these very files.
 *
 * **What counts.** A run of `release.yml` started by `workflow_dispatch` (a dry run, or a release started by hand),
 * concluded `success`, whose head commit has this tree. A dispatch never skips its verify legs (the tag's lookup runs
 * only on a pushed tag), so its success means every leg passed. A push run, a failed or cancelled one, or one of
 * another tree does not count.
 *
 * **It can only say yes from a match.** No match, an API error or a refusal prints why and writes an empty `run`, and
 * the verify legs run as they always did: the worst it can do is cost the time it was meant to save.
 *
 * Writes `run=<id>` (or `run=`) to `$GITHUB_OUTPUT` when that is set. It reads the API with the job's token
 * (`actions: read`, `contents: read`), from `$GITHUB_API_URL` and `$GITHUB_REPOSITORY`, as Actions sets them.
 */
async function verified(commit) {
  if (!COMMIT.test(commit ?? '')) fail('usage: release-ci.mjs verified <commit>');
  const answer = async (run, message) => {
    console.log(message);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  };
  let tree;
  try {
    ({ stdout: tree } = await execFileAsync('git', ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }));
    tree = tree.trim();
  } catch (error) {
    return answer('', `  no tree for ${commit} (${error?.message ?? error}): the verify legs run`);
  }
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    return answer('', `  no repository named in GITHUB_REPOSITORY: the verify legs run`);
  }
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const headers = {
    Accept: 'application/vnd.github+json',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
  const read = async (path) => {
    const response = await fetch(`${api}/repos/${repository}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${response.status} for ${path}`);
    return response.json();
  };
  try {
    const listed = await read('/actions/workflows/release.yml/runs?event=workflow_dispatch&status=success&per_page=30');
    const trees = new Map([[commit, tree]]);
    for (const run of listed?.workflow_runs ?? []) {
      if (run?.event !== 'workflow_dispatch' || run?.conclusion !== 'success' || !COMMIT.test(run?.head_sha ?? '')) {
        continue;
      }
      if (!trees.has(run.head_sha)) trees.set(run.head_sha, (await read(`/git/commits/${run.head_sha}`))?.tree?.sha);
      if (trees.get(run.head_sha) === tree) {
        return answer(
          String(run.id),
          `  ✓ dry run ${run.id} verified this exact tree, ${tree}, at ${run.head_sha}: the verify legs do not run again (${run.html_url ?? ''})`,
        );
      }
    }
  } catch (error) {
    return answer('', `  could not ask which dry runs passed (${error?.message ?? error}): the verify legs run`);
  }
  return answer('', `  no green dry run verified this tree, ${tree}: the verify legs run`);
}

/** What `git ls-remote origin` prints for `patterns`. Retried like the registry reads: a flaky answer costs a retry. */
async function lsRemote(name, patterns) {
  let last = 'no answer';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', 'origin', ...patterns], {
        encoding: 'utf8',
        timeout: 60_000,
        // A prompt for credentials would wait for ever on a runner with nobody to answer it; failing is the answer.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return stdout;
    } catch (error) {
      // Every line git wrote, not the last: its reason is often on the first, and the last only says it stopped.
      last =
        String(error?.stderr ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .join(' / ')
          .slice(0, 400) ||
        error?.message ||
        String(error);
    }
  }
  fail(`could not ask origin where ${name} points (${last}). This run stops here; re-run the job.`);
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
else if (command === 'tag') await tag(rest[0], rest[1]);
else if (command === 'notes') await notes(rest[0]);
else if (command === 'verified') await verified(rest[0]);
else {
  fail(
    'usage: release-ci.mjs pending <version> <commit> | preflight <version> <commit> | tag <tag> <commit> | ' +
      'notes <version> | verified <commit>',
  );
}
