import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gatedChange } from '../src/change-flow.ts';
import type { Streams } from '../src/cli-runtime.ts';
import { classifyChange, updateLevelOf } from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { updateLevelChange, updatePause, updateResume } from '../src/operations/update-settings.ts';
import { checkForUpdates } from '../src/update-check.ts';
import { updateNoticeAtTerminal, updateToolNotice } from '../src/update-gate.ts';
import { readUpdateCheck, UPDATE_JOB_MARKER, updateJobInstalled } from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { codeOf, connect, deps, LATEST, type Machine, machine, seed } from './helpers/update-machine.ts';

/*
 * The levels and the pause (design 2026-10-16, U2 and U3): `defaults.updates` is `auto` (the default), `every-14-days`
 * or `never`, read from 0.18's `updateCheck` until one is set; a pause of 1, 7 or 14 days holds notices with no
 * approval, and never holds a security fix. Nothing here reaches npm, and every clock is the test's.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const DAY = 24 * 3_600_000;
const START = new Date('2026-10-16T09:00:00.000Z');
const at = (ms: number) => () => new Date(START.getTime() + ms);

/** A registry that answers `latest` for core, counting the asks. */
function registry(latest = LATEST) {
  const asked: string[] = [];
  return {
    asked,
    latestVersion: async (name: string) => {
      asked.push(name);
      return latest;
    },
  };
}

/** The notice a fresh server process gives on its first call, at `now`: what a client restarted then would see. */
const serverNotice = (m: Machine, now: () => Date, env: Record<string, string> = m.env) =>
  updateToolNotice({ core: m.core, env, channel: 'core', running: VERSION, exempt: [], now })('comms_audit_tail');

/** What a command run at `now` prints on stderr. */
async function commandNotice(m: Machine, now: () => Date, env: Record<string, string> = m.env): Promise<string> {
  let said = '';
  const stderr = new PassThrough();
  stderr.on('data', (chunk) => {
    said += String(chunk);
  });
  await updateNoticeAtTerminal({
    core: m.core,
    env,
    channel: 'core',
    running: VERSION,
    output: { json: true, color: false },
    streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr } as unknown as Streams,
    now,
  });
  return said;
}

/**
 * The core's command, run in a process of its own without blocking this one: `spawnSync` would hold this process's
 * event loop, and with it any lock a server here had just taken, for as long as the command ran.
 */
function cli(
  env: Record<string, string>,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const levelConfig = (updates: string | undefined, updateCheck?: string) => ({
  defaults: { ...(updates === undefined ? {} : { updates }), ...(updateCheck === undefined ? {} : { updateCheck }) },
});

// ── The levels ──────────────────────────────────────────────────────────────────────────────────────────────────

test('0.18’s setting reads as a level until one is set: on is auto, off is never, and nothing set is auto', async () => {
  for (const [config, level] of [
    [{}, 'auto'],
    [levelConfig(undefined, 'on'), 'auto'],
    [levelConfig(undefined, 'off'), 'never'],
    [levelConfig('every-14-days', 'on'), 'every-14-days'],
    [levelConfig('never', 'off'), 'never'],
    // The level a person chose is the level, whatever an older release left in the old key.
    [levelConfig('auto', 'off'), 'auto'],
  ] as const) {
    const m = machine({}, config);
    assert.equal(updateLevelOf(await m.core.config.load()), level, JSON.stringify(config));
  }
  // A word this release does not know reads as the default, and the file stays readable.
  const later = machine({}, levelConfig('every-30-days'));
  assert.equal(updateLevelOf(await later.core.config.load()), 'auto');
});

test('a level that updates less is a loosening; one that updates more is not', async () => {
  const m = machine();
  const base = await m.core.config.load();
  const withLevel = (updates: string | undefined) => ({
    ...base,
    defaults: { ...base.defaults, ...(updates === undefined ? {} : { updates }) },
  });
  const judged = (from: string | undefined, to: string | undefined) =>
    classifyChange(withLevel(from), withLevel(to)).changes.map((change) => [change.path, change.before, change.after]);
  assert.deepEqual(judged(undefined, 'every-14-days'), [['defaults.updates', 'auto', 'every-14-days']]);
  assert.deepEqual(judged('auto', 'never'), [['defaults.updates', 'auto', 'never']]);
  assert.deepEqual(judged('every-14-days', 'never'), [['defaults.updates', 'every-14-days', 'never']]);
  assert.deepEqual(judged('never', 'auto'), []);
  assert.deepEqual(judged('every-14-days', 'auto'), []);
  assert.deepEqual(judged('auto', 'auto'), []);
  // 0.18's switch, off: still a loosening when it is all that says how this machine updates.
  const old = (updateCheck: 'on' | 'off') => ({ ...base, defaults: { ...base.defaults, updateCheck } });
  assert.deepEqual(
    classifyChange(old('on'), old('off')).changes.map((change) => change.path),
    ['defaults.updates'],
  );
  // A word this release cannot judge, arriving: as the least updating there is.
  assert.deepEqual(judged('auto', 'every-30-days'), [['defaults.updates', 'auto', 'every-30-days']]);
  // The store itself refuses it without the person's consent, whoever asks.
  await assert.rejects(
    m.core.config.update((config) => ({ ...config, defaults: { ...config.defaults, updates: 'never' } })),
    (error: unknown) => error instanceof CommsError && error.code === 'LOOSENING_REFUSED',
  );
});

test('moving to a level that updates less waits for a yes, says what stops, and keeps 0.18’s key in step; moving back is at once', async () => {
  const m = machine();
  const { call, close } = await connect(m);
  try {
    const asked = (await call('comms_update', { level: 'every-14-days' })).structuredContent as Record<string, unknown>;
    assert.equal(asked.approvalRequired, true, JSON.stringify(asked));
    assert.match(String(asked.preview), /how this machine updates: auto → every-14-days/);
    assert.match(String(asked.preview), /at most once every 14 days/);
    assert.equal((await m.core.config.load()).defaults.updates, undefined, 'written before the yes');
    const applied = (await call('comms_update', { level: 'every-14-days', approvalId: asked.approvalId }))
      .structuredContent as { applied: boolean; result: { level: string; changed: boolean } };
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual([applied.result.level, applied.result.changed], ['every-14-days', true]);
    const config = await m.core.config.load();
    assert.equal(config.defaults.updates, 'every-14-days');
    assert.equal(config.defaults.updateCheck, 'on', 'an earlier release still checks');

    const never = (await call('comms_update', { level: 'never' })).structuredContent as Record<string, unknown>;
    assert.equal(never.approvalRequired, true);
    assert.match(String(never.preview), /nothing on this machine will ask npm for a newer release/);
    await call('comms_update', { level: 'never', approvalId: never.approvalId });
    assert.equal((await m.core.config.load()).defaults.updateCheck, 'off', 'an earlier release stops checking too');

    // Back to auto: at once, asking nobody.
    const back = (await call('comms_update', { level: 'auto' })).structuredContent as Record<string, unknown>;
    assert.equal(back.applied, true, JSON.stringify(back));
    const restored = await m.core.config.load();
    assert.deepEqual([restored.defaults.updates, restored.defaults.updateCheck], ['auto', 'on']);
    assert.equal(codeOf(await call('comms_update', { level: 'sometimes' })), 'USAGE');
  } finally {
    await close();
  }
  // The same from a terminal: an agent gets the preview and an id (exit 10); back is at once.
  const run = (args: readonly string[]) => cli({ ...m.env, CLAUDECODE: '1' }, args);
  const less = await run(['update', '--level', 'never', '--json']);
  assert.equal(less.status, 10, less.stdout + less.stderr);
  assert.equal((await run(['update', '--level', 'every-14-days', '--json'])).status, 10);
  assert.equal((await run(['update', '--level', 'auto', '--json'])).status, 0);
  assert.equal((await run(['update', '--level', 'weekly', '--json'])).status, 64);
  const outcome = await gatedChange(m.core, updateLevelChange(m.core, 'never'), { channel: 'core', surface: 'mcp' });
  assert.equal(outcome.status, 'approval-required');
});

test('auto checks daily and says so; every-14-days checks and says so at most once in 14 days; never asks nobody', async () => {
  // auto, the default: a check a day, and each new server process says it.
  const auto = machine();
  const daily = registry();
  for (const ms of [0, DAY / 2, DAY, DAY + 1])
    await checkForUpdates(auto.core, auto.env, { deps: deps(daily.latestVersion), now: at(ms) });
  assert.equal(daily.asked.length, 2, 'auto asks once a day');
  assert.match(String(await serverNotice(auto, at(DAY + 2))), /99\.0\.0 is out/);
  assert.match(String(await serverNotice(auto, at(DAY + 3))), /99\.0\.0 is out/, 'every new process says it');

  // every-14-days: the registry once in 14 days, and the notice once in 14 days for the whole machine.
  const spaced = machine({}, levelConfig('every-14-days', 'on'));
  const fortnightly = registry();
  for (const ms of [0, DAY, 13 * DAY, 14 * DAY - 1]) {
    await checkForUpdates(spaced.core, spaced.env, { deps: deps(fortnightly.latestVersion), now: at(ms) });
  }
  assert.equal(fortnightly.asked.length, 1, 'asked more than once in 14 days');
  await checkForUpdates(spaced.core, spaced.env, { deps: deps(fortnightly.latestVersion), now: at(14 * DAY) });
  assert.equal(fortnightly.asked.length, 2);
  assert.match(String(await serverNotice(spaced, at(14 * DAY + 1))), /99\.0\.0 is out/);
  assert.equal(await serverNotice(spaced, at(15 * DAY)), null, 'a second server said it inside 14 days');
  assert.equal(await commandNotice(spaced, at(20 * DAY)), '', 'a command said it inside 14 days');
  assert.match(await commandNotice(spaced, at(28 * DAY + 1)), /99\.0\.0 is out/);

  // never: no registry request, and no notice, whatever the file says.
  const off = machine({}, levelConfig('never', 'off'));
  const nobody = registry();
  const outcome = await checkForUpdates(off.core, off.env, { deps: deps(nobody.latestVersion), now: at(0) });
  assert.equal(outcome.asked, false);
  assert.deepEqual(nobody.asked, []);
  await seed(off, { latest: LATEST, behind: true }, at(0)());
  assert.equal(await serverNotice(off, at(1)), null);
  assert.equal(await commandNotice(off, at(1)), '');
});

test('AGENT_COMMS_UPDATES=never and CI switch it all off for the process, whatever the level', async () => {
  for (const extra of [{ AGENT_COMMS_UPDATES: 'never' }, { CI: 'true' }, { AGENT_COMMS_UPDATE_CHECK: 'off' }]) {
    const m = machine(extra);
    const nobody = registry();
    const outcome = await checkForUpdates(m.core, m.env, { deps: deps(nobody.latestVersion), now: at(0) });
    assert.equal(outcome.asked, false, JSON.stringify(extra));
    assert.deepEqual(nobody.asked, [], JSON.stringify(extra));
    await seed(m, { latest: LATEST, behind: true, release: { version: LATEST, security: true, needsDecision: false } });
    assert.equal(await serverNotice(m, () => new Date()), null, JSON.stringify(extra));
    assert.equal(await commandNotice(m, () => new Date()), '', JSON.stringify(extra));
  }
  // Any other word leaves the level alone.
  const on = machine({ AGENT_COMMS_UPDATES: 'auto' });
  await seed(on, { latest: LATEST, behind: true });
  assert.match(String(await serverNotice(on, () => new Date())), /is out/);
});

test('auto with its background job set up says only what needs the person: a restart, a major release, a decision', async () => {
  const m = machine();
  assert.equal(await updateJobInstalled(m.core), false, 'no job yet: auto is a daily check with a notice');
  mkdirSync(m.stateDir, { recursive: true });
  writeFileSync(join(m.stateDir, UPDATE_JOB_MARKER), '{}\n');
  assert.equal(await updateJobInstalled(m.core), true);
  const running = VERSION.split('.').map(Number) as [number, number, number];
  const minor = `${running[0]}.${running[1] + 1}.0`;
  const major = `${running[0] + 1}.0.0`;
  // A minor release the job installs on its own: nothing to say.
  await seed(m, { latest: minor, behind: true });
  assert.equal(await serverNotice(m, () => new Date()), null);
  assert.equal(await commandNotice(m, () => new Date()), '');
  // Installed, and this process older: restart.
  await seed(m, { latest: minor, behind: false, current: { registered: ['core'], global: [] } });
  assert.match(String(await serverNotice(m, () => new Date())), /is installed; restart the client/);
  // A major release waits for the person.
  await seed(m, { latest: major, behind: true, current: null });
  assert.match(
    String(await serverNotice(m, () => new Date())),
    new RegExp(`${major.replaceAll('.', '\\.')} is out, a major release`),
  );
  // One whose manifest needs a decision waits for the person too.
  await seed(m, { latest: minor, behind: true, release: { version: minor, security: false, needsDecision: true } });
  assert.match(String(await serverNotice(m, () => new Date())), /needs a decision from you/);
});

// ── The pause ───────────────────────────────────────────────────────────────────────────────────────────────────

test('a pause is 1, 7 or 14 days — 7 when no length is given — asks nobody, and a new one replaces the old', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true }, at(0)());
  const week = await updatePause(m.core, { now: at(0) });
  assert.equal(week.days, 7);
  assert.equal(week.pausedUntil, at(7 * DAY)().toISOString());
  assert.equal(await serverNotice(m, at(7 * DAY - 1)), null, 'a notice inside the pause');
  assert.equal(await commandNotice(m, at(DAY)), '');
  assert.match(String(await serverNotice(m, at(7 * DAY))), /is out/, 'the pause ran out');
  // Replaced, not added to: a day from now, from a day in.
  const day = await updatePause(m.core, { days: 1, now: at(8 * DAY) });
  assert.equal(day.pausedUntil, at(9 * DAY)().toISOString());
  const fortnight = await updatePause(m.core, { days: 14, now: at(8 * DAY) });
  assert.equal(fortnight.pausedUntil, at(22 * DAY)().toISOString());
  for (const days of [0, 2, 15, 30, -7, 7.5]) {
    await assert.rejects(
      updatePause(m.core, { days, now: at(0) }),
      (error: unknown) => {
        return error instanceof CommsError && error.code === 'USAGE';
      },
      String(days),
    );
  }
  // Resume ends it at once.
  const resumed = await updateResume(m.core, { now: at(8 * DAY) });
  assert.equal(resumed.resumed, true);
  assert.match(String(await serverNotice(m, at(9 * DAY))), /is out/);
  assert.equal((await updateResume(m.core, { now: at(8 * DAY) })).resumed, false, 'nothing to resume');
});

test('a pause never lasts longer than 14 days from when it was asked, however the clock jumps', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true }, at(0)());
  await updatePause(m.core, { days: 14, now: at(0) });
  // The clock goes back a month: the pause would have lasted six weeks. It ends; the notice is said.
  assert.match(String(await serverNotice(m, at(-30 * DAY))), /is out/);
  // A pause written by hand for longer than 14 days holds nothing.
  await seed(m, { pausedAt: at(0)().toISOString(), pausedUntil: at(60 * DAY)().toISOString() }, at(0)());
  assert.match(String(await serverNotice(m, at(DAY))), /is out/);
});

test('a pause never holds a security fix: its notice is said at once, with when the pause ends', async () => {
  const m = machine({}, levelConfig('every-14-days', 'on'));
  await seed(m, { latest: LATEST, behind: true, noticeAt: at(0)().toISOString() }, at(0)());
  const paused = await updatePause(m.core, { days: 14, now: at(0) });
  assert.equal(paused.security, null, 'no security fix is waiting');
  assert.equal(await serverNotice(m, at(DAY)), null);
  // The check finds the release fixes a security problem: said at once — inside the pause and the 14-day spacing.
  await seed(
    m,
    { latest: LATEST, behind: true, release: { version: LATEST, security: true, needsDecision: false } },
    at(DAY)(),
  );
  const line = String(await serverNotice(m, at(DAY + 1)));
  assert.match(line, /99\.0\.0 is out, and fixes a security problem/);
  assert.match(line, /paused until .*; a security fix is not held/);
  assert.match(await commandNotice(m, at(DAY + 2)), /fixes a security problem/);
  // A pause asked while one is waiting says so.
  const again = await updatePause(m.core, { days: 7, now: at(DAY + 3) });
  assert.equal(again.security, LATEST);
  // On never, the security fix a check by hand found is said too.
  const never = machine({}, levelConfig('never', 'off'));
  await seed(never, {
    latest: LATEST,
    behind: true,
    release: { version: LATEST, security: true, needsDecision: false },
  });
  assert.match(String(await serverNotice(never, () => new Date())), /fixes a security problem/);
});

test('the pause and resume over MCP and at a terminal: no approval, and the retired later and auto say what replaced them', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true });
  const { call, close } = await connect(m);
  try {
    const paused = (await call('comms_update', { pause: 14 })).structuredContent as {
      days: number;
      pausedUntil: string;
      approvalRequired?: boolean;
    };
    assert.equal(paused.approvalRequired, undefined, 'a pause asked for an approval');
    assert.equal(paused.days, 14);
    assert.equal(((await call('comms_update', { pause: true })).structuredContent as { days: number }).days, 7);
    assert.equal(
      ((await call('comms_update', { resume: true })).structuredContent as { resumed: boolean }).resumed,
      true,
    );
    assert.equal(codeOf(await call('comms_update', { pause: 3 })), 'USAGE');
    assert.equal(codeOf(await call('comms_update', { pause: 7, level: 'never' })), 'USAGE', 'one at a time');
    for (const [argument, value, words] of [
      ['later', true, /pause/],
      ['auto', 'off', /level/],
    ] as const) {
      const refused = await call('comms_update', { [argument]: value });
      assert.equal(codeOf(refused), 'USAGE', argument);
      const error = (refused.structuredContent as { error: { message: string; hint: string } }).error;
      assert.match(error.message, new RegExp(`no longer takes \`${argument}\``));
      assert.match(error.hint, words);
    }
  } finally {
    await close();
  }
  const run = (args: readonly string[]) => cli({ ...m.env, CLAUDECODE: '1' }, args);
  const pause = await run(['update', '--pause', '--json']);
  assert.equal(pause.status, 0, pause.stdout + pause.stderr);
  assert.equal((JSON.parse(pause.stdout) as { data: { days: number } }).data.days, 7);
  const one = await run(['update', '--pause', '1', '--json']);
  assert.equal((JSON.parse(one.stdout) as { data: { days: number } }).data.days, 1, one.stdout + one.stderr);
  assert.equal((await run(['update', '--pause', '5', '--json'])).status, 64);
  assert.equal((await run(['update', '--resume', '--json'])).status, 0);
  for (const [args, words] of [
    [['update', '--later', '--json'], /--pause/],
    [['update', '--auto', 'off', '--json'], /--level/],
  ] as const) {
    const refused = await run(args);
    assert.equal(refused.status, 64, refused.stdout + refused.stderr);
    assert.match((JSON.parse(refused.stdout) as { error: { hint: string } }).error.hint, words);
  }
  assert.equal((await readUpdateCheck(m.stateDir)).pausedUntil, null, 'resumed');
});
