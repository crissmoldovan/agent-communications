import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { NATIVE_SKIP } from './helpers/native-lane.mjs';

// Integration entry: ./e2e/full-production-probe.mjs
// Packaged adapter route: ../src/production-flow-probe.tsx
// desktop-mutation: desktop-production-path
test('full-flow: production adapter drives the compiled native boundary', {
  skip:
    NATIVE_SKIP ??
    (process.platform === 'win32'
      ? 'Unix control peer; Windows full-production separately proves WINDOWS_CONTROL_UNAVAILABLE'
      : undefined),
}, async () => {
  const entry = new URL('./e2e/full-production-probe.mjs', import.meta.url);
  assert.ok(existsSync(entry), 'missing full-production evidence gate');
  const { runControlFlow } = await import(entry.href);
  const evidence = await runControlFlow();
  if (process.platform === 'win32') {
    assert.equal(evidence.unavailable, 'WINDOWS_CONTROL_UNAVAILABLE');
    assert.equal(evidence.adapterCalls, 0);
    return;
  }
  assert.equal(evidence.adapterCalls, evidence.operations.length);
  assert.ok(evidence.adapterCalls > 30, 'complete B3 non-secret operation inventory');
  assert.equal(evidence.nativeCalls, evidence.adapterCalls);
  assert.deepEqual(evidence.egress, []);
});

// Production seam: ../src/screens/phase-seams.ts
// desktop-mutation: desktop-e2-seam-reason
test('full-flow: E and E2 states retain explicit unavailable reasons', async () => {
  const entry = new URL('./e2e/full-production-probe.mjs', import.meta.url);
  assert.ok(existsSync(entry), 'missing integrated E/E2 seam audit');
  const { auditPhaseSeams } = await import(entry.href);
  await auditPhaseSeams();
});

// The executable manifest is part of the CI gate: ./mutations/manifest.json
// desktop-mutation: desktop-mutation-completeness
test('full-flow: every required named mutation remains executable', async () => {
  const manifest = JSON.parse(await readFile(new URL('./mutations/manifest.json', import.meta.url), 'utf8'));
  for (const id of [
    'desktop-production-path',
    'desktop-e2-seam-reason',
    'desktop-bundle-content-dependency-graph',
    'desktop-release-hold',
    'desktop-mutation-completeness',
  ]) {
    const matches = manifest.cases.filter((item) => item.id === id);
    assert.equal(matches.length, 1, `missing or duplicate required mutation: ${id}`);
    assert.equal(matches[0].group, 'task-7');
    assert.equal(matches[0].test.kind, 'node');
    assert.ok(matches[0].test.name);
    assert.ok(matches[0].mutation.find !== matches[0].mutation.replace);
  }
});
