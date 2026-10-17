import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serverFacts } from '../src/channel-servers.ts';
import { openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { findNpmCli, installManagedRuntime, managedRuntimeDir, reusableRuntime } from '../src/mcp-install.ts';
import { npmInstallGlobal } from '../src/npm.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * An update installs a runtime, and a global package, with npm told to run no package's install script (security
 * review of 0.20.0, severity 5): a script runs as the person, before anything checks that what npm installed is the
 * tarball whose provenance was verified.
 *
 * npm itself is run here, as an update runs it, against a registry on the loopback address serving one package of the
 * test's own, whose `preinstall`, `install` and `postinstall` scripts would each leave a file behind. Nothing reaches
 * npm's registry and no real package is installed.
 */

const VERSION = '99.0.0';
const GMAIL = serverFacts('gmail').packageName;
const SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

/** The package, packed by npm itself: a CLI, and a script for each install step that writes `ran-<step>` in `marks`. */
function packed(marks: string): { tarball: Buffer; manifest: Record<string, unknown> } {
  const source = tempDir('comms-install-scripts-package-');
  const scripts = Object.fromEntries(SCRIPTS.map((step) => [step, `node mark.cjs ${step}`]));
  const manifest = { name: GMAIL, version: VERSION, bin: { 'agent-gmail': './dist/cli.mjs' }, scripts };
  mkdirSync(join(source, 'dist'));
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(source, 'dist', 'cli.mjs'), 'process.exit(0);\n');
  writeFileSync(
    join(source, 'mark.cjs'),
    `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(marks)}, 'ran-' + process.argv[2]), '');\n`,
  );
  const out = tempDir('comms-install-scripts-packed-');
  return {
    tarball: (() => {
      const npm = spawnSync(process.execPath, [npmCliPath(), 'pack', '--pack-destination', out, '--silent'], {
        cwd: source,
        env: { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false' },
        encoding: 'utf8',
      });
      assert.equal(npm.status, 0, npm.stderr);
      const [file] = readdirSync(out).filter((name) => name.endsWith('.tgz'));
      return readFileSync(join(out, String(file)));
    })(),
    manifest,
  };
}

let npmCli = '';
const npmCliPath = () => npmCli;

/** A registry on the loopback address: the package's document, and its tarball. */
async function loopback(tarball: Buffer, manifest: Record<string, unknown>) {
  const asked: string[] = [];
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  let url = '';
  const server: Server = createServer((request, response) => {
    asked.push(request.url ?? '');
    if (request.url?.endsWith('.tgz')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tarball);
      return;
    }
    if (decodeURIComponent(request.url ?? '') !== `/${GMAIL}`) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const version = { ...manifest, hasInstallScript: true, dist: { tarball: `${url}gmail-${VERSION}.tgz`, integrity } };
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ name: GMAIL, 'dist-tags': { latest: VERSION }, versions: { [VERSION]: version } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    url,
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A home of the test's own, and npm pointed at the loopback registry with a cache and a prefix of its own. */
function machine(registry: string) {
  const home = tempDir('comms-install-scripts-');
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_SECRETS_DIR: join(home, 'secrets'),
    AGENT_COMMS_UPDATE_CHECK: 'off',
    npm_config_registry: registry,
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_prefix: join(home, 'npm-global'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  return { home, env, core: openCore({ env, caller: CORE_CALLER }) };
}

test('a runtime and a global package are installed with npm told to run no install script', async () => {
  try {
    npmCli = await findNpmCli();
  } catch {
    // No npm beside this Node: nothing installs a runtime here, and nothing can be shown.
    return;
  }
  const marks = tempDir('comms-install-scripts-marks-');
  const { tarball, manifest } = packed(marks);
  const served = await loopback(tarball, manifest);
  try {
    const m = machine(served.url);
    const installed = await installManagedRuntime(
      { env: m.env, core: m.core },
      { ...serverFacts('gmail'), version: VERSION, moduleUrl: '' },
      VERSION,
    );
    assert.equal(installed, await reusableRuntime(m.core.paths.dataDir, GMAIL, VERSION), 'the runtime is in place');
    assert.ok(existsSync(join(managedRuntimeDir(m.core.paths.dataDir, GMAIL, VERSION), 'package-lock.json')));
    assert.ok(
      served.asked.some((url) => url.endsWith('.tgz')),
      'npm fetched the tarball from the loopback registry',
    );
    assert.deepEqual(readdirSync(marks), [], 'no install script of the package ran');

    await npmInstallGlobal(m.env, `${GMAIL}@${VERSION}`);
    assert.deepEqual(readdirSync(marks), [], 'no install script ran for the global package either');
  } finally {
    await served.close();
  }
});

/*
 * What the install no longer runs, nothing published here needs: no package any published package depends on has an
 * install-time script (`preinstall`, `install`, `postinstall`) or a `binding.gyp`, which npm builds with an implicit
 * `node-gyp rebuild`. Read from this checkout's own install, which the lockfile fixes; a dependency added with one
 * fails here, before a release would install it without running it. (`prepare` runs only for a git or folder
 * dependency, never for one from the registry.)
 */
test('no package the published packages depend on needs an install script to work', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const resolveFrom = (dir: string, name: string): string | null => {
    for (let at = dir; ; at = dirname(at)) {
      const candidate = join(at, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
      if (dirname(at) === at) return null;
    }
  };
  const seen = new Set<string>();
  const needing: string[] = [];
  const walk = (dir: string) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const scripts = SCRIPTS.filter((step) => manifest.scripts?.[step] !== undefined);
    if (scripts.length > 0 || existsSync(join(dir, 'binding.gyp'))) {
      needing.push(`${manifest.name}@${manifest.version} (${scripts.join(', ') || 'binding.gyp'})`);
    }
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const found = resolveFrom(dir, name);
      // An optional dependency for another platform is not installed here, and is a prebuilt binary where it is.
      if (found !== null) walk(found);
    }
  };
  const published = readdirSync(join(root, 'packages')).filter((name) => {
    const manifest = join(root, 'packages', name, 'package.json');
    return (
      existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { private?: boolean }).private !== true
    );
  });
  for (const name of published) walk(realpathSync(join(root, 'packages', name)));
  assert.ok(seen.size > 50, `only ${seen.size} packages were read`);
  assert.deepEqual(needing, []);
});
