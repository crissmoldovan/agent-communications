#!/usr/bin/env node
/**
 * Writes `apps/desktop/THIRD_PARTY_LICENSES`: the notices for the third-party code Agent Comms is built from (desktop
 * design DA15, "Licence notices"). Every one of those licences asks for its notice to travel with each copy, and the
 * app ships as one binary with its web bundle inside, so nothing else carries them. `publish-desktop.sh` attaches the
 * file to every `desktop-v*` release.
 *
 * Two sources, each read from what the build actually uses:
 *
 * - **JavaScript:** the packages the Vite bundle includes. The app is built again in memory with its own
 *   `vite.config.ts` (`write: false`, so `dist/` is left alone), and every module of every chunk is mapped to the
 *   installed package that owns it with the repository's own reader (`scripts/third-party-licenses.mjs`: `ownerOf`,
 *   `noticeFor`), so a notice here reads like every package's. Stylesheets are followed as well: Tailwind inlines what
 *   an `@import` names, which the module graph does not show, so each stylesheet is read and its imports resolved as
 *   Tailwind resolves them (a package's `style` export). The bundler's own glue is not a package: rolldown's runtime
 *   and the helpers its transformer writes are named below, by their exact shape, so an unfamiliar virtual module
 *   still fails. Vite's preload polyfill is Vite's own code, so Vite is noticed, with its own licence only.
 * - **Rust:** the crates `cargo metadata` resolves for the four targets the app is built for (macOS on Apple silicon
 *   and Intel, Windows x64, Linux x64), reached from the app through normal and build dependencies; its
 *   dev-dependencies only build its tests. Each crate's licence expression comes from its manifest and its texts from
 *   its own files (`LICENSE*`, `COPYING*`, `NOTICE*` and the like). A text several crates ship byte for byte is
 *   printed once, under every crate that ships it. A crate that ships no such file is listed with its expression.
 *
 * `--check` writes nothing and fails, naming each `name@version`, when the file is out of step with the build, which
 * is what CI runs. It needs the app's dependencies installed and `cargo` on the PATH; `cargo metadata` downloads the
 * crates of a target it has not fetched yet, as a build would.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingNotices, normaliseLicenceText, noticeFor, ownerOf } from '../../../scripts/third-party-licenses.mjs';

const APP = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = realpathSync(join(APP, '..', '..'));
const OUTPUT = join(APP, 'THIRD_PARTY_LICENSES');

/** The targets the app is built for: the universal macOS build's two halves, then the Windows and Linux CI builds. */
export const TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];

/**
 * Virtual modules the bundler writes into the build itself, rather than reading from an installed package: rolldown's
 * runtime (as the repository's reader treats it), and the helpers its transformer (oxc) emits for syntax the targets
 * lack, which come from inside the bundler's native binary. Matched by their exact shape, nothing looser.
 */
const BUNDLER_MODULES = [/^\0rolldown\/runtime\.js$/, /^\0@oxc-project\+runtime@[\w.-]+\/helpers\/(?:esm\/)?\w+\.js$/];
/** Vite's module-preload polyfill, which Vite copies into the bundle: its code, so its notice. */
const VITE_POLYFILL = '\0vite/modulepreload-polyfill.js';

/** A licence, notice or copyright file a crate ships. `LICENSES/` folders are read file by file. */
const CRATE_LICENCE_FILE = /^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[-._][\w.-]*)?$/i;

const RULE = '-'.repeat(100);
const BANNER = '='.repeat(100);

/** Forward slashes, and one case on Windows, so a module id and a directory compare as paths. */
const comparable = (path) => {
  const forward = path.replaceAll('\\', '/');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
};

/** By name, then by version as numbers, so `entities@4.5.0` comes before `entities@10.0.0`. */
export function byPackage(a, b) {
  const split = (key) => {
    const at = key.lastIndexOf('@');
    return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, ''];
  };
  const [nameA, versionA] = split(a);
  const [nameB, versionB] = split(b);
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return versionA.localeCompare(versionB, 'en', { numeric: true });
}

/** Text as the repository stores it: LF line ends, and no whitespace at the end of a line. */
const stored = (text) => normaliseLicenceText(String(text).replace(/\r\n?/g, '\n')).trim();

// ---------------------------------------------------------------------------------------------------------------------
// JavaScript

/** The file a stylesheet's `@import "<package>[/<path>]"` names, resolved from `from` as Tailwind does, or null. */
export function resolveStylesheet(specifier, from) {
  if (/^(?:[a-z]+:)?\/\//i.test(specifier)) return null;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return resolve(from, specifier);
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = parts.slice(specifier.startsWith('@') ? 2 : 1).join('/');
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      const root = realpathSync(candidate);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const target = styleTarget(manifest, subpath);
      return target === null ? null : join(root, target);
    }
    if (directory === dirname(directory)) return null;
  }
}

/** Where a package's manifest sends a stylesheet import of `subpath` ('' for the package itself). */
function styleTarget(manifest, subpath) {
  const key = subpath === '' ? '.' : `./${subpath}`;
  const pick = (entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return pick(entry.style ?? entry.default ?? entry.import ?? null);
    return null;
  };
  const exports = manifest.exports;
  if (exports === undefined) return subpath === '' ? (manifest.style ?? 'index.css') : subpath;
  if (typeof exports === 'string') return subpath === '' ? exports : null;
  if (key in exports) return pick(exports[key]);
  for (const [pattern, entry] of Object.entries(exports)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const [before, after] = [pattern.slice(0, star), pattern.slice(star + 1)];
    if (key.startsWith(before) && key.endsWith(after) && key.length >= before.length + after.length) {
      const target = pick(entry);
      return target === null ? null : target.replace('*', key.slice(before.length, key.length - after.length));
    }
  }
  return subpath === '' ? (manifest.style ?? null) : null;
}

/** Every stylesheet `file` pulls in through `@import`, itself included, as real paths; problems are pushed. */
export function stylesheetsFrom(file, problems, seen = new Set()) {
  const real = realpathSync(file);
  if (seen.has(comparable(real))) return seen;
  seen.add(comparable(real));
  const text = readFileSync(real, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of text.matchAll(/@import\s+(?:url\(\s*)?(["'])([^"']+)\1/g)) {
    const specifier = match[2];
    const target = resolveStylesheet(specifier, dirname(real));
    if (target === null || !existsSync(target)) {
      problems.push(
        `${comparable(real)}: its @import "${specifier}" cannot be resolved to a file, so it cannot be read`,
      );
      continue;
    }
    stylesheetsFrom(target, problems, seen);
  }
  return seen;
}

/** Every module id of the app's bundle, built in memory with its own config. */
async function bundleModules() {
  const { build } = await import('vite');
  const result = await build({
    root: APP,
    configFile: join(APP, 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false, emptyOutDir: false },
  });
  const ids = new Set();
  for (const output of Array.isArray(result) ? result : [result]) {
    for (const chunk of output.output) if (chunk.type === 'chunk') for (const id of chunk.moduleIds) ids.add(id);
  }
  return ids;
}

/**
 * A notice cut to the package's own licence where its licence file goes on to reproduce the licences of what the
 * package's own `dist` bundles. Vite's does: the app takes only its preload polyfill, which is Vite's own code, and
 * none of what Vite bundles for itself.
 */
export function ownPart(name, notice) {
  return name === 'vite' ? notice.split('\n# Licenses of bundled dependencies')[0] : notice;
}

/** The installed directory of `name`, as the app resolves it. */
function installedDirectory(name) {
  return realpathSync(join(APP, 'node_modules', name));
}

/**
 * The packages one set of module ids comes from: `name@version` → `{ directory, manifest }`. Ids are module ids of
 * the bundle, or real paths of the stylesheets they import; problems are pushed.
 */
export function packagesOf(ids, problems, { app = APP, root = ROOT, vite = () => installedDirectory('vite') } = {}) {
  const found = new Map();
  const own = `${comparable(app).replace(/\/$/, '')}/`;
  const add = (directory) => {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const key = `${manifest.name}@${manifest.version}`;
    if (!found.has(key)) found.set(key, { directory, manifest });
  };
  for (const id of ids) {
    if (BUNDLER_MODULES.some((pattern) => pattern.test(id))) continue;
    if (id === VITE_POLYFILL) {
      add(vite());
      continue;
    }
    const file = id.startsWith('\0') ? null : id.replace(/[?#].*$/, '');
    const owner = file === null ? { kind: 'unknown' } : ownerOf(file, { root, self: '' });
    if (owner.kind === 'third-party') {
      add(owner.directory);
      continue;
    }
    if (file !== null && comparable(file).startsWith(own) && !comparable(file).includes('/node_modules/')) continue;
    // The repository's own code the app imports from a package's source — the rule text of `@agentcomms/events`
    // (0.33.0) — is the app's own, under the app's own licence: no third party's, so no notice.
    if (owner.kind === 'workspace' && firstPartySource(owner.file, root, app)) continue;
    problems.push(
      `the app's bundle includes ${JSON.stringify(id.replace(own, ''))}, which is neither the app's code nor an ` +
        'installed package, so there is no licence to name for it',
    );
  }
  return found;
}

/**
 * Whether `file` is the source of one of this repository's own packages (`packages/<name>/src/…`), an `@agentcomms/*`
 * package under the app's own licence. A package's vendored data, or anything outside its `src`, is not.
 */
export function firstPartySource(file, root = ROOT, app = APP) {
  const packages = `${comparable(root).replace(/\/$/, '')}/packages/`;
  const candidate = comparable(file);
  if (!candidate.startsWith(packages)) return false;
  const [name, top] = candidate.slice(packages.length).split('/');
  if (!name || top !== 'src') return false;
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
    const ours = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    return (
      typeof manifest.name === 'string' && manifest.name.startsWith('@agentcomms/') && manifest.license === ours.license
    );
  } catch {
    return false;
  }
}

/** The JavaScript packages in the app's bundle, with the packages its stylesheets import. */
async function javascriptPackages(problems) {
  const ids = await bundleModules();
  const stylesheets = new Set();
  for (const id of ids) {
    const file = id.replace(/[?#].*$/, '');
    if (!id.startsWith('\0') && file.endsWith('.css'))
      for (const sheet of stylesheetsFrom(file, problems)) stylesheets.add(sheet);
  }
  return packagesOf(new Set([...ids, ...stylesheets]), problems);
}

// ---------------------------------------------------------------------------------------------------------------------
// Rust

/** `cargo metadata` for the app's crate, resolved for every target it is built for, from its lock file. */
function cargoMetadata() {
  const manifest = join(APP, 'src-tauri', 'Cargo.toml');
  const platforms = TARGETS.flatMap((target) => ['--filter-platform', target]);
  const run = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest, ...platforms],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (run.error) throw new Error(`cargo could not be run (${run.error.message}); the Rust crates need it`);
  if (run.status !== 0) throw new Error(`cargo metadata failed:\n${run.stderr.trim()}`);
  return JSON.parse(run.stdout);
}

/**
 * The crates the app is built from: every package reachable from the root through normal and build dependencies,
 * without the root. A dev-dependency of the root only builds its tests, so it is left out; cargo resolves no
 * dev-dependency of any other crate.
 */
export function cratesOf(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const root = metadata.resolve.root;
  const reached = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) {
      const kinds = (dependency.dep_kinds ?? []).map((kind) => kind.kind ?? 'normal');
      if (kinds.length > 0 && kinds.every((kind) => kind === 'dev')) continue;
      pending.push(dependency.pkg);
    }
  }
  reached.delete(root);
  return [...reached]
    .map((id) => packages.get(id))
    .filter(Boolean)
    .sort((a, b) => byPackage(`${a.name}@${a.version}`, `${b.name}@${b.version}`));
}

/** The licence, notice and copyright texts one crate ships, by file name, sorted. */
export function crateTexts(directory, licenseFile) {
  const files = [];
  const visit = (folder, prefix) => {
    for (const entry of readdirSync(folder).sort()) {
      const path = join(folder, entry);
      const stats = statSync(path);
      if (stats.isDirectory() && prefix === '' && /^licen[cs]es$/i.test(entry)) visit(path, `${entry}/`);
      else if (stats.isFile() && (prefix !== '' || CRATE_LICENCE_FILE.test(entry))) files.push(`${prefix}${entry}`);
    }
  };
  visit(directory, '');
  if (licenseFile && !files.includes(licenseFile.replaceAll('\\', '/')) && existsSync(join(directory, licenseFile))) {
    files.push(licenseFile.replaceAll('\\', '/'));
  }
  return files
    .map((file) => ({ file, text: stored(readFileSync(join(directory, file), 'utf8')) }))
    .filter(({ text }) => text !== '');
}

/** The expression a crate declares, or what it says instead. */
const crateLicence = (crate) => crate.license ?? (crate.license_file ? `see ${crate.license_file}` : 'none declared');

/** The Rust half of the file: one section per distinct text, then the crates that ship none. */
export function rustSection(crates, textsOf) {
  const texts = new Map();
  const without = [];
  for (const crate of crates) {
    const key = `${crate.name}@${crate.version}`;
    const shipped = textsOf(crate);
    if (shipped.length === 0) {
      without.push(`${key} — ${crateLicence(crate)}${crate.repository ? `  ${crate.repository}` : ''}`);
      continue;
    }
    for (const { text } of shipped) {
      if (!texts.has(text)) texts.set(text, []);
      texts.get(text).push(`${key} — ${crateLicence(crate)}`);
    }
  }
  const sections = [...texts].map(([text, holders]) => [RULE, ...holders, RULE, text, '', ''].join('\n'));
  const missing =
    without.length === 0
      ? []
      : [
          RULE,
          'Crates that ship no licence file',
          RULE,
          '',
          'These declare a licence in their manifest and carry no licence, notice or copyright file in the published',
          'crate, so there is no text of theirs to reproduce. Each is named with its expression and its repository.',
          '',
          ...without,
          '',
          '',
        ];
  return [
    BANNER,
    'Rust crates',
    BANNER,
    '',
    `${crates.length} crates, as \`cargo metadata\` resolves them through normal and build dependencies for the targets`,
    `the app is built for: ${TARGETS.slice(0, -1).join(', ')} and ${TARGETS.at(-1)}.`,
    'A text several crates ship byte for byte is printed once, under every crate that ships it.',
    '',
    '',
    ...sections,
    ...missing,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------

/** The whole file, from the JavaScript packages (with their notices) and the crates. */
export function licencesFile(javascript, notices, crates, rust) {
  return `${[
    'Third-party licences for Agent Comms (@agentcomms/desktop)',
    '',
    "Agent Comms is built from this repository's code, under its own LICENSE, and from the third-party code below:",
    'the JavaScript packages its web bundle includes, and the Rust crates its binary is built from. Each of their',
    'licences asks for its notice to travel with every copy, so the notices are reproduced here in full.',
    '',
    `Generated by apps/desktop/scripts/third-party-licenses.mjs from the ${javascript} packages the bundler put into the`,
    `app and the ${crates} crates cargo resolves for it.`,
    '',
    '',
    BANNER,
    'JavaScript packages',
    BANNER,
    '',
    '',
    ...notices,
    rust,
  ]
    .join('\n')
    .trimEnd()}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const problems = [];

  const javascript = await javascriptPackages(problems);
  const keys = [...javascript.keys()].sort(byPackage);
  const notices = [];
  for (const key of keys) {
    const notice = await noticeFor(key, javascript.get(key), javascript, problems);
    if (notice) notices.push(stored(ownPart(javascript.get(key).manifest.name, notice)), '', '');
  }

  const crates = cratesOf(cargoMetadata());
  const rust = rustSection(crates, (crate) => crateTexts(dirname(crate.manifest_path), crate.license_file));
  const content = licencesFile(keys.length, notices, crates.length, rust);

  if (problems.length === 0) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8').replace(/\r\n?/g, '\n') : null;
    if (current !== content) {
      if (!check) {
        writeFileSync(OUTPUT, content);
      } else {
        const expected = [...keys, ...crates.map((crate) => `${crate.name}@${crate.version}`)];
        for (const key of missingNotices(expected, current)) {
          problems.push(`apps/desktop: the build uses ${key}, and THIRD_PARTY_LICENSES has no notice for it`);
        }
        problems.push(
          'apps/desktop/THIRD_PARTY_LICENSES is out of date — run `pnpm --filter @agentcomms/desktop run licenses`',
        );
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  process.stdout.write(
    `desktop third-party licences ${check ? 'match' : 'written for'} the build: ${keys.length} JavaScript packages, ` +
      `${crates.length} Rust crates.\n`,
  );
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) await main();
