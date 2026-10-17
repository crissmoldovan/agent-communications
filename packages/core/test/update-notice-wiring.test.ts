import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { Streams } from '../src/cli-runtime.ts';
import { launcherPaths } from '../src/launcher.ts';
import { updatePause } from '../src/operations/update-settings.ts';
import { updateNoticeAtTerminal, updateToolNotice } from '../src/update-gate.ts';
import { type BackgroundNotice, readUpdateCheck } from '../src/update-state.ts';
import { BACKGROUND_WORDS } from '../src/update-words.ts';
import { VERSION } from '../src/version.ts';
import { coreInline } from './helpers/handoffs.ts';
import { LATEST, type Machine, machine, markJobSetUp, seed } from './helpers/update-machine.ts';

/*
 * Tracks A, B, C and D's notices, wired into one line (design 2026-10-16, U1, U2, U4, U5 step 7, U6): what a
 * background run left for the next session, the offer to set up the background job where `auto` has none, and the one
 * approved update that moves a registration still naming a versioned runtime onto the stable launcher.
 *
 * Nothing here reaches npm or schedules a job: the state file is seeded by hand, and the job's marker is a file.
 */

const [major, minor] = VERSION.split('.').map(Number) as [number, number, number];
const NEXT_MINOR = `${major}.${minor + 1}.0`;
const NEXT_MAJOR = `${major + 1}.0.0`;

/** A fresh server process's notice: what its first tool result carries, and what its second does. */
async function serverTwice(m: Machine, env: Record<string, string> = m.env): Promise<[string | null, string | null]> {
  const notice = updateToolNotice({ core: m.core, env, channel: 'core', running: VERSION, exempt: [] });
  return [await notice('comms_audit_tail'), await notice('comms_audit_tail')];
}

/** What a command prints on stderr. */
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
    output: { json: true, color: false, platform: 'darwin' },
    streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr } as unknown as Streams,
  });
  return said;
}

const left = (outcome: BackgroundNotice['outcome'], version: string | null, text: string): BackgroundNotice => ({
  at: new Date().toISOString(),
  outcome,
  version,
  text,
});

/** The stable core launcher, as Track B writes it: what the background job runs, so what its setup needs. */
function coreLauncher(m: Machine): void {
  const { launcher } = launcherPaths(m.core.paths.dataDir, 'core');
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 });
}

// ── What a background run left (U5 step 7) ───────────────────────────────────────────────────────────────────────

test('a background run’s notice is the next session’s line, once, and then it is cleared: installed, refused, a skipped major', async () => {
  // The sentences a run leaves (`update-words.ts`): the notice says one only as it is, word for word.
  for (const [outcome, version, text] of [
    ['installed', NEXT_MINOR, BACKGROUND_WORDS.installed(NEXT_MINOR)],
    ['refused', NEXT_MINOR, BACKGROUND_WORDS.unverified(NEXT_MINOR, 'attestation')],
    ['skipped', NEXT_MAJOR, BACKGROUND_WORDS.major(NEXT_MAJOR)],
  ] as const) {
    const m = machine();
    markJobSetUp(m);
    await seed(m, { latest: version, behind: true, backgroundNotice: left(outcome, version, text) });
    const [first, second] = await serverTwice(m);
    assert.ok(first?.includes(text), `${outcome}: ${first}`);
    assert.equal(second, null, `${outcome}: said once in a process`);
    // A major release is said once, in the run's words: not again in the notice's own beside them.
    assert.equal((first ?? '').split(version).length - 1, 1, `${outcome}: ${first}`);
    assert.equal((await readUpdateCheck(m.stateDir)).backgroundNotice ?? null, null, `${outcome}: cleared once shown`);
    const [later] = await serverTwice(m);
    assert.ok(!later?.includes(text), `${outcome}: the next process does not say it again: ${later}`);
  }
});

test('a background run’s notice waits for a pause, is never said where updates are off, and "installed" only to a process behind it', async () => {
  const text = BACKGROUND_WORDS.installed(VERSION);
  // A process already running what was installed: nothing to restart into, and the notice is left for one that is not.
  const current = machine();
  markJobSetUp(current);
  await seed(current, { latest: VERSION, behind: false, backgroundNotice: left('installed', VERSION, text) });
  assert.deepEqual(await serverTwice(current), [null, null]);
  assert.equal((await readUpdateCheck(current.stateDir)).backgroundNotice?.text, text, 'left for a process behind it');

  const refused = BACKGROUND_WORDS.unverified(NEXT_MINOR, 'attestation');
  const paused = machine();
  markJobSetUp(paused);
  await seed(paused, { latest: NEXT_MINOR, behind: true, backgroundNotice: left('refused', NEXT_MINOR, refused) });
  await updatePause(paused.core, { days: 7 });
  assert.deepEqual(await serverTwice(paused), [null, null]);
  assert.equal((await readUpdateCheck(paused.stateDir)).backgroundNotice?.text, refused, 'kept until the pause ends');
  assert.deepEqual(await serverTwice(paused, { ...paused.env, AGENT_COMMS_UPDATES: 'never' }), [null, null]);

  // A command says it once, on stderr, and clears it.
  const command = machine();
  markJobSetUp(command);
  await seed(command, { latest: NEXT_MINOR, behind: true, backgroundNotice: left('refused', NEXT_MINOR, refused) });
  assert.ok((await commandNotice(command)).includes(refused));
  assert.equal((await readUpdateCheck(command.stateDir)).backgroundNotice ?? null, null);
});

// ── auto without its job offers it (U2, U4) ─────────────────────────────────────────────────────────────────────

test('auto without its background job: the notice offers setting it up, naming the approval it shows', async () => {
  const m = machine();
  coreLauncher(m);
  await seed(m, { latest: LATEST, behind: true });
  const [line] = await serverTwice(m);
  assert.match(String(line), /is out; say "update"/);
  assert.match(String(line), /comms_update with backgroundJob "on"/);
  assert.match(String(line), /shows the job, when it runs and how to remove it, and sets nothing up without your yes/);
  const said = await commandNotice(m);
  assert.ok(
    said.includes(coreInline(m.core.paths, ['update', '--background-job', 'on'], 'darwin')),
    `the command names this installation's own: ${said}`,
  );

  // With the job set up there is nothing to offer, and where it cannot be set up nothing is offered.
  const job = machine();
  coreLauncher(job);
  markJobSetUp(job);
  await seed(job, { latest: NEXT_MAJOR, behind: true });
  assert.doesNotMatch(String((await serverTwice(job))[0]), /backgroundJob/);
  for (const config of [{ defaults: { updates: 'every-14-days' } }, { defaults: { updates: 'auto' } }]) {
    const none = machine({}, config);
    await seed(none, { latest: LATEST, behind: true });
    const [said] = await serverTwice(none);
    assert.ok(said !== null, JSON.stringify(config));
    assert.doesNotMatch(String(said), /backgroundJob/, `${JSON.stringify(config)}: ${said}`);
  }
});

// ── A registration still naming a versioned runtime (U6, Track B's "moves") ──────────────────────────────────────

test('a registration still naming a versioned runtime: the notice says one approved update moves it to the stable launcher', async () => {
  // Nothing newer is out: the move alone is worth a line.
  const m = machine();
  await seed(m, { latest: VERSION, behind: false, moves: 2 });
  const [line, again] = await serverTwice(m);
  assert.match(String(line), /2 registrations still start a versioned runtime/);
  assert.match(String(line), /one approved update \(say "update"\) moves them onto the stable launcher/);
  assert.equal(again, null);
  const said = await commandNotice(m);
  assert.match(said, /2 registrations still start a versioned runtime/);
  assert.ok(said.includes(coreInline(m.core.paths, ['update'], 'darwin')), said);

  // Behind as well: one line, the update and the move together.
  const behind = machine();
  markJobSetUp(behind);
  await seed(behind, { latest: NEXT_MAJOR, behind: true, moves: 1 });
  const [both] = await serverTwice(behind);
  assert.match(String(both), new RegExp(`${NEXT_MAJOR.replaceAll('.', '\\.')} is out`));
  assert.match(String(both), /also moves one registration onto the stable launcher/);

  // never, and a machine with nothing to move, say nothing of it.
  const never = machine({}, { defaults: { updates: 'never' } });
  await seed(never, { latest: VERSION, behind: false, moves: 3 });
  assert.deepEqual(await serverTwice(never), [null, null]);
  const moved = machine();
  await seed(moved, { latest: VERSION, behind: false, moves: 0 });
  assert.deepEqual(await serverTwice(moved), [null, null]);
});
