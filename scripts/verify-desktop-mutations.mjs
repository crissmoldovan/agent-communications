#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root =
  rootArg >= 0 && args[rootArg + 1]
    ? resolve(args[rootArg + 1])
    : resolve(fileURLToPath(new URL('../', import.meta.url)));
const manifestArg = args.indexOf('--manifest');
const manifestPath =
  manifestArg >= 0 && args[manifestArg + 1]
    ? resolve(args[manifestArg + 1])
    : join(root, 'apps/desktop/test/mutations/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];
const ids = new Set();

if (manifest.version !== 1 || !Array.isArray(manifest.cases)) errors.push('invalid desktop mutation manifest');
const cases = Array.isArray(manifest.cases) ? manifest.cases : [];

function declaredTest(item) {
  if (typeof item?.test === 'string') return { kind: 'node', file: item.test, name: item.testName, legacy: true };
  return item?.test;
}

function structuralTest(item, declared) {
  return declared?.kind === 'cargo' ? item.structuralTest : declared;
}

const managedTestFiles = new Set(
  cases
    .flatMap((item) => {
      const structural = structuralTest(item, declaredTest(item));
      return typeof structural?.file === 'string' ? [structural.file] : [];
    })
    .filter((path) => /\.test\.(?:mjs|ts|tsx)$/.test(path)),
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
      // The manifest names files with `/` on every system; Windows' relative() would give `\`.
      const testPath = relative(root, path).split(sep).join('/');
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
  const declared = declaredTest(item);
  if (!declared || (declared.kind !== 'node' && declared.kind !== 'cargo') || typeof declared.name !== 'string') {
    errors.push(`${item.id}: missing declared test`);
    continue;
  }
  const structural = structuralTest(item, declared);
  if (!structural || typeof structural.file !== 'string' || typeof structural.name !== 'string') {
    errors.push(`${item.id}: missing named structural test`);
    continue;
  }
  if (!/\.test\.(?:mjs|ts|tsx)$/.test(structural.file)) {
    errors.push(`${item.id}: structural test is not a node test file`);
    continue;
  }
  const testPath = resolve(root, structural.file);
  if (!testPath.startsWith(`${root}${sep}`) || !existsSync(testPath)) {
    errors.push(`${item.id}: named structural test is missing`);
    continue;
  }
  const source = readFileSync(testPath, 'utf8');
  const nodeTest = namedTests.get(testKey(structural.file, structural.name));
  if (!nodeTest) {
    errors.push(`${item.id}: named structural test case is missing`);
  }
  if (nodeTest?.marker !== item.id) errors.push(`${item.id}: no matching test marker`);
  const nodePath = declared.kind === 'node' ? declared.file : structural.file;
  if (nodePath.includes('/e2e/') && item.execution !== 'desktop-e2e') {
    errors.push(`${item.id}: packaged probe cases must be marked desktop-e2e`);
  }
  if (!nodePath.includes('/e2e/') && item.execution !== undefined && item.execution !== 'structural') {
    errors.push(`${item.id}: non-e2e cases must be structural when execution is declared`);
  }
  const production = resolve(root, item.production ?? '');
  if (!item.production || !production.startsWith(`${root}${sep}`) || !existsSync(production)) {
    errors.push(`${item.id}: production module is missing`);
  }
  if (
    typeof item.import !== 'string' ||
    !source.includes(item.import) ||
    resolve(dirname(testPath), item.import) !== production
  ) {
    errors.push(`${item.id}: named structural test does not import its production module`);
  }
  if (item.group === 'task-4' && item.production?.endsWith('.rs')) {
    if (
      declared.kind !== 'cargo' ||
      typeof declared.manifest !== 'string' ||
      typeof declared.cargoTestPath !== 'string'
    ) {
      errors.push(`${item.id}: missing declared compiled Rust test`);
    } else if (
      declared.manifest !== 'apps/desktop/src-tauri/Cargo.toml' ||
      !/^--(?:lib|test [a-z0-9_]+)$/.test(declared.cargoTestPath)
    ) {
      errors.push(`${item.id}: invalid declared Cargo test path`);
    } else {
      const target = declared.cargoTestPath === '--lib' ? undefined : declared.cargoTestPath.slice('--test '.length);
      const rustPath = target ? resolve(root, 'apps/desktop/src-tauri/tests', `${target}.rs`) : production;
      if (!existsSync(rustPath)) {
        errors.push(`${item.id}: declared Cargo test source is missing`);
      } else {
        const rustSource = readFileSync(rustPath, 'utf8');
        const marker = `desktop-rust-mutation: ${item.id} | cargo ${declared.cargoTestPath} | ${declared.name}`;
        if (!rustSource.includes(marker)) errors.push(`${item.id}: declared Cargo test name does not match its marker`);
        const functionName = declared.name.split('::').at(-1);
        if (!new RegExp(`fn ${functionName}\\(`).test(rustSource)) {
          errors.push(`${item.id}: declared Cargo test function is missing`);
        }
        const module = item.production
          .replace(/^apps\/desktop\/src-tauri\/src\//, '')
          .replace(/\.rs$/, '')
          .replaceAll('/', '::');
        if (target && !rustSource.includes(`agentcomms_desktop::${module}`)) {
          errors.push(`${item.id}: declared Cargo test does not import its production module`);
        }
      }
    }
    if (item.rustTest || item.rustTestWindows) errors.push(`${item.id}: legacy Rust test declaration is forbidden`);
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

// A Cargo case has two different roles: its Node marker names structural evidence,
// while its Rust marker names the executable test. Each role gets one declaration.
function scanMutationMarkers() {
  const byId = new Map(cases.filter((item) => typeof item?.id === 'string').map((item) => [item.id, item]));
  const occurrences = new Map();
  const ignored = new Set(['.git', '.pnpm-store', '.superpowers', '.tmp', 'node_modules', 'target', 'coverage']);
  const sourceFile = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx|rs)$/;

  function walkFixture(folder, files) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        walkFixture(path, files);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join('/'));
      }
    }
  }

  const files = [];
  if (rootArg >= 0) {
    // Copied fixtures have no Git index. Their small tree includes synthetic tracked-source paths.
    walkFixture(root, files);
  } else {
    // Git selects tracked files plus current uncommitted source/test files, even inside build/dist.
    files.push(
      ...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
        .split('\0')
        .filter(Boolean),
    );
  }

  for (const file of new Set(files)) {
    if (!sourceFile.test(file)) continue;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const marker = lines[index].match(/^\s*\/\/\s*desktop-(rust-)?mutation:(.*)$/);
      if (!marker) continue;
      const [, rust, declaration] = marker;
      const idMatch = declaration.match(/^\s*(\S+)(.*)$/);
      if (!idMatch) {
        errors.push(`${file}:${index + 1}: marker has no mutation id`);
        continue;
      }
      const [, id, detail] = idMatch;
      const role = rust ? 'rust' : 'node';
      const key = `${role}\u0000${id}`;
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
      if (occurrences.get(key) > 1) errors.push(`${id}: mutation marker is duplicated`);
      const item = byId.get(id);
      if (!item) {
        errors.push(`${id}: marker has no manifest case`);
        continue;
      }
      const declared = declaredTest(item);
      if (rust) {
        const expected =
          declared?.kind === 'cargo' ? ` | cargo ${declared.cargoTestPath} | ${declared.name}` : undefined;
        if (detail !== expected) errors.push(`${id}: marker test differs from the manifest declaration`);
      } else {
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        const named = lines[next]?.match(/^\s*test\(\s*(['"])(.*?)\1\s*,/);
        const expected = structuralTest(item, declared);
        if (detail.trim() || file !== expected?.file || named?.[2] !== expected?.name) {
          errors.push(`${id}: marker test differs from the manifest declaration`);
        }
      }
    }
  }

  for (const item of cases) {
    if (typeof item?.id !== 'string') continue;
    const role = declaredTest(item)?.kind === 'cargo' ? 'rust' : 'node';
    if (!occurrences.has(`${role}\u0000${item.id}`)) errors.push(`${item.id}: executable mutation marker is missing`);
  }
}
scanMutationMarkers();

for (const [id, paths] of markers) {
  if (!ids.has(id)) errors.push(`${id}: test has no mutation`);
  if (paths.length !== 1) errors.push(`${id}: test marker is duplicated`);
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}

if (!process.exitCode) process.stdout.write(`Verified ${cases.length} desktop mutation pair(s)\n`);
