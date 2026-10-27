/**
 * A workflow's runs in words (workflows design §11.2, §7, the approved prototype's WorkflowRun), pure: what a run's
 * state is called, whether it is still live, how many runs a workflow had this week and when its last one started, a
 * wait as a person reads it ("Waiting for acme-site · Claude Code, 1 ahead"), why Which project? chose a project, and a
 * subscriber's delivery of a raised event. Every word here is the app's own or a closed word the event service wrote;
 * a project's name is the person's own text. What a sender wrote never reaches these words: a run's records carry none.
 *
 * Nothing here reads a workflow's flow, so the list of runs and the cards load none of the designer's code.
 */
import type { ChipTone } from '../messages/story.ts';
import { outcomeWords } from './copy.ts';
import type { RunListEntryV1, RunSummaryV1, RunWaitingV1 } from './types.ts';

/** A run's state, as its chip says it (spec §7.1). */
export const RUN_STATE_WORDS = {
  held: 'Held by a limit',
  running: 'Running',
  waiting: 'Waiting',
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Ran out of time',
} as const satisfies Record<RunListEntryV1['state'], string>;

/** Each state's chip tone: one still going, one that ended well, one that ended otherwise. */
const RUN_TONES = {
  held: 'warn',
  running: 'accent',
  waiting: 'warn',
  done: 'ok',
  failed: 'warn',
  cancelled: 'neutral',
  expired: 'neutral',
} as const satisfies Record<RunListEntryV1['state'], ChipTone>;

export function runTone(state: RunListEntryV1['state']): ChipTone {
  return RUN_TONES[state];
}

/** Whether a run is still going: held, running or waiting. Its view is read again every 2 seconds while it is. */
export function isLive(state: RunListEntryV1['state']): boolean {
  return state === 'held' || state === 'running' || state === 'waiting';
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A workflow's runs this week, and when its newest one started: what its card says (spec §11.2). */
export function runFacts(
  runs: readonly RunListEntryV1[],
  ruleId: string,
  now: number,
): { thisWeek: number; last: number | null; capped: boolean } {
  const own = runs.filter((run) => run.ruleId === ruleId);
  const last = own.reduce<number | null>(
    (newest, run) => (newest === null || run.startedAt > newest ? run.startedAt : newest),
    null,
  );
  const thisWeek = own.filter((run) => run.startedAt >= now - WEEK_MS).length;
  // `runs list` gives the newest 200 of every workflow: past that, a count of this week may be short of the truth.
  const oldest = runs.reduce<number | null>(
    (least, run) => (least === null || run.startedAt < least ? run.startedAt : least),
    null,
  );
  const capped = runs.length >= RUNS_LISTED && oldest !== null && oldest >= now - WEEK_MS;
  return { thisWeek, last, capped };
}

/** How many runs `runs list` gives at most (plan I6). */
export const RUNS_LISTED = 200;

/** "3 runs this week", "1 run this week", "200 or more runs this week". */
export function thisWeekWords(count: number, capped: boolean): string {
  if (capped) return `${count} or more runs this week`;
  return count === 1 ? '1 run this week' : `${count} runs this week`;
}

/** A session's provider, as a person reads it. */
export function providerWords(provider: unknown): string | null {
  if (provider === 'claude') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  return null;
}

/** "acme-site · Claude Code": the project a run chose and the session's provider, each when the run says. */
export function sessionWords(project: string | null, provider: unknown): string {
  const said = [project, providerWords(provider)].filter((each): each is string => each !== null);
  return said.length === 0 ? 'a session' : said.join(' · ');
}

/**
 * What a run waits on, in a sentence (spec §11.2): "Waiting for acme-site · Claude Code, 1 ahead" for a session to be
 * free, "Waiting for acme-site · Claude Code to finish its turn", "Waiting until 14:00", or held by a limit. The
 * session is named by what the run chose: the project, and the provider.
 */
export function waitingWords(
  waiting: Pick<RunWaitingV1, 'kind' | 'ahead'>,
  session: { project: string | null; provider: unknown },
  options: { wakeAt?: number | null; time?: (at: number) => string } = {},
): string {
  const who = sessionWords(session.project, session.provider);
  switch (waiting.kind) {
    case 'session-idle':
      return waiting.ahead === null || waiting.ahead === 0
        ? `Waiting for ${who} to be free`
        : `Waiting for ${who}, ${waiting.ahead} ahead`;
    case 'turn-end':
      return `Waiting for ${who} to finish its turn`;
    case 'time':
      return options.wakeAt == null || options.time === undefined
        ? 'Waiting for a time'
        : `Waiting until ${options.time(options.wakeAt)}`;
    case 'limit':
      return options.wakeAt == null || options.time === undefined
        ? 'Held: one of its limits was reached'
        : `Held: one of its limits was reached. It goes on at ${options.time(options.wakeAt)}`;
  }
}

/** The line a run shows when the session it waits on needs the person in claude-stream. */
export const NEEDS_YOU_IN_CLAUDE_STREAM = 'Needs you in claude-stream';

/**
 * Why Which project? chose a project, in closed words (spec §8.3), never the message's: a hint the person gave, or a
 * judge's yes and its score. A reason the app does not know is said as no reason, never shown as it came.
 */
export function routeBecause(reason: unknown, project: string, score: unknown): { short: string; long: string } | null {
  switch (reason) {
    case 'hint:sender-domain':
      return { short: 'its sender’s domain', long: `its sender’s domain is one ${project} lists` };
    case 'hint:slack-conversation':
      return { short: 'its Slack conversation', long: `its Slack conversation is one ${project} lists` };
    case 'hint:person':
      return { short: 'its sender', long: `its sender is someone ${project} lists` };
    case 'judge': {
      const sure = typeof score === 'number' && Number.isFinite(score) ? ` at ${score.toFixed(2)}` : '';
      return { short: `the judge said yes${sure}`, long: `the judge said yes${sure} to ${project}’s profile` };
    }
    default:
      return null;
  }
}

/** A subscriber's delivery of one raised event, as its state says (spec §9.2). */
export function eventDeliveryWords(state: string): string {
  switch (state) {
    case 'delivered':
      return 'delivered';
    case 'queued':
    case 'disclosing':
      return 'on its way';
    case 'retryable':
      return 'will try again';
    case 'dead-lettered':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return 'not delivered yet';
  }
}

/**
 * A run's story in a few words, for a list (B6's `summary`): the project Which project? chose, the issue made, whether a
 * session was found or started, and how its turn ended. A project's name is the person's; the rest are closed words.
 * An event service before it sends none, and nothing is said.
 */
export function summaryWords(summary: RunSummaryV1 | undefined): string[] {
  if (summary === undefined) return [];
  return [
    summary.project,
    summary.issue,
    summary.session === 'started' ? 'a session started' : summary.session === 'found' ? 'a session found' : null,
    summary.turn === null ? null : `its turn: ${outcomeWords(summary.turn)}`,
  ].filter((word): word is string => word !== null);
}
