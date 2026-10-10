#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
const manifestPath =
  args[0] === '--manifest' && args[1] ? resolve(args[1]) : join(root, 'apps/desktop/test/mutations/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];
const ids = new Set();

if (manifest.version !== 1 || !Array.isArray(manifest.cases)) errors.push('invalid desktop mutation manifest');
const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
const managedTestFiles = new Set(
  cases.map((item) => item?.test).filter((path) => typeof path === 'string' && /\.test\.(?:mjs|ts|tsx)$/.test(path)),
);
const markers = new Map();
const namedTests = new Map();

function testKey(path, name) {
  return `${path}\u0000${name}`;
}

function collectNamedTests(path, source) {
  const lines = source.split(/\r?\n/);
  let pendingMarker;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(/^\s*\/\/\s*desktop-mutation:\s*([a-z0-9-]+)\s*$/);
    if (marker) {
      if (pendingMarker) errors.push(`${pendingMarker}: test marker is not paired with a named test`);
      pendingMarker = marker[1];
      continue;
    }
    if (!line.trim()) continue;
    const namedTest = line.match(/^\s*test\(\s*(['"])(.*?)\1\s*,/);
    if (namedTest) {
      const name = namedTest[2];
      const key = testKey(path, name);
      if (namedTests.has(key)) errors.push(`${path}: ${name}: named test is duplicated`);
      namedTests.set(key, { marker: pendingMarker });
      if (!pendingMarker) {
        errors.push(`${path}: ${name}: named test has no mutation marker`);
      } else {
        const markerTests = markers.get(pendingMarker) ?? [];
        markerTests.push(key);
        markers.set(pendingMarker, markerTests);
      }
      pendingMarker = undefined;
      continue;
    }
    if (pendingMarker) {
      errors.push(`${pendingMarker}: test marker is not paired with a named test`);
      pendingMarker = undefined;
    }
  }
  if (pendingMarker) errors.push(`${pendingMarker}: test marker is not paired with a named test`);
}

function visit(folder) {
  if (!existsSync(folder)) return;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (/\.test\.(?:mjs|ts|tsx)$/.test(entry.name)) {
      const source = readFileSync(path, 'utf8');
      const testPath = relative(root, path);
      if (testPath.startsWith('apps/desktop/test/') || managedTestFiles.has(testPath)) {
        collectNamedTests(testPath, source);
      }
    }
  }
}
visit(join(root, 'apps/desktop/test'));
visit(join(root, 'test'));

for (const item of cases) {
  if (!item || typeof item.id !== 'string') {
    errors.push('case has no id');
    continue;
  }
  if (ids.has(item.id)) errors.push(`${item.id}: duplicate mutation id`);
  ids.add(item.id);
  if (typeof item.test !== 'string' || !/\.test\.(?:mjs|ts|tsx)$/.test(item.test)) {
    errors.push(`${item.id}: missing named test`);
    continue;
  }
  const testPath = resolve(root, item.test);
  if (!testPath.startsWith(`${root}${sep}`) || !existsSync(testPath)) {
    errors.push(`${item.id}: named test is missing`);
    continue;
  }
  const source = readFileSync(testPath, 'utf8');
  const test = namedTests.get(testKey(item.test, item.testName));
  if (typeof item.testName !== 'string' || !test) {
    errors.push(`${item.id}: named test case is missing`);
  }
  if (test?.marker !== item.id) errors.push(`${item.id}: no matching test marker`);
  const production = resolve(root, item.production ?? '');
  if (!item.production || !production.startsWith(`${root}${sep}`) || !existsSync(production)) {
    errors.push(`${item.id}: production module is missing`);
  }
  if (
    typeof item.import !== 'string' ||
    !source.includes(item.import) ||
    resolve(dirname(testPath), item.import) !== production
  ) {
    errors.push(`${item.id}: named test does not import its production module`);
  }
  const mutation = item.mutation;
  if (
    !mutation ||
    mutation.file !== item.production ||
    typeof mutation.find !== 'string' ||
    mutation.find.length === 0 ||
    typeof mutation.replace !== 'string' ||
    mutation.find === mutation.replace ||
    isAbsolute(mutation.file ?? '')
  ) {
    errors.push(`${item.id}: invalid source-level mutation`);
  } else if (existsSync(production) && readFileSync(production, 'utf8').split(mutation.find).length !== 2) {
    errors.push(`${item.id}: mutant source text must occur exactly once`);
  }
}
for (const [id, paths] of markers) {
  if (!ids.has(id)) errors.push(`${id}: test has no mutation`);
  if (paths.length !== 1) errors.push(`${id}: test marker is duplicated`);
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}

// A custom manifest is used by structural tests. The repository manifest also proves mutants are red.
if (manifestPath === join(root, 'apps/desktop/test/mutations/manifest.json')) {
  for (const item of cases) {
    const run = spawnSync(process.execPath, ['apps/desktop/test/mutations/run.mjs', '--case', item.id], {
      cwd: root,
      encoding: 'utf8',
    });
    if (run.status !== 0) {
      process.stderr.write(`${item.id}: mutation did not fail its named test\n${run.stderr}`);
      process.exitCode = 1;
    }
  }
}
if (!process.exitCode) process.stdout.write(`Verified ${cases.length} desktop mutation pair(s)\n`);
