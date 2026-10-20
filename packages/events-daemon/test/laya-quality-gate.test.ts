import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gmailMessageReceivedV1, slackMessagePostedV1 } from '@agentcomms/events';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import gateSchema from '../../events-laya-runtime/gate/schema-v1.json' with { type: 'json' };
import { LAYA_CHOICE2_TEMPLATE_ID, LAYA_NOUL_TEMPLATE_ID, layaTemplateDigest } from '../src/runtime/laya/templates.ts';
import badReports from './fixtures/laya/quality/bad-report-v1.json' with { type: 'json' };
import metrics from './fixtures/laya/quality/metrics-v1.json' with { type: 'json' };
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * D11's quality gate (E2-8, Task 9) on synthetic data only: tiny labelled vectors prove the arithmetic, a synthetic
 * report and its bad edits prove the validator, and stand-ins prove the owner run's protocol. Nothing here is a
 * quality claim, runs a model or reads a corpus.
 */

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const verifierScript = join(repositoryRoot, 'scripts/verify-laya-quality-gate.mjs');
const runnerScript = join(repositoryRoot, 'scripts/run-laya-quality-gate.mjs');

type Edit = Readonly<Record<string, unknown>>;
type WorkerOutcome =
  | { readonly kind: 'answer'; readonly value: number; readonly inputTokens: number }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'abort'; readonly code: string };
type ReferenceOutcome =
  | { readonly kind: 'answer'; readonly value: number; readonly inputTokens: number }
  | { readonly kind: 'refused' };
interface Observation {
  readonly channel: string;
  readonly language: string;
  readonly label: number;
  readonly worker: WorkerOutcome;
  readonly reference: ReferenceOutcome | null;
}
interface ChannelBlock {
  readonly channel: string;
  readonly pairs: number;
  readonly answered: number;
  readonly refused: Readonly<Record<string, number>>;
  readonly positiveShare: number | null;
  readonly expectedCalibrationError: number | null;
  readonly brierScore: number | null;
  readonly auroc: number | null;
  readonly reference: Readonly<Record<string, number | null>>;
  readonly warmLatencyP95Ms: number | null;
  readonly peakWorkerBytes: number | null;
  readonly passed: boolean;
}
interface TemplateBlock {
  readonly templateId: string;
  readonly channels: readonly ChannelBlock[];
  readonly passed: boolean;
}
interface Candidate {
  readonly manifestId: string;
  readonly templates: readonly { readonly templateId: string; readonly templateSha256: string }[];
  readonly subjectDigest: string;
}
interface Verifier {
  readonly QUALITY_THRESHOLDS: Readonly<Record<string, number>>;
  readonly QUALITY_CORPUS_RELEASE: Readonly<Record<string, string>>;
  readonly GATE_REPORT_DIRECTORY: string;
  readonly GATE_SUBJECT_FILES: readonly string[];
  readonly EVIDENCE_RECORD: string;
  calibrationBin(probability: number, bins?: number): number;
  expectedCalibrationError(probabilities: readonly number[], labels: readonly number[]): number;
  brierScore(probabilities: readonly number[], labels: readonly number[]): number;
  areaUnderRoc(probabilities: readonly number[], labels: readonly number[]): number | null;
  positiveShare(labels: readonly number[]): number | null;
  nearestRankPercentile(values: readonly number[], quantile: number): number | null;
  peakOf(samples: readonly number[]): number | null;
  maximumReferenceDelta(worker: readonly number[], reference: readonly number[]): number | null;
  aggregateChannel(channel: string, observations: readonly Observation[], measurements?: unknown): ChannelBlock;
  aggregateTemplate(
    templateId: string,
    templateSha256: string,
    observations: readonly Observation[],
    measurements?: unknown,
  ): TemplateBlock;
  channelPasses(block: ChannelBlock): boolean;
  checkMetricVectors(fixture: unknown): number;
  materializeFixtureCandidate(
    fixture: unknown,
    options?: { readonly files?: Readonly<Record<string, string>> },
  ): Promise<string>;
  computeCandidate(options: { readonly root?: string; readonly architecture: string }): Candidate;
  gateSubjectFiles(root: string): readonly string[];
  gateSubjectDigest(root: string, architecture: string): string;
  assertSubjectExcludesReport(files: readonly string[]): readonly string[];
  verifyPythonReferenceRecord(root?: string): unknown;
  validateQualityReport(
    report: unknown,
    options: { readonly candidates: Readonly<Record<string, Candidate>>; readonly mode: string; readonly root: string },
  ): unknown;
  applyFixtureEdits(report: unknown, edits: readonly Edit[]): unknown;
  canonicalReportBytes(report: unknown): Buffer;
  verifyQualityGate(options: { readonly root: string; readonly architectures?: readonly string[] }): unknown;
  verifyQualityFixtures(): Promise<{ readonly vectors: number; readonly refusals: number }>;
}
interface WorkerStandin {
  evaluate(request: {
    readonly templateId: string;
    readonly instructions: string;
    readonly state: string;
  }): Promise<{ readonly outcome: WorkerOutcome; readonly cold: boolean; readonly ms: number }>;
  memorySamples(): readonly number[];
  close(): Promise<void>;
}
interface ReferenceStandin {
  readonly environment: Readonly<Record<string, string>>;
  evaluate(request: {
    readonly templateId: string;
    readonly instructions: string;
    readonly state: string;
  }): Promise<ReferenceOutcome>;
  close(): Promise<void>;
}
interface Runner {
  readonly REFERENCE_DRIVER: string;
  assertOutsideRepository(path: unknown, options: { readonly root: string; readonly what: string }): string;
  sealCorpus(key: Buffer, plaintext: Buffer): Buffer;
  openCorpus(key: Buffer, sealed: Buffer): Buffer;
  readCorpusKey(path: string, options: { readonly root: string }): Promise<Buffer>;
  generateCorpusKey(path: string, options: { readonly root: string }): Promise<void>;
  sealCorpusFile(options: {
    readonly keyFile: string;
    readonly corpus: string;
    readonly plaintext: Buffer;
    readonly root: string;
  }): Promise<string>;
  parseCorpusItems(plaintext: Buffer): readonly unknown[];
  readCorpusDirectory(
    directory: string,
    options: { readonly key: Buffer; readonly root: string },
  ): Promise<readonly unknown[]>;
  workerOutcome(result: Readonly<Record<string, unknown>>): WorkerOutcome;
  referenceQuestion(templateId: string, instructions: string): unknown;
  referenceOutcome(templateId: string, message: unknown): ReferenceOutcome;
  verifyReferenceSnapshot(
    snapshot: string,
    options?: { readonly files?: Readonly<Record<string, { path: string; size: number; sha256: string }>> },
  ): Promise<string>;
  measureCandidate(options: {
    readonly candidate: Candidate;
    readonly items: readonly unknown[];
    readonly worker: WorkerStandin;
    readonly reference: ReferenceStandin;
  }): Promise<readonly TemplateBlock[]>;
  writeGateReport(options: { readonly root: string; readonly report: unknown }): Promise<string>;
  runQualityGate(
    options: Readonly<Record<string, unknown>>,
    dependencies: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly path: string; readonly lines: readonly string[] }>;
}

async function verifier(): Promise<Verifier> {
  // @ts-expect-error The owner-only JavaScript gate command deliberately ships without a TypeScript declaration.
  return (await import('../../../scripts/verify-laya-quality-gate.mjs')) as Verifier;
}

async function runner(): Promise<Runner> {
  // @ts-expect-error The owner-only JavaScript gate command deliberately ships without a TypeScript declaration.
  return (await import('../../../scripts/run-laya-quality-gate.mjs')) as Runner;
}

/** The closed refusal code a gate check throws, or null when it accepted. Any other failure is not a refusal. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    if (error instanceof Error && /^Quality(?:Gate|GateRun)Error$/.test(error.name))
      return String((error as unknown as { code: unknown }).code);
    throw error;
  }
  return null;
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && /^Quality(?:Gate|GateRun)Error$/.test(error.name))
      return String((error as unknown as { code: unknown }).code);
    throw error;
  }
  return null;
}

function badCase(name: string): { readonly code: string; readonly edits: readonly Edit[] } {
  const found = badReports.cases.find((entry) => entry.name === name);
  assert.ok(found, `bad-report-v1.json has ${name}`);
  return found as unknown as { readonly code: string; readonly edits: readonly Edit[] };
}

async function withFixtureRoot<T>(
  run: (root: string, gate: Verifier) => Promise<T> | T,
  files: Readonly<Record<string, string>> = {},
): Promise<T> {
  const gate = await verifier();
  const root = await gate.materializeFixtureCandidate(metrics, { files });
  try {
    return await run(root, gate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function candidates(gate: Verifier, root: string): Record<string, Candidate> {
  return {
    arm64: gate.computeCandidate({ root, architecture: 'arm64' }),
    x64: gate.computeCandidate({ root, architecture: 'x64' }),
  };
}

function refusal(gate: Verifier, root: string, edits: readonly Edit[], mode = 'fixture'): string | null {
  return codeOf(() =>
    gate.validateQualityReport(gate.applyFixtureEdits(metrics.report, edits), {
      candidates: candidates(gate, root),
      mode,
      root,
    }),
  );
}

function expectBadCases(gate: Verifier, root: string, names: readonly string[]): void {
  for (const name of names) {
    const entry = badCase(name);
    assert.equal(refusal(gate, root, entry.edits), entry.code, name);
  }
}

/** Synthetic, well-separated observations: p 0.95 for a positive label and 0.05 for a negative, the reference equal. */
function observations(channel: string, pairs: number, positives: number, inverted = false): Observation[] {
  return Array.from({ length: pairs }, (_, index) => {
    const label = index < positives ? 1 : 0;
    const value = (label === 1) !== inverted ? 0.95 : 0.05;
    return {
      channel,
      language: 'en',
      label,
      worker: { kind: 'answer', value, inputTokens: 40 },
      reference: { kind: 'answer', value, inputTokens: 40 },
    };
  });
}

const MEASURED = { warmLatenciesMs: [120, 140, 160], memorySamples: [2_000_000_000] };

test('E2 quality gate: ten equal-width bins put each probability in its bin and 1 in the last', async () => {
  const gate = await verifier();
  assert.deepEqual(
    [0, 0.05, 0.1, 0.12, 0.18, 0.47, 0.52, 0.86, 0.89, 0.95, 1].map((value) => gate.calibrationBin(value)),
    [0, 0, 1, 1, 1, 4, 5, 8, 8, 9, 9],
  );
  const shared = metrics.vectors.find((vector) => vector.name === 'shared-bins');
  assert.ok(shared);
  assert.equal(
    gate.expectedCalibrationError(shared.probabilities, shared.labels),
    shared.expected.expectedCalibrationError,
  );
});

test('E2 quality gate: ECE, Brier, AUROC and positive share recompute the synthetic vectors exactly', async () => {
  const gate = await verifier();
  assert.equal(gate.checkMetricVectors(metrics), 10);
  for (const vector of metrics.vectors) {
    assert.ok(
      Math.abs(gate.brierScore(vector.probabilities, vector.labels) - vector.expected.brierScore) <= 1e-12,
      vector.name,
    );
    assert.equal(gate.positiveShare(vector.labels), vector.expected.positiveShare, vector.name);
  }
  assert.throws(() => gate.brierScore([1.2], [1]), /QUALITY_METRIC_INPUT/);
  assert.throws(() => gate.expectedCalibrationError([0.5], [2]), /QUALITY_METRIC_INPUT/);
});

test('E2 quality gate: AUROC counts a tie as one half and is undefined without both classes', async () => {
  const gate = await verifier();
  assert.equal(gate.areaUnderRoc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]), 0.5);
  assert.equal(gate.areaUnderRoc([0.7, 0.4, 0.4], [1, 1, 0]), 0.75);
  assert.equal(gate.areaUnderRoc([0.9, 0.8], [1, 1]), null);
  assert.equal(gate.areaUnderRoc([0.1, 0.9], [1, 0]), 0);
});

test('E2 quality gate: warm p95 is the nearest rank, peak memory the largest sample, the reference delta the largest gap', async () => {
  const gate = await verifier();
  for (const vector of metrics.latency)
    assert.equal(gate.nearestRankPercentile(vector.valuesMs, 0.95), vector.expectedP95Ms);
  for (const vector of metrics.memory) assert.equal(gate.peakOf(vector.samples), vector.expectedPeak);
  for (const vector of metrics.referenceDelta) {
    const delta = gate.maximumReferenceDelta(vector.worker, vector.reference);
    assert.ok(delta !== null && Math.abs(delta - vector.expected) <= 1e-12);
  }
  assert.equal(gate.nearestRankPercentile([], 0.95), null);
  assert.equal(gate.peakOf([]), null);
  assert.equal(gate.maximumReferenceDelta([], []), null);
});

test('E2 quality gate: Gmail and Slack are measured and judged separately, never combined', async () => {
  const gate = await verifier();
  const template = gate.aggregateTemplate(
    LAYA_NOUL_TEMPLATE_ID,
    layaTemplateDigest(LAYA_NOUL_TEMPLATE_ID),
    [...observations('gmail', 200, 100), ...observations('slack', 200, 100, true)],
    { gmail: MEASURED, slack: MEASURED },
  );
  assert.deepEqual(
    template.channels.map((channel) => [channel.channel, channel.pairs, channel.passed]),
    [
      ['gmail', 200, true],
      ['slack', 200, false],
    ],
  );
  assert.equal(template.channels[0]?.auroc, 1);
  assert.equal(template.channels[1]?.auroc, 0);
  assert.equal(template.passed, false, 'a template passes only when each channel passes on its own');
});

test('E2 quality gate: a report with one channel, or without a manifest template, is refused', async () => {
  await withFixtureRoot((root, gate) => expectBadCases(gate, root, ['one-channel-only', 'missing-template']));
});

test('E2 quality gate: 199 labelled pairs or under 30% positives does not pass', async () => {
  const gate = await verifier();
  const channel = (pairs: number, positives: number) =>
    gate.aggregateChannel('gmail', observations('gmail', pairs, positives), MEASURED);
  assert.equal(channel(200, 100).passed, true);
  assert.equal(channel(199, 100).passed, false, '199 labelled pairs are too few');
  assert.equal(channel(200, 60).passed, true, 'exactly 30% positives is enough');
  assert.equal(channel(200, 59).passed, false, '29.5% positives is too few');
});

test('E2 quality gate: a channel passes only within every D11 threshold and with no worker failure', async () => {
  const gate = await verifier();
  const passing = gate.aggregateChannel('slack', observations('slack', 200, 100), MEASURED);
  assert.equal(gate.channelPasses(passing), true);
  const variant = (change: Readonly<Record<string, unknown>>) =>
    gate.channelPasses({ ...passing, ...change } as ChannelBlock);
  const reference = (change: Readonly<Record<string, unknown>>) =>
    variant({ reference: { ...passing.reference, ...change } });
  const refused = (change: Readonly<Record<string, number>>) => variant({ refused: { ...passing.refused, ...change } });
  assert.equal(variant({ expectedCalibrationError: 0.1 }), true);
  assert.equal(variant({ expectedCalibrationError: 0.1000001 }), false);
  assert.equal(variant({ brierScore: 0.2 }), true);
  assert.equal(variant({ brierScore: 0.2000001 }), false);
  assert.equal(variant({ auroc: 0.8 }), true);
  assert.equal(variant({ auroc: 0.7999999 }), false);
  assert.equal(reference({ maxProbabilityDelta: 0.001 }), true);
  assert.equal(reference({ maxProbabilityDelta: 0.0011 }), false, 'every probability within 0.001 of the reference');
  assert.equal(reference({ inputTokenMismatches: 1 }), false);
  assert.equal(variant({ warmLatencyP95Ms: 2000 }), true);
  assert.equal(variant({ warmLatencyP95Ms: 2000.5 }), false);
  assert.equal(variant({ peakWorkerBytes: 3_000_000_000 }), true);
  assert.equal(variant({ peakWorkerBytes: 3_000_000_001 }), false);
  assert.equal(refused({ tokenLimit: 3 }), true, 'inputs refused for length are reported, not failures');
  assert.equal(refused({ malformed: 1 }), false, 'a malformed worker answer on any item fails the channel');
  assert.equal(refused({ crashed: 1 }), false);
});

test('E2 quality gate: model-card or refitted calibration is refused', async () => {
  await withFixtureRoot((root, gate) =>
    expectBadCases(gate, root, ['model-card-calibration', 'refitted-temperatures']),
  );
});

test('E2 quality gate: a report bound to another manifest, lock, platform list, runtime, runner or template is refused', async () => {
  await withFixtureRoot((root, gate) =>
    expectBadCases(gate, root, [
      'manifest-id',
      'manifest-digest',
      'runtime-lock-digest',
      'platform-file-list-digest',
      'runtime-version',
      'runtime-version-onnxruntime-node',
      'runtime-version-tokenizers',
      'runner-digest',
      'x64-claimed-with-arm64-evidence',
      'template-digest',
    ]),
  );
});

test('E2 quality gate: the subject digest binds the worker source and ignores the report', async () => {
  await withFixtureRoot(async (root, gate) => {
    assert.deepEqual(gate.gateSubjectFiles(root), [
      'packages/events-daemon/laya-enablement-disclosures.json',
      'packages/events-daemon/laya-manifest.json',
      'packages/events-daemon/laya-runtime.json',
      'packages/events-daemon/package.json',
      'packages/events-daemon/src/runtime/judge-coordinator.ts',
      'packages/events-daemon/src/runtime/laya/contracts.ts',
      'packages/events-daemon/src/runtime/laya/manager.ts',
      'packages/events-daemon/src/runtime/laya/tar.ts',
      'packages/events-daemon/src/runtime/laya/tree-verifier.ts',
      'packages/events-daemon/src/runtime/laya/worker-main.ts',
      'packages/events-daemon/src/runtime/laya/worker-runtime.ts',
      'packages/events-daemon/src/runtime/laya/worker-supervisor.ts',
      'packages/events-daemon/tsdown.config.ts',
      'pnpm-lock.yaml',
    ]);
    const before = gate.gateSubjectDigest(root, 'arm64');
    assert.notEqual(before, gate.gateSubjectDigest(root, 'x64'), 'the subject is bound to its architecture');
    await mkdir(join(root, gate.GATE_REPORT_DIRECTORY), { recursive: true });
    await writeFile(join(root, gate.GATE_REPORT_DIRECTORY, 'laya-en-onnx-68f27dfe.json'), '{}\n');
    assert.equal(gate.gateSubjectDigest(root, 'arm64'), before, 'committing the report does not change its subject');
    expectBadCases(gate, root, ['subject-digest']);
  });
  await withFixtureRoot(
    (root, gate) => {
      assert.equal(refusal(gate, root, []), 'QUALITY_REPORT_CANDIDATE', 'a changed worker source is another candidate');
    },
    {
      'packages/events-daemon/src/runtime/laya/worker-runtime.ts':
        'export function answer(): void {\n  // changed\n}\n',
    },
  );
});

test('E2 review round 1: the subject binds every file the evidence measures, and a version bump alone leaves it as it was', async () => {
  // A2: the tree checks, the strict extractor, the artifact manager, the strict parsers and the lockfile that pins the
  // toolchain each change what a passing run measured, so each is in the subject.
  const measured = [
    'packages/events-daemon/src/runtime/laya/contracts.ts',
    'packages/events-daemon/src/runtime/laya/manager.ts',
    'packages/events-daemon/src/runtime/laya/tar.ts',
    'packages/events-daemon/src/runtime/laya/tree-verifier.ts',
    'pnpm-lock.yaml',
  ];
  for (const file of measured) {
    await withFixtureRoot(async (root, gate) => {
      assert.ok(gate.GATE_SUBJECT_FILES.includes(file), `${file} is a subject file`);
      const before = gate.gateSubjectDigest(root, 'arm64');
      await writeFile(join(root, file), `${await readFile(join(root, file), 'utf8')}\n// changed\n`);
      assert.notEqual(gate.gateSubjectDigest(root, 'arm64'), before, `a change to ${file} is another candidate`);
    });
  }
  // B3: the daemon's package.json is bound without its version: a release's bump keeps the evidence; nothing else does.
  await withFixtureRoot(async (root, gate) => {
    const path = join(root, 'packages/events-daemon/package.json');
    const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const before = gate.gateSubjectDigest(root, 'arm64');
    await writeFile(path, `${JSON.stringify({ ...original, version: '9.9.9' }, null, 2)}\n`);
    assert.equal(gate.gateSubjectDigest(root, 'arm64'), before, 'a version bump alone is the same candidate');
    await writeFile(path, `${JSON.stringify({ version: '0.25.0', ...original })}\n`);
    assert.equal(gate.gateSubjectDigest(root, 'arm64'), before, 'nor do the order of its keys or its layout');
    await writeFile(path, `${JSON.stringify({ ...original, version: '0.25.0', files: ['dist'] }, null, 2)}\n`);
    assert.notEqual(gate.gateSubjectDigest(root, 'arm64'), before, 'any other change is another candidate');
    await writeFile(path, 'not json\n');
    assert.equal(
      codeOf(() => gate.gateSubjectDigest(root, 'arm64')),
      'QUALITY_CANDIDATE',
      'broken JSON is refused',
    );
  });
});

test('E2 quality gate: a candidate subject that includes the report is refused', async () => {
  const gate = await verifier();
  assert.equal(
    codeOf(() => gate.assertSubjectExcludesReport(['packages/events-laya-runtime/gate/laya-en-onnx-68f27dfe.json'])),
    'QUALITY_SUBJECT_INCLUDES_REPORT',
  );
  assert.equal(
    codeOf(() => gate.assertSubjectExcludesReport(['packages/events-laya-runtime/gate'])),
    'QUALITY_SUBJECT_INCLUDES_REPORT',
  );
  const entry = badReports.cases.find((candidate) => candidate.name === 'subject-includes-the-report');
  assert.ok(entry && 'files' in entry);
  await withFixtureRoot(
    (root, fixtureGate) => {
      assert.equal(
        codeOf(() => fixtureGate.computeCandidate({ root, architecture: 'arm64' })),
        'QUALITY_SUBJECT_INCLUDES_REPORT',
      );
    },
    entry.files as Readonly<Record<string, string>>,
  );
});

test('E2 quality gate: an absent or mutable Python reference record is refused', async () => {
  const gate = await verifier();
  assert.doesNotThrow(() => gate.verifyPythonReferenceRecord(), 'the repository record pins the reference');
  const pinned = '- immutable: `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851`';
  const encoder = 'bf3ab80598fdccf414855a2ce80f22859e4492d06ca8a62ddd1cfb63972f8979';
  for (const [name, edit] of [
    ['absent', null],
    ['mutable', (record: string) => record.replace(pinned, '- immutable: `main`')],
    ['short', (record: string) => record.replace(pinned, '- immutable: `55cf4c4e`')],
    ['input missing', (record: string) => record.replaceAll(encoder, 'not-recorded')],
  ] as const) {
    await withFixtureRoot(async (root, fixtureGate) => {
      const path = join(root, fixtureGate.EVIDENCE_RECORD);
      if (edit === null) await rm(path);
      else await writeFile(path, edit(await readFile(path, 'utf8')));
      assert.equal(
        codeOf(() => fixtureGate.verifyPythonReferenceRecord(root)),
        'QUALITY_REFERENCE_RECORD',
        name,
      );
      assert.equal(refusal(fixtureGate, root, []), 'QUALITY_REFERENCE_RECORD', name);
    });
  }
});

test('E2 quality gate: a guessed reference invocation, tokenizer or model input is refused', async () => {
  await withFixtureRoot((root, gate) =>
    expectBadCases(gate, root, [
      'reference-revision',
      'reference-invocation',
      'reference-device',
      'reference-tokenizer',
      'reference-weights',
      'reference-encoder-config',
    ]),
  );
});

test('E2 quality gate: corpus content, secrets and per-item values are refused before any shape check', async () => {
  await withFixtureRoot((root, gate) =>
    expectBadCases(gate, root, [
      'message-text-in-a-token-field',
      'subject-field',
      'rule-question-field',
      'raw-labels-field',
      'slack-handle',
      'address',
      'event-id',
      'path',
      'secret-prefix',
      'secret-mixed-case',
      'per-item-scores',
    ]),
  );
});

test('E2 quality gate: an unknown field, a missing field or a duplicate is refused', async () => {
  await withFixtureRoot((root, gate) =>
    expectBadCases(gate, root, [
      'unknown-field',
      'missing-field',
      'schema-version',
      'duplicate-template',
      'duplicate-channel',
      'duplicate-architecture',
      'counts-do-not-add-up',
    ]),
  );
});

test('E2 quality gate: a synthetic fixture report is never release evidence', async () => {
  await withFixtureRoot((root, gate) => {
    assert.equal(refusal(gate, root, []), null, 'the synthetic report is valid fixture evidence');
    assert.equal(refusal(gate, root, [], 'release'), 'QUALITY_REPORT_FIXTURE');
    const consented = Object.entries(gate.QUALITY_CORPUS_RELEASE).map(([key, value]) => ({
      op: 'set',
      pointer: `/corpus/${key}`,
      value,
    }));
    assert.equal(refusal(gate, root, consented), 'QUALITY_REPORT_FIXTURE', 'fixture mode accepts only synthetic data');
  });
});

test('E2 quality gate: a passing flag its numbers do not give is refused', async () => {
  await withFixtureRoot((root, gate) =>
    expectBadCases(gate, root, [
      '199-pairs-marked-passing',
      'under-30-percent-positive-marked-passing',
      'ece-over-threshold-marked-passing',
      'brier-over-threshold-marked-passing',
      'auroc-under-threshold-marked-passing',
      'reference-delta-over-threshold-marked-passing',
      'input-token-mismatch-marked-passing',
      'warm-p95-over-threshold-marked-passing',
      'peak-memory-over-threshold-marked-passing',
      'malformed-answer-marked-passing',
      'template-passing-with-failing-channel',
    ]),
  );
});

/** The synthetic report, marked as a consented run, written into a disposable fixture root: never the repository. */
async function writeReleaseShaped(gate: Verifier, root: string, edits: readonly Edit[] = []): Promise<string> {
  const consented = Object.entries(gate.QUALITY_CORPUS_RELEASE).map(([key, value]) => ({
    op: 'set',
    pointer: `/corpus/${key}`,
    value,
  }));
  const directory = join(root, gate.GATE_REPORT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'laya-en-onnx-68f27dfe.json');
  await writeFile(path, gate.canonicalReportBytes(gate.applyFixtureEdits(metrics.report, [...consented, ...edits])));
  return path;
}

test('E2 quality gate: a release offers an architecture only when every manifest template passed there', async () => {
  await withFixtureRoot(async (root, gate) => {
    assert.equal(
      codeOf(() => gate.verifyQualityGate({ root })),
      'QUALITY_GATE_ABSENT',
      'no evidence, no Laya',
    );
    const path = await writeReleaseShaped(gate, root);
    assert.equal(
      codeOf(() => gate.verifyQualityGate({ root })),
      'QUALITY_GATE_FAILED',
      'laya-choice2-v1 is refused by the worker, so this manifest cannot be offered',
    );
    const choice = '/architectures/0/templates/0';
    const report = gate.applyFixtureEdits(metrics.report, []) as {
      architectures: { templates: { channels: unknown[] }[] }[];
    };
    const passingChoice = [
      { op: 'set', pointer: `${choice}/channels`, value: report.architectures[0]?.templates[1]?.channels },
      { op: 'set', pointer: `${choice}/passed`, value: true },
    ];
    await rm(path);
    await writeReleaseShaped(gate, root, passingChoice);
    assert.doesNotThrow(() => gate.verifyQualityGate({ root }), 'every template passed on arm64');
    assert.equal(
      codeOf(() => gate.verifyQualityGate({ root, architectures: ['arm64', 'x64'] })),
      'QUALITY_GATE_ABSENT',
      'arm64 evidence never authorises x64',
    );
    const text = await readFile(path, 'utf8');
    await writeFile(path, JSON.stringify(JSON.parse(text)));
    assert.equal(
      codeOf(() => gate.verifyQualityGate({ root })),
      'QUALITY_REPORT_JSON',
    );
  });
});

test('E2 quality gate: the shipped placeholder lock leaves no candidate to gate', async () => {
  const gate = await verifier();
  assert.equal(
    codeOf(() => gate.computeCandidate({ architecture: 'arm64' })),
    'QUALITY_CANDIDATE_BLOCKED',
  );
  assert.equal(
    codeOf(() => gate.verifyQualityGate({ root: repositoryRoot })),
    'QUALITY_CANDIDATE_BLOCKED',
  );
});

test('E2 quality gate: schema-v1.json agrees with the validator on the synthetic report', async () => {
  const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(gateSchema);
  const gate = await verifier();
  assert.equal(validate(metrics.report), true, JSON.stringify(validate.errors));
  for (const name of [
    'unknown-field',
    'one-channel-only',
    'reference-revision',
    'model-card-calibration',
    'per-item-scores',
  ]) {
    assert.equal(validate(gate.applyFixtureEdits(metrics.report, badCase(name).edits)), false, name);
  }
});

test('E2 quality gate: the fixture command recomputes every vector and refuses every bad report', async () => {
  const gate = await verifier();
  assert.deepEqual(await gate.verifyQualityFixtures(), { vectors: 10, refusals: badReports.cases.length });
  const result = await run(verifierScript, ['--fixture']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /^Laya quality gate fixtures: OK \(10 synthetic metric vectors, \d+ refused reports; no quality claim\)\n$/,
  );
});

// ------------------------------------------------------------------------------------------------ the owner run

function run(
  script: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', script, ...args],
      { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function outside(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

const QUESTION = 'Synthetic rule question: does this ask for the quarterly review?';

function gmailItem(index: number, label: 0 | 1) {
  return {
    channel: 'gmail',
    language: 'en',
    label,
    question: QUESTION,
    inputs: ['/subject', '/body'],
    event: {
      ...gmailMessageReceivedV1.examples[0],
      subject: `Synthetic ${label === 1 ? 'positive' : 'negative'} subject ${index}`,
      body: `Synthetic body ${index}`,
    },
  };
}

function slackItem(index: number, label: 0 | 1) {
  return {
    channel: 'slack',
    language: 'en',
    label,
    question: QUESTION,
    inputs: ['/text'],
    event: {
      ...slackMessagePostedV1.examples[0],
      text: `Synthetic ${label === 1 ? 'positive' : 'negative'} text ${index}`,
    },
  };
}

function corpus(items: readonly unknown[]): Buffer {
  return Buffer.from(JSON.stringify({ format: 'agentcomms-laya-quality-corpus-v1', items }));
}

async function sealedCorpus(gateRunner: Runner, root: string, items: readonly unknown[]) {
  const keys = await outside('laya-quality-key-');
  const keyFile = join(keys, 'corpus.key');
  await gateRunner.generateCorpusKey(keyFile, { root });
  const directory = await outside('laya-quality-corpus-');
  await gateRunner.sealCorpusFile({ keyFile, corpus: directory, plaintext: corpus(items), root });
  return {
    keyFile,
    directory,
    key: await gateRunner.readCorpusKey(keyFile, { root }),
    async remove() {
      await rm(keys, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else found.push(path);
    }
  };
  await visit(root, '');
  return found.sort();
}

test('E2 quality gate run: refuses without written-consent attestation or an explicit corpus directory', {
  skip: WINDOWS_SKIP,
}, async () => {
  const gateRunner = await runner();
  await withFixtureRoot(async (root) => {
    const base = { root, platform: 'darwin', architecture: 'arm64' };
    assert.equal(await asyncCodeOf(() => gateRunner.runQualityGate(base, {})), 'QUALITY_CONSENT_REQUIRED');
    assert.equal(
      await asyncCodeOf(() => gateRunner.runQualityGate({ ...base, attestWrittenConsent: true }, {})),
      'QUALITY_CORPUS_REQUIRED',
    );
    assert.equal(
      await asyncCodeOf(() =>
        gateRunner.runQualityGate({ ...base, attestWrittenConsent: true, platform: 'linux' }, {}),
      ),
      'QUALITY_PLATFORM',
    );
  });
  const result = await run(runnerScript, ['run']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^QUALITY_CONSENT_REQUIRED: [^\n]+\n$/);
});

test('E2 quality gate run: a corpus or key inside the repository is refused', { skip: WINDOWS_SKIP }, async () => {
  const gateRunner = await runner();
  await withFixtureRoot(async (root) => {
    const inside = join(root, 'corpus');
    await mkdir(inside);
    const options = { root, platform: 'darwin', architecture: 'arm64', attestWrittenConsent: true };
    assert.equal(
      await asyncCodeOf(() => gateRunner.runQualityGate({ ...options, corpus: inside }, {})),
      'QUALITY_INSIDE_REPOSITORY',
    );
    assert.equal(
      codeOf(() =>
        gateRunner.assertOutsideRepository(join(repositoryRoot, 'docs'), { root, what: 'the corpus directory' }),
      ),
      'QUALITY_INSIDE_REPOSITORY',
      'the runner checkout itself is refused too',
    );
    assert.equal(
      codeOf(() => gateRunner.assertOutsideRepository(tmpdir(), { root, what: 'the corpus directory' })),
      'QUALITY_INSIDE_REPOSITORY',
      'a directory that contains the checkout is refused',
    );
    assert.equal(
      codeOf(() => gateRunner.assertOutsideRepository('corpus', { root, what: 'the corpus directory' })),
      'QUALITY_PATH',
    );
    const links = await outside('laya-quality-link-');
    try {
      await symlink(root, join(links, 'checkout'), 'dir');
      assert.equal(
        codeOf(() =>
          gateRunner.assertOutsideRepository(join(links, 'checkout', 'new.key'), { root, what: 'the corpus key' }),
        ),
        'QUALITY_INSIDE_REPOSITORY',
        'a new file reached through a link into the checkout is inside it',
      );
    } finally {
      await rm(links, { recursive: true, force: true });
    }
    const keyFile = join(root, 'corpus.key');
    await writeFile(keyFile, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
    assert.equal(await asyncCodeOf(() => gateRunner.readCorpusKey(keyFile, { root })), 'QUALITY_INSIDE_REPOSITORY');
  });
});

test('E2 quality gate run: the corpus directory holds only sealed corpus files', { skip: WINDOWS_SKIP }, async () => {
  const gateRunner = await runner();
  await withFixtureRoot(async (root) => {
    const sealed = await sealedCorpus(gateRunner, root, [gmailItem(0, 1)]);
    try {
      assert.equal((await gateRunner.readCorpusDirectory(sealed.directory, { key: sealed.key, root })).length, 1);
      const [name] = await readdir(sealed.directory);
      assert.ok(name?.endsWith('.lqc'));
      const bytes = await readFile(join(sealed.directory, name ?? ''));
      const renamed = await outside('laya-quality-corpus-');
      const plaintext = await outside('laya-quality-corpus-');
      const nested = await outside('laya-quality-corpus-');
      try {
        await writeFile(join(renamed, 'corpus.json'), bytes, { mode: 0o600 });
        assert.equal(
          await asyncCodeOf(() => gateRunner.readCorpusDirectory(renamed, { key: sealed.key, root })),
          'QUALITY_CORPUS_UNENCRYPTED',
          'only *.lqc files are read, even a sealed file under another name',
        );
        await writeFile(join(plaintext, 'corpus.lqc'), corpus([gmailItem(1, 0)]), { mode: 0o600 });
        assert.equal(
          await asyncCodeOf(() => gateRunner.readCorpusDirectory(plaintext, { key: sealed.key, root })),
          'QUALITY_CORPUS_UNENCRYPTED',
          'a plaintext corpus is refused as unencrypted',
        );
        await mkdir(join(nested, 'more.lqc'));
        assert.equal(
          await asyncCodeOf(() => gateRunner.readCorpusDirectory(nested, { key: sealed.key, root })),
          'QUALITY_CORPUS_UNENCRYPTED',
        );
      } finally {
        for (const directory of [renamed, plaintext, nested]) await rm(directory, { recursive: true, force: true });
      }
    } finally {
      await sealed.remove();
    }
  });
});

test('E2 quality gate run: the corpus key is an owner-only file outside the repository and opens only its corpus', {
  skip: WINDOWS_SKIP,
}, async () => {
  const gateRunner = await runner();
  await withFixtureRoot(async (root) => {
    const sealed = await sealedCorpus(gateRunner, root, [slackItem(0, 0)]);
    const other = await outside('laya-quality-key-');
    try {
      assert.equal((await stat(sealed.keyFile)).mode & 0o777, 0o600);
      await assert.rejects(
        gateRunner.generateCorpusKey(sealed.keyFile, { root }),
        /EEXIST/u,
        'a key is never overwritten',
      );
      const shared = join(other, 'shared.key');
      await writeFile(shared, `${Buffer.alloc(32, 9).toString('base64')}\n`, { mode: 0o600 });
      await chmod(shared, 0o640);
      assert.equal(
        await asyncCodeOf(() => gateRunner.readCorpusKey(shared, { root })),
        'QUALITY_KEY',
        'group-readable',
      );
      const short = join(other, 'short.key');
      await writeFile(short, 'c2hvcnQ=\n', { mode: 0o600 });
      assert.equal(await asyncCodeOf(() => gateRunner.readCorpusKey(short, { root })), 'QUALITY_KEY');
      const [name] = await readdir(sealed.directory);
      assert.ok(name);
      assert.equal(
        codeOf(() => gateRunner.openCorpus(Buffer.alloc(32, 1), Buffer.from('not sealed'))),
        'QUALITY_CORPUS_UNENCRYPTED',
      );
      const bytes = await readFile(join(sealed.directory, name));
      assert.equal(
        codeOf(() => gateRunner.openCorpus(Buffer.alloc(32, 1), bytes)),
        'QUALITY_CORPUS_KEY',
      );
      const opened = gateRunner.openCorpus(sealed.key, bytes);
      assert.equal(gateRunner.parseCorpusItems(opened).length, 1);
      assert.equal(bytes.includes(Buffer.from('Synthetic')), false, 'the sealed file holds no plaintext');
    } finally {
      await rm(other, { recursive: true, force: true });
      await sealed.remove();
    }
  });
});

test('E2 quality reference gate: only the pinned snapshot runs, and its value is read where the record puts it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const gateRunner = await runner();
  assert.match(gateRunner.REFERENCE_DRIVER, /agent = RLAgent\(snapshot, device="cpu"\)/u);
  assert.match(
    gateRunner.REFERENCE_DRIVER,
    /agent\.system_one\(request\["state"\], \{"decision": request\["question"\]\}\)/u,
  );
  assert.deepEqual(gateRunner.referenceQuestion(LAYA_NOUL_TEMPLATE_ID, 'Is it urgent?'), {
    type: 'noul',
    instructions: 'Is it urgent?',
  });
  assert.deepEqual(gateRunner.referenceQuestion(LAYA_CHOICE2_TEMPLATE_ID, 'Is it urgent?'), {
    type: 'choice',
    instructions: 'Is it urgent?',
    criteria: { a: 'yes, the statement holds', b: 'no, the statement does not hold' },
  });
  const answer = (decision: unknown, inputTokens = 37) => ({ type: 'answer', answer: decision, inputTokens });
  assert.deepEqual(gateRunner.referenceOutcome(LAYA_NOUL_TEMPLATE_ID, answer({ type: 'noul', noul: 0.8123 })), {
    kind: 'answer',
    value: 0.8123,
    inputTokens: 37,
  });
  assert.deepEqual(
    gateRunner.referenceOutcome(
      LAYA_CHOICE2_TEMPLATE_ID,
      answer({ type: 'choice', probabilities: { a: 0.7104, b: 0.2896 } }),
    ),
    { kind: 'answer', value: 0.7104, inputTokens: 37 },
    'the affirmative key a is the template value',
  );
  for (const [templateId, decision] of [
    [LAYA_NOUL_TEMPLATE_ID, { type: 'noul', noul: 1.2 }],
    [LAYA_NOUL_TEMPLATE_ID, { type: 'choice', probabilities: { a: 0.5, b: 0.5 } }],
    [LAYA_CHOICE2_TEMPLATE_ID, { type: 'choice', probabilities: { a: 0.5 } }],
    [LAYA_CHOICE2_TEMPLATE_ID, { type: 'choice', probabilities: { a: 0.5, b: 0.4, c: 0.1 } }],
    [LAYA_CHOICE2_TEMPLATE_ID, { type: 'choice', probabilities: { a: -0.1, b: 1.1 } }],
  ] as const) {
    assert.deepEqual(gateRunner.referenceOutcome(templateId, answer(decision)), { kind: 'refused' });
  }
  assert.deepEqual(gateRunner.referenceOutcome(LAYA_NOUL_TEMPLATE_ID, { type: 'refused' }), { kind: 'refused' });
  assert.deepEqual(gateRunner.referenceOutcome(LAYA_NOUL_TEMPLATE_ID, answer({ type: 'noul', noul: 0.5 }, 0)), {
    kind: 'refused',
  });

  const snapshot = await outside('laya-quality-snapshot-');
  try {
    const file = Buffer.from('synthetic reference file\n');
    await writeFile(join(snapshot, 'rl_agent_api.py'), file);
    const { createHash } = await import('node:crypto');
    const pin = {
      api: { path: 'rl_agent_api.py', size: file.length, sha256: createHash('sha256').update(file).digest('hex') },
    };
    assert.equal(await gateRunner.verifyReferenceSnapshot(snapshot, { files: pin }), snapshot);
    await writeFile(join(snapshot, 'json.py'), 'raise SystemExit\n');
    assert.equal(
      await asyncCodeOf(() => gateRunner.verifyReferenceSnapshot(snapshot, { files: pin })),
      'QUALITY_REFERENCE_UNPINNED',
      'a planted module beside the reference is refused',
    );
    await rm(join(snapshot, 'json.py'));
    await writeFile(join(snapshot, 'rl_agent_api.py'), 'synthetic reference filE\n');
    assert.equal(
      await asyncCodeOf(() => gateRunner.verifyReferenceSnapshot(snapshot, { files: pin })),
      'QUALITY_REFERENCE_UNPINNED',
      'a changed byte is another reference',
    );
    assert.equal(await asyncCodeOf(() => gateRunner.verifyReferenceSnapshot(snapshot)), 'QUALITY_REFERENCE_UNPINNED');
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
});

test('E2 quality gate run: an aggregate that does not validate is never written', { skip: WINDOWS_SKIP }, async () => {
  const gateRunner = await runner();
  await withFixtureRoot(async (root, gate) => {
    const synthetic = gate.applyFixtureEdits(metrics.report, [
      ...Object.entries(gate.QUALITY_CORPUS_RELEASE).map(([key, value]) => ({
        op: 'set',
        pointer: `/corpus/${key}`,
        value,
      })),
      { op: 'set', pointer: '/architectures/0/referenceEnvironment/python', value: '3.12.7 (main, Oct  1 2026)' },
    ]);
    assert.equal(
      await asyncCodeOf(() => gateRunner.writeGateReport({ root, report: synthetic })),
      'QUALITY_REPORT_RAW',
    );
    assert.deepEqual(
      (await filesBelow(root)).filter((path) => path.startsWith(gate.GATE_REPORT_DIRECTORY)),
      [],
      'nothing is written',
    );
  });
});

function standinWorker(seen: { state: string; templateId: string }[], abort = false): WorkerStandin {
  let requests = 0;
  return {
    async evaluate(request) {
      requests += 1;
      seen.push({ state: request.state, templateId: request.templateId });
      if (abort) return { outcome: { kind: 'abort', code: 'boundary-failed' }, cold: true, ms: 0 };
      if (request.templateId === LAYA_CHOICE2_TEMPLATE_ID)
        return { outcome: { kind: 'refused', code: 'templateBlocked' }, cold: requests === 1, ms: 1 };
      const value = request.state.includes('positive') ? 0.95 : 0.05;
      return { outcome: { kind: 'answer', value, inputTokens: 52 }, cold: requests === 1, ms: 130 };
    },
    memorySamples: () => [2_100_000_000],
    async close() {},
  };
}

function standinReference(environment: Readonly<Record<string, string>> = {}): ReferenceStandin {
  return {
    environment: {
      python: '0.0.0-standin',
      torch: '0.0.0-standin',
      transformers: '0.0.0-standin',
      numpy: '0.0.0-standin',
      ...environment,
    },
    async evaluate(request) {
      return { kind: 'answer', value: request.state.includes('positive') ? 0.9504 : 0.0497, inputTokens: 52 };
    },
    async close() {},
  };
}

test('E2 quality gate run: refusals are counted and a worker that cannot run stops the run', {
  skip: WINDOWS_SKIP,
}, async () => {
  const gateRunner = await runner();
  assert.deepEqual(gateRunner.workerOutcome({ kind: 'answer', value: 0.4, inputTokens: 9 }), {
    kind: 'answer',
    value: 0.4,
    inputTokens: 9,
  });
  for (const [code, counted] of [
    ['laya-token-limit', 'tokenLimit'],
    ['laya-request-too-large', 'tokenLimit'],
    ['laya-malformed', 'malformed'],
    ['laya-template-blocked', 'templateBlocked'],
    ['laya-timeout', 'timeout'],
    ['laya-crashed', 'crashed'],
    ['laya-something-new', 'other'],
  ] as const) {
    assert.deepEqual(gateRunner.workerOutcome({ kind: 'refused', code }), { kind: 'refused', code: counted });
  }
  for (const code of ['boundary-failed', 'runtime-failed', 'integrity', 'LAYA_SANDBOX_UNAVAILABLE', 'laya-not-ready'])
    assert.equal(gateRunner.workerOutcome({ kind: 'refused', code }).kind, 'abort', code);
  await withFixtureRoot(async (root, gate) => {
    const candidate = gate.computeCandidate({ root, architecture: 'arm64' });
    const items = [{ channel: 'gmail', language: 'en', label: 1, instructions: QUESTION, state: '{"version":1}' }];
    assert.equal(
      await asyncCodeOf(() =>
        gateRunner.measureCandidate({
          candidate,
          items,
          worker: standinWorker([], true),
          reference: standinReference(),
        }),
      ),
      'QUALITY_WORKER_UNAVAILABLE',
    );
  });
});

test("E2 quality gate run: a sealed corpus holds only labelled pairs whose event is their channel's", {
  skip: WINDOWS_SKIP,
}, async () => {
  const gateRunner = await runner();
  assert.equal(gateRunner.parseCorpusItems(corpus([gmailItem(0, 1), slackItem(1, 0)])).length, 2);
  const crossed = {
    ...gmailItem(2, 1),
    event: { ...gmailItem(2, 1).event, account: { ...slackMessagePostedV1.examples[0]?.account } },
  };
  for (const [name, plaintext] of [
    ['an event from the other channel', corpus([crossed])],
    ['a label that is not 0 or 1', corpus([{ ...gmailItem(3, 1), label: 2 }])],
    ['a language that is not a closed code', corpus([{ ...gmailItem(4, 1), language: 'English' }])],
    ['an extra field', corpus([{ ...gmailItem(5, 1), note: 'x' }])],
    ['no judge input pointers', corpus([{ ...gmailItem(6, 1), inputs: [] }])],
    ['another format', Buffer.from(JSON.stringify({ format: 'other', items: [gmailItem(7, 1)] }))],
    ['an empty corpus', corpus([])],
  ] as const) {
    assert.equal(
      codeOf(() => gateRunner.parseCorpusItems(plaintext)),
      'QUALITY_CORPUS_ITEM',
      name,
    );
  }
  try {
    gateRunner.parseCorpusItems(corpus([{ ...gmailItem(8, 1), label: 2 }]));
  } catch (error) {
    assert.equal(String(error).includes('Synthetic'), false, 'a refusal never echoes corpus content');
  }
});

test('E2 quality gate run: only the aggregate leaves the run', { skip: WINDOWS_SKIP }, async () => {
  const gateRunner = await runner();
  await withFixtureRoot(async (root, gate) => {
    const items = [
      ...Array.from({ length: 220 }, (_, index) => gmailItem(index, index % 2 === 0 ? 1 : 0)),
      ...Array.from({ length: 210 }, (_, index) => slackItem(index, index % 3 === 0 ? 1 : 0)),
    ];
    const sealed = await sealedCorpus(gateRunner, root, items);
    const filesBefore = await filesBelow(root);
    const corpusBefore = await filesBelow(sealed.directory);
    const seen: { state: string; templateId: string }[] = [];
    try {
      const result = await gateRunner.runQualityGate(
        {
          root,
          platform: 'darwin',
          architecture: 'arm64',
          attestWrittenConsent: true,
          corpus: sealed.directory,
          keyFile: sealed.keyFile,
          reference: '/nonexistent/reference-snapshot',
          python: '/nonexistent/python',
          runtimeTree: '/nonexistent/runtime',
          modelTree: '/nonexistent/model',
          node: '0.0.0-standin',
        },
        {
          verifyReferenceSnapshot: async () => undefined,
          verifyCandidateTrees: async () => true,
          createWorkerEvaluator: async () => standinWorker(seen),
          createPythonReference: async () => standinReference(),
        },
      );
      assert.equal(result.path, 'packages/events-laya-runtime/gate/laya-en-onnx-68f27dfe.json');
      assert.deepEqual(result.lines, [
        'laya-choice2-v1 gmail: did not pass (220 pairs)',
        'laya-choice2-v1 slack: did not pass (210 pairs)',
        'laya-noul-v1 gmail: passed (220 pairs)',
        'laya-noul-v1 slack: passed (210 pairs)',
      ]);
      const gmailStates = seen.filter((entry) => entry.state.includes('Synthetic positive subject 0'));
      assert.equal(gmailStates.length, 2, 'each template asked once per item');
      const envelope = JSON.parse(gmailStates[0]?.state ?? '{}') as {
        version?: number;
        inputs?: { pointer: string }[];
      };
      assert.equal(envelope.version, 1, "the worker is asked E's own judge envelope");
      assert.deepEqual(
        envelope.inputs?.map((input) => input.pointer),
        ['/subject', '/body'],
      );
      assert.equal(gmailStates[0]?.state.includes('<untrusted-content boundary='), true);

      assert.deepEqual(
        await filesBelow(root),
        [...filesBefore, result.path].sort(),
        'the one artifact is the aggregate',
      );
      assert.deepEqual(await filesBelow(sealed.directory), corpusBefore, 'the corpus directory is untouched');
      const bytes = await readFile(join(root, result.path), 'utf8');
      for (const output of [bytes, result.lines.join('\n')]) {
        for (const content of ['Synthetic', 'quarterly', '@', 'untrusted-content', '/subject', QUESTION]) {
          assert.equal(output.includes(content), false, `no ${content} leaves the run`);
        }
      }
      const report = JSON.parse(bytes) as { architectures: { templates: TemplateBlock[] }[] };
      const [choice, noul] = report.architectures[0]?.templates ?? [];
      assert.deepEqual(
        choice?.channels.map((channel) => [channel.refused.templateBlocked, channel.passed]),
        [
          [220, false],
          [210, false],
        ],
      );
      assert.deepEqual(
        noul?.channels.map((channel) => [channel.answered, channel.auroc, channel.passed]),
        [
          [220, 1, true],
          [210, 1, true],
        ],
      );
      assert.equal(
        codeOf(() => gate.verifyQualityGate({ root })),
        'QUALITY_GATE_FAILED',
        'with laya-choice2-v1 refused, this stand-in run cannot offer the manifest',
      );
    } finally {
      await sealed.remove();
    }
  });
});
