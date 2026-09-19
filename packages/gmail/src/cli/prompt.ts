import { createInterface } from 'node:readline/promises';
import { CommsError, challengeMatches, hashChallenge, newChallenge, paint, type Streams } from '@cloudpixel/comms-core';

export interface ChallengeOptions {
  /** One line saying what is about to change. */
  prompt: string;
  color: boolean;
  /** Attempts before giving up. */
  attempts?: number;
}

/**
 * Asks a person at the terminal to type a short code back. It exists to make a change deliberate: an agent that can
 * run commands can also type an answer, so this is a speed bump against an accidental or hasty change, never a
 * security boundary — the real boundary is that agents are refused outright (see the agent-marker check).
 */
export async function askChallenge(streams: Streams, options: ChallengeOptions): Promise<void> {
  const challenge = newChallenge();
  // Only the hash is compared, in constant time, exactly as an approval challenge is.
  const expected = hashChallenge(challenge);
  const attempts = options.attempts ?? 3;
  const rl = createInterface({
    input: streams.stdin as NodeJS.ReadableStream,
    output: streams.stderr as NodeJS.WritableStream,
  });
  try {
    streams.stderr.write(`${options.prompt}\n`);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const answer = await rl.question(
        `Type ${paint(options.color, 'bold', challenge)} to confirm (or press Enter to cancel): `,
      );
      if (answer.trim() === '') break;
      if (challengeMatches(answer, expected)) return;
      streams.stderr.write(`That did not match${attempt < attempts ? ', try again' : ''}.\n`);
    }
  } finally {
    rl.close();
  }
  throw new CommsError('LOOSENING_REFUSED', 'the change was not confirmed, so nothing was changed');
}

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
