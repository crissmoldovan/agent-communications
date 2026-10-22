import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CliCommandCaller } from '../src/cli-command.ts';
import { openCore } from '../src/core.ts';
import { releaseFactsReader, type UpdateDeps, updateCheck } from '../src/operations/update.ts';
import { PATH_OPTIONS } from '../src/paths.ts';
import { type DeclaredSince, declaredSince, factsOf } from '../src/release-facts.ts';
import { checkForUpdates, claimUpdateCheck } from '../src/update-check.ts';
import { securityNotice, updateToolNotice } from '../src/update-gate.ts';
import type { ReleaseRegistry } from '../src/update-release.ts';
import { changeUpdateCheck, readUpdateCheck } from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { loopbackRegistry, releaseWorld, type World, type WorldRelease } from './helpers/release-world.ts';
import { tempDir } from './helpers/temp.ts';
import { type Machine, machine, seed } from './helpers/update-machine.ts';

/*
 * The daily check and `update --check` believe what a release declares — a security fix, a decision it needs — only
 * from its verified tarball (design 2026-10-22 P1), and a check that cannot verify erases nothing (P2).
 *
 * Every release whose declaration matters is verified first, then read from the bytes whose sha512 its provenance
 * signs: the registry's document is read for which releases there are, and where each tarball is, never for what one
 * declares. A declaration that cannot be read is unknown, and the record then makes no claim: `release` is null,
 * never a stored `security: false`. A check with no verifier — a channel's — reads none, and keeps what core's
 * verified check left for the same release.
 *
 * The world here is the registry, npm's attestations and the tarballs, all stand-ins, with the real verifier over the
 * test's own trust root; one test runs core's CLI as a child against the world on 127.0.0.1, under the loopback seal.
 * Nothing reaches npm or Sigstore.
 */

const CORE = '@agentcomms/core';
const LATEST = '99.0.0';
const BEFORE = '98.0.0';
const FIXTURE_CLI = fileURLToPath(new URL('./fixtures/declared-core-cli.ts', import.meta.url));
const SEAL = pathToFileURL(
  fileURLToPath(new URL('../../../test/helpers/loopback-seal-preload.mjs', import.meta.url)),
).href;
/** A module of Gmail's own package in this checkout: a channel opening core, as its command and server do. */
const GMAIL_CALLER: CliCommandCaller = Object.freeze({
  url: new URL('../../gmail/src/caller.ts', import.meta.url).href,
  packageName: '@agentcomms/gmail',
});

function worldOf(...releases: WorldRelease[]): World {
  return releaseWorld({ [CORE]: LATEST }, releases);
}

/** Where `declaredSince` reads from: the world's registry, its verifier and its tarballs, and a state folder. */
function sources(world: World, stateDir = tempDir('comms-release-facts-')) {
  return { registry: world.registry, verify: world.verifyRelease, stateDir, tarballs: world.tarballs };
}

/** The update's stand-ins for a check with the world's reader: the latest is the world's, and nothing is installed. */
function checkDeps(m: Machine, world: World, verifier = true): UpdateDeps {
  return {
    latestVersion: async () => LATEST,
    globalPackages: async () => ({}),
    releaseFacts: releaseFactsReader(
      m.env,
      {
        registry: world.registry,
        tarballs: world.tarballs,
        ...(verifier ? { verifyRelease: world.verifyRelease } : {}),
      },
      m.stateDir,
    ),
  };
}

/** The record's `release` after one check through the world's reader. */
async function checked(world: World, verifier = true) {
  const m = machine();
  await updateCheck(m.core, m.env, checkDeps(m, world, verifier));
  return { m, release: (await readUpdateCheck(m.stateDir)).release };
}

test('each flag is read from the verified tarball whose packument says the other, both ways', async () => {
  const cases: { label: string; release: WorldRelease; security: boolean; needsDecision: boolean }[] = [
    {
      label: 'a security fix in the tarball, nothing in the registry',
      release: { version: LATEST, declares: { security: true }, registrySays: {} },
      security: true,
      needsDecision: false,
    },
    {
      label: 'a security fix in the registry, nothing in the tarball',
      release: { version: LATEST, declares: undefined, registrySays: { security: true } },
      security: false,
      needsDecision: false,
    },
    {
      label: 'a decision in the tarball, nothing in the registry',
      release: { version: LATEST, declares: { needsDecision: true }, registrySays: {} },
      security: false,
      needsDecision: true,
    },
    {
      label: 'a decision in the registry, nothing in the tarball',
      release: { version: LATEST, declares: undefined, registrySays: { needsDecision: true } },
      security: false,
      needsDecision: false,
    },
  ];
  for (const { label, release, security, needsDecision } of cases) {
    const world = worldOf(release);
    const declared = await declaredSince(sources(world), CORE, null, LATEST);
    assert.deepEqual(
      declared,
      { security, needsDecision, deciding: needsDecision ? [LATEST] : [], unread: [] },
      `${label}: declaredSince`,
    );
    assert.equal(world.tarballsAsked.length, 1, `${label}: its tarball was read`);
    // The same through the check, with a verifier: what the record keeps is the tarball's word.
    const { release: recorded } = await checked(worldOf(release));
    assert.deepEqual(recorded, { version: LATEST, security, needsDecision }, `${label}: the record`);
  }
});

test('a release in range that needs a decision is found from its tarball, though the registry says nothing', async () => {
  const world = worldOf(
    { version: '97.0.0' },
    { version: BEFORE, declares: { needsDecision: true }, registrySays: {} },
    { version: LATEST, registrySays: { needsDecision: true } },
  );
  const declared = await declaredSince(sources(world), CORE, '97.0.0', LATEST);
  assert.deepEqual(declared, { security: false, needsDecision: true, deciding: [BEFORE], unread: [] });
  assert.equal(world.registryAsked.length, 1, 'the registry document is read once');
  // Every release after 97.0.0 is verified, and read from its own tarball.
  assert.equal(world.attestationsAsked.length, 2);
  assert.equal(world.tarballsAsked.length, 2);
  // A decision is not ended by a later release that does not say so again.
  const { release } = await checked(world);
  assert.deepEqual(release, { version: LATEST, security: false, needsDecision: true });
});

test('an unread declaration makes no claim', async () => {
  // The latest's tarball cannot be had, from where the registry says or from npm's own address.
  const world = worldOf({ version: LATEST, declares: { security: true }, serve: 'missing' });
  const declared = await declaredSince(sources(world), CORE, null, LATEST);
  assert.deepEqual(declared, { security: null, needsDecision: null, deciding: [], unread: [LATEST] });
  assert.equal(factsOf(LATEST, declared), null);

  const { m, release } = await checked(worldOf({ version: LATEST, declares: { security: true }, serve: 'missing' }));
  assert.equal(release, null, 'the record makes no claim, and stores no false flag');
  const record = await readUpdateCheck(m.stateDir);
  assert.equal(record.latest, LATEST);
  assert.equal(record.behind, false);
  await seed(m, { behind: true });
  // No security line in a preview, and none in the server's notice.
  assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION }), null);
  const line = await updateToolNotice({ core: m.core, env: m.env, channel: 'core', running: VERSION, exempt: [] })(
    'comms_audit_tail',
  );
  assert.ok(line?.includes(`${LATEST} is out`), String(line));
  assert.doesNotMatch(String(line), /security/);

  // The same release with its tarball served: the claim is there, so the two above would have seen it.
  const known = await checked(worldOf({ version: LATEST, declares: { security: true } }));
  assert.deepEqual(known.release, { version: LATEST, security: true, needsDecision: false });
  await seed(known.m, { behind: true });
  assert.notEqual(await securityNotice({ core: known.m.core, env: known.m.env, running: VERSION }), null);
  const said = await updateToolNotice({
    core: known.m.core,
    env: known.m.env,
    channel: 'core',
    running: VERSION,
    exempt: [],
  })('comms_audit_tail');
  assert.match(String(said), /fixes a security problem/);

  // A release in range that cannot be read leaves whether a decision is needed unknown, not false.
  const range = worldOf(
    { version: BEFORE, declares: { needsDecision: true }, serve: 'missing' },
    { version: LATEST, declares: { security: true } },
  );
  const inRange = await declaredSince(sources(range), CORE, '97.0.0', LATEST);
  assert.deepEqual(inRange, { security: true, needsDecision: null, deciding: [], unread: [BEFORE] });
  assert.equal(factsOf(LATEST, inRange), null, 'the latest is known, and the range is not: no facts');
});

test("a release that does not verify is unread, never counted from the registry's word", async () => {
  for (const shape of ['missing', { subjectSha512: 'ab'.repeat(64) }] as const) {
    // Its registry document and its tarball both say it is a security fix; its attestation is not the release's.
    const world = worldOf({ version: LATEST, declares: { security: true }, registrySays: { security: true }, shape });
    const declared = await declaredSince(sources(world), CORE, null, LATEST);
    assert.deepEqual(
      declared,
      { security: null, needsDecision: null, deciding: [], unread: [LATEST] },
      JSON.stringify(shape),
    );
    assert.deepEqual(world.tarballsAsked, [], 'a release that did not verify is not downloaded');
    const { release } = await checked(
      worldOf({ version: LATEST, declares: { security: true }, registrySays: { security: true }, shape }),
    );
    assert.equal(release, null, JSON.stringify(shape));
  }
  // One in range: unread, so a decision it might need is not known — never "none needed".
  const range = worldOf(
    { version: BEFORE, declares: { needsDecision: true }, registrySays: { needsDecision: true }, shape: 'missing' },
    { version: LATEST },
  );
  assert.deepEqual(await declaredSince(sources(range), CORE, '97.0.0', LATEST), {
    security: false,
    needsDecision: null,
    deciding: [],
    unread: [BEFORE],
  });
  // A version the registry gives no integrity for is unread too: nothing to verify it against.
  const bare = worldOf({ version: LATEST, declares: { security: true } });
  const registry: ReleaseRegistry = async (packageName) => {
    const { packument } = await bare.registry(packageName);
    const versions = { ...packument.versions, [LATEST]: { ...packument.versions?.[LATEST], dist: {} } };
    return { packument: { ...packument, versions } };
  };
  assert.deepEqual(await declaredSince({ ...sources(bare), registry }, CORE, null, LATEST), {
    security: null,
    needsDecision: null,
    deciding: [],
    unread: [LATEST],
  });
  assert.deepEqual([bare.attestationsAsked, bare.tarballsAsked], [[], []], 'nothing was asked of it');
});

test('the record holds facts only when both are known, and a decision once any read release says so', () => {
  const known = (over: Partial<DeclaredSince>): DeclaredSince => ({
    security: false,
    needsDecision: false,
    deciding: [],
    unread: [],
    ...over,
  });
  assert.deepEqual(factsOf(LATEST, known({})), { version: LATEST, security: false, needsDecision: false });
  assert.deepEqual(factsOf(LATEST, known({ security: true, needsDecision: true, deciding: [BEFORE] })), {
    version: LATEST,
    security: true,
    needsDecision: true,
  });
  assert.equal(factsOf(LATEST, known({ security: null })), null);
  assert.equal(factsOf(LATEST, known({ needsDecision: null, unread: [BEFORE] })), null);
});

test('with no verifier, a check reads no declaration and keeps the verified one', async () => {
  const VERIFIED = { version: LATEST, security: true, needsDecision: false };
  // The registry says the release is no security fix: a check that believed it would store that.
  const world = worldOf({ version: LATEST, declares: { security: true }, registrySays: { security: false } });
  const m = machine();
  await seed(m, { latest: LATEST, behind: true, release: { ...VERIFIED } }, new Date(Date.now() - 25 * 3_600_000));
  assert.equal(releaseFactsReader(m.env, { registry: world.registry, tarballs: world.tarballs }, m.stateDir), null);
  await updateCheck(m.core, m.env, checkDeps(m, world, false));
  assert.deepEqual(world.tarballsAsked, [], 'nothing was downloaded');
  assert.deepEqual(world.attestationsAsked, [], 'nothing was verified');
  assert.deepEqual((await readUpdateCheck(m.stateDir)).release, VERIFIED, 'the verified release was kept');

  // A channel's own check, as it runs in its process: the registry npm reads, and no verifier at all.
  const served = await loopbackRegistry(world);
  try {
    const env = { ...m.env, npm_config_registry: served.url };
    const channel = openCore({ env, caller: GMAIL_CALLER });
    await seed(m, { latest: LATEST, release: { ...VERIFIED } }, new Date(Date.now() - 25 * 3_600_000));
    const outcome = await checkForUpdates(channel, env, { deps: { globalPackages: async () => ({}) } });
    assert.equal(outcome.asked, true);
    const record = await readUpdateCheck(m.stateDir);
    assert.equal(record.lastError, null, String(record.lastError));
    assert.deepEqual(record.release, VERIFIED, "a channel's check left the verified release as it was");
    assert.ok(!served.asked.some(({ url }) => url.endsWith('.tgz')), 'a channel downloaded a tarball');
  } finally {
    await served.close();
  }

  // A newer latest than the verified one: the record says nothing of it, never false flags.
  const newer = machine();
  await seed(newer, {
    latest: BEFORE,
    behind: true,
    release: { version: BEFORE, security: true, needsDecision: false },
  });
  await updateCheck(newer.core, newer.env, checkDeps(newer, world, false));
  const after = await readUpdateCheck(newer.stateDir);
  assert.equal(after.latest, LATEST);
  assert.equal(after.release, null);
});

test('a check with no verifier that cannot finish keeps the verified release of the latest it heard, and no other', async () => {
  const VERIFIED = { version: LATEST, security: true, needsDecision: false };
  const world = worldOf({ version: LATEST, declares: { security: true }, registrySays: { security: false } });
  const served = await loopbackRegistry(world);
  try {
    for (const [seeded, expected] of [
      [VERIFIED, VERIFIED],
      [{ ...VERIFIED, version: BEFORE }, null],
    ] as const) {
      const m = machine({ npm_config_registry: served.url });
      await seed(m, { latest: seeded.version, release: { ...seeded } }, new Date(Date.now() - 25 * 3_600_000));
      // Opened without its caller: the registry answers, and the report cannot be made, so the check records what it
      // knows — the latest, and why the rest is not — as a check that fails midway does.
      const bare = openCore({ env: m.env });
      const outcome = await checkForUpdates(bare, m.env, { deps: { globalPackages: async () => ({}) } });
      assert.equal(outcome.asked, true);
      const record = await readUpdateCheck(m.stateDir);
      assert.equal(record.latest, LATEST);
      assert.match(String(record.lastError), /opened without its caller/);
      assert.deepEqual(record.release, expected, `seeded ${seeded.version}`);
    }
  } finally {
    await served.close();
  }
});

test('a check whose declaration read fails keeps the facts already verified for that version, and no other', async () => {
  /*
   * A version on npm is never published twice, so what was verified of 99.0.0's tarball stays true: a read that fails
   * now — a tarball that cannot be had, an attestation that does not answer — leaves it as it was. A read that fails
   * for another version knows nothing of that one, and the record makes no claim.
   */
  const VERIFIED = { version: LATEST, security: true, needsDecision: false };
  const NEXT = '100.0.0';
  const unreadable = (version: string) =>
    releaseWorld({ [CORE]: version }, [{ version, declares: { security: true }, serve: 'missing' }]);
  const readers = (m: Machine, world: World, version: string): UpdateDeps => ({
    latestVersion: async () => version,
    globalPackages: async () => ({}),
    releaseFacts: releaseFactsReader(
      m.env,
      { registry: world.registry, verifyRelease: world.verifyRelease, tarballs: world.tarballs },
      m.stateDir,
    ),
  });
  for (const [version, expected] of [
    [LATEST, VERIFIED],
    [NEXT, null],
  ] as const) {
    // Through the check's own record.
    const m = machine();
    await seed(m, { latest: LATEST, behind: true, release: { ...VERIFIED } });
    const world = unreadable(version);
    await updateCheck(m.core, m.env, readers(m, world, version));
    assert.ok(world.tarballsAsked.length > 0, `${version}: its tarball was asked for`);
    const record = await readUpdateCheck(m.stateDir);
    assert.equal(record.latest, version);
    assert.deepEqual(record.release, expected, `${version}: the check's record`);

    // Through a check that cannot finish once the registry answered: what it knows is recorded by the same rule.
    const served = await loopbackRegistry(unreadable(version));
    try {
      const halfway = machine({ npm_config_registry: served.url });
      await seed(halfway, { latest: LATEST, release: { ...VERIFIED } }, new Date(Date.now() - 25 * 3_600_000));
      const inner = unreadable(version);
      const bare = openCore({ env: halfway.env });
      const outcome = await checkForUpdates(bare, halfway.env, {
        deps: {
          registry: inner.registry,
          verifyRelease: inner.verifyRelease,
          tarballs: inner.tarballs,
          globalPackages: async () => ({}),
        },
      });
      assert.equal(outcome.asked, true);
      assert.ok(inner.tarballsAsked.length > 0, `${version}: its tarball was asked for, halfway`);
      const after = await readUpdateCheck(halfway.stateDir);
      assert.equal(after.latest, version);
      assert.match(String(after.lastError), /opened without its caller/);
      assert.deepEqual(after.release, expected, `${version}: the record of a check that could not finish`);
    } finally {
      await served.close();
    }
  }
});

test("core's update-check-child writes the verified flags, and a channel's unverified check after it keeps them", async () => {
  // The same world the fixture CLI verifies with: 99.0.0 declares a security fix in its tarball, and its registry
  // document says nothing. The tarball's bytes are deterministic, so what is served here is what the child verifies.
  const world = releaseWorld({ [CORE]: LATEST }, [{ version: LATEST, declares: { security: true }, registrySays: {} }]);
  const served = await loopbackRegistry(world);
  const prefix = tempDir('comms-release-facts-npm-');
  mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
  mkdirSync(join(prefix, 'node_modules'), { recursive: true });
  try {
    const m = machine({
      npm_config_registry: served.url,
      npm_config_prefix: prefix,
      npm_config_update_notifier: 'false',
    });
    const claimedAt = await claimUpdateCheck(m.core);
    assert.ok(claimedAt !== null, 'the check is claimed');
    const pins = PATH_OPTIONS.flatMap(({ key, flag }) => [flag, m.core.paths[key]]);
    const ran = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          SEAL,
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          FIXTURE_CLI,
          ...pins,
          'update-check-child',
          claimedAt,
        ],
        { env: m.env, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(ran.code, 0, ran.stderr);
    const record = await readUpdateCheck(m.stateDir);
    assert.equal(record.checking, null, JSON.stringify(record));
    assert.deepEqual(record.release, { version: LATEST, security: true, needsDecision: false }, JSON.stringify(record));
    assert.ok(
      served.asked.some(({ url }) => url === `/tarballs/${CORE}/-/core-${LATEST}.tgz`),
      'the child read the tarball from where the registry said it is',
    );

    // The next day, a channel's own check, which has no verifier: it records the day, and keeps core's flags.
    await changeUpdateCheck(m.stateDir, (current) => ({
      record: { ...current, lastChecked: new Date(Date.now() - 25 * 3_600_000).toISOString() },
    }));
    const channel = openCore({ env: m.env, caller: GMAIL_CALLER });
    const outcome = await checkForUpdates(channel, m.env, { deps: { globalPackages: async () => ({}) } });
    assert.equal(outcome.asked, true);
    const after = await readUpdateCheck(m.stateDir);
    assert.notEqual(after.lastChecked, record.lastChecked, 'the channel checked');
    assert.deepEqual(after.release, { version: LATEST, security: true, needsDecision: false });
  } finally {
    await served.close();
  }
});
