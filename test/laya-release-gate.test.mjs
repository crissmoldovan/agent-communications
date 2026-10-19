/**
 * Laya's release rule (events E2 Task 10), on copies only: every test builds a disposable release root, and nothing
 * reaches a registry — the rebuild is given its tarball bytes, or refused before it could ask for any.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  daemonDependencyClosure,
  LAYA_ASSETS,
  layaReleaseGate,
  lockArchitectures,
  OFFERED_TEMPLATES,
  PLACEHOLDER_LOCK,
  rebuildRuntimeLock,
  runtimeLockBuildInput,
} from '../scripts/laya-release-gate.mjs';
import { buildFixtureRuntimeLock, readPrivateRuntimeClosure } from '../scripts/laya-runtime-lock.mjs';
import {
  boundaryEvidence,
  codeOf,
  dormantRoot,
  offeredRoot,
  RELEASE_LISTS,
  ROOT,
  refusalOf,
  removeRoot,
  SHIPPED,
  writeBoundaryEvidence,
  writeQualityReport,
} from './helpers/laya-release-fixture.mjs';

const exec = promisify(execFile);
const FIXTURES = join(ROOT, 'packages/events-daemon/test/fixtures/laya');
const BOTH = ['arm64', 'x64'];

/** Offered mode never asks the dormant question; a rule that did would be treating a real lock as the placeholder. */
function noDormantQuestion() {
  throw new Error('a real lock was treated as the placeholder');
}

/** The gate, on a root, with every outside dependency a test's own: no registry, no real package list. */
function gate(root, overrides = {}) {
  return layaReleaseGate({
    root,
    env: {},
    publishLists: async () => RELEASE_LISTS,
    availability: noDormantQuestion,
    rebuildLock: async (lockText) => lockText,
    ...overrides,
  });
}

async function withOffered(run) {
  const { root, metrics } = await offeredRoot();
  try {
    return await run(root, metrics);
  } finally {
    await removeRoot(root);
  }
}

async function withDormant(run) {
  const root = await dormantRoot();
  try {
    return await run(root);
  } finally {
    await removeRoot(root);
  }
}

async function evidenceFor(root, metrics, architectures = BOTH) {
  await writeQualityReport(root, metrics, architectures);
  await writeBoundaryEvidence(root, boundaryEvidence(root, architectures));
}

// ------------------------------------------------------------------------------------------------ dormant

test('E2 release gate: the shipped placeholder lock releases with Laya checked unavailable on every platform', async () => {
  await withDormant(async (root) => {
    assert.equal(await readFile(join(root, LAYA_ASSETS.runtimeLock), 'utf8'), PLACEHOLDER_LOCK);
    const asked = [];
    const result = await gate(root, {
      availability: (_assets, platform) => {
        asked.push(`${platform.platform}-${platform.architecture}`);
        return { available: false, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' };
      },
    });
    assert.deepEqual(result, { mode: 'dormant' });
    assert.deepEqual(asked, ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
    // Through the daemon's own parser, the shipped definition refuses on its own: no stand-in answers for it.
    assert.deepEqual(await layaReleaseGate({ root, env: {}, publishLists: async () => RELEASE_LISTS }), {
      mode: 'dormant',
    });
  });
});

test('E2 release gate: a placeholder the shipped definition does not refuse stops the release', async () => {
  await withDormant(async (root) => {
    for (const answer of [{ available: true }, { available: false, code: 'LAYA_SANDBOX_UNAVAILABLE' }]) {
      assert.equal(
        await codeOf(() => gate(root, { availability: () => answer })),
        'LAYA_RELEASE_NOT_DORMANT',
        JSON.stringify(answer),
      );
    }
  });
});

test('E2 release gate: any lock but the exact placeholder bytes needs every gate', async () => {
  await withDormant(async (root) => {
    // The same fields, written differently: not the placeholder, and not a reviewed lock either.
    await writeFile(
      join(root, LAYA_ASSETS.runtimeLock),
      '{"schemaVersion":1,"blocked":"E2_EXTERNAL_REFERENCE_BLOCKED"}\n',
    );
    assert.equal(await codeOf(() => gate(root)), 'LAYA_RELEASE_LOCK');
  });
  await withOffered(async (root) => {
    const refused = await refusalOf(() => gate(root));
    assert.equal(refused?.code, 'LAYA_RELEASE_QUALITY', 'a real lock with no evidence does not release');
    assert.match(refused.message, /QUALITY_GATE_ABSENT/);
  });
});

// ------------------------------------------------------------------------------------------------ the offer

test('E2 release gate: the release offers exactly laya-noul-v1', async () => {
  assert.deepEqual(OFFERED_TEMPLATES, ['laya-noul-v1']);
  await withDormant(async (root) => {
    // The worker's two templates, as the fixture manifest lists them: the choice template waits for its own task.
    await writeFile(join(root, SHIPPED.manifest), await readFile(join(FIXTURES, 'manifest-tiny-v1.json')));
    assert.equal(
      await codeOf(() =>
        gate(root, { availability: () => ({ available: false, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' }) }),
      ),
      'LAYA_RELEASE_TEMPLATES',
    );
  });
  const shipped = JSON.parse(await readFile(join(ROOT, SHIPPED.manifest), 'utf8'));
  assert.deepEqual(shipped.promptTemplates, ['laya-noul-v1']);
});

// ------------------------------------------------------------------------------------------------ the real lock

test('E2 release gate: a real lock with every gate passing releases on the architectures it offers', async () => {
  await withOffered(async (root, metrics) => {
    await evidenceFor(root, metrics);
    const rebuilt = [];
    const result = await gate(root, {
      rebuildLock: async (lockText) => {
        rebuilt.push(lockText);
        return lockText;
      },
    });
    assert.deepEqual(result, { mode: 'offered', architectures: BOTH });
    assert.deepEqual(
      rebuilt,
      [await readFile(join(root, LAYA_ASSETS.runtimeLock), 'utf8')],
      'the lock is rebuilt once',
    );
  });
});

test('E2 release gate: a real lock without passing quality evidence is refused', async () => {
  await withOffered(async (root, metrics) => {
    await writeBoundaryEvidence(root, boundaryEvidence(root, BOTH));
    const absent = await refusalOf(() => gate(root));
    assert.equal(absent?.code, 'LAYA_RELEASE_QUALITY');
    assert.match(absent.message, /QUALITY_GATE_ABSENT/);
    const path = await writeQualityReport(root, metrics, BOTH);
    const report = JSON.parse(await readFile(path, 'utf8'));
    for (const channel of report.architectures[1].templates[0].channels) {
      channel.auroc = 0.5;
      channel.passed = false;
    }
    report.architectures[1].templates[0].passed = false;
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    const failed = await refusalOf(() => gate(root));
    assert.equal(failed?.code, 'LAYA_RELEASE_QUALITY');
    assert.match(failed.message, /QUALITY_GATE_FAILED: laya-noul-v1 did not pass on x64/);
  });
});

test('E2 release gate: a real lock without passing real-Mac boundary evidence is refused', async () => {
  await withOffered(async (root, metrics) => {
    await writeQualityReport(root, metrics, BOTH);
    const absent = await refusalOf(() => gate(root));
    assert.equal(absent?.code, 'LAYA_RELEASE_BOUNDARY');
    assert.match(absent.message, /BOUNDARY_GATE_ABSENT/);
    await writeBoundaryEvidence(root, boundaryEvidence(root, BOTH, { checks: { arm64: { udp: 'fail' } } }));
    const failed = await refusalOf(() => gate(root));
    assert.equal(failed?.code, 'LAYA_RELEASE_BOUNDARY');
    assert.match(failed.message, /BOUNDARY_GATE_FAILED: the boundary run did not pass on arm64/);
    // A checklist, or the quality report, in the evidence's place is not evidence.
    await writeFile(
      join(root, 'packages/events-laya-runtime/gate/macos-boundary-v1.json'),
      '- [x] TCP, UDP, fetch and UDS denied\n',
    );
    assert.equal(await codeOf(() => gate(root)), 'LAYA_RELEASE_BOUNDARY');
  });
});

test('E2 release gate: every architecture the lock offers needs its own evidence', async () => {
  await withOffered(async (root, metrics) => {
    assert.deepEqual(lockArchitectures(await readFile(join(root, LAYA_ASSETS.runtimeLock), 'utf8')), BOTH);
    await evidenceFor(root, metrics, ['arm64']);
    const refused = await refusalOf(() => gate(root));
    assert.equal(refused?.code, 'LAYA_RELEASE_QUALITY', 'arm64 evidence never authorises x64');
    assert.match(refused.message, /no gate evidence exists for x64/);
    // A lock whose Intel file lists are empty offers arm64 alone, and needs arm64's evidence alone.
    const lockPath = join(root, LAYA_ASSETS.runtimeLock);
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    for (const pkg of lock.packages) pkg.files['darwin-x64'] = [];
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    assert.deepEqual(lockArchitectures(await readFile(lockPath, 'utf8')), ['arm64']);
    await evidenceFor(root, metrics, ['arm64']);
    assert.deepEqual(await gate(root), { mode: 'offered', architectures: ['arm64'] });
  });
});

test('E2 release gate: a lock that does not rebuild byte for byte from its registry tarballs is refused', async () => {
  await withOffered(async (root, metrics) => {
    await evidenceFor(root, metrics);
    const drifted = await refusalOf(() => gate(root, { rebuildLock: async (lockText) => lockText.replace('1', '2') }));
    assert.equal(drifted?.code, 'LAYA_RELEASE_LOCK_DRIFT');
    const unbuilt = await refusalOf(() =>
      gate(root, {
        rebuildLock: async () => {
          throw Object.assign(new Error('refused'), { code: 'RUNTIME_SRI' });
        },
      }),
    );
    assert.equal(unbuilt?.code, 'LAYA_RELEASE_LOCK');
    assert.match(unbuilt.message, /RUNTIME_SRI/);
  });
});

test('E2 release gate: the real rebuild needs the owner-only acquirer, and asks the registry nothing without it', async () => {
  await withOffered(async (root, metrics) => {
    await evidenceFor(root, metrics);
    // The production rebuild: without the owner's flag there is no acquirer, so nothing is requested.
    const refused = await refusalOf(() =>
      layaReleaseGate({ root, env: {}, publishLists: async () => RELEASE_LISTS, availability: noDormantQuestion }),
    );
    assert.equal(refused?.code, 'LAYA_RELEASE_LOCK');
    assert.match(refused.message, /RUNTIME_LOCK_INPUT/);
  });
});

test('E2 release gate: the rebuild input read back from a lock rebuilds that lock byte for byte', async () => {
  const expected = await readFile(join(FIXTURES, 'lock-expected.json'), 'utf8');
  const input = runtimeLockBuildInput(expected);
  const archives = new Map();
  for (const pkg of input.packages)
    archives.set(
      `${pkg.name}@${pkg.version}`,
      await readFile(join(FIXTURES, 'lock-input', `${pkg.name}-${pkg.version}.tgz`)),
    );
  assert.equal(await buildFixtureRuntimeLock(input, archives), expected);
  assert.deepEqual(Object.keys(input.platforms), ['darwin-arm64', 'darwin-x64']);
});

/** A lock over the reviewed 19-package closure with one tiny file each: enough to reach the builder's closure check. */
async function closureLock(change = (packages) => packages) {
  const closure = readPrivateRuntimeClosure(await readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8'));
  const file = { path: 'package.json', size: 1, sha256: 'a'.repeat(64), executable: false };
  const packages = change(closure.map((entry) => ({ ...entry }))).map((entry) => ({
    ...entry,
    files: { 'darwin-arm64': [file], 'darwin-x64': [file] },
  }));
  return `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`;
}

test('E2 release gate: a lock whose tarball URL or SRI drifted is refused before any tarball is requested', async () => {
  const requested = [];
  const acquire = async (metadata) => {
    requested.push(metadata.name);
    throw Object.assign(new Error('the test acquirer serves nothing'), { code: 'TEST_ACQUIRER' });
  };
  // The reviewed closure reaches the acquirer: the stand-in refuses the first tarball it is asked for.
  assert.equal(await codeOf(async () => rebuildRuntimeLock(await closureLock(), { acquire })), 'TEST_ACQUIRER');
  assert.ok(requested.length > 0);
  requested.length = 0;
  const drifted = [
    (packages) =>
      packages.map((entry, index) => (index === 3 ? { ...entry, integrity: `sha512-${'A'.repeat(86)}==` } : entry)),
    (packages) =>
      packages.map((entry, index) =>
        index === 3 ? { ...entry, version: '9.9.9', url: entry.url.replace(entry.version, '9.9.9') } : entry,
      ),
  ];
  for (const change of drifted) {
    assert.equal(
      await codeOf(async () => rebuildRuntimeLock(await closureLock(change), { acquire })),
      'RUNTIME_EVIDENCE',
    );
  }
  assert.deepEqual(requested, [], 'nothing was requested for a drifted lock');
});

// ------------------------------------------------------------------------------------------------ the package audit

test("E2 release gate: no Laya or ONNX package may enter the daemon's published dependencies", async () => {
  const closure = daemonDependencyClosure(await readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8'));
  assert.ok(closure.includes('@agentcomms/core') && closure.includes('zod'), 'the walk follows workspace links');
  assert.deepEqual(
    closure.filter((name) => /onnx|laya|tokenizers/i.test(name)),
    [],
  );
  await withDormant(async (root) => {
    const answer = { availability: () => ({ available: false, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' }) };
    const lockfile = join(root, SHIPPED.lockfile);
    const original = await readFile(lockfile, 'utf8');
    // ONNX Runtime reaching the daemon through core, a workspace package it links.
    await writeFile(
      lockfile,
      original.replace(
        '  packages/core:\n    dependencies:\n',
        '  packages/core:\n    dependencies:\n      onnxruntime-node:\n        specifier: 1.30.0\n        version: 1.30.0\n',
      ),
    );
    const transitive = await refusalOf(() => gate(root, answer));
    assert.equal(transitive?.code, 'LAYA_RELEASE_AUDIT');
    assert.match(transitive.message, /the published daemon would install onnxruntime-common, onnxruntime-node$/);
    // Declared by the daemon itself.
    await writeFile(lockfile, original);
    const daemonPath = join(root, SHIPPED.daemon);
    const daemon = JSON.parse(await readFile(daemonPath, 'utf8'));
    await writeFile(
      daemonPath,
      JSON.stringify({ ...daemon, optionalDependencies: { '@receptron/laya': '0.1.2' } }, null, 2),
    );
    assert.equal(await codeOf(() => gate(root, answer)), 'LAYA_RELEASE_AUDIT');
  });
});

test('E2 release gate: the private runtime declaration is never published', async () => {
  await withDormant(async (root) => {
    const answer = { availability: () => ({ available: false, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' }) };
    for (const lists of [
      { publishable: ['core', 'events-laya-runtime'], packages: ['core'] },
      { publishable: ['core'], packages: ['core', 'events-laya-runtime'] },
    ]) {
      const refused = await refusalOf(() => gate(root, { ...answer, publishLists: async () => lists }));
      assert.equal(refused?.code, 'LAYA_RELEASE_AUDIT');
      assert.match(refused.message, /the private Laya runtime declaration is in a release list/);
    }
    const runtimePath = join(root, SHIPPED.runtime);
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    const { private: _private, ...published } = runtime;
    await writeFile(runtimePath, JSON.stringify(published, null, 2));
    assert.equal(await codeOf(() => gate(root, answer)), 'LAYA_RELEASE_AUDIT');
  });
});

test('E2 release gate: this repository passes as dormant, through the command the release job runs', async () => {
  const { stdout } = await exec(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'scripts/laya-release-gate.mjs'],
    { cwd: ROOT, env: { ...process.env, AGENTCOMMS_LAYA_SUPPLY_CHAIN_GATE: '' } },
  );
  assert.equal(stdout, 'Laya release gate: the placeholder lock ships, so Laya stays unavailable on every platform\n');
});

// ------------------------------------------------------------------------------------------------ where it runs

/** One top-level job of a workflow, by its key, up to the next job. */
function jobBlock(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('E2 release gate workflow: the publish needs the Laya release gate, which holds no publish credential', async () => {
  const workflow = await readFile(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const job = jobBlock(workflow, 'laya');
  assert.ok(job, 'there is a laya job');
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {4}steps:\n/, 'contents: read, and nothing else');
  assert.doesNotMatch(job, /id-token|environment:|secrets\.|registry-url|NODE_AUTH_TOKEN/);
  assert.match(
    job,
    /\n {6}- name: Laya ships dormant, or with every gate's evidence\n {8}env:\n {10}AGENTCOMMS_LAYA_SUPPLY_CHAIN_GATE: '1'\n {8}run: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts\/laya-release-gate\.mjs\n/,
  );
  assert.ok(
    job.indexOf("pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime'") <
      job.indexOf('scripts/laya-release-gate.mjs'),
  );
  const publish = jobBlock(workflow, 'publish');
  const needs =
    /\n {4}needs: \[([^\]]*)\]\n/
      .exec(publish)?.[1]
      .split(',')
      .map((need) => need.trim()) ?? [];
  assert.ok(needs.includes('laya'), 'the publish job, and so the OIDC preflight and every publish, waits for it');
  // Only this job may hand the rebuild the owner-only acquirer.
  assert.equal(workflow.split('AGENTCOMMS_LAYA_SUPPLY_CHAIN_GATE').length - 1, 1);
  assert.doesNotMatch(jobBlock(workflow, 'laya'), /if: \$\{\{ inputs\.dry-run/, 'a dry run runs it too');
});

test('E2 release gate: the local release runs the same gate before its verify and before anything is sent', async () => {
  const script = await readFile(join(ROOT, 'scripts/release.mjs'), 'utf8');
  // Loaded only once both Phase-E gates have passed, so a refused Phase-E gate stops the release first.
  assert.match(script, /\n {2}const \{ layaReleaseGate \} = await import\('\.\/laya-release-gate\.mjs'\);\n/);
  assert.doesNotMatch(script, /^import .*laya-release-gate/m);
  const call = script.indexOf('await layaReleaseGate(');
  assert.notEqual(call, -1, 'the local release calls the gate');
  assert.ok(script.indexOf("await requirePhaseEGate('Phase-E strict-test gate'") < call);
  // A refusal is one of the release's refusals, which stop it before the verify and every publish.
  assert.match(script, /\} catch \(error\) \{\n {2}refuse\(\n {4}`the Laya release gate refused: /);
  for (const later of ['if (failures.length > 0) {', "runLoud('pnpm', ['verify'])", "'publish',"]) {
    assert.ok(call < script.indexOf(later), `the gate runs before ${later}`);
  }
});
