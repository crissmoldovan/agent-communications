import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  changelogSection,
  coreReleaseFlags,
  DECISION_MARKER,
  releaseFlagProblems,
  SECURITY_MARKER,
} from '../scripts/release-flags.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

/**
 * What a release declares must be what its changelog says (update provenance, hardened, P1).
 *
 * Core may declare `"agentcommsRelease": { "security": true }`, `{ "needsDecision": true }` or both, and from 0.26.0
 * those flags are read from the verified tarball: they move a release's hold between 72 and 24 hours, turn its urgent
 * notice on, or keep it from installing in the background. Flags left in `packages/core/package.json` after a release
 * would apply to the next one too, so the release checks hold them to the version's own changelog section: a flag
 * without its marker line, or a marker line without its flag, refuses the release.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);

const VERSION = '1.2.3';
const NONE = Object.freeze({ security: false, needsDecision: false, needsDecisionSince: null });

/** The marker of each flag, and the two sentences a mismatch reads as, for `version`. */
const FLAGS = [
  ['security', SECURITY_MARKER],
  ['needsDecision', DECISION_MARKER],
];
const declaredWithout = (key, marker, version = VERSION) =>
  `packages/core/package.json declares "${key}": true, but the ## ${version} section of CHANGELOG.md has no line starting ${marker}`;
const markedWithout = (key, marker, version = VERSION) =>
  `the ## ${version} section of CHANGELOG.md has a line starting ${marker}, but packages/core/package.json does not declare "${key}": true`;
/** `flags` as core declares them: a release that declares a needed decision carries its own version (§8.1). */
const declaring = (flags, version = VERSION) =>
  flags.needsDecision ? { ...flags, needsDecisionSince: version } : flags;

/** A changelog whose `## 1.2.3` section carries `lines`, between an Unreleased section and an older release. */
function changelogWith(lines, { unreleased = [], older = [] } = {}) {
  return [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    ...unreleased,
    '',
    `## ${VERSION}`,
    '',
    '**Update provenance.** The release in one line.',
    '',
    ...lines,
    '',
    '**What changes when you update:**',
    '- a thing.',
    '',
    '## 1.2.2',
    '',
    'Older.',
    ...older,
    '',
  ].join('\n');
}

test('the markers are the two lines the changelog has always used for them', () => {
  assert.equal(SECURITY_MARKER, '**Security fix.**');
  assert.equal(DECISION_MARKER, '**Needs a decision before it installs.**');
});

test('flags and markers must match, both ways, for both flags', () => {
  for (const [key, marker] of FLAGS) {
    for (const declared of [true, false]) {
      for (const marked of [true, false]) {
        const flags = declaring({ ...NONE, [key]: declared });
        const changelog = changelogWith(marked ? [`${marker} What it fixes, in a sentence.`] : []);
        const expected =
          declared && !marked
            ? [declaredWithout(key, marker)]
            : !declared && marked
              ? [markedWithout(key, marker)]
              : [];
        assert.deepEqual(
          releaseFlagProblems({ version: VERSION, changelog, flags }),
          expected,
          `${key} ${declared ? 'declared' : 'not declared'}, its marker ${marked ? 'present' : 'absent'}`,
        );
      }
    }
  }

  // Both at once: each is checked on its own, security first, and both may be wrong together.
  const both = declaring({ ...NONE, security: true, needsDecision: true });
  assert.deepEqual(releaseFlagProblems({ version: VERSION, changelog: changelogWith([]), flags: both }), [
    declaredWithout('security', SECURITY_MARKER),
    declaredWithout('needsDecision', DECISION_MARKER),
  ]);
  const markedBoth = changelogWith([`${SECURITY_MARKER} A fix.`, '', `${DECISION_MARKER} A migration.`]);
  assert.deepEqual(releaseFlagProblems({ version: VERSION, changelog: markedBoth, flags: both }), []);
  assert.deepEqual(releaseFlagProblems({ version: VERSION, changelog: markedBoth, flags: NONE }), [
    markedWithout('security', SECURITY_MARKER),
    markedWithout('needsDecision', DECISION_MARKER),
  ]);
  // One right and one wrong names only the wrong one.
  assert.deepEqual(
    releaseFlagProblems({ version: VERSION, changelog: markedBoth, flags: { security: true, needsDecision: false } }),
    [markedWithout('needsDecision', DECISION_MARKER)],
  );
});

test('a marker counts only at the start of a line of the version’s own section', () => {
  for (const [key, marker] of FLAGS) {
    const declared = declaring({ ...NONE, [key]: true });
    // Each with what a release that declares nothing carries: the last one's decision is carried forward (§8.1), so
    // its marker asks this release for that, and for no flag of its own.
    const elsewhere = [
      // Indented: a list item's continuation, or a quoted line, is not the release saying it.
      [changelogWith([`  ${marker} Indented.`]), null],
      [changelogWith([`- ${marker} In a list.`]), null],
      [changelogWith([`> ${marker} Quoted.`]), null],
      // In the middle of a line.
      [changelogWith([`This release is not a ${marker}`]), null],
      // Under another version's heading: the next release's, still unreleased, and the last one's.
      [changelogWith([], { unreleased: [`${marker} Not yet.`] }), null],
      [changelogWith([], { older: ['', `${marker} Last time.`] }), key === 'needsDecision' ? '1.2.2' : null],
    ];
    for (const [changelog, carried] of elsewhere) {
      assert.deepEqual(
        releaseFlagProblems({ version: VERSION, changelog, flags: { ...NONE, needsDecisionSince: carried } }),
        [],
        `a marker that does not count asked for its flag:\n${changelog}`,
      );
      assert.deepEqual(
        releaseFlagProblems({ version: VERSION, changelog, flags: declared }),
        [declaredWithout(key, marker)],
        `a marker that does not count stood in for one:\n${changelog}`,
      );
    }
    // A `###` heading is part of the section, as the release notes read it; CRLF line endings change nothing.
    const counted = [
      changelogWith(['### Detail', '', `${marker} Under a sub-heading.`]),
      changelogWith([`${marker} With CRLF endings.`]).replaceAll('\n', '\r\n'),
    ];
    for (const changelog of counted) {
      assert.deepEqual(releaseFlagProblems({ version: VERSION, changelog, flags: declared }), [], changelog);
      assert.deepEqual(releaseFlagProblems({ version: VERSION, changelog, flags: NONE }), [markedWithout(key, marker)]);
    }
  }
});

test('no section is a problem', () => {
  const changelog = changelogWith([`${SECURITY_MARKER} A fix.`]);
  for (const flags of [NONE, { security: true, needsDecision: false }, { security: true, needsDecision: true }]) {
    assert.deepEqual(releaseFlagProblems({ version: '9.9.9', changelog, flags }), [
      'CHANGELOG.md has no "## 9.9.9" section',
    ]);
  }
  // A heading is matched whole: `1.2` is a prefix of `1.2.2` and `1.2.3`, and has no section of its own.
  assert.deepEqual(releaseFlagProblems({ version: '1.2', changelog, flags: NONE }), [
    'CHANGELOG.md has no "## 1.2" section',
  ]);
  assert.equal(changelogSection(changelog, '1.2'), null);
  assert.equal(changelogSection(changelog, '9.9.9'), null);

  // The section is the lines after its heading up to the next `## `, and the last one runs to the end.
  assert.equal(
    changelogSection(changelog, VERSION),
    [
      '',
      '**Update provenance.** The release in one line.',
      '',
      `${SECURITY_MARKER} A fix.`,
      '',
      '**What changes when you update:**',
      '- a thing.',
      '',
    ].join('\n'),
  );
  assert.equal(changelogSection(changelog, '1.2.2'), '\nOlder.\n');
});

// ── A needed decision, carried forward (design 2026-10-22 §8.1) ─────────────────────────────────────────────────

/**
 * Core's `needsDecisionSince` is the newest release, up to and including this one, that declared `needsDecision`. An
 * update reads it from the release it goes to, and from nothing else, so a release that drops it, or carries the
 * wrong one, lets a machine past a decision it never took. The check reads the carry from the changelog: the decision
 * marker of each `## X.Y.Z` section is what that release declared, since this check held each release's flag to it.
 */
const ownWrong = (version, described) =>
  `packages/core/package.json declares "needsDecision": true, so its "needsDecisionSince" must be "${version}", this release's own version, but it ${described}`;
const carryWrong = (version, previous, described) =>
  `the ## ${previous} section of CHANGELOG.md is the newest before ${version} with a line starting ${DECISION_MARKER}, so packages/core/package.json must carry "needsDecisionSince": "${previous}" forward, but it ${described}`;
const carryNone = (version, since) =>
  `no ## X.Y.Z section of CHANGELOG.md before ${version} has a line starting ${DECISION_MARKER}, so packages/core/package.json must not declare "needsDecisionSince", but it is "${since}"`;

/** A changelog of `sections`, newest first as the file keeps them: `[version, marked]` each, under an Unreleased one. */
function history(sections, { unreleased = [] } = {}) {
  return [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    ...unreleased,
    '',
    ...sections.flatMap(([version, marked]) => [
      `## ${version}`,
      '',
      `**Release ${version}.** In one line.`,
      '',
      ...(marked ? [`${DECISION_MARKER} A migration, said here.`, ''] : []),
    ]),
  ].join('\n');
}

const carried = (needsDecisionSince, over = {}) => ({ ...NONE, needsDecisionSince, ...over });

test('a release that declares a needed decision carries its own version', () => {
  const changelog = history([
    ['1.2.3', true],
    ['1.2.2', false],
    ['1.2.1', true],
  ]);
  const decided = { needsDecision: true };
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog, flags: carried('1.2.3', decided) }), []);
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog, flags: carried(null, decided) }), [
    ownWrong('1.2.3', 'declares none'),
  ]);
  // The last release's value is not this one's: this release is the newest that needs a decision.
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog, flags: carried('1.2.1', decided) }), [
    ownWrong('1.2.3', 'is "1.2.1"'),
  ]);
  // Declared without its marker: both are said, the marker first.
  const unmarked = history([
    ['1.2.3', false],
    ['1.2.2', false],
  ]);
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog: unmarked, flags: carried(null, decided) }), [
    declaredWithout('needsDecision', DECISION_MARKER),
    ownWrong('1.2.3', 'declares none'),
  ]);
});

test('every other release carries the last needed decision forward, both ways', () => {
  // 1.2.1 needed a decision, and 1.2.2 carried it: 1.2.3 carries it too, though no section since says so again.
  const changelog = history([
    ['1.2.3', false],
    ['1.2.2', false],
    ['1.2.1', true],
    ['1.2.0', true],
  ]);
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog, flags: carried('1.2.1') }), []);
  // Missing: a machine on 1.2.0 would go past 1.2.1's decision.
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog, flags: NONE }), [
    carryWrong('1.2.3', '1.2.1', 'declares none'),
  ]);
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog, flags: carried(null) }), [
    carryWrong('1.2.3', '1.2.1', 'declares none'),
  ]);
  // Wrong: an older decision, this release's own version, or one that is no release at all.
  for (const since of ['1.2.0', '1.2.3', '1.2.2', '9.9.9']) {
    assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog, flags: carried(since) }), [
      carryWrong('1.2.3', '1.2.1', `is "${since}"`),
    ]);
  }
  // None before it: nothing may be carried.
  const none = history([
    ['1.2.3', false],
    ['1.2.2', false],
  ]);
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog: none, flags: NONE }), []);
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog: none, flags: carried('1.2.2') }), [
    carryNone('1.2.3', '1.2.2'),
  ]);
});

test('the carry is the newest release before this one by version, not the next section down, and counts no Unreleased line', () => {
  // A backport released after 0.26.0 sits above it in the file, and comes before it: it carries nothing of 0.26.0's.
  const changelog = history([
    ['0.26.1', false],
    ['0.25.4', false],
    ['0.26.0', true],
    ['0.25.3', false],
  ]);
  assert.deepEqual(releaseFlagProblems({ version: '0.25.4', changelog, flags: NONE }), []);
  assert.deepEqual(releaseFlagProblems({ version: '0.25.4', changelog, flags: carried('0.26.0') }), [
    carryNone('0.25.4', '0.26.0'),
  ]);
  assert.deepEqual(releaseFlagProblems({ version: '0.26.1', changelog, flags: carried('0.26.0') }), []);
  assert.deepEqual(releaseFlagProblems({ version: '0.26.1', changelog, flags: NONE }), [
    carryWrong('0.26.1', '0.26.0', 'declares none'),
  ]);
  // Two decisions, the newer line's further down the file: the newest by version is carried.
  const both = history([
    ['0.26.1', false],
    ['0.25.4', true],
    ['0.26.0', true],
  ]);
  assert.deepEqual(releaseFlagProblems({ version: '0.26.1', changelog: both, flags: carried('0.26.0') }), []);
  assert.deepEqual(releaseFlagProblems({ version: '0.26.1', changelog: both, flags: carried('0.25.4') }), [
    carryWrong('0.26.1', '0.26.0', 'is "0.25.4"'),
  ]);
  // Numbers compare as numbers: 0.10.0 comes after 0.9.0.
  const numeric = history([
    ['0.10.1', false],
    ['0.10.0', true],
    ['0.9.0', true],
  ]);
  assert.deepEqual(releaseFlagProblems({ version: '0.10.1', changelog: numeric, flags: carried('0.10.0') }), []);
  // What is still under Unreleased is no release, and carries nothing.
  const unreleased = history([['1.2.3', false]], { unreleased: [`${DECISION_MARKER} Not yet.`] });
  assert.deepEqual(releaseFlagProblems({ version: '1.2.3', changelog: unreleased, flags: NONE }), []);
});

// ── The command the tag gate and a person run ───────────────────────────────────────────────────────────────────

/**
 * A copy of the release's scripts and every package manifest — what the flag check reads, and nothing else — so a
 * test can set core's declaration and the changelog without touching this checkout's.
 */
async function releaseTree() {
  const root = await tempDir('release-flags-');
  await cp(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await mkdir(join(root, 'packages', entry.name), { recursive: true });
    await cp(join(ROOT, 'packages', entry.name, 'package.json'), join(root, 'packages', entry.name, 'package.json'));
    const declaration = JSON.parse(
      await readFile(join(ROOT, 'packages', entry.name, 'package.json'), 'utf8'),
    ).agentcommsPackage;
    if (declaration?.kind !== 'service') continue;
    // A service's declared paths are checked by the registry, so they come too.
    for (const path of [declaration.server.entry, declaration.operations]) {
      const target = join(root, 'packages', entry.name, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(ROOT, 'packages', entry.name, path), target, { recursive: true });
    }
    if (declaration.skills?.contract) {
      const target = join(root, declaration.skills.contract);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(ROOT, declaration.skills.contract), target);
    }
  }
  // The copied core declares whatever this release is; every test here starts from nothing declared.
  await declare(root, undefined);
  return root;
}

/** Sets core's `agentcommsRelease` in the copy at `root`; `undefined` removes it. */
async function declare(root, release) {
  const path = join(root, 'packages', 'core', 'package.json');
  const { agentcommsRelease: _old, ...core } = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(
    path,
    `${JSON.stringify(release === undefined ? core : { ...core, agentcommsRelease: release }, null, 2)}\n`,
  );
}

/** Runs the copy's `scripts/release-flags.mjs`; its exit status and output, a refusal being an answer. */
async function flagCheck(root, args, env = {}) {
  const environment = { ...process.env, ...env };
  if (!Object.hasOwn(env, 'RELEASE_CHANGELOG')) delete environment.RELEASE_CHANGELOG;
  try {
    const { stdout, stderr } = await exec(process.execPath, [join(root, 'scripts', 'release-flags.mjs'), ...args], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { status: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

const errorsOf = (output) => output.split(/\r?\n/).filter((line) => line.startsWith('::error::'));

test('the CLI exits 1 and prints ::error:: for each problem, 0 when they match', async () => {
  const root = await releaseTree();
  const changelog = join(root, 'CHANGELOG.md');

  // Nothing declared and no marker: what almost every release is.
  await writeFile(changelog, changelogWith([]));
  const plain = await flagCheck(root, [VERSION]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(errorsOf(plain.stdout + plain.stderr), []);

  // What core declares is read from the tree's own registry, which both release paths ask.
  assert.deepEqual(coreReleaseFlags(root), NONE);
  // A flag left from the last release: core still declares it, and this version's section does not say so.
  await declare(root, { security: true });
  assert.deepEqual(coreReleaseFlags(root), { security: true, needsDecision: false, needsDecisionSince: null });
  const left = await flagCheck(root, [VERSION]);
  assert.equal(left.status, 1);
  assert.deepEqual(errorsOf(left.stderr), [`::error::${declaredWithout('security', SECURITY_MARKER)}`]);

  // Both left: one line for each.
  await declare(root, { security: true, needsDecision: true, needsDecisionSince: VERSION });
  const both = await flagCheck(root, [VERSION]);
  assert.equal(both.status, 1);
  assert.deepEqual(errorsOf(both.stderr), [
    `::error::${declaredWithout('security', SECURITY_MARKER)}`,
    `::error::${declaredWithout('needsDecision', DECISION_MARKER)}`,
  ]);

  // Declared and said: it passes.
  await writeFile(changelog, changelogWith([`${SECURITY_MARKER} A fix.`, '', `${DECISION_MARKER} A migration.`]));
  const said = await flagCheck(root, [VERSION]);
  assert.equal(said.status, 0, said.stderr);
  assert.deepEqual(errorsOf(said.stdout + said.stderr), []);

  // Said and not declared, read from the changelog RELEASE_CHANGELOG names, as `release-ci.mjs notes` reads it.
  await declare(root, { needsDecision: true, security: false, needsDecisionSince: VERSION });
  const elsewhere = join(root, 'elsewhere.md');
  await writeFile(elsewhere, changelogWith([`${SECURITY_MARKER} A fix.`]));
  const unsaid = await flagCheck(root, [VERSION], { RELEASE_CHANGELOG: elsewhere });
  assert.equal(unsaid.status, 1);
  assert.deepEqual(errorsOf(unsaid.stderr), [
    `::error::${markedWithout('security', SECURITY_MARKER)}`,
    `::error::${declaredWithout('needsDecision', DECISION_MARKER)}`,
  ]);

  // No section for the version, and no version at all.
  await declare(root, undefined);
  const missing = await flagCheck(root, ['9.9.9']);
  assert.equal(missing.status, 1);
  assert.deepEqual(errorsOf(missing.stderr), ['::error::CHANGELOG.md has no "## 9.9.9" section']);
  const usage = await flagCheck(root, []);
  assert.equal(usage.status, 1);
  assert.deepEqual(errorsOf(usage.stderr), ['::error::usage: release-flags.mjs <version>']);
});

test('the CLI refuses a needed decision not carried forward, and passes the carry', async () => {
  const root = await releaseTree();
  await writeFile(
    join(root, 'CHANGELOG.md'),
    history([
      [VERSION, false],
      ['1.2.2', true],
    ]),
  );
  // The last release needed a decision, and core's package.json dropped it with the flag.
  await declare(root, undefined);
  const dropped = await flagCheck(root, [VERSION]);
  assert.equal(dropped.status, 1);
  assert.deepEqual(errorsOf(dropped.stderr), [`::error::${carryWrong(VERSION, '1.2.2', 'declares none')}`]);

  await declare(root, { needsDecisionSince: '1.2.2' });
  assert.deepEqual(coreReleaseFlags(root), carried('1.2.2'));
  const kept = await flagCheck(root, [VERSION]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /needsDecisionSince 1\.2\.2/);
});
