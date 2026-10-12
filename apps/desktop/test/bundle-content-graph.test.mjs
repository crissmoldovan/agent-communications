import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { NATIVE_SKIP } from './helpers/native-lane.mjs';

// Bundle gate: ../scripts/bundle-content-graph.mjs
// desktop-mutation: desktop-bundle-content-dependency-graph
test('bundle-content-graph: content and provenance reject renamed forbidden payloads', {
  skip: NATIVE_SKIP,
}, async () => {
  const entry = new URL('../scripts/bundle-content-graph.mjs', import.meta.url);
  assert.ok(existsSync(entry), 'missing packaged-content and dependency-graph evidence');
  const { auditBundle, inspectContent } = await import(entry.href);
  // Real package collection is audited by full-production. This exact mutation test isolates
  // the detector, so a different undeclared packaged file cannot masquerade as its kill.
  const evidence = {
    version: 1,
    files: [
      {
        path: 'synthetic-safe.dat',
        ...inspectContent(Buffer.from('synthetic safe bytes')),
        executable: false,
        provenance: 'vite-asset',
      },
    ],
    graph: {
      cargo: [{ name: 'safe-cargo', dependencies: [] }],
      pnpm: [{ name: 'safe-pnpm', dependencies: [] }],
      vite: [{ id: 'safe-vite', imports: [] }],
      viteAssets: [{ path: 'safe.txt', ...inspectContent(Buffer.from('synthetic safe frontend')) }],
      tauri: { resources: ['../THIRD_PARTY_LICENSES'] },
    },
  };
  auditBundle(evidence);
  assert.ok(evidence.files.length > 0);
  for (const bytes of [
    Buffer.from('node::Start'),
    Buffer.from('@agentcomms/events-daemon'),
    Buffer.from('OrtGetApiBase'),
    Buffer.from('new Worker('),
    Buffer.from([8, 8, 58, 0, 66, 2, 16, 13]),
    Buffer.from('GGUF\x03\0\0\0'),
    Buffer.from([8, 0, 0, 0, 84, 70, 76, 51]),
  ]) {
    const changed = structuredClone(evidence);
    changed.files.push({
      path: 'resources/renamed.dat',
      ...inspectContent(bytes),
      executable: false,
      provenance: 'vite-asset',
    });
    assert.throws(() => auditBundle(changed), /forbidden bundle content/);
  }
  const changed = structuredClone(evidence);
  changed.graph.vite.push({ id: 'synthetic-safe-name', imports: ['node:fs'] });
  assert.throws(() => auditBundle(changed), /forbidden/);
  for (const graph of ['cargo', 'pnpm'])
    for (const dependency of ['node', 'node@22.0.0', 'node:fs']) {
      const injected = structuredClone(evidence);
      injected.graph[graph][0].dependencies.push(dependency);
      assert.throws(() => auditBundle(injected), /forbidden resolved runtime dependency/);
    }
});
