import { stat } from 'node:fs/promises';
import type { GatedChange } from '../change-flow.ts';
import type { ChangeSurface } from '../changes.ts';
import { type Config, updateCheckSetting } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { handoffSentence, handoffText, requireHandoffs } from '../handoffs.ts';
import {
  inspectUpdateJob,
  installUpdateJob,
  removeUpdateJob,
  UPDATE_JOB_HOUR,
  type UpdateJobContext,
  type UpdateJobDeps,
  type UpdateJobInspection,
  type UpdateJobPlatform,
  updateJobCommand,
  updateJobContext,
  updateJobSupported,
} from '../update-job.ts';

/**
 * The background update job on or off for this machine, from a terminal (`update --background-job on|off`) or a chat
 * (`comms_update` with `backgroundJob`): design 2026-10-16 U4.
 *
 * Setting it up is a change the person approves. It loosens no setting in `config.json` — it is an effect, as "not
 * now" is — so its preview names what it does: the job's file and what it runs, when it runs, what macOS shows, and
 * how to take it away. Taking it away applies at once and asks nobody: it only ever makes this machine do less.
 *
 * It is refused, before anything is prepared or run, where it would do no good or harm: an organisation profile that
 * turns background updates off (U8), a level at which nothing installs in the background, the stable launcher not
 * there yet, a job at its place that this installation did not write.
 */

export type UpdateJobSetting = 'on' | 'off';

/** The update level as the job reads it: Track A's levels (U2). Until they land, `updateCheck: off` reads as never. */
export type UpdateLevel = 'auto' | 'every-14-days' | 'never';

export interface UpdateJobOptions {
  /**
   * False when an organisation profile on this machine says `updates.background: false` (U8): setting the job up is
   * refused. Track A's organisation cap supplies it; until then nothing here turns it off.
   */
  background?: boolean | undefined;
  /** The level in force. Left out, read from the configuration: `updateCheck: off` is `never` (U2's migration). */
  level?: UpdateLevel | undefined;
  /** The stable core launcher the job runs: Track B's `launcherPaths(dataDir, 'core').launcher`. */
  launcher?: string | undefined;
  /** The platform the job is for, and the shell the commands it names are quoted for. */
  platform?: NodeJS.Platform | undefined;
  /** For a test: the runner, the user, the random minute and the clock. */
  deps?: UpdateJobDeps | undefined;
  /** Where the change came from, for the audit log. */
  surface?: ChangeSurface | undefined;
}

export interface UpdateJobResult {
  /** Where the job stands now. */
  backgroundJob: UpdateJobSetting;
  /** False when it already was, and nothing was done. */
  changed: boolean;
  platform: NodeJS.Platform;
  /** The job's file, or on Windows its task. */
  where: string;
  /** What it runs, word by word. */
  command: string[];
  /** When it runs, in words; null when there is no job. */
  schedule: string | null;
  /** A job at its place that this installation did not write, left as it is, and why it is not this one's. */
  foreign?: { where: string; reason: string } | undefined;
  /**
   * With the job set up: the command that removes it, located for this installation — or why there is none here. The
   * preview names it in words: a located command, with its four folders, is longer than a preview line shows.
   */
  remove?: string | undefined;
}

/** When each platform's job runs, in words. `minute` is the macOS job's, once it is chosen. */
function scheduleOf(platform: UpdateJobPlatform, minute?: number | undefined): string {
  if (platform === 'darwin') {
    return minute === undefined
      ? `daily at ${UPDATE_JOB_HOUR}:00 local time and a random minute, chosen as it is set up — and at the next wake when the Mac was asleep then`
      : `daily at ${UPDATE_JOB_HOUR}:${String(minute).padStart(2, '0')} local time, and at the next wake when the Mac was asleep then`;
  }
  if (platform === 'linux') {
    return 'daily, at a random moment in the hour after midnight — and at the next start when the computer was off then';
  }
  return `daily at ${UPDATE_JOB_HOUR}:00 local time, after a random delay of up to an hour — as soon as it can after a start it missed, on battery too`;
}

function levelOf(config: Config, given: UpdateLevel | undefined): UpdateLevel {
  return given ?? (updateCheckSetting(config) === 'off' ? 'never' : 'auto');
}

export function updateJobChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  setting: UpdateJobSetting,
  options: UpdateJobOptions = {},
): GatedChange<UpdateJobResult> {
  if (setting !== 'on' && setting !== 'off') {
    throw new CommsError('USAGE', `"${String(setting)}" is not a setting of the background update job; use on or off`);
  }
  const platform = options.platform ?? process.platform;
  const context: UpdateJobContext = updateJobContext(core, env, {
    platform,
    launcher: options.launcher,
    deps: options.deps,
  });
  const handoffs = requireHandoffs(core, platform);
  let planned: { inspection: UpdateJobInspection; acts: boolean } | null = null;
  const result = (
    backgroundJob: UpdateJobSetting,
    changed: boolean,
    inspection: UpdateJobInspection,
    extra: Partial<UpdateJobResult> = {},
  ): UpdateJobResult => ({
    backgroundJob,
    changed,
    platform,
    where: inspection.where,
    command: updateJobCommand(context),
    schedule: backgroundJob === 'on' && updateJobSupported(platform) ? scheduleOf(platform, inspection.minute) : null,
    ...extra,
  });

  if (setting === 'off') {
    return {
      plan: async (config) => {
        planned = { inspection: await inspectUpdateJob(context, { query: 'always' }), acts: false };
        return { before: config, after: config, summary: 'Remove the background update job from this machine' };
      },
      apply: async () => {
        if (planned === null) throw new CommsError('UNEXPECTED', 'the job was removed before it was planned');
        const removed = await removeUpdateJob(context, planned.inspection);
        if (removed.removed) {
          await core.audit.append({
            inboxId: '',
            operation: 'update.job.off',
            outcome: 'ok',
            ...(options.surface === undefined ? {} : { surface: options.surface }),
          });
        }
        return result('off', removed.removed, planned.inspection, {
          schedule: null,
          ...(removed.foreign === undefined ? {} : { foreign: removed.foreign }),
        });
      },
    };
  }

  const off = handoffs.core(['update', '--background-job', 'off']);
  return {
    plan: async (config) => {
      if (!updateJobSupported(platform)) {
        throw new CommsError(
          'CONFIG',
          'nothing was set up: a background update job is offered on macOS, Linux and Windows only',
        );
      }
      if (options.background === false) {
        throw new CommsError(
          'CONFIG',
          'nothing was set up: an organisation profile on this machine turns background updates off',
          {
            hint: handoffSentence(
              handoffs.core(['update']),
              (update) =>
                `Updates are still checked daily, and a notice says when one is out: run ${update} (comms_update from a chat) when it suits you.`,
            ),
          },
        );
      }
      const level = levelOf(config, options.level);
      if (level !== 'auto') {
        throw new CommsError('CONFIG', `nothing was set up: at the level ${level} nothing installs in the background`, {
          hint: handoffSentence(
            handoffs.core(['update', '--auto', 'on']),
            (command) => `Turn updates back on with ${command} first, then set up the job.`,
          ),
        });
      }
      const inspection = await inspectUpdateJob(context, { query: 'always' });
      if (inspection.state === 'foreign') {
        throw new CommsError(
          'CONFIG',
          `nothing was set up: ${inspection.where} is a job this installation did not write (${inspection.reason})`,
          {
            hint: 'Remove it with the installation that set it up, or by hand if you do not want it, and set this one up again.',
          },
        );
      }
      if (inspection.state === 'stale' && /launcher/.test(inspection.reason ?? '')) {
        throw launcherMissing(context, handoffs);
      }
      if (inspection.state === 'not-set-up' || inspection.state === 'missing') {
        const there = await stat(context.launcher).then(
          () => true,
          () => false,
        );
        if (!there) throw launcherMissing(context, handoffs);
      }
      const acts = inspection.state !== 'installed';
      planned = { inspection, acts };
      return {
        before: config,
        after: config,
        effects: acts ? previewLines(context, inspection, platform as UpdateJobPlatform) : [],
        summary: 'Set up the background update job on this machine',
      };
    },
    apply: async () => {
      if (planned === null) throw new CommsError('UNEXPECTED', 'the job was set up before it was planned');
      const { inspection, acts } = planned;
      const remove = handoffText(off);
      if (!acts) return result('on', false, inspection, { remove });
      const installed = await installUpdateJob(context, inspection);
      await core.audit.append({
        inboxId: '',
        operation: 'update.job.on',
        outcome: 'ok',
        ...(options.surface === undefined ? {} : { surface: options.surface }),
      });
      return result('on', true, { ...inspection, minute: installed.minute }, { remove });
    },
    refuseApproval: () =>
      new CommsError(
        'USAGE',
        'nothing was changed: the background update job is already set up, so this takes no approval',
        {
          hint: 'Leave the approval out to see where it stands, or run the doctor.',
        },
      ),
  };
}

function launcherMissing(context: UpdateJobContext, handoffs: ReturnType<typeof requireHandoffs>): CommsError {
  return new CommsError(
    'CONFIG',
    `nothing was set up: the stable launcher the job runs, ${context.launcher}, is not there yet`,
    {
      hint: handoffSentence(
        handoffs.core(['update']),
        (update) =>
          `Run ${update} first (comms_update from a chat): it moves this machine to the launcher. Then set up the job.`,
      ),
    },
  );
}

/**
 * What the person reads before saying yes: the file and what it runs, when, what macOS shows, and how to remove it —
 * each its own line, since a preview shows 300 characters of one. How to remove it is said in words: the command, located
 * with this installation's four folders, is longer than that; the result of setting it up gives it whole.
 */
function previewLines(
  context: UpdateJobContext,
  inspection: UpdateJobInspection,
  platform: UpdateJobPlatform,
): string[] {
  const again = inspection.state === 'stale' ? `, replacing this installation's own (${inspection.reason})` : '';
  const what =
    platform === 'darwin'
      ? [
          `writes ${inspection.where}${again}`,
          `a LaunchAgent of your own, needing no administrator, loaded with launchctl bootstrap gui/${context.uid}`,
        ]
      : platform === 'linux'
        ? [
            `writes ${inspection.files.join(' and ')}${again}`,
            'a systemd timer of your own, needing no administrator, enabled with systemctl --user enable --now',
          ]
        : [`registers ${inspection.where}${again}`, 'a task of your own, needing no administrator rights'];
  return [
    ...what,
    `it runs ${context.launcher} update --background, pinned to this installation's folders`,
    'it installs only a release whose provenance verifies, and never sends, posts or approves anything',
    `it runs ${scheduleOf(platform)}`,
    ...(platform === 'darwin'
      ? [
          'macOS shows “Background Items Added” once, and lists it in System Settings → General → Login Items, where it can be switched off',
        ]
      : []),
    'to remove it, run update --background-job off with this CLI, or call comms_update with backgroundJob "off"; choosing to update every 14 days or never removes it too',
  ];
}
