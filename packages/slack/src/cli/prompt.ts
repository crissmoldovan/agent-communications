import { createInterface } from 'node:readline/promises';
import type { Streams } from '@agentcomms/core';

/**
 * Asks one question at the terminal and returns what was typed.
 *
 * A copy of the Gmail package's, deliberately rather than shared: it is nine lines, and moving it to core would
 * put a readline interface in a package that has no terminal of its own. The approval code itself is *not*
 * invented here — it is issued by the approval store and checked there, in constant time, with a limited number
 * of attempts.
 */
export async function askFor(streams: Streams, options: { question: string }): Promise<string> {
  const rl = createInterface({
    input: streams.stdin as NodeJS.ReadableStream,
    output: streams.stderr as NodeJS.WritableStream,
  });
  try {
    return await rl.question(options.question);
  } finally {
    rl.close();
  }
}
