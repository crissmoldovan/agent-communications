import { spawn, spawnSync } from 'node:child_process';

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

/** The process groups of oracles still running: a runner that is about to end can end them too. */
const liveGroups = new Set<number>();

/**
 * The shell command that ends an oracle's whole process group: a negative id names the group. `-s KILL` names the
 * signal as every POSIX shell's `kill` reads it; dash, Ubuntu's `/bin/sh`, reads `kill -KILL -- -<group>` as a signal
 * and then `--` as a pid ("Illegal number: -") and signals nothing.
 */
export const ORACLE_GROUP_KILL = 'kill -s KILL -- "-$ORACLE_GROUP"';

/**
 * This module is one of phase E's adversarial helpers, whose scanner admits no `process` member beyond `execPath` and
 * `platform` and no computed string, so the group is signalled by the shell's own `kill`, its id handed over in the
 * environment. A group that has already gone makes it fail, which is the same outcome.
 */
function endProcessGroup(leader: number): void {
  // Node writes each environment value as text itself; the cast only says so to the type checker.
  const env = { ORACLE_GROUP: leader } as unknown as NodeJS.ProcessEnv;
  spawnSync('/bin/sh', ['-c', ORACLE_GROUP_KILL], { env, stdio: 'ignore' });
}

/** Ends every oracle still running; a runner calls it as it ends (`mutation-runner-exit.ts`). */
export function endLiveOracleGroups(): void {
  for (const leader of liveGroups) endProcessGroup(leader);
  liveGroups.clear();
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
  return new Promise<StrictMutationChildResult>((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: OWN_PROCESS_GROUP,
    });
    const leader = child.pid;
    if (OWN_PROCESS_GROUP && leader !== undefined) liveGroups.add(leader);
    /**
     * The whole oracle: its group on POSIX, and its own process in any case, so even a group that cannot be signalled
     * leaves no hung leader behind. A failed spawn has no PID, and nothing to end.
     */
    const endOracle = (): void => {
      if (leader === undefined) return;
      if (OWN_PROCESS_GROUP) {
        liveGroups.delete(leader);
        endProcessGroup(leader);
      }
      // A process that has already exited ignores this; one whose spawn failed returned above, PID-less.
      child.kill('SIGKILL');
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
