#!/usr/bin/env node
/**
 * Where the gate evidence came from (E2 review round 1, A3). The protected workflow
 * (`.github/workflows/laya-quality-gate.yml`) writes the two gate results on the owner's Mac, but the owner commits them
 * by hand, so on their own they are self-attested: any document that validates could be committed. A release that
 * ships the real Laya runtime lock therefore asks GitHub, before it accepts them, about the protected run each offered
 * architecture's results came from:
 *
 * - the owner records, per offered architecture, that run's id and the candidate commit it ran on, in
 *   `packages/events-laya-runtime/gate/runs-v1.json` (the gate directory, outside the candidate subject);
 * - the run is `.github/workflows/laya-quality-gate.yml`, started by `workflow_dispatch` on a `laya-candidate-*` tag of
 *   this repository, completed with `success`, on exactly that commit;
 * - the run uploaded, unzipped, `laya-quality-run.json` and `laya-boundary-run.json` — each result as that run wrote
 *   it, restricted to its own architecture — and each artifact's SHA-256 digest equals the committed result's,
 *   restricted the same way (`runCopyBytes`, which the runners use to write them).
 *
 * It makes two GET requests per architecture to the GitHub REST API and nothing else, needs only `actions: read`, and
 * sends the job's token only as a header.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-laya-gate-runs.mjs \
 *     [--architecture arm64|x64]...
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOUNDARY_EVIDENCE, canonicalEvidenceBytes, parseEvidenceBytes } from './verify-laya-boundary-gate.mjs';
import {
  canonicalReportBytes,
  computeCandidate,
  GATE_REPORT_DIRECTORY,
  parseReportBytes,
  QUALITY_ARCHITECTURES,
} from './verify-laya-quality-gate.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export const GATE_RUNS = `${GATE_REPORT_DIRECTORY}/runs-v1.json`;
export const GATE_RUNS_SCHEMA_VERSION = 1;
export const GATE_WORKFLOW = '.github/workflows/laya-quality-gate.yml';
/** The run's own copies of its two results, uploaded unzipped, so each artifact's digest is the file's SHA-256. */
export const RUN_COPIES = Object.freeze({ quality: 'laya-quality-run.json', boundary: 'laya-boundary-run.json' });
const API_TIMEOUT_MS = 30_000;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class LayaGateRunError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'LayaGateRunError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LayaGateRunError(code, message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * One architecture's entry of a gate result, with every field the result shares: the bytes a protected run writes as
 * its own copy, and the bytes a release recomputes from the committed result to compare with that copy's digest.
 */
export function runCopyBytes(document, architecture, canonicalBytes) {
  const entries = Array.isArray(document?.architectures)
    ? document.architectures.filter((entry) => entry?.architecture === architecture)
    : [];
  if (entries.length !== 1) fail('LAYA_GATE_RUN_RESULT', `the result has no single ${architecture} entry`);
  return canonicalBytes({ ...document, architectures: entries });
}

/** The canonical bytes of a run record: two-space JSON and a final newline, as the other gate documents are. */
export function canonicalRunRecordBytes(record) {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function exactKeys(value, keys, at) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('LAYA_GATE_RUNS_SHAPE', `${at || '/'} is an object`);
  const found = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (found.length !== expected.length || found.some((key, index) => key !== expected[index]))
    fail('LAYA_GATE_RUNS_SHAPE', `${at || '/'} has exactly its fields`);
  return value;
}

/** The owner's run record: per architecture, the protected run's id and the candidate commit it ran on. */
export function parseRunRecordBytes(bytes) {
  let record;
  try {
    record = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail('LAYA_GATE_RUNS_SHAPE', 'the run record is strict JSON');
  }
  if (!canonicalRunRecordBytes(record).equals(Buffer.from(bytes)))
    fail('LAYA_GATE_RUNS_SHAPE', 'the run record is canonical JSON with no duplicate key');
  exactKeys(record, ['schemaVersion', 'runs'], '');
  if (record.schemaVersion !== GATE_RUNS_SCHEMA_VERSION) fail('LAYA_GATE_RUNS_SHAPE', 'the schema version is 1');
  if (!Array.isArray(record.runs) || record.runs.length === 0 || record.runs.length > QUALITY_ARCHITECTURES.length)
    fail('LAYA_GATE_RUNS_SHAPE', '/runs lists one run per architecture');
  const seen = new Set();
  for (const [index, run] of record.runs.entries()) {
    const at = `/runs/${index}`;
    exactKeys(run, ['architecture', 'runId', 'commit'], at);
    if (!QUALITY_ARCHITECTURES.includes(run.architecture))
      fail('LAYA_GATE_RUNS_SHAPE', `${at}/architecture is arm64 or x64`);
    if (typeof run.runId !== 'string' || !RUN_ID.test(run.runId))
      fail('LAYA_GATE_RUNS_SHAPE', `${at}/runId is a run id, in decimal`);
    if (typeof run.commit !== 'string' || !COMMIT.test(run.commit))
      fail('LAYA_GATE_RUNS_SHAPE', `${at}/commit is a full commit id`);
    if (seen.has(run.architecture)) fail('LAYA_GATE_RUNS_SHAPE', `${at} repeats ${run.architecture}`);
    seen.add(run.architecture);
  }
  return record;
}

/** The one GET this check makes, twice per architecture: JSON from the REST API, or a closed refusal. */
async function getJson(api, path) {
  let response;
  try {
    response = await fetch(`${api.url}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(api.token === undefined ? {} : { authorization: `Bearer ${api.token}` }),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    fail('LAYA_GATE_RUN_API', `GitHub did not answer ${path}`);
  }
  if (response.status !== 200) fail('LAYA_GATE_RUN_API', `GitHub answered ${response.status} for ${path}`);
  try {
    return await response.json();
  } catch {
    return fail('LAYA_GATE_RUN_API', `GitHub's answer for ${path} is not JSON`);
  }
}

/** The protected run itself: this workflow, started by hand on a candidate tag, finished, passed, on that commit. */
function assertProtectedRun(run, { runId, commit, repository, architecture }) {
  const named = `run ${runId} (${architecture})`;
  if (String(run?.id) !== runId) fail('LAYA_GATE_RUN', `${named} is not the run GitHub answered with`);
  if (run.repository?.full_name !== repository) fail('LAYA_GATE_RUN', `${named} is not a run of ${repository}`);
  // The path names the workflow file, and may carry the ref it ran from after an `@`.
  if (typeof run.path !== 'string' || (run.path !== GATE_WORKFLOW && !run.path.startsWith(`${GATE_WORKFLOW}@`)))
    fail('LAYA_GATE_RUN', `${named} is not ${GATE_WORKFLOW}`);
  if (run.event !== 'workflow_dispatch') fail('LAYA_GATE_RUN', `${named} was not started by hand`);
  if (typeof run.head_branch !== 'string' || !run.head_branch.startsWith('laya-candidate-'))
    fail('LAYA_GATE_RUN', `${named} did not run on a laya-candidate tag`);
  if (run.status !== 'completed' || run.conclusion !== 'success') fail('LAYA_GATE_RUN', `${named} did not pass`);
  if (run.head_sha !== commit) fail('LAYA_GATE_RUN', `${named} ran on another commit than the one recorded`);
}

/** Each run copy: uploaded once by that run, and its digest the committed result's, restricted to that architecture. */
function assertRunCopies(listing, { runId, architecture, expected }) {
  const artifacts = Array.isArray(listing?.artifacts) ? listing.artifacts : [];
  if (typeof listing?.total_count !== 'number' || listing.total_count !== artifacts.length)
    fail('LAYA_GATE_RUN_ARTIFACT', `run ${runId} lists more artifacts than one page holds`);
  for (const [kind, name] of Object.entries(RUN_COPIES)) {
    const found = artifacts.filter((artifact) => artifact?.name === name);
    if (found.length !== 1) fail('LAYA_GATE_RUN_ARTIFACT', `run ${runId} has no single ${name}`);
    const [artifact] = found;
    if (
      artifact.workflow_run !== undefined &&
      artifact.workflow_run !== null &&
      String(artifact.workflow_run.id) !== runId
    )
      fail('LAYA_GATE_RUN_ARTIFACT', `${name} of run ${runId} belongs to another run`);
    if (artifact.digest !== `sha256:${expected[kind]}`)
      fail('LAYA_GATE_RUN_DIGEST', `${name} of run ${runId} is not the committed ${kind} result for ${architecture}`);
  }
}

function readCommitted(root, path, what) {
  const file = join(root, path);
  if (!existsSync(file)) fail('LAYA_GATE_RUN_RESULT', `${what} is not committed`);
  return readFileSync(file);
}

/**
 * The provenance check, for every architecture a release offers: the owner's run record names a protected run, and
 * that run's two unzipped copies are exactly the committed results for that architecture. `api` is the REST API's base
 * URL, this repository's `owner/name`, and an optional token.
 */
export async function verifyGateRuns({ root = repositoryRoot, architectures, api }) {
  if (!Array.isArray(architectures) || architectures.length === 0)
    fail('LAYA_GATE_RUNS_ABSENT', 'a release names the architectures it offers');
  if (typeof api?.repository !== 'string' || !REPOSITORY.test(api.repository))
    fail('LAYA_GATE_RUN_API', 'the repository is owner/name');
  const recordPath = join(root, GATE_RUNS);
  if (!existsSync(recordPath)) fail('LAYA_GATE_RUNS_ABSENT', `no run record (${GATE_RUNS}) names the protected runs`);
  const record = parseRunRecordBytes(readFileSync(recordPath));
  const manifestId = computeCandidate({ root, architecture: architectures[0] }).manifestId;
  const quality = parseReportBytes(
    readCommitted(root, `${GATE_REPORT_DIRECTORY}/${manifestId}.json`, 'the quality report'),
  );
  const boundary = parseEvidenceBytes(readCommitted(root, BOUNDARY_EVIDENCE, 'the boundary evidence'));
  const checked = [];
  for (const architecture of architectures) {
    const run = record.runs.find((entry) => entry.architecture === architecture);
    if (run === undefined) fail('LAYA_GATE_RUNS_ABSENT', `the run record names no protected run for ${architecture}`);
    const expected = {
      quality: sha256(runCopyBytes(quality, architecture, canonicalReportBytes)),
      boundary: sha256(runCopyBytes(boundary, architecture, canonicalEvidenceBytes)),
    };
    const base = `/repos/${api.repository}/actions/runs/${run.runId}`;
    assertProtectedRun(await getJson(api, base), { ...run, repository: api.repository, architecture });
    assertRunCopies(await getJson(api, `${base}/artifacts?per_page=100`), { ...run, architecture, expected });
    checked.push({ architecture, runId: run.runId });
  }
  return checked;
}

/** This repository's `owner/name`, from the root package's `repository.url`. */
export function repositoryOf(root = repositoryRoot) {
  const url = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))?.repository?.url;
  const matched = typeof url === 'string' ? /github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/.exec(url) : null;
  if (matched === null) fail('LAYA_GATE_RUN_API', 'the root package names no GitHub repository');
  return matched[1];
}

/**
 * The production API: GitHub's own URL for the job (`GITHUB_API_URL`, https only), this repository, and the job's
 * token (`GITHUB_TOKEN`, which the release job grants `actions: read` and nothing more), when there is one.
 */
export function gateRunsApi(env = process.env, root = repositoryRoot) {
  const url = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+(?:\/[^?#]*)?$/.test(url)) fail('LAYA_GATE_RUN_API', 'the GitHub API is reached over https');
  const repository = env.GITHUB_REPOSITORY ?? repositoryOf(root);
  const token = typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0 ? env.GITHUB_TOKEN : undefined;
  return { url, repository, token };
}

function parseArguments(argv) {
  const options = { root: repositoryRoot, architectures: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root')
      options.root = resolve(argv[++index] ?? fail('LAYA_GATE_RUNS_USAGE', '--root names a directory'));
    else if (argument === '--architecture') options.architectures.push(argv[++index] ?? '');
    else fail('LAYA_GATE_RUNS_USAGE', `unknown argument ${JSON.stringify(argument)}`);
  }
  if (options.architectures.length === 0) options.architectures.push('arm64');
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const checked = await verifyGateRuns({ ...options, api: gateRunsApi(process.env, options.root) });
    for (const { architecture, runId } of checked)
      process.stdout.write(`Laya gate runs: ${architecture}'s results are protected run ${runId}'s own\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof LayaGateRunError ? error.message : 'LAYA_GATE_RUN_FAILED'}\n`);
    process.exitCode = 1;
  }
}
