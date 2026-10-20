/**
 * The real-Mac boundary gate (events E2 Task 10): its content-free evidence, its validator, its runner's refusals and
 * writes, and the protected workflow that runs it. Every test works on a disposable candidate root; the runner is given
 * stand-ins for the Mac it would run on, so nothing here starts a worker, loads a model or opens a connection.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import {
  BUILT_WORKER_ENTRY,
  EGRESS_PROBES,
  egressCheck,
  runBoundaryGate,
  runProductionChecks,
} from '../scripts/run-laya-macos-boundary-gate.mjs';
import {
  BOUNDARY_CHECKS,
  BOUNDARY_EVIDENCE,
  BOUNDARY_SCHEMA,
  boundaryPassed,
  canonicalEvidenceBytes,
  computeBoundaryCandidate,
  parseEvidenceBytes,
  validateBoundaryEvidence,
  verifyBoundaryGate,
} from '../scripts/verify-laya-boundary-gate.mjs';
import { RUN_COPIES } from '../scripts/verify-laya-gate-runs.mjs';
import {
  boundaryEvidence,
  codeOf,
  dormantRoot,
  offeredRoot,
  passingChecks,
  ROOT,
  removeRoot,
  writeBoundaryEvidence,
} from './helpers/laya-release-fixture.mjs';
import { assertLoopbackSeal } from './helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

/**
 * E2 CI round 1: every test here that starts or awaits a child, a listener, an owner or a worker has a bound of its own.
 * `node --test` has none, and Node 24 keeps a test whose awaited promise never settles pending for ever (Node 22
 * cancels it once the event loop drains): a hang must fail in minutes, not at the job limit hours later.
 */
const CHILD_TEST_TIMEOUT_MS = 120_000;

const BOTH = ['arm64', 'x64'];
const TREES = { runtimeTree: '/nonexistent/laya-runtime-tree', modelTree: '/nonexistent/laya-model-tree' };

async function withOffered(run) {
  const { root } = await offeredRoot();
  try {
    return await run(root);
  } finally {
    await removeRoot(root);
  }
}

function candidatesFor(root, architectures = BOTH) {
  return Object.fromEntries(
    architectures.map((architecture) => [architecture, computeBoundaryCandidate({ root, architecture })]),
  );
}

/** A Mac the runner believes in: native, with a working sandbox and the candidate's trees, every check passing. */
function standinMac(overrides = {}) {
  const calls = { runChecks: 0 };
  return {
    calls,
    dependencies: {
      translated: () => false,
      macosVersion: () => '14.5',
      sandboxAvailable: () => true,
      verifyTrees: async () => true,
      runChecks: async () => {
        calls.runChecks += 1;
        return passingChecks();
      },
      connects: async () => false,
      ...overrides,
    },
  };
}

function runOn(root, dependencies, options = {}) {
  return runBoundaryGate(
    { root, platform: 'darwin', architecture: 'arm64', node: '22.18.0', macos: '14.5', ...TREES, ...options },
    dependencies,
  );
}

async function filesBelow(directory) {
  const found = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) found.push(relative(directory, join(entry.parentPath, entry.name)).split('\\').join('/'));
  }
  return found.sort();
}

// ------------------------------------------------------------------------------------------------ the evidence

test('E2 macOS boundary gate: evidence bound to another candidate is refused', async () => {
  await withOffered(async (root) => {
    const candidates = candidatesFor(root);
    const good = boundaryEvidence(root, BOTH);
    assert.doesNotThrow(() => validateBoundaryEvidence(good, { candidates }));
    const other = 'e'.repeat(64);
    for (const change of [
      (evidence) => ({ ...evidence, manifestSha256: other }),
      (evidence) => ({ ...evidence, runtimeLockSha256: other }),
      (evidence) => ({ ...evidence, runnerSha256: other }),
      (evidence) => ({ ...evidence, manifestId: 'laya-en-onnx-another' }),
      (evidence) => ({
        ...evidence,
        architectures: evidence.architectures.map((entry) => ({ ...entry, platformFileListDigest: other })),
      }),
      (evidence) => ({
        ...evidence,
        architectures: evidence.architectures.map((entry) => ({ ...entry, subjectDigest: other })),
      }),
    ]) {
      assert.equal(
        await codeOf(() => validateBoundaryEvidence(change(good), { candidates })),
        'BOUNDARY_EVIDENCE_CANDIDATE',
      );
    }
    // A worker source changed after the run is another subject: the evidence no longer names it.
    await writeBoundaryEvidence(root, good);
    await writeFile(join(root, 'packages/events-daemon/src/runtime/laya/worker-main.ts'), '// another worker\n');
    assert.equal(
      await codeOf(() => verifyBoundaryGate({ root, architectures: ['arm64'] })),
      'BOUNDARY_EVIDENCE_CANDIDATE',
    );
  });
});

test('E2 macOS boundary gate: arm64 evidence never authorises x64', async () => {
  await withOffered(async (root) => {
    await writeBoundaryEvidence(root, boundaryEvidence(root, ['arm64']));
    assert.doesNotThrow(() => verifyBoundaryGate({ root, architectures: ['arm64'] }));
    assert.equal(await codeOf(() => verifyBoundaryGate({ root, architectures: BOTH })), 'BOUNDARY_GATE_ABSENT');
    assert.equal(await codeOf(() => verifyBoundaryGate({ root, architectures: ['x64'] })), 'BOUNDARY_GATE_ABSENT');
    assert.equal(await codeOf(() => verifyBoundaryGate({ root, architectures: [] })), 'BOUNDARY_GATE_ABSENT');
  });
});

test('E2 macOS boundary gate: a passing verdict its checks do not give is refused', async () => {
  await withOffered(async (root) => {
    const candidates = candidatesFor(root, ['arm64']);
    const [entry] = boundaryEvidence(root, ['arm64']).architectures;
    const evidence = (changed) => ({ ...boundaryEvidence(root, ['arm64']), architectures: [{ ...entry, ...changed }] });
    const failing = { ...passingChecks(), uds: 'fail' };
    assert.equal(
      await codeOf(() => validateBoundaryEvidence(evidence({ checks: failing, passed: true }), { candidates })),
      'BOUNDARY_EVIDENCE_VERDICT',
    );
    assert.equal(
      await codeOf(() => validateBoundaryEvidence(evidence({ passed: false }), { candidates })),
      'BOUNDARY_EVIDENCE_VERDICT',
    );
  });
});

test('E2 macOS boundary gate: one failed check fails the architecture', async () => {
  assert.equal(boundaryPassed(passingChecks()), true);
  await withOffered(async (root) => {
    for (const name of BOUNDARY_CHECKS) {
      assert.equal(boundaryPassed({ ...passingChecks(), [name]: 'fail' }), false, name);
      await writeBoundaryEvidence(root, boundaryEvidence(root, ['arm64'], { checks: { arm64: { [name]: 'fail' } } }));
      assert.equal(
        await codeOf(() => verifyBoundaryGate({ root, architectures: ['arm64'] })),
        'BOUNDARY_GATE_FAILED',
        name,
      );
    }
  });
});

test('E2 macOS boundary gate: evidence holding a path, message or secret is refused before any shape check', async () => {
  await withOffered(async (root) => {
    const candidates = candidatesFor(root, ['arm64']);
    const good = boundaryEvidence(root, ['arm64']);
    const [entry] = good.architectures;
    for (const bad of [
      { ...good, path: 'runtime' },
      // A token-shaped value, assembled here so this file holds no secret-looking literal of its own.
      { ...good, architectures: [{ ...entry, node: ['ghp', '0123456789abcdefABCDEF'].join('_') }] },
      { ...good, architectures: [{ ...entry, checks: { ...entry.checks, tcp: 'denied by /usr/bin/sandbox-exec' } }] },
      { ...good, architectures: [{ ...entry, socket: { message: 'a connection was refused' } }] },
      { ...good, architectures: [{ ...entry, checks: { ...entry.checks, pipes: ['pass', 'pass'] } }] },
    ]) {
      assert.equal(await codeOf(() => validateBoundaryEvidence(bad, { candidates })), 'BOUNDARY_EVIDENCE_RAW');
    }
  });
});

test('E2 macOS boundary gate: evidence is canonical JSON with exactly its reviewed fields', async () => {
  await withOffered(async (root) => {
    const candidates = candidatesFor(root);
    const good = boundaryEvidence(root, BOTH);
    const [arm64, x64] = good.architectures;
    const { tcp: _tcp, ...withoutTcp } = arm64.checks;
    for (const [code, bad] of [
      // Version 1 named no spawn check; no version 1 evidence was ever produced, and a release accepts only version 2.
      ['BOUNDARY_EVIDENCE_SHAPE', { ...good, schemaVersion: 1 }],
      ['BOUNDARY_EVIDENCE_SHAPE', { ...good, architectures: [] }],
      ['BOUNDARY_EVIDENCE_SHAPE', { ...good, architectures: [{ ...arm64, checks: withoutTcp }, x64] }],
      [
        'BOUNDARY_EVIDENCE_SHAPE',
        { ...good, architectures: [{ ...arm64, checks: { ...arm64.checks, tcp: 'skipped' } }] },
      ],
      ['BOUNDARY_EVIDENCE_SHAPE', { ...good, architectures: [{ ...arm64, architecture: 'arm' }] }],
      ['BOUNDARY_EVIDENCE_SHAPE', { ...good, extra: 'field' }],
      ['BOUNDARY_EVIDENCE_DUPLICATE', { ...good, architectures: [arm64, arm64] }],
    ]) {
      assert.equal(
        await codeOf(() => validateBoundaryEvidence(bad, { candidates })),
        code,
        JSON.stringify(bad).slice(0, 80),
      );
    }
    const bytes = canonicalEvidenceBytes(good);
    assert.deepEqual(parseEvidenceBytes(bytes), good);
    assert.equal(await codeOf(() => parseEvidenceBytes(Buffer.from(JSON.stringify(good)))), 'BOUNDARY_EVIDENCE_JSON');
    const duplicated = bytes
      .toString('utf8')
      .replace('"schemaVersion": 2,', '"schemaVersion": 2,\n  "schemaVersion": 2,');
    assert.equal(await codeOf(() => parseEvidenceBytes(Buffer.from(duplicated))), 'BOUNDARY_EVIDENCE_JSON');
    assert.equal(await codeOf(() => parseEvidenceBytes(Buffer.from('- [x] TCP denied\n'))), 'BOUNDARY_EVIDENCE_JSON');
  });
});

async function boundarySchema(version) {
  const require = createRequire(join(ROOT, 'packages/events-daemon/package.json'));
  const ajvModule = require('ajv/dist/2020.js');
  const Ajv2020 = ajvModule.default ?? ajvModule;
  const schema = JSON.parse(
    await readFile(join(ROOT, `packages/events-laya-runtime/gate/macos-boundary-${version}.schema.json`), 'utf8'),
  );
  return { schema, validate: new Ajv2020({ allErrors: true, strict: true }).compile(schema) };
}

test('E2 macOS boundary gate: macos-boundary-v1.schema.json agrees with the validator', async () => {
  // Version 1 is kept as it was written (E2 review round 1, A1): exactly version 2's checks less the process start,
  // and the validator, which reads version 2, refuses a version 1 document.
  const { schema } = await boundarySchema('v1');
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(
    schema.$defs.architecture.properties.checks.required,
    BOUNDARY_CHECKS.filter((name) => name !== 'spawn'),
  );
  await withOffered(async (root) => {
    assert.equal(
      await codeOf(() =>
        validateBoundaryEvidence(
          { ...boundaryEvidence(root, ['arm64']), schemaVersion: 1 },
          {
            candidates: candidatesFor(root, ['arm64']),
          },
        ),
      ),
      'BOUNDARY_EVIDENCE_SHAPE',
    );
  });
});

test('E2 macOS boundary gate: macos-boundary-v2.schema.json agrees with the validator, and names the process start', async () => {
  const { schema, validate } = await boundarySchema('v2');
  assert.equal(BOUNDARY_SCHEMA, 'packages/events-laya-runtime/gate/macos-boundary-v2.schema.json');
  assert.equal(BOUNDARY_EVIDENCE, 'packages/events-laya-runtime/gate/macos-boundary-v2.json');
  assert.equal(schema.properties.schemaVersion.const, 2);
  await withOffered(async (root) => {
    const good = boundaryEvidence(root, BOTH);
    assert.equal(validate(good), true, JSON.stringify(validate.errors));
    assert.deepEqual(schema.$defs.architecture.properties.checks.required, [...BOUNDARY_CHECKS]);
    assert.ok(BOUNDARY_CHECKS.includes('spawn'), 'the real-Mac run records the refused process start');
    const [arm64] = good.architectures;
    const { spawn: _spawn, ...withoutSpawn } = arm64.checks;
    for (const bad of [
      { ...good, extra: true },
      { ...good, architectures: [{ ...arm64, checks: { ...arm64.checks, tcp: 'skipped' } }] },
      { ...good, architectures: [{ ...arm64, checks: withoutSpawn }] },
      { ...good, architectures: [{ ...arm64, node: 'node' }] },
    ]) {
      assert.equal(validate(bad), false);
      assert.notEqual(await codeOf(() => validateBoundaryEvidence(bad, { candidates: candidatesFor(root) })), null);
    }
  });
});

// ------------------------------------------------------------------------------------------------ the run

test("E2 macOS boundary gate run: refuses off macOS, under Rosetta, without the real lock, or with another candidate's trees", {
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  await withOffered(async (root) => {
    const before = await filesBelow(root);
    for (const [code, mac, options] of [
      ['BOUNDARY_PLATFORM', standinMac(), { platform: 'linux' }],
      ['BOUNDARY_PLATFORM', standinMac(), { architecture: 'ia32' }],
      ['BOUNDARY_TRANSLATED', standinMac({ translated: () => true }), { architecture: 'x64' }],
      ['BOUNDARY_TREES', standinMac({ verifyTrees: async () => false }), {}],
      ['BOUNDARY_SANDBOX_UNAVAILABLE', standinMac({ sandboxAvailable: () => false }), {}],
      ['BOUNDARY_USAGE', standinMac(), { runtimeTree: undefined }],
    ]) {
      assert.equal(await codeOf(() => runOn(root, mac.dependencies, options)), code);
      assert.equal(mac.calls.runChecks, 0, `${code}: no check runs`);
    }
    assert.deepEqual(await filesBelow(root), before, 'a refused run writes nothing');
  });
  const root = await dormantRoot();
  try {
    const mac = standinMac();
    assert.equal(await codeOf(() => runOn(root, mac.dependencies)), 'BOUNDARY_CANDIDATE_BLOCKED');
    assert.equal(mac.calls.runChecks, 0);
  } finally {
    await removeRoot(root);
  }
});

test('E2 macOS boundary gate run: writes only the validated, content-free evidence', {
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  await withOffered(async (root) => {
    const before = await filesBelow(root);
    const mac = standinMac();
    const result = await runOn(root, mac.dependencies);
    assert.equal(result.path, BOUNDARY_EVIDENCE);
    assert.equal(result.passed, true);
    assert.deepEqual(
      result.lines,
      BOUNDARY_CHECKS.map((name) => `arm64 ${name}: pass`),
    );
    assert.deepEqual(await filesBelow(root), [...before, BOUNDARY_EVIDENCE].sort(), 'the one file it writes');
    const text = await readFile(join(root, BOUNDARY_EVIDENCE), 'utf8');
    for (const content of ['nonexistent', 'laya-runtime-tree', 'synthetic', 'Laya boundary gate', '/']) {
      assert.equal(text.includes(content), false, `${content} never reaches the evidence`);
    }
    assert.doesNotThrow(() => verifyBoundaryGate({ root, architectures: ['arm64'] }));
  });
});

test('E2 review round 1: the real-Mac boundary run starts the built worker a release ships, not its source', {
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  assert.equal(BUILT_WORKER_ENTRY, 'packages/events-daemon/dist/laya-worker.mjs');
  await withOffered(async (root) => {
    const given = [];
    const mac = standinMac({
      runChecks: async (options) => {
        given.push(options.workerEntry);
        return passingChecks();
      },
    });
    await runOn(root, mac.dependencies);
    assert.deepEqual(given, [join(root, BUILT_WORKER_ENTRY)], 'the checks run the candidate checkout’s own build');
  });
  // The harness hands that entry to the boundary itself: every other option is the production one.
  const runner = await readFile(join(ROOT, 'scripts/run-laya-macos-boundary-gate.mjs'), 'utf8');
  assert.match(
    runner,
    /createLayaWorkerBoundaryForTest\(\{\s*dataDirectory: options\.dataDirectory,\s*signal: options\.signal,\s*workerEntry,\s*\}\)/u,
  );
  assert.doesNotMatch(runner, /\bcreateLayaWorkerBoundary\(/u, 'never the source entry the production surface derives');
  // A candidate whose daemon was not built runs no check: every one is recorded as failed.
  await withOffered(async (root) => {
    const { candidate } = computeBoundaryCandidate({ root, architecture: 'arm64' });
    const checks = await runProductionChecks({
      candidate,
      runtimeTree: TREES.runtimeTree,
      modelTree: TREES.modelTree,
      workerEntry: join(root, BUILT_WORKER_ENTRY),
    });
    assert.deepEqual(checks, Object.fromEntries(BOUNDARY_CHECKS.map((name) => [name, 'fail'])));
  });
});

test('E2 macOS boundary gate run: a check that fails is recorded, and the run does not pass', {
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  await withOffered(async (root) => {
    const mac = standinMac({ runChecks: async () => ({ ...passingChecks(), idleRestart: 'fail', uds: 'maybe' }) });
    const result = await runOn(root, mac.dependencies);
    assert.equal(result.passed, false);
    const evidence = parseEvidenceBytes(await readFile(join(root, BOUNDARY_EVIDENCE)));
    assert.equal(evidence.architectures[0].checks.idleRestart, 'fail');
    assert.equal(evidence.architectures[0].checks.uds, 'fail', 'anything but pass is a fail');
    assert.equal(evidence.architectures[0].passed, false);
    assert.equal(await codeOf(() => verifyBoundaryGate({ root, architectures: ['arm64'] })), 'BOUNDARY_GATE_FAILED');
  });
});

test("E2 macOS boundary gate run: an architecture's run joins the other's evidence only for the same candidate", {
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  await withOffered(async (root) => {
    const path = join(root, BOUNDARY_EVIDENCE);
    await writeBoundaryEvidence(root, boundaryEvidence(root, ['x64']));
    await runOn(root, standinMac().dependencies);
    assert.doesNotThrow(() => verifyBoundaryGate({ root, architectures: BOTH }), 'arm64 joined the x64 evidence');
    // Made for another candidate: refused, never replaced.
    const stale = { ...boundaryEvidence(root, ['x64']), runnerSha256: 'd'.repeat(64) };
    await writeBoundaryEvidence(root, stale);
    assert.equal(await codeOf(() => runOn(root, standinMac().dependencies)), 'BOUNDARY_EVIDENCE_STALE');
    assert.deepEqual(parseEvidenceBytes(await readFile(path)), stale);
    // The same candidate's names, but an entry for another subject: nothing a release would refuse is written.
    const mismatched = boundaryEvidence(root, ['x64']);
    mismatched.architectures[0].subjectDigest = 'c'.repeat(64);
    await writeBoundaryEvidence(root, mismatched);
    assert.equal(await codeOf(() => runOn(root, standinMac().dependencies)), 'BOUNDARY_EVIDENCE_CANDIDATE');
    assert.deepEqual(parseEvidenceBytes(await readFile(path)), mismatched);
  });
});

test('E2 macOS boundary gate run: the egress check refuses a host that reaches an outside address', {
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  assert.ok(
    EGRESS_PROBES.every((probe) => /^\d+\.\d+\.\d+\.\d+$/.test(probe.host)),
    'literal addresses, no lookup',
  );
  const asked = [];
  assert.deepEqual(
    await egressCheck({
      connects: async (probe) => {
        asked.push(probe.host);
        return false;
      },
    }),
    { probes: EGRESS_PROBES.length },
  );
  assert.deepEqual(
    asked,
    EGRESS_PROBES.map((probe) => probe.host),
  );
  assert.equal(
    await codeOf(() => egressCheck({ connects: async (probe) => probe.host === EGRESS_PROBES[1].host })),
    'BOUNDARY_EGRESS',
  );
});

test('E2 macOS boundary gate run: the production checks fail closed when the trees do not verify', {
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  await withOffered(async (root) => {
    const empty = await mkdtemp(join(tmpdir(), 'laya-boundary-empty-'));
    try {
      const { candidate } = computeBoundaryCandidate({ root, architecture: 'arm64' });
      const checks = await runProductionChecks({ candidate, runtimeTree: empty, modelTree: empty });
      assert.deepEqual(checks, Object.fromEntries(BOUNDARY_CHECKS.map((name) => [name, 'fail'])));
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------ the workflow

const GATE_WORKFLOW = '.github/workflows/laya-quality-gate.yml';

async function gateWorkflow() {
  return readFile(join(ROOT, GATE_WORKFLOW), 'utf8');
}

/** The workflow's steps, each as its own text, in order. */
function steps(workflow) {
  const body = workflow.slice(workflow.indexOf('\n    steps:\n'));
  return body.split(/\n {6}- /).slice(1);
}

test('E2 macOS boundary gate workflow: only the owner starts it, by hand, with no input', {
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const workflow = await gateWorkflow();
  const on = /\non:\n([\s\S]*?)\n\S/.exec(workflow)?.[1];
  assert.equal(on, '  workflow_dispatch:\n', 'workflow_dispatch alone, with nothing beneath it');
  assert.doesNotMatch(
    workflow,
    /pull_request|push:|schedule:|workflow_run|workflow_call|repository_dispatch|inputs[.:]|github\.event\.inputs/,
  );
});

test("E2 macOS boundary gate workflow: it runs on the owner's protected Mac, behind its environment, for a candidate tag", async () => {
  const workflow = await gateWorkflow();
  assert.match(workflow, /\n {4}if: startsWith\(github\.ref, 'refs\/tags\/laya-candidate-'\)\n/);
  assert.match(workflow, /\n {4}environment: laya-quality-gate\n/);
  assert.match(workflow, /\n {4}runs-on: \[self-hosted, macOS, agentcomms-laya-gate\]\n/);
  assert.equal([...workflow.matchAll(/\n {4}runs-on: /g)].length, 1, 'one job, on that runner');
  const tag = steps(workflow).findIndex((step) =>
    step.includes('scripts/release-ci.mjs tag "$GITHUB_REF_NAME" "$GITHUB_SHA"'),
  );
  assert.notEqual(tag, -1, 'it checks the candidate tag still names the commit it checked out');
});

test('E2 macOS boundary gate workflow: nothing in it can publish or keep a credential', async () => {
  const workflow = await gateWorkflow();
  assert.match(workflow, /\npermissions: \{\}\n/);
  assert.match(workflow, /\n {4}permissions:\n {6}contents: read\n {4}steps:\n/, 'contents: read, and nothing else');
  assert.doesNotMatch(workflow, /id-token|registry-url|NODE_AUTH_TOKEN|NPM_TOKEN|github\.token|write-all/);
  // E2 review round 1 (A4): one secret, the corpus key, the gate environment's own, in the quality step's env alone.
  const secrets = steps(workflow).flatMap((step, index) =>
    [...step.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)].map((match) => [index, match[1], step]),
  );
  assert.equal([...workflow.matchAll(/secrets\./g)].length, 1, 'no secret anywhere else');
  assert.equal(secrets.length, 1);
  const [[, name, step]] = secrets;
  assert.equal(name, 'AGENTCOMMS_LAYA_GATE_CORPUS_KEY');
  assert.match(step, /run-laya-quality-gate\.mjs run\b/, 'only the quality run is given it');
  assert.match(
    step,
    /\n {8}env:\n {10}AGENTCOMMS_LAYA_GATE_CORPUS_KEY: \$\{\{ secrets\.AGENTCOMMS_LAYA_GATE_CORPUS_KEY \}\}\n/,
    'as that step’s own environment',
  );
  assert.doesNotMatch(workflow, /KEY_FILE|--key-file/, 'no key path on the gate Mac');
  const checkout = steps(workflow).find((step) => step.startsWith('uses: actions/checkout@'));
  assert.match(checkout ?? '', /\n {10}persist-credentials: false/);
  for (const [, action, ref] of workflow.matchAll(/uses: ([^@\s]+)@(\S+)/g)) {
    assert.match(ref, /^[0-9a-f]{40}$/, `${action} is pinned to a commit`);
  }
});

test('E2 macOS boundary gate workflow: the corpus is read last, after the candidate, the egress check and the boundary run', async () => {
  const list = steps(await gateWorkflow());
  const at = (marker) => {
    const index = list.findIndex((step) => step.includes(marker));
    assert.notEqual(index, -1, `a step runs ${marker}`);
    return index;
  };
  const install = at("pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime'");
  const candidate = at('scripts/run-laya-macos-boundary-gate.mjs verify-candidate');
  const egress = at('scripts/run-laya-macos-boundary-gate.mjs egress-check');
  const boundary = at('scripts/run-laya-macos-boundary-gate.mjs run');
  const quality = at('scripts/run-laya-quality-gate.mjs run --attest-written-consent');
  assert.ok(install < candidate && candidate < egress && egress < boundary && boundary < quality);
  // The order protects only if every step runs: none before the results' artifacts may be skipped or allowed to fail.
  const uploads = list.flatMap((step, index) => (step.includes('uses: actions/upload-artifact@') ? [index] : []));
  assert.deepEqual(uploads, [list.length - 3, list.length - 2, list.length - 1], 'the three artifact steps come last');
  for (const [index, step] of list.slice(0, uploads[0]).entries()) {
    assert.doesNotMatch(
      step,
      /\n {8}(?:if|continue-on-error):/,
      `step ${index} always runs, and its failure stops the job`,
    );
  }
  const corpus = list.flatMap((step, index) =>
    /AGENTCOMMS_LAYA_GATE_(?:CORPUS|CORPUS_KEY|KEY_FILE|REFERENCE|PYTHON)\b/.test(step) ? [index] : [],
  );
  assert.deepEqual(corpus, [quality], 'only the quality run names the corpus, its key or the reference');
  const kept = list[uploads[0]] ?? '';
  assert.match(kept, /packages\/events-laya-runtime\/gate\/laya-\*\.json\n/);
  assert.match(kept, /packages\/events-laya-runtime\/gate\/macos-boundary-v2\.json\n/);
  assert.equal(
    [...kept.matchAll(/\n {12}\S/g)].length,
    2,
    'the artifact keeps the two content-free results and nothing else',
  );
});

test('E2 review round 1: each gate run writes its own copy of its result, which the workflow uploads unzipped', {
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const list = steps(await gateWorkflow());
  const boundaryRun = list.find((step) => step.includes('scripts/run-laya-macos-boundary-gate.mjs run')) ?? '';
  const qualityRun = list.find((step) => step.includes('scripts/run-laya-quality-gate.mjs run')) ?? '';
  assert.match(boundaryRun, new RegExp(`--run-copy "\\$RUNNER_TEMP/${RUN_COPIES.boundary}"(?:\n|$)`));
  assert.match(qualityRun, new RegExp(`--run-copy "\\$RUNNER_TEMP/${RUN_COPIES.quality}"(?:\n|$)`));
  for (const [step, name] of [
    [list.at(-2), RUN_COPIES.quality],
    [list.at(-1), RUN_COPIES.boundary],
  ]) {
    // Unzipped, the artifact is the file itself, named by it, and GitHub's digest of it is the file's SHA-256.
    assert.match(step ?? '', new RegExp(`\\n {10}path: \\$\\{\\{ runner\\.temp \\}\\}/${name}\\n`), name);
    assert.match(step ?? '', /\n {10}archive: false\n/, `${name} is uploaded unzipped`);
    assert.match(step ?? '', /\n {10}retention-days: 90(?:\n|$)/, `${name} is kept as long as GitHub allows`);
  }
  await withOffered(async (root) => {
    // Another architecture's entry already there: the copy is still this run's architecture alone.
    await writeBoundaryEvidence(root, boundaryEvidence(root, ['x64']));
    const copy = join(root, 'run-copy.json');
    await runOn(root, standinMac().dependencies, { runCopy: copy });
    const committed = parseEvidenceBytes(await readFile(join(root, BOUNDARY_EVIDENCE)));
    assert.deepEqual(
      committed.architectures.map((entry) => entry.architecture),
      ['arm64', 'x64'],
    );
    assert.deepEqual(
      await readFile(copy),
      canonicalEvidenceBytes({ ...committed, architectures: [committed.architectures[0]] }),
      "the run's copy is the committed evidence restricted to its architecture",
    );
  });
});

test('E2 macOS boundary gate workflow: ordinary CI and pnpm verify run neither gate and read no corpus', async () => {
  const runners = /run-laya-quality-gate\.mjs|run-laya-macos-boundary-gate\.mjs|AGENTCOMMS_LAYA_GATE_/;
  const workflows = await readdir(join(ROOT, '.github/workflows'));
  for (const name of workflows.filter((file) => `.github/workflows/${file}` !== GATE_WORKFLOW)) {
    assert.doesNotMatch(await readFile(join(ROOT, '.github/workflows', name), 'utf8'), runners, name);
  }
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  for (const [name, script] of Object.entries(root.scripts)) assert.doesNotMatch(script, runners, `pnpm ${name}`);
});
