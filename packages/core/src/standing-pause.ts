import { randomInt } from 'node:crypto';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { CommsError } from './errors.ts';

/**
 * The pause between deciding a standing act and making it (design 2026-10-19-standing-approvals, S9, the lead's call
 * after review). An agent under injected instructions can still choose which arrived messages to acknowledge and when;
 * the moment an acknowledgement appears is one of the few things it controls, so the gate takes that moment away: the
 * act goes 5 to 30 seconds after the count is spent, a whole number of milliseconds drawn from the operating system's
 * cryptographic source, which nothing the agent reads can predict. The act's own time is recorded beside the decision's.
 */

/** The shortest and the longest pause, in milliseconds, both included. */
export const STANDING_PAUSE_MS: Readonly<{ min: number; max: number }> = Object.freeze({ min: 5_000, max: 30_000 });

/** Waits the pause, and says how long it was, in milliseconds. */
export type StandingPause = () => Promise<number>;

export interface StandingPauseOptions {
  /** A whole number from `min` to `max`, both included: the operating system's CSPRNG unless a test injects one. */
  readonly random?: ((min: number, max: number) => number) | undefined;
  /** Waits `ms`: the real timer unless a test injects one. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** `node:crypto`'s `randomInt`, whose upper bound is exclusive: from `min` to `max`, both included. */
function cryptoRandom(min: number, max: number): number {
  return randomInt(min, max + 1);
}

/**
 * The pause, drawn fresh each time: from `STANDING_PAUSE_MS.min` to `STANDING_PAUSE_MS.max`. A value the source gives
 * outside that range, or that is no whole number, is a programming error, refused rather than slept: a pause of 0 would
 * give the moment back.
 */
export function standingPause(options: StandingPauseOptions = {}): StandingPause {
  const random = options.random ?? cryptoRandom;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms).then(() => undefined));
  return async () => {
    const { min, max } = STANDING_PAUSE_MS;
    const ms = random(min, max);
    if (!Number.isSafeInteger(ms) || ms < min || ms > max) {
      throw new CommsError(
        'UNEXPECTED',
        `a standing act's pause is a whole number of milliseconds from ${min} to ${max}`,
        {
          hint: 'This is a bug — please report it.',
        },
      );
    }
    await sleep(ms);
    return ms;
  };
}
