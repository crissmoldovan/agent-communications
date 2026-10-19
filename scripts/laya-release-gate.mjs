#!/usr/bin/env node
/**
 * Laya's release rule (E2 Task 10). Every release runs it before the OIDC preflight and before any publish:
 * `.github/workflows/release.yml`'s `laya` job, which the publish job needs, and `scripts/release.mjs` locally.
 *
 * - **A release that ships the fail-closed placeholder lock** publishes with Laya unavailable — and this checks that it
 *   is so rather than assuming it: the shipped lock is exactly the placeholder's canonical bytes, the daemon packs that
 *   file, and the definition built from the shipped assets refuses on every platform with `E2_EXTERNAL_REFERENCE_BLOCKED`.
 * - **A release that ships anything else** must first (a) rebuild the lock from its exact registry origins and SRI with
 *   the owner-only raw-tarball acquirer (`scripts/fetch-laya-release-tarballs.mjs`) and match it byte for byte,
 *   (b) carry the aggregate quality report `packages/events-laya-runtime/gate/<manifestId>.json` that E2 Task 9's
 *   validator accepts with every offered template passing, and (c) carry the content-free real-Mac boundary evidence
 *   `packages/events-laya-runtime/gate/macos-boundary-v1.json` passing — (b) and (c) for every macOS architecture the
 *   lock offers, each with its own evidence (E2-J). Any failure stops the release with nothing published.
 *
 * Either way: the manifest offers exactly `laya-noul-v1` (`laya-choice2-v1` waits for its own task), no Laya or ONNX
 * package is in the daemon's published dependency closure, and the private runtime package is never published.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/laya-release-gate.mjs
 *
 * The rebuild needs `AGENTCOMMS_LAYA_SUPPLY_CHAIN_GATE=1`, which only the release job and the owner's local release
 * set; nothing in `pnpm verify` or a test reaches the registry.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLayaJudgeKindDefinition } from '../packages/events-daemon/src/runtime/laya/contracts.ts';
import { buildLayaRuntimeLock, supplyChainGateAcquirer } from './fetch-laya-release-tarballs.mjs';
import {
  assertDaemonRuntimeBoundary,
  assertPrivateRuntimePackage,
  parseLayaManifest,
  parseRuntimeLock,
} from './laya-runtime-lock.mjs';
import { verifyBoundaryGate } from './verify-laya-boundary-gate.mjs';
import { verifyQualityGate } from './verify-laya-quality-gate.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export const LAYA_ASSETS = Object.freeze({
  manifest: 'packages/events-daemon/laya-manifest.json',
  runtimeLock: 'packages/events-daemon/laya-runtime.json',
  disclosures: 'packages/events-daemon/laya-enablement-disclosures.json',
});
const DAEMON_DIRECTORY = 'packages/events-daemon';
const DAEMON_PACKAGE = `${DAEMON_DIRECTORY}/package.json`;
const RUNTIME_DIRECTORY = 'packages/events-laya-runtime';
const RUNTIME_PACKAGE = `${RUNTIME_DIRECTORY}/package.json`;
const RUNTIME_PACKAGE_NAME = '@agentcomms/events-laya-runtime';
/** The fail-closed placeholder, byte for byte: what a release ships until the owner's gates have passed. */
export const PLACEHOLDER_LOCK = '{\n  "schemaVersion": 1,\n  "blocked": "E2_EXTERNAL_REFERENCE_BLOCKED"\n}\n';
/** The templates this release may offer (E2 Task 9's decision): the choice template waits for a task of its own. */
export const OFFERED_TEMPLATES = Object.freeze(['laya-noul-v1']);
/** The macOS architectures a lock can offer, by the lock's own platform keys. */
const LOCK_PLATFORMS = Object.freeze({ 'darwin-arm64': 'arm64', 'darwin-x64': 'x64' });
/** Every platform the shipped definition is asked about while it ships dormant. */
const DORMANT_PLATFORMS = Object.freeze([
  Object.freeze({ platform: 'darwin', architecture: 'arm64' }),
  Object.freeze({ platform: 'darwin', architecture: 'x64' }),
  Object.freeze({ platform: 'linux', architecture: 'x64' }),
  Object.freeze({ platform: 'win32', architecture: 'x64' }),
]);
/** The runtime's own packages, ONNX Runtime's shared one and the private declaration: never in the daemon's closure. */
const LAYA_PACKAGES = Object.freeze([
  '@huggingface/tokenizers',
  '@receptron/laya',
  'onnxruntime-common',
  'onnxruntime-node',
  RUNTIME_PACKAGE_NAME,
]);
const LAYA_PACKAGE_PATTERN = /onnxruntime|laya/i;

export class LayaReleaseError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'LayaReleaseError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LayaReleaseError(code, message);
}

async function readRootText(root, path) {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch {
    return fail('LAYA_RELEASE_ASSET', `${path} is missing`);
  }
}

// ------------------------------------------------------------------------------------------------ the lockfile closure

/** One section of pnpm's lockfile, as its lines, without the section's own heading. */
function lockfileSection(lockfile, name) {
  const lines = lockfile.split('\n');
  const start = lines.indexOf(`${name}:`);
  if (start === -1) fail('LAYA_RELEASE_AUDIT', `the lockfile has no ${name} section`);
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The keyed blocks of `lines` at exactly `indent` spaces: each key to the lines beneath it. */
function blocks(lines, indent) {
  const result = new Map();
  const prefix = ' '.repeat(indent);
  let current;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (line.startsWith(prefix) && line[indent] !== ' ') {
      const matched = /^(?:'([^']+)'|([^:]+)):(?: (.*))?$/.exec(line.slice(indent));
      if (matched === null) fail('LAYA_RELEASE_AUDIT', 'the lockfile has a line its audit cannot read');
      const key = matched[1] ?? matched[2];
      current = [];
      result.set(key, { value: matched[3], lines: current });
    } else if (current !== undefined && line.startsWith(`${prefix} `)) {
      current.push(line);
    }
  }
  return result;
}

const RUNTIME_SECTIONS = ['dependencies', 'optionalDependencies'];

/**
 * Every package the published daemon brings when installed, read from pnpm's lockfile: its own runtime and optional
 * dependencies, through each workspace package it links, and through every registry package's own. Development
 * dependencies are not published, so they are not followed. An entry the audit cannot resolve refuses, never passes.
 */
export function daemonDependencyClosure(lockfile) {
  const importers = blocks(lockfileSection(lockfile, 'importers'), 2);
  const snapshots = blocks(lockfileSection(lockfile, 'snapshots'), 2);
  const names = new Set();
  const seen = new Set();
  const visitImporter = (path) => {
    if (seen.has(`importer:${path}`)) return;
    seen.add(`importer:${path}`);
    const importer = importers.get(path);
    if (importer === undefined) fail('LAYA_RELEASE_AUDIT', `the lockfile has no importer ${path}`);
    const sections = blocks(importer.lines, 4);
    for (const section of RUNTIME_SECTIONS) {
      for (const [name, entry] of blocks(sections.get(section)?.lines ?? [], 6)) {
        names.add(name);
        const version = blocks(entry.lines, 8).get('version')?.value;
        if (version === undefined) fail('LAYA_RELEASE_AUDIT', `${path} has a dependency with no resolved version`);
        if (version.startsWith('link:')) {
          const target = join(path, version.slice('link:'.length)).split('\\').join('/');
          visitImporter(target);
        } else visitSnapshot(name, version);
      }
    }
  };
  const visitSnapshot = (name, version) => {
    // An npm alias (`string-width-cjs: string-width@4.2.3`) installs the package it names: both names are audited.
    const alias = /^(@?[^@()\s]+)@([0-9][^\s]*)$/.exec(version);
    if (alias === null && !/^[0-9]/.test(version))
      fail('LAYA_RELEASE_AUDIT', `${name} resolves to ${version}, which the audit cannot follow`);
    if (alias !== null) names.add(alias[1]);
    const key = alias === null ? `${name}@${version}` : `${alias[1]}@${alias[2]}`;
    if (seen.has(key)) return;
    seen.add(key);
    const snapshot = snapshots.get(key);
    if (snapshot === undefined) fail('LAYA_RELEASE_AUDIT', `the lockfile has no snapshot ${key}`);
    if (snapshot.value === '{}') return;
    const sections = blocks(snapshot.lines, 4);
    for (const section of RUNTIME_SECTIONS) {
      for (const [dependency, entry] of blocks(sections.get(section)?.lines ?? [], 6)) {
        names.add(dependency);
        if (entry.value === undefined) fail('LAYA_RELEASE_AUDIT', `${key} has a dependency with no version`);
        visitSnapshot(dependency, entry.value);
      }
    }
  };
  visitImporter(DAEMON_DIRECTORY);
  return [...names].sort();
}

/**
 * The package audit, whatever the lock: the daemon depends on no Laya or ONNX package, directly or through anything
 * it installs, and still packs the three reviewed assets; the private runtime declaration stays private and is in
 * neither release list.
 */
export async function auditLayaPackages({ root, publishable, packages }) {
  const daemon = JSON.parse(await readRootText(root, DAEMON_PACKAGE));
  try {
    assertDaemonRuntimeBoundary(daemon);
  } catch {
    fail('LAYA_RELEASE_AUDIT', 'the daemon declares a Laya runtime dependency, or does not pack its reviewed assets');
  }
  const declared = Object.keys({
    ...daemon.dependencies,
    ...daemon.optionalDependencies,
    ...daemon.peerDependencies,
    ...Object.fromEntries((daemon.bundledDependencies ?? []).map((name) => [name, true])),
  });
  const closure = [...declared, ...daemonDependencyClosure(await readRootText(root, 'pnpm-lock.yaml'))];
  const leaked = [...new Set(closure)].filter(
    (name) => LAYA_PACKAGES.includes(name) || LAYA_PACKAGE_PATTERN.test(name),
  );
  if (leaked.length > 0) fail('LAYA_RELEASE_AUDIT', `the published daemon would install ${leaked.sort().join(', ')}`);
  try {
    assertPrivateRuntimePackage(JSON.parse(await readRootText(root, RUNTIME_PACKAGE)));
  } catch {
    fail('LAYA_RELEASE_AUDIT', 'the Laya runtime declaration is no longer private and dependency-only');
  }
  const directory = RUNTIME_DIRECTORY.slice('packages/'.length);
  if (publishable.includes(directory) || packages.includes(directory))
    fail('LAYA_RELEASE_AUDIT', 'the private Laya runtime declaration is in a release list');
  return { closure: closure.length };
}

// ------------------------------------------------------------------------------------------------ the lock

/** The lock builder's input, read back from a lock: its packages and, per platform, each package's listed paths. */
export function runtimeLockBuildInput(lockText) {
  const lock = parseRuntimeLock(lockText);
  const platforms = Object.fromEntries(
    Object.keys(LOCK_PLATFORMS).map((platform) => [
      platform,
      Object.fromEntries(lock.packages.map((pkg) => [pkg.name, pkg.files[platform].map((file) => file.path)])),
    ]),
  );
  return {
    packages: lock.packages.map(({ name, version, url, integrity }) => ({ name, version, url, integrity })),
    platforms,
  };
}

/**
 * The owner-only rebuild: every tarball from its exact registry URL, its SRI checked over the raw bytes before the
 * strict extractor reads it, the closure bound to the root lockfile and its reviewed record (E2 Task 2's builder).
 * Returns the rebuilt lock text; the gate compares it with what ships.
 */
export async function rebuildRuntimeLock(lockText, { acquire }) {
  return buildLayaRuntimeLock(runtimeLockBuildInput(lockText), acquire);
}

/** Which macOS architectures a lock offers Laya on: those whose platform file list it carries. */
export function lockArchitectures(lockText) {
  const lock = parseRuntimeLock(lockText);
  return Object.entries(LOCK_PLATFORMS)
    .filter(([platform]) => lock.packages.some((pkg) => (pkg.files[platform] ?? []).length > 0))
    .map(([, architecture]) => architecture);
}

function assetBytes(texts) {
  return {
    manifestBytes: Buffer.from(texts.manifest, 'utf8'),
    runtimeLockBytes: Buffer.from(texts.runtimeLock, 'utf8'),
    disclosuresBytes: Buffer.from(texts.disclosures, 'utf8'),
  };
}

/** The shipped definition's own answer on a platform, through the daemon's production parser. */
function shippedAvailability(assets, platform) {
  try {
    return createLayaJudgeKindDefinition({ assets, platform }).availability();
  } catch {
    return fail('LAYA_RELEASE_ASSET', 'the shipped Laya assets do not parse');
  }
}

async function productionPublishLists() {
  const { PACKAGES, PUBLISHABLE } = await import('./packages.mjs');
  return { publishable: [...PUBLISHABLE], packages: [...PACKAGES] };
}

/**
 * The release rule. Returns `{ mode: 'dormant' }` when the placeholder ships, or `{ mode: 'offered', architectures }`
 * when every gate's evidence is there; throws a `LayaReleaseError` otherwise. Every dependency but the root is the
 * production one unless a test passes its own.
 */
export async function layaReleaseGate({
  root = repositoryRoot,
  env = process.env,
  publishLists = productionPublishLists,
  availability = shippedAvailability,
  rebuildLock = (lockText) => rebuildRuntimeLock(lockText, { acquire: supplyChainGateAcquirer(env) }),
  verifyQuality = verifyQualityGate,
  verifyBoundary = verifyBoundaryGate,
} = {}) {
  const texts = {
    manifest: await readRootText(root, LAYA_ASSETS.manifest),
    runtimeLock: await readRootText(root, LAYA_ASSETS.runtimeLock),
    disclosures: await readRootText(root, LAYA_ASSETS.disclosures),
  };
  let manifest;
  try {
    manifest = parseLayaManifest(texts.manifest);
  } catch {
    fail('LAYA_RELEASE_ASSET', 'the shipped manifest is not the reviewed one');
  }
  if (
    manifest.promptTemplates.length !== OFFERED_TEMPLATES.length ||
    manifest.promptTemplates.some((id, index) => id !== OFFERED_TEMPLATES[index])
  )
    fail('LAYA_RELEASE_TEMPLATES', `this release offers exactly ${OFFERED_TEMPLATES.join(', ')}`);
  await auditLayaPackages({ root, ...(await publishLists()) });
  const assets = assetBytes(texts);

  if (texts.runtimeLock === PLACEHOLDER_LOCK) {
    // Dormant, and checked to be: every platform's answer is the placeholder's own refusal.
    for (const platform of DORMANT_PLATFORMS) {
      const answer = availability(assets, platform);
      if (answer.available || answer.code !== 'E2_EXTERNAL_REFERENCE_BLOCKED')
        fail(
          'LAYA_RELEASE_NOT_DORMANT',
          `the placeholder ships, yet ${platform.platform} ${platform.architecture} is not refused`,
        );
    }
    return { mode: 'dormant' };
  }

  // Anything but the placeholder is the real lock, and needs every gate.
  let architectures;
  try {
    architectures = lockArchitectures(texts.runtimeLock);
  } catch {
    fail('LAYA_RELEASE_LOCK', 'the shipped runtime lock is neither the placeholder nor a reviewed lock');
  }
  if (architectures.length === 0) fail('LAYA_RELEASE_LOCK', 'the shipped runtime lock offers no macOS architecture');
  try {
    verifyQuality({ root, architectures });
  } catch (error) {
    fail('LAYA_RELEASE_QUALITY', error instanceof Error ? error.message : String(error));
  }
  try {
    verifyBoundary({ root, architectures });
  } catch (error) {
    fail('LAYA_RELEASE_BOUNDARY', error instanceof Error ? error.message : String(error));
  }
  let rebuilt;
  try {
    rebuilt = await rebuildLock(texts.runtimeLock);
  } catch (error) {
    fail('LAYA_RELEASE_LOCK', `the lock could not be rebuilt from its exact origins (${error?.code ?? 'unknown'})`);
  }
  if (rebuilt !== texts.runtimeLock)
    fail('LAYA_RELEASE_LOCK_DRIFT', 'the lock rebuilt from its registry tarballs is not the lock that ships');
  return { mode: 'offered', architectures };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await layaReleaseGate();
    process.stdout.write(
      result.mode === 'dormant'
        ? 'Laya release gate: the placeholder lock ships, so Laya stays unavailable on every platform\n'
        : `Laya release gate: the rebuilt lock, quality and boundary evidence all pass on ${result.architectures.join(', ')}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
