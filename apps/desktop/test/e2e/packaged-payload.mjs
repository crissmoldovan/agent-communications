import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditBundle, buildEvidence } from '../../scripts/bundle-content-graph.mjs';

const desktop = fileURLToPath(new URL('../../', import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const target = () => resolve(process.env.CARGO_TARGET_DIR ?? join(desktop, 'src-tauri/target'));

function oneArtifact(folder, extension) {
  const artifacts = readdirSync(folder).filter((name) => name.endsWith(extension));
  assert.equal(artifacts.length, 1, `expected one ${extension} bundle artifact`);
  return join(folder, artifacts[0]);
}

function ensurePayload(binary) {
  assert.ok(isAbsolute(binary), `packaged probe path must be absolute: ${binary}`);
  assert.ok(existsSync(binary), `packaged probe payload is missing: ${binary}`);
  return binary;
}

async function buildProbeBundle() {
  const build = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../scripts/bundle-with-evidence.mjs', import.meta.url)),
      '--',
      'pnpm',
      '--filter',
      '@agentcomms/desktop',
      'tauri:build',
      '--features',
      'no-egress-probe',
      '--no-sign',
      '--bundles',
      process.platform === 'darwin' ? 'app' : process.platform === 'win32' ? 'nsis' : 'deb',
    ],
    {
      cwd: root,
      env: { ...process.env, VITE_NO_EGRESS_PROBE: '1', CARGO_NET_OFFLINE: 'true' },
      stdio: 'inherit',
      timeout: 1_200_000,
      shell: process.platform === 'win32',
    },
  );
  assert.equal(build.status, 0, `test-feature release bundle build failed: ${build.error?.code ?? build.status}`);
  auditBundle(await buildEvidence());
}

/**
 * Returns the executable the package manager or installer payload ships. A direct Tauri release binary is never a
 * probe target: it omits the package layout that the test is responsible for validating.
 */
export async function preparePackagedPayload() {
  if (process.env.DESKTOP_PROBE_BINARY) {
    assert.ok(
      isAbsolute(process.env.DESKTOP_PROBE_BINARY),
      'DESKTOP_PROBE_BINARY must name an absolute shipped payload',
    );
    return { binary: ensurePayload(process.env.DESKTOP_PROBE_BINARY), cleanup: async () => {} };
  }

  await buildProbeBundle();
  const bundle = join(target(), 'release/bundle');
  if (process.platform === 'darwin') {
    return {
      binary: ensurePayload(join(bundle, 'macos/Agent Communications.app/Contents/MacOS/agentcomms-desktop')),
      cleanup: async () => {},
    };
  }

  const payload = mkdtempSync(join(tmpdir(), 'desktop-packaged-payload-'));
  if (process.platform === 'linux') {
    const deb = oneArtifact(join(bundle, 'deb'), '.deb');
    const extracted = spawnSync('dpkg-deb', ['-x', deb, payload], { stdio: 'inherit' });
    assert.equal(extracted.status, 0, 'could not extract packaged Debian payload');
    return {
      binary: ensurePayload(join(payload, 'usr/bin/agentcomms-desktop')),
      cleanup: async () => rmSync(payload, { recursive: true, force: true }),
    };
  }

  assert.equal(process.platform, 'win32', `unsupported packaged probe platform: ${process.platform}`);
  const installer = oneArtifact(join(bundle, 'nsis'), '.exe');
  const installed = spawnSync(installer, ['/S', `/D=${payload}`], { stdio: 'inherit', windowsHide: true });
  assert.equal(installed.status, 0, 'could not silently install packaged NSIS payload');
  const uninstaller = join(payload, 'uninstall.exe');
  return {
    binary: ensurePayload(join(payload, 'agentcomms-desktop.exe')),
    cleanup: async () => {
      assert.ok(existsSync(uninstaller), `installed NSIS payload has no uninstaller: ${uninstaller}`);
      const removed = spawnSync(uninstaller, ['/S'], { stdio: 'inherit', windowsHide: true });
      assert.equal(removed.status, 0, 'could not silently uninstall packaged NSIS payload');
      rmSync(payload, { recursive: true, force: true });
    },
  };
}
