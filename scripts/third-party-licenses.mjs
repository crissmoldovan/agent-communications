#!/usr/bin/env node
/**
 * Writes `THIRD_PARTY_LICENSES` for each published package.
 *
 * These packages are bundled: the dependency code is inlined into the published files rather than installed
 * alongside them, so the licence notices that would normally travel in `node_modules` do not travel at all. Every
 * one of those licences requires the notice to be preserved, which means this file is a licence obligation, not
 * paperwork — and a bundle shipped without it is a bundle shipped in breach.
 *
 * `--check` verifies without writing, which is what CI runs.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const PACKAGES = ['core', 'gmail', 'gmail-mcp'];
const LICENCE_FILES = ['LICENSE', 'LICENSE.md', 'LICENCE', 'LICENCE.md', 'LICENSE.txt', 'license'];
const problems = [];

/** The packages a bundle actually inlines: its own runtime and build dependencies, and theirs, transitively. */
async function bundledInto(name) {
  const manifest = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
  const direct = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    // Type packages and our own workspace packages carry no code into the bundle.
    .filter((dependency) => !dependency.startsWith('@types/') && !dependency.startsWith('@agent-communications/'))
    // The toolchain builds the bundle; it is not in it.
    .filter((dependency) => !['tsdown', 'typescript', '@biomejs/biome'].includes(dependency));
  const seen = new Set();
  const queue = [...direct];
  while (queue.length > 0) {
    const dependency = queue.shift();
    if (!dependency || seen.has(dependency)) continue;
    const manifestPath = await resolveManifest(dependency);
    if (!manifestPath) continue;
    seen.add(dependency);
    const theirs = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const next of Object.keys(theirs.dependencies ?? {})) queue.push(next);
  }
  return [...seen].sort();
}

/** pnpm's store nests by version, so the manifest is found by walking up from the resolved entry point. */
async function resolveManifest(dependency) {
  const direct = join(ROOT, 'node_modules', dependency, 'package.json');
  if (
    await readFile(direct, 'utf8').then(
      () => true,
      () => false,
    )
  )
    return direct;
  // Hoisted differently, or only present under a workspace package.
  for (const name of PACKAGES) {
    const nested = join(ROOT, 'packages', name, 'node_modules', dependency, 'package.json');
    if (
      await readFile(nested, 'utf8').then(
        () => true,
        () => false,
      )
    )
      return nested;
  }
  return null;
}

async function noticeFor(dependency) {
  const manifestPath = await resolveManifest(dependency);
  if (!manifestPath) return null;
  const directory = join(manifestPath, '..');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const licence = typeof manifest.license === 'string' ? manifest.license : (manifest.license?.type ?? 'see below');

  let text = null;
  const entries = await readdir(directory).catch(() => []);
  for (const candidate of LICENCE_FILES) {
    const found = entries.find((entry) => entry.toLowerCase() === candidate.toLowerCase());
    if (!found) continue;
    text = await readFile(join(directory, found), 'utf8').catch(() => null);
    if (text) break;
  }
  if (!text) {
    // Some packages declare a licence and ship no copy of it — `@googleapis/*` among them. The obligation to
    // reproduce it does not go away, so the canonical text for that SPDX id is used, taken from a package in this
    // same tree that does ship one. An id nothing here carries is reported rather than skipped.
    text = await canonicalText(licence);
    if (!text) {
      problems.push(`${dependency}: declares ${licence} and ships no copy of it, and no canonical text was found`);
      return null;
    }
  }
  return [
    '-'.repeat(100),
    `${dependency}@${manifest.version} — ${licence}`,
    manifest.homepage ? `  ${manifest.homepage}` : '',
    '-'.repeat(100),
    '',
    text.trim(),
    '',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * The text of a licence, borrowed from a package in this tree that ships one.
 *
 * Preferred over a copy pasted into this script: the text then comes from the same versions being bundled, and
 * there is no second place for it to go stale. A licence with a per-package copyright line is not borrowed — the
 * two that matter here, Apache-2.0 and MIT-with-no-holder, are identical everywhere.
 */
const canonicalCache = new Map();
async function canonicalText(spdx) {
  if (spdx !== 'Apache-2.0') return null;
  if (canonicalCache.has(spdx)) return canonicalCache.get(spdx);
  for (const donor of ['google-auth-library', 'googleapis-common', 'google-logging-utils']) {
    const manifestPath = await resolveManifest(donor);
    if (!manifestPath) continue;
    const text = await readFile(join(manifestPath, '..', 'LICENSE'), 'utf8').catch(() => null);
    if (text) {
      canonicalCache.set(spdx, text);
      return text;
    }
  }
  return null;
}

for (const name of PACKAGES) {
  const dependencies = await bundledInto(name);
  const notices = [];
  for (const dependency of dependencies) {
    const notice = await noticeFor(dependency);
    if (notice) notices.push(notice);
  }

  // A package that bundles nothing says so, rather than leaving a header with nothing under it — which reads like
  // a file that was cut off.
  const content =
    notices.length === 0
      ? [
          `Third-party licences for @agent-communications/${name}`,
          '',
          'This package inlines no third-party code: it depends on @agent-communications/gmail at runtime, which carries its',
          'own THIRD_PARTY_LICENSES for what it bundles. There is nothing to reproduce here.',
          '',
          'Generated by scripts/third-party-licenses.mjs.',
          '',
        ].join('\n')
      : [
          `Third-party licences bundled into @agent-communications/${name}`,
          '',
          'This package is published as a bundle: the code below is compiled into its published files rather than',
          'installed beside them, so these notices travel here instead of in node_modules. They are reproduced in',
          'full, as each licence requires.',
          '',
          `Generated by scripts/third-party-licenses.mjs from ${dependencies.length} packages.`,
          '',
          '',
          ...notices,
        ].join('\n');

  const path = join(ROOT, 'packages', name, 'THIRD_PARTY_LICENSES');
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current === content) continue;
  if (check) {
    problems.push(`packages/${name}/THIRD_PARTY_LICENSES is out of date — run \`pnpm licenses\``);
    continue;
  }
  await writeFile(path, content);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`third-party licences written for ${PACKAGES.length} packages.`);
