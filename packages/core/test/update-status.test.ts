import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { updateStatus } from '../src/operations/update-status.ts';
import {
  coreLauncherPath,
  installUpdateJob,
  launchAgentPath,
  recordUpdateJobRun,
  type UpdateJobDeps,
  updateJobContext,
} from '../src/update-job.ts';
import { updateCheckPath } from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { runMain } from './helpers/main-in-process.ts';
import { recordingRunner } from './helpers/recording-runner.ts';
import { refusingNpm } from './helpers/refusing-npm.ts';
import { codeOf, connect, LATEST, type Machine, machine, seed } from './helpers/update-machine.ts';

/*
 * `agentcomms update --status` and `comms_update` with `status: true` (desktop design DA13): where updates stand on
 * this machine — the level and what decided it, any pause, the last check, the latest and running versions, a security
 * fix waiting, and the background job — read from local files, asking npm nothing. One operation, `updateStatus`,
 * that both run, so the desktop app and an agent read the same thing.
 *
 * Every machine here is a temporary home with the daily check on and a registry nobody answers on; every program the
 * background job would start goes to a runner that only records it.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIXED = new Date('2026-10-19T08:00:00.000Z');
const at = (offset: number) => new Date(FIXED.getTime() + offset);
/** The Node a Windows task would start the launcher with, as the test names it: nothing runs it. */
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

/** Where nothing is recorded and nothing was checked: the job's every field empty. */
const NO_JOB = { state: 'not-set-up', where: null, installedAt: null, lastRun: null, working: null };

/** The stable core launcher the job runs, in place, as a managed install leaves it. */
function withLauncher(m: Machine): void {
  const launcher = coreLauncherPath(m.core.paths.dataDir);
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 });
}

/** The macOS job set up through its own installer, at `setUp`, and its last run recorded at `ran`. */
async function jobSetUp(m: Machine, setUp: Date, ran?: Date): Promise<UpdateJobDeps> {
  withLauncher(m);
  const { run } = recordingRunner();
  const deps: UpdateJobDeps = { run, uid: 501, random: () => 0.5, now: () => setUp, node: NODE };
  await installUpdateJob(updateJobContext(m.core, m.env, { platform: 'darwin', deps }));
  if (ran !== undefined) await recordUpdateJobRun(m.core.paths.stateDir, ran);
  return deps;
}

test('status reads level, pause, last check, latest and running from local files', async () => {
  const m = machine({}, { defaults: { updates: 'every-14-days' } });
  await seed(
    m,
    {
      latest: LATEST,
      lastError: 'the registry did not answer in time',
      pausedAt: at(-HOUR).toISOString(),
      pausedUntil: at(7 * DAY - HOUR).toISOString(),
      release: { version: LATEST, security: true, needsDecision: false },
    },
    at(-2 * HOUR),
  );
  const status = await updateStatus(m.core, m.env, { platform: 'linux', now: () => FIXED });
  assert.deepEqual(status, {
    level: 'every-14-days',
    set: 'every-14-days',
    by: 'setting',
    cap: null,
    pausedUntil: at(7 * DAY - HOUR).toISOString(),
    lastChecked: at(-2 * HOUR).toISOString(),
    latest: LATEST,
    running: VERSION,
    security: LATEST,
    lastError: 'the registry did not answer in time',
    job: NO_JOB,
  });

  // A pause that has ended holds nothing, and says so.
  const later = await updateStatus(m.core, m.env, { platform: 'linux', now: () => at(8 * DAY) });
  assert.equal(later.pausedUntil, null);

  // A file never written: nothing checked, nothing known, and the default level.
  const fresh = machine();
  assert.deepEqual(await updateStatus(fresh.core, fresh.env, { platform: 'linux', now: () => FIXED }), {
    level: 'auto',
    set: 'auto',
    by: 'setting',
    cap: null,
    pausedUntil: null,
    lastChecked: null,
    latest: null,
    running: VERSION,
    security: null,
    lastError: null,
    job: NO_JOB,
  });
});

test('an organisation’s cap is said by its organisation and level alone, with no path', async () => {
  // A configuration that cannot be read still holds the caps it names (design 2026-10-16 U8, failing closed).
  const m = machine({}, { organisations: { acme: { updates: { max: 'never' } } } });
  const status = await updateStatus(m.core, m.env, { platform: 'linux', now: () => FIXED });
  assert.deepEqual(status.cap, { level: 'never', organisation: 'acme' });
  assert.equal(status.level, 'never');
  assert.equal(status.by, 'setting');
});

test('status asks npm nothing', async () => {
  const m = machine();
  // Checked three days ago, so the daily check is due: the status, by command or by tool, still asks nothing, and the
  // server's own background check does not start for it either.
  await seed(m, { latest: LATEST }, at(-3 * DAY));
  const recorded = readFileSync(updateCheckPath(m.stateDir), 'utf8');
  const npm = refusingNpm(() => FIXED);

  const byCommand = await runMain(['update', '--status', '--json'], m.env, 'linux', { update: npm.deps });
  assert.equal(byCommand.code, 0, byCommand.stdout + byCommand.stderr);
  assert.equal((byCommand.json().data as { latest: string }).latest, LATEST);
  assert.equal(byCommand.stderr, '', 'and no notice: the update command never gives one');

  const shown = await runMain(['update', '--status'], m.env, 'linux', { update: npm.deps });
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`^running +${VERSION.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(shown.stdout, /^job\.state +not-set-up$/m);

  const { call, close } = await connect(m, { update: npm.deps, platform: 'linux' });
  try {
    const byTool = await call('comms_update', { status: true });
    assert.notEqual(byTool.isError, true, JSON.stringify(byTool.structuredContent));
    assert.equal(byTool.structuredContent?.latest, LATEST);
    // A check started in the background would have asked by now, and written down that it did.
    await new Promise((settled) => setTimeout(settled, 300));
  } finally {
    await close();
  }
  assert.deepEqual(npm.asked, [], 'nothing asked npm, the registry or the verifier');
  assert.equal(readFileSync(updateCheckPath(m.stateDir), 'utf8'), recorded, 'update-check.json is as it was');
});

test('status says where the background job stands', async () => {
  const setUp = at(-3 * DAY);
  const m = machine();
  const deps = await jobSetUp(m, setUp, at(-5 * HOUR));
  const status = await updateStatus(m.core, m.env, { platform: 'darwin', job: deps, now: () => FIXED });
  assert.deepEqual(status.job, {
    state: 'installed',
    where: launchAgentPath(m.home),
    installedAt: setUp.toISOString(),
    lastRun: at(-5 * HOUR).toISOString(),
    working: true,
  });

  // Silent for more than two days: still installed, and not working.
  const silent = await updateStatus(m.core, m.env, { platform: 'darwin', job: deps, now: () => at(3 * DAY) });
  assert.deepEqual([silent.job.state, silent.job.working], ['installed', false]);

  // Windows with nothing recorded: not set up, and the scheduler is never asked.
  const w = machine();
  const { calls, run } = recordingRunner();
  const windows = await updateStatus(w.core, w.env, { platform: 'win32', job: { run, node: NODE }, now: () => FIXED });
  assert.deepEqual(windows.job, NO_JOB);
  assert.deepEqual(calls, [], 'nothing recorded, so no program was started');

  // A platform with no background job at all.
  const other = await updateStatus(w.core, w.env, { platform: 'freebsd', now: () => FIXED });
  assert.deepEqual(other.job, { state: 'unsupported', where: null, installedAt: null, lastRun: null, working: null });
});

test('a background job that cannot be read is said to be unreadable, with why, and the rest is still read', async () => {
  const m = machine();
  await seed(m, { latest: LATEST }, at(-HOUR));
  // The job's file is a folder: reading it fails with something other than "not there".
  mkdirSync(launchAgentPath(m.home), { recursive: true });
  const status = await updateStatus(m.core, m.env, { platform: 'darwin', now: () => FIXED });
  assert.equal(status.latest, LATEST, 'everything else is still read');
  assert.equal(status.job.state, 'unreadable');
  assert.deepEqual(
    [status.job.where, status.job.installedAt, status.job.lastRun, status.job.working],
    [null, null, null, null],
  );
  assert.match(status.job.reason ?? '', /could not be read/);
  assert.match(status.job.reason ?? '', /EISDIR|illegal operation|directory/i);

  // The command says so too, rather than failing, in both its shapes.
  const npm = refusingNpm(() => FIXED);
  const byCommand = await runMain(['update', '--status', '--json'], m.env, 'darwin', { update: npm.deps });
  assert.equal(byCommand.code, 0, byCommand.stdout + byCommand.stderr);
  const job = (byCommand.json().data as { job: { state: string; reason: string } }).job;
  assert.equal(job.state, 'unreadable');
  assert.equal(job.reason, status.job.reason);
  const shown = await runMain(['update', '--status'], m.env, 'darwin', { update: npm.deps });
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^job\.state +unreadable$/m);
  assert.match(shown.stdout, /^job\.reason +.*could not be read/m);
  assert.deepEqual(npm.asked, []);
});

test('an environment switch is what decided the level', async () => {
  for (const [variable, value] of [
    ['AGENT_COMMS_UPDATES', 'never'],
    ['AGENT_COMMS_UPDATE_CHECK', 'off'],
    ['CI', 'true'],
  ] as const) {
    const m = machine({ [variable]: value }, { defaults: { updates: 'every-14-days' } });
    const status = await updateStatus(m.core, m.env, { platform: 'linux', now: () => FIXED });
    assert.deepEqual([status.level, status.set, status.by], ['never', 'every-14-days', variable], variable);
  }
});

test('--status is one mode at a time and takes no approval', async () => {
  const m = machine();
  const npm = refusingNpm(() => FIXED);
  const approval = `ap_${'0'.repeat(26)}`;
  for (const words of [
    ['--status', '--check'],
    ['--status', '--approval', approval],
    ['--status', '--level', 'never'],
    ['--status', '--pause'],
    ['--status', '--background-job', 'off'],
    // It only reads, so there is no update for --no-verify to be about.
    ['--status', '--no-verify'],
  ]) {
    const run = await runMain(['update', ...words, '--json'], m.env, 'linux', { update: npm.deps });
    assert.equal(run.code, 64, `${words.join(' ')}: ${run.stdout}`);
    assert.equal((run.json().error as { code: string }).code, 'USAGE');
  }
  const { call, close } = await connect(m, { update: npm.deps, platform: 'linux' });
  try {
    for (const args of [
      { status: true, approvalId: approval },
      { status: true, check: true },
      { status: true, resume: true },
      { status: false },
    ]) {
      const result = await call('comms_update', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.equal(codeOf(result), 'USAGE', JSON.stringify(result.structuredContent));
    }
  } finally {
    await close();
  }
  assert.deepEqual(npm.asked, []);
});

test('the CLI and MCP give the same result', async () => {
  const m = machine({}, { defaults: { updates: 'auto' } });
  await seed(m, { latest: LATEST, pausedAt: at(-HOUR).toISOString(), pausedUntil: at(DAY).toISOString() }, at(-HOUR));
  const job = await jobSetUp(m, at(-DAY), at(-2 * HOUR));
  const npm = refusingNpm(() => FIXED);
  const expected = JSON.parse(
    JSON.stringify(await updateStatus(m.core, m.env, { platform: 'darwin', job, now: () => FIXED })),
  );
  assert.equal(expected.job.state, 'installed', JSON.stringify(expected));

  const byCommand = await runMain(['update', '--status', '--json'], m.env, 'darwin', {
    update: npm.deps,
    updateJob: job,
  });
  assert.equal(byCommand.code, 0, byCommand.stdout);
  assert.deepEqual(byCommand.json().data, expected);

  const { call, close } = await connect(m, { update: npm.deps, updateJob: job, platform: 'darwin' });
  try {
    const byTool = await call('comms_update', { status: true });
    assert.notEqual(byTool.isError, true, JSON.stringify(byTool.structuredContent));
    assert.deepEqual(byTool.structuredContent, expected);
  } finally {
    await close();
  }
});
