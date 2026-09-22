import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import { CommsError, EXIT_CODES, toCommsError } from './errors.ts';
import { challengeMatches, hashChallenge, newChallenge } from './ids.ts';
import { errorEnvelope, okEnvelope } from './output.ts';

/**
 * Output rules shared by every agent-communications CLI, so humans and agents get the same behaviour everywhere:
 * data on stdout, messages on stderr; `--json` prints the versioned envelope; colour only on a TTY and never with
 * NO_COLOR, TERM=dumb or --no-color; prompts only when stdin and stdout are both TTYs and nothing forbids them.
 */

export interface OutputOptions {
  json: boolean;
  color: boolean;
}

export interface Streams {
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}

export const defaultStreams: Streams = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };

export function colorEnabled(env: NodeJS.ProcessEnv, stream: { isTTY?: boolean }, flag?: boolean): boolean {
  if (flag === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY);
}

/** True when a human could answer a prompt: both ends are terminals, no --json/--no-input, not CI. */
export function canPrompt(
  env: NodeJS.ProcessEnv,
  streams: Streams,
  options: { json?: boolean; noInput?: boolean },
): boolean {
  if (options.json || options.noInput) return false;
  if (env.CI && env.CI !== '0' && env.CI !== 'false') return false;
  return Boolean(streams.stdin?.isTTY && streams.stdout.isTTY);
}

/** Environment variables well-known coding agents set. Used only as a speed bump, never as a security boundary. */
const AGENT_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CODEX_HOME',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'AGENT_COMMS_AGENT',
];

export function agentMarker(env: NodeJS.ProcessEnv): string | null {
  for (const name of AGENT_MARKERS) if (env[name] !== undefined && env[name] !== '') return name;
  return null;
}

export function paint(color: boolean, format: Parameters<typeof styleText>[0], text: string): string {
  return color ? styleText(format, text, { validateStream: false }) : text;
}

/** Writes a successful result: the envelope with --json, otherwise the human rendering. */
export function writeResult<T>(
  data: T,
  options: OutputOptions,
  human: (data: T) => string,
  streams: Streams = defaultStreams,
): void {
  if (options.json) {
    streams.stdout.write(`${JSON.stringify(okEnvelope(data))}\n`);
    return;
  }
  const text = human(data);
  if (text) streams.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Writes an error and returns the exit code to use. */
export function writeError(error: unknown, options: OutputOptions, streams: Streams = defaultStreams): number {
  const commsError: CommsError = toCommsError(error);
  if (options.json) {
    streams.stdout.write(`${JSON.stringify(errorEnvelope(commsError))}\n`);
  } else {
    streams.stderr.write(`${paint(options.color, 'red', 'error')}: ${commsError.message}\n`);
    if (commsError.hint) streams.stderr.write(`${paint(options.color, 'dim', 'hint')}: ${commsError.hint}\n`);
  }
  return commsError.exitCode;
}

/** Runs a command body and exits with the documented code. Unexpected errors keep only their message. */
export async function runCommand(
  options: OutputOptions,
  body: () => Promise<void>,
  streams: Streams = defaultStreams,
): Promise<number> {
  try {
    await body();
    return EXIT_CODES.OK;
  } catch (error) {
    return writeError(error, options, streams);
  }
}

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
 *
 * Here rather than in one package because two need it now, and a second copy of a consent prompt is a second set
 * of wording, a second attempt count, and eventually two different ideas of what confirming something means.
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
