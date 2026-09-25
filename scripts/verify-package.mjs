#!/usr/bin/env node
/**
 * Proves a package works as published: pack it the way it will be published (pnpm, so `workspace:` and `catalog:`
 * specifiers are rewritten), install the tarball into a fresh consumer with its own npm cache, then run the package's
 * `test/consumer-check.mjs` inside that consumer. Catches missing files, wrong exports, undeclared dependencies and
 * broken bins — none of which the source tests can see.
 *
 *   node scripts/verify-package.mjs packages/core
 *   node scripts/verify-package.mjs --all     # every package in scripts/packages.mjs, in order
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { PACKAGES } from './packages.mjs';

// `--all` walks the shared list rather than a chain of commands in package.json, which was one more hand-written
// copy of it. Each package runs in its own process, as it did before, so one package's temp tree and environment
// cannot leak into the next.
if (process.argv[2] === '--all') {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const name of PACKAGES) {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), join(root, 'packages', name)], {
      stdio: 'inherit',
    });
  }
  process.exit(0);
}

const packageDir = resolve(process.argv[2] ?? '');
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const tempRoot = await mkdtemp(join(tmpdir(), `${manifest.name.replace(/[@/]/g, '-')}-consumer-`));

// Nested package-manager commands must not inherit the parent run's npm_* variables, which describe this checkout.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')),
);

// pnpm and npm are .cmd shims on Windows, which only a shell can start. Passing an argument array together with a
// shell is deprecated (DEP0190) because the arguments are concatenated unescaped, so build one quoted command line.
function quoteForCmd(arg) {
  return /^[\w@+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

function run(command, args, cwd, extraEnv = {}) {
  const options = { cwd, env: { ...cleanEnv, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  if (process.platform === 'win32' && command !== process.execPath) {
    return execFileSync([command, ...args].map(quoteForCmd).join(' '), { ...options, shell: true });
  }
  return execFileSync(command, args, options);
}

/** Lists a .tgz in-process (ustar headers), so the check does not depend on which `tar` a platform provides. */
function readTarball(bytes) {
  const tar = gunzipSync(bytes);
  const entries = new Map();
  const text = (start, length) =>
    tar
      .subarray(start, start + length)
      .toString('utf8')
      .replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = text(offset, 100);
    if (!name) break;
    const prefix = text(offset + 345, 155);
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8);
    const path = prefix ? `${prefix}/${name}` : name;
    entries.set(path, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const { readdirSync } = await import('node:fs');

// Packed with the hook every publish passes, which records the commit as `gitHead`. The release skips a package
// already at its version only when that field names the tagged commit, so this is where a pnpm that stopped applying
// the hook is found: in verify, before a version goes out that no later run could match.
const recordGitHead = `--config.pnpmfile=${fileURLToPath(new URL('record-git-head.cjs', import.meta.url))}`;

/** Builds and packs one workspace package, returning the tarball under a name unique to this run. */
async function packPackage(directory, label) {
  const before = new Set(readdirSync(tempRoot).filter((name) => name.endsWith('.tgz')));
  run('pnpm', ['run', 'build'], directory);
  run('pnpm', ['pack', recordGitHead, '--pack-destination', tempRoot], directory);
  const packed = readdirSync(tempRoot).filter((name) => name.endsWith('.tgz') && !before.has(name));
  if (packed.length !== 1) throw new Error(`expected one new tarball for ${label}, found ${packed.length}`);
  // A unique path per run: npm caches local file: sources by name and version.
  const tarball = join(tempRoot, `${label}-${process.pid}-${Date.now()}.tgz`);
  await copyFile(join(tempRoot, packed[0]), tarball);
  return tarball;
}

/**
 * Packages in this workspace that the candidate depends on at runtime. They are not published yet, so a consumer
 * install has to be given their tarballs too — which also proves that what they export is what the candidate uses.
 */
async function packWorkspaceDependencies() {
  const declared = { ...manifest.dependencies, ...manifest.optionalDependencies };
  const tarballs = [];
  for (const [name, specifier] of Object.entries(declared)) {
    if (!String(specifier).startsWith('workspace:')) continue;
    const directory = resolve(packageDir, '..', name.split('/').pop());
    tarballs.push(await packPackage(directory, `dependency-${name.replace(/[@/]/g, '-')}`));
  }
  return tarballs;
}

try {
  const dependencyTarballs = await packWorkspaceDependencies();
  const tarball = await packPackage(packageDir, 'candidate');

  const entries = readTarball(await readFile(tarball));
  for (const required of ['package/package.json', 'package/LICENSE', 'package/README.md']) {
    if (!entries.has(required)) throw new Error(`tarball is missing ${required}`);
  }
  if ([...entries.keys()].some((path) => /^package\/(src|test)\//.test(path))) {
    throw new Error('tarball ships src/ or test/; check "files"');
  }
  const packedManifest = JSON.parse(entries.get('package/package.json').toString('utf8'));
  const deps = JSON.stringify({ ...packedManifest.dependencies, ...packedManifest.optionalDependencies });
  if (/workspace:|catalog:/.test(deps)) throw new Error(`unresolved workspace or catalog specifier: ${deps}`);
  const head = run('git', ['rev-parse', 'HEAD'], packageDir).trim();
  if (packedManifest.gitHead !== head) {
    throw new Error(
      `the packed manifest records gitHead ${packedManifest.gitHead}, not ${head}; the publish would too`,
    );
  }

  const consumer = await mkdtemp(join(tempRoot, 'consumer-'));
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(tempRoot, 'npm-cache'),
      ...dependencyTarballs,
      tarball,
    ],
    consumer,
  );
  const check = await readFile(join(packageDir, 'test', 'consumer-check.mjs'), 'utf8');
  await writeFile(join(consumer, 'consumer-check.mjs'), check);
  const output = run(process.execPath, ['consumer-check.mjs'], consumer, {
    AGENT_COMMS_CONFIG_DIR: join(tempRoot, 'config'),
  });
  process.stdout.write(output);
  /*
   * A check proves itself by its last line, not by its exit code.
   *
   * Exiting 0 only says nothing threw. Gmail's check printed nothing here for a whole release — its library reroutes
   * `console.log` to stderr, which this discards — and "printed nothing" reads exactly like "stopped half way and
   * exited cleanly". Each check ends by naming itself and OK; a run that never reaches that line fails here.
   */
  const unscoped = manifest.name.split('/').pop();
  if (!new RegExp(`^${unscoped} consumer check: .*\\bOK\\b`, 'm').test(output)) {
    throw new Error(
      `${manifest.name}: the consumer check exited without printing its "${unscoped} consumer check: … OK" line`,
    );
  }
  console.log(`package verification OK: ${manifest.name} (${basename(tarball)})`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
