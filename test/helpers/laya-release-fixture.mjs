/**
 * Disposable release candidates for the Laya release-gate tests (E2 Task 10). Every test runs on a copy: a fresh
 * temporary root holding copies of the assets a release reads, never the repository's own files.
 *
 * - `dormantRoot()` is this repository as it ships: the fail-closed placeholder lock.
 * - `offeredRoot()` ships a real lock — E2 Task 9's synthetic fixture candidate (tiny stand-in sources, the two-package
 *   fixture lock) with this release's own manifest — so the quality and boundary evidence written beside it are bound
 *   to a candidate no release of this repository is. Nothing here is release evidence.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOUNDARY_CHECKS,
  BOUNDARY_EVIDENCE,
  BOUNDARY_RUNNER,
  BOUNDARY_SCHEMA_VERSION,
  canonicalEvidenceBytes,
  computeBoundaryCandidate,
} from '../../scripts/verify-laya-boundary-gate.mjs';
import {
  canonicalReportBytes,
  computeCandidate,
  GATE_REPORT_DIRECTORY,
  materializeFixtureCandidate,
  QUALITY_CORPUS_RELEASE,
} from '../../scripts/verify-laya-quality-gate.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SHIPPED = Object.freeze({
  manifest: 'packages/events-daemon/laya-manifest.json',
  runtimeLock: 'packages/events-daemon/laya-runtime.json',
  disclosures: 'packages/events-daemon/laya-enablement-disclosures.json',
  daemon: 'packages/events-daemon/package.json',
  runtime: 'packages/events-laya-runtime/package.json',
  lockfile: 'pnpm-lock.yaml',
});
const METRICS = 'packages/events-daemon/test/fixtures/laya/quality/metrics-v1.json';
/** A package list stand-in: the gate reads the real `scripts/packages.mjs` only from its command. */
export const RELEASE_LISTS = Object.freeze({ publishable: ['core'], packages: ['core'] });

export async function copyInto(root, files) {
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await cp(join(ROOT, file), join(root, file));
  }
}

export async function removeRoot(root) {
  await rm(root, { recursive: true, force: true });
}

/** The release inputs as this repository ships them, the placeholder lock included. */
export async function dormantRoot() {
  const root = await mkdtemp(join(tmpdir(), 'laya-release-dormant-'));
  await copyInto(root, Object.values(SHIPPED));
  return root;
}

/** A candidate that ships a real lock (the synthetic fixture lock), with this release's manifest. */
export async function offeredRoot() {
  const metrics = JSON.parse(await readFile(join(ROOT, METRICS), 'utf8'));
  const root = await materializeFixtureCandidate(metrics, { source: ROOT });
  await copyInto(root, [SHIPPED.manifest, SHIPPED.daemon, SHIPPED.runtime, SHIPPED.lockfile]);
  await writeFile(join(root, BOUNDARY_RUNNER), '// A stand-in boundary runner: the evidence binds only its digest.\n');
  return { root, metrics };
}

/** The synthetic report, marked as a consented run and bound to this root's candidate: written into the root only. */
export async function writeQualityReport(root, metrics, architectures) {
  const candidates = architectures.map((architecture) => computeCandidate({ root, architecture }));
  const [first] = candidates;
  const fixture = metrics.report.architectures[0];
  const passing = fixture.templates.find((template) => template.templateId === 'laya-noul-v1');
  const report = {
    ...metrics.report,
    manifestId: first.manifestId,
    manifestSha256: first.manifestSha256,
    runtimeLockSha256: first.runtimeLockSha256,
    runnerSha256: first.runnerSha256,
    corpus: { ...QUALITY_CORPUS_RELEASE },
    architectures: candidates.map((candidate) => ({
      ...fixture,
      architecture: candidate.architecture,
      platformFileListDigest: candidate.platformFileListDigest,
      subjectDigest: candidate.subjectDigest,
      templates: candidate.templates.map((template) => ({ ...passing, ...template })),
    })),
  };
  const path = join(root, GATE_REPORT_DIRECTORY, `${first.manifestId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonicalReportBytes(report));
  return path;
}

export function passingChecks() {
  return Object.fromEntries(BOUNDARY_CHECKS.map((name) => [name, 'pass']));
}

/** Boundary evidence bound to this root's candidate, every check passing unless `checks` says otherwise. */
export function boundaryEvidence(root, architectures, { checks = {} } = {}) {
  const candidates = architectures.map((architecture) => computeBoundaryCandidate({ root, architecture }));
  const [first] = candidates;
  return {
    schemaVersion: BOUNDARY_SCHEMA_VERSION,
    manifestId: first.manifestId,
    manifestSha256: first.manifestSha256,
    runtimeLockSha256: first.runtimeLockSha256,
    runnerSha256: first.runnerSha256,
    architectures: candidates.map((candidate) => {
      const verdicts = { ...passingChecks(), ...(checks[candidate.architecture] ?? {}) };
      return {
        architecture: candidate.architecture,
        platformFileListDigest: candidate.platformFileListDigest,
        subjectDigest: candidate.subjectDigest,
        node: '22.18.0',
        macos: '14.5',
        checks: verdicts,
        passed: Object.values(verdicts).every((verdict) => verdict === 'pass'),
      };
    }),
  };
}

export async function writeBoundaryEvidence(root, evidence) {
  const path = join(root, BOUNDARY_EVIDENCE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonicalEvidenceBytes(evidence));
  return path;
}

/** The closed code a refusal carries, or `null` when nothing was refused. */
export async function codeOf(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error?.code ?? `uncoded: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The error a refusal carries, for its message. */
export async function refusalOf(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}
