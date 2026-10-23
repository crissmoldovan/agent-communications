import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { launcherName, switchPointer } from '../src/launcher.ts';
import { managedRuntimeDir, managedRuntimeEntry } from '../src/mcp-install.ts';
import { releaseFactsReader } from '../src/operations/update.ts';
import * as releaseFacts from '../src/release-facts.ts';
import { canonicalTarballUrl, type TarballFetch } from '../src/release-tarball.ts';
import { type BackgroundDeps, runBackgroundUpdate } from '../src/update-background.ts';
import { askUnderClaim, claimUpdateCheck } from '../src/update-check.ts';
import type { ReleaseRegistry, ReleaseVerifier } from '../src/update-release.ts';
import {
  changeUpdateCheck,
  readUpdateCheck,
  UPDATE_CHECK_LEASE_MS,
  type UpdateCheckRecord,
} from '../src/update-state.ts';
import { fixtureTarballUrl } from './helpers/provenance-fixture.ts';
import { loopbackRegistry, releaseWorld, type World, type WorldRelease } from './helpers/release-world.ts';
import { tempDir } from './helpers/temp.ts';
import { machine as noticeMachine } from './helpers/update-machine.ts';

/*
 * A needed decision is carried forward in the verified release, not found by listing releases (design 2026-10-22 §8.1,
 * review A's findings 2–4), and one check reads its target's declaration once, within its claim's lease (review B's
 * finding 2).
 *
 * A release that declares `needsDecision` carries its own version as `needsDecisionSince`; every later release carries
 * the same value forward, as the release check holds it to. So a machine at A updating to B reads B's verified
 * declaration and nothing else: B needs a decision when B declares one, or when B's `needsDecisionSince` is after A.
 * Which versions the registry lists decides nothing — a hidden release, a junk version or five hundred of them change
 * no fact and cost no request.
 *
 * The world is `helpers/release-world.ts`: the registry, npm's attestations and the tarballs as stand-ins, with the real
 * verifier over the test's own trust root. Nothing reaches npm or Sigstore, and nothing is installed.
 */

const CORE = '@agentcomms/core';
const GMAIL = '@agentcomms/gmail';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

/** 0.20.1 needs a decision; 0.20.2, the latest, carries it forward. A machine on 0.20.0 has not taken it. */
const CARRIED: WorldRelease[] = [
  { version: '0.20.0', signedAt: hoursAgo(900) },
  { version: '0.20.1', signedAt: hoursAgo(300), declares: { needsDecision: true, needsDecisionSince: '0.20.1' } },
  { version: '0.20.2', signedAt: hoursAgo(100), declares: { needsDecisionSince: '0.20.1' } },
];

interface Launched {
  env: NodeJS.ProcessEnv;
  core: Core;
}

/** A home of the test's own, with core's folders under it, and the check and the background run on. */
function home(): Launched {
  const root = tempDir('comms-needed-decision-');
  const env = {
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    PATH: join(root, 'bin'),
    AGENT_COMMS_CONFIG_DIR: join(root, 'config'),
    AGENT_COMMS_STATE_DIR: join(root, 'state'),
    AGENT_COMMS_DATA_DIR: join(root, 'data'),
    AGENT_COMMS_SECRETS_DIR: join(root, 'secrets'),
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    NO_COLOR: '1',
  };
  mkdirSync(env.AGENT_COMMS_CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(env.AGENT_COMMS_CONFIG_DIR, 'config.json'),
    JSON.stringify({ version: 2, secrets: { store: 'file' } }),
  );
  return { env, core: openCore({ env, caller: CORE_CALLER }) };
}

/** A runtime as npm leaves one: the package, its manifest, and the lockfile with the integrity of its own tarball. */
function runtime(m: Launched, packageName: string, version: string, integrity: string): string {
  const root = managedRuntimeDir(m.core.paths.dataDir, packageName, version);
  const cli = managedRuntimeEntry(m.core.paths.dataDir, packageName, version);
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, 'process.exit(0);\n');
  writeFileSync(join(dirname(dirname(cli)), 'package.json'), JSON.stringify({ name: packageName, version }));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, dependencies: { [packageName]: version } }),
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${packageName}`]: { version, integrity } } }),
  );
  return root;
}

/** Core and Gmail on stable launchers at `from`, and one background run against `world` through `registry`. */
async function backgroundRun(world: World, from: string, registry: ReleaseRegistry = world.registry) {
  const m = home();
  for (const packageName of [CORE, GMAIL]) {
    await switchPointer(
      m.core.paths.dataDir,
      launcherName(packageName),
      runtime(m, packageName, from, world.integrity(packageName, from)),
    );
  }
  const installs: string[] = [];
  const deps: BackgroundDeps = {
    settings: { level: () => 'auto', pausedUntil: () => undefined, background: () => true },
    registry,
    provenance: { fetch: world.attestations, verifyBundle: world.verifyBundle },
    tarballs: world.tarballs,
    install: async (packageName: string, version: string) => {
      installs.push(`${packageName}@${version}`);
      return runtime(m, packageName, version, world.integrity(packageName, version));
    },
    selfCheck: async () => ({ ok: true, detail: 'a stand-in' }),
    processes: async () => [],
    now: () => NOW,
    job: { run: async () => ({ status: 0, stdout: '', stderr: '' }), uid: 501, random: () => 0.5, now: () => NOW },
    platform: 'linux',
  };
  const result = await runBackgroundUpdate(m.core, m.env, {}, deps);
  return { result, installs };
}

/** The check's reader of core's releases, through `registry`, with the world's verifier and tarballs. */
function readerOf(world: World, registry: ReleaseRegistry = world.registry) {
  const read = releaseFactsReader(
    {},
    { registry, verifyRelease: world.verifyRelease, tarballs: world.tarballs },
    tempDir('comms-needed-decision-state-'),
  );
  assert.ok(read !== null, 'a reader with a verifier');
  return read;
}

/** The world's registry, with `versions` of core left out of its document. */
function hiding(world: World, ...versions: string[]): ReleaseRegistry {
  return async (packageName) => {
    const answer = await world.registry(packageName);
    if (packageName !== CORE) return answer;
    const listed = { ...answer.packument.versions };
    for (const version of versions) delete listed[version];
    return { ...answer, packument: { ...answer.packument, versions: listed } };
  };
}

// ── Review A, finding 2: a registry that hides the release needing a decision ────────────────────────────────────

test('a registry that leaves out the release needing a decision still has the next one wait for the person', async () => {
  // The release that needs the decision is genuine and served, but the registry's document no longer lists it.
  const shown = releaseWorld({ [CORE]: '0.20.2', [GMAIL]: '0.20.2' }, CARRIED);
  const listed = await backgroundRun(shown, '0.20.0');
  assert.equal(listed.result.outcome, 'skipped', listed.result.reason);
  assert.match(listed.result.reason, /needs a decision from the person \(0\.20\.1 says so\)$/);

  const hidden = releaseWorld({ [CORE]: '0.20.2', [GMAIL]: '0.20.2' }, CARRIED);
  const left = await backgroundRun(hidden, '0.20.0', hiding(hidden, '0.20.1'));
  assert.equal(left.result.outcome, 'skipped', left.result.reason);
  assert.match(left.result.reason, /needs a decision from the person \(0\.20\.1 says so\)$/);
  assert.deepEqual(left.installs, [], 'nothing was installed');
  assert.ok(!hidden.attestationsAsked.some((url) => url.endsWith('@0.20.1')), 'no listed release was asked about');

  // The daily check and `update --check` read it the same way: a decision, from 0.20.2's own verified tarball.
  const world = releaseWorld({ [CORE]: '0.20.2' }, CARRIED);
  const read = readerOf(world, hiding(world, '0.20.1'));
  assert.deepEqual(await read(CORE, '0.20.2', '0.20.0'), { security: false, needsDecision: true });
  assert.deepEqual(world.tarballsAsked, [fixtureTarballUrl(CORE, '0.20.2')], "only the target's tarball is read");
});

test('a decision taken already does not wait again, and one the target carries counts from the oldest release here', async () => {
  // A machine on 0.20.1 installed the release that needed the decision: the person took it then.
  const world = releaseWorld({ [CORE]: '0.20.2', [GMAIL]: '0.20.2' }, CARRIED);
  const taken = await backgroundRun(world, '0.20.1');
  assert.equal(taken.result.outcome, 'installed', taken.result.reason);
  assert.deepEqual(taken.installs, [`${CORE}@0.20.2`, `${GMAIL}@0.20.2`]);

  // The check reads one declaration, and each machine's answer is its own: the oldest release here decides.
  const read = readerOf(releaseWorld({ [CORE]: '0.20.2' }, CARRIED));
  assert.deepEqual(await read(CORE, '0.20.2', '0.20.1'), { security: false, needsDecision: false });
  assert.deepEqual(await read(CORE, '0.20.2', '0.20.2'), { security: false, needsDecision: false });
  assert.deepEqual(await read(CORE, '0.20.2', '0.19.9'), { security: false, needsDecision: true });

  // The target that declares one itself carries its own version: it waits from any release before it.
  const own = readerOf(
    releaseWorld({ [CORE]: '0.20.1' }, [
      { version: '0.20.1', declares: { needsDecision: true, needsDecisionSince: '0.20.1' } },
    ]),
  );
  assert.deepEqual(await own(CORE, '0.20.1', '0.20.0'), { security: false, needsDecision: true });
});

test("a needsDecisionSince the release cannot read waits for the person, and the registry's never counts", async () => {
  for (const since of ['soon', '0.20', '^0.20.1', 3, true, {}]) {
    const read = readerOf(
      releaseWorld({ [CORE]: '0.20.2' }, [{ version: '0.20.2', declares: { needsDecisionSince: since } }]),
    );
    assert.deepEqual(
      await read(CORE, '0.20.2', '0.20.1'),
      { security: false, needsDecision: true },
      JSON.stringify(since),
    );
  }
  // The registry's copy says a decision is carried, and the verified tarball carries none: no decision.
  const registryOnly = readerOf(
    releaseWorld({ [CORE]: '0.20.2' }, [
      { version: '0.20.2', registrySays: { needsDecisionSince: '0.20.2' }, declares: {} },
    ]),
  );
  assert.deepEqual(await registryOnly(CORE, '0.20.2', '0.20.0'), { security: false, needsDecision: false });
  // And the other way: the tarball carries it, the registry's copy says nothing.
  const tarballOnly = readerOf(
    releaseWorld({ [CORE]: '0.20.2' }, [
      { version: '0.20.2', declares: { needsDecisionSince: '0.20.1' }, registrySays: {} },
    ]),
  );
  assert.deepEqual(await tarballOnly(CORE, '0.20.2', '0.20.0'), { security: false, needsDecision: true });
});

// ── Review A, finding 3: a junk version in range ─────────────────────────────────────────────────────────────────

test('a junk version in range that does not verify leaves a verified security claim as it is', async () => {
  // A mirror lists 0.20.1, which npm's endpoint has no attestation for, between the machine's release and the fix.
  const releases: WorldRelease[] = [
    { version: '0.20.0', signedAt: hoursAgo(900) },
    { version: '0.20.1', signedAt: hoursAgo(300), shape: 'missing' },
    { version: '0.20.2', signedAt: hoursAgo(30), declares: { security: true } },
  ];
  const world = releaseWorld({ [CORE]: '0.20.2' }, releases);
  const read = readerOf(world);
  assert.deepEqual(await read(CORE, '0.20.2', '0.20.0'), { security: true, needsDecision: false });
  assert.ok(!world.attestationsAsked.some((url) => url.endsWith('@0.20.1')), 'the junk version was asked about');

  // The background run installs the verified fix after its 24 hours, the junk version unread.
  const background = releaseWorld({ [CORE]: '0.20.2', [GMAIL]: '0.20.2' }, releases);
  const run = await backgroundRun(background, '0.20.0');
  assert.equal(run.result.outcome, 'installed', run.result.reason);
  assert.equal(run.result.release?.security, true);
  assert.equal(run.result.release?.holdHours, 24);
});

// ── Review A, finding 4: a flood of listed versions ──────────────────────────────────────────────────────────────

test('500 listed versions cost one attestation request and one declaration read', async () => {
  const flood =
    (world: World): ReleaseRegistry =>
    async (packageName) => {
      const answer = await world.registry(packageName);
      if (packageName !== CORE) return answer;
      const versions = { ...answer.packument.versions };
      const genuine = versions['0.21.0']?.dist?.integrity;
      for (let patch = 1; patch <= 500; patch += 1) {
        versions[`0.20.${patch}`] = { dist: { integrity: genuine, tarball: 'https://mirror.invalid/junk.tgz' } };
      }
      return { ...answer, packument: { ...answer.packument, versions } };
    };
  const releases: WorldRelease[] = [
    { version: '0.20.0', signedAt: hoursAgo(900) },
    { version: '0.21.0', signedAt: hoursAgo(100) },
  ];
  const world = releaseWorld({ [CORE]: '0.21.0' }, releases);
  const read = readerOf(world, flood(world));
  assert.deepEqual(await read(CORE, '0.21.0', '0.20.0'), { security: false, needsDecision: false });
  assert.equal(world.attestationsAsked.length, 1, 'one attestation request');
  assert.equal(world.tarballsAsked.length, 1, 'one declaration read');

  // The background run asks for core's once, and Gmail's once: none for a listed version.
  const background = releaseWorld({ [CORE]: '0.21.0', [GMAIL]: '0.21.0' }, releases);
  const run = await backgroundRun(background, '0.20.0', flood(background));
  assert.equal(run.result.outcome, 'installed', run.result.reason);
  assert.equal(background.attestationsAsked.length, 2, background.attestationsAsked.join('\n'));
  assert.deepEqual(background.tarballsAsked, [fixtureTarballUrl(CORE, '0.21.0')]);
});

// ── Review B, finding 2: one check, one read of its target, within its lease ───────────────────────────────────────

/** A machine whose check is a day old: the next check is due, and claimed by the caller. */
async function dueMachine() {
  const m = noticeMachine();
  mkdirSync(m.stateDir, { recursive: true });
  await changeUpdateCheck(m.stateDir, (record) => ({
    record: { ...record, lastChecked: new Date(Date.now() - 30 * 3_600_000).toISOString() },
  }));
  return m;
}

/**
 * What the check found was written under its own claim, inside its lease: the claim is given up, and the day's check is
 * recorded — which `recordFound` does only while the file still holds that claim — less than a lease after it.
 */
function recordedUnder(record: UpdateCheckRecord, claimedAt: string): void {
  assert.equal(record.checking, null, 'the claim is still held');
  assert.ok(
    record.lastChecked !== null && record.lastChecked >= claimedAt,
    `not recorded: ${String(record.lastChecked)}`,
  );
  assert.ok(Date.parse(record.lastChecked) - Date.parse(claimedAt) < UPDATE_CHECK_LEASE_MS, 'recorded past its lease');
}

test("one check reads an unreadable target's tarball at most twice: its location, then npm's own address", async () => {
  const LATEST = '99.0.0';
  const m = await dueMachine();
  const world = releaseWorld({ [CORE]: LATEST }, [{ version: LATEST, serve: 'missing' }]);
  const sources = { registry: world.registry, verifyRelease: world.verifyRelease, tarballs: world.tarballs };
  const claimedAt = await claimUpdateCheck(m.core);
  assert.ok(claimedAt !== null, 'the check is claimed');
  // The reader the ask makes for itself, handed in only because a stand-in `latestVersion` makes none.
  await askUnderClaim(m.core, m.env, claimedAt, {
    deps: {
      ...sources,
      latestVersion: async () => LATEST,
      globalPackages: async () => ({}),
      releaseFacts: releaseFactsReader(m.env, sources, m.stateDir),
    },
  });
  assert.deepEqual(world.tarballsAsked, [fixtureTarballUrl(CORE, LATEST), canonicalTarballUrl(CORE, LATEST)]);
  assert.equal(world.attestationsAsked.length, 1, 'verified once');
  const record = await readUpdateCheck(m.stateDir);
  recordedUnder(record, claimedAt);
  assert.equal(record.latest, LATEST);
  assert.equal(record.release, null, 'no claim either way');
});

test("a check whose target's tarball stalls records within its lease, unknown and never false", {
  timeout: 20_000,
}, async () => {
  const LATEST = '99.0.0';
  const m = await dueMachine();
  const world = releaseWorld({ [CORE]: LATEST }, [{ version: LATEST, declares: { security: true } }]);
  // A mirror that takes the request and never answers: only the read's own deadline ends it.
  const asked: string[] = [];
  const signals: AbortSignal[] = [];
  const stalled: TarballFetch = (url, init) => {
    asked.push(url);
    signals.push(init.signal);
    return new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  const sources = { registry: world.registry, verifyRelease: world.verifyRelease, tarballs: stalled };
  // sigstore-js loaded and the trust root read before the clock starts: the test's short deadline is for the tarball,
  // and a cold first verification on a loaded machine could outlast it before the tarball is even asked for.
  assert.ok(
    (await world.verifyRelease({ packageName: CORE, version: LATEST, integrity: world.integrity(CORE, LATEST) })).ok,
  );
  const claimedAt = await claimUpdateCheck(m.core);
  assert.ok(claimedAt !== null, 'the check is claimed');
  const started = Date.now();
  await askUnderClaim(m.core, m.env, claimedAt, {
    deps: {
      ...sources,
      latestVersion: async () => LATEST,
      globalPackages: async () => ({}),
      releaseFacts: releaseFactsReader(m.env, sources, m.stateDir, { deadlineMs: 2_000 }),
    },
  });
  assert.ok(Date.now() - started < 10_000, 'the check waited past its deadline');
  // Past the deadline nothing more is asked: not npm's own address, and not the same tarball for the second reader.
  assert.deepEqual(asked, [fixtureTarballUrl(CORE, LATEST)], 'the deadline passed before the tarball was asked for');
  // And what was asked is cut off then, not left to run on for its own minute.
  assert.ok(signals.length > 0 && signals.every((signal) => signal.aborted), 'the stalled request was not cut off');
  const record = await readUpdateCheck(m.stateDir);
  recordedUnder(record, claimedAt);
  assert.equal(record.latest, LATEST);
  assert.equal(record.release, null, 'unknown: no security claim, and never a stored false');

  // The deadline a check's reader has unless a test hands it another: the rest of the ask — the registry's 10 seconds,
  // `npm ls`'s minute, the record's lock — fits beside it in the lease.
  const deadline = (releaseFacts as Record<string, unknown>).DECLARATION_DEADLINE_MS;
  assert.equal(typeof deadline, 'number', 'the read has a deadline');
  assert.ok((deadline as number) <= UPDATE_CHECK_LEASE_MS / 4, `${String(deadline)} ms is not well inside the lease`);
});

// ── The day's own reader: its reads stop a fixed time into its claim, whenever the ask began ────────────────────────

/*
 * The deadline counts from the claim, not from when the read starts (review B of 0.26.0, finding 2): the claim is
 * taken by the command, and the ask that reads may be a child started seconds later on a loaded machine, after the
 * registry's `latest` took its own ten. Each claim here is taken as if the check began `DECLARATION_DEADLINE_MS` less
 * a few seconds ago, so its reads must stop a few seconds from now. Nothing is handed in but the registry, the
 * verifier and the tarballs: the latest comes from the world on 127.0.0.1, so the ask makes its own reader, as it does
 * in core's update-check child.
 */
const READS_LEFT_MS = 4_000;

/** A claim as if the check began `DECLARATION_DEADLINE_MS - READS_LEFT_MS` ago. */
async function lateClaim(core: Core): Promise<string> {
  const claimedAt = await claimUpdateCheck(core, {
    now: () => new Date(Date.now() - releaseFacts.DECLARATION_DEADLINE_MS + READS_LEFT_MS),
  });
  assert.ok(claimedAt !== null, 'the check is claimed');
  return claimedAt;
}

test("the day's check stops reading a fixed time into its claim, whatever stalls, and records under it", {
  timeout: 60_000,
}, async () => {
  const LATEST = '99.0.0';
  // A request taken and never answered, and an attestations endpoint that never answers: only the deadline ends them.
  const signals: AbortSignal[] = [];
  const stalled: TarballFetch = (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_, failed) => {
      if (signal.aborted) failed(signal.reason);
      signal.addEventListener('abort', () => failed(signal.reason), { once: true });
    });
  };
  const unanswered: ReleaseVerifier = () => new Promise(() => undefined);
  for (const stall of ['a mirror that never answers', 'an attestations endpoint that never answers'] as const) {
    signals.length = 0;
    const world = releaseWorld({ [CORE]: LATEST }, [{ version: LATEST, declares: { security: true } }]);
    // sigstore-js loaded before the clock starts, so a cold first verification does not use the reads' time up.
    assert.ok(
      (await world.verifyRelease({ packageName: CORE, version: LATEST, integrity: world.integrity(CORE, LATEST) })).ok,
    );
    const served = await loopbackRegistry(world);
    try {
      const m = noticeMachine({ npm_config_registry: served.url });
      await dueMachineAt(m);
      const claimedAt = await lateClaim(m.core);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        askUnderClaim(m.core, m.env, claimedAt, {
          deps: {
            registry: world.registry,
            verifyRelease: stall === 'a mirror that never answers' ? world.verifyRelease : unanswered,
            tarballs: stall === 'a mirror that never answers' ? stalled : world.tarballs,
            globalPackages: async () => ({}),
          },
        }).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(resolve, READS_LEFT_MS + 15_000, false);
        }),
      ]);
      clearTimeout(timer);
      assert.ok(finished, `${stall}: still reading 15 s after its reads were to stop`);
      const record = await readUpdateCheck(m.stateDir);
      recordedUnder(record, claimedAt);
      assert.deepEqual([record.latest, record.release], [LATEST, null], `${stall}: ${JSON.stringify(record)}`);
      // What was asked for was cut off when the reads stopped, and npm's own address was not asked after that.
      assert.ok(signals.length <= 1, `${stall}: asked ${signals.length} times`);
      assert.ok(
        signals.every((signal) => signal.aborted),
        `${stall}: a download went on after its check`,
      );
    } finally {
      await served.close();
    }
  }
});

test('a release the check read before its reads stopped still counts when the check asks again after', {
  timeout: 60_000,
}, async () => {
  // The check reads the latest for this release, runs `npm ls`, then asks again for the oldest release here; `npm ls`
  // can take a minute, so the second asking often comes after the reads stop. What was read stands: the record keeps
  // the verified security fix, and the release is verified and downloaded once.
  const LATEST = '99.0.0';
  const world = releaseWorld({ [CORE]: LATEST }, [{ version: LATEST, declares: { security: true }, registrySays: {} }]);
  assert.ok(
    (await world.verifyRelease({ packageName: CORE, version: LATEST, integrity: world.integrity(CORE, LATEST) })).ok,
  );
  const served = await loopbackRegistry(world);
  try {
    const m = noticeMachine({ npm_config_registry: served.url });
    await dueMachineAt(m);
    const claimedAt = await lateClaim(m.core);
    const stop = Date.parse(claimedAt) + releaseFacts.DECLARATION_DEADLINE_MS;
    const attestations = world.attestationsAsked.length;
    await askUnderClaim(m.core, m.env, claimedAt, {
      deps: {
        registry: world.registry,
        verifyRelease: world.verifyRelease,
        tarballs: world.tarballs,
        // `npm ls`, slow: it answers once the reads have stopped.
        globalPackages: async () => {
          await new Promise((waited) => setTimeout(waited, Math.max(0, stop - Date.now()) + 200));
          return {};
        },
      },
    });
    assert.ok(Date.now() > stop, 'the second asking came before the reads stopped');
    const record = await readUpdateCheck(m.stateDir);
    recordedUnder(record, claimedAt);
    assert.deepEqual(record.release, { version: LATEST, security: true, needsDecision: false });
    assert.equal(world.tarballsAsked.length, 1, 'downloaded more than once');
    assert.equal(world.attestationsAsked.length - attestations, 1, 'verified more than once');
  } finally {
    await served.close();
  }
});

/** `m`'s check made a day old, so the next one is due. */
async function dueMachineAt(m: { stateDir: string }): Promise<void> {
  mkdirSync(m.stateDir, { recursive: true });
  await changeUpdateCheck(m.stateDir, (record) => ({
    record: { ...record, lastChecked: new Date(Date.now() - 30 * 3_600_000).toISOString() },
  }));
}
