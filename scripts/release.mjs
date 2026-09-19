#!/usr/bin/env node
/**
 * Publishes the three packages to npm, from here.
 *
 * Publishing is the one thing in this repository that cannot be undone: npm keeps a version for ever, and the
 * 72-hour unpublish window is not a fix once somebody has installed it. So this refuses far more than it does, and
 * every refusal names what to do about it.
 *
 * It rehearses by default. `--publish` is the only way to send anything.
 *
 *   node scripts/release.mjs              # rehearse: every check, then stop
 *   node scripts/release.mjs --publish    # rehearse, then actually publish
 *   node scripts/release.mjs --publish --skip-verify   # only when verify just passed in this same tree
 *
 * Why here and not in CI: a published version carries npm provenance only when it is published by a supported CI
 * runner, so a local release has none. That is a deliberate trade — see docs/RELEASING.md.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Packages in dependency order: a consumer installing gmail must find the core it pins already on the registry. */
const PACKAGES = ['core', 'gmail', 'gmail-mcp'];
const SCOPE = '@agent-communications';

const args = new Set(process.argv.slice(2));
const publish = args.has('--publish');
const skipVerify = args.has('--skip-verify');

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

/** Runs a command for its effect, letting its output through so a long verify does not look like a hang. */
function runLoud(command, commandArgs) {
  execFileSync(command, commandArgs, { stdio: 'inherit' });
}

const failures = [];
function refuse(what, fix) {
  failures.push({ what, fix });
}

function quiet(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

console.log(`${publish ? 'Releasing' : 'Rehearsing a release'} — checking first.\n`);

// ── The tree ──────────────────────────────────────────────────────────────────────────────────────────────────
const dirty = run('git', ['status', '--porcelain']);
if (dirty)
  refuse('the working tree has uncommitted changes', 'Commit or stash them; a release must be a commit that exists.');

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') refuse(`on branch "${branch}", not main`, 'Release from main: `git checkout main`.');

quiet(() => run('git', ['fetch', '--quiet', 'origin']));
const local = quiet(() => run('git', ['rev-parse', 'HEAD']));
const remote = quiet(() => run('git', ['rev-parse', 'origin/main']));
if (local && remote && local !== remote) {
  refuse(
    'main here and main on the server are different commits',
    'Push or pull first. What is published must be what anyone else can read.',
  );
}

// ── The version ───────────────────────────────────────────────────────────────────────────────────────────────
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
console.log(`Version: ${version}`);

for (const name of PACKAGES) {
  const manifest = JSON.parse(readFileSync(join('packages', name, 'package.json'), 'utf8'));
  if (manifest.version !== version) {
    refuse(
      `${SCOPE}/${name} says ${manifest.version}, the repository says ${version}`,
      'Run `pnpm sync:versions` and commit.',
    );
  }
}

// ── Who is publishing ─────────────────────────────────────────────────────────────────────────────────────────
const who = quiet(() => run('npm', ['whoami']));
if (!who) {
  refuse('not logged in to npm', 'Run `npm login`. This is a credential action and belongs to a person, not a script.');
} else {
  console.log(`npm user: ${who}`);
}

// ── Already published? ────────────────────────────────────────────────────────────────────────────────────────
// A version on the registry cannot be replaced, so finding one now is much better than finding it half way through.
for (const name of PACKAGES) {
  const published = quiet(() => run('npm', ['view', `${SCOPE}/${name}@${version}`, 'version']));
  if (published === version) {
    refuse(
      `${SCOPE}/${name}@${version} is already on the registry`,
      'Bump the version: a published version can never be replaced, only superseded.',
    );
  }
}

// Publishing may need a one-time password from an authenticator, and only an interactive terminal can supply one.
//
// **Do not try to predict this from the account's 2FA mode.** It was tried: `npm profile get` reported `auth-only`
// — 2FA on sign-in, not on writes — and the very next `npm publish` still failed with `EOTP`, because npm treats
// *creating* a package as privileged whatever that setting says. So the check that reads the mode is worse than no
// check: it waves through the exact case that fails, after the verify has already run.
//
// Refuse on a non-interactive terminal instead, and let a person run it.
if (publish && !process.stdin.isTTY) {
  refuse(
    'this is not an interactive terminal, and npm may ask for a one-time password',
    'Run `pnpm release:publish` yourself in a terminal so npm can prompt you. An agent cannot do this step, ' +
      'and should not be handed the code.',
  );
}

if (failures.length > 0) {
  console.error('\nRefusing to release:\n');
  for (const { what, fix } of failures) console.error(`  ✗ ${what}\n    ${fix}\n`);
  process.exit(1);
}

// ── The checks that take time ─────────────────────────────────────────────────────────────────────────────────
if (skipVerify) {
  console.log('\nSkipping verify, as asked. Only do this when it has just passed in this same tree.');
} else {
  console.log('\nRunning the full verify — lint, build, typecheck, tests, skills, versions, licences, and a real');
  console.log('install of each packed tarball into a throwaway project.\n');
  runLoud('pnpm', ['verify']);
}

if (!publish) {
  console.log(`\nEverything a release checks has passed for ${version}.`);
  console.log('Nothing was published. Add --publish to send it.');
  process.exit(0);
}

// ── The irreversible part ─────────────────────────────────────────────────────────────────────────────────────
console.log(`\nPublishing ${PACKAGES.length} packages at ${version}, in dependency order.\n`);
const sent = [];
try {
  for (const name of PACKAGES) {
    process.stdout.write(`  ${SCOPE}/${name} … `);
    runLoud('pnpm', ['--filter', `${SCOPE}/${name}`, 'publish', '--access', 'public', '--no-git-checks']);
    sent.push(name);
    console.log(`  ${SCOPE}/${name} sent`);
  }
} catch (error) {
  // What to say depends entirely on whether anything got out, and saying the wrong one is its own harm: telling
  // someone a version is permanent when nothing was sent invites them to burn a version number for no reason.
  if (sent.length === 0) {
    console.error('\nNothing was published. The registry is untouched, so fix the cause and run this again at the');
    console.error('same version.\n');
  } else {
    console.error(`\nA publish failed after sending: ${sent.join(', ')}.`);
    console.error('Those versions are on the registry for good. Bump the version and release again rather than');
    console.error('retrying this one — the packages that did go out cannot be replaced.\n');
  }
  throw error;
}

// ── Ask the registry what actually arrived ────────────────────────────────────────────────────────────────────
// `pnpm --filter` exits 0 when it matches nothing, so a renamed package would publish fewer than this list claims
// and still finish green. Trust the registry, not the loop's exit code.
console.log('\nConfirming what reached the registry:');

/**
 * Asks whether a version is really published, and asks the right endpoint.
 *
 * `npm view` reads the public packument, which is CDN-cached and can lag minutes behind a successful publish —
 * badly so just after npm maintenance. The first version of this check used it, ran immediately, and announced
 * that a publish which had in fact succeeded had "not arrived". That is the worst way to be wrong: it invites
 * someone to burn the version number and publish 0.1.1 over a perfectly good 0.1.0.
 *
 * `npm dist-tag ls` goes to the authenticated registry path instead and was accurate within seconds of the same
 * publish. It is tried first; the packument is a fallback, and the whole thing retries before giving up.
 */
function publishedVersion(name) {
  const tags = quiet(() => run('npm', ['dist-tag', 'ls', `${SCOPE}/${name}`]));
  const tagged = tags?.split('\n').find((line) => line.startsWith('latest:'));
  if (tagged) return tagged.slice('latest:'.length).trim();
  return quiet(() => run('npm', ['view', `${SCOPE}/${name}@${version}`, 'version']));
}

const pending = new Set(PACKAGES);
for (let attempt = 1; attempt <= 10 && pending.size > 0; attempt += 1) {
  for (const name of [...pending]) {
    if (publishedVersion(name) === version) {
      pending.delete(name);
      console.log(`  ✓ ${SCOPE}/${name}@${version}`);
    }
  }
  if (pending.size > 0 && attempt < 10) {
    console.log(`  … waiting for ${[...pending].join(', ')} (attempt ${attempt})`);
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},6000)']);
  }
}

if (pending.size > 0) {
  console.error(`\n${pending.size} package(s) are not visible yet: ${[...pending].join(', ')}.`);
  console.error('That may still be the read path lagging rather than a failed publish. Before doing anything');
  console.error(`about it, check \`npm dist-tag ls ${SCOPE}/<name>\` — if it says ${version}, the publish landed`);
  console.error('and there is nothing to fix. Do NOT bump the version on the strength of this message alone.\n');
  process.exit(1);
}

console.log(`\nPublished ${version}.`);
console.log('\nNext, and none of it automatic:');
console.log(`  git tag v${version} && git push origin v${version}`);
console.log(`  npx -y ${SCOPE}/gmail@${version} --version     # prove it installs from a clean machine`);
console.log('  gh release create ...                          # with the changelog section as its body');
