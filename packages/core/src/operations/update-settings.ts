import type { GatedChange } from '../change-flow.ts';
import { type Config, isUpdateLevel, UPDATE_LEVELS, type UpdateLevel, updateLevelOf } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { changeUpdateCheck, DEFAULT_PAUSE_DAYS, PAUSE_DAYS, pauseEnd, securityRelease } from '../update-state.ts';
import { VERSION } from '../version.ts';

/**
 * How this machine updates, from a terminal (`agentcomms update --level`, `--pause [days]`, `--resume`) or a chat
 * (`comms_update` with `level`, `pause` or `resume`) — design 2026-10-16, U2 and U3.
 *
 * The level is a setting in `config.json`, changed through the one flow every change goes through: a level that
 * updates less is a loosening `ConfigStore.update` refuses without the person's consent, and moving back applies at
 * once. The pause is a plain answer with no approval: nothing is stopped any more, so a pause clears nothing, and it
 * writes only the state file. Neither reads the registry: they are the reader's, so WhatsApp's command could offer
 * them with no network code.
 *
 * They replace 0.18's "not now" (`later`), which put off a stop until midnight with an approval of its own, and `auto
 * on|off`, which only switched the daily check.
 */

export interface UpdateLevelResult {
  /** The level this machine is set to now. */
  level: UpdateLevel;
  /** False when it already was, and nothing was written. */
  changed: boolean;
}

/** `level` as the setting, and 0.18's switch beside it, so a release before 0.20 sharing the file reads the same. */
function withLevel(config: Config, level: UpdateLevel): Config {
  return {
    ...config,
    defaults: { ...config.defaults, updates: level, updateCheck: level === 'never' ? 'off' : 'on' },
  };
}

const LEVEL_WORDS: Readonly<Record<UpdateLevel, string>> = {
  auto: 'check daily, and install in the background once that is set up',
  'every-14-days': 'check at most once every 14 days, and install only with your yes',
  never: 'never check: update only by hand',
};

/** The machine's level: a level that updates less is a loosening, approved first; one that updates more is at once. */
export function updateLevelChange(core: Core, level: string): GatedChange<UpdateLevelResult> {
  if (!isUpdateLevel(level)) {
    throw new CommsError('USAGE', `"${String(level).slice(0, 40)}" is not a level; use ${UPDATE_LEVELS.join(', ')}`, {
      hint: `auto checks daily; every-14-days at most once every 14 days; never asks npm nothing.`,
    });
  }
  return {
    plan: (config: Config) => {
      const same =
        config.defaults.updates === level &&
        config.defaults.updateCheck === withLevel(config, level).defaults.updateCheck;
      return {
        before: config,
        after: same ? config : withLevel(config, level),
        summary: `Update this machine: ${level} — ${LEVEL_WORDS[level]}`,
      };
    },
    apply: async (consent, request) => {
      if (request.after === request.before) return { level: updateLevelOf(request.before), changed: false };
      await core.config.update((config) => withLevel(config, level), consent ? { consent } : {});
      return { level, changed: true };
    },
  };
}

export interface UpdatePauseResult {
  /** How long it was asked for. */
  days: number;
  /** When it ends: at most 14 days from now. */
  pausedUntil: string;
  /** A security fix waiting now, which a pause never holds; null when there is none. */
  security: string | null;
}

/**
 * Holds notices — and, once Track D's background run exists, background installs — for the whole machine, for 1, 7
 * or 14 days: 7 when no length is given. A new pause replaces the one before. A security fix is never held.
 */
export async function updatePause(
  core: Core,
  options: { days?: number | undefined; now?: (() => Date) | undefined } = {},
): Promise<UpdatePauseResult> {
  const days = options.days ?? DEFAULT_PAUSE_DAYS;
  if (!PAUSE_DAYS.includes(days)) {
    throw new CommsError(
      'USAGE',
      `a pause is ${PAUSE_DAYS.join(', ').replace(/, (\d+)$/, ' or $1')} days, not ${String(days)}`,
      {
        hint: `Pause for 1, 7 or 14 days; 7 when no length is given.`,
      },
    );
  }
  const now = (options.now ?? (() => new Date()))();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  const { record } = await changeUpdateCheck(core.paths.stateDir, (current) => ({
    record: { ...current, pausedAt: now.toISOString(), pausedUntil: until, snoozedUntil: until },
  }));
  return { days, pausedUntil: until, security: securityRelease(record, VERSION) };
}

export interface UpdateResumeResult {
  /** False when no pause held, and nothing was changed. */
  resumed: boolean;
}

/** Ends a pause at once. */
export async function updateResume(
  core: Core,
  options: { now?: (() => Date) | undefined } = {},
): Promise<UpdateResumeResult> {
  const now = (options.now ?? (() => new Date()))();
  const { result } = await changeUpdateCheck<boolean>(core.paths.stateDir, (current) => {
    if (current.pausedAt === null && current.pausedUntil === null) return null;
    const held = pauseEnd(current, now) !== null;
    // The mirror an earlier release reads goes with it, when it was the pause's.
    const snoozedUntil = current.snoozedUntil === current.pausedUntil ? null : current.snoozedUntil;
    return { record: { ...current, pausedAt: null, pausedUntil: null, snoozedUntil }, result: held };
  });
  return { resumed: result === true };
}
