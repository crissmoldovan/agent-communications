#!/usr/bin/env node
/**
 * The real-Mac boundary evidence (E2-6, E2-9, E2 Task 10): its closed, content-free shape, its binding to the candidate
 * and its verdicts. The owner's protected Mac writes it with `scripts/run-laya-macos-boundary-gate.mjs`; a release that
 * ships the real Laya runtime lock validates it here for every architecture that lock offers, and refuses without it.
 *
 *   node --experimental-strip-types scripts/verify-laya-boundary-gate.mjs [--architecture arm64|x64]...
 *
 * The evidence, `packages/events-laya-runtime/gate/macos-boundary-v2.json`, holds per architecture only the candidate's
 * digests, the Node and macOS versions it ran on, and `pass` or `fail` for each check — never a path, a socket, a
 * process id, a request or an answer. It sits in the gate directory, which the candidate subject excludes, so
 * committing it does not change the subject it names (E2 Task 9's subject).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAggregateOnly,
  computeCandidate,
  GATE_REPORT_DIRECTORY,
  QUALITY_ARCHITECTURES,
} from './verify-laya-quality-gate.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Version 2 (E2 review round 1, A1) adds `spawn`. No version 1 evidence was ever produced, so none is invalidated;
 * `gate/macos-boundary-v1.schema.json` stays as it was written, beside version 2's.
 */
export const BOUNDARY_SCHEMA_VERSION = 2;
export const BOUNDARY_EVIDENCE = `${GATE_REPORT_DIRECTORY}/macos-boundary-v2.json`;
export const BOUNDARY_SCHEMA = `${GATE_REPORT_DIRECTORY}/macos-boundary-v2.schema.json`;
export const BOUNDARY_RUNNER = 'scripts/run-laya-macos-boundary-gate.mjs';
/**
 * What the run proves on a real Mac, each `pass` or `fail`:
 * - `spawn`: the production same-child proof accepted the worker, which it does only when the operating system refused
 *   the worker's attempt to start another process (EPERM under the profile's `process-fork` denial);
 * - `tcp`, `fetch`, `udp`, `uds`: the production same-child proof accepted the worker, which it does only when the
 *   operating system refused that attempt and the daemon's own listener for it saw nothing — for UDP, zero datagrams;
 * - `pipes`, `nativeLoad`: over that child's own pipes, the real runtime and model loaded and answered;
 * - `crashRestart`, `timeoutRestart`, `idleRestart`: a killed worker, a request past its 30-second deadline and ten idle
 *   minutes each end that child, and the next request proves and loads a fresh one;
 * - `alteredTreeRefused`, `repairedTreeAccepted`: one changed byte in the runtime or the model tree starts no worker,
 *   and the restored tree starts one that answers.
 */
export const BOUNDARY_CHECKS = Object.freeze([
  'spawn',
  'tcp',
  'fetch',
  'udp',
  'uds',
  'pipes',
  'nativeLoad',
  'crashRestart',
  'timeoutRestart',
  'idleRestart',
  'alteredTreeRefused',
  'repairedTreeAccepted',
]);
export const BOUNDARY_VERDICTS = Object.freeze(['pass', 'fail']);

const TOP_KEYS = [
  'schemaVersion',
  'manifestId',
  'manifestSha256',
  'runtimeLockSha256',
  'runnerSha256',
  'architectures',
];
const ARCHITECTURE_KEYS = [
  'architecture',
  'platformFileListDigest',
  'subjectDigest',
  'node',
  'macos',
  'checks',
  'passed',
];
const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,31}$/;

export class BoundaryGateError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'BoundaryGateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new BoundaryGateError(code, message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactObject(value, keys, at) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('BOUNDARY_EVIDENCE_SHAPE', `${at || '/'} is an object`);
  const found = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (found.length !== expected.length || found.some((key, index) => key !== expected[index]))
    fail('BOUNDARY_EVIDENCE_SHAPE', `${at || '/'} has exactly its reviewed fields`);
  return value;
}

function token(value, pattern, at) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('BOUNDARY_EVIDENCE_SHAPE', `${at} is a closed token`);
  return value;
}

/**
 * What one architecture's evidence must be bound to, recomputed from a checkout: E2 Task 9's candidate (the strict
 * reviewed manifest and real runtime lock — the placeholder refuses — the platform file list and the subject digest)
 * and this runner's own digest.
 */
export function computeBoundaryCandidate({ root = repositoryRoot, architecture }) {
  let candidate;
  try {
    candidate = computeCandidate({ root, architecture });
  } catch (error) {
    const code = error?.code === 'QUALITY_CANDIDATE_BLOCKED' ? 'BOUNDARY_CANDIDATE_BLOCKED' : 'BOUNDARY_CANDIDATE';
    fail(code, `there is no reviewed Laya candidate for ${architecture}`);
  }
  const runner = join(root, BOUNDARY_RUNNER);
  if (!existsSync(runner)) fail('BOUNDARY_CANDIDATE', 'the candidate has no boundary runner');
  return {
    manifestId: candidate.manifestId,
    manifestSha256: candidate.manifestSha256,
    runtimeLockSha256: candidate.runtimeLockSha256,
    runnerSha256: sha256(readFileSync(runner)),
    architecture,
    platformFileListDigest: candidate.platformFileListDigest,
    subjectDigest: candidate.subjectDigest,
    candidate,
  };
}

/** A check is `pass` only when it ran and held; an architecture passed only when every check did. */
export function boundaryPassed(checks) {
  return BOUNDARY_CHECKS.every((name) => checks[name] === 'pass');
}

/**
 * Validates the evidence against candidates recomputed from the checkout, one per architecture it reports. Returns the
 * evidence; throws a `BoundaryGateError` with a closed code otherwise.
 */
export function validateBoundaryEvidence(evidence, { candidates }) {
  try {
    assertAggregateOnly(evidence);
  } catch (error) {
    fail('BOUNDARY_EVIDENCE_RAW', `the evidence holds what is not a closed token (${error?.code ?? 'unknown'})`);
  }
  exactObject(evidence, TOP_KEYS, '');
  if (evidence.schemaVersion !== BOUNDARY_SCHEMA_VERSION) fail('BOUNDARY_EVIDENCE_SHAPE', 'the schema version is 2');
  token(evidence.manifestId, /^[a-z0-9][a-z0-9-]{0,63}$/, '/manifestId');
  for (const key of ['manifestSha256', 'runtimeLockSha256', 'runnerSha256']) token(evidence[key], HEX64, `/${key}`);
  if (!Array.isArray(evidence.architectures) || evidence.architectures.length === 0)
    fail('BOUNDARY_EVIDENCE_SHAPE', '/architectures is a non-empty list');
  const seen = new Set();
  for (const [index, entry] of evidence.architectures.entries()) {
    const at = `/architectures/${index}`;
    exactObject(entry, ARCHITECTURE_KEYS, at);
    token(entry.architecture, /^(?:arm64|x64)$/, `${at}/architecture`);
    token(entry.platformFileListDigest, HEX64, `${at}/platformFileListDigest`);
    token(entry.subjectDigest, HEX64, `${at}/subjectDigest`);
    token(entry.node, VERSION, `${at}/node`);
    token(entry.macos, VERSION, `${at}/macos`);
    exactObject(entry.checks, BOUNDARY_CHECKS, `${at}/checks`);
    for (const name of BOUNDARY_CHECKS)
      if (!BOUNDARY_VERDICTS.includes(entry.checks[name]))
        fail('BOUNDARY_EVIDENCE_SHAPE', `${at}/checks/${name} is pass or fail`);
    if (typeof entry.passed !== 'boolean') fail('BOUNDARY_EVIDENCE_SHAPE', `${at}/passed is a boolean`);
    if (entry.passed !== boundaryPassed(entry.checks))
      fail('BOUNDARY_EVIDENCE_VERDICT', `${at} has a verdict its checks do not give`);
    if (seen.has(entry.architecture)) fail('BOUNDARY_EVIDENCE_DUPLICATE', `${at} repeats ${entry.architecture}`);
    seen.add(entry.architecture);
  }
  for (const [index, entry] of evidence.architectures.entries()) {
    const at = `/architectures/${index}`;
    const candidate = candidates[entry.architecture];
    if (candidate === undefined) fail('BOUNDARY_EVIDENCE_CANDIDATE', `${at} has no candidate to be bound to`);
    const bound =
      evidence.manifestId === candidate.manifestId &&
      evidence.manifestSha256 === candidate.manifestSha256 &&
      evidence.runtimeLockSha256 === candidate.runtimeLockSha256 &&
      evidence.runnerSha256 === candidate.runnerSha256 &&
      entry.platformFileListDigest === candidate.platformFileListDigest;
    if (!bound) fail('BOUNDARY_EVIDENCE_CANDIDATE', `${at} is not this candidate's manifest, lock, platform or runner`);
    if (entry.subjectDigest !== candidate.subjectDigest)
      fail('BOUNDARY_EVIDENCE_CANDIDATE', `${at} is not this candidate's subject digest`);
  }
  return evidence;
}

/** The canonical bytes the runner writes and a release reads: two-space JSON and a final newline. */
export function canonicalEvidenceBytes(evidence) {
  return Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

export function parseEvidenceBytes(bytes) {
  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail('BOUNDARY_EVIDENCE_JSON', 'the boundary evidence is strict JSON');
  }
  if (!canonicalEvidenceBytes(evidence).equals(Buffer.from(bytes)))
    fail('BOUNDARY_EVIDENCE_JSON', 'the boundary evidence is canonical JSON with no duplicate key');
  return evidence;
}

/**
 * One architecture's new entry, beside an existing file's other architectures only when that file names the same
 * candidate (manifest, lock and runner); a file made for another candidate is refused, never silently replaced.
 */
export function mergeBoundaryEvidence({ existing, top, entry }) {
  const merged = { ...top, architectures: [entry] };
  if (existing === undefined) return merged;
  const shared = (value) =>
    JSON.stringify([value.manifestId, value.manifestSha256, value.runtimeLockSha256, value.runnerSha256]);
  if (shared(existing) !== shared(top))
    fail('BOUNDARY_EVIDENCE_STALE', 'the existing boundary evidence was made for another candidate; remove it first');
  const others = existing.architectures.filter((other) => other.architecture !== entry.architecture);
  merged.architectures = [...others, entry].sort((left, right) => (left.architecture < right.architecture ? -1 : 1));
  return merged;
}

/**
 * A release offers Laya on an architecture only with that architecture's exact passing boundary evidence; arm64
 * evidence never authorises x64 (E2-J), and no checklist or other report stands in for it (E2-9).
 */
export function verifyBoundaryGate({ root = repositoryRoot, architectures }) {
  if (!Array.isArray(architectures) || architectures.length === 0)
    fail('BOUNDARY_GATE_ABSENT', 'a release names the architectures it offers');
  const path = join(root, BOUNDARY_EVIDENCE);
  if (!existsSync(path)) fail('BOUNDARY_GATE_ABSENT', 'no real-Mac boundary evidence exists for this candidate');
  const evidence = parseEvidenceBytes(readFileSync(path));
  const reported = Array.isArray(evidence.architectures)
    ? evidence.architectures.map((entry) => entry?.architecture).filter((name) => QUALITY_ARCHITECTURES.includes(name))
    : [];
  const candidates = Object.fromEntries(
    [...new Set([...architectures, ...reported])].map((architecture) => [
      architecture,
      computeBoundaryCandidate({ root, architecture }),
    ]),
  );
  validateBoundaryEvidence(evidence, { candidates });
  for (const architecture of architectures) {
    const entry = evidence.architectures.find((candidate) => candidate.architecture === architecture);
    if (entry === undefined) fail('BOUNDARY_GATE_ABSENT', `no boundary evidence exists for ${architecture}`);
    if (!entry.passed) fail('BOUNDARY_GATE_FAILED', `the boundary run did not pass on ${architecture}`);
  }
  return evidence;
}

function parseArguments(argv) {
  const options = { root: repositoryRoot, architectures: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root')
      options.root = resolve(argv[++index] ?? fail('BOUNDARY_USAGE', '--root names a directory'));
    else if (argument === '--architecture') options.architectures.push(argv[++index] ?? '');
    else fail('BOUNDARY_USAGE', `unknown argument ${JSON.stringify(argument)}`);
  }
  if (options.architectures.length === 0) options.architectures.push('arm64');
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const evidence = verifyBoundaryGate(options);
    process.stdout.write(
      `Laya boundary gate: ${evidence.manifestId} passes on ${options.architectures.join(', ')} for every check\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
