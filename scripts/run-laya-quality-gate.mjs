#!/usr/bin/env node
/**
 * D11's labelled quality gate, its owner-only run (E2-8, E2-I, Task 9). It never runs in CI, `pnpm verify` or a
 * test against real data: the owner runs it on a protected macOS runner, over a corpus of their own and colleagues'
 * Gmail and Slack messages that people consented to in writing, labelled by a person and kept encrypted outside the
 * repository.
 *
 *   keygen  --key-file <path>                       a fresh 256-bit corpus key, owner-only, outside the repository
 *   seal    --key-file <path> --corpus <directory>  encrypts one plaintext corpus read from stdin into the directory
 *   run     --attest-written-consent --corpus <directory> --key-file <path> --reference <snapshot directory>
 *           --python <interpreter> --runtime-tree <directory> --model-tree <directory>
 *
 * `run` refuses a corpus or key inside the repository and a corpus directory holding anything but sealed corpus files;
 * decrypts only in memory; builds each judge input with E's own envelope (`buildJudgeInput`); asks the candidate's
 * worker through the production supervisor and boundary (`LayaWorkerSupervisor`, `createLayaWorkerBoundary`), and the
 * source-record-pinned Python reference only after its snapshot matches the pin byte for byte, both under the same
 * network-denying `sandbox-exec` profile; and keeps every item, value and label in memory. It prints and writes only
 * the schema-validated aggregate, `packages/events-laya-runtime/gate/<manifestId>.json`. No provider is called.
 */
import { execFile, spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildJudgeInput } from '../packages/events-daemon/src/runtime/judge-coordinator.ts';
import { sandboxExecAvailable } from '../packages/events-daemon/src/runtime/laya/contracts.ts';
import { layaTemplate } from '../packages/events-daemon/src/runtime/laya/templates.ts';
import { verifyRuntimeTree } from '../packages/events-daemon/src/runtime/laya/tree-verifier.ts';
import {
  createLayaWorkerBoundary,
  LAYA_SANDBOX_EXECUTABLE,
  LAYA_SANDBOX_PROFILE,
} from '../packages/events-daemon/src/runtime/laya/worker-boundary-probe.ts';
import { LayaWorkerSupervisor } from '../packages/events-daemon/src/runtime/laya/worker-supervisor.ts';
import {
  aggregateTemplate,
  canonicalReportBytes,
  computeCandidate,
  GATE_REPORT_DIRECTORY,
  PYTHON_REFERENCE,
  parseReportBytes,
  QUALITY_ARCHITECTURES,
  QUALITY_CALIBRATION,
  QUALITY_CHANNELS,
  QUALITY_CORPUS_RELEASE,
  QUALITY_GATE_SCHEMA_VERSION,
  validateQualityReport,
  verifyPythonReferenceRecord,
} from './verify-laya-quality-gate.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export const CORPUS_FORMAT = 'agentcomms-laya-quality-corpus-v1';
export const CORPUS_MAGIC = Buffer.from(`${CORPUS_FORMAT}\n`, 'utf8');
export const CORPUS_FILE_SUFFIX = '.lqc';
const CORPUS_IV_BYTES = 12;
const CORPUS_TAG_BYTES = 16;
const CORPUS_KEY_BYTES = 32;
const CORPUS_MAX_FILE_BYTES = 256 * 1024 * 1024;
const CORPUS_MAX_ITEMS = 200_000;
const QUESTION_MAX_LENGTH = 4096;
const INPUTS_MAX = 16;
const LANGUAGE = /^(?:[a-z]{2,3}|und)$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,31}$/;
const REFERENCE_READY_TIMEOUT_MS = 15 * 60_000;
const REFERENCE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const REFERENCE_LINE_MAX_BYTES = 1024 * 1024;
const MEMORY_SAMPLE_INTERVAL_MS = 200;

export class QualityGateRunError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'QualityGateRunError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new QualityGateRunError(code, message);
}

// ------------------------------------------------------------------------------------------------ where data may live

/** A path with every link resolved; a path that does not exist yet resolves through its parent's real location. */
function realDirectory(path) {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

function within(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/**
 * Corpus data and its key live outside every repository checkout the run can see: this script's own and the candidate
 * root. A path that resolves (links followed) inside either, or that contains either, is refused before it is read.
 */
export function assertOutsideRepository(path, { root = repositoryRoot, what }) {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path))
    fail('QUALITY_PATH', `${what} is an explicitly supplied absolute path`);
  const target = realDirectory(path);
  for (const checkout of new Set([realDirectory(repositoryRoot), realDirectory(root)])) {
    if (within(checkout, target) || within(target, checkout))
      fail('QUALITY_INSIDE_REPOSITORY', `${what} must be outside the repository`);
  }
  return target;
}

// ------------------------------------------------------------------------------------------------ the sealed corpus

function corpusKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== CORPUS_KEY_BYTES) fail('QUALITY_KEY', 'the corpus key is 32 bytes');
  return key;
}

/** One sealed corpus file: the format line, a 12-byte nonce, the AES-256-GCM ciphertext and its 16-byte tag. */
export function sealCorpus(key, plaintext) {
  const iv = randomBytes(CORPUS_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', corpusKey(key), iv);
  cipher.setAAD(CORPUS_MAGIC);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([CORPUS_MAGIC, iv, ciphertext, cipher.getAuthTag()]);
}

export function openCorpus(key, sealed) {
  const bytes = Buffer.from(sealed);
  if (
    bytes.length < CORPUS_MAGIC.length + CORPUS_IV_BYTES + CORPUS_TAG_BYTES ||
    !bytes.subarray(0, CORPUS_MAGIC.length).equals(CORPUS_MAGIC)
  )
    fail('QUALITY_CORPUS_UNENCRYPTED', 'a corpus file is not a sealed corpus');
  const iv = bytes.subarray(CORPUS_MAGIC.length, CORPUS_MAGIC.length + CORPUS_IV_BYTES);
  const tag = bytes.subarray(bytes.length - CORPUS_TAG_BYTES);
  const ciphertext = bytes.subarray(CORPUS_MAGIC.length + CORPUS_IV_BYTES, bytes.length - CORPUS_TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', corpusKey(key), iv);
    decipher.setAAD(CORPUS_MAGIC);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return fail('QUALITY_CORPUS_KEY', 'a corpus file does not open with this key');
  }
}

/** The key file: outside the repository, a regular file only its owner can read, holding base64 of 32 bytes. */
export async function readCorpusKey(path, { root = repositoryRoot } = {}) {
  const target = assertOutsideRepository(path, { root, what: 'the corpus key' });
  const info = await lstat(target).catch(() => fail('QUALITY_KEY', 'the corpus key file is missing'));
  if (!info.isFile()) fail('QUALITY_KEY', 'the corpus key is a regular file');
  if ((info.mode & 0o077) !== 0) fail('QUALITY_KEY', 'the corpus key file is readable only by its owner');
  const text = (await readFile(target, 'utf8')).trim();
  const key = Buffer.from(text, 'base64');
  if (key.length !== CORPUS_KEY_BYTES || key.toString('base64') !== text)
    fail('QUALITY_KEY', 'the corpus key file holds base64 of 32 bytes');
  return key;
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const found = Object.keys(value).sort();
  const expected = [...keys].sort();
  return found.length === expected.length && found.every((key, index) => key === expected[index]);
}

function corpusItem(item) {
  const valid =
    exactKeys(item, ['channel', 'language', 'label', 'question', 'inputs', 'event']) &&
    QUALITY_CHANNELS.includes(item.channel) &&
    LANGUAGE.test(item.language) &&
    (item.label === 0 || item.label === 1) &&
    typeof item.question === 'string' &&
    item.question.length > 0 &&
    item.question.length <= QUESTION_MAX_LENGTH &&
    Array.isArray(item.inputs) &&
    item.inputs.length > 0 &&
    item.inputs.length <= INPUTS_MAX &&
    item.inputs.every((pointer) => typeof pointer === 'string' && pointer.startsWith('/') && pointer.length <= 256) &&
    item.event !== null &&
    typeof item.event === 'object' &&
    !Array.isArray(item.event) &&
    item.event.version === 1 &&
    typeof item.event.type === 'string' &&
    item.event.type.startsWith(`${item.channel}.`) &&
    item.event.account?.channel === item.channel;
  // No index, field or value reaches the message: a refusal never echoes corpus content.
  if (!valid) fail('QUALITY_CORPUS_ITEM', 'a corpus item is not a labelled pair in the corpus format');
  return item;
}

/**
 * The plaintext corpus: `{ format, items }`, each item one labelled pair — its channel (which its version-1 event's
 * own account channel must equal), language, the person's 0/1 label, the rule question, the judge input pointers and
 * the event as a dry-run delivery shows it.
 */
export function parseCorpusItems(plaintext) {
  let corpus;
  try {
    corpus = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  } catch {
    fail('QUALITY_CORPUS_ITEM', 'a corpus is strict JSON');
  }
  if (
    !exactKeys(corpus, ['format', 'items']) ||
    corpus.format !== CORPUS_FORMAT ||
    !Array.isArray(corpus.items) ||
    corpus.items.length === 0 ||
    corpus.items.length > CORPUS_MAX_ITEMS
  )
    fail('QUALITY_CORPUS_ITEM', 'a corpus is { format, items } in the corpus format');
  return corpus.items.map(corpusItem);
}

/**
 * Reads every sealed file of the corpus directory into memory. The directory is explicitly supplied, outside the
 * repository, and holds only sealed corpus files: a plaintext file, a link or a subdirectory refuses the whole run.
 */
export async function readCorpusDirectory(directory, { key, root = repositoryRoot }) {
  if (directory === undefined) fail('QUALITY_CORPUS_REQUIRED', 'the run needs an explicitly supplied corpus directory');
  const target = assertOutsideRepository(directory, { root, what: 'the corpus directory' });
  const info = await lstat(target).catch(() => fail('QUALITY_CORPUS_REQUIRED', 'the corpus directory is missing'));
  if (!info.isDirectory()) fail('QUALITY_CORPUS_REQUIRED', 'the corpus is a directory');
  const entries = (await readdir(target, { withFileTypes: true })).sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  );
  if (entries.length === 0) fail('QUALITY_CORPUS_REQUIRED', 'the corpus directory is empty');
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(CORPUS_FILE_SUFFIX))
      fail('QUALITY_CORPUS_UNENCRYPTED', 'the corpus directory holds only sealed corpus files');
    const file = await lstat(join(target, entry.name));
    if (!file.isFile() || file.size > CORPUS_MAX_FILE_BYTES)
      fail('QUALITY_CORPUS_UNENCRYPTED', 'a corpus file is a bounded regular file');
    items.push(...parseCorpusItems(openCorpus(key, await readFile(join(target, entry.name)))));
  }
  if (items.length > CORPUS_MAX_ITEMS) fail('QUALITY_CORPUS_ITEM', 'the corpus is bounded');
  return items;
}

/** One item's judge input, built exactly as E's coordinator builds it for a Laya judge: the same minimised envelope. */
export function prepareCorpusItem(item) {
  let input;
  try {
    input = buildJudgeInput(
      {
        event: { type: item.event.type, version: item.event.version },
        agentic: { question: item.question, inputs: item.inputs },
      },
      item.event,
    );
  } catch {
    input = null;
  }
  if (input === null) fail('QUALITY_CORPUS_ITEM', 'a corpus item does not build a judge input');
  return {
    channel: item.channel,
    language: item.language,
    label: item.label,
    instructions: item.question,
    state: input.state,
  };
}

// ------------------------------------------------------------------------------------------------ the worker

const WORKER_REFUSALS = Object.freeze({
  'laya-crashed': 'crashed',
  'laya-malformed': 'malformed',
  'laya-request-too-large': 'tokenLimit',
  'laya-template-blocked': 'templateBlocked',
  'laya-timeout': 'timeout',
  'laya-token-limit': 'tokenLimit',
});
/** A worker that cannot run at all is not a measurement: the run stops rather than count it. */
const WORKER_ABORTS = new Set([
  'E2_EXTERNAL_REFERENCE_BLOCKED',
  'LAYA_PLATFORM_UNAVAILABLE',
  'LAYA_SANDBOX_UNAVAILABLE',
  'boundary-failed',
  'download-failed',
  'integrity',
  'laya-adapter-blocked',
  'laya-authority-changed',
  'laya-not-ready',
  'laya-purged',
  'laya-stopped',
  'runtime-failed',
]);

/** The supervisor's closed result as the gate counts it. */
export function workerOutcome(result) {
  if (result.kind === 'answer') return { kind: 'answer', value: result.value, inputTokens: result.inputTokens };
  if (WORKER_ABORTS.has(result.code)) return { kind: 'abort', code: result.code };
  return { kind: 'refused', code: WORKER_REFUSALS[result.code] ?? 'other' };
}

function runtimeTreeFiles(candidate) {
  return candidate.enablement.runtimeLock.platform.files.map((file) => ({
    path: `node_modules/${file.package}/${file.path}`,
    size: file.size,
    sha256: file.sha256,
    executable: file.executable,
  }));
}

function modelTreeFiles(candidate) {
  return candidate.enablement.manifest.files.map((file) => ({
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    executable: false,
  }));
}

/** Both verified trees, before any corpus item is opened and again before every worker start. */
export async function verifyCandidateTrees({ candidate, runtimeTree, modelTree }) {
  const runtime = await verifyRuntimeTree({ root: runtimeTree, files: runtimeTreeFiles(candidate) });
  const model = await verifyRuntimeTree({ root: modelTree, files: modelTreeFiles(candidate) });
  return runtime.ok && model.ok;
}

function sampleResident(pid, samples) {
  execFile('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1_000 }, (error, stdout) => {
    const kibibytes = Number.parseInt(String(stdout).trim(), 10);
    if (error === null && Number.isSafeInteger(kibibytes) && kibibytes > 0) samples.push(kibibytes * 1024);
  });
}

/**
 * The candidate's own worker, through the production supervisor and boundary: the shipped entry, the literal
 * profile, the same-child probe and both whole-tree checks before every start. The gate observes the proven child's
 * PID only to sample its resident memory; it passes no spawn, listener or entry of its own.
 */
export async function createWorkerEvaluator({ candidate, runtimeTree, modelTree }) {
  const available = sandboxExecAvailable({ platform: process.platform, architecture: process.arch });
  const selection = {
    epoch: 1,
    version: 1,
    digest: candidate.subjectDigest,
    manifestId: candidate.manifestId,
    promptTemplates: candidate.templates.map((template) => template.templateId),
  };
  let failed = false;
  let starts = 0;
  let pid = null;
  let samples = [];
  const artifacts = {
    availability: () => (available ? { available: true } : { available: false, code: 'LAYA_SANDBOX_UNAVAILABLE' }),
    workerSelection: () => (failed ? null : selection),
    async verifyForWorkerStart() {
      return (await verifyCandidateTrees({ candidate, runtimeTree, modelTree }))
        ? { ok: true, runtimeRoot: runtimeTree, modelRoot: modelTree }
        : { ok: false, failureCode: 'integrity' };
    },
    recordWorkerFailure() {
      failed = true;
    },
    trackWork: () => ({ signal: new AbortController().signal, release() {} }),
    attachWorker: () => () => undefined,
  };
  const supervisor = new LayaWorkerSupervisor({
    artifacts,
    startWorker: async (options) => {
      starts += 1;
      const boundary = await createLayaWorkerBoundary(options);
      if (boundary.ok) {
        const child = boundary.child;
        pid = child.pid ?? null;
        child.once('exit', () => {
          if (pid === child.pid) pid = null;
        });
      }
      return boundary;
    },
  });
  const sampler = setInterval(() => {
    if (pid !== null) sampleResident(pid, samples);
  }, MEMORY_SAMPLE_INTERVAL_MS);
  sampler.unref();
  return {
    async evaluate({ templateId, instructions, state }) {
      const prepared = supervisor.prepare({
        judge: { model: candidate.manifestId, promptTemplate: templateId },
        state,
        instructions,
      });
      if (!prepared.ok) return { outcome: workerOutcome({ kind: 'refused', code: prepared.code }), cold: false, ms: 0 };
      const before = starts;
      const started = performance.now();
      const result = await supervisor.execute(prepared.request, {
        reservationId: randomUUID(),
        finalGate: () => undefined,
      });
      return { outcome: workerOutcome(result), cold: starts !== before, ms: performance.now() - started };
    },
    /** The resident sizes sampled since the last call, in bytes. */
    memorySamples() {
      const taken = samples;
      samples = [];
      return taken;
    },
    async close() {
      clearInterval(sampler);
      await supervisor.close();
    },
  };
}

// ------------------------------------------------------------------------------------------------ the Python reference

/**
 * The reference driver: `RLAgent(<snapshot>, device="cpu")`, then for each request exactly `system_one(state,
 * {"decision": question})`, the path the record names (`hf-laya-python-reference`). It answers with the decision's
 * numbers and the usage only, one JSON line per request; it never echoes a request and writes no file (`-B`).
 */
export const REFERENCE_DRIVER = `import json
import sys

snapshot = sys.argv[1]
# The snapshot was verified to hold exactly the pinned files, so it is searched first: the reference's own
# rl_agent_api and rl_common are the ones that run, never an installed module of the same name.
sys.path.insert(0, snapshot)

import numpy
import torch
import transformers
from rl_agent_api import RLAgent

agent = RLAgent(snapshot, device="cpu")


def emit(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":"), allow_nan=False) + "\\n")
    sys.stdout.flush()


emit({"type": "ready", "python": sys.version.split()[0], "torch": str(torch.__version__),
      "transformers": str(transformers.__version__), "numpy": str(numpy.__version__)})
for line in sys.stdin:
    try:
        request = json.loads(line)
        result = agent.system_one(request["state"], {"decision": request["question"]})
        answer = result["answers"]["decision"]
        emit({"type": "answer",
              "answer": {key: answer[key] for key in ("type", "noul", "probabilities") if key in answer},
              "inputTokens": result["usage"]["input_tokens"]})
    except Exception:
        emit({"type": "refused"})
`;

/** The reference question for one template, in the record's request shape and with the worker's own option text. */
export function referenceQuestion(templateId, instructions) {
  const template = layaTemplate(templateId);
  if (template.type === 'noul') return { type: 'noul', instructions };
  return {
    type: 'choice',
    instructions,
    criteria: Object.fromEntries(template.options.map((option) => [option.label, option.text])),
  };
}

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * The reference's value where the record puts it: `answers.decision.noul` for a `noul` template, and
 * `answers.decision.probabilities.<affirmative key>` for a `choice` template (hf-laya-python-reference-choice),
 * checked as D5 checks any value — finite, within 0 to 1, never clamped — with its `usage.input_tokens`.
 */
export function referenceOutcome(templateId, message) {
  const template = layaTemplate(templateId);
  const answer = message?.type === 'answer' ? message.answer : undefined;
  if (answer === null || typeof answer !== 'object' || answer.type !== template.type) return { kind: 'refused' };
  let value;
  if (template.type === 'noul') value = answer.noul;
  else {
    const keys = template.options.map((option) => option.label);
    if (!exactKeys(answer.probabilities, keys)) return { kind: 'refused' };
    value = answer.probabilities[template.affirmative];
  }
  if (!probability(value) || !Number.isSafeInteger(message.inputTokens) || message.inputTokens < 1)
    return { kind: 'refused' };
  return { kind: 'answer', value, inputTokens: message.inputTokens };
}

/** The snapshot directory holds exactly the pinned reference files, byte for byte: nothing guessed, nothing extra. */
export async function verifyReferenceSnapshot(snapshot, { files = PYTHON_REFERENCE.files } = {}) {
  if (typeof snapshot !== 'string' || !isAbsolute(snapshot))
    fail('QUALITY_REFERENCE_UNPINNED', 'the reference snapshot is an explicitly supplied absolute path');
  const expected = Object.values(files).map((file) => ({ ...file, executable: false }));
  const verified = await verifyRuntimeTree({ root: snapshot, files: expected });
  if (!verified.ok) fail('QUALITY_REFERENCE_UNPINNED', 'the reference snapshot is not the pinned revision');
  return snapshot;
}

function lineReader(stream) {
  let buffered = Buffer.alloc(0);
  const lines = [];
  const waiting = [];
  let ended = false;
  const settle = () => {
    while (waiting.length > 0 && (lines.length > 0 || ended)) {
      const next = waiting.shift();
      if (lines.length > 0) next.resolve(lines.shift());
      else next.resolve(null);
    }
  };
  stream.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    let newline = buffered.indexOf(0x0a);
    while (newline !== -1) {
      lines.push(buffered.subarray(0, newline).toString('utf8'));
      buffered = buffered.subarray(newline + 1);
      newline = buffered.indexOf(0x0a);
    }
    if (buffered.length > REFERENCE_LINE_MAX_BYTES) {
      ended = true;
      stream.destroy();
    }
    settle();
  });
  stream.once('close', () => {
    ended = true;
    settle();
  });
  return (timeoutMs) =>
    new Promise((resolveLine) => {
      const entry = { resolve: () => undefined };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index !== -1) waiting.splice(index, 1);
        resolveLine(null);
      }, timeoutMs);
      entry.resolve = (line) => {
        clearTimeout(timer);
        resolveLine(line);
      };
      waiting.push(entry);
      settle();
    });
}

function message(line) {
  if (line === null) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * The pinned Python reference, inside the same network-denying profile as the worker, isolated (`-I`), writing no
 * bytecode (`-B`), with a closed environment and a fresh home that is removed afterwards. Its stderr is drained and
 * discarded: it is never printed or kept.
 */
export async function createPythonReference({ python, snapshot }) {
  if (typeof python !== 'string' || !isAbsolute(python))
    fail('QUALITY_REFERENCE_FAILED', 'the reference interpreter is an explicitly supplied absolute path');
  const home = await mkdtemp(join(tmpdir(), 'laya-quality-reference-'));
  const child = spawn(
    LAYA_SANDBOX_EXECUTABLE,
    ['-p', LAYA_SANDBOX_PROFILE, python, '-I', '-B', '-c', REFERENCE_DRIVER, snapshot],
    {
      cwd: home,
      env: { PATH: '/usr/bin:/bin', TZ: 'UTC', HOME: home, USE_TF: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    },
  );
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  child.stderr.resume();
  const next = lineReader(child.stdout);
  const stop = async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  };
  const ready = message(await next(REFERENCE_READY_TIMEOUT_MS));
  const environment = {
    python: ready?.python,
    torch: ready?.torch,
    transformers: ready?.transformers,
    numpy: ready?.numpy,
  };
  if (
    ready?.type !== 'ready' ||
    !Object.values(environment).every((value) => typeof value === 'string' && VERSION.test(value))
  ) {
    await stop();
    fail('QUALITY_REFERENCE_FAILED', 'the Python reference did not start');
  }
  return {
    environment,
    async evaluate({ templateId, instructions, state }) {
      child.stdin.write(`${JSON.stringify({ state, question: referenceQuestion(templateId, instructions) })}\n`);
      const reply = message(await next(REFERENCE_REQUEST_TIMEOUT_MS));
      if (reply === null) fail('QUALITY_REFERENCE_FAILED', 'the Python reference stopped answering');
      return referenceOutcome(templateId, reply);
    },
    close: stop,
  };
}

// ------------------------------------------------------------------------------------------------ the measurement

/**
 * Every manifest template, Gmail then Slack: each item to the worker and, only when it answered, the same input to
 * the reference. Observations stay in this function's memory; only the aggregates leave it.
 */
export async function measureCandidate({ candidate, items, worker, reference }) {
  const templates = [];
  for (const { templateId, templateSha256 } of candidate.templates) {
    const observations = [];
    const measurements = {};
    for (const channel of QUALITY_CHANNELS) {
      worker.memorySamples();
      const warmLatenciesMs = [];
      for (const item of items) {
        if (item.channel !== channel) continue;
        const request = { templateId, instructions: item.instructions, state: item.state };
        const { outcome, cold, ms } = await worker.evaluate(request);
        if (outcome.kind === 'abort') fail('QUALITY_WORKER_UNAVAILABLE', `the worker cannot run (${outcome.code})`);
        let referenceResult = null;
        if (outcome.kind === 'answer') {
          referenceResult = await reference.evaluate(request);
          if (!cold) warmLatenciesMs.push(ms);
        }
        observations.push({
          channel,
          language: item.language,
          label: item.label,
          worker: outcome,
          reference: referenceResult,
        });
      }
      measurements[channel] = { warmLatenciesMs, memorySamples: worker.memorySamples() };
    }
    templates.push(aggregateTemplate(templateId, templateSha256, observations, measurements));
  }
  return templates;
}

export function buildReport({ candidate, environment, templates, node = process.versions.node }) {
  return {
    schemaVersion: QUALITY_GATE_SCHEMA_VERSION,
    manifestId: candidate.manifestId,
    manifestSha256: candidate.manifestSha256,
    runtimeLockSha256: candidate.runtimeLockSha256,
    runtime: { ...candidate.runtime },
    runnerSha256: candidate.runnerSha256,
    reference: {
      record: PYTHON_REFERENCE.record,
      revision: PYTHON_REFERENCE.revision,
      invocation: PYTHON_REFERENCE.invocation,
      device: PYTHON_REFERENCE.device,
      files: Object.fromEntries(Object.entries(PYTHON_REFERENCE.files).map(([key, file]) => [key, file.sha256])),
    },
    corpus: { ...QUALITY_CORPUS_RELEASE },
    calibration: QUALITY_CALIBRATION,
    architectures: [
      {
        architecture: candidate.architecture,
        platformFileListDigest: candidate.platformFileListDigest,
        subjectDigest: candidate.subjectDigest,
        node,
        referenceEnvironment: { ...environment },
        templates,
      },
    ],
  };
}

/**
 * Writes the one artifact, only after it validates as release evidence for this candidate. Another architecture's
 * existing entry is kept only when it, too, still validates for this checkout and shares every top-level field.
 */
export async function writeGateReport({ root = repositoryRoot, report }) {
  const path = join(root, GATE_REPORT_DIRECTORY, `${report.manifestId}.json`);
  const architecture = report.architectures[0].architecture;
  let merged = report;
  if (existsSync(path)) {
    const existing = parseReportBytes(await readFile(path));
    const others = existing.architectures.filter((entry) => entry.architecture !== architecture);
    if (others.length > 0) {
      const shared = (value) => JSON.stringify({ ...value, architectures: [] });
      if (shared(existing) !== shared(report))
        fail('QUALITY_REPORT_STALE', 'the existing gate report was made for another candidate; remove it first');
      merged = {
        ...report,
        architectures: [...others, ...report.architectures].sort((left, right) =>
          left.architecture.localeCompare(right.architecture),
        ),
      };
    }
  }
  const candidates = Object.fromEntries(
    merged.architectures.map((entry) => [
      entry.architecture,
      computeCandidate({ root, architecture: entry.architecture }),
    ]),
  );
  validateQualityReport(merged, { candidates, mode: 'release', root });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.partial`;
  await writeFile(temporary, canonicalReportBytes(merged), { flag: 'wx', mode: 0o644 });
  await rename(temporary, path);
  return relative(root, path).split(sep).join('/');
}

function summary(templates) {
  return templates.flatMap((template) =>
    template.channels.map(
      (channel) =>
        `${template.templateId} ${channel.channel}: ${channel.passed ? 'passed' : 'did not pass'} (${channel.pairs} pairs)`,
    ),
  );
}

export const PRODUCTION_DEPENDENCIES = Object.freeze({
  verifyReferenceSnapshot,
  verifyCandidateTrees,
  createWorkerEvaluator,
  createPythonReference,
});

/**
 * The protected run. Every refusal comes before any corpus byte is decrypted, except a malformed item, and none
 * echoes corpus content. Returns the written path and the aggregate summary lines; nothing per item.
 */
export async function runQualityGate(options, dependencies = PRODUCTION_DEPENDENCIES) {
  const root = options.root ?? repositoryRoot;
  if (options.attestWrittenConsent !== true)
    fail(
      'QUALITY_CONSENT_REQUIRED',
      'the run needs --attest-written-consent: every person in the corpus consented in writing',
    );
  if ((options.platform ?? process.platform) !== 'darwin') fail('QUALITY_PLATFORM', 'the gate runs only on macOS');
  const architecture = options.architecture ?? process.arch;
  if (!QUALITY_ARCHITECTURES.includes(architecture)) fail('QUALITY_PLATFORM', 'the gate runs on arm64 or x64');
  if (options.corpus === undefined)
    fail('QUALITY_CORPUS_REQUIRED', 'the run needs an explicitly supplied corpus directory');
  assertOutsideRepository(options.corpus, { root, what: 'the corpus directory' });
  const key = await readCorpusKey(options.keyFile, { root });
  const candidate = computeCandidate({ root, architecture });
  verifyPythonReferenceRecord(root);
  await dependencies.verifyReferenceSnapshot(options.reference);
  if (
    !(await dependencies.verifyCandidateTrees({
      candidate,
      runtimeTree: options.runtimeTree,
      modelTree: options.modelTree,
    }))
  )
    fail('QUALITY_WORKER_UNAVAILABLE', 'the runtime and model trees are not the candidate’s verified trees');
  const items = (await readCorpusDirectory(options.corpus, { key, root })).map(prepareCorpusItem);
  const worker = await dependencies.createWorkerEvaluator({
    candidate,
    runtimeTree: options.runtimeTree,
    modelTree: options.modelTree,
  });
  let reference;
  let templates;
  try {
    reference = await dependencies.createPythonReference({ python: options.python, snapshot: options.reference });
    templates = await measureCandidate({ candidate, items, worker, reference });
  } finally {
    await reference?.close();
    await worker.close();
  }
  const report = buildReport({ candidate, environment: reference.environment, templates, node: options.node });
  const path = await writeGateReport({ root, report });
  return { path, lines: summary(templates) };
}

// ------------------------------------------------------------------------------------------------ the command

const COMMAND_OPTIONS = Object.freeze({
  '--corpus': 'corpus',
  '--key-file': 'keyFile',
  '--reference': 'reference',
  '--python': 'python',
  '--runtime-tree': 'runtimeTree',
  '--model-tree': 'modelTree',
});

export function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!['keygen', 'seal', 'run'].includes(command)) fail('QUALITY_USAGE', 'the command is keygen, seal or run');
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--attest-written-consent') options.attestWrittenConsent = true;
    else if (Object.hasOwn(COMMAND_OPTIONS, argument)) {
      const value = rest[++index];
      if (value === undefined) fail('QUALITY_USAGE', `${argument} needs a value`);
      options[COMMAND_OPTIONS[argument]] = resolve(value);
    } else fail('QUALITY_USAGE', `unknown argument ${JSON.stringify(argument)}`);
  }
  return options;
}

export async function generateCorpusKey(path, { root = repositoryRoot } = {}) {
  if (typeof path !== 'string') fail('QUALITY_USAGE', 'keygen needs --key-file');
  assertOutsideRepository(path, { root, what: 'the corpus key' });
  await writeFile(path, `${randomBytes(CORPUS_KEY_BYTES).toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
}

export async function sealCorpusFile({ keyFile, corpus, plaintext, root = repositoryRoot }) {
  const key = await readCorpusKey(keyFile, { root });
  if (corpus === undefined) fail('QUALITY_CORPUS_REQUIRED', 'seal needs --corpus');
  const directory = assertOutsideRepository(corpus, { root, what: 'the corpus directory' });
  parseCorpusItems(plaintext);
  const name = `corpus-${randomBytes(8).toString('hex')}${CORPUS_FILE_SUFFIX}`;
  await writeFile(join(directory, name), sealCorpus(key, plaintext), { flag: 'wx', mode: 0o600 });
  return name;
}

async function standardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCommand(process.argv.slice(2));
    if (options.command === 'keygen') {
      await generateCorpusKey(options.keyFile);
      process.stdout.write('wrote a new owner-only corpus key\n');
    } else if (options.command === 'seal') {
      const name = await sealCorpusFile({ ...options, plaintext: await standardInput() });
      process.stdout.write(`sealed one corpus file (${name})\n`);
    } else {
      const { path, lines } = await runQualityGate(options);
      for (const line of lines) process.stdout.write(`${line}\n`);
      process.stdout.write(`wrote ${path} (aggregate only)\n`);
    }
  } catch (error) {
    // Only the closed code and its fixed sentence: never an item, path inside the corpus or child output.
    const code = error instanceof Error && typeof error.code === 'string' ? error.code : 'QUALITY_RUN_FAILED';
    const known = error instanceof QualityGateRunError || error?.name === 'QualityGateError';
    process.stderr.write(`${known ? error.message : `${code}: the quality gate run failed`}\n`);
    process.exitCode = 1;
  }
}
