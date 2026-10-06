import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  inlinedInto,
  missingNotices,
  normaliseLicenceText,
  noticedIn,
  noticeFor,
  ownerOf,
  vendoredEntry,
} from '../scripts/third-party-licenses.mjs';

/**
 * The licence notices are built from the bundler's module graph (`scripts/third-party-licenses.mjs`): every module
 * compiled into a published file is attributed to the package it came from, and a package whose bundle inlines one
 * that its THIRD_PARTY_LICENSES does not name fails `pnpm verify:licenses`.
 *
 * The walk it replaced followed each package's declared dependencies and skipped `@agentcomms/*`, so a channel that
 * inlines core — and everything core inlines — shipped 13 packages' code without their notices (Resend), or 58
 * (Gmail). These tests hold the two parts that decide what is owed: where a module comes from, and whether a notice
 * names it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const root = '/work/repo';
const at = (self) => ({ root, self });

test('a module under node_modules is the installed package it sits in, at the version on disk', () => {
  const pnpm = `${root}/node_modules/.pnpm/htmlparser2@12.0.0/node_modules/htmlparser2/dist/esm/Parser.js`;
  assert.deepEqual(ownerOf(pnpm, at('resend')), {
    kind: 'third-party',
    directory: `${root}/node_modules/.pnpm/htmlparser2@12.0.0/node_modules/htmlparser2`,
  });
  // Scoped, a declaration file, and a query naming a view of the same file.
  const scoped = `${root}/node_modules/.pnpm/@selderee+plugin-htmlparser2@0.12.0/node_modules/@selderee/plugin-htmlparser2/lib/hp2-builder.mjs?commonjs-proxy`;
  assert.deepEqual(ownerOf(scoped, at('resend')), {
    kind: 'third-party',
    directory: `${root}/node_modules/.pnpm/@selderee+plugin-htmlparser2@0.12.0/node_modules/@selderee/plugin-htmlparser2`,
  });
  // A dependency nested under another is that dependency, not its parent.
  const nested = `${root}/node_modules/.pnpm/a@1.0.0/node_modules/a/node_modules/entities/lib/decode.js`;
  assert.equal(
    ownerOf(nested, at('gmail')).directory,
    `${root}/node_modules/.pnpm/a@1.0.0/node_modules/a/node_modules/entities`,
  );
  // Windows paths use backslashes.
  const windows = 'C:\\work\\repo\\node_modules\\.pnpm\\zod@4.6.5\\node_modules\\zod\\v4\\core\\parse.d.cts';
  assert.deepEqual(ownerOf(windows, { root: 'C:\\work\\repo', self: 'slack' }), {
    kind: 'third-party',
    directory: 'C:/work/repo/node_modules/.pnpm/zod@4.6.5/node_modules/zod',
  });
});

test('a channel inlining core is inlining a workspace package, which is followed rather than skipped', () => {
  // The old walk dropped every `@agentcomms/*` dependency, and with it everything core carries into a channel.
  assert.deepEqual(ownerOf(`${root}/packages/core/dist/index.mjs`, at('resend')), {
    kind: 'workspace',
    name: 'core',
    file: `${root}/packages/core/dist/index.mjs`,
  });
  assert.deepEqual(ownerOf(`${root}/packages/resend/src/cli.ts`, at('resend')), { kind: 'own' });
  assert.deepEqual(ownerOf(`${root}/packages/resend/package.json`, at('resend')), { kind: 'own' });
  assert.equal(ownerOf(`${root}/packages/core/src/index.ts`, at('core')).kind, 'own');
});

test('only the bundler’s own runtime is let through unnamed; any other module no package owns is a failure', () => {
  assert.deepEqual(ownerOf('\0rolldown/runtime.js', at('gmail')), { kind: 'bundler' });
  for (const id of [
    '\0commonjs-external:x',
    '\0rolldown/other.js',
    '/elsewhere/vendor/lib.js',
    `${root}/scripts/x.mjs`,
  ]) {
    assert.deepEqual(ownerOf(id, at('gmail')), { kind: 'unknown' }, id);
  }
});

test('a notice counts only for the package and version it names', () => {
  const text = [
    'Third-party licences bundled into @agentcomms/resend',
    '',
    '-'.repeat(100),
    '@selderee/plugin-htmlparser2@0.12.0 — MIT',
    '  https://example.test/',
    '-'.repeat(100),
    'MIT License',
    '-'.repeat(100),
    'entities@4.5.0 — BSD-2-Clause',
    '-'.repeat(100),
    'Copyright (c) Felix Böhm — mentioned in prose@1.0.0 — not a header',
  ].join('\n');
  assert.deepEqual([...noticedIn(text)].sort(), ['@selderee/plugin-htmlparser2@0.12.0', 'entities@4.5.0']);
  // Two versions of one package are two bundled copies, and each needs its notice.
  assert.deepEqual(
    missingNotices(
      ['entities@4.5.0', 'entities@8.1.0', 'htmlparser2@12.0.0', '@selderee/plugin-htmlparser2@0.12.0'],
      text,
    ),
    ['entities@8.1.0', 'htmlparser2@12.0.0'],
  );
  // A package with no file at all owes every notice.
  assert.deepEqual(missingNotices(['zod@4.6.5'], null), ['zod@4.6.5']);
});

test('generated licence notices ignore meaningless trailing whitespace from upstream prose', () => {
  assert.equal(
    normaliseLicenceText('Copyright holder  \n \nPermission granted\t\n'),
    'Copyright holder\n\nPermission granted\n',
  );
});

test('the packed-tarball check requires THIRD_PARTY_LICENSES in every tarball', async () => {
  // `verify:licenses` checks the file in the source tree; only the packed tarball shows it actually ships.
  const source = await readFile(join(ROOT, 'scripts', 'verify-package.mjs'), 'utf8');
  const list = /const mustShip = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
  assert.match(list, /'package\/THIRD_PARTY_LICENSES'/);
  assert.match(source, /for \(const required of mustShip\) \{\n\s+if \(!entries\.has\(required\)\) throw/);
});

test('UNI-d: a module under a package’s vendor directory is that vendor’s, while the package’s own source is its own', () => {
  const generated = `${root}/packages/events/vendor/unicode-15.1.0/generated/x.ts`;
  assert.deepEqual(ownerOf(generated, at('events')), {
    kind: 'vendored',
    directory: `${root}/packages/events/vendor/unicode-15.1.0`,
  });
  // Bundled into another package it is still the vendor's, never that package's workspace code.
  assert.deepEqual(ownerOf(generated, at('core')), {
    kind: 'vendored',
    directory: `${root}/packages/events/vendor/unicode-15.1.0`,
  });
  assert.deepEqual(ownerOf(`${root}/packages/events/src/x.ts`, at('events')), { kind: 'own' });
  // A directory merely named vendor elsewhere in the package is not a vendored one.
  assert.deepEqual(ownerOf(`${root}/packages/events/src/vendor/x.ts`, at('events')), { kind: 'own' });
  assert.deepEqual(
    ownerOf('C:\\work\\repo\\packages\\events\\vendor\\unicode-15.1.0\\generated\\x.ts', {
      root: 'C:\\work\\repo',
      self: 'events',
    }),
    { kind: 'vendored', directory: 'C:/work/repo/packages/events/vendor/unicode-15.1.0' },
  );
});

test('UNI-d: a vendor directory is named by its NOTICE.json and licensed by its LICENSE, and one without is a problem', async () => {
  const directory = join(ROOT, 'packages', 'events', 'vendor', 'unicode-15.1.0');
  const problems = [];
  const entry = await vendoredEntry(directory, problems);
  assert.deepEqual(problems, []);
  const key = `${entry.manifest.name}@${entry.manifest.version}`;
  assert.equal(key, 'unicode-character-database@15.1.0');
  const notice = await noticeFor(key, entry, new Map(), problems);
  assert.deepEqual(problems, []);
  assert.equal(notice.split('\n')[1], 'unicode-character-database@15.1.0 — Unicode-3.0');
  assert.match(notice, /UNICODE LICENSE V3/);
  assert.deepEqual([...noticedIn(notice)], ['unicode-character-database@15.1.0']);

  const bare = await mkdtemp(join(tmpdir(), 'agentcomms-vendor-'));
  try {
    await writeFile(join(bare, 'LICENSE'), 'Some licence.\n');
    const missing = [];
    assert.equal(await vendoredEntry(bare, missing), null);
    assert.equal(missing.length, 1);
    assert.match(missing[0], /NOTICE\.json/);
    assert.ok(missing[0].includes(bare.replaceAll('\\', '/')), missing[0]);
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('UNI-d: the events package’s notices carry the Unicode licence because its build inlines the tables', async () => {
  const problems = [];
  const inlined = await inlinedInto('events', problems);
  assert.deepEqual(problems, []);
  assert.ok(inlined.has('unicode-character-database@15.1.0'), `the events bundle inlines ${[...inlined.keys()]}`);
  assert.ok(
    [...inlined.get('unicode-character-database@15.1.0').in].includes('packages/events/dist/index.mjs'),
    'the tables are in the published index',
  );
  const notices = await readFile(join(ROOT, 'packages', 'events', 'THIRD_PARTY_LICENSES'), 'utf8');
  assert.deepEqual(missingNotices(inlined.keys(), notices), []);
  // Deleted, the notice is owed again, which is what `pnpm verify:licenses` refuses.
  const withoutIt = notices.replace(/^unicode-character-database@15\.1\.0 — /m, 'deleted — ');
  assert.deepEqual(missingNotices(inlined.keys(), withoutIt), ['unicode-character-database@15.1.0']);
});
