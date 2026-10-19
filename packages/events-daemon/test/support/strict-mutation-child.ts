import { spawn } from 'node:child_process';

export const STRICT_MUTATION_CHILD_TIMEOUT_MS = 15_000;

export interface StrictMutationChildResult {
  readonly code: number | null;
  readonly output: string;
}

/**
 * On POSIX each oracle leads a process group of its own, so the runner can end every process the oracle started: the
 * test runner's per-file process, a Laya worker, a stand-in, Vitest's forks, a cargo build. Killing only the direct
 * child left a timed-out oracle's test process and its worker reparented to init, running in a mutant folder the
 * runner had already deleted. Windows has no process groups to signal; it keeps the direct child's kill, and the
 * Laya mutation runner does not run there (B1-G).
 */
const OWN_PROCESS_GROUP = process.platform !== 'win32';

/** The process groups of oracles still running, ended too if the runner itself exits or is told to stop. */
const liveGroups = new Set<number>();
let runnerExitHooked = false;

function endProcessGroup(leader: number): void {
  try {
    process.kill(-leader, 'SIGKILL');
  } catch {
    // ESRCH: every process of that oracle has already gone.
  }
}

function endLiveGroups(): void {
  for (const leader of liveGroups) endProcessGroup(leader);
  liveGroups.clear();
}

/**
 * An oracle in its own group no longer hears the terminal's Ctrl-C, so the runner ends the live groups as it goes.
 * A signal is passed on afterwards only when nothing else listens for it, which is when Node would have ended anyway.
 */
function hookRunnerExit(): void {
  if (runnerExitHooked) return;
  runnerExitHooked = true;
  process.once('exit', endLiveGroups);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      endLiveGroups();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

/**
 * Runs one isolated mutation oracle with a hard wall-clock bound. A timeout is a runner failure, never mutant evidence.
 * When the oracle ends, or its bound does, every process it started ends with it: nothing outlives its mutant folder.
 */
export async function runStrictMutationChild(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number | undefined;
}): Promise<StrictMutationChildResult> {
  const timeoutMs = input.timeoutMs ?? STRICT_MUTATION_CHILD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('strict mutation child timeout must be a positive safe integer');
  if (OWN_PROCESS_GROUP) hookRunnerExit();
  return new Promise<StrictMutationChildResult>((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: OWN_PROCESS_GROUP,
    });
    const leader = child.pid;
    if (OWN_PROCESS_GROUP && leader !== undefined) liveGroups.add(leader);
    /** The whole oracle: its group on POSIX; a failed spawn has no PID, and nothing to end. */
    const endOracle = (): void => {
      if (leader === undefined) return;
      if (OWN_PROCESS_GROUP) {
        liveGroups.delete(leader);
        endProcessGroup(leader);
      } else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    let output = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      endOracle();
    }, timeoutMs);
    const finish = (work: () => void): void => {
      clearTimeout(timeout);
      endOracle();
      work();
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    // The oracle's own process has ended: whatever it left behind ends now, which also closes any pipe a leftover
    // descendant still held, so `close` follows at once rather than at the bound.
    child.once('exit', () => {
      if (OWN_PROCESS_GROUP) endOracle();
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) =>
      finish(() => {
        if (timedOut) {
          reject(new Error(`strict mutation child timed out after ${timeoutMs}ms; it was killed by the runner`));
          return;
        }
        resolve({ code, output });
      }),
    );
  });
}
