#!/usr/bin/env node
/**
 * Proves a package works as published: pack it the way it will be published (pnpm, so `workspace:` and `catalog:`
 * specifiers are rewritten), install the tarball into a fresh consumer with its own npm cache, then run the package's
 * `test/consumer-check.mjs` inside that consumer. Catches missing files, wrong exports, undeclared dependencies and
 * broken bins — none of which the source tests can see.
 *
 *   node scripts/verify-package.mjs packages/comms-core
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const packageDir = resolve(process.argv[2] ?? '');
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const tempRoot = await mkdtemp(join(tmpdir(), `${manifest.name.replace(/[@/]/g, '-')}-consumer-`));

// Nested package-manager commands must not inherit the parent run's npm_* variables, which describe this checkout.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')),
);

function run(command, args, cwd, extraEnv = {}) {
  return execFileSync(command, args, {
    cwd,
    env: { ...cleanEnv, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

try {
  run('pnpm', ['run', 'build'], packageDir);
  run('pnpm', ['pack', '--pack-destination', tempRoot], packageDir);
  const packed = (await import('node:fs')).readdirSync(tempRoot).filter((name) => name.endsWith('.tgz'));
  if (packed.length !== 1) throw new Error(`expected one tarball, found ${packed.length}`);
  // A unique path per run: npm caches local file: sources by name and version.
  const tarball = join(tempRoot, `candidate-${process.pid}-${Date.now()}.tgz`);
  await copyFile(join(tempRoot, packed[0]), tarball);

  const listing = run('tar', ['-tzf', tarball], tempRoot);
  for (const required of ['package/package.json', 'package/LICENSE', 'package/README.md']) {
    if (!listing.split('\n').includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  if (/package\/(src|test)\//.test(listing)) throw new Error('tarball ships src/ or test/; check "files"');
  const packedManifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json'], tempRoot));
  const deps = JSON.stringify({ ...packedManifest.dependencies, ...packedManifest.optionalDependencies });
  if (/workspace:|catalog:/.test(deps)) throw new Error(`unresolved workspace or catalog specifier: ${deps}`);

  const consumer = await mkdtemp(join(tempRoot, 'consumer-'));
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(tempRoot, 'npm-cache'), tarball],
    consumer,
  );
  const check = await readFile(join(packageDir, 'test', 'consumer-check.mjs'), 'utf8');
  await writeFile(join(consumer, 'consumer-check.mjs'), check);
  const output = run(process.execPath, ['consumer-check.mjs'], consumer, {
    AGENT_COMMS_CONFIG_DIR: join(tempRoot, 'config'),
  });
  process.stdout.write(output);
  console.log(`package verification OK: ${manifest.name} (${basename(tarball)})`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
