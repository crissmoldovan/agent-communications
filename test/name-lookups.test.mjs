import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Names are looked up in one place.
 *
 * Version 2 of the config renames every account and remembers the names it replaced, so "is there an inbox called
 * `cue`" has three answers — yes; no; and no, it is called `cue/gmail` now — and only `resolveName` in core knows the
 * third. A caller that indexes `config.inboxes[name]` itself answers "no such inbox" to somebody using last week's
 * name, and applies version 1's rules to a version-2 file.
 *
 * A table of tested callers only covers the callers somebody listed. This covers the ones nobody did, in the form
 * such a lookup nearly always takes. Not every form: a `find` over `Object.entries(config.inboxes)` gets past it, and
 * review has to catch that.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Core's config module and the helpers built on it are where names are looked up; that is the point. */
const ALLOWED = [join('packages', 'core', 'src', 'config.ts'), join('packages', 'core', 'src', 'names.ts')];

/**
 * Lookups not yet moved onto the helpers, and how many each file has.
 *
 * Gmail's move in N2 and Slack's in N3. Exact counts, so a new lookup added to one of these files fails like one
 * added anywhere else — and a file that reaches zero must leave the list, so the list can only shrink.
 */
const NOT_YET_MOVED = {
  [join('packages', 'gmail', 'src', 'cli', 'program.ts')]: 1,
  [join('packages', 'gmail', 'src', 'mcp', 'server.ts')]: 2,
  [join('packages', 'gmail', 'src', 'operations', 'consent.ts')]: 1,
  [join('packages', 'gmail', 'src', 'operations', 'doctor.ts')]: 1,
  [join('packages', 'gmail', 'src', 'operations', 'import-legacy.ts')]: 2,
  [join('packages', 'gmail', 'src', 'operations', 'inboxes.ts')]: 2,
  [join('packages', 'gmail', 'src', 'operations', 'send.ts')]: 1,
  [join('packages', 'gmail', 'src', 'operations', 'signin.ts')]: 1,
  [join('packages', 'slack', 'src', 'cli', 'program.ts')]: 1,
  [join('packages', 'slack', 'src', 'operations', 'signin.ts')]: 2,
  [join('packages', 'slack', 'src', 'operations', 'workspaces.ts')]: 2,
};

/**
 * An indexed read of either map: `config.inboxes[alias]`, `current.accounts?.[name]`.
 *
 * A numeric index is left alone — `result.inboxes[0]` is an element of some list of names, not a lookup by one.
 */
export const NAME_LOOKUP = /\.(?:inboxes|accounts)(?:\?\.)?\[(?!\s*\d)/g;

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs']);

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      found.push(...(await sourceFiles(path)));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

export function countLookups(source) {
  return withoutComments(source).match(NAME_LOOKUP)?.length ?? 0;
}

/** Every package's `src/` under `root`, checked against the allowlist and the not-yet-moved counts. */
async function scan(root, allowed, notYetMoved) {
  const counts = new Map();
  for (const name of await readdir(join(root, 'packages'))) {
    for (const file of await sourceFiles(join(root, 'packages', name, 'src')).catch(() => [])) {
      const count = countLookups(await readFile(file, 'utf8'));
      if (count > 0) counts.set(relative(root, file), count);
    }
  }
  const unexpected = [];
  for (const [file, count] of counts) {
    if (allowed.includes(file)) continue;
    const limit = notYetMoved[file] ?? 0;
    if (count > limit) unexpected.push(`${file}: ${count} (expected at most ${limit})`);
  }
  const stale = Object.entries(notYetMoved)
    .filter(([file, expected]) => (counts.get(file) ?? 0) < expected)
    .map(([file, expected]) => `${file}: ${counts.get(file) ?? 0} (listed as ${expected})`);
  return { unexpected, stale };
}

test('nothing outside core looks an account up by name except through the helpers', async () => {
  const { unexpected, stale } = await scan(ROOT, ALLOWED, NOT_YET_MOVED);
  assert.deepEqual(unexpected, [], 'look names up with resolveName / nameAvailable from @agentcomms/core');
  assert.deepEqual(stale, [], 'a lookup was moved onto the helpers — lower its count here, or remove the file');
});

test('the scan finds a lookup planted in a package it has never seen, and a count that went down', async () => {
  const root = await mkdtemp(join(tmpdir(), 'name-lookups-'));
  try {
    const write = async (path, text) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), text);
    };
    await write(join('packages', 'core', 'src', 'config.ts'), 'const a = config.inboxes[name];');
    await write(join('packages', 'newcomer', 'src', 'deep', 'lookup.ts'), 'export const b = (c, n) => c.accounts[n];');
    await write(join('packages', 'old', 'src', 'moved.ts'), 'export const nothing = 1;');
    await write(join('packages', 'newcomer', 'node_modules', 'x', 'src', 'dep.ts'), 'c.inboxes[n];');

    const allowed = [join('packages', 'core', 'src', 'config.ts')];
    const { unexpected, stale } = await scan(root, allowed, { [join('packages', 'old', 'src', 'moved.ts')]: 1 });
    assert.deepEqual(unexpected, [
      `${join('packages', 'newcomer', 'src', 'deep', 'lookup.ts')}: 1 (expected at most 0)`,
    ]);
    assert.deepEqual(stale, [`${join('packages', 'old', 'src', 'moved.ts')}: 0 (listed as 1)`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the scan finds the shapes it claims to, and leaves list indexing alone', () => {
  assert.equal(countLookups('const inbox = config.inboxes[alias];'), 1);
  assert.equal(countLookups('const held = current.accounts?.[flow.alias];'), 1);
  assert.equal(countLookups('if (config.inboxes[ name ]) {}'), 1);
  assert.equal(countLookups('write(result.inboxes[0]);'), 0);
  assert.equal(countLookups('// config.inboxes[alias] in a comment'), 0);
  assert.equal(countLookups('return { ...current, inboxes: { ...current.inboxes, [alias]: inbox } };'), 0);
});
