/**
 * Laya's release rule (events E2 Task 10), on copies only: every test builds a disposable release root, and nothing
 * reaches a registry — the rebuild is given its tarball bytes, or refused before it could ask for any.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
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
import { BOUNDARY_RUNNER } from '../scripts/verify-laya-boundary-gate.mjs';
import { GATE_RUNNER, GATE_SUBJECT_FILES, GATE_WORKER_ENTRY } from '../scripts/verify-laya-quality-gate.mjs';
import {
  boundaryEvidence,
  codeOf,
  copyInto,
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
import { assertLoopbackSeal } from './helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

const exec = promisify(execFile);
const FIXTURES = join(ROOT, 'packages/events-daemon/test/fixtures/laya');
const BOTH = ['arm64', 'x64'];

/** Offered mode never asks the dormant question; a rule that did would be treating a real lock as the placeholder. */
function noDormantQuestion() {
  throw new Error('a real lock was treated as the placeholder');
}

/**
 * The gate, on a root, with every outside dependency a test's own: no registry, no real package list, and no GitHub
 * (the gate-run check's own loopback fake is `test/laya-gate-runs.test.mjs`'s).
 */
function gate(root, overrides = {}) {
  return layaReleaseGate({
    root,
    env: {},
    publishLists: async () => RELEASE_LISTS,
    availability: noDormantQuestion,
    rebuildLock: async (lockText) => lockText,
    verifyRuns: async () => [],
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
      join(root, 'packages/events-laya-runtime/gate/macos-boundary-v2.json'),
      '- [x] TCP, UDP, fetch and UDS denied\n',
    );
    assert.equal(await codeOf(() => gate(root)), 'LAYA_RELEASE_BOUNDARY');
  });
});

test("E2 release gate: the owner's manual macOS checklist is supplemental: no release check reads it, and in the evidence's place it is refused", async () => {
  const checklist = await readFile(join(ROOT, 'test/laya-manual-macos-checklist.md'), 'utf8');
  assert.match(checklist, /cannot satisfy the release gate/u, 'the checklist says plainly what it is not');
  assert.ok(
    checklist.includes('packages/events-laya-runtime/gate/macos-boundary-v2.json'),
    'and names the machine-produced boundary evidence that is the gate',
  );
  for (const file of [
    'scripts/laya-release-gate.mjs',
    'scripts/release.mjs',
    'scripts/verify-laya-boundary-gate.mjs',
    'scripts/verify-laya-quality-gate.mjs',
    '.github/workflows/release.yml',
    '.github/workflows/laya-quality-gate.yml',
  ])
    assert.doesNotMatch(await readFile(join(ROOT, file), 'utf8'), /manual-macos-checklist/u, `${file} never reads it`);
  await withOffered(async (root, metrics) => {
    await writeQualityReport(root, metrics, BOTH);
    await mkdir(join(root, 'packages/events-laya-runtime/gate'), { recursive: true });
    await writeFile(join(root, 'packages/events-laya-runtime/gate/macos-boundary-v2.json'), checklist);
    const refused = await refusalOf(() => gate(root));
    assert.equal(refused?.code, 'LAYA_RELEASE_BOUNDARY', 'the ticked checklist in the evidence’s place is refused');
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

test('E2 review round 1: a real lock whose results no recorded protected run wrote is refused, before the registry is asked', async () => {
  await withOffered(async (root, metrics) => {
    await evidenceFor(root, metrics);
    const order = [];
    let rebuilt = 0;
    const refusal = await refusalOf(() =>
      gate(root, {
        verifyQuality: (input) => order.push(['quality', input.architectures]),
        verifyBoundary: (input) => order.push(['boundary', input.architectures]),
        verifyRuns: async (input) => {
          order.push(['runs', input.architectures]);
          throw new Error('LAYA_GATE_RUN_DIGEST: laya-boundary-run.json of run 7 is not the committed boundary result');
        },
        rebuildLock: async (lockText) => {
          rebuilt += 1;
          return lockText;
        },
      }),
    );
    assert.equal(refusal?.code, 'LAYA_RELEASE_RUN');
    assert.match(refusal?.message ?? '', /LAYA_GATE_RUN_DIGEST/);
    assert.deepEqual(order, [
      ['quality', BOTH],
      ['boundary', BOTH],
      ['runs', BOTH],
    ]);
    assert.equal(rebuilt, 0, 'no registry request after a refused provenance check');
    // With the provenance shown, the release goes on to the rebuild.
    assert.deepEqual(await gate(root), { mode: 'offered', architectures: BOTH });
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
      layaReleaseGate({
        root,
        env: {},
        publishLists: async () => RELEASE_LISTS,
        availability: noDormantQuestion,
        verifyRuns: async () => [],
      }),
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
  // E2 review round 1 (A3): `actions: read` beside `contents: read`, for the gate-run check, and nothing more.
  assert.match(
    job,
    /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n {4}steps:\n/,
    'contents and actions read, and nothing else',
  );
  assert.doesNotMatch(job, /id-token|environment:|secrets\.|registry-url|NODE_AUTH_TOKEN/);
  assert.match(
    job,
    /\n {6}- name: Laya ships dormant, or with every gate's evidence\n {8}env:\n {10}AGENTCOMMS_LAYA_SUPPLY_CHAIN_GATE: '1'\n {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}\n {8}run: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts\/laya-release-gate\.mjs\n/,
  );
  assert.equal(job.split('github.token').length - 1, 1, 'only the gate step is handed the job token');
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

// ------------------------------------------------------------------------------------------------ end to end (E2 Task 13)

/*
 * The release rule end to end, on copied release states only: the release job's own gate command and the local release
 * script run as a release runs them, under the loopback seal, with `git`, `npm` and `pnpm` replaced by stand-ins that
 * record every call. Nothing here can reach a registry, the real workflow, a tag or a publish.
 */

const POSIX_ONLY = process.platform === 'win32' && 'the release tool stand-ins are POSIX shell scripts';
const SEAL_URL = pathToFileURL(join(ROOT, 'test/helpers/loopback-seal-preload.mjs')).href;
/** A reviewed-shaped real lock (E2 Task 2's fixture lock): anything but the placeholder needs every gate. */
const REAL_LOCK = 'packages/events-daemon/test/fixtures/laya/lock-expected.json';

/**
 * Phase E's two release gates and the release list, replaced in the copy: their own proofs are E3's and E13's and
 * `release-packages.test.mjs`'s; here the question is only where Laya's gate stands in a release.
 */
const RELEASE_STAND_INS = Object.freeze({
  'scripts/packages.mjs':
    "// The copied state's release list: the daemon alone.\nexport const SCOPE = '@agentcomms';\nexport const PUBLISHABLE = Object.freeze(['events-daemon']);\nexport const PACKAGES = Object.freeze(['events-daemon']);\n",
  'scripts/verify-events-phase-e-prerequisites.mjs':
    "// Phase E's prerequisite gate is proved by E3 and E13; this copy passes it.\nexport async function verifyPhaseEPrerequisites() {\n  return [];\n}\n",
  'scripts/verify-events-phase-e-tests.mjs':
    "// Phase E's strict-test gate is proved by E3 and E13; this copy passes it.\nexport async function verifyPhaseETestManifest() {\n  return [];\n}\n",
});

/** `git` on main and in step with its remote, `npm` signed in with nothing published, `pnpm` doing nothing. */
const TOOL_STAND_INS = Object.freeze({
  git: `case "$1 $2" in
  "status --porcelain") ;;
  "rev-parse --abbrev-ref") echo main ;;
  "rev-parse HEAD"|"rev-parse origin/main") echo 0000000000000000000000000000000000000013 ;;
esac`,
  npm: `case "$1" in
  whoami) echo synthetic-release-owner ;;
  *) exit 1 ;;
esac`,
  pnpm: 'exit 0',
});

function relativeImports(source) {
  return [...source.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)].map((match) => match[2]);
}

/** Copies one script and every relative module it reaches, as the release would load them, into `root`. */
async function copyModuleClosure(root, entry) {
  const pending = [entry];
  const copied = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (copied.has(file) || Object.hasOwn(RELEASE_STAND_INS, file)) continue;
    copied.add(file);
    await copyInto(root, [file]);
    for (const specifier of relativeImports(await readFile(join(ROOT, file), 'utf8'))) {
      const target = relative(ROOT, resolve(dirname(join(ROOT, file)), specifier));
      if (!target.split('/').includes('node_modules')) pending.push(target);
    }
  }
}

/**
 * A copied release state: this repository's release inputs, the shipped lock or `lock`, the Laya gate's modules (and
 * the local release's, with `release`), the installed modules linked, and the tool stand-ins on an otherwise empty PATH.
 */
async function releaseState({ lock, release = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'laya-release-e2e-'));
  await copyInto(root, ['package.json', '.github/workflows/release.yml', ...Object.values(SHIPPED)]);
  // What the gate's verifiers bind a candidate to: its subject, the worker with everything it imports, both runners.
  await copyInto(root, [...GATE_SUBJECT_FILES, GATE_RUNNER, BOUNDARY_RUNNER]);
  await copyModuleClosure(root, GATE_WORKER_ENTRY);
  await copyModuleClosure(root, 'scripts/laya-release-gate.mjs');
  if (release) await copyModuleClosure(root, 'scripts/release.mjs');
  for (const [path, text] of Object.entries(RELEASE_STAND_INS)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  if (lock !== undefined) await writeFile(join(root, SHIPPED.runtimeLock), await readFile(join(ROOT, lock)));
  for (const directory of ['', 'packages/events-daemon'])
    await symlink(await realpath(join(ROOT, directory, 'node_modules')), join(root, directory, 'node_modules'), 'dir');
  const bin = join(root, '.release-tools');
  const calls = join(bin, 'calls');
  await mkdir(bin, { recursive: true });
  for (const [tool, body] of Object.entries(TOOL_STAND_INS)) {
    await writeFile(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n${body}\n`);
    await chmod(join(bin, tool), 0o755);
  }
  const env = { PATH: bin, HOME: join(root, '.home'), TMPDIR: join(root, '.tmp') };
  await mkdir(env.HOME, { recursive: true });
  await mkdir(env.TMPDIR, { recursive: true });
  return {
    root,
    env,
    calls: async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean),
  };
}

/** Runs node with the loopback seal first; a non-zero exit is an answer, not a thrown error. */
async function sealedNode(args, { cwd, env }) {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', SEAL_URL, ...args], { cwd, env });
    return { status: 0, output: `${stdout}${stderr}`, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    const stdout = String(error.stdout ?? '');
    const stderr = String(error.stderr ?? '');
    return { status: error.code, output: `${stdout}${stderr}`, stdout, stderr };
  }
}

/** The release job's Laya step, read from the workflow: its command words after `node`, and its environment. */
async function layaJobStep(root) {
  const job = jobBlock(await readFile(join(root, '.github/workflows/release.yml'), 'utf8'), 'laya');
  const step =
    /\n {6}- name: Laya ships dormant, or with every gate's evidence\n {8}env:\n((?: {10}[A-Z_]+: (?:'[^']*'|\$\{\{ github\.token \}\})\n)+) {8}run: node ([^\n]+)\n/.exec(
      job,
    );
  assert.ok(step, 'the release job has its Laya gate step');
  // The job token is GitHub's to fill in; here it is a synthetic one that reaches nothing.
  const env = Object.fromEntries(
    [...step[1].matchAll(/ {10}([A-Z_]+): (?:'([^']*)'|\$\{\{ github\.token \}\})/g)].map((match) => [
      match[1],
      match[2] ?? 'synthetic-job-token',
    ]),
  );
  return { args: step[2].split(' '), env };
}

test("E2 release end to end: the release job's gate refuses a copied state shipping a real lock without gate evidence, before any registry request", {
  skip: POSIX_ONLY,
}, async () => {
  const refused = await releaseState({ lock: REAL_LOCK });
  try {
    const step = await layaJobStep(refused.root);
    assert.deepEqual(
      step.env,
      { AGENTCOMMS_LAYA_SUPPLY_CHAIN_GATE: '1', GITHUB_TOKEN: 'synthetic-job-token' },
      'the job hands the gate its owner-only rebuild, and its token for the gate-run check',
    );
    const result = await sealedNode(step.args, { cwd: refused.root, env: { ...refused.env, ...step.env } });
    assert.notEqual(
      result.status,
      0,
      `the step fails, so the publish job that needs it never starts\n${result.output}`,
    );
    assert.match(
      result.stderr,
      /^LAYA_RELEASE_QUALITY: .*QUALITY_GATE_ABSENT/u,
      'the missing aggregate evidence refuses first, before the rebuild that would ask the registry',
    );
    assert.doesNotMatch(result.output, /loopback seal refused/u, 'and nothing tried to reach a registry');
    assert.deepEqual(await refused.calls(), [], 'the gate runs no release tool');
  } finally {
    await removeRoot(refused.root);
  }
  const shipped = await releaseState();
  try {
    const step = await layaJobStep(shipped.root);
    const result = await sealedNode(step.args, { cwd: shipped.root, env: { ...shipped.env, ...step.env } });
    assert.equal(result.status, 0, result.output);
    assert.equal(
      result.stdout,
      'Laya release gate: the placeholder lock ships, so Laya stays unavailable on every platform\n',
      'the state as this repository ships it passes, dormant',
    );
  } finally {
    await removeRoot(shipped.root);
  }
});

test('E2 release end to end: the local release refuses a copied state shipping a real lock without gate evidence, before its verify and any publish', {
  skip: POSIX_ONLY,
}, async () => {
  const state = await releaseState({ lock: REAL_LOCK, release: true });
  try {
    const result = await sealedNode(['scripts/release.mjs'], { cwd: state.root, env: state.env });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Refusing to release:/u);
    assert.match(result.output, /the Laya release gate refused: LAYA_RELEASE_QUALITY: /u);
    assert.doesNotMatch(result.output, /loopback seal refused/u, 'nothing tried to reach a registry');
    const calls = await state.calls();
    assert.ok(calls.includes('npm whoami'), 'the release reached its own preflight checks');
    assert.deepEqual(
      calls.filter((call) => call.startsWith('pnpm ')),
      [],
      'it stopped before `pnpm verify` and before any `pnpm publish`',
    );
  } finally {
    await removeRoot(state.root);
  }
});

test('E2 release end to end: the local release rehearses the shipped placeholder state to its end, with Laya checked unavailable', {
  skip: POSIX_ONLY,
}, async () => {
  const state = await releaseState({ release: true });
  try {
    const result = await sealedNode(['scripts/release.mjs'], { cwd: state.root, env: state.env });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Laya: the placeholder lock ships, so Laya stays unavailable on every platform\./u);
    assert.match(result.output, /Nothing was published\./u);
    assert.deepEqual(
      (await state.calls()).filter((call) => call.startsWith('pnpm ')),
      ['pnpm verify'],
      'a rehearsal verifies and sends nothing',
    );
  } finally {
    await removeRoot(state.root);
  }
});
