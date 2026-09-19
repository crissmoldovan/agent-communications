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
const PACKAGES = ['comms-core', 'gmail', 'gmail-mcp'];
const SCOPE = '@cloudpixel';

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

// An account with 2FA set to "auth and writes" needs a one-time password at the moment of publish, and only an
// interactive terminal can ask for one. Discovering that at the first `pnpm publish` is a bad place to find out:
// the run has already spent minutes on the verify, and pnpm's message mentions authentication in a way that reads
// like the login is wrong.
//
// So ask the account rather than assuming. `auth-only` means 2FA guards signing in and not writing, which is the
// common setting for an account that publishes from a script — refusing there would block a release that would
// have worked. Anything else, or an answer we cannot read, is treated as needing a person.
const twoFactor = quiet(() => run('npm', ['profile', 'get', 'two-factor auth']))?.toLowerCase() ?? '';
const otpNeeded = !twoFactor.includes('auth-only') && !twoFactor.includes('disabled');
if (publish && otpNeeded && !process.stdin.isTTY) {
  refuse(
    `this is not an interactive terminal and the account needs a one-time password (2FA: ${twoFactor || 'unknown'})`,
    'Run `pnpm release:publish` yourself in a terminal so npm can ask for the code.',
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
let missing = 0;
for (const name of PACKAGES) {
  const found = quiet(() => run('npm', ['view', `${SCOPE}/${name}@${version}`, 'version']));
  const ok = found === version;
  if (!ok) missing += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${SCOPE}/${name}@${version}${ok ? '' : ` — not there (got ${found ?? 'nothing'})`}`);
}
if (missing > 0) {
  console.error(`\n${missing} package(s) did not arrive. The publish step reported success, which is the bug.`);
  process.exit(1);
}

console.log(`\nPublished ${version}.`);
console.log('\nNext, and none of it automatic:');
console.log(`  git tag v${version} && git push origin v${version}`);
console.log(`  npx -y ${SCOPE}/gmail@${version} --version     # prove it installs from a clean machine`);
console.log('  gh release create ...                          # with the changelog section as its body');
