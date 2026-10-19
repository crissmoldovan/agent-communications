/**
 * The desktop app (`apps/desktop`) is a workspace package that is never published (desktop design DA2, DA8): it is
 * private, outside `PUBLISHABLE`, `PACKAGES` and the channel registry, so no release path, licence check or consumer
 * check walks it — and its version still moves with the repository's, which `scripts/sync-versions.mjs` writes into
 * its `package.json` and its `tauri.conf.json`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../scripts/channels.mjs';
import { HELD, PACKAGES, PUBLISHABLE } from '../scripts/packages.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = join(ROOT, 'apps', 'desktop');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('the desktop app is private and outside PUBLISHABLE and the registry', () => {
  const manifest = json(join(APP, 'package.json'));
  assert.equal(manifest.name, '@agentcomms/desktop');
  assert.equal(manifest.private, true, 'a private package is one npm refuses to publish');
  assert.equal(manifest.agentcomms, undefined, 'a package that declares nothing is no channel, library or service');
  assert.equal(manifest.publishConfig, undefined);
  for (const list of [PUBLISHABLE, PACKAGES, Object.keys(HELD)]) {
    assert.ok(!list.includes('desktop'), `${JSON.stringify(list)} names the desktop app`);
  }
  const registry = loadRegistry(ROOT);
  assert.ok(!registry.packages.includes('desktop'), 'the channel registry names the desktop app');
  // The registry reads `packages/` alone: the app is not found by being in the workspace.
  assert.ok(!JSON.stringify(registry).includes('apps/desktop'));
});

test("its package and tauri.conf.json are at the repository's version", () => {
  const version = json(join(ROOT, 'package.json')).version;
  assert.equal(json(join(APP, 'package.json')).version, version);
  const tauri = json(join(APP, 'src-tauri', 'tauri.conf.json'));
  assert.equal(tauri.version, version);
  assert.equal(tauri.identifier, 'com.cueplusplus.agentcomms');
  assert.equal(tauri.productName, 'Agent Comms');
  // The crate's own version is not the app's: Tauri reads tauri.conf.json, and the crate is never published.
  const cargo = readFileSync(join(APP, 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.match(cargo, /^name = "agentcomms-desktop"$/m);
  assert.match(cargo, /^version = "0\.0\.0"$/m);
  assert.match(cargo, /^publish = false$/m);
});
