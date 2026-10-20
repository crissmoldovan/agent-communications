#!/usr/bin/env node
/**
 * D11's labelled quality gate, its static half (E2-8, Task 9). The protected owner run
 * (`scripts/run-laya-quality-gate.mjs`) measures the candidate's worker against a consented, encrypted, external
 * Gmail and Slack corpus and keeps every item in memory; what it writes, and what this verifier accepts, is only an
 * aggregate: `packages/events-laya-runtime/gate/<manifestId>.json`.
 *
 * This module is the one definition of the gate's arithmetic (ten equal-width-bin ECE, Brier score, AUROC, positive
 * share, nearest-rank latency percentile, peak memory, maximum reference delta), of its thresholds, of the report's
 * closed shape and privacy scan, and of the candidate the report must be bound to: the reviewed manifest and runtime
 * lock, the architecture's platform file list, the templates' digests, the runner's digest and a report-excluding
 * candidate-subject digest recomputed here from the checkout. The Python reference the report names must be the one
 * the source record pins (`hf-laya-python-reference` and its Task 9 entries).
 *
 * No synthetic vector here, in the fixtures or in a test is a quality claim. A report marked as fixture evidence is
 * refused as release evidence, and a release accepts only a report whose every manifest template passes on Gmail and
 * on Slack separately for each architecture it offers.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLayaJudgeKindDefinition } from '../packages/events-daemon/src/runtime/laya/contracts.ts';
import { isLayaTemplateId, layaTemplateDigest } from '../packages/events-daemon/src/runtime/laya/templates.ts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export const QUALITY_GATE_SCHEMA_VERSION = 1;
export const QUALITY_CHANNELS = Object.freeze(['gmail', 'slack']);
export const QUALITY_ARCHITECTURES = Object.freeze(['arm64', 'x64']);
export const CALIBRATION_BINS = 10;
/** D11, for Gmail and for Slack separately, per template, per architecture. */
export const QUALITY_THRESHOLDS = Object.freeze({
  minPairs: 200,
  minPositiveShare: 0.3,
  maxExpectedCalibrationError: 0.1,
  maxBrierScore: 0.2,
  minAuroc: 0.8,
  maxReferenceDelta: 0.001,
  maxWarmLatencyP95Ms: 2000,
  maxPeakWorkerBytes: 3_000_000_000,
});
/** The worker's closed refusal reasons, counted per channel; only `tokenLimit` is a refusal a passing channel may have. */
export const QUALITY_REFUSALS = Object.freeze([
  'crashed',
  'malformed',
  'other',
  'templateBlocked',
  'timeout',
  'tokenLimit',
]);
/** The probabilities are the bundle's own temperatures applied by the worker, measured on the corpus (D11). */
export const QUALITY_CALIBRATION = 'bundle-temperatures';
export const QUALITY_CORPUS_RELEASE = Object.freeze({
  kind: 'consented-external',
  consent: 'written-attested',
  retention: 'encrypted-external',
  handling: 'aggregate-only',
});
export const QUALITY_CORPUS_FIXTURE_KIND = 'synthetic-fixture';

/**
 * The owner's Python reference (E2-H): `convaiinnovations/laya` at 55cf4c4e, run on CPU through `system_one`, every
 * file it reads bound to its SHA-256 and size (`hf-laya-python-reference`, `hf-laya-python-reference-encoder-config`).
 */
export const PYTHON_REFERENCE = Object.freeze({
  record: 'hf-laya-python-reference',
  revision: '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851',
  invocation: 'system-one-cpu-v1',
  device: 'cpu',
  files: Object.freeze({
    api: Object.freeze({
      path: 'rl_agent_api.py',
      size: 4732,
      sha256: 'be3b46819c9999c3ef88e0f2ecf6d3ab1cdfed1d9a8b466fc89811e34d44031b',
    }),
    common: Object.freeze({
      path: 'rl_common.py',
      size: 19139,
      sha256: '8d83611d480c971d640a7b7d3aa2f2219c5e8455e9cc2329fd073681bd8be23e',
    }),
    config: Object.freeze({
      path: 'rl_agent_config.json',
      size: 745,
      sha256: 'ae287b56bbcf5f8c4f4541ae9dfd00c914c4c48b940b8398c3058af37ba92bbd',
    }),
    encoderConfig: Object.freeze({
      path: 'encoder/config.json',
      size: 2083,
      sha256: 'bf3ab80598fdccf414855a2ce80f22859e4492d06ca8a62ddd1cfb63972f8979',
    }),
    tokenizer: Object.freeze({
      path: 'tokenizer/tokenizer.json',
      size: 3583228,
      sha256: '6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30',
    }),
    tokenizerConfig: Object.freeze({
      path: 'tokenizer/tokenizer_config.json',
      size: 308,
      sha256: '50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12',
    }),
    weights: Object.freeze({
      path: 'model.safetensors',
      size: 842609210,
      sha256: '891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c',
    }),
  }),
});

export const EVIDENCE_RECORD = 'docs/superpowers/evidence/2026-10-10-e2-external-sources.md';
export const GATE_REPORT_DIRECTORY = 'packages/events-laya-runtime/gate';
export const GATE_RUNNER = 'scripts/run-laya-quality-gate.mjs';
/**
 * The candidate subject: the reviewed assets, the daemon's build inputs and the lockfile that pins its toolchain, the
 * daemon-side code that builds and frames the worker's input, the code that checks and installs the trees the gates
 * measure (the strict parsers, the extractor, the tree verifier and the artifact manager: E2 review round 1, A2), and
 * the worker entry with everything it imports. Never the gate's own report. A release that changes any of these needs
 * both gates run again; a version bump alone does not, because the daemon's `package.json` is bound without its
 * `version` (B3).
 */
export const GATE_SUBJECT_FILES = Object.freeze([
  'packages/events-daemon/laya-enablement-disclosures.json',
  'packages/events-daemon/laya-manifest.json',
  'packages/events-daemon/laya-runtime.json',
  'packages/events-daemon/package.json',
  'packages/events-daemon/src/runtime/judge-coordinator.ts',
  'packages/events-daemon/src/runtime/laya/contracts.ts',
  'packages/events-daemon/src/runtime/laya/manager.ts',
  'packages/events-daemon/src/runtime/laya/tar.ts',
  'packages/events-daemon/src/runtime/laya/tree-verifier.ts',
  'packages/events-daemon/src/runtime/laya/worker-supervisor.ts',
  'packages/events-daemon/tsdown.config.ts',
  'pnpm-lock.yaml',
]);
/** The one subject file bound by its meaning rather than its bytes: canonical JSON, without its `version` (B3). */
export const GATE_SUBJECT_VERSIONED_MANIFEST = 'packages/events-daemon/package.json';
export const GATE_WORKER_ENTRY = 'packages/events-daemon/src/runtime/laya/worker-main.ts';
const ASSETS = Object.freeze({
  manifest: 'packages/events-daemon/laya-manifest.json',
  runtimeLock: 'packages/events-daemon/laya-runtime.json',
  disclosures: 'packages/events-daemon/laya-enablement-disclosures.json',
});

export class QualityGateError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'QualityGateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new QualityGateError(code, message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function rawByteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

// ------------------------------------------------------------------------------------------------ the arithmetic

function labelledVector(probabilities, labels) {
  if (!Array.isArray(probabilities) || !Array.isArray(labels) || probabilities.length !== labels.length)
    fail('QUALITY_METRIC_INPUT', 'probabilities and labels are equal-length arrays');
  if (probabilities.length === 0) fail('QUALITY_METRIC_INPUT', 'a metric needs at least one labelled pair');
  for (const value of probabilities) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
      fail('QUALITY_METRIC_INPUT', 'a probability is a finite number within 0 to 1');
  }
  for (const label of labels) {
    if (label !== 0 && label !== 1) fail('QUALITY_METRIC_INPUT', 'a label is 0 or 1');
  }
}

/** The equal-width bin of one probability: [0, 0.1), [0.1, 0.2), …, [0.9, 1]. A probability of exactly 1 is the last. */
export function calibrationBin(probability, bins = CALIBRATION_BINS) {
  return Math.min(bins - 1, Math.floor(probability * bins));
}

/** Expected calibration error over equal-width bins: Σ_b (n_b / N) · |mean(label_b) − mean(p_b)|. */
export function expectedCalibrationError(probabilities, labels, bins = CALIBRATION_BINS) {
  labelledVector(probabilities, labels);
  const count = new Array(bins).fill(0);
  const confidence = new Array(bins).fill(0);
  const positives = new Array(bins).fill(0);
  probabilities.forEach((probability, index) => {
    const bin = calibrationBin(probability, bins);
    count[bin] += 1;
    confidence[bin] += probability;
    positives[bin] += labels[index];
  });
  let error = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    if (count[bin] === 0) continue;
    error += (count[bin] / probabilities.length) * Math.abs(positives[bin] / count[bin] - confidence[bin] / count[bin]);
  }
  return error;
}

/** Brier score: the mean squared difference between each probability and its 0/1 label. */
export function brierScore(probabilities, labels) {
  labelledVector(probabilities, labels);
  let total = 0;
  probabilities.forEach((probability, index) => {
    total += (probability - labels[index]) ** 2;
  });
  return total / probabilities.length;
}

/**
 * Area under the ROC curve as the Mann–Whitney statistic: the share of (positive, negative) pairs the probabilities
 * order correctly, a tie counting one half. Null when either class is absent, since then it is undefined.
 */
export function areaUnderRoc(probabilities, labels) {
  labelledVector(probabilities, labels);
  const positives = probabilities.filter((_, index) => labels[index] === 1);
  const negatives = probabilities.filter((_, index) => labels[index] === 0);
  if (positives.length === 0 || negatives.length === 0) return null;
  const sorted = [...negatives].sort((left, right) => left - right);
  let concordant = 0;
  for (const positive of positives) {
    let below = 0;
    let tied = 0;
    for (const negative of sorted) {
      if (negative < positive) below += 1;
      else if (negative === positive) tied += 1;
      else break;
    }
    concordant += below + 0.5 * tied;
  }
  return concordant / (positives.length * negatives.length);
}

export function positiveShare(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return null;
  for (const label of labels) if (label !== 0 && label !== 1) fail('QUALITY_METRIC_INPUT', 'a label is 0 or 1');
  return labels.reduce((sum, label) => sum + label, 0) / labels.length;
}

/** Nearest-rank percentile: the smallest value at or above which `quantile` of the values lie. Null when empty. */
export function nearestRankPercentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      fail('QUALITY_METRIC_INPUT', 'a latency is a finite, non-negative number');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1];
}

/** Peak worker memory: the largest sampled resident size, in bytes. Null when nothing was sampled. */
export function peakOf(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample) || sample < 0) fail('QUALITY_METRIC_INPUT', 'a memory sample is a byte count');
  }
  return samples.reduce((peak, sample) => Math.max(peak, sample), 0);
}

/** The largest absolute difference between the worker's and the reference's probability for the same item. */
export function maximumReferenceDelta(worker, reference) {
  if (!Array.isArray(worker) || !Array.isArray(reference) || worker.length !== reference.length)
    fail('QUALITY_METRIC_INPUT', 'worker and reference probabilities are paired');
  if (worker.length === 0) return null;
  labelledVector(
    worker,
    worker.map(() => 0),
  );
  labelledVector(
    reference,
    reference.map(() => 0),
  );
  return worker.reduce((largest, value, index) => Math.max(largest, Math.abs(value - reference[index])), 0);
}

// ------------------------------------------------------------------------------------------------ one channel

const LANGUAGE = /^(?:[a-z]{2,3}|und)$/;
const MAX_LANGUAGES = 64;

function emptyRefusals() {
  return Object.fromEntries(QUALITY_REFUSALS.map((code) => [code, 0]));
}

/**
 * One channel's aggregate from its in-memory observations. Each observation is one labelled pair: its language and
 * label, the worker's outcome, and — only when the worker answered — the reference's. Nothing per item is returned.
 */
export function aggregateChannel(channel, observations, measurements = {}) {
  if (!QUALITY_CHANNELS.includes(channel)) fail('QUALITY_METRIC_INPUT', 'a channel is gmail or slack');
  const refused = emptyRefusals();
  const languages = new Map();
  const workerValues = [];
  const referenceValues = [];
  const answeredLabels = [];
  let referenceAnswered = 0;
  let referenceRefused = 0;
  let inputTokenMismatches = 0;
  for (const observation of observations) {
    if (observation.channel !== channel) fail('QUALITY_METRIC_INPUT', 'an observation belongs to its channel');
    if (!LANGUAGE.test(observation.language)) fail('QUALITY_METRIC_INPUT', 'a language is a closed code');
    const language = languages.get(observation.language) ?? { pairs: 0, answered: 0, refusedForLength: 0 };
    languages.set(observation.language, language);
    language.pairs += 1;
    const outcome = observation.worker;
    if (outcome.kind !== 'answer') {
      if (!QUALITY_REFUSALS.includes(outcome.code)) fail('QUALITY_METRIC_INPUT', 'a refusal has a closed code');
      refused[outcome.code] += 1;
      if (outcome.code === 'tokenLimit') language.refusedForLength += 1;
      continue;
    }
    language.answered += 1;
    answeredLabels.push(observation.label);
    workerValues.push(outcome.value);
    const reference = observation.reference;
    if (reference?.kind !== 'answer') {
      referenceRefused += 1;
      continue;
    }
    referenceAnswered += 1;
    if (reference.inputTokens !== outcome.inputTokens) inputTokenMismatches += 1;
    referenceValues.push({ worker: outcome.value, reference: reference.value });
  }
  if (languages.size > MAX_LANGUAGES) fail('QUALITY_METRIC_INPUT', 'a channel reports at most 64 languages');
  const answered = workerValues.length;
  const measured = answered > 0;
  const block = {
    channel,
    pairs: observations.length,
    answered,
    refused,
    positiveShare: positiveShare(answeredLabels),
    languages: [...languages.entries()]
      .sort(([left], [right]) => rawByteCompare(left, right))
      .map(([language, counts]) => ({ language, ...counts })),
    expectedCalibrationError: measured ? expectedCalibrationError(workerValues, answeredLabels) : null,
    brierScore: measured ? brierScore(workerValues, answeredLabels) : null,
    auroc: measured ? areaUnderRoc(workerValues, answeredLabels) : null,
    reference: {
      answered: referenceAnswered,
      refused: referenceRefused,
      inputTokenMismatches,
      maxProbabilityDelta: maximumReferenceDelta(
        referenceValues.map((pair) => pair.worker),
        referenceValues.map((pair) => pair.reference),
      ),
    },
    warmLatencyP95Ms: nearestRankPercentile(measurements.warmLatenciesMs ?? [], 0.95),
    warmRequests: (measurements.warmLatenciesMs ?? []).length,
    peakWorkerBytes: peakOf(measurements.memorySamples ?? []),
  };
  return { ...block, passed: channelPasses(block) };
}

function atMost(value, limit) {
  return value !== null && value <= limit;
}

/** D11's verdict for one channel, from its aggregate alone: the same rule the runner applies and the verifier rechecks. */
export function channelPasses(block) {
  const refusals = QUALITY_REFUSALS.filter((code) => code !== 'tokenLimit').every((code) => block.refused[code] === 0);
  return (
    block.pairs >= QUALITY_THRESHOLDS.minPairs &&
    block.answered >= QUALITY_THRESHOLDS.minPairs &&
    block.positiveShare !== null &&
    block.positiveShare >= QUALITY_THRESHOLDS.minPositiveShare &&
    refusals &&
    atMost(block.expectedCalibrationError, QUALITY_THRESHOLDS.maxExpectedCalibrationError) &&
    atMost(block.brierScore, QUALITY_THRESHOLDS.maxBrierScore) &&
    block.auroc !== null &&
    block.auroc >= QUALITY_THRESHOLDS.minAuroc &&
    block.reference.answered === block.answered &&
    block.reference.refused === 0 &&
    block.reference.inputTokenMismatches === 0 &&
    atMost(block.reference.maxProbabilityDelta, QUALITY_THRESHOLDS.maxReferenceDelta) &&
    atMost(block.warmLatencyP95Ms, QUALITY_THRESHOLDS.maxWarmLatencyP95Ms) &&
    atMost(block.peakWorkerBytes, QUALITY_THRESHOLDS.maxPeakWorkerBytes)
  );
}

/**
 * One template's aggregate: Gmail and Slack measured and judged separately, never one combined score (D11). The
 * observations of both channels arrive together; each channel sees only its own.
 */
export function aggregateTemplate(templateId, templateSha256, observations, measurements = {}) {
  const channels = QUALITY_CHANNELS.map((channel) =>
    aggregateChannel(
      channel,
      observations.filter((observation) => observation.channel === channel),
      measurements[channel] ?? {},
    ),
  );
  return { templateId, templateSha256, channels, passed: channels.every((channel) => channel.passed) };
}

// ------------------------------------------------------------------------------------------------ the candidate

function readRootFile(root, path) {
  const target = resolve(root, path);
  if (!target.startsWith(`${resolve(root)}${sep}`)) fail('QUALITY_CANDIDATE', 'a candidate path escapes its root');
  try {
    const info = lstatSync(target);
    if (!info.isFile()) fail('QUALITY_CANDIDATE', `${path} is not a regular file`);
  } catch (error) {
    if (error instanceof QualityGateError) throw error;
    fail('QUALITY_CANDIDATE', `${path} is missing from the candidate`);
  }
  return readFileSync(target);
}

function relativeImports(source) {
  return [...source.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)].map((match) => match[2]);
}

/** Refuses a subject that would contain the gate's own report: the report cannot bind the bytes it is part of. */
export function assertSubjectExcludesReport(files) {
  for (const file of files) {
    if (file === GATE_REPORT_DIRECTORY || file.startsWith(`${GATE_REPORT_DIRECTORY}/`))
      fail('QUALITY_SUBJECT_INCLUDES_REPORT', 'the candidate subject must exclude the gate report directory');
  }
  return files;
}

/** The subject's files: the fixed list and the worker entry's whole relative-import closure, in raw-byte order. */
export function gateSubjectFiles(root) {
  const files = new Set(GATE_SUBJECT_FILES);
  const pending = [GATE_WORKER_ENTRY];
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assertSubjectExcludesReport([file]);
    files.add(file);
    for (const specifier of relativeImports(readRootFile(root, file).toString('utf8'))) {
      const target = relative(root, resolve(root, dirname(file), specifier))
        .split(sep)
        .join('/');
      if (target.startsWith('..')) fail('QUALITY_CANDIDATE', 'a worker import escapes the candidate');
      pending.push(target);
    }
  }
  return assertSubjectExcludesReport([...files].sort(rawByteCompare));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort(rawByteCompare)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The bytes a subject file is bound by: its own, except the daemon's `package.json`, which is bound as canonical JSON
 * with only its `version` removed, so a release's version bump keeps the evidence and every other change does not.
 */
export function gateSubjectBytes(root, path) {
  const bytes = readRootFile(root, path);
  if (path !== GATE_SUBJECT_VERSIONED_MANIFEST) return bytes;
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('QUALITY_CANDIDATE', `${path} is not JSON`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))
    fail('QUALITY_CANDIDATE', `${path} is not a package manifest`);
  const { version: _version, ...unversioned } = manifest;
  return Buffer.from(canonicalJson(unversioned), 'utf8');
}

/** The report-excluding candidate subject for one architecture: every subject file's path and SHA-256. */
export function gateSubjectDigest(root, architecture) {
  const files = gateSubjectFiles(root).map((path) => ({ path, sha256: sha256(gateSubjectBytes(root, path)) }));
  return sha256(JSON.stringify({ schemaVersion: 1, architecture, files }));
}

/**
 * Everything a report must be bound to, recomputed from a checkout: the strict-parsed reviewed manifest and runtime
 * lock (the placeholder lock refuses), the architecture's platform file list, the runtime versions, each manifest
 * template's digest, the runner's digest and the subject digest.
 */
export function computeCandidate({ root = repositoryRoot, architecture }) {
  if (!QUALITY_ARCHITECTURES.includes(architecture)) fail('QUALITY_CANDIDATE', 'an architecture is arm64 or x64');
  const manifestBytes = readRootFile(root, ASSETS.manifest);
  const runtimeLockBytes = readRootFile(root, ASSETS.runtimeLock);
  const disclosuresBytes = readRootFile(root, ASSETS.disclosures);
  let enablement;
  try {
    enablement = createLayaJudgeKindDefinition({
      assets: { manifestBytes, runtimeLockBytes, disclosuresBytes },
      platform: { platform: 'darwin', architecture },
    }).preview({ version: 1 });
  } catch (error) {
    const code = error?.code === 'E2_EXTERNAL_REFERENCE_BLOCKED' ? 'QUALITY_CANDIDATE_BLOCKED' : 'QUALITY_CANDIDATE';
    fail(code, 'the candidate has no reviewed Laya manifest and runtime lock for this architecture');
  }
  const manifest = enablement.manifest;
  const templates = manifest.promptTemplates.map((templateId) => {
    if (!isLayaTemplateId(templateId))
      fail('QUALITY_CANDIDATE', 'a manifest template is not one the worker implements');
    return { templateId, templateSha256: layaTemplateDigest(templateId) };
  });
  return {
    manifestId: manifest.manifestId,
    manifestSha256: sha256(manifestBytes),
    runtimeLockSha256: sha256(runtimeLockBytes),
    runtime: {
      laya: manifest.runtime['@receptron/laya'],
      onnxruntimeNode: manifest.runtime['onnxruntime-node'],
      tokenizers: manifest.runtime['@huggingface/tokenizers'],
    },
    runnerSha256: sha256(readRootFile(root, GATE_RUNNER)),
    architecture,
    platformFileListDigest: enablement.runtimeLock.platform.digest,
    subjectDigest: gateSubjectDigest(root, architecture),
    templates,
    enablement,
  };
}

// ------------------------------------------------------------------------------------------------ the source record

function recordSections(record, id) {
  const sections = [];
  const pattern = /^### (\S+)\s*$/gm;
  const headings = [...record.matchAll(pattern)];
  headings.forEach((heading, index) => {
    if (heading[1] !== id && !heading[1].startsWith(`${id}-`)) return;
    const end = index + 1 < headings.length ? headings[index + 1].index : record.length;
    const next = record.indexOf('\n## ', heading.index);
    sections.push({ id: heading[1], text: record.slice(heading.index, next !== -1 && next < end ? next : end) });
  });
  return sections;
}

/**
 * The Python reference must be the one the fetched-source record pins: its entry present, bound to an immutable
 * 40-hex revision equal to the pin, running on CPU, and every file the reference reads named by its SHA-256.
 */
export function verifyPythonReferenceRecord(root = repositoryRoot) {
  const path = join(root, EVIDENCE_RECORD);
  if (!existsSync(path)) fail('QUALITY_REFERENCE_RECORD', 'the fetched-source record is absent');
  const record = readFileSync(path, 'utf8');
  const sections = recordSections(record, PYTHON_REFERENCE.record);
  const main = sections.find((section) => section.id === PYTHON_REFERENCE.record);
  if (main === undefined) fail('QUALITY_REFERENCE_RECORD', 'the record has no Python reference entry');
  // The pin is a full 40-hex commit, so only an entry bound to exactly it is immutable: a branch, tag or short form
  // is refused here as a mutable reference.
  const immutable = /^- immutable: `([^`]+)`/m.exec(main.text)?.[1] ?? '';
  if (immutable !== PYTHON_REFERENCE.revision)
    fail('QUALITY_REFERENCE_RECORD', 'the Python reference entry is not bound to the pinned immutable revision');
  if (!main.text.includes('device="cpu"')) fail('QUALITY_REFERENCE_RECORD', 'the Python reference runs on CPU');
  const text = sections.map((section) => section.text).join('\n');
  for (const file of Object.values(PYTHON_REFERENCE.files)) {
    if (!text.includes(file.sha256)) fail('QUALITY_REFERENCE_RECORD', 'a Python reference input is not in the record');
  }
  return PYTHON_REFERENCE;
}

// ------------------------------------------------------------------------------------------------ the report

const FORBIDDEN_KEYS = new Set([
  'address',
  'addresses',
  'body',
  'content',
  'email',
  'emails',
  'event',
  'eventid',
  'events',
  'file',
  'filename',
  'handle',
  'handles',
  'instructions',
  'item',
  'items',
  'label',
  'labels',
  'latencies',
  'message',
  'messages',
  'password',
  'path',
  'paths',
  'prediction',
  'predictions',
  'probabilities',
  'probability',
  'question',
  'questions',
  'samples',
  'score',
  'scores',
  'secret',
  'state',
  'subject',
  'text',
  'token',
  'tokens',
  'user',
  'value',
  'values',
]);
const SAFE_STRING = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SECRET_PREFIX = /^(?:sk-|pk-|rk-|re_|hf_|ghp_|gho_|ghs_|ghu_|github_pat_|xox[a-z]-|AKIA)/;
const MAX_ARRAY = 64;

/**
 * Before any shape check: no message, subject, address, Slack handle, event id, rule question, label, per-item value,
 * path or secret-looking string may appear anywhere, whatever field carries it. The report's schema has only fixed
 * keys, closed tokens, digests, counts and aggregate numbers.
 */
export function assertAggregateOnly(value, at = '') {
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) fail('QUALITY_REPORT_PER_ITEM', `${at || '/'} is a per-item list`);
    value.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
        fail('QUALITY_REPORT_PER_ITEM', `${at}/${index} is a per-item value`);
      assertAggregateOnly(entry, `${at}/${index}`);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.replaceAll(/[-_]/g, '').toLowerCase()))
        fail('QUALITY_REPORT_RAW', `${at}/${key} names corpus content`);
      assertAggregateOnly(child, `${at}/${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (!SAFE_STRING.test(value)) fail('QUALITY_REPORT_RAW', `${at} holds text that is not a closed token`);
    if (SECRET_PREFIX.test(value)) fail('QUALITY_REPORT_RAW', `${at} holds a secret-looking value`);
    if (/^[a-f0-9]{32}$/.test(value)) fail('QUALITY_REPORT_RAW', `${at} holds an event id`);
    if (value.length >= 20 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value))
      fail('QUALITY_REPORT_RAW', `${at} holds a secret-looking value`);
  }
}

function object(value, keys, at) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('QUALITY_REPORT_SHAPE', `${at} is an object`);
  const found = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (found.length !== expected.length || found.some((key, index) => key !== expected[index]))
    fail('QUALITY_REPORT_SHAPE', `${at} has exactly its reviewed fields`);
  return value;
}

function array(value, at) {
  if (!Array.isArray(value) || value.length === 0) fail('QUALITY_REPORT_SHAPE', `${at} is a non-empty list`);
  return value;
}

function count(value, at) {
  if (!Number.isSafeInteger(value) || value < 0) fail('QUALITY_REPORT_SHAPE', `${at} is a count`);
  return value;
}

function share(value, at) {
  if (value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    fail('QUALITY_REPORT_SHAPE', `${at} is a number within 0 to 1, or null`);
  return value;
}

function measure(value, at) {
  if (value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    fail('QUALITY_REPORT_SHAPE', `${at} is a non-negative number, or null`);
  return value;
}

function token(value, pattern, at) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('QUALITY_REPORT_SHAPE', `${at} is a closed token`);
  return value;
}

const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,31}$/;
const CHANNEL_KEYS = [
  'channel',
  'pairs',
  'answered',
  'refused',
  'positiveShare',
  'languages',
  'expectedCalibrationError',
  'brierScore',
  'auroc',
  'reference',
  'warmLatencyP95Ms',
  'warmRequests',
  'peakWorkerBytes',
  'passed',
];

function uniqueBy(entries, key, at) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry[key])) fail('QUALITY_REPORT_DUPLICATE', `${at} repeats ${entry[key]}`);
    seen.add(entry[key]);
  }
}

function checkChannel(block, at) {
  object(block, CHANNEL_KEYS, at);
  token(block.channel, /^(?:gmail|slack)$/, `${at}/channel`);
  count(block.pairs, `${at}/pairs`);
  count(block.answered, `${at}/answered`);
  object(block.refused, QUALITY_REFUSALS, `${at}/refused`);
  for (const code of QUALITY_REFUSALS) count(block.refused[code], `${at}/refused/${code}`);
  share(block.positiveShare, `${at}/positiveShare`);
  const languages = array(block.languages, `${at}/languages`);
  for (const [index, language] of languages.entries()) {
    object(language, ['language', 'pairs', 'answered', 'refusedForLength'], `${at}/languages/${index}`);
    token(language.language, LANGUAGE, `${at}/languages/${index}/language`);
    count(language.pairs, `${at}/languages/${index}/pairs`);
    count(language.answered, `${at}/languages/${index}/answered`);
    count(language.refusedForLength, `${at}/languages/${index}/refusedForLength`);
  }
  uniqueBy(languages, 'language', `${at}/languages`);
  share(block.expectedCalibrationError, `${at}/expectedCalibrationError`);
  share(block.brierScore, `${at}/brierScore`);
  share(block.auroc, `${at}/auroc`);
  object(block.reference, ['answered', 'refused', 'inputTokenMismatches', 'maxProbabilityDelta'], `${at}/reference`);
  count(block.reference.answered, `${at}/reference/answered`);
  count(block.reference.refused, `${at}/reference/refused`);
  count(block.reference.inputTokenMismatches, `${at}/reference/inputTokenMismatches`);
  share(block.reference.maxProbabilityDelta, `${at}/reference/maxProbabilityDelta`);
  measure(block.warmLatencyP95Ms, `${at}/warmLatencyP95Ms`);
  count(block.warmRequests, `${at}/warmRequests`);
  if (block.peakWorkerBytes !== null) count(block.peakWorkerBytes, `${at}/peakWorkerBytes`);
  if (typeof block.passed !== 'boolean') fail('QUALITY_REPORT_SHAPE', `${at}/passed is a boolean`);
  const refusals = QUALITY_REFUSALS.reduce((sum, code) => sum + block.refused[code], 0);
  const sum = (field) => languages.reduce((total, language) => total + language[field], 0);
  if (
    block.answered + refusals !== block.pairs ||
    sum('pairs') !== block.pairs ||
    sum('answered') !== block.answered ||
    sum('refusedForLength') !== block.refused.tokenLimit ||
    block.reference.answered + block.reference.refused !== block.answered
  )
    fail('QUALITY_REPORT_COUNTS', `${at} has counts that do not add up`);
}

function checkTemplates(templates, candidate, at) {
  array(templates, at);
  for (const [index, template] of templates.entries()) {
    object(template, ['templateId', 'templateSha256', 'channels', 'passed'], `${at}/${index}`);
    token(template.templateId, /^laya-[a-z0-9-]{1,32}$/, `${at}/${index}/templateId`);
    token(template.templateSha256, HEX64, `${at}/${index}/templateSha256`);
    const channels = array(template.channels, `${at}/${index}/channels`);
    for (const [channelIndex, block] of channels.entries())
      checkChannel(block, `${at}/${index}/channels/${channelIndex}`);
    uniqueBy(channels, 'channel', `${at}/${index}/channels`);
    if (typeof template.passed !== 'boolean') fail('QUALITY_REPORT_SHAPE', `${at}/${index}/passed is a boolean`);
  }
  uniqueBy(templates, 'templateId', at);
  const expected = candidate.templates.map((template) => template.templateId);
  const reported = templates.map((template) => template.templateId);
  if (reported.length !== expected.length || reported.some((id, index) => id !== expected[index]))
    fail('QUALITY_REPORT_COVERAGE', `${at} must measure exactly the manifest's templates, in its order`);
  for (const template of templates) {
    const channels = template.channels.map((block) => block.channel);
    if (channels.length !== QUALITY_CHANNELS.length || channels.some((name, index) => name !== QUALITY_CHANNELS[index]))
      fail('QUALITY_REPORT_COVERAGE', `${at} must measure Gmail and Slack separately`);
  }
  for (const [index, template] of templates.entries()) {
    const reviewed = candidate.templates[index];
    if (template.templateSha256 !== reviewed.templateSha256)
      fail('QUALITY_REPORT_CANDIDATE', `${at}/${index} is not the reviewed template's digest`);
  }
  for (const [index, template] of templates.entries()) {
    for (const [channelIndex, block] of template.channels.entries()) {
      if (block.passed !== channelPasses(block))
        fail('QUALITY_REPORT_VERDICT', `${at}/${index}/channels/${channelIndex} has a verdict its numbers do not give`);
    }
    if (template.passed !== template.channels.every((block) => block.passed))
      fail('QUALITY_REPORT_VERDICT', `${at}/${index} has a verdict its channels do not give`);
  }
}

function checkReference(reference, at) {
  object(reference, ['record', 'revision', 'invocation', 'device', 'files'], at);
  token(reference.record, /^[a-z0-9-]{1,64}$/, `${at}/record`);
  token(reference.revision, HEX40, `${at}/revision`);
  token(reference.invocation, /^[a-z0-9-]{1,64}$/, `${at}/invocation`);
  token(reference.device, /^[a-z0-9]{1,16}$/, `${at}/device`);
  const fileKeys = Object.keys(PYTHON_REFERENCE.files);
  object(reference.files, fileKeys, `${at}/files`);
  for (const key of fileKeys) token(reference.files[key], HEX64, `${at}/files/${key}`);
  const pinned =
    reference.record === PYTHON_REFERENCE.record &&
    reference.revision === PYTHON_REFERENCE.revision &&
    reference.invocation === PYTHON_REFERENCE.invocation &&
    reference.device === PYTHON_REFERENCE.device;
  if (!pinned) fail('QUALITY_REPORT_REFERENCE', `${at} is not the pinned Python reference and its invocation`);
  for (const key of fileKeys) {
    if (reference.files[key] !== PYTHON_REFERENCE.files[key].sha256)
      fail('QUALITY_REPORT_REFERENCE', `${at}/files/${key} is not the pinned reference input`);
  }
}

const REPORT_KEYS = [
  'schemaVersion',
  'manifestId',
  'manifestSha256',
  'runtimeLockSha256',
  'runtime',
  'runnerSha256',
  'reference',
  'corpus',
  'calibration',
  'architectures',
];
const ARCHITECTURE_KEYS = [
  'architecture',
  'platformFileListDigest',
  'subjectDigest',
  'node',
  'referenceEnvironment',
  'templates',
];

/**
 * Validates one aggregate report against candidates recomputed from the checkout, one per architecture it reports.
 * `mode` is `release` (a consented external run, the only release evidence) or `fixture` (synthetic test vectors,
 * never release evidence). Returns the report; throws a `QualityGateError` with a closed code otherwise.
 */
export function validateQualityReport(report, { candidates, mode, root = repositoryRoot }) {
  assertAggregateOnly(report);
  verifyPythonReferenceRecord(root);
  object(report, REPORT_KEYS, '');
  if (report.schemaVersion !== QUALITY_GATE_SCHEMA_VERSION) fail('QUALITY_REPORT_SHAPE', 'the schema version is 1');
  token(report.manifestId, /^[a-z0-9][a-z0-9-]{0,63}$/, '/manifestId');
  token(report.manifestSha256, HEX64, '/manifestSha256');
  token(report.runtimeLockSha256, HEX64, '/runtimeLockSha256');
  object(report.runtime, ['laya', 'onnxruntimeNode', 'tokenizers'], '/runtime');
  for (const key of ['laya', 'onnxruntimeNode', 'tokenizers']) token(report.runtime[key], VERSION, `/runtime/${key}`);
  token(report.runnerSha256, HEX64, '/runnerSha256');
  checkReference(report.reference, '/reference');
  object(report.corpus, Object.keys(QUALITY_CORPUS_RELEASE), '/corpus');
  for (const key of Object.keys(QUALITY_CORPUS_RELEASE)) token(report.corpus[key], /^[a-z-]{1,32}$/, `/corpus/${key}`);
  token(report.calibration, /^[a-z-]{1,32}$/, '/calibration');
  if (report.calibration !== QUALITY_CALIBRATION)
    fail('QUALITY_REPORT_CALIBRATION', 'probabilities are measured with the bundle temperatures, never a model card');
  if (mode === 'release') {
    const consented = Object.entries(QUALITY_CORPUS_RELEASE).every(([key, value]) => report.corpus[key] === value);
    if (!consented) fail('QUALITY_REPORT_FIXTURE', 'release evidence comes only from the consented external corpus');
  } else if (mode === 'fixture') {
    if (report.corpus.kind !== QUALITY_CORPUS_FIXTURE_KIND)
      fail('QUALITY_REPORT_FIXTURE', 'a fixture report is marked as synthetic');
  } else {
    fail('QUALITY_REPORT_SHAPE', 'a report is validated as release or fixture evidence');
  }
  const architectures = array(report.architectures, '/architectures');
  for (const [index, entry] of architectures.entries()) {
    const at = `/architectures/${index}`;
    object(entry, ARCHITECTURE_KEYS, at);
    token(entry.architecture, /^(?:arm64|x64)$/, `${at}/architecture`);
    token(entry.platformFileListDigest, HEX64, `${at}/platformFileListDigest`);
    token(entry.subjectDigest, HEX64, `${at}/subjectDigest`);
    token(entry.node, VERSION, `${at}/node`);
    object(entry.referenceEnvironment, ['python', 'torch', 'transformers', 'numpy'], `${at}/referenceEnvironment`);
    for (const key of ['python', 'torch', 'transformers', 'numpy'])
      token(entry.referenceEnvironment[key], VERSION, `${at}/referenceEnvironment/${key}`);
  }
  uniqueBy(architectures, 'architecture', '/architectures');
  for (const [index, entry] of architectures.entries()) {
    const at = `/architectures/${index}`;
    const candidate = candidates[entry.architecture];
    if (candidate === undefined) fail('QUALITY_REPORT_CANDIDATE', `${at} has no candidate to be bound to`);
    const bound =
      report.manifestId === candidate.manifestId &&
      report.manifestSha256 === candidate.manifestSha256 &&
      report.runtimeLockSha256 === candidate.runtimeLockSha256 &&
      report.runtime.laya === candidate.runtime.laya &&
      report.runtime.onnxruntimeNode === candidate.runtime.onnxruntimeNode &&
      report.runtime.tokenizers === candidate.runtime.tokenizers &&
      report.runnerSha256 === candidate.runnerSha256 &&
      entry.platformFileListDigest === candidate.platformFileListDigest;
    if (!bound) fail('QUALITY_REPORT_CANDIDATE', `${at} is not this candidate's manifest, lock, runtime or runner`);
    if (entry.subjectDigest !== candidate.subjectDigest)
      fail('QUALITY_REPORT_CANDIDATE', `${at} is not this candidate's subject digest`);
    checkTemplates(entry.templates, candidate, `${at}/templates`);
  }
  return report;
}

/** The canonical bytes the runner writes and a release reads: two-space JSON and a final newline. */
export function canonicalReportBytes(report) {
  return Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function parseReportBytes(bytes) {
  let report;
  try {
    report = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail('QUALITY_REPORT_JSON', 'the gate report is strict JSON');
  }
  if (!canonicalReportBytes(report).equals(Buffer.from(bytes)))
    fail('QUALITY_REPORT_JSON', 'the gate report is canonical JSON with no duplicate key');
  return report;
}

/**
 * A release offers Laya on an architecture only with that architecture's exact passing evidence: every manifest
 * template passed on Gmail and on Slack. arm64 evidence never authorises x64 (E2-J).
 */
export function verifyQualityGate({ root = repositoryRoot, architectures = ['arm64'] } = {}) {
  if (architectures.length === 0) fail('QUALITY_GATE_ABSENT', 'a release names the architectures it offers');
  const manifestId = computeCandidate({ root, architecture: architectures[0] }).manifestId;
  const path = join(root, GATE_REPORT_DIRECTORY, `${manifestId}.json`);
  if (!existsSync(path)) fail('QUALITY_GATE_ABSENT', 'no aggregate gate evidence exists for this manifest');
  const report = parseReportBytes(readFileSync(path));
  const reported = Array.isArray(report.architectures)
    ? report.architectures.map((entry) => entry?.architecture).filter((name) => QUALITY_ARCHITECTURES.includes(name))
    : [];
  const candidates = Object.fromEntries(
    [...new Set([...architectures, ...reported])].map((architecture) => [
      architecture,
      computeCandidate({ root, architecture }),
    ]),
  );
  validateQualityReport(report, { candidates, mode: 'release', root });
  for (const architecture of architectures) {
    const entry = report.architectures.find((candidate) => candidate.architecture === architecture);
    if (entry === undefined) fail('QUALITY_GATE_ABSENT', `no gate evidence exists for ${architecture}`);
    for (const template of entry.templates) {
      if (!template.passed) fail('QUALITY_GATE_FAILED', `${template.templateId} did not pass on ${architecture}`);
    }
  }
  return report;
}

// ------------------------------------------------------------------------------------------------ the fixtures

export const QUALITY_FIXTURE_DIRECTORY = 'packages/events-daemon/test/fixtures/laya/quality';
const FIXTURE_ASSETS = Object.freeze({
  [ASSETS.manifest]: 'packages/events-daemon/test/fixtures/laya/manifest-tiny-v1.json',
  [ASSETS.runtimeLock]: 'packages/events-daemon/test/fixtures/laya/lock-expected.json',
  [ASSETS.disclosures]: 'packages/events-daemon/test/fixtures/laya/disclosures-tiny-v1.json',
  [EVIDENCE_RECORD]: EVIDENCE_RECORD,
});

/** Writes the fixture's synthetic candidate — tiny assets, synthetic sources, the real record — into a fresh root. */
export async function materializeFixtureCandidate(fixture, { source = repositoryRoot, files = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'laya-quality-fixture-'));
  const write = async (path, bytes) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  };
  for (const [path, from] of Object.entries(FIXTURE_ASSETS)) await write(path, readFileSync(join(source, from)));
  for (const [path, content] of Object.entries({ ...fixture.candidateFiles, ...files })) await write(path, content);
  return root;
}

function decodePointer(pointer) {
  if (!pointer.startsWith('/')) fail('QUALITY_FIXTURE', 'a fixture edit names a JSON pointer');
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function parentOf(document, pointer) {
  const parts = decodePointer(pointer);
  const last = parts.pop();
  let parent = document;
  for (const part of parts) parent = parent[Array.isArray(parent) ? Number(part) : part];
  if (parent === undefined || parent === null) fail('QUALITY_FIXTURE', 'a fixture edit names a missing location');
  return { parent, key: Array.isArray(parent) ? Number(last) : last };
}

function lookup(document, pointer) {
  const { parent, key } = parentOf(document, pointer);
  return parent[key];
}

/** Applies one bad case's edits to a copy of the good fixture report. */
export function applyFixtureEdits(report, edits = []) {
  const document = structuredClone(report);
  for (const edit of edits) {
    if (edit.op === 'set') {
      const { parent, key } = parentOf(document, edit.pointer);
      parent[key] = structuredClone(edit.value);
    } else if (edit.op === 'remove') {
      const { parent, key } = parentOf(document, edit.pointer);
      if (Array.isArray(parent)) parent.splice(key, 1);
      else delete parent[key];
    } else if (edit.op === 'duplicate') {
      const list = lookup(document, edit.into);
      list.push(structuredClone(lookup(document, edit.pointer)));
    } else {
      fail('QUALITY_FIXTURE', 'a fixture edit is set, remove or duplicate');
    }
  }
  return document;
}

function close(left, right) {
  return left === right || (left !== null && right !== null && Math.abs(left - right) <= 1e-12);
}

/** Recomputes every synthetic metric vector of `metrics-v1.json` against its stated expectation. */
export function checkMetricVectors(fixture) {
  for (const vector of fixture.vectors) {
    const computed = {
      expectedCalibrationError: expectedCalibrationError(vector.probabilities, vector.labels),
      brierScore: brierScore(vector.probabilities, vector.labels),
      auroc: areaUnderRoc(vector.probabilities, vector.labels),
      positiveShare: positiveShare(vector.labels),
    };
    for (const [metric, expected] of Object.entries(vector.expected)) {
      if (!close(computed[metric], expected)) fail('QUALITY_FIXTURE', `${vector.name}: ${metric} is not as stated`);
    }
  }
  for (const vector of fixture.latency) {
    if (!close(nearestRankPercentile(vector.valuesMs, 0.95), vector.expectedP95Ms))
      fail('QUALITY_FIXTURE', `${vector.name}: p95 is not as stated`);
  }
  for (const vector of fixture.memory) {
    if (peakOf(vector.samples) !== vector.expectedPeak)
      fail('QUALITY_FIXTURE', `${vector.name}: peak is not as stated`);
  }
  for (const vector of fixture.referenceDelta) {
    if (!close(maximumReferenceDelta(vector.worker, vector.reference), vector.expected))
      fail('QUALITY_FIXTURE', `${vector.name}: the reference delta is not as stated`);
  }
  return fixture.vectors.length + fixture.latency.length + fixture.memory.length + fixture.referenceDelta.length;
}

function fixtureCandidates(root) {
  return Object.fromEntries(
    QUALITY_ARCHITECTURES.map((architecture) => [architecture, computeCandidate({ root, architecture })]),
  );
}

function refusalCode(run) {
  try {
    run();
  } catch (error) {
    if (error instanceof QualityGateError) return error.code;
    throw error;
  }
  return null;
}

/**
 * `--fixture`: the synthetic metric vectors recompute exactly; the good synthetic report validates only as fixture
 * evidence and is refused as release evidence; every bad case is refused with its stated code. No quality claim.
 */
export async function verifyQualityFixtures({ source = repositoryRoot } = {}) {
  const fixtureDirectory = join(source, QUALITY_FIXTURE_DIRECTORY);
  const metrics = JSON.parse(readFileSync(join(fixtureDirectory, 'metrics-v1.json'), 'utf8'));
  const bad = JSON.parse(readFileSync(join(fixtureDirectory, 'bad-report-v1.json'), 'utf8'));
  const vectors = checkMetricVectors(metrics);
  const root = await materializeFixtureCandidate(metrics, { source });
  let refusals = 0;
  try {
    const candidates = fixtureCandidates(root);
    validateQualityReport(metrics.report, { candidates, mode: 'fixture', root });
    if (
      refusalCode(() => validateQualityReport(metrics.report, { candidates, mode: 'release', root })) !==
      'QUALITY_REPORT_FIXTURE'
    )
      fail('QUALITY_FIXTURE', 'the synthetic report must never be release evidence');
    for (const entry of bad.cases) {
      const caseRoot =
        entry.files === undefined && entry.record === undefined
          ? root
          : await materializeFixtureCandidate(metrics, { source, files: entry.files ?? {} });
      try {
        if (entry.record !== undefined) {
          const recordPath = join(caseRoot, EVIDENCE_RECORD);
          if (entry.record === null) await rm(recordPath);
          else {
            const record = readFileSync(recordPath, 'utf8');
            if (!record.includes(entry.record.from)) fail('QUALITY_FIXTURE', `${entry.name}: the record edit is stale`);
            await writeFile(recordPath, record.replaceAll(entry.record.from, entry.record.to));
          }
        }
        const code = refusalCode(() =>
          validateQualityReport(applyFixtureEdits(metrics.report, entry.edits), {
            candidates: fixtureCandidates(caseRoot),
            mode: entry.mode ?? 'fixture',
            root: caseRoot,
          }),
        );
        if (code !== entry.code)
          fail('QUALITY_FIXTURE', `${entry.name}: refused as ${code ?? 'nothing'}, not ${entry.code}`);
        refusals += 1;
      } finally {
        if (caseRoot !== root) await rm(caseRoot, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return { vectors, refusals };
}

// ------------------------------------------------------------------------------------------------ the command

function parseArguments(argv) {
  const options = { fixture: false, root: repositoryRoot, architectures: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fixture') options.fixture = true;
    else if (argument === '--root')
      options.root = resolve(argv[++index] ?? fail('QUALITY_USAGE', '--root names a directory'));
    else if (argument === '--architecture') options.architectures.push(argv[++index] ?? '');
    else fail('QUALITY_USAGE', `unknown argument ${JSON.stringify(argument)}`);
  }
  if (options.architectures.length === 0) options.architectures.push('arm64');
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.fixture) {
      const { vectors, refusals } = await verifyQualityFixtures({ source: options.root });
      process.stdout.write(
        `Laya quality gate fixtures: OK (${vectors} synthetic metric vectors, ${refusals} refused reports; no quality claim)\n`,
      );
    } else {
      const report = verifyQualityGate({ root: options.root, architectures: options.architectures });
      process.stdout.write(
        `Laya quality gate: ${report.manifestId} passes on ${options.architectures.join(', ')} for every manifest template\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
