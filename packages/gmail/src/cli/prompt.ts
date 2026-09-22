import { createInterface } from 'node:readline/promises';
import type { Streams } from '@agentcomms/core';

/**
 * Asks one question at the terminal and returns what was typed.
 *
 * Separate from `askChallenge` because the send approval shows the preview first and compares the answer against a
 * hash held in the approval record, not against a challenge this process invented: the code the person types was
 * issued by the store and is checked there, in constant time, with a limited number of attempts.
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
