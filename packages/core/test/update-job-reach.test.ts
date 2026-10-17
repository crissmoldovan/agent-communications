import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { runBackgroundUpdate } from '../src/update-background.ts';
import { securityNotice, updateToolNotice } from '../src/update-gate.ts';
import { readUpdateJobMarker, updateJobMarkerPath } from '../src/update-job.ts';
import { withUpdateLock } from '../src/update-lock.ts';
import { VERSION } from '../src/version.ts';
import { launchedThrough, type Machine, machine, seed } from './helpers/update-machine.ts';

/*
 * A working background job covers only the processes it updates (re-review of 0.20.0, severity 6). It switches the
 * stable launchers' pointers, so a server or command started through its package's launcher runs the release it
 * installs from its next start; a server registered with `--launcher npx`, a versioned or a local registration, a
 * command from a global install or npx's cache, it never touches. So the security notice and the preview's line are
 * held back only for a process the job reaches, and only until the verified security release is what its launcher
 * starts; every other process is told as on a machine with no job. Nothing here schedules a job or reaches npm.
 */

// A minor release: one the job installs on its own. A major it never does, and says so whatever the job.
const [major, minor] = VERSION.split('.').map(Number) as [number, number];
const FIX = `${major}.${minor + 1}.0`;
const LINE = `A security fix is out (${FIX}): update first, or approve to post anyway`;
const SECURITY = { version: FIX, security: true, needsDecision: false };

/** A job that ran an hour ago: working. */
function workingJob(m: Machine): void {
  mkdirSync(m.stateDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    updateJobMarkerPath(m.stateDir),
    JSON.stringify({ platform: 'darwin', installedAt: now, label: 'com.agentcomms.update', lastRun: now }),
  );
}

/** What a Slack server running `env` is told: the preview's line, and its tool notice. */
async function told(m: Machine, env: NodeJS.ProcessEnv) {
  const preview = await securityNotice({ core: m.core, env, running: VERSION, act: 'post', channel: 'slack' });
  const notice = await updateToolNotice({ core: m.core, env, running: VERSION, channel: 'slack', exempt: [] })(
    'slack_read',
  );
  return { preview, notice };
}

test('a working job holds the security line back only for a server started through the launcher it switches', async () => {
  // As the reviewer's reproduction has it: a verified security fix out, and Slack's server registered with npx.
  const withoutJob = machine();
  await seed(withoutJob, { latest: FIX, behind: true, release: SECURITY });
  const plain = await told(withoutJob, withoutJob.env);
  assert.equal(plain.preview, LINE);
  assert.match(String(plain.notice), /fixes a security problem/);

  // The same machine with a job that runs: a server the job never updates is told just as without one.
  for (const [why, env] of [
    ['npx, or any registration the job does not start', (m: Machine) => m.env],
    ['started through another package’s launcher', (m: Machine) => launchedThrough(m, 'gmail', VERSION)],
  ] as const) {
    const m = machine();
    await seed(m, { latest: FIX, behind: true, release: SECURITY });
    workingJob(m);
    const { preview, notice } = await told(m, env(m));
    assert.equal(preview, LINE, `${why}: the preview's line was held back`);
    assert.match(String(notice), /fixes a security problem/, `${why}: the notice was held back`);
  }

  // Started through Slack's own launcher, whose pointer the job switches: held back, the job installs it in a day.
  const reached = machine();
  await seed(reached, { latest: FIX, behind: true, release: SECURITY });
  workingJob(reached);
  const old = await told(reached, launchedThrough(reached, 'slack', VERSION));
  assert.equal(old.preview, null);
  assert.equal(old.notice, null);

  // Once its launcher starts the security release, this process still runs the old one: told again, to restart.
  const installed = machine();
  await seed(installed, { latest: FIX, behind: true, release: SECURITY });
  workingJob(installed);
  const after = await told(installed, launchedThrough(installed, 'slack', FIX));
  assert.equal(after.preview, LINE, 'the line stayed held back after the release was installed');
  assert.notEqual(after.notice, null, 'the notice stayed held back after the release was installed');

  // A security fix the job never installs on its own — a new major, or one needing a decision — is the person's to
  // take, whatever process asks: told, as without a job.
  const next = `${major + 1}.0.0`;
  for (const release of [
    { version: next, security: true, needsDecision: false },
    { version: FIX, security: true, needsDecision: true },
  ]) {
    const m = machine();
    await seed(m, { latest: release.version, behind: true, release });
    workingJob(m);
    const { preview, notice } = await told(m, launchedThrough(m, 'slack', VERSION));
    assert.equal(preview, `A security fix is out (${release.version}): update first, or approve to post anyway`);
    assert.match(String(notice), /fixes a security problem/, JSON.stringify(release));
  }
});

test('a background run records lastRun only for an outcome that shows the job works: not unavailable, busy or failed', async () => {
  const NOW = new Date();
  // The job's own run: started through the core launcher, as the job starts it.
  const jobRun = async (m: Machine, at: Date) =>
    runBackgroundUpdate(m.core, launchedThrough(m, 'core', VERSION), {}, { now: () => at });

  // The registry cannot be reached: the run cannot keep the machine up to date, so it records nothing, and a job
  // stuck so for 48 hours is reported as not running.
  const unreachable = machine();
  workingJob(unreachable);
  const before = (await readUpdateJobMarker(unreachable.stateDir))?.lastRun;
  const offline = await jobRun(unreachable, new Date(NOW.getTime() + 60_000));
  assert.equal(offline.outcome, 'unavailable', offline.reason);
  assert.equal((await readUpdateJobMarker(unreachable.stateDir))?.lastRun, before, 'unavailable recorded lastRun');

  // Another run or a person's update holds the lock: this run did nothing, and a lock held for good would hide it.
  const busy = machine();
  workingJob(busy);
  const held = (await readUpdateJobMarker(busy.stateDir))?.lastRun;
  await withUpdateLock(busy.stateDir, async () => {
    const run = await jobRun(busy, new Date(NOW.getTime() + 60_000));
    assert.equal(run.outcome, 'busy', run.reason);
  });
  assert.equal((await readUpdateJobMarker(busy.stateDir))?.lastRun, held, 'busy recorded lastRun');
});

test('a background run a person starts by hand records no lastRun; the job’s own, through the core launcher, does', async () => {
  const m = machine();
  mkdirSync(m.stateDir, { recursive: true });
  const installedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(
    updateJobMarkerPath(m.stateDir),
    JSON.stringify({ platform: 'darwin', installedAt, label: 'com.agentcomms.update' }),
  );
  const NOW = new Date();
  // `agentcomms update --background` at a terminal: the command a person runs, from wherever it is installed.
  const byHand = await runBackgroundUpdate(m.core, m.env, {}, { now: () => NOW });
  assert.equal(byHand.outcome, 'no-launchers', byHand.reason);
  assert.equal((await readUpdateJobMarker(m.stateDir))?.lastRun, undefined, 'a run by hand said the job ran');
  // The job's own: it starts the stable core launcher, which says so to what it starts.
  const byJob = await runBackgroundUpdate(m.core, { ...m.env, AGENT_COMMS_LAUNCHER: 'core' }, {}, { now: () => NOW });
  assert.equal(byJob.outcome, 'no-launchers', byJob.reason);
  assert.equal((await readUpdateJobMarker(m.stateDir))?.lastRun, NOW.toISOString());
});
