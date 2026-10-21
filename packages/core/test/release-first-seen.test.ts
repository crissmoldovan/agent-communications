import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIRST_SEEN_FILE, firstSeenTimes, type SeenRelease } from '../src/release-first-seen.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * When this machine first saw a release (design 2026-10-22 P4, §7.2; plan gap 7): the moment a hold counts from when
 * a release carries no time Rekor signed. It is recorded at the machine's own clock, so a registry cannot make it
 * earlier, and it is never moved earlier — except a sight recorded while the clock ran far ahead, which would
 * otherwise hold a release for as long as the clock was ahead (Review Focus 4).
 */

const CORE = '@agentcomms/core';
const GMAIL = '@agentcomms/gmail';
const T0 = new Date('2026-10-20T10:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const release = (version: string, packageName = CORE, integrity = `sha512-${version}`): SeenRelease => ({
  package: packageName,
  version,
  integrity,
});
const later = (ms: number): Date => new Date(T0.getTime() + ms);
const keyOf = (seen: SeenRelease): string => `${seen.package}@${seen.version}`;

function file(stateDir: string): { seen: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(stateDir, FIRST_SEEN_FILE), 'utf8'));
}

async function timeOf(stateDir: string, seen: SeenRelease, now: Date, options?: { record?: boolean }) {
  const times = await firstSeenTimes(stateDir, [seen], now, options);
  return times.get(keyOf(seen))?.toISOString();
}

test("a release first seen is recorded at the machine's clock, and read back unchanged", async () => {
  const state = tempDir();
  const times = await firstSeenTimes(state, [release('0.26.0'), release('0.26.0', GMAIL)], T0);
  assert.deepEqual(
    [...times].map(([key, at]) => [key, at.toISOString()]),
    [
      [`${CORE}@0.26.0`, T0.toISOString()],
      [`${GMAIL}@0.26.0`, T0.toISOString()],
    ],
  );
  assert.deepEqual(file(state), {
    seen: [
      { package: CORE, version: '0.26.0', integrity: 'sha512-0.26.0', at: T0.toISOString() },
      { package: GMAIL, version: '0.26.0', integrity: 'sha512-0.26.0', at: T0.toISOString() },
    ],
  });
  // Asked again, a day on: the sight stands, and the file is not rewritten.
  const before = readFileSync(join(state, FIRST_SEEN_FILE), 'utf8');
  assert.equal(await timeOf(state, release('0.26.0'), later(DAY)), T0.toISOString());
  assert.equal(readFileSync(join(state, FIRST_SEEN_FILE), 'utf8'), before);
});

test('a recorded first sight is never moved earlier, whatever clock asks', async () => {
  const state = tempDir();
  await timeOf(state, release('0.26.0'), T0);
  // A clock a few minutes behind — another process, read a moment apart — gets the recorded time, not its own.
  assert.equal(await timeOf(state, release('0.26.0'), later(-4 * MINUTE)), T0.toISOString());
  assert.equal(await timeOf(state, release('0.26.0'), later(-5 * MINUTE)), T0.toISOString());
  // Nor later: a month on, it is still the first sight.
  assert.equal(await timeOf(state, release('0.26.0'), later(30 * DAY)), T0.toISOString());
  assert.equal(file(state).seen[0]?.at, T0.toISOString());
});

test('a first sight recorded more than five minutes ahead of the clock is recorded again as now', async () => {
  const state = tempDir();
  // Seen while the clock ran a year ahead; the clock is then put right.
  await timeOf(state, release('0.26.0'), later(365 * DAY));
  assert.equal(await timeOf(state, release('0.26.0'), T0), T0.toISOString());
  assert.equal(file(state).seen[0]?.at, T0.toISOString(), 'recorded again');
  // The bound: five minutes ahead is a clock read a moment apart, and stands; a millisecond more does not.
  const edge = tempDir();
  await timeOf(edge, release('0.26.0'), later(5 * MINUTE));
  assert.equal(await timeOf(edge, release('0.26.0'), T0), later(5 * MINUTE).toISOString());
  const past = tempDir();
  await timeOf(past, release('0.26.0'), later(5 * MINUTE + 1));
  assert.equal(await timeOf(past, release('0.26.0'), T0), T0.toISOString());
});

test('another integrity for the same version is another sight', async () => {
  const state = tempDir();
  await timeOf(state, release('0.26.0', CORE, 'sha512-first'), T0);
  assert.equal(await timeOf(state, release('0.26.0', CORE, 'sha512-other'), later(DAY)), later(DAY).toISOString());
  assert.equal(await timeOf(state, release('0.26.0', CORE, 'sha512-first'), later(2 * DAY)), T0.toISOString());
  assert.deepEqual(
    file(state)
      .seen.map((seen) => `${seen.integrity} ${seen.at}`)
      .sort(),
    [`sha512-first ${T0.toISOString()}`, `sha512-other ${later(DAY).toISOString()}`],
  );
});

test('record false writes nothing, and an unseen release reads as now', async () => {
  const state = tempDir();
  assert.equal(await timeOf(state, release('0.26.0'), T0, { record: false }), T0.toISOString());
  assert.equal(existsSync(join(state, FIRST_SEEN_FILE)), false);
  assert.equal(existsSync(join(state, '.release-first-seen.lock')), false);

  // A recorded sight is read; one never seen, and one recorded far ahead, read as now; the file is left as it was.
  await timeOf(state, release('0.25.0'), T0);
  await timeOf(state, release('0.24.0'), later(365 * DAY));
  const before = readFileSync(join(state, FIRST_SEEN_FILE), 'utf8');
  const times = await firstSeenTimes(state, [release('0.25.0'), release('0.24.0'), release('0.26.0')], later(DAY), {
    record: false,
  });
  assert.equal(times.get(`${CORE}@0.25.0`)?.toISOString(), T0.toISOString());
  assert.equal(times.get(`${CORE}@0.24.0`)?.toISOString(), later(DAY).toISOString());
  assert.equal(times.get(`${CORE}@0.26.0`)?.toISOString(), later(DAY).toISOString());
  assert.equal(readFileSync(join(state, FIRST_SEEN_FILE), 'utf8'), before);
});

const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

test('a file that cannot be read is treated as empty and written afresh', async () => {
  for (const garbage of ['{"seen": [', 'null', '[]', '{"seen": "all"}', '\u0000\u0001']) {
    const state = tempDir();
    writeFileSync(join(state, FIRST_SEEN_FILE), garbage);
    assert.equal(await timeOf(state, release('0.26.0'), T0), T0.toISOString(), garbage);
    assert.deepEqual(file(state), {
      seen: [{ package: CORE, version: '0.26.0', integrity: 'sha512-0.26.0', at: T0.toISOString() }],
    });
  }
});

test('one that cannot be written gives now', {
  skip: canChmod
    ? false
    : 'Windows has no POSIX modes, and root writes through them: a folder cannot be made read-only',
}, async (t) => {
  const state = tempDir();
  await timeOf(state, release('0.25.0'), T0);
  chmodSync(state, 0o500);
  t.after(() => chmodSync(state, 0o700));
  // No throw: an unseen release reads as now, and nothing is written.
  assert.equal(await timeOf(state, release('0.26.0'), later(DAY)), later(DAY).toISOString());
  assert.deepEqual(
    file(state).seen.map((seen) => seen.version),
    ['0.25.0'],
  );
  // A sight it can still read is still the first sight, never now: now would restart the hold on every run, for as
  // long as the folder stays read-only.
  assert.equal(await timeOf(state, release('0.25.0'), later(DAY)), T0.toISOString());
});

test('two runs at once keep both sights', async () => {
  const state = tempDir();
  const versions = ['0.26.0', '0.26.1', '0.26.2', '0.26.3', '0.26.4', '0.26.5', '0.26.6', '0.26.7'];
  await Promise.all(versions.map((version, index) => timeOf(state, release(version), later(index * MINUTE))));
  assert.deepEqual(
    file(state)
      .seen.map((seen) => seen.version)
      .sort(),
    versions,
  );
});

test('only package, version, integrity and at are kept, the newest 128', async () => {
  const state = tempDir();
  // 130 sights, each with something more, an hour apart, and some that are not sights at all.
  const seen = Array.from({ length: 130 }, (_, index) => ({
    package: CORE,
    version: `0.1.${index}`,
    integrity: `sha512-${index}`,
    at: new Date(T0.getTime() - (130 - index) * 60 * MINUTE).toISOString(),
    note: 'more than a sight',
  }));
  writeFileSync(
    join(state, FIRST_SEEN_FILE),
    JSON.stringify({
      seen: [
        ...seen,
        null,
        'a sight',
        { package: CORE, version: '0.0.1', integrity: 'sha512-x', at: 'not a time' },
        { package: CORE, version: 7, integrity: 'sha512-x', at: T0.toISOString() },
      ],
      more: true,
    }),
  );
  await timeOf(state, release('0.26.0'), T0);
  const kept = file(state);
  assert.deepEqual(Object.keys(kept), ['seen']);
  assert.equal(kept.seen.length, 128);
  for (const record of kept.seen)
    assert.deepEqual(Object.keys(record).sort(), ['at', 'integrity', 'package', 'version']);
  const versions = new Set(kept.seen.map((record) => record.version));
  assert.ok(versions.has('0.26.0'), 'the newest is kept');
  for (const oldest of ['0.1.0', '0.1.1', '0.1.2']) assert.ok(!versions.has(oldest), `${oldest} is dropped`);
  assert.ok(versions.has('0.1.3') && versions.has('0.1.129'));
});
