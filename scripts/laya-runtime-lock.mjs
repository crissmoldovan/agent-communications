#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspectPackageArchive } from '../packages/events-daemon/src/runtime/laya/tar.ts';
import { LAYA_TEMPLATE_IDS } from '../packages/events-daemon/src/runtime/laya/templates.ts';

const RUNTIME_ROOTS = Object.freeze({
  '@huggingface/tokenizers': '0.2.0',
  '@receptron/laya': '0.1.2',
  'onnxruntime-node': '1.30.0',
});
const PLATFORMS = Object.freeze(['darwin-arm64', 'darwin-x64']);
const ASCII_SHA256 = /^[a-f0-9]{64}$/;
const SRI = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const PRIVATE_RUNTIME_IMPORTER = 'packages/events-laya-runtime';
const CLOSURE_EVIDENCE = new URL('../docs/superpowers/evidence/2026-10-10-e2-external-sources.md', import.meta.url);
const CLOSURE_EVIDENCE_SHA256 = '5e23d92819feccb28ab2be114fa0a26613ec61d6dc5373c5d462a560f23bd181';
const ROOT_LOCKFILE = new URL('../pnpm-lock.yaml', import.meta.url);
const NPM_NAME_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/;

export class RuntimeLockError extends Error {
  constructor(code) {
    super(`Laya runtime lock refused: ${code}`);
    this.name = 'RuntimeLockError';
    this.code = code;
  }
}

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeLockError(code);
  return value;
}

function string(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new RuntimeLockError(code);
  return value;
}

function safeRelativePath(value, code) {
  const path = string(value, code);
  if (
    !path.isWellFormed() ||
    path !== path.normalize('NFC') ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new RuntimeLockError(code);
  }
  return path;
}

function assertNpmPackageName(value) {
  const name = string(value, 'RUNTIME_ORIGIN');
  if (!name.isWellFormed() || name.length > 214) throw new RuntimeLockError('RUNTIME_ORIGIN');
  const segments = name.startsWith('@') ? name.slice(1).split('/') : [name];
  if ((name.startsWith('@') && segments.length !== 2) || (!name.startsWith('@') && segments.length !== 1)) {
    throw new RuntimeLockError('RUNTIME_ORIGIN');
  }
  if (segments.some((segment) => segment === '.' || segment === '..' || !NPM_NAME_SEGMENT.test(segment))) {
    throw new RuntimeLockError('RUNTIME_ORIGIN');
  }
  return name;
}

export function assertCanonicalSRI(value, code = 'RUNTIME_SRI') {
  const integrity = string(value, code);
  const matched = SRI.exec(integrity);
  if (matched === null || matched[1] === undefined) throw new RuntimeLockError(code);
  const payload = matched[1];
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== payload) throw new RuntimeLockError(code);
  return integrity;
}

function exactKeys(value, keys, code) {
  const record = object(value, code);
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new RuntimeLockError(code);
  }
  return record;
}

function rawByteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sorted(values) {
  return [...values].sort(rawByteCompare);
}

function assertStrictOrder(values, code) {
  if (values.some((value, index) => index > 0 && rawByteCompare(values[index - 1], value) >= 0)) {
    throw new RuntimeLockError(code);
  }
}

export function assertExactRegistryTarball(name, version, rawUrl) {
  const packageName = assertNpmPackageName(name);
  const packageVersion = string(version, 'RUNTIME_ORIGIN');
  const unscoped = packageName.startsWith('@') ? packageName.slice(packageName.indexOf('/') + 1) : packageName;
  const expected = `https://registry.npmjs.org/${packageName}/-/${unscoped}-${packageVersion}.tgz`;
  let parsed;
  try {
    parsed = new URL(expected);
  } catch {
    throw new RuntimeLockError('RUNTIME_ORIGIN');
  }
  if (string(rawUrl, 'RUNTIME_ORIGIN') !== expected || parsed.href !== expected) {
    throw new RuntimeLockError('RUNTIME_ORIGIN');
  }
  return expected;
}

function lockfileSection(text, name) {
  const lines = string(text, 'RUNTIME_LOCKFILE').split(/\r?\n/);
  const start = lines.indexOf(`${name}:`);
  if (start === -1) throw new RuntimeLockError('RUNTIME_LOCKFILE');
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function yamlKey(text) {
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

function yamlBlocks(lines, indent) {
  const entries = new Map();
  const prefix = ' '.repeat(indent);
  const isAtIndent = (line) => line.startsWith(prefix) && !line.startsWith(`${prefix} `);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!isAtIndent(line)) continue;
    const matched = /^(.+):$/.exec(line.slice(indent));
    if (matched === null) continue;
    const key = yamlKey(matched[1]);
    if (entries.has(key)) throw new RuntimeLockError('RUNTIME_LOCKFILE');
    let end = index + 1;
    while (end < lines.length && !isAtIndent(lines[end] ?? '') && !/^\S/.test(lines[end] ?? '')) end += 1;
    entries.set(key, lines.slice(index + 1, end));
    index = end - 1;
  }
  return entries;
}

function yamlMappings(lines, indent) {
  const entries = new Map();
  const prefix = ' '.repeat(indent);
  for (const line of lines) {
    if (!line.startsWith(prefix) || line.startsWith(`${prefix} `)) continue;
    const matched = /^(.+): (.+)$/.exec(line.slice(indent));
    if (matched === null || matched[1] === undefined || matched[2] === undefined) continue;
    const key = yamlKey(matched[1]);
    if (entries.has(key)) throw new RuntimeLockError('RUNTIME_LOCKFILE');
    entries.set(key, yamlKey(matched[2]));
  }
  return entries;
}

function yamlScalar(lines, indent, field) {
  const prefix = `${' '.repeat(indent)}${field}: `;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new RuntimeLockError('RUNTIME_LOCKFILE');
  const value = line.slice(prefix.length);
  if (value.length === 0 || value.startsWith('#')) throw new RuntimeLockError('RUNTIME_LOCKFILE');
  return yamlKey(value);
}

/**
 * pnpm writes a resolved version followed by any number of peer suffixes, and nests them when a peer has peers of its
 * own: `1.9.0(@types/react@19.3.0)(react-dom@19.3.1(react@19.3.1))`. Returns the version alone; anything but balanced,
 * non-empty groups after it is refused.
 */
function withoutPeerSuffixes(value) {
  const open = value.indexOf('(');
  if (open === -1) return value;
  let depth = 0;
  let previous = '';
  for (const character of value.slice(open)) {
    if (character === '(') depth += 1;
    else if (character === ')') {
      if (previous === '(' || depth === 0) throw new RuntimeLockError('RUNTIME_LOCKFILE');
      depth -= 1;
    } else if (depth === 0) throw new RuntimeLockError('RUNTIME_LOCKFILE');
    previous = character;
  }
  if (depth !== 0) throw new RuntimeLockError('RUNTIME_LOCKFILE');
  return value.slice(0, open);
}

function packageReference(value) {
  const matched = /^((?:@[^/]+\/)?[^@]+)@([^()]+)$/.exec(withoutPeerSuffixes(value));
  if (matched === null || matched[1] === undefined || matched[2] === undefined) {
    throw new RuntimeLockError('RUNTIME_LOCKFILE');
  }
  return { name: matched[1], version: matched[2] };
}

function lockfileDependencies(lines) {
  const dependencies = new Map();
  for (const kind of ['dependencies', 'optionalDependencies']) {
    const kindLines = yamlBlocks(lines, 4).get(kind);
    if (kindLines === undefined) continue;
    for (const [name, version] of yamlMappings(kindLines, 6)) {
      if (dependencies.has(name)) throw new RuntimeLockError('RUNTIME_LOCKFILE');
      dependencies.set(name, withoutPeerSuffixes(version));
    }
  }
  return dependencies;
}

function evidenceValue(section, field) {
  const quote = String.fromCharCode(96);
  const matched = new RegExp(`^- ${field}: ${quote}([^${quote}]*)${quote}$`, 'm').exec(section);
  if (matched === null || matched[1] === undefined) throw new RuntimeLockError('RUNTIME_EVIDENCE');
  return matched[1];
}

function closureEvidencePackage(value) {
  const boundary = value.lastIndexOf('@');
  if (boundary <= 0 || boundary === value.length - 1) throw new RuntimeLockError('RUNTIME_EVIDENCE');
  return { name: value.slice(0, boundary), version: value.slice(boundary + 1) };
}

function closureEvidenceScripts(value) {
  if (value === 'none') return {};
  if (!value.startsWith('`') || !value.endsWith('`')) throw new RuntimeLockError('RUNTIME_EVIDENCE');
  const matched = /^postinstall: (.+)$/.exec(value.slice(1, -1));
  if (matched === null || matched[1] === undefined) throw new RuntimeLockError('RUNTIME_EVIDENCE');
  return { postinstall: matched[1] };
}

function reviewedRuntimeClosure() {
  const source = readFileSync(CLOSURE_EVIDENCE, 'utf8');
  const start = source.indexOf('### npm-laya-runtime-closure\n');
  const end = source.indexOf('\n## ', start);
  if (start === -1 || end === -1) throw new RuntimeLockError('RUNTIME_EVIDENCE');
  const section = source.slice(start, end);
  if (
    evidenceValue(section, 'id') !== 'npm-laya-runtime-closure' ||
    evidenceValue(section, 'url') !== 'https://registry.npmjs.org/' ||
    evidenceValue(section, 'immutable') !== CLOSURE_EVIDENCE_SHA256
  ) {
    throw new RuntimeLockError('RUNTIME_EVIDENCE');
  }
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  if (rows.length !== 19 || rows.some((cells) => cells.length !== 5)) throw new RuntimeLockError('RUNTIME_EVIDENCE');
  const canonicalRows = rows
    .map((cells) => {
      const [packageReference, licence, tarball, integrity, installScripts] = cells;
      if (
        packageReference === undefined ||
        licence === undefined ||
        tarball === undefined ||
        integrity === undefined ||
        installScripts === undefined ||
        !packageReference.startsWith('`') ||
        !packageReference.endsWith('`') ||
        !tarball.startsWith('`') ||
        !tarball.endsWith('`') ||
        !integrity.startsWith('`') ||
        !integrity.endsWith('`')
      ) {
        throw new RuntimeLockError('RUNTIME_EVIDENCE');
      }
      const packageName = packageReference.slice(1, -1);
      return {
        installScripts: closureEvidenceScripts(installScripts),
        integrity: integrity.slice(1, -1),
        licence,
        package: packageName,
        tarball: tarball.slice(1, -1),
      };
    })
    .sort((left, right) => rawByteCompare(left.package, right.package));
  if (
    createHash('sha256').update(JSON.stringify(canonicalRows)).digest('hex') !== CLOSURE_EVIDENCE_SHA256 ||
    canonicalRows.some((entry, index) => index > 0 && entry.package === canonicalRows[index - 1]?.package)
  ) {
    throw new RuntimeLockError('RUNTIME_EVIDENCE');
  }
  const evidence = new Map();
  for (const row of canonicalRows) {
    const { name, version } = closureEvidencePackage(row.package);
    const key = `${name}@${version}`;
    if (evidence.has(key)) {
      throw new RuntimeLockError('RUNTIME_EVIDENCE');
    }
    assertCanonicalSRI(row.integrity, 'RUNTIME_EVIDENCE');
    if (row.tarball !== assertExactRegistryTarball(name, version, row.tarball)) {
      throw new RuntimeLockError('RUNTIME_EVIDENCE');
    }
    evidence.set(key, { name, version, url: row.tarball, integrity: row.integrity });
  }
  return evidence;
}

function assertReviewedRuntimeClosure(closure) {
  const evidence = reviewedRuntimeClosure();
  if (closure.length !== evidence.size) throw new RuntimeLockError('RUNTIME_EVIDENCE');
  for (const entry of closure) {
    const reviewed = evidence.get(`${entry.name}@${entry.version}`);
    if (reviewed === undefined || reviewed.url !== entry.url || reviewed.integrity !== entry.integrity) {
      throw new RuntimeLockError('RUNTIME_EVIDENCE');
    }
  }
}

/**
 * Resolves the private runtime importer's complete package closure directly from
 * pnpm's lockfile. It deliberately understands only pnpm lockfile v9's pinned
 * scalar forms; an unsupported form fails closed instead of guessing a package.
 */
export function readPrivateRuntimeClosure(lockfile) {
  const importers = yamlBlocks(lockfileSection(lockfile, 'importers'), 2);
  const importer = importers.get(PRIVATE_RUNTIME_IMPORTER);
  if (importer === undefined) throw new RuntimeLockError('RUNTIME_LOCKFILE');
  const directBlock = yamlBlocks(importer, 4).get('dependencies');
  if (directBlock === undefined) throw new RuntimeLockError('RUNTIME_LOCKFILE');
  const direct = new Map();
  for (const [name, value] of yamlBlocks(directBlock, 6)) {
    if (direct.has(name)) throw new RuntimeLockError('RUNTIME_LOCKFILE');
    direct.set(name, yamlScalar(value, 8, 'version'));
  }
  if (
    direct.size !== Object.keys(RUNTIME_ROOTS).length ||
    Object.entries(RUNTIME_ROOTS).some(([name, version]) => direct.get(name) !== version)
  ) {
    throw new RuntimeLockError('RUNTIME_LOCKFILE');
  }

  const packageMetadata = new Map();
  for (const [reference, value] of yamlBlocks(lockfileSection(lockfile, 'packages'), 2)) {
    const { name, version } = packageReference(reference);
    const integrity = /^ {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}$/.exec(value[0] ?? '')?.[1];
    if (integrity === undefined || packageMetadata.has(`${name}@${version}`)) continue;
    packageMetadata.set(`${name}@${version}`, { name, version, integrity });
  }

  const snapshots = new Map();
  for (const [reference, value] of yamlBlocks(lockfileSection(lockfile, 'snapshots'), 2)) {
    const { name, version } = packageReference(reference);
    const key = `${name}@${version}`;
    if (!snapshots.has(key)) snapshots.set(key, lockfileDependencies(value));
  }

  const resolved = new Map();
  const visit = (name, version) => {
    const key = `${name}@${version}`;
    if (resolved.has(key)) return;
    const metadata = packageMetadata.get(key);
    if (metadata === undefined) throw new RuntimeLockError('RUNTIME_LOCKFILE');
    assertCanonicalSRI(metadata.integrity, 'RUNTIME_LOCKFILE');
    const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
    const url = `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`;
    assertExactRegistryTarball(name, version, url);
    resolved.set(key, { name, version, url, integrity: metadata.integrity });
    for (const [dependencyName, dependencyVersion] of snapshots.get(key) ?? []) {
      visit(dependencyName, dependencyVersion);
    }
  };
  for (const [name, version] of direct) visit(name, version);
  const closure = sorted([...resolved.values()].map((entry) => `${entry.name}@${entry.version}`)).map((key) =>
    resolved.get(key),
  );
  assertReviewedRuntimeClosure(closure);
  return closure;
}

export function assertSRI(bytes, integrity) {
  const canonicalIntegrity = assertCanonicalSRI(integrity);
  const expected = Buffer.from(canonicalIntegrity.slice('sha512-'.length), 'base64');
  const actual = createHash('sha512').update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new RuntimeLockError('RUNTIME_SRI');
}

function fileRecord(value) {
  const record = exactKeys(value, ['path', 'size', 'sha256', 'executable'], 'RUNTIME_LOCK_UNKNOWN');
  const path = safeRelativePath(record.path, 'RUNTIME_LOCK_FIELD');
  const size = record.size;
  const sha256 = string(record.sha256, 'RUNTIME_LOCK_FIELD');
  if (!Number.isSafeInteger(size) || size < 0 || !ASCII_SHA256.test(sha256) || typeof record.executable !== 'boolean') {
    throw new RuntimeLockError('RUNTIME_LOCK_FIELD');
  }
  return { path, size, sha256, executable: record.executable };
}

function packageRecord(value) {
  const record = exactKeys(value, ['name', 'version', 'url', 'integrity', 'files'], 'RUNTIME_LOCK_UNKNOWN');
  const name = string(record.name, 'RUNTIME_LOCK_FIELD');
  const version = string(record.version, 'RUNTIME_LOCK_FIELD');
  const url = string(record.url, 'RUNTIME_LOCK_FIELD');
  const integrity = string(record.integrity, 'RUNTIME_LOCK_FIELD');
  assertExactRegistryTarball(name, version, url);
  assertCanonicalSRI(integrity);
  const files = exactKeys(record.files, PLATFORMS, 'RUNTIME_LOCK_UNKNOWN');
  const platformFiles = {};
  for (const platform of PLATFORMS) {
    if (!Array.isArray(files[platform])) throw new RuntimeLockError('RUNTIME_LOCK_FIELD');
    const entries = files[platform].map(fileRecord);
    assertStrictOrder(
      entries.map((entry) => entry.path),
      'RUNTIME_LOCK_ORDER',
    );
    platformFiles[platform] = entries;
  }
  return { name, version, url, integrity, files: platformFiles };
}

function runtimeLockRecord(value) {
  const record = exactKeys(value, ['schemaVersion', 'packages'], 'RUNTIME_LOCK_UNKNOWN');
  if (record.schemaVersion !== 1 || !Array.isArray(record.packages) || record.packages.length === 0) {
    throw new RuntimeLockError('RUNTIME_LOCK_FIELD');
  }
  const packages = record.packages.map(packageRecord);
  assertStrictOrder(
    packages.map((entry) => `${entry.name}@${entry.version}`),
    'RUNTIME_LOCK_ORDER',
  );
  return { schemaVersion: 1, packages };
}

class JsonReader {
  #text;
  #index = 0;

  constructor(text) {
    this.#text = text;
  }

  read() {
    const value = this.#value();
    this.#space();
    if (this.#index !== this.#text.length) throw new RuntimeLockError('RUNTIME_LOCK_JSON');
    return value;
  }

  #space() {
    while (/\s/.test(this.#text[this.#index] ?? '')) this.#index += 1;
  }

  #value() {
    this.#space();
    const character = this.#text[this.#index];
    if (character === '{') return this.#object();
    if (character === '[') return this.#array();
    if (character === '"') return this.#string();
    if (this.#text.startsWith('true', this.#index)) return this.#literal('true', true);
    if (this.#text.startsWith('false', this.#index)) return this.#literal('false', false);
    if (this.#text.startsWith('null', this.#index)) return this.#literal('null', null);
    const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.#text.slice(this.#index));
    if (match === null) throw new RuntimeLockError('RUNTIME_LOCK_JSON');
    this.#index += match[0].length;
    return Number(match[0]);
  }

  #literal(text, value) {
    this.#index += text.length;
    return value;
  }

  #string() {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') {
        try {
          return JSON.parse(this.#text.slice(start, this.#index));
        } catch {
          throw new RuntimeLockError('RUNTIME_LOCK_JSON');
        }
      }
      if (character < ' ') throw new RuntimeLockError('RUNTIME_LOCK_JSON');
    }
    throw new RuntimeLockError('RUNTIME_LOCK_JSON');
  }

  #array() {
    this.#index += 1;
    const values = [];
    this.#space();
    if (this.#text[this.#index] === ']') {
      this.#index += 1;
      return values;
    }
    while (true) {
      values.push(this.#value());
      this.#space();
      const next = this.#text[this.#index++];
      if (next === ']') return values;
      if (next !== ',') throw new RuntimeLockError('RUNTIME_LOCK_JSON');
    }
  }

  #object() {
    this.#index += 1;
    const value = {};
    const keys = new Set();
    this.#space();
    if (this.#text[this.#index] === '}') {
      this.#index += 1;
      return value;
    }
    while (true) {
      this.#space();
      if (this.#text[this.#index] !== '"') throw new RuntimeLockError('RUNTIME_LOCK_JSON');
      const key = this.#string();
      if (keys.has(key)) throw new RuntimeLockError('RUNTIME_LOCK_DUPLICATE');
      keys.add(key);
      this.#space();
      if (this.#text[this.#index++] !== ':') throw new RuntimeLockError('RUNTIME_LOCK_JSON');
      value[key] = this.#value();
      this.#space();
      const next = this.#text[this.#index++];
      if (next === '}') return value;
      if (next !== ',') throw new RuntimeLockError('RUNTIME_LOCK_JSON');
    }
  }
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalLayaManifest(value) {
  const source = canonical(value);
  // The template list is written on one line, whichever of the worker's templates the manifest offers.
  const multilineTemplates = `  "promptTemplates": [\n${value.promptTemplates.map((id) => `    ${JSON.stringify(id)}`).join(',\n')}\n  ]`;
  const compactTemplates = `  "promptTemplates": [${value.promptTemplates.map((id) => JSON.stringify(id)).join(', ')}]`;
  if (!source.includes(multilineTemplates)) throw new RuntimeLockError('LAYA_MANIFEST');
  return source.replace(multilineTemplates, compactTemplates);
}

export function parseRuntimeLock(text) {
  const source = string(text, 'RUNTIME_LOCK_JSON');
  const lock = runtimeLockRecord(new JsonReader(source).read());
  if (canonical(lock) !== source) throw new RuntimeLockError('RUNTIME_LOCK_ORDER');
  return lock;
}

function inputPackage(value) {
  const record = exactKeys(value, ['name', 'version', 'url', 'integrity'], 'RUNTIME_LOCK_INPUT');
  const name = string(record.name, 'RUNTIME_LOCK_INPUT');
  const version = string(record.version, 'RUNTIME_LOCK_INPUT');
  const url = string(record.url, 'RUNTIME_LOCK_INPUT');
  const integrity = string(record.integrity, 'RUNTIME_LOCK_INPUT');
  assertExactRegistryTarball(name, version, url);
  assertCanonicalSRI(integrity);
  return { name, version, url, integrity };
}

function selectedPaths(platforms, platform, name) {
  const platformRecord = object(platforms[platform], 'RUNTIME_LOCK_INPUT');
  const value = platformRecord[name];
  if (!Array.isArray(value)) throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  const paths = value.map((path) => safeRelativePath(path, 'RUNTIME_LOCK_INPUT'));
  if (new Set(paths).size !== paths.length) throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  return paths;
}

function lockBuildInput(input) {
  const record = exactKeys(input, ['packages', 'platforms'], 'RUNTIME_LOCK_INPUT');
  if (!Array.isArray(record.packages)) throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  return record;
}

function assertInputClosureMatches(packages, closure) {
  if (packages.length !== closure.length) throw new RuntimeLockError('RUNTIME_EVIDENCE');
  const supplied = new Map();
  for (const entry of packages) {
    const key = `${entry.name}@${entry.version}`;
    if (supplied.has(key)) throw new RuntimeLockError('RUNTIME_EVIDENCE');
    supplied.set(key, entry);
  }
  for (const entry of closure) {
    const suppliedEntry = supplied.get(`${entry.name}@${entry.version}`);
    if (suppliedEntry === undefined || suppliedEntry.url !== entry.url || suppliedEntry.integrity !== entry.integrity) {
      throw new RuntimeLockError('RUNTIME_EVIDENCE');
    }
  }
}

/** Builds canonical lock bytes only from archives supplied by an already-bound entry point. */
async function buildArchiveLock(input, acquireTarball) {
  const record = lockBuildInput(input);
  if (typeof acquireTarball !== 'function') throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  for (const platform of PLATFORMS) {
    const platformRecord = object(record.platforms[platform], 'RUNTIME_LOCK_INPUT');
    const names = record.packages.map((entry) =>
      string(object(entry, 'RUNTIME_LOCK_INPUT').name, 'RUNTIME_LOCK_INPUT'),
    );
    if (
      Object.keys(platformRecord).length !== names.length ||
      names.some((name) => !Object.hasOwn(platformRecord, name))
    ) {
      throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
    }
  }
  const packages = await Promise.all(
    record.packages.map(async (raw) => {
      const metadata = inputPackage(raw);
      const bytes = await acquireTarball(metadata);
      if (!Buffer.isBuffer(bytes)) throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
      assertSRI(bytes, metadata.integrity);
      const inspected = await inspectPackageArchive(
        (async function* () {
          yield bytes;
        })(),
      );
      const byPath = new Map(inspected.map((entry) => [entry.path, entry]));
      const files = {};
      for (const platform of PLATFORMS) {
        const selected = selectedPaths(record.platforms, platform, metadata.name);
        const entries = selected.map((path) => {
          const found = byPath.get(path);
          if (found === undefined) throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
          return found;
        });
        files[platform] = sorted(entries.map((entry) => entry.path)).map((path) => byPath.get(path));
      }
      return { ...metadata, files };
    }),
  );
  const lock = runtimeLockRecord({
    schemaVersion: 1,
    packages: packages
      .map(({ name, version, url, integrity, files }) => ({ name, version, url, integrity, files }))
      .sort((left, right) => rawByteCompare(`${left.name}@${left.version}`, `${right.name}@${right.version}`)),
  });
  return canonical(lock);
}

/**
 * The release builder is bound to the root private-importer closure and its
 * reviewed evidence before it can ask the caller for a single tarball byte.
 */
export async function buildRuntimeLock(input, acquireTarball) {
  const record = lockBuildInput(input);
  const suppliedPackages = record.packages.map(inputPackage);
  const closure = readPrivateRuntimeClosure(await readFile(ROOT_LOCKFILE, 'utf8'));
  assertInputClosureMatches(suppliedPackages, closure);
  return buildArchiveLock({ packages: closure, platforms: record.platforms }, acquireTarball);
}

/** Fixture-only builder: accepts in-memory fixture bytes and has no acquisition callback. */
export async function buildFixtureRuntimeLock(input, archives) {
  if (!(archives instanceof Map)) throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  return buildArchiveLock(input, async (metadata) => {
    const bytes = archives.get(`${metadata.name}@${metadata.version}`);
    if (!Buffer.isBuffer(bytes)) throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
    return bytes;
  });
}

export function assertPrivateRuntimePackage(manifest) {
  const record = object(manifest, 'RUNTIME_PACKAGE');
  if (record.name !== '@agentcomms/events-laya-runtime' || record.private !== true)
    throw new RuntimeLockError('RUNTIME_PACKAGE');
  for (const forbidden of [
    'agentcomms',
    'agentcommsPackage',
    'agentcommsRelease',
    'bin',
    'exports',
    'main',
    'scripts',
    'types',
  ]) {
    if (Object.hasOwn(record, forbidden)) throw new RuntimeLockError('RUNTIME_PACKAGE');
  }
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    if (Object.hasOwn(record, field)) throw new RuntimeLockError('RUNTIME_PACKAGE');
  }
  const dependencies = exactKeys(record.dependencies, Object.keys(RUNTIME_ROOTS), 'RUNTIME_PACKAGE');
  for (const [name, version] of Object.entries(RUNTIME_ROOTS)) {
    if (dependencies[name] !== version) throw new RuntimeLockError('RUNTIME_PACKAGE');
  }
  return dependencies;
}

export function assertDaemonRuntimeBoundary(manifest) {
  const record = object(manifest, 'RUNTIME_DAEMON');
  const dependencies = {
    ...object(record.dependencies ?? {}, 'RUNTIME_DAEMON'),
    ...object(record.optionalDependencies ?? {}, 'RUNTIME_DAEMON'),
    ...object(record.bundledDependencies ?? {}, 'RUNTIME_DAEMON'),
  };
  if (Object.keys(RUNTIME_ROOTS).some((name) => Object.hasOwn(dependencies, name))) {
    throw new RuntimeLockError('RUNTIME_DAEMON');
  }
  if (
    !Array.isArray(record.files) ||
    !['laya-enablement-disclosures.json', 'laya-manifest.json', 'laya-runtime.json'].every((file) =>
      record.files.includes(file),
    )
  ) {
    throw new RuntimeLockError('RUNTIME_DAEMON');
  }
}

function layaManifestRecord(value) {
  const record = exactKeys(
    value,
    ['manifestVersion', 'manifestId', 'source', 'weights', 'files', 'runtime', 'context', 'promptTemplates'],
    'LAYA_MANIFEST',
  );
  if (
    record.manifestVersion !== 1 ||
    record.manifestId !== 'laya-en-onnx-68f27dfe' ||
    !Array.isArray(record.files) ||
    record.files.length !== 5 ||
    !Array.isArray(record.promptTemplates) ||
    record.promptTemplates.length === 0
  ) {
    throw new RuntimeLockError('LAYA_MANIFEST');
  }
  const source = exactKeys(record.source, ['host', 'repo', 'revision'], 'LAYA_MANIFEST');
  if (
    source.host !== 'huggingface.co' ||
    source.repo !== 'receptron/laya-onnx' ||
    source.revision !== '68f27dfe5a27a54fb2b1fefc432f43f972e90868'
  ) {
    throw new RuntimeLockError('LAYA_MANIFEST');
  }
  const weights = exactKeys(record.weights, ['publisher', 'origin', 'originSha256', 'licence'], 'LAYA_MANIFEST');
  if (
    weights.publisher !== 'Convai Innovations' ||
    weights.origin !== 'convaiinnovations/laya' ||
    weights.originSha256 !== '891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c' ||
    weights.licence !== 'Apache-2.0'
  ) {
    throw new RuntimeLockError('LAYA_MANIFEST');
  }
  const runtime = exactKeys(record.runtime, Object.keys(RUNTIME_ROOTS), 'LAYA_MANIFEST');
  for (const [name, version] of Object.entries(RUNTIME_ROOTS)) {
    if (runtime[name] !== version) throw new RuntimeLockError('LAYA_MANIFEST');
  }
  const context = exactKeys(record.context, ['maxTokens', 'language'], 'LAYA_MANIFEST');
  if (context.maxTokens !== 512 || context.language !== 'en') throw new RuntimeLockError('LAYA_MANIFEST');
  // The templates a release offers, each one the worker source implements, in raw-byte order and without a duplicate
  // (E2 Task 10: the first release offers `laya-noul-v1` alone).
  if (!record.promptTemplates.every((id) => typeof id === 'string' && LAYA_TEMPLATE_IDS.includes(id))) {
    throw new RuntimeLockError('LAYA_MANIFEST');
  }
  assertStrictOrder(record.promptTemplates, 'LAYA_MANIFEST_ORDER');
  const files = record.files.map((value) => {
    const file = exactKeys(value, ['path', 'size', 'sha256'], 'LAYA_MANIFEST');
    const parsed = fileRecord({ ...file, executable: false });
    return { path: parsed.path, size: parsed.size, sha256: parsed.sha256 };
  });
  assertStrictOrder(
    files.map((file) => file.path),
    'LAYA_MANIFEST_ORDER',
  );
  return {
    manifestVersion: 1,
    manifestId: record.manifestId,
    source: { host: source.host, repo: source.repo, revision: source.revision },
    weights: {
      publisher: weights.publisher,
      origin: weights.origin,
      originSha256: weights.originSha256,
      licence: weights.licence,
    },
    files,
    runtime: {
      '@receptron/laya': runtime['@receptron/laya'],
      'onnxruntime-node': runtime['onnxruntime-node'],
      '@huggingface/tokenizers': runtime['@huggingface/tokenizers'],
    },
    context: { maxTokens: context.maxTokens, language: context.language },
    promptTemplates: [...record.promptTemplates],
  };
}

export function assertLayaManifest(value) {
  layaManifestRecord(value);
}

export function parseLayaManifest(text) {
  const source = string(text, 'LAYA_MANIFEST_JSON');
  const manifest = layaManifestRecord(new JsonReader(source).read());
  if (canonicalLayaManifest(manifest) !== source) throw new RuntimeLockError('LAYA_MANIFEST_CANONICAL');
  return manifest;
}

async function checkFixtures() {
  const fixture = new URL('../packages/events-daemon/test/fixtures/laya/lock-expected.json', import.meta.url);
  const lock = parseRuntimeLock(await readFile(fixture, 'utf8'));
  if (lock.packages.length === 0) throw new RuntimeLockError('RUNTIME_LOCK_FIELD');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--check-fixtures') {
    throw new Error('usage: laya-runtime-lock.mjs --check-fixtures');
  }
  await checkFixtures();
}
