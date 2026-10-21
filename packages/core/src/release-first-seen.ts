/**
 * When this machine first saw a release (design 2026-10-22 P4 and §7.2; plan gap 7).
 *
 * A background update holds a release from the time Rekor signed for it (`VerifiedProvenance.signedAt`). A release
 * whose provenance carries no signed time is held from the moment this machine first saw it instead. A registry can't
 * make that moment earlier, so the hold is never shorter than intended, and it is never permanent.
 *
 * - **The machine's clock:** a sight is recorded at the `now` it is asked with, which is the machine's own clock, not
 *   the run's: the run's clock is the earlier of the machine's and the registry's `Date`, which a registry could set
 *   back.
 * - **Never moved earlier:** a sight stands once recorded, whatever clock asks again. The one exception is a sight more
 *   than five minutes ahead of the clock. That sight was recorded while the clock ran ahead, and would otherwise hold
 *   the release for as long as the clock was ahead, so it is recorded again as now.
 * - **Content-free:** each sight is a package, a version, the integrity it was seen with, and when. Another integrity
 *   for the same version is another sight. The newest 128 are kept, in `<state>/release-first-seen.json`, written
 *   atomically under `<state>/.release-first-seen.lock`.
 * - **Never in the way:** a file that can't be read counts as empty. A sight that can't be written is seen now, and
 *   recorded by the next run that can write it. Whatever can still be read stands.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';

export const FIRST_SEEN_FILE = 'release-first-seen.json';

const FIRST_SEEN_LOCK = '.release-first-seen.lock';

/** How many sights are kept: the newest. */
const KEPT = 128;

/** How far ahead of the clock a recorded sight may be and still stand: two processes read their clocks apart. */
const AHEAD_MS = 5 * 60_000;

/** A release as this machine saw it: its package, its version, and the integrity the registry gave for it. */
export interface SeenRelease {
  package: string;
  version: string;
  integrity: string;
}

interface Sight extends SeenRelease {
  /** When this machine first saw it, ISO. */
  at: string;
}

function isTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const at = new Date(value);
  return !Number.isNaN(at.getTime()) && at.toISOString() === value;
}

const sameRelease = (a: SeenRelease, b: SeenRelease): boolean =>
  a.package === b.package && a.version === b.version && a.integrity === b.integrity;

/** The sights recorded, each once, at its earliest: none when the file is missing or cannot be read. */
async function readSights(stateDir: string): Promise<Sight[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(stateDir, FIRST_SEEN_FILE), 'utf8'));
  } catch {
    return [];
  }
  const listed =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).seen
      : undefined;
  if (!Array.isArray(listed)) return [];
  const sights: Sight[] = [];
  for (const item of listed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const { package: name, version, integrity, at } = item as Record<string, unknown>;
    if (typeof name !== 'string' || typeof version !== 'string' || typeof integrity !== 'string' || !isTime(at))
      continue;
    const sight: Sight = { package: name, version, integrity, at };
    const twice = sights.findIndex((other) => sameRelease(other, sight));
    if (twice === -1) sights.push(sight);
    else if (Date.parse(at) < Date.parse((sights[twice] as Sight).at)) sights[twice] = sight;
  }
  return sights;
}

/** Each release's first sight at `now`, and the sights with any new one added, or a far-ahead one seen again. */
function look(
  recorded: readonly Sight[],
  releases: readonly SeenRelease[],
  now: Date,
): { times: Map<string, Date>; sights: Sight[]; changed: boolean } {
  const sights = [...recorded];
  const times = new Map<string, Date>();
  let changed = false;
  for (const release of releases) {
    const key = `${release.package}@${release.version}`;
    const at = sights.findIndex((sight) => sameRelease(sight, release));
    const found = sights[at];
    if (found !== undefined && Date.parse(found.at) - now.getTime() <= AHEAD_MS) {
      times.set(key, new Date(found.at));
      continue;
    }
    const seen: Sight = {
      package: release.package,
      version: release.version,
      integrity: release.integrity,
      at: now.toISOString(),
    };
    if (found === undefined) sights.push(seen);
    else sights[at] = seen;
    times.set(key, new Date(now.getTime()));
    changed = true;
  }
  return { times, sights, changed };
}

/** The newest `KEPT`, newest first. A sort is stable, so sights seen at the same moment keep their order. */
function newest(sights: readonly Sight[]): Sight[] {
  return [...sights].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, KEPT);
}

/**
 * When this machine first saw each release, by `${package}@${version}`. One never seen is recorded at `now`, the
 * machine's own clock. A record more than 5 minutes ahead of `now` is recorded again as `now`. With
 * `record: false`, nothing is written, and an unseen release reads as `now`.
 */
export async function firstSeenTimes(
  stateDir: string,
  releases: readonly SeenRelease[],
  now: Date,
  options: { record?: boolean } = {},
): Promise<Map<string, Date>> {
  if (options.record === false) return look(await readSights(stateDir), releases, now).times;
  try {
    return await withFileLock(join(stateDir, FIRST_SEEN_LOCK), async () => {
      const { times, sights, changed } = look(await readSights(stateDir), releases, now);
      if (changed) {
        await writeFileAtomic(
          join(stateDir, FIRST_SEEN_FILE),
          `${JSON.stringify({ seen: newest(sights) }, null, 2)}\n`,
        );
      }
      return times;
    });
  } catch {
    // The lock could not be taken, or the file could not be written. What can be read still stands, and the rest is
    // seen now, never earlier. The next run that can write records it.
    return look(await readSights(stateDir), releases, now).times;
  }
}
