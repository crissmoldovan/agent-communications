import { spawn } from 'node:child_process';

export const STRICT_MUTATION_CHILD_TIMEOUT_MS = 15_000;

export interface StrictMutationChildResult {
  readonly code: number | null;
  readonly output: string;
}

/** Runs one isolated mutation oracle with a hard wall-clock bound. A timeout is a runner failure, never mutant evidence. */
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
    });
    let output = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (work: () => void): void => {
      clearTimeout(timeout);
      work();
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
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
