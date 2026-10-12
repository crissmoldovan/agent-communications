import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { test } from 'node:test';

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// desktop-mutation: desktop-vite-evidence-after-rewrites
test('desktop repair: Vite evidence is recorded after every other plugin has rewritten its chunks', async () => {
  const { bundleGraphPlugin } = await import('../apps/desktop/scripts/bundle-content-graph.mjs');
  const plugin = bundleGraphPlugin();
  // Vite rewrites dynamic-import preload lists in its own generateBundle: evidence recorded earlier binds bytes that
  // are never written, and the final inventory check refuses every build that has a dynamic import.
  assert.equal(plugin.enforce, 'post');
  assert.equal(plugin.generateBundle.order, 'post');
  assert.equal(typeof plugin.generateBundle.handler, 'function');
});

// desktop-mutation: desktop-embedded-vite-content
test('desktop repair: embedded Vite assets are classified before packaging', async () => {
  const { bundleGraphPlugin, auditBundle, validateFrontendAssets } = await import(
    '../apps/desktop/scripts/bundle-content-graph.mjs'
  );
  const emit = (bytes) => {
    let emitted;
    bundleGraphPlugin().generateBundle.handler.call(
      {
        getModuleIds: () => ['synthetic-module'],
        getModuleInfo: () => ({ importedIds: [], dynamicallyImportedIds: [] }),
        emitFile: (entry) => {
          emitted = JSON.parse(entry.source);
        },
      },
      {},
      { 'renamed.dat': { type: 'asset', fileName: 'renamed.dat', source: bytes } },
    );
    return emitted;
  };
  const evidence = (vite) => ({
    version: 1,
    // The outer native binary is valid and contains compressed assets, not a plaintext model marker.
    files: [
      {
        path: 'agentcomms-desktop',
        sha256: 'a'.repeat(64),
        size: 32,
        type: 'executable',
        executable: true,
        provenance: 'tauri-executable',
      },
    ],
    graph: {
      cargo: [{ name: 'safe' }],
      pnpm: [{ name: 'safe' }],
      vite: vite.modules,
      viteAssets: vite.assets,
      tauri: { resources: ['../THIRD_PARTY_LICENSES'] },
    },
  });
  assert.doesNotThrow(() => auditBundle(evidence(emit(Buffer.from('synthetic safe frontend')))));
  assert.doesNotThrow(() => auditBundle(evidence(emit(Buffer.from('const synthetic = {node: 1, Node: 2};')))));
  assert.throws(
    () => auditBundle(evidence(emit(Buffer.from('import fs from "node:fs";')))),
    /forbidden embedded Vite content/,
  );
  // Actual ModelProto wire bytes: ir_version, GraphProto and opset_import; no filename/content string hint.
  for (const bytes of [Buffer.from([8, 8, 58, 0, 66, 2, 16, 13]), Buffer.from('GGUF\x03\0\0\0')]) {
    const vite = emit(bytes);
    assert.throws(() => auditBundle(evidence(vite)), /forbidden embedded Vite content/);
    assert.deepEqual(vite.assets[0].contentMarkers, ['model-container']);
    assert.equal(vite.assets[0].size, bytes.length);
    assert.equal(
      JSON.stringify(vite).includes(bytes.toString('base64')),
      false,
      'evidence stores metadata, not model bytes',
    );
  }
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'desktop-vite-fixture-'));
  try {
    const bytes = Buffer.from('synthetic safe frontend');
    const vite = emit(bytes);
    await writeFile(join(folder, 'renamed.dat'), bytes);
    await validateFrontendAssets(vite, folder);
    const altered = structuredClone(vite);
    altered.assets[0].size += 1;
    await assert.rejects(validateFrontendAssets(altered, folder), /classification mismatch/);
    await writeFile(join(folder, 'renamed.dat'), Buffer.from([8, 8, 58, 0, 66, 2, 16, 13]));
    await assert.rejects(validateFrontendAssets(vite, folder), /inventory mismatch/);
    await assert.rejects(
      validateFrontendAssets(emit(Buffer.from([8, 8, 58, 0, 66, 2, 16, 13])), folder),
      /forbidden embedded Vite content/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  assert.match(
    await read('apps/desktop/scripts/bundle-with-evidence.mjs'),
    /await validateFrontendAssets\(vite, dist\)/,
  );
});

// Bundle gate: ../apps/desktop/scripts/bundle-content-graph.mjs
// desktop-mutation: desktop-exact-tauri-metadata
test('desktop repair: only exact, non-executable Tauri metadata may carry a launcher', async () => {
  const { auditBundle, inspectContent } = await import('../apps/desktop/scripts/bundle-content-graph.mjs');
  const evidence = (file) => ({
    version: 1,
    platform: 'linux',
    files: [file],
    graph: {
      cargo: [{ name: 'safe', dependencies: [] }],
      pnpm: [{ name: 'safe', dependencies: [] }],
      vite: [{ id: 'safe', imports: [] }],
      viteAssets: [{ path: 'safe.txt', ...inspectContent(Buffer.from('synthetic safe frontend')) }],
      tauri: { resources: ['../THIRD_PARTY_LICENSES'] },
    },
  });
  const metadata = (path, text, executable = false) => ({
    path,
    ...inspectContent(Buffer.from(text)),
    executable,
    type: executable ? 'executable' : 'data',
    provenance: 'tauri-metadata',
  });

  assert.doesNotThrow(() =>
    auditBundle(evidence(metadata('usr/share/applications/Agent Communications.desktop', 'Exec=agentcomms-desktop'))),
  );
  assert.throws(
    () => auditBundle(evidence(metadata('usr/share/applications/helper.desktop', 'Exec=agentcomms-desktop'))),
    /metadata path/,
  );
  assert.throws(
    () => auditBundle(evidence(metadata('usr/share/applications/Agent Communications.desktop', 'Exec=node'))),
    /metadata launcher/,
  );
  assert.throws(
    () =>
      auditBundle(
        evidence(
          metadata('usr/share/applications/Agent Communications.desktop', 'Exec=agentcomms-desktop; agent-events'),
        ),
      ),
    /metadata launcher/,
  );
  assert.throws(
    () =>
      auditBundle(
        evidence(metadata('usr/share/applications/Agent Communications.desktop', 'Exec=agentcomms-desktop', true)),
      ),
    /metadata executable/,
  );
});

// Workflow under test: ../.github/workflows/desktop.yml
// desktop-mutation: desktop-native-display-safe
test('desktop repair: native webviews always have a Linux display', async () => {
  const workflow = JSON.parse(await read('.github/workflows/desktop.yml'));
  const native = workflow.jobs.verify.steps.find((step) => step.name === 'Native desktop proofs (Cargo)');
  assert.match(
    native.run,
    /if \[ "\$RUNNER_OS" = Linux \]; then\n {2}xvfb-run -a pnpm --filter @agentcomms\/desktop test:native\nelse\n {2}pnpm --filter @agentcomms\/desktop test:native\nfi/,
  );
});

// desktop-mutation: desktop-mutation-platform-applicability
test('desktop repair: platform applicability never counts a refusal as a kill', async () => {
  const { applicable } = await import('../apps/desktop/test/mutations/policy.mjs');
  const manifest = JSON.parse(await read('apps/desktop/test/mutations/manifest.json'));
  const windows = manifest.cases.filter((item) => applicable(item, 'win32'));
  assert.ok(windows.some((item) => item.id === 'desktop-windows-pre-read-refusal'));
  assert.ok(!windows.some((item) => item.id === 'desktop-production-path'));
  for (const item of manifest.cases) {
    assert.ok(Array.isArray(item.platforms), item.id);
    if (item.test.cargoTestPath === '--test supervisor_lifecycle') assert.ok(!applicable(item, 'win32'));
    if (!applicable(item, 'win32')) assert.match(item.platformReason, /Unix|Windows/);
  }
  assert.throws(() => applicable({ platforms: [] }, 'win32'), /platform/);
  const runner = await read('apps/desktop/test/mutations/run.mjs');
  assert.match(runner, /not applicable.*not killed/);
  assert.match(runner, /applicable\(item, process.platform\)/);
  assert.match(runner, /--test-reporter=tap/);
});

// desktop-mutation: desktop-resolved-runtime-edge-exclusion
test('desktop repair: forbidden bytes and all resolved dependency edges are checked', async () => {
  const { auditBundle, inspectContent } = await import('../apps/desktop/scripts/bundle-content-graph.mjs');
  const clean = {
    version: 1,
    files: [
      {
        path: 'renamed.dat',
        sha256: '0'.repeat(64),
        size: 32,
        provenance: 'vite-asset',
        executable: false,
        type: 'data',
      },
    ],
    graph: {
      cargo: [{ name: 'safe', dependencies: [] }],
      pnpm: [{ name: 'safe', dependencies: [] }],
      vite: [{ id: 'safe', imports: [] }],
      viteAssets: [{ path: 'safe.txt', ...inspectContent(Buffer.from('synthetic safe frontend')) }],
      tauri: { resources: ['../THIRD_PARTY_LICENSES'] },
    },
  };
  auditBundle(clean);
  // ModelProto: ir_version=8, graph(empty), opset_import(version=13). No filename/string hint.
  for (const bytes of [
    Buffer.from([8, 8, 58, 0, 66, 2, 16, 13]),
    Buffer.from('GGUF\x03\0\0\0'),
    Buffer.from('TFL3'),
    Buffer.from('node::Start'),
    Buffer.from('OrtGetApiBase'),
    Buffer.from('new Worker('),
    Buffer.from('@agentcomms/events-daemon'),
  ]) {
    const evidence = structuredClone(clean);
    Object.assign(evidence.files[0], inspectContent(bytes));
    assert.throws(() => auditBundle(evidence), /forbidden bundle content/);
  }
  for (const graph of ['cargo', 'pnpm'])
    for (const bad of ['node', 'node@22.0.0', 'node:fs', '@agentcomms/events-daemon']) {
      const evidence = structuredClone(clean);
      evidence.graph[graph][0].dependencies.push(bad);
      assert.throws(() => auditBundle(evidence), /forbidden resolved runtime dependency/);
      evidence.graph[graph][0] = { name: bad, dependencies: [] };
      assert.throws(() => auditBundle(evidence), /forbidden resolved runtime dependency/);
    }
});

// desktop-mutation: desktop-artifact-digest-binding
test('desktop repair: artifact binding is digest exact and universal metadata covers both targets', async () => {
  const { validateBinding, cargoPlatforms, inspectContent } = await import(
    '../apps/desktop/scripts/bundle-content-graph.mjs'
  );
  const files = [{ path: 'macos/synthetic.app/main', sha256: 'a'.repeat(64) }];
  const binding = {
    version: 1,
    buildId: 'synthetic-build',
    vite: {
      buildId: 'synthetic-build',
      modules: [{ id: 'safe', imports: [] }],
      assets: [{ path: 'safe.txt', ...inspectContent(Buffer.from('synthetic safe frontend')) }],
    },
    artifacts: files,
  };
  assert.doesNotThrow(() => validateBinding(binding, files));
  assert.throws(() => validateBinding(binding, [{ ...files[0], sha256: 'b'.repeat(64) }]), /artifact.*mismatch/);
  assert.throws(() => validateBinding({ ...binding, buildId: 'other' }, files), /build.*mismatch/);
  assert.deepEqual(cargoPlatforms('universal-apple-darwin'), ['aarch64-apple-darwin', 'x86_64-apple-darwin']);
  assert.deepEqual(cargoPlatforms('x86_64-pc-windows-msvc'), ['x86_64-pc-windows-msvc']);
  const module = await read('apps/desktop/scripts/bundle-content-graph.mjs');
  assert.doesNotMatch(module, /readFile\(join\(desktop, 'dist\/desktop-build-graph.json'/);
  const release = await read('.github/workflows/desktop-release.yml');
  assert.match(release, /DESKTOP_BUNDLE_PLATFORM=universal-apple-darwin/);
  assert.match(release, /bundle-with-evidence.mjs/);
});

// Mutation runner under test: ../apps/desktop/test/mutations/run.mjs
// desktop-mutation: desktop-mutation-build-isolation
test('desktop repair: Task 7 mutants isolate target frontend home and evidence', async () => {
  const { isolatedPaths } = await import('../apps/desktop/test/mutations/policy.mjs');
  const paths = isolatedPaths('/synthetic/mutation-copy');
  // The paths come from path.join, so the prefix does too: `\` on Windows.
  const copy = join('/synthetic/mutation-copy');
  for (const path of Object.values(paths)) assert.ok(path.startsWith(`${copy}${sep}`), path);
  const runner = await read('apps/desktop/test/mutations/run.mjs');
  assert.match(runner, /isolatedPaths\(temp\)/);
  assert.doesNotMatch(runner, /symlink\(join\(root, 'apps\/desktop\/dist'/);
  assert.match(runner, /HOME: isolation.home/);
  assert.match(runner, /CARGO_TARGET_DIR: isolation.target/);
  assert.match(runner, /DESKTOP_EVIDENCE_DIR: isolation.evidence/);
  assert.match(await read('apps/desktop/vite.config.ts'), /DESKTOP_DIST_DIR/);
});
