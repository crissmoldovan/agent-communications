#!/usr/bin/env node
/**
 * Proves a package works as published: pack it the way it will be published (pnpm, so `workspace:` and `catalog:`
 * specifiers are rewritten), install the tarball — with every workspace package it needs at runtime, packed the same
 * way — into a fresh consumer with its own npm cache and no registry for this suite's scope, then run the package's
 * `test/consumer-check.mjs` inside that consumer. Catches missing files, wrong exports, undeclared dependencies and
 * broken bins — none of which the source tests can see.
 *
 *   node scripts/verify-package.mjs packages/core
 *   node scripts/verify-package.mjs --all     # every publishable package in scripts/packages.mjs, in order
 */
import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { PUBLISHABLE, SCOPE } from './packages.mjs';

const readManifest = (directory) => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));

/**
 * Packages in this workspace that the candidate depends on at runtime, as `{ name, directory }`. They are not published
 * yet, so a consumer install has to be given their tarballs too — which also proves that what they export is what the
 * candidate uses.
 *
 * **Every level, not only the first.** The `workspace:` edges in `dependencies` and `optionalDependencies` are
 * followed into each package they name, and so on down. Only the candidate's own edges used to be packed, which was
 * enough while no package two levels down was this suite's; once every channel depended on core at runtime, verifying
 * `gmail-mcp` packed Gmail and left Gmail's core to npm. A package reached by two routes is packed once, and each comes
 * after everything it depends on — the order npm is then given them in.
 */
export function workspaceClosure(packageDir) {
  const ordered = [];
  const done = new Set();
  const visit = (directory, manifest, route) => {
    const declared = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(declared).sort()) {
      if (!String(declared[name]).startsWith('workspace:')) continue;
      const dependency = resolve(directory, '..', name.split('/').pop());
      if (route.some((step) => step.directory === dependency)) {
        const circle = [...route.slice(route.findIndex((step) => step.directory === dependency)), { name }];
        throw new Error(
          `workspace packages depend on each other in a circle: ${circle.map((s) => s.name).join(' → ')}`,
        );
      }
      if (done.has(dependency)) continue;
      const own = readManifest(dependency);
      if (own.name !== name) {
        throw new Error(`${manifest.name} depends on ${name}, and ${dependency} holds ${own.name}`);
      }
      visit(dependency, own, [...route, { name, directory: dependency }]);
      done.add(dependency);
      ordered.push({ name, directory: dependency });
    }
  };
  const candidate = readManifest(packageDir);
  visit(resolve(packageDir), candidate, [{ name: candidate.name, directory: resolve(packageDir) }]);
  return ordered;
}

// Run directly, verify. Imported — by the tests, for the closure above — do nothing.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) await main();

async function main() {
  // `--all` walks the shared list rather than a chain of commands in package.json, which was one more hand-written
  // copy of it — the wide one, so a package held back from release is consumer-checked like the rest. Each package
  // runs in its own process, as it did before, so one package's temp tree and environment cannot leak into the next.
  if (process.argv[2] === '--all') {
    const root = fileURLToPath(new URL('..', import.meta.url));
    for (const name of PUBLISHABLE) {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), join(root, 'packages', name)], {
        stdio: 'inherit',
      });
    }
    process.exit(0);
  }

  const packageDir = resolve(process.argv[2] ?? '');
  const manifest = readManifest(packageDir);
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

  /** `run`, without blocking this process: the consumer install talks to the registry below, which answers from here. */
  async function runAsync(command, args, cwd) {
    const options = { cwd, env: cleanEnv, encoding: 'utf8' };
    if (process.platform === 'win32') {
      return (await promisify(execFile)([command, ...args].map(quoteForCmd).join(' '), { ...options, shell: true }))
        .stdout;
    }
    return (await promisify(execFile)(command, args, options)).stdout;
  }

  /*
   * The registry the consumer install is given for this suite's scope, which has none of its packages.
   *
   * A package of this suite that npm cannot find among the tarballs it was handed is otherwise fetched from the real
   * registry, and the check then passes against the copy already published — Gmail's core, while only the direct
   * edges were packed, was core 0.13.0 from npm whatever this checkout held — or, for a version not out yet, fails
   * as though the package were broken. Here such an install fails instead, naming what it asked for.
   */
  async function refusingRegistry() {
    const asked = new Set();
    const server = createServer((request, response) => {
      asked.add(decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1)));
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: `this install takes ${SCOPE} packages from local tarballs only` }));
    });
    await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
    return {
      url: `http://127.0.0.1:${server.address().port}/`,
      asked,
      close: () => {
        server.closeAllConnections();
        return new Promise((closed) => server.close(closed));
      },
    };
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

  async function packWorkspaceDependencies() {
    const tarballs = [];
    for (const { name, directory } of workspaceClosure(packageDir)) {
      tarballs.push(await packPackage(directory, `dependency-${name.replace(/[@/]/g, '-')}`));
    }
    return tarballs;
  }

  try {
    const dependencyTarballs = await packWorkspaceDependencies();
    const tarball = await packPackage(packageDir, 'candidate');

    const entries = readTarball(await readFile(tarball));
    // THIRD_PARTY_LICENSES is the notice every bundled dependency's licence requires to travel with its code; a package
    // whose "files" dropped it would ship those dependencies in breach, and `verify:licenses` checks only the source.
    const mustShip = ['package/package.json', 'package/LICENSE', 'package/README.md', 'package/THIRD_PARTY_LICENSES'];
    for (const required of mustShip) {
      if (!entries.has(required)) throw new Error(`tarball is missing ${required}`);
    }
    if ([...entries.keys()].some((path) => /^package\/(src|test)\//.test(path))) {
      throw new Error('tarball ships src/ or test/; check "files"');
    }
    const packedManifest = JSON.parse(entries.get('package/package.json').toString('utf8'));
    const deps = JSON.stringify({ ...packedManifest.dependencies, ...packedManifest.optionalDependencies });
    if (/workspace:|catalog:/.test(deps)) throw new Error(`unresolved workspace or catalog specifier: ${deps}`);
    // A package of this suite depends on another at exactly its own version — lockstep, and a channel's handoffs must
    // name the core of its own release (design 2026-10-04, D4). `workspace:*` packs that way; `workspace:^` would not.
    for (const [name, range] of Object.entries({
      ...packedManifest.dependencies,
      ...packedManifest.optionalDependencies,
    })) {
      if (name.startsWith(`${SCOPE}/`) && range !== packedManifest.version) {
        throw new Error(`the packed manifest pins ${name} to "${range}", not exactly ${packedManifest.version}`);
      }
    }
    const head = run('git', ['rev-parse', 'HEAD'], packageDir).trim();
    if (packedManifest.gitHead !== head) {
      throw new Error(
        `the packed manifest records gitHead ${packedManifest.gitHead}, not ${head}; the publish would too`,
      );
    }

    const consumer = await mkdtemp(join(tempRoot, 'consumer-'));
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
    );
    const sealedDaemonConsumer = manifest.name === '@agentcomms/events-daemon';
    if (sealedDaemonConsumer) {
      await copyFile(
        fileURLToPath(new URL('../test/helpers/loopback-seal-preload.mjs', import.meta.url)),
        join(consumer, 'loopback-seal-preload.mjs'),
      );
    }
    const registry = await refusingRegistry();
    const install = (tarballs) =>
      runAsync(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--cache',
          join(tempRoot, 'npm-cache'),
          `--${SCOPE}:registry=${registry.url}`,
          ...tarballs,
        ],
        consumer,
      );
    try {
      /*
       * The workspace dependencies first, then the candidate. npm places a consumer's dependencies in name order, so a
       * candidate whose workspace dependency sorts after it (`@agentcomms/events-daemon` before `@agentcomms/gmail`)
       * was resolved while that tarball was not yet placed — and npm asked the registry for it. Installed already, the
       * dependency satisfies the candidate's exact pin, and every request still goes to the refusing registry.
       */
      if (dependencyTarballs.length > 0) await install(dependencyTarballs);
      await install([tarball]);
    } catch (error) {
      // Asking the registry is the failure to report; npm's own words for it are a 404 that names neither cause.
      if (registry.asked.size === 0) throw error;
    } finally {
      await registry.close();
    }
    if (registry.asked.size > 0) {
      throw new Error(
        `the consumer install asked a registry for ${[...registry.asked].join(', ')}: every ${SCOPE} package it ` +
          "needs must be one of this run's tarballs, or the check proves a published copy rather than this checkout",
      );
    }
    const check = await readFile(join(packageDir, 'test', 'consumer-check.mjs'), 'utf8');
    await writeFile(join(consumer, 'consumer-check.mjs'), check);
    const output = run(
      process.execPath,
      sealedDaemonConsumer ? ['--import', './loopback-seal-preload.mjs', 'consumer-check.mjs'] : ['consumer-check.mjs'],
      consumer,
      {
        AGENT_COMMS_CONFIG_DIR: join(tempRoot, 'config'),
        // The daily update check, off: a consumer check runs every command it tries against a temporary configuration,
        // and none of them asks the real npm registry or stops for a release (design 2026-09-28).
        AGENT_COMMS_UPDATE_CHECK: 'off',
      },
    );
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
}
