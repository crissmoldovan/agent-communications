#!/usr/bin/env node
/**
 * Writes `THIRD_PARTY_LICENSES` for each published package, from what its bundle actually contains.
 *
 * These packages are bundled: the dependency code is inlined into the published files rather than installed
 * alongside them, so the licence notices that would normally travel in `node_modules` do not travel at all. Every
 * one of those licences requires the notice to be preserved, which means this file is a licence obligation, not
 * paperwork — and a bundle shipped without it is a bundle shipped in breach.
 *
 * **Read from the bundler, not from package.json.** This used to walk each package's declared dependencies, skipping
 * `@agentcomms/*` — yet every channel bundle inlines core, and with it everything core inlines and everything core
 * depends on (`noExternal` matches every module); and the walk lost any dependency pnpm had not hoisted. Resend's notice missed
 * 13 of the packages its bundle carried, Gmail's 58. So each package is now built again in memory, with its own
 * `tsdown.config.ts`, and the bundler's module graph says which files went into which output — the declaration
 * files `dts: { resolve: true }` inlines included. A module is then one of:
 *
 * - this package's own source, or core's: this repository's code, under its own LICENSE;
 * - a file of another workspace package's `dist`, which is followed into that package's own graph, so what core
 *   inlined is found in every bundle that inlines core;
 * - a file under a `node_modules/<name>`: that installed package, by the version actually on disk;
 * - the bundler's runtime glue, which it generates for the build rather than copying from a package;
 * - anything else, which fails — a module nobody can name the licence of is a module that ships without one.
 *
 * `--check` verifies without writing, which is what CI runs. It fails, naming the package and the version, for every
 * package a bundle inlines that its `THIRD_PARTY_LICENSES` has no notice for — as well as when the file is merely out
 * of date. It needs the workspace built (`pnpm build`), because a channel's bundle inlines core's `dist`.
 */
import { realpathSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// The one list of packages, read rather than copied: this script kept a copy of its own, which nothing checked. The
// wide one: a package held back from release still ships its notices in the tarball every verify packs.
import { PUBLISHABLE } from './packages.mjs';

const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));

/** Licence files, most likely first; a package that ships none of these is looked at more loosely below. */
const LICENCE_FILES = ['LICENSE', 'LICENSE.md', 'LICENCE', 'LICENCE.md', 'LICENSE.txt', 'license'];
const LOOSE_LICENCE_FILE = /^(?:licen[cs]e|copying)(?:[-.][\w.-]+)?$/i;

/**
 * Modules the bundler writes itself: rolldown's helpers for interop and lazy initialisation, generated into the
 * build rather than taken from an installed package. Named one by one, so an unfamiliar virtual module still fails.
 */
const BUNDLER_MODULES = new Set(['\0rolldown/runtime.js']);

/** Forward slashes everywhere, and on Windows one case, so a module id and a directory compare as paths. */
const comparable = (path) => {
  const forward = path.replaceAll('\\', '/');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
};

/**
 * Where one module of a bundle comes from.
 *
 * `root` is the repository, `self` the package whose bundle it is. Returns `{ kind: 'bundler' }`, `{ kind: 'own' }`,
 * `{ kind: 'workspace', name, file }`, `{ kind: 'third-party', directory }` or `{ kind: 'unknown' }`.
 */
export function ownerOf(id, { root, self }) {
  if (BUNDLER_MODULES.has(id)) return { kind: 'bundler' };
  // A query (`?commonjs-proxy` and the like) names a view of a file, not another file.
  const file = id.startsWith('\0') ? null : id.replace(/[?#].*$/, '');
  if (file === null) return { kind: 'unknown' };
  const forward = file.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const at = forward.lastIndexOf(marker);
  if (at !== -1) {
    const segments = forward.slice(at + marker.length).split('/');
    const name = segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
    if (!name || (name.startsWith('@') && !name.includes('/'))) return { kind: 'unknown' };
    return { kind: 'third-party', directory: forward.slice(0, at + marker.length) + name };
  }
  const packages = `${comparable(root).replace(/\/$/, '')}/packages/`;
  const candidate = comparable(file);
  if (candidate.startsWith(packages)) {
    const name = forward.slice(packages.length).split('/')[0];
    return name === self ? { kind: 'own' } : { kind: 'workspace', name, file: forward };
  }
  return { kind: 'unknown' };
}

/** The `name@version` of every notice a THIRD_PARTY_LICENSES text carries, read from the header line of each. */
export function noticedIn(text) {
  return new Set(
    [...String(text ?? '').matchAll(/^((?:@[^/\s]+\/)?[^@\s/]+)@(\S+) — /gm)].map((m) => `${m[1]}@${m[2]}`),
  );
}

/** What a bundle inlines that `text` has no notice for, as `name@version`, sorted. */
export function missingNotices(inlined, text) {
  const noticed = noticedIn(text);
  return [...inlined].filter((key) => !noticed.has(key)).sort(byPackage);
}

/** Remove whitespace that carries no licence wording and would fail the repository's whitespace check. */
export function normaliseLicenceText(text) {
  return String(text ?? '').replace(/[ \t]+$/gm, '');
}

/** By name, then by version as numbers, so `entities@4.5.0` comes before `entities@10.0.0`. */
function byPackage(a, b) {
  const split = (key) => {
    const at = key.lastIndexOf('@');
    return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, ''];
  };
  const [nameA, versionA] = split(a);
  const [nameB, versionB] = split(b);
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return versionA.localeCompare(versionB, 'en', { numeric: true });
}

/**
 * One package's bundle, as the bundler builds it: every output file, by absolute path, and the modules in it
 * (`outputs`), and every bare specifier it leaves for Node to resolve at run time (`externals`).
 *
 * Built in memory with the package's own config — `write: false`, and `clean: false` so its `dist` is not emptied —
 * so what is read is what `pnpm build` makes, without touching what `pnpm build` made.
 */
async function buildGraph(name) {
  const { build } = await import('tsdown');
  let handle;
  try {
    handle = await build({ cwd: join(ROOT, 'packages', name), write: false, clean: false, logLevel: 'silent' });
  } catch (error) {
    // Most often core's `dist` is missing or stale: a channel's bundle is made from it, so nothing can be read.
    throw new Error(
      `packages/${name}: its bundle could not be built to read what it inlines (${error?.message ?? error}). ` +
        'Run `pnpm build` first.',
    );
  }
  const outputs = new Map();
  const externals = new Set();
  for (const bundle of handle.bundles) {
    for (const chunk of bundle.chunks) {
      if (chunk.type !== 'chunk') continue;
      outputs.set(comparable(join(chunk.outDir, chunk.fileName)), chunk.moduleIds);
      for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
        if (!/^(?:\.|\/|[A-Za-z]:|node:)/.test(specifier)) externals.add(specifier);
      }
    }
  }
  return { outputs, externals };
}

const graphs = new Map();
function graphOf(name) {
  if (!graphs.has(name)) graphs.set(name, buildGraph(name));
  return graphs.get(name);
}

/**
 * Every installed package inlined into one package's bundle: `name@version` → `{ name, version, directory, in }`,
 * where `in` lists the published files that carry it. Problems — a module no package owns, a workspace `dist` that
 * a fresh build would not produce — are pushed onto `problems`.
 */
async function inlinedInto(name, problems) {
  const found = new Map();
  const where = (file) => relative(ROOT, file).replaceAll('\\', '/');

  async function visit(owner, output, ids, via, seen) {
    for (const id of ids) {
      const from = ownerOf(id, { root: ROOT, self: owner });
      if (from.kind === 'bundler' || from.kind === 'own') continue;
      if (from.kind === 'unknown') {
        problems.push(
          `packages/${name}: ${where(output)} inlines ${JSON.stringify(id)}, which is neither this repository's code ` +
            'nor an installed package, so there is no licence to name for it',
        );
        continue;
      }
      if (from.kind === 'workspace') {
        const key = comparable(from.file);
        if (seen.has(key)) continue;
        seen.add(key);
        const theirs = (await graphOf(from.name)).outputs.get(key);
        if (!theirs) {
          problems.push(
            `packages/${name}: its bundle inlines ${where(from.file)}, which a fresh build of packages/${from.name} ` +
              'does not produce — that dist is out of date, so what it inlines cannot be read. Run `pnpm build`.',
          );
          continue;
        }
        await visit(from.name, from.file, theirs, via, seen);
        continue;
      }
      const manifest = JSON.parse(await readFile(join(from.directory, 'package.json'), 'utf8'));
      const key = `${manifest.name}@${manifest.version}`;
      if (!found.has(key)) found.set(key, { directory: from.directory, manifest, in: new Set() });
      found.get(key).in.add(via);
    }
  }

  const { outputs, externals } = await graphOf(name);
  // A workspace package the bundle leaves outside it, though this package does not install it, is one the bundler
  // could not find — core's `dist` not built, most often. What it would have inlined is then invisible here, and the
  // notices would come out short rather than wrong-looking, so it is said plainly.
  const manifest = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
  const installed = new Set(
    Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }),
  );
  for (const specifier of externals) {
    const [scope, bare] = specifier.split('/');
    const packageName = specifier.startsWith('@') ? `${scope}/${bare}` : scope;
    if (packageName.startsWith('@agentcomms/') && !installed.has(packageName)) {
      problems.push(
        `packages/${name}: its bundle leaves ${specifier} outside it, and the package does not install it — that ` +
          "workspace package's dist is missing, so what it would inline cannot be read. Run `pnpm build`.",
      );
    }
  }
  for (const [output, ids] of outputs) {
    await visit(name, output, ids, where(output), new Set());
  }
  return found;
}

/** The licence a manifest declares: an SPDX expression, the old `{ type }` form, or the older `licenses` array. */
function declaredLicence(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (typeof manifest.license?.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map((entry) => entry?.type).filter((type) => typeof type === 'string');
    if (types.length > 0) return types.join(' OR ');
  }
  return 'see below';
}

/** The licence text a package ships, or null. */
async function shippedText(directory) {
  const entries = await readdir(directory).catch(() => []);
  for (const candidate of LICENCE_FILES) {
    const found = entries.find((entry) => entry.toLowerCase() === candidate.toLowerCase());
    if (!found) continue;
    const text = await readFile(join(directory, found), 'utf8').catch(() => null);
    if (text?.trim()) return text;
  }
  // `LICENSE-MIT`, `COPYING` and the like; a dual-licensed package can ship two, and both are reproduced.
  const loose = entries.filter((entry) => LOOSE_LICENCE_FILE.test(entry)).sort();
  const texts = [];
  for (const entry of loose) {
    const text = await readFile(join(directory, entry), 'utf8').catch(() => null);
    if (text?.trim()) texts.push(text.trim());
  }
  if (texts.length > 0) return texts.join('\n\n');
  return readmeLicence(directory, entries);
}

/**
 * The licence a package reproduces in its README instead of a file of its own — `data-uri-to-buffer` does — taken
 * only when that section is the licence's text, with its grant, and not a one-line "MIT © somebody".
 */
async function readmeLicence(directory, entries) {
  const readme = entries.find((entry) => /^readme(?:\.md|\.markdown|\.txt)?$/i.test(entry));
  if (!readme) return null;
  const lines = (await readFile(join(directory, readme), 'utf8').catch(() => '')).split(/\r?\n/);
  const heading = (index) => {
    const line = lines[index] ?? '';
    if (/^#{1,6}\s/.test(line)) return line.replace(/^#+\s*/, '');
    return /^(?:-{3,}|={3,})\s*$/.test(lines[index + 1] ?? '') && line.trim() !== '' ? line : null;
  };
  const start = lines.findIndex((_, index) => /^licen[cs]e\b/i.test(heading(index)?.trim() ?? ''));
  if (start === -1) return null;
  const body = [];
  for (let index = start + (/^#/.test(lines[start]) ? 1 : 2); index < lines.length; index += 1) {
    if (heading(index) !== null) break;
    // Link definitions at the foot of a README belong to the document, not to the licence.
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(lines[index])) continue;
    body.push(lines[index]);
  }
  const text = body
    .join('\n')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .trim();
  const granted = /Permission is hereby granted|Redistribution and use|Permission to use, copy, modify/;
  return granted.test(text) ? text : null;
}

/**
 * The text of a licence whose package ships no copy, borrowed from another package inlined here that declares the
 * same licence and does ship one.
 *
 * Some packages declare a licence and ship no copy of it — `@googleapis/*` among them. The obligation to reproduce it
 * does not go away. Only Apache-2.0 is borrowed: its text carries no per-package copyright line, so it is the same
 * everywhere, while an MIT or BSD text names its holder and cannot be taken from someone else's. The donor is chosen
 * by name, so the output does not depend on the order the bundler happened to list modules in.
 */
async function canonicalText(spdx, everything) {
  if (spdx !== 'Apache-2.0') return null;
  const donors = [...everything.values()]
    .filter((entry) => declaredLicence(entry.manifest) === spdx)
    .sort((a, b) => byPackage(`${a.manifest.name}@${a.manifest.version}`, `${b.manifest.name}@${b.manifest.version}`));
  for (const donor of donors) {
    const text = await shippedText(donor.directory);
    if (text && /Apache License/.test(text) && /Version 2\.0/.test(text)) return text;
  }
  return null;
}

async function noticeFor(key, entry, everything, problems) {
  const licence = declaredLicence(entry.manifest);
  const text = (await shippedText(entry.directory)) ?? (await canonicalText(licence, everything));
  if (!text) {
    problems.push(`${key}: declares ${licence} and ships no copy of it, and no canonical text was found`);
    return null;
  }
  return [
    '-'.repeat(100),
    `${key} — ${licence}`,
    entry.manifest.homepage ? `  ${entry.manifest.homepage}` : '',
    '-'.repeat(100),
    '',
    text.trim(),
    '',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The file for one package, from the packages its bundle inlines. */
async function licencesFile(name, inlined, everything, problems) {
  const keys = [...inlined.keys()].sort(byPackage);
  const notices = [];
  for (const key of keys) {
    const notice = await noticeFor(key, inlined.get(key), everything, problems);
    if (notice) notices.push(notice);
  }
  if (keys.length === 0) {
    // A package that bundles nothing says so, rather than leaving a header with nothing under it — which reads like
    // a file that was cut off.
    const manifest = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
    const ours = Object.keys(manifest.dependencies ?? {}).filter((dependency) => dependency.startsWith('@agentcomms/'));
    const because =
      ours.length > 0
        ? `: it depends on ${ours.join(' and ')} at runtime, which ${ours.length === 1 ? 'carries its' : 'carry their'}\nown THIRD_PARTY_LICENSES for what ${ours.length === 1 ? 'it bundles' : 'they bundle'}.`
        : '.';
    return [
      `Third-party licences for @agentcomms/${name}`,
      '',
      `This package inlines no third-party code${because} There is nothing to reproduce here.`,
      '',
      'Generated by scripts/third-party-licenses.mjs.',
      '',
    ].join('\n');
  }
  return [
    `Third-party licences bundled into @agentcomms/${name}`,
    '',
    'This package is published as a bundle: the code below is compiled into its published files rather than',
    'installed beside them, so these notices travel here instead of in node_modules. They are reproduced in',
    'full, as each licence requires.',
    '',
    `Generated by scripts/third-party-licenses.mjs from the ${keys.length} packages the bundler put into it.`,
    '',
    '',
    ...notices,
  ].join('\n');
}

async function main() {
  const check = process.argv.includes('--check');
  const problems = [];
  const contents = new Map();
  const everything = new Map();
  for (const name of PUBLISHABLE) {
    const inlined = await inlinedInto(name, problems);
    contents.set(name, inlined);
    for (const [key, entry] of inlined) if (!everything.has(key)) everything.set(key, entry);
  }

  const counts = [];
  for (const name of PUBLISHABLE) {
    const inlined = contents.get(name);
    counts.push(`${name} ${inlined.size}`);
    // Some licence files are written with CRLF. The repository stores every text file with LF (`.gitattributes`), so
    // a CRLF kept here would be normalised on commit and then differ from every fresh generation, on every platform.
    const content = normaliseLicenceText(
      (await licencesFile(name, inlined, everything, problems)).replace(/\r\n?/g, '\n'),
    );
    const path = join(ROOT, 'packages', name, 'THIRD_PARTY_LICENSES');
    const current = await readFile(path, 'utf8').catch(() => null);
    // Existing notices may preserve whitespace copied from an upstream licence. Do not rewrite an unrelated package
    // merely to remove it; any package whose bundle really changed is written in the clean canonical form above.
    if (normaliseLicenceText(current) === content) continue;
    if (!check) {
      await writeFile(path, content);
      continue;
    }
    for (const key of missingNotices(inlined.keys(), current)) {
      const carriers = [...inlined.get(key).in].sort().join(', ');
      problems.push(
        `packages/${name}: its bundle inlines ${key} (${carriers}), and THIRD_PARTY_LICENSES has no notice for it`,
      );
    }
    problems.push(`packages/${name}/THIRD_PARTY_LICENSES is out of date — run \`pnpm licenses\``);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(
    `third-party licences ${check ? 'match' : 'written for'} what ${PUBLISHABLE.length} bundles inline (${counts.join(', ')}).`,
  );
}

// Run directly, generate or check. Imported — by its test — it only lends its readers. Compared through realpath,
// as `packages.mjs` does, because a temp directory can be a symlink.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) await main();
