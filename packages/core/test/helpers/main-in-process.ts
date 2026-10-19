import { main } from '../../src/cli.ts';

/** What `main` takes after its words, environment and platform: the stand-ins a test hands in. */
export type MainDeps = NonNullable<Parameters<typeof main>[3]>;

export interface MainRun {
  code: number;
  stdout: string;
  stderr: string;
  /** The first line of stdout, as JSON: the one envelope `--json` promises. */
  json: () => Record<string, unknown>;
}

/**
 * Core's command run in this process — so a test can hand it stand-ins for the registry and the job's runner — with
 * what it writes on stdout and stderr. What the command writes is text; the test runner's own reports, on the same
 * streams, are bytes, and go on through.
 */
export async function runMain(
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  deps: MainDeps = {},
): Promise<MainRun> {
  let stdout = '';
  let stderr = '';
  const write = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string') {
      return (write.out as (...given: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    }
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string') {
      return (write.err as (...given: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
    }
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await main(args, env, platform, deps);
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
  return { code, stdout, stderr, json: () => JSON.parse(stdout.trim().split('\n')[0] ?? '') };
}
