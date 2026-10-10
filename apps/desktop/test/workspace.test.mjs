import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../../', import.meta.url);
const desktopManifestUrl = new URL('../package.json', import.meta.url);
const desktopIgnoreUrl = new URL('../../../.gitignore', import.meta.url);
const rootManifestUrl = new URL('../../../package.json', import.meta.url);

// desktop-mutation: desktop-workspace-private
test('desktop is a private workspace member outside package publishing', async () => {
  const workspace = await readFile(new URL('pnpm-workspace.yaml', root), 'utf8');
  assert.match(workspace, /^\s*- apps\/\*\s*$/m);
  const manifest = JSON.parse(await readFile(desktopManifestUrl, 'utf8'));
  assert.equal(manifest.name, '@agentcomms/desktop');
  assert.equal(manifest.private, true);
  assert.equal(Object.hasOwn(manifest, 'agentcomms'), false);
  assert.equal(Object.hasOwn(manifest, 'agentcommsPackage'), false);
  assert.equal(Object.hasOwn(manifest.scripts, 'publish'), false);
  const published = execFileSync(process.execPath, ['scripts/packages.mjs'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(published, /\bdesktop\b/);
});

// desktop-mutation: desktop-root-verification
test('root verification reaches desktop build, typecheck, and unit tests', async () => {
  const rootManifest = JSON.parse(await readFile(rootManifestUrl, 'utf8'));
  const desktopManifest = JSON.parse(await readFile(desktopManifestUrl, 'utf8'));
  for (const script of ['build', 'typecheck', 'test']) {
    assert.match(rootManifest.scripts[script], /\.\/packages\/\*\*/);
    assert.match(rootManifest.scripts[script], /\.\/apps\/\*\*/);
    assert.ok(desktopManifest.scripts[script], `desktop ${script} script missing`);
  }
  assert.match(rootManifest.scripts.test, /loopback-seal-preload\.mjs/);
  assert.match(desktopManifest.scripts.build, /vite build/);
  assert.match(desktopManifest.scripts.typecheck, /tsc/);
  assert.match(
    desktopManifest.scripts.test,
    /node --experimental-strip-types --disable-warning=ExperimentalWarning --test/,
  );
  assert.match(rootManifest.scripts.verify, /verify:desktop-mutations/);
});

// desktop-mutation: desktop-lockfile-importer
test('desktop dependency graph is pinned by the workspace lockfile', async () => {
  const manifest = JSON.parse(await readFile(desktopManifestUrl, 'utf8'));
  const lockfile = await readFile(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8');
  const importerSection = lockfile.match(/^importers:\n([\s\S]*?)^packages:\n/m)?.[1];
  assert.ok(importerSection, 'lockfile importers section missing');
  const importer = importerSection.match(/^ {2}apps\/desktop:\n(?: {4}.*\n)*/m)?.[0];
  assert.ok(importer, 'desktop lockfile importer missing');

  for (const dependency of ['dependencies', 'devDependencies']) {
    for (const [name, specifier] of Object.entries(manifest[dependency] ?? {})) {
      const key = name.startsWith('@') ? `'${name}'` : name;
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(
        importer,
        new RegExp(`^      ${escapedKey}:\\n        specifier: ['"]?${escapedSpecifier}['"]?$`, 'm'),
        `${dependency} ${name} is not lockfile-pinned`,
      );
    }
  }
});

// desktop-mutation: desktop-capability-settings-tracked
test('desktop labelled capability files are present and Git-visible', async () => {
  const ignore = await readFile(desktopIgnoreUrl, 'utf8');
  assert.match(ignore, /!apps\/desktop\/src-tauri\/capabilities\/settings\.json/);
  for (const label of ['settings', 'secrets']) {
    const relative = `apps/desktop/src-tauri/capabilities/${label}.json`;
    const capability = JSON.parse(await readFile(new URL(`../src-tauri/capabilities/${label}.json`, import.meta.url)));
    assert.equal(capability.identifier, label);
    assert.deepEqual(capability.windows, [label]);
    assert.deepEqual(capability.permissions, []);
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--quiet', relative], { cwd: root });
    assert.equal(ignored.status, 1, `${relative} is ignored by Git or Git could not check it`);
  }
});
