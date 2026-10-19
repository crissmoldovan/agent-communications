import { spawnSync } from 'node:child_process';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { JUDGE_KINDS } from '../../domain/lifecycle.ts';
import type { JudgeReservation } from '../judge-budget.ts';
import type { JudgeAnswer, JudgeExecutionRequest } from '../judge-coordinator.ts';
import { isLayaTemplateId } from './templates.ts';
import { LAYA_SANDBOX_EXECUTABLE, LAYA_SANDBOX_PROFILE } from './worker-boundary-probe.ts';

const LAYA_KIND: (typeof JUDGE_KINDS)[1] = JUDGE_KINDS[1];
const PLATFORM_PREFIX = 'darwin-';
const SANDBOX_TRIVIAL_PROGRAM = '/usr/bin/true';
const SANDBOX_PROBE_TIMEOUT_MS = 250;

export type LayaUnavailableCode =
  | 'E2_EXTERNAL_REFERENCE_BLOCKED'
  | 'LAYA_PLATFORM_UNAVAILABLE'
  | 'LAYA_SANDBOX_UNAVAILABLE';
export type LayaModelState = 'installing' | 'downloading' | 'ready' | 'failed' | 'removed';
export type LayaPresentationState =
  | 'idle'
  | 'installing'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'failed'
  | 'unavailable';
export const LAYA_MODEL_FAILURE_CODES = ['boundary-failed', 'download-failed', 'integrity', 'runtime-failed'] as const;
export type LayaModelFailureCode = (typeof LAYA_MODEL_FAILURE_CODES)[number];

export class LayaContractError extends Error {
  readonly code: LayaUnavailableCode | 'LAYA_ENABLEMENT_EXACT' | 'LAYA_ASSET_INVALID';

  constructor(code: LayaContractError['code'], message: string) {
    super(message);
    this.name = 'LayaContractError';
    this.code = code;
  }
}

export interface LayaManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CanonicalLayaManifest {
  readonly manifestVersion: 1;
  readonly manifestId: string;
  readonly source: { readonly host: 'huggingface.co'; readonly repo: string; readonly revision: string };
  readonly weights: {
    readonly publisher: string;
    readonly origin: string;
    readonly originSha256: string;
    readonly licence: string;
  };
  readonly files: readonly LayaManifestFile[];
  readonly runtime: Readonly<Record<string, string>>;
  readonly context: { readonly maxTokens: 512; readonly language: 'en' };
  readonly promptTemplates: readonly string[];
}

export interface LayaRuntimeFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

interface RuntimePackage {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
  readonly files: Readonly<Record<string, readonly LayaRuntimeFile[]>>;
}

interface RuntimeLock {
  readonly schemaVersion: 1;
  readonly packages: readonly RuntimePackage[];
}

/** The only injectable Laya definition input: exact reviewed asset bytes, never a prebuilt definition. */
export interface LayaReviewedAssetSource {
  readonly manifestBytes: Uint8Array;
  readonly runtimeLockBytes: Uint8Array;
  readonly disclosuresBytes: Uint8Array;
}

/** @deprecated Use LayaReviewedAssetSource. Kept as a source-compatible type name for existing fixture helpers. */
export type LayaReviewedAssets = LayaReviewedAssetSource;

export interface LayaSandboxSpawnResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: unknown;
}

export type LayaSandboxSpawn = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly stdio: 'ignore';
    readonly timeout: number;
    readonly killSignal: 'SIGKILL';
  }>,
) => LayaSandboxSpawnResult;

export interface LayaPlatformProbe {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  /** Test seam only. Production uses node:child_process.spawnSync below. */
  readonly spawnSync?: LayaSandboxSpawn | undefined;
}

export interface CanonicalLayaRuntimeLock {
  readonly schemaVersion: 1;
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly url: string;
    readonly integrity: string;
  }[];
  readonly platform: {
    readonly id: string;
    readonly files: readonly (LayaRuntimeFile & { readonly package: string })[];
    readonly digest: string;
  };
  readonly digest: string;
}

export interface CanonicalLayaEnablement {
  readonly id: `judge-kind:${typeof LAYA_KIND}`;
  readonly kind: typeof LAYA_KIND;
  readonly version: number;
  readonly manifest: CanonicalLayaManifest;
  readonly runtimeLock: CanonicalLayaRuntimeLock;
  readonly disclosures: CanonicalLayaEnablementDisclosures;
}

export interface CanonicalLayaEnablementDisclosures {
  readonly modelBytes: number;
  readonly runtimeBytes: number;
  readonly runtimeLicences: readonly string[];
  readonly workerMemory: string;
  readonly facts: Readonly<{
    readonly englishCpu: string;
    readonly macosBoundary: string;
    readonly linuxUnavailable: string;
    readonly windowsUnavailable: string;
    readonly downloadAfterApproval: string;
    readonly oneAtATime: string;
  }>;
  readonly limitations: Readonly<{
    readonly sandboxDeprecation: string;
    readonly englishAccuracy: string;
  }>;
}

/**
 * The stable Laya status answer, version 1: what `judge model status --json` prints, what `judge model remove`
 * returns, `doctor`'s `judge.laya` builds on and the desktop app reads (schema:
 * `src/operations/contracts/laya-model-status-v1.schema.json`). Exactly these eight fields, always present:
 *
 * - `state`: `idle` — disabled and offered here (a removed model is `idle` too); `installing` — the runtime is
 *   being installed after an approved enablement's claim; `downloading` — the model is being downloaded;
 *   `verifying` — both trees are being compared with the lock and manifest; `ready`; `failed` — see `failureCode`;
 *   `unavailable` — disabled and not offered on this machine or in this release, see `reason`. An enabled kind is
 *   never `idle` or `unavailable`.
 * - `manifestId`, `runtimeLockDigest`: the reviewed entry's identity; the digest is null when this platform has no
 *   reviewed runtime lock (the placeholder lock, Linux, Windows).
 * - `bytesVerified` of `totalBytes`: byte progress over this platform's reviewed runtime and model files (model only
 *   while no runtime lock applies); an idle installation that kept a verified copy keeps its byte count.
 * - `failureCode` (only with `failed`): `integrity`, `download-failed`, `runtime-failed` or `boundary-failed`.
 * - `reason` (with `unavailable`, and with `failed`/`boundary-failed`): `E2_EXTERNAL_REFERENCE_BLOCKED` — this
 *   release ships the placeholder lock, so Laya is not offered yet; `LAYA_PLATFORM_UNAVAILABLE`;
 *   `LAYA_SANDBOX_UNAVAILABLE`.
 * - `updatedAt`: the content-free D8 row's last change, or null.
 *
 * It carries no path, input, request, response, key or token. A new field or code is a new version.
 */
export interface LayaModelStatus {
  readonly state: LayaPresentationState;
  readonly manifestId: string | null;
  readonly runtimeLockDigest: string | null;
  readonly bytesVerified: number;
  readonly totalBytes: number;
  readonly failureCode: LayaModelFailureCode | null;
  readonly reason: LayaUnavailableCode | null;
  readonly updatedAt: number | null;
}

/**
 * `doctor`'s Laya entry (doctor-v3 `judge.laya`): the status answer's state, identity, failure and progress, plus the
 * installed runtime's state, the D8 model row's state and the boundary's availability. Never a path or content.
 */
export interface LayaArtifactDoctor {
  readonly state: LayaPresentationState;
  readonly manifestId: string | null;
  readonly runtimeLockDigest: string | null;
  readonly runtime: 'absent' | 'installing' | 'installed';
  readonly model: 'absent' | LayaModelState;
  readonly boundary:
    | { readonly status: 'active'; readonly reason: null }
    | { readonly status: 'unavailable'; readonly reason: LayaUnavailableCode };
  readonly failureCode: LayaModelFailureCode | null;
  readonly bytesVerified: number;
  readonly totalBytes: number;
}

/** The worker-facing result stays narrower than a transport result and never carries a request, response or path. */
export type LayaJudgeAnswer = JudgeAnswer;

export interface LayaJudgeAvailability {
  readonly available: true;
}

export interface LayaJudgeUnavailable {
  readonly available: false;
  readonly code: LayaUnavailableCode;
}

export interface LayaJudgeKindDefinition {
  readonly kind: typeof LAYA_KIND;
  availability(): LayaJudgeAvailability | LayaJudgeUnavailable;
  prepareEnablement(input: { readonly version: number }): CanonicalLayaEnablement;
  canonicalEnablement(value: unknown): CanonicalLayaEnablement;
  /** The approval view is the exact immutable enablement document, not a detached rendering. */
  preview(input: { readonly version: number }): CanonicalLayaEnablement;
  onEnabled(enablement: CanonicalLayaEnablement, activation: { readonly id: string }): Promise<LayaModelStatus>;
  execute(request: JudgeExecutionRequest, reservation: JudgeReservation): Promise<LayaJudgeAnswer>;
  onWorkPurged(scope: Readonly<Record<string, unknown>>): Promise<void>;
  onDisabled(): Promise<void>;
  status(): LayaModelStatus;
  removeWhenDisabled(): Promise<LayaModelStatus>;
}

/** The durable D8 projection accepted at the daemon-to-B3/C boundary. */
export interface LayaModelStatusRecord {
  readonly manifestId: string;
  readonly state: LayaModelState;
  readonly bytesVerified: number;
  readonly verifiedAt: number | null;
  readonly failureCode: LayaModelFailureCode | null;
  readonly updatedAt: number;
}

function fail(code: LayaContractError['code'], message: string): never {
  throw new LayaContractError(code, message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail('LAYA_ASSET_INVALID', `${name} is an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const found = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (found.length !== expected.length || found.some((key, index) => key !== expected[index]))
    fail('LAYA_ASSET_INVALID', `${name} has exact reviewed fields`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('LAYA_ASSET_INVALID', `${name} is a non-empty string`);
  return value;
}

function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail('LAYA_ASSET_INVALID', `${name} is a positive integer`);
  return value as number;
}

function nonNegative(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail('LAYA_ASSET_INVALID', `${name} is a non-negative integer`);
  return value as number;
}

function modelState(value: unknown): LayaModelState {
  if (
    value === 'installing' ||
    value === 'downloading' ||
    value === 'ready' ||
    value === 'failed' ||
    value === 'removed'
  )
    return value;
  return fail('LAYA_ASSET_INVALID', 'the Laya model state is closed');
}

function modelFailureCode(value: unknown): LayaModelFailureCode | null {
  if (value === null) return null;
  if ((LAYA_MODEL_FAILURE_CODES as readonly string[]).includes(value as string)) return value as LayaModelFailureCode;
  return fail('LAYA_ASSET_INVALID', 'the Laya model failure code is closed');
}

function safePath(value: unknown, name: string): string {
  const path = text(value, name);
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail('LAYA_ASSET_INVALID', `${name} is a safe relative path`);
  return path;
}

function sha256(value: unknown, name: string): string {
  const digest = text(value, name);
  if (!/^[a-f0-9]{64}$/.test(digest)) fail('LAYA_ASSET_INVALID', `${name} is lowercase SHA-256`);
  return digest;
}

function ordered<T>(values: readonly T[], key: (value: T) => string, name: string): readonly T[] {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1] as T) >= key(values[index] as T))
      fail('LAYA_ASSET_INVALID', `${name} is sorted and duplicate-free`);
  }
  return values;
}

function manifest(value: unknown): CanonicalLayaManifest {
  const candidate = object(value, 'the Laya manifest');
  exactKeys(
    candidate,
    ['manifestVersion', 'manifestId', 'source', 'weights', 'files', 'runtime', 'context', 'promptTemplates'],
    'the Laya manifest',
  );
  if (candidate.manifestVersion !== 1) fail('LAYA_ASSET_INVALID', 'the Laya manifest has version 1');
  const source = object(candidate.source, 'the Laya source');
  exactKeys(source, ['host', 'repo', 'revision'], 'the Laya source');
  if (source.host !== 'huggingface.co') fail('LAYA_ASSET_INVALID', 'the Laya source has its reviewed host');
  const revision = text(source.revision, 'the Laya revision');
  if (!/^[a-f0-9]{40}$/.test(revision)) fail('LAYA_ASSET_INVALID', 'the Laya revision is a full lowercase commit');
  const weights = object(candidate.weights, 'the Laya weights');
  exactKeys(weights, ['publisher', 'origin', 'originSha256', 'licence'], 'the Laya weights');
  if (!Array.isArray(candidate.files) || candidate.files.length === 0)
    fail('LAYA_ASSET_INVALID', 'the Laya files are non-empty');
  const files = ordered(
    candidate.files.map((entry) => {
      const file = object(entry, 'a Laya manifest file');
      exactKeys(file, ['path', 'size', 'sha256'], 'a Laya manifest file');
      return {
        path: safePath(file.path, 'a Laya manifest path'),
        size: positive(file.size, 'a Laya manifest size'),
        sha256: sha256(file.sha256, 'a Laya manifest SHA-256'),
      };
    }),
    (file) => Buffer.from(file.path, 'utf8').toString('hex'),
    'the Laya manifest files',
  );
  const runtime = object(candidate.runtime, 'the Laya runtime preview');
  const runtimeEntries = Object.entries(runtime);
  if (
    runtimeEntries.length === 0 ||
    runtimeEntries.some(([name, version]) => name.length === 0 || typeof version !== 'string' || version.length === 0)
  )
    fail('LAYA_ASSET_INVALID', 'the Laya runtime preview is reviewed');
  const context = object(candidate.context, 'the Laya context');
  exactKeys(context, ['maxTokens', 'language'], 'the Laya context');
  if (context.maxTokens !== 512 || context.language !== 'en')
    fail('LAYA_ASSET_INVALID', 'the Laya context is English and bounded to 512 tokens');
  // The manifest lists which of the worker's immutable templates a release offers (E2 Task 10: the first release offers
  // `laya-noul-v1` alone); a template the worker source does not implement is never offered.
  if (
    !Array.isArray(candidate.promptTemplates) ||
    candidate.promptTemplates.length === 0 ||
    !candidate.promptTemplates.every((entry) => isLayaTemplateId(entry))
  )
    fail('LAYA_ASSET_INVALID', 'the Laya prompt templates are reviewed templates the worker implements');
  const promptTemplates = ordered(
    candidate.promptTemplates.map((entry) => text(entry, 'a Laya prompt template')),
    (entry) => entry,
    'the Laya prompt templates',
  );
  return {
    manifestVersion: 1,
    manifestId: text(candidate.manifestId, 'the Laya manifest id'),
    source: { host: 'huggingface.co', repo: text(source.repo, 'the Laya repository'), revision },
    weights: {
      publisher: text(weights.publisher, 'the Laya weights publisher'),
      origin: text(weights.origin, 'the Laya weights origin'),
      originSha256: sha256(weights.originSha256, 'the Laya weights origin SHA-256'),
      licence: text(weights.licence, 'the Laya weights licence'),
    },
    files,
    runtime: Object.fromEntries(runtimeEntries.map(([name, version]) => [name, version as string])),
    context: { maxTokens: 512, language: 'en' },
    promptTemplates,
  };
}

function runtimeLock(value: unknown): RuntimeLock | { readonly blocked: 'E2_EXTERNAL_REFERENCE_BLOCKED' } {
  const candidate = object(value, 'the Laya runtime lock');
  if (candidate.schemaVersion === 1 && candidate.blocked === 'E2_EXTERNAL_REFERENCE_BLOCKED') {
    exactKeys(candidate, ['schemaVersion', 'blocked'], 'the blocked Laya runtime lock');
    return { blocked: 'E2_EXTERNAL_REFERENCE_BLOCKED' };
  }
  exactKeys(candidate, ['schemaVersion', 'packages'], 'the Laya runtime lock');
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.packages) || candidate.packages.length === 0)
    fail('LAYA_ASSET_INVALID', 'the Laya runtime lock is complete');
  const packages = ordered(
    candidate.packages.map((entry) => {
      const pkg = object(entry, 'a Laya runtime package');
      exactKeys(pkg, ['name', 'version', 'url', 'integrity', 'files'], 'a Laya runtime package');
      const filesByPlatform = object(pkg.files, 'a Laya runtime package file list');
      const files = Object.fromEntries(
        Object.entries(filesByPlatform).map(([platform, entries]) => {
          if (!platform.startsWith(PLATFORM_PREFIX) || !Array.isArray(entries))
            fail('LAYA_ASSET_INVALID', 'a Laya runtime package has macOS file lists');
          return [
            platform,
            ordered(
              entries.map((file) => {
                const parsed = object(file, 'a Laya runtime file');
                exactKeys(parsed, ['path', 'size', 'sha256', 'executable'], 'a Laya runtime file');
                if (typeof parsed.executable !== 'boolean')
                  fail('LAYA_ASSET_INVALID', 'a Laya runtime executable bit is boolean');
                return {
                  path: safePath(parsed.path, 'a Laya runtime path'),
                  size: positive(parsed.size, 'a Laya runtime size'),
                  sha256: sha256(parsed.sha256, 'a Laya runtime SHA-256'),
                  executable: parsed.executable,
                };
              }),
              (file) => Buffer.from(file.path, 'utf8').toString('hex'),
              'a Laya runtime package file list',
            ),
          ];
        }),
      );
      const url = text(pkg.url, 'a Laya runtime URL');
      if (!url.startsWith('https://registry.npmjs.org/') || /[?#]/.test(url))
        fail('LAYA_ASSET_INVALID', 'a Laya runtime URL is its reviewed registry URL');
      const integrity = text(pkg.integrity, 'a Laya runtime SRI');
      if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity))
        fail('LAYA_ASSET_INVALID', 'a Laya runtime SRI is exact SHA-512');
      return {
        name: text(pkg.name, 'a Laya runtime package name'),
        version: text(pkg.version, 'a Laya runtime package version'),
        url,
        integrity,
        files,
      };
    }),
    (pkg) => pkg.name,
    'the Laya runtime packages',
  );
  return { schemaVersion: 1, packages };
}

function rawByteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sourceText(bytes: Uint8Array, name: string): string {
  const source = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(Buffer.from(bytes))) fail('LAYA_ASSET_INVALID', `${name} is strict UTF-8`);
  return source;
}

function jsonSource(bytes: Uint8Array, name: string): unknown {
  const source = sourceText(bytes, name);
  try {
    return JSON.parse(source);
  } catch {
    return fail('LAYA_ASSET_INVALID', `${name} is strict JSON`);
  }
}

function canonicalManifestSource(value: CanonicalLayaManifest): string {
  const runtime = {
    '@receptron/laya': value.runtime['@receptron/laya'],
    'onnxruntime-node': value.runtime['onnxruntime-node'],
    '@huggingface/tokenizers': value.runtime['@huggingface/tokenizers'],
  };
  const source = `${JSON.stringify(
    {
      manifestVersion: value.manifestVersion,
      manifestId: value.manifestId,
      source: value.source,
      weights: value.weights,
      files: value.files,
      runtime,
      context: value.context,
      promptTemplates: value.promptTemplates,
    },
    null,
    2,
  )}\n`;
  // The template list is written on one line, whichever templates the manifest offers.
  const multilineTemplates = `  "promptTemplates": [\n${value.promptTemplates.map((id) => `    ${JSON.stringify(id)}`).join(',\n')}\n  ]`;
  return source.replace(
    multilineTemplates,
    `  "promptTemplates": [${value.promptTemplates.map((id) => JSON.stringify(id)).join(', ')}]`,
  );
}

function canonicalRuntimeLockSource(
  value: RuntimeLock | { readonly blocked: 'E2_EXTERNAL_REFERENCE_BLOCKED' },
): string {
  if ('blocked' in value) return `${JSON.stringify({ schemaVersion: 1, blocked: value.blocked }, null, 2)}\n`;
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      packages: value.packages.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        url: pkg.url,
        integrity: pkg.integrity,
        files: Object.fromEntries(
          Object.entries(pkg.files)
            .sort(([left], [right]) => rawByteCompare(left, right))
            .map(([platform, files]) => [platform, files]),
        ),
      })),
    },
    null,
    2,
  )}\n`;
}

interface ReviewedDisclosureText {
  readonly runtimeLicences: readonly string[];
  readonly workerMemory: string;
  readonly facts: CanonicalLayaEnablementDisclosures['facts'];
  readonly limitations: CanonicalLayaEnablementDisclosures['limitations'];
}

const REQUIRED_PREVIEW_LIMITATIONS = ['sandboxDeprecation', 'englishAccuracy'] as const;

function disclosureText(value: unknown): ReviewedDisclosureText {
  const candidate = object(value, 'the Laya enablement disclosures');
  exactKeys(
    candidate,
    ['schemaVersion', 'runtimeLicences', 'workerMemory', 'facts', 'limitations'],
    'the Laya enablement disclosures',
  );
  if (candidate.schemaVersion !== 1) fail('LAYA_ASSET_INVALID', 'the Laya enablement disclosures have version 1');
  if (!Array.isArray(candidate.runtimeLicences) || candidate.runtimeLicences.length === 0)
    fail('LAYA_ASSET_INVALID', 'the Laya runtime licences are reviewed');
  const runtimeLicences = candidate.runtimeLicences.map((licence) => text(licence, 'a Laya runtime licence'));
  if (runtimeLicences.some((licence, index) => index > 0 && (runtimeLicences[index - 1] as string) >= licence))
    fail('LAYA_ASSET_INVALID', 'the Laya runtime licences are sorted and duplicate-free');
  const facts = object(candidate.facts, 'the Laya disclosure facts');
  exactKeys(
    facts,
    ['englishCpu', 'macosBoundary', 'linuxUnavailable', 'windowsUnavailable', 'downloadAfterApproval', 'oneAtATime'],
    'the Laya disclosure facts',
  );
  const limitations = object(candidate.limitations, 'the Laya disclosure limitations');
  const reviewed = { limitations: Object.keys(limitations) };
  if (!REQUIRED_PREVIEW_LIMITATIONS.every((fact) => reviewed.limitations.includes(fact)))
    fail('LAYA_ASSET_INVALID', 'the Laya disclosure limitations are complete');
  if (reviewed.limitations.length > REQUIRED_PREVIEW_LIMITATIONS.length)
    fail('LAYA_ASSET_INVALID', 'the Laya disclosure limitations have no unreviewed fields');
  for (const [name, disclosure] of Object.entries(limitations)) text(disclosure, `the ${name} Laya limitation`);
  return {
    runtimeLicences,
    workerMemory: text(candidate.workerMemory, 'the Laya worker memory disclosure'),
    facts: {
      englishCpu: text(facts.englishCpu, 'the English Laya disclosure'),
      macosBoundary: text(facts.macosBoundary, 'the macOS Laya disclosure'),
      linuxUnavailable: text(facts.linuxUnavailable, 'the Linux Laya disclosure'),
      windowsUnavailable: text(facts.windowsUnavailable, 'the Windows Laya disclosure'),
      downloadAfterApproval: text(facts.downloadAfterApproval, 'the Laya download disclosure'),
      oneAtATime: text(facts.oneAtATime, 'the Laya concurrency disclosure'),
    },
    limitations: limitations as CanonicalLayaEnablementDisclosures['limitations'],
  };
}

function canonicalDisclosureSource(value: ReviewedDisclosureText): string {
  const source = `${JSON.stringify(
    {
      schemaVersion: 1,
      runtimeLicences: value.runtimeLicences,
      workerMemory: value.workerMemory,
      facts: value.facts,
      limitations: value.limitations,
    },
    null,
    2,
  )}\n`;
  const multilineRuntimeLicences = `${JSON.stringify(value.runtimeLicences, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? `  "runtimeLicences": ${line}` : `  ${line}`))
    .join('\n')},`;
  return source.replace(multilineRuntimeLicences, `  "runtimeLicences": ${JSON.stringify(value.runtimeLicences)},`);
}

interface ParsedReviewedAssets {
  readonly manifest: CanonicalLayaManifest;
  readonly runtimeLock: RuntimeLock | { readonly blocked: 'E2_EXTERNAL_REFERENCE_BLOCKED' };
  readonly disclosures: ReviewedDisclosureText;
}

function parseReviewedAssets(source: LayaReviewedAssetSource): ParsedReviewedAssets {
  const manifestSource = sourceText(source.manifestBytes, 'the Laya manifest');
  const parsedManifest = manifest(jsonSource(source.manifestBytes, 'the Laya manifest'));
  if (canonicalManifestSource(parsedManifest) !== manifestSource)
    fail('LAYA_ASSET_INVALID', 'the Laya manifest bytes are canonical');
  const runtimeSource = sourceText(source.runtimeLockBytes, 'the Laya runtime lock');
  const parsedRuntimeLock = runtimeLock(jsonSource(source.runtimeLockBytes, 'the Laya runtime lock'));
  if (canonicalRuntimeLockSource(parsedRuntimeLock) !== runtimeSource)
    fail('LAYA_ASSET_INVALID', 'the Laya runtime lock bytes are canonical');
  const disclosuresSource = sourceText(source.disclosuresBytes, 'the Laya enablement disclosures');
  const disclosures = disclosureText(jsonSource(source.disclosuresBytes, 'the Laya enablement disclosures'));
  if (canonicalDisclosureSource(disclosures) !== disclosuresSource)
    fail('LAYA_ASSET_INVALID', 'the Laya enablement disclosure bytes are canonical');
  return { manifest: parsedManifest, runtimeLock: parsedRuntimeLock, disclosures };
}

function selectedPlatform(lock: RuntimeLock, probe: LayaPlatformProbe): CanonicalLayaRuntimeLock['platform'] {
  const id = `${PLATFORM_PREFIX}${probe.architecture}`;
  const files = lock.packages.flatMap((pkg) => (pkg.files[id] ?? []).map((file) => ({ package: pkg.name, ...file })));
  if (files.length === 0) fail('LAYA_ASSET_INVALID', 'the reviewed runtime lock has this macOS architecture');
  return {
    id,
    files,
    digest: sha256Hex(canonicalJson(files)),
  };
}

function completeRuntimeLock(lock: RuntimeLock, probe: LayaPlatformProbe): CanonicalLayaRuntimeLock {
  const platform = selectedPlatform(lock, probe);
  const packages = lock.packages.map(({ name, version, url, integrity }) => ({ name, version, url, integrity }));
  return {
    schemaVersion: 1,
    packages,
    platform,
    digest: sha256Hex(canonicalJson({ schemaVersion: 1, packages, platform })),
  };
}

/** The Task 1 availability probe is separate from Task 7's per-child proof and intentionally content-free. */
export function sandboxExecAvailable(probe: LayaPlatformProbe): boolean {
  if (probe.platform !== 'darwin') return false;
  const options = {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin' },
    shell: false as const,
    stdio: 'ignore' as const,
    timeout: SANDBOX_PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL' as const,
  };
  try {
    const result =
      probe.spawnSync?.(LAYA_SANDBOX_EXECUTABLE, ['-p', LAYA_SANDBOX_PROFILE, SANDBOX_TRIVIAL_PROGRAM], options) ??
      spawnSync(LAYA_SANDBOX_EXECUTABLE, ['-p', LAYA_SANDBOX_PROFILE, SANDBOX_TRIVIAL_PROGRAM], options);
    return result.status === 0 && result.signal === null && result.error === undefined;
  } catch {
    return false;
  }
}

function available(
  assets: ParsedReviewedAssets,
  probe: LayaPlatformProbe,
): LayaJudgeAvailability | LayaJudgeUnavailable {
  const lock = assets.runtimeLock;
  if ('blocked' in lock) return { available: false, code: lock.blocked };
  if (probe.platform !== 'darwin') return { available: false, code: 'LAYA_PLATFORM_UNAVAILABLE' };
  if (!sandboxExecAvailable(probe)) return { available: false, code: 'LAYA_SANDBOX_UNAVAILABLE' };
  try {
    selectedPlatform(lock, probe);
  } catch {
    return { available: false, code: 'LAYA_PLATFORM_UNAVAILABLE' };
  }
  return { available: true };
}

function assertAvailable(assets: ParsedReviewedAssets, probe: LayaPlatformProbe): RuntimeLock {
  const state = available(assets, probe);
  if (!state.available) fail(state.code, 'the reviewed Laya runtime is unavailable before enablement preparation');
  const lock = assets.runtimeLock;
  if ('blocked' in lock) fail(lock.blocked, 'the reviewed Laya runtime lock is blocked');
  return lock;
}

function disclosures(
  reviewedDisclosure: ReviewedDisclosureText,
  runtime: CanonicalLayaRuntimeLock,
  parsedManifest: CanonicalLayaManifest,
): CanonicalLayaEnablementDisclosures {
  const modelBytes = parsedManifest.files.reduce((sum, file) => sum + file.size, 0);
  const runtimeBytes = runtime.platform.files.reduce((sum, file) => sum + file.size, 0);
  const reviewed = {
    facts: [
      reviewedDisclosure.facts.englishCpu,
      reviewedDisclosure.facts.macosBoundary,
      reviewedDisclosure.facts.linuxUnavailable,
      reviewedDisclosure.facts.windowsUnavailable,
      reviewedDisclosure.facts.downloadAfterApproval,
      reviewedDisclosure.facts.oneAtATime,
    ],
  };
  const facts = [
    ...reviewed.facts,
    // Keep the reviewed values as a list until their canonical document fields are assembled below.
  ];
  return {
    modelBytes,
    runtimeBytes,
    runtimeLicences: reviewedDisclosure.runtimeLicences,
    workerMemory: reviewedDisclosure.workerMemory,
    facts: {
      englishCpu: facts[0] as string,
      macosBoundary: facts[1] as string,
      linuxUnavailable: facts[2] as string,
      windowsUnavailable: facts[3] as string,
      downloadAfterApproval: facts[4] as string,
      oneAtATime: facts[5] as string,
    },
    limitations: reviewedDisclosure.limitations,
  };
}

/**
 * Converts the only durable model projection to the closed B3/C DTO.  The input deliberately excludes filesystem
 * state and is revalidated as untrusted database data before crossing the control boundary.
 */
export function layaModelStatusFromRecord(input: {
  readonly record: unknown | null;
  readonly enablement: CanonicalLayaEnablement;
  readonly availability: LayaJudgeAvailability | LayaJudgeUnavailable;
}): LayaModelStatus {
  const totalBytes =
    input.enablement.manifest.files.reduce((sum, file) => sum + file.size, 0) +
    input.enablement.runtimeLock.platform.files.reduce((sum, file) => sum + file.size, 0);
  let record: LayaModelStatusRecord | null = null;
  if (input.record !== null) {
    const candidate = object(input.record, 'the stored Laya model status');
    exactKeys(
      candidate,
      ['manifestId', 'state', 'bytesVerified', 'verifiedAt', 'failureCode', 'updatedAt'],
      'the stored Laya model status',
    );
    record = {
      manifestId: text(candidate.manifestId, 'the stored Laya manifest id'),
      state: modelState(candidate.state),
      bytesVerified: nonNegative(candidate.bytesVerified, 'the stored verified bytes'),
      verifiedAt:
        candidate.verifiedAt === null ? null : nonNegative(candidate.verifiedAt, 'the stored verification time'),
      failureCode: modelFailureCode(candidate.failureCode),
      updatedAt: nonNegative(candidate.updatedAt, 'the stored update time'),
    };
    if (record.manifestId !== input.enablement.manifest.manifestId)
      fail('LAYA_ASSET_INVALID', 'the stored model row does not match the enabled manifest');
    if (record.bytesVerified > totalBytes)
      fail('LAYA_ASSET_INVALID', 'the stored verified bytes exceed the reviewed total');
  }
  if (!input.availability.available) {
    return {
      state: 'unavailable',
      manifestId: input.enablement.manifest.manifestId,
      runtimeLockDigest: input.enablement.runtimeLock.digest,
      bytesVerified: record?.bytesVerified ?? 0,
      totalBytes,
      failureCode: null,
      reason: input.availability.code,
      updatedAt: record?.updatedAt ?? null,
    };
  }
  if (record === null || record.state === 'removed') {
    return {
      state: 'idle',
      manifestId: input.enablement.manifest.manifestId,
      runtimeLockDigest: input.enablement.runtimeLock.digest,
      bytesVerified: record?.bytesVerified ?? 0,
      totalBytes,
      failureCode: null,
      reason: null,
      updatedAt: record?.updatedAt ?? null,
    };
  }
  return {
    state: record.state,
    manifestId: record.manifestId,
    runtimeLockDigest: input.enablement.runtimeLock.digest,
    bytesVerified: record.bytesVerified,
    totalBytes,
    failureCode: record.failureCode,
    reason: null,
    updatedAt: record.updatedAt,
  };
}

/**
 * The concrete E2 replacement for Phase E's opaque slot. Tests may inject only canonical synthetic asset bytes and
 * the sandbox spawn; production supplies the shipped bytes and never accepts a caller path, manifest, lock, template
 * or prebuilt definition.
 */
export function createLayaJudgeKindDefinition(input: {
  readonly assets: LayaReviewedAssetSource;
  readonly platform: LayaPlatformProbe;
}): LayaJudgeKindDefinition {
  const assets = parseReviewedAssets(input.assets);
  const parsedManifest = assets.manifest;
  const status = (): ReturnType<LayaJudgeKindDefinition['availability']> => available(assets, input.platform);
  const modelBytes = parsedManifest.files.reduce((sum, file) => sum + file.size, 0);
  const unavailableStatus = (): LayaModelStatus => {
    const availability = status();
    return {
      state: 'unavailable',
      manifestId: parsedManifest.manifestId,
      runtimeLockDigest: null,
      bytesVerified: 0,
      totalBytes: modelBytes,
      failureCode: null,
      reason: availability.available ? 'E2_EXTERNAL_REFERENCE_BLOCKED' : availability.code,
      updatedAt: null,
    };
  };
  const preview = ({ version }: { readonly version: number }): CanonicalLayaEnablement => {
    if (!Number.isSafeInteger(version) || version < 1)
      fail('LAYA_ENABLEMENT_EXACT', 'a Laya enablement version is positive');
    const lock = assets.runtimeLock;
    if ('blocked' in lock) fail(lock.blocked, 'the reviewed Laya runtime lock is blocked');
    const complete = completeRuntimeLock(lock, input.platform);
    return {
      id: `judge-kind:${LAYA_KIND}`,
      kind: LAYA_KIND,
      version,
      manifest: parsedManifest,
      runtimeLock: complete,
      disclosures: disclosures(assets.disclosures, complete, parsedManifest),
    };
  };
  const prepareEnablement = ({ version }: { readonly version: number }): CanonicalLayaEnablement => {
    assertAvailable(assets, input.platform);
    return preview({ version });
  };
  return {
    kind: LAYA_KIND,
    availability: status,
    prepareEnablement,
    canonicalEnablement(value: unknown): CanonicalLayaEnablement {
      const candidate = object(value, 'the Laya enablement');
      const { manifestPath, modelPath, template, ...reviewed } = candidate;
      if (manifestPath !== undefined || modelPath !== undefined || template !== undefined)
        fail('LAYA_ENABLEMENT_EXACT', 'a Laya enablement cannot select a manifest, path or template');
      const version = positive(candidate.version, 'the Laya enablement version');
      const expected = preview({ version });
      if (canonicalJson(reviewed) !== canonicalJson(expected))
        fail('LAYA_ENABLEMENT_EXACT', 'a Laya enablement must embed exactly the reviewed assets and disclosures');
      return expected;
    },
    preview,
    async onEnabled(
      _enablement: CanonicalLayaEnablement,
      _activation: { readonly id: string },
    ): Promise<LayaModelStatus> {
      // Task 6 installs only after this normal activation has claimed.  Before that manager exists this is an
      // explicit content-free unavailable state, never an alternate installer.
      return unavailableStatus();
    },
    async execute(_request: JudgeExecutionRequest, _reservation: JudgeReservation): Promise<LayaJudgeAnswer> {
      // Task 8 owns the sole coordinator adapter.  Keeping this refusal here prevents a provisional direct worker
      // call from becoming a second execution path.
      return fail('E2_EXTERNAL_REFERENCE_BLOCKED', 'the Laya worker adapter is not installed');
    },
    async onWorkPurged(_scope: Readonly<Record<string, unknown>>): Promise<void> {
      // Task 6 attaches the artifact manager to E's existing purge participant.
    },
    async onDisabled(): Promise<void> {
      // Task 6 attaches the artifact manager to E's existing immediate disable hook.
    },
    status(): LayaModelStatus {
      return unavailableStatus();
    },
    async removeWhenDisabled(): Promise<LayaModelStatus> {
      // Task 6 owns file removal; status/remove remains routed through B3's existing operation functions.
      return unavailableStatus();
    },
  };
}
