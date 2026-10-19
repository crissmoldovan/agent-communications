import type { UpdateLevel } from '../config.ts';
import type { Core } from '../core.ts';
import {
  inspectUpdateJob,
  type UpdateJobDeps,
  type UpdateJobState,
  updateJobContext,
  updateJobHealth,
  updateJobSupported,
} from '../update-job.ts';
import {
  countedLatest,
  type EffectiveUpdates,
  effectiveUpdates,
  pauseEnd,
  readUpdateCheck,
  securityRelease,
} from '../update-state.ts';
import { VERSION } from '../version.ts';

/**
 * Where updates stand on this machine, from a terminal (`agentcomms update --status`) or a chat (`comms_update` with
 * `status: true`): desktop design 2026-10-19, DA13. The desktop app reads it every 15 seconds, so it is read from local
 * files alone — the configuration, `update-check.json` and the background job's own files and record — and asks npm
 * nothing: no check, however due, and no notice. On Windows the scheduler is asked about the job only when this
 * installation recorded one, as the doctor asks it.
 */

export interface UpdateStatus {
  /** The level in force: the one set, capped by an organisation, unless the environment switched updates off. */
  level: UpdateLevel;
  /** The level `config.json` sets. */
  set: UpdateLevel;
  /** What decided `level`: the configuration and its caps, or the environment (`CI`, or a switch's name). */
  by: EffectiveUpdates['by'];
  /** An organisation profile's cap below the level set: the cap in force, and whose. Null when none holds. */
  cap: { level: 'every-14-days' | 'never'; organisation: string } | null;
  /** When a pause holding now ends, as an ISO time; null when none holds. */
  pausedUntil: string | null;
  /** When npm was last asked, as an ISO time, whether or not it answered; null when never. */
  lastChecked: string | null;
  /** The latest release that check named, as a plain version; null when none is known. */
  latest: string | null;
  /** The release this command or server is. */
  running: string;
  /** A security fix that is out and that `running` is behind; null when there is none. */
  security: string | null;
  /** Why the last check got no answer, when it got none. */
  lastError: string | null;
  /** The background update job. */
  job: {
    /**
     * Where it stands, as the doctor reads it — or `unsupported` on a platform it is not offered on, or `unreadable`
     * when its files, its record or the scheduler could not be read; then `reason` says why, and the rest is null.
     */
    state: UpdateJobState | 'unsupported' | 'unreadable';
    /** Its file — the service, on Linux — or on Windows its task. Null when nothing is set up or recorded there. */
    where: string | null;
    /** When this installation set it up, from its record. */
    installedAt: string | null;
    /** When a background run last ran, from its record. */
    lastRun: string | null;
    /** Whether it ran in the last 48 hours, or was set up less than 48 hours ago; null with no record. */
    working: boolean | null;
    /** Why the job could not be read: only with `unreadable`. */
    reason?: string;
  };
}

export async function updateStatus(
  core: Core,
  env: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform | undefined;
    job?: UpdateJobDeps | undefined;
    now?: (() => Date) | undefined;
  } = {},
): Promise<UpdateStatus> {
  const now = (options.now ?? (() => new Date()))();
  const platform = options.platform ?? process.platform;
  const [updates, record] = await Promise.all([effectiveUpdates(core, env, now), readUpdateCheck(core.paths.stateDir)]);
  return {
    level: updates.level,
    set: updates.set,
    by: updates.by,
    cap: updates.cap === undefined ? null : { level: updates.cap.level, organisation: updates.cap.organisation },
    pausedUntil: pauseEnd(record, now)?.toISOString() ?? null,
    lastChecked: record.lastChecked,
    latest: countedLatest(record),
    running: VERSION,
    security: securityRelease(record, VERSION),
    lastError: record.lastError,
    job: await jobStatus(core, env, platform, options.job, now),
  };
}

async function jobStatus(
  core: Core,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  deps: UpdateJobDeps | undefined,
  now: Date,
): Promise<UpdateStatus['job']> {
  if (!updateJobSupported(platform)) {
    return { state: 'unsupported', where: null, installedAt: null, lastRun: null, working: null };
  }
  let seen: Awaited<ReturnType<typeof inspectUpdateJob>>;
  let health: Awaited<ReturnType<typeof updateJobHealth>>;
  try {
    seen = await inspectUpdateJob(updateJobContext(core, env, { platform, deps }), { query: 'when-recorded' });
    health = await updateJobHealth(core.paths.stateDir, now);
  } catch (error) {
    // One part that cannot be read does not take the rest of the status with it: the app polls this, and a level, a
    // pause or a security fix waiting is still worth saying. The job says it could not be read, and why.
    const why = error instanceof Error ? error.message : String(error);
    return {
      state: 'unreadable',
      where: null,
      installedAt: null,
      lastRun: null,
      working: null,
      reason: `the background job could not be read: ${why}`,
    };
  }
  return {
    state: seen.state,
    where: seen.state === 'not-set-up' ? null : seen.where,
    installedAt: seen.marker?.installedAt ?? null,
    lastRun: seen.marker?.lastRun ?? null,
    working: health?.working ?? null,
  };
}
