import type { UpdateJobRunner } from '../../src/update-job.ts';

/** One program the background job's code asked to run. */
export interface RunnerCall {
  program: string;
  args: readonly string[];
}

/**
 * A runner for the background update job that runs nothing: it records each program it is handed and answers exit 0
 * with no output, so `launchctl`, `systemctl` and PowerShell are never started by a test.
 */
export function recordingRunner(): { calls: RunnerCall[]; run: UpdateJobRunner } {
  const calls: RunnerCall[] = [];
  const run: UpdateJobRunner = async (program, args) => {
    calls.push({ program, args: [...args] });
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}
