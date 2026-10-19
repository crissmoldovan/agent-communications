import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { Streams } from '../src/cli-runtime.ts';
import { doctor } from '../src/operations/maintenance.ts';
import { runBackgroundUpdate } from '../src/update-background.ts';
import { securityNotice, updateNoticeAtTerminal, updateToolNotice } from '../src/update-gate.ts';
import {
  installUpdateJob,
  readUpdateJobMarker,
  type UpdateJobRunner,
  updateJobContext,
  updateJobMarkerPath,
} from '../src/update-job.ts';
import { effectiveUpdates, localStamp } from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { launchedThrough, type Machine, machine, seed } from './helpers/update-machine.ts';

/*
 * A background job that never runs (design 2026-10-16 U4, U7; the 0.20.0 security review, severity 7). The marker
 * `<state>/update-job.json` says the job was set up, not that it works: a job switched off in Login Items, a timer
 * that never fires or a task Task Scheduler cannot start leaves the marker in place forever. Read as "the job installs
 * it", that silenced every notice, the security line included.
 *
 * So every background run records `lastRun` on the marker, and the job counts as working only when it ran in the last
 * 48 hours — or was set up less than 48 hours ago and has not had its first run yet. Otherwise this machine is treated
 * as having no job: full notices, the security line, the setup offer, and one line saying since when it has not run.
 *
 * Nothing here schedules a job, runs a scheduler or reaches npm: the marker is written by hand or through a recording
 * runner, and the registry is a port nobody answers on.
 */

const HOUR = 60 * 60 * 1000;
const NOW = new Date();
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
const minorRelease = () => {
  const [major, minor] = VERSION.split('.').map(Number) as [number, number];
  return `${major}.${minor + 1}.0`;
};
// A minor release: one the job installs on its own, so a working job is what holds its line back.
const SECURITY = { version: minorRelease(), security: true, needsDecision: false };
const LINE = `A security fix is out (${minorRelease()}): update first, or approve to send anyway`;
const SILENT = /background updates have not run since \d{4}-\d{2}-\d{2}; check Login Items \(macOS\) or run doctor/;

/** The marker as the installer writes it, set up `installedHoursAgo`, with a `lastRun` when one is given. */
function marker(m: Machine, installedHoursAgo: number, lastRunHoursAgo?: number): void {
  mkdirSync(m.stateDir, { recursive: true });
  writeFileSync(
    updateJobMarkerPath(m.stateDir),
    `${JSON.stringify({
      platform: 'darwin',
      installedAt: ago(installedHoursAgo).toISOString(),
      label: 'com.agentcomms.update',
      ...(lastRunHoursAgo === undefined ? {} : { lastRun: ago(lastRunHoursAgo).toISOString() }),
    })}\n`,
  );
}

/** The stable core launcher, where the job's setup looks for it: what makes the setup offer one that can be taken. */
function launcherThere(m: Machine): void {
  const launcher = join(m.core.paths.dataDir, 'launch', 'core');
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 });
}

const serverNotice = (m: Machine) =>
  updateToolNotice({ core: m.core, env: m.env, channel: 'core', running: VERSION, exempt: [] })('comms_audit_tail');

async function commandNotice(m: Machine): Promise<string> {
  let said = '';
  const stderr = new PassThrough();
  stderr.on('data', (chunk) => {
    said += String(chunk);
  });
  await updateNoticeAtTerminal({
    core: m.core,
    env: m.env,
    channel: 'core',
    running: VERSION,
    output: { json: true, color: false },
    streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr } as unknown as Streams,
  });
  return said;
}

// ── Each run records it ─────────────────────────────────────────────────────────────────────────────────────────

test('every run of the job records lastRun on the marker, one that finds nothing to do included; a dry run does not', async () => {
  const m = machine();
  marker(m, 24 * 5);
  // The job's run, started through the stable core launcher as the job starts it: a run by hand records nothing
  // (update-job-reach.test.ts). Nothing here has a runtime to start: the run finds nothing to do, and says so.
  const job = { ...m.env, AGENT_COMMS_LAUNCHER: 'core' };
  const run = await runBackgroundUpdate(m.core, job, {}, { now: () => NOW });
  assert.equal(run.outcome, 'no-launchers', run.reason);
  const after = await readUpdateJobMarker(m.stateDir);
  assert.equal(after?.lastRun, NOW.toISOString(), 'a run that found nothing to do recorded no lastRun');
  assert.equal(after?.installedAt, ago(24 * 5).toISOString(), 'the rest of the marker is kept');

  // A dry run is a person's question, not the job running: it changes nothing, the marker included.
  const later = new Date(NOW.getTime() + HOUR);
  await runBackgroundUpdate(m.core, job, { dryRun: true }, { now: () => later });
  assert.equal((await readUpdateJobMarker(m.stateDir))?.lastRun, NOW.toISOString());

  // With no job set up, a run writes no marker: a run by hand is not a job.
  const bare = machine();
  await runBackgroundUpdate(bare.core, { ...bare.env, AGENT_COMMS_LAUNCHER: 'core' }, {}, { now: () => NOW });
  assert.equal(existsSync(updateJobMarkerPath(bare.stateDir)), false);
});

test('a lastRun this release cannot read is none, and the rest of the marker reads as it did', async () => {
  const m = machine();
  mkdirSync(m.stateDir, { recursive: true });
  writeFileSync(
    updateJobMarkerPath(m.stateDir),
    JSON.stringify({ platform: 'darwin', installedAt: NOW.toISOString(), label: 'x', lastRun: 'yesterday' }),
  );
  const read = await readUpdateJobMarker(m.stateDir);
  assert.equal(read?.lastRun, undefined);
  assert.equal(read?.installedAt, NOW.toISOString());
});

// ── What the notice makes of it ─────────────────────────────────────────────────────────────────────────────────

test('a marker whose lastRun is stale gets the security line; a fresh one does not need it', async () => {
  const stale = machine();
  await seed(stale, { latest: minorRelease(), behind: true, release: SECURITY });
  marker(stale, 24 * 10, 72);
  assert.equal((await effectiveUpdates(stale.core, stale.env)).background, false);
  assert.equal(await securityNotice({ core: stale.core, env: stale.env, running: VERSION }), LINE);

  const fresh = machine();
  await seed(fresh, { latest: minorRelease(), behind: true, release: SECURITY });
  marker(fresh, 24 * 10, 3);
  assert.equal((await effectiveUpdates(fresh.core, fresh.env)).background, true);
  // Held back for a process the job reaches: one started through the launcher it switches.
  const launched = launchedThrough(fresh, 'core', VERSION);
  assert.equal(await securityNotice({ core: fresh.core, env: launched, running: VERSION }), null);
});

test('a job set up under 48 hours ago counts until its first run is due; one set up longer ago that never ran does not', async () => {
  const waiting = machine();
  await seed(waiting, { latest: minorRelease(), behind: true, release: SECURITY });
  marker(waiting, 2);
  assert.equal((await effectiveUpdates(waiting.core, waiting.env)).background, true);
  const launched = launchedThrough(waiting, 'core', VERSION);
  assert.equal(await securityNotice({ core: waiting.core, env: launched, running: VERSION }), null);

  const never = machine();
  await seed(never, { latest: minorRelease(), behind: true, release: SECURITY });
  marker(never, 72);
  const updates = await effectiveUpdates(never.core, never.env);
  assert.equal(updates.background, false);
  assert.equal(updates.jobSilent?.since, ago(72).toISOString(), 'never ran: silent since it was set up');
  assert.equal(await securityNotice({ core: never.core, env: never.env, running: VERSION }), LINE);
});

test('a silent job: the full notice, the line saying since when, and the offer to set it up again', async () => {
  const m = machine();
  launcherThere(m);
  await seed(m, { latest: minorRelease(), behind: true });
  marker(m, 24 * 10, 24 * 4);
  const line = String(await serverNotice(m));
  // A minor release the job would have installed: with the job silent, it is the notice, as with no job at all.
  assert.match(line, /is out; say "update"/);
  assert.match(line, SILENT);
  assert.ok(line.includes(`since ${localStamp(ago(24 * 4)).slice(0, 10)};`), line);
  assert.match(line, /backgroundJob "on" sets up a daily job/);
  // A command says it too, once a day.
  const said = await commandNotice(m);
  assert.match(said, SILENT);

  // The same release with the job working, for a server started through the launcher it switches: nothing to say —
  // it installs on its own.
  const working = machine();
  launcherThere(working);
  await seed(working, { latest: minorRelease(), behind: true });
  marker(working, 24 * 10, 2);
  Object.assign(working.env, launchedThrough(working, 'core', VERSION));
  assert.equal(await serverNotice(working), null);
});

test('the silent line is said on its own when nothing is behind, and not during a pause', async () => {
  const m = machine();
  await seed(m, { latest: VERSION, behind: false });
  marker(m, 24 * 10, 24 * 3);
  assert.match(String(await serverNotice(m)), SILENT);

  const paused = machine();
  await seed(paused, {
    latest: VERSION,
    behind: false,
    pausedAt: ago(1).toISOString(),
    pausedUntil: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
  });
  marker(paused, 24 * 10, 24 * 3);
  assert.equal(await serverNotice(paused), null);
});

// ── The doctor ──────────────────────────────────────────────────────────────────────────────────────────────────

function recorder(): { run: UpdateJobRunner } {
  return { run: async () => ({ status: 0, stdout: '', stderr: '' }) };
}

async function rows(m: Machine, now: Date) {
  const report = await doctor(m.core, m.env, {
    keyring: null,
    platform: 'darwin',
    updateJob: { run: recorder().run, uid: 501, random: () => 0.5, now: () => now },
    now: () => now,
  });
  return {
    job: report.checks.find((check) => check.name === 'background update job'),
    check: report.checks.find((check) => check.name === 'update check'),
  };
}

test('the doctor warns of a job that has not run in 48 hours, and says where to look', async () => {
  const m = machine();
  launcherThere(m);
  const setUp = ago(24 * 6);
  await installUpdateJob(
    updateJobContext(m.core, m.env, {
      platform: 'darwin',
      deps: { run: recorder().run, uid: 501, random: () => 0.5, now: () => setUp },
    }),
  );
  const silent = await rows(m, NOW);
  assert.equal(silent.job?.ok, true);
  assert.equal(silent.job?.warn, true, JSON.stringify(silent.job));
  assert.match(String(silent.job?.detail), /has not run since/);
  assert.match(String(silent.job?.fix), /Login Items/);
  assert.match(String(silent.check?.detail), /background updates have not run since/);

  // Once it runs, it is installed and quiet again.
  const marked = JSON.parse(readFileSync(updateJobMarkerPath(m.stateDir), 'utf8')) as Record<string, unknown>;
  writeFileSync(updateJobMarkerPath(m.stateDir), JSON.stringify({ ...marked, lastRun: ago(5).toISOString() }));
  const fine = await rows(m, NOW);
  assert.equal(fine.job?.warn, undefined, JSON.stringify(fine.job));
  assert.match(String(fine.job?.detail), /^installed: .*last ran /);
  assert.doesNotMatch(String(fine.check?.detail), /have not run/);
});
