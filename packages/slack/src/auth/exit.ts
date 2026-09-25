import { settleRefreshes } from './refresh.ts';

/**
 * Leaving a process without losing a renewed token, for the CLI and the MCP server alike.
 *
 * Slack's refresh token is spent the moment Slack answers, so for a while the only copy of a workspace's credential
 * can be in this process's memory: between the reply and the write, or for longer when the store would not take
 * it. Both ways of leaving have to account for that — a signal, and an ordinary exit — and both surfaces leave the
 * same way, because the same refresh runs inside either.
 */

/** The two signals a process is asked to leave by: a client's SIGTERM, and a person's Ctrl-C. */
export type ExitSignal = 'SIGTERM' | 'SIGINT';

/**
 * What `exitAfterRefreshes` needs from the process, so a test can send the signal — and see it sent again — without
 * being killed by it.
 */
export interface SignalHost {
  readonly pid: number;
  once(signal: ExitSignal, listener: () => void): unknown;
  removeListener(signal: ExitSignal, listener: () => void): unknown;
  kill(pid: number, signal: ExitSignal): unknown;
}

/** Where the warnings go: stderr, which for an MCP server is the log its client keeps. */
export interface WarningSink {
  write(text: string): unknown;
}

/**
 * How long an exit waits for a refresh to settle: the thirty-second exchange, and most of a store retry.
 *
 * Bounded, because a client is entitled to its server going away and a person to their prompt back.
 */
const EXIT_WAIT_MS = 45_000;

/**
 * How long a process that re-raised its signal is given to die of it before it exits with the conventional status.
 *
 * On POSIX the re-raised signal ends the process before this starts to count. It is for a platform where re-raising
 * does not — Windows has no POSIX signals — so that a signal can never leave the process running.
 */
const REDELIVERY_GRACE_MS = 1_000;

/**
 * Settles every refresh this process has started, and says on `stderr` which workspace anything was left for.
 *
 * The last chance to write down a renewed token kept because the store failed. A CLI command ends and nothing calls
 * again; an MCP client closes stdin without sending a signal. Either way, a token that cannot be written now is gone,
 * and the person is told so — by name, never by value — rather than finding out from the next command.
 */
export async function settleBeforeExit(stderr: WarningSink, waitMs: number = EXIT_WAIT_MS): Promise<void> {
  for (const unsettled of await settleRefreshes(waitMs)) stderr.write(`${unsettled.message}\n`);
}

/**
 * On SIGTERM or SIGINT, let any token refresh in flight finish before exiting — for up to `waitMs`.
 *
 * A client that wants its server gone closes stdin and, if the server has not left promptly, sends SIGTERM; a person
 * presses Ctrl-C on a command. Node's default for either is to die on the spot, and if the spot is between Slack's
 * reply to a refresh and the write that records it, the workspace's only renewed token dies with the process: Slack
 * has already retired the old one, and the marker left behind becomes `refresh-uncertain`, which means a
 * re-authorisation. The window is one round trip and one keychain write, and a busy server hits it eventually.
 *
 * Each signal is taken once, so a second one — a person pressing Ctrl-C again — gets Node's default and ends the
 * process immediately. With nothing in flight the exit is as prompt as the default's. Returns a function that
 * removes the handlers.
 *
 * Once settled, the process dies **by the signal**, as it would have with no handler, rather than exiting with 130
 * or 143. The difference is what a parent sees, and bash acts on it: running a script, it takes a child that exits
 * normally after SIGINT as one that dealt with the interrupt, and goes on to the next line — so Ctrl-C on a loop of
 * `agent-slack` commands, or on a read followed by an approved `post send`, stopped one command and ran the next.
 * With nothing to settle that happens at once, so a command with no refresh to protect ends exactly as it would
 * have without the hold.
 */
export function exitAfterRefreshes(
  options: { host?: SignalHost; waitMs?: number; exit?: (code: number) => void; stderr?: WarningSink } = {},
): () => void {
  const host: SignalHost = options.host ?? process;
  const waitMs = options.waitMs ?? EXIT_WAIT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const stderr = options.stderr ?? process.stderr;
  const on = (signal: ExitSignal) => () => {
    void settleBeforeExit(stderr, waitMs).finally(() => {
      // With no listener left, the signal sent again meets Node's default, which is to die of it.
      release();
      setTimeout(() => exit(signal === 'SIGINT' ? 130 : 143), REDELIVERY_GRACE_MS);
      host.kill(host.pid, signal);
    });
  };
  const onTerm = on('SIGTERM');
  const onInt = on('SIGINT');
  const release = () => {
    host.removeListener('SIGTERM', onTerm);
    host.removeListener('SIGINT', onInt);
  };
  host.once('SIGTERM', onTerm);
  host.once('SIGINT', onInt);
  return release;
}
