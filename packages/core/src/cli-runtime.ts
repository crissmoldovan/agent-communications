import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import type { CliCommandNotLocated, PrintedCommand } from './cli-command.ts';
import type { ExternalCommand } from './command-brands.ts';
import { inlineQuoted, quotedLineWithWordsToFill, quotedText } from './command-line.ts';
import { CommsError, EXIT_CODES, toCommsError } from './errors.ts';
import { challengeMatches, hashChallenge, newChallenge } from './ids.ts';
import { errorEnvelope, okEnvelope } from './output.ts';
import { PATH_OPTIONS, type PathOptionName, type PathOverrides } from './paths.ts';

/**
 * Output rules shared by every agent-communications CLI, so humans and agents get the same behaviour everywhere:
 * data on stdout, messages on stderr; `--json` prints the versioned envelope; colour only on a TTY and never with
 * NO_COLOR, TERM=dumb or --no-color; prompts only when stdin and stdout are both TTYs and nothing forbids them.
 */

export interface OutputOptions {
  json: boolean;
  color: boolean;
  /** The shell syntax used for commands returned alongside this output. */
  platform?: NodeJS.Platform | undefined;
}

export interface Streams {
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}

export const defaultStreams: Streams = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };

/** Converts the shared parser's five global option values into independently applied core path pins. */
export function pathOverridesFromCliOptions(
  values: Partial<Record<PathOptionName, string | undefined>>,
): PathOverrides {
  const overrides: PathOverrides = {};
  for (const { key, option, flag } of PATH_OPTIONS) {
    const value = values[option];
    if (value === undefined) continue;
    if (value.length === 0) throw new CommsError('USAGE', `${flag} needs a non-empty directory`);
    overrides[key] = value;
  }
  return overrides;
}

/** Inserts generated option words immediately before the first end-of-options sentinel. */
export function insertWordsBeforeSentinel(words: readonly string[], ...inserted: readonly string[]): string[] {
  const sentinel = words.indexOf('--');
  const at = sentinel < 0 ? words.length : sentinel;
  return [...words.slice(0, at), ...inserted, ...words.slice(at)];
}

/**
 * Removes the named options only where the CLI parser can see them: before the first `--`. Both `--x value` and
 * `--x=value` are removed. The sentinel and every positional word after it are byte-for-byte data.
 */
export function withoutOptionsBeforeSentinel(words: readonly string[], flags: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '--') {
      kept.push(...words.slice(index));
      break;
    }
    const spaced = flags.find((flag) => word === flag);
    if (spaced !== undefined) {
      const value = words[index + 1];
      if (value === undefined || value === '--') {
        throw new CommsError('USAGE', `${spaced} needs a value before --`);
      }
      index += 1;
      continue;
    }
    if (flags.some((flag) => word.startsWith(`${flag}=`))) continue;
    kept.push(word);
  }
  return kept;
}

/**
 * Replaces every pre-sentinel suite path option with one canonical pin per supplied directory. `insertAt` counts
 * words after the old pins are removed: zero puts global options after the executable held elsewhere, one puts them
 * after an entry/package word. Downloads are included only when the caller supplies that pin.
 */
export function normalizePathOptionWords(words: readonly string[], pins: PathOverrides, insertAt: number): string[] {
  const stripped = withoutOptionsBeforeSentinel(
    words,
    PATH_OPTIONS.map(({ flag }) => flag),
  );
  const sentinel = stripped.indexOf('--');
  const optionsEnd = sentinel < 0 ? stripped.length : sentinel;
  if (!Number.isSafeInteger(insertAt) || insertAt < 0 || insertAt > optionsEnd) {
    throw new TypeError(`path-option insertion point ${insertAt} is outside the option words`);
  }
  const pathWords = PATH_OPTIONS.flatMap(({ key, flag }) => {
    const value = pins[key];
    if (value === undefined) return [];
    if (value.length === 0) throw new CommsError('USAGE', `${flag} needs a non-empty directory`);
    // `resolve` removes redundant separators and a non-root trailing separator while retaining filesystem roots.
    return [flag, resolve(value)];
  });
  return [...stripped.slice(0, insertAt), ...pathWords, ...stripped.slice(insertAt)];
}

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

/** The coding agent each marker says this shell is inside, as a person names it. */
const MARKED_BY: Readonly<Record<(typeof AGENT_MARKERS)[number], string>> = Object.freeze({
  CLAUDECODE: 'Claude Code',
  CLAUDE_CODE_ENTRYPOINT: 'Claude Code',
  CODEX_SANDBOX: 'Codex',
  CODEX_HOME: 'Codex',
  CURSOR_AGENT: 'Cursor',
  GEMINI_CLI: 'Gemini CLI',
  AGENT_COMMS_AGENT: 'an agent’s session',
});

/**
 * What a refusal an agent's marker caused tells a person who set that variable themselves (the re-review of 0.35.0,
 * LOW 3): which variable it is, and how to clear it at their own terminal — `CODEX_HOME` is a setting people export,
 * and it marks a shell as Codex's. The marker stays: dropped, it would let a Codex session pass as the person. Null for
 * what is no variable a person sets: the MCP surface, an MCP server's process.
 */
export function agentMarkerHint(marker: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof marker !== 'string' || !Object.hasOwn(MARKED_BY, marker)) return null;
  const agent = MARKED_BY[marker as keyof typeof MARKED_BY];
  const clear = platform === 'win32' ? `Remove-Item Env:${marker}` : `unset ${marker}`;
  return `\`${marker}\` is set in this shell; if you’re not inside ${agent}, \`${clear}\` and run it again.`;
}

/**
 * `error` with its hint saying how to clear the agent's marker that caused it (`agentMarkerHint`), where its details
 * name one — every person-only refusal does, `NO_SESSION` and `NOT_OWN_CONNECTION` among them — and as it was
 * otherwise. Said where a refusal reaches the person, so every command's refusal says it, as text and in JSON.
 */
export function withMarkerHint(error: CommsError, platform: NodeJS.Platform = process.platform): CommsError {
  const said = agentMarkerHint(error.details?.marker, platform);
  if (said === null || error.hint?.includes(said) === true) return error;
  return new CommsError(error.code, error.message, {
    hint: error.hint === undefined || error.hint === '' ? said : `${error.hint} ${said}`,
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error.cause ?? error,
  });
}

export function paint(color: boolean, format: Parameters<typeof styleText>[0], text: string): string {
  return color ? styleText(format, text, { validateStream: false }) : text;
}

/*
 * A command for a person to run is one of two kinds, and only these render: one of this suite's own CLIs, made by the
 * locator (`locateCliCommand`, a `PrintedCommand`), and any other program, made by `externalCommand` (an
 * `ExternalCommand`). Each quotes its words for its shell when it is made (`command-line.ts`); these show it.
 */

/** A command in backticks, for a sentence — as its words in JSON, saying it has to be typed, when it has no line. */
export function inlineCommand(command: PrintedCommand | ExternalCommand): string {
  return inlineQuoted(command);
}

/** A command as text of its own — a list's line, a field's value — or its words in JSON, saying it has to be typed. */
export function commandText(command: PrintedCommand | ExternalCommand): string {
  return quotedText(command);
}

/**
 * A command's line with words the agent is to fill in — a placeholder such as `<folder>`, printed as written, never
 * quoted as a word — before the command's first `--`, where the CLI still reads them as options. Null when the
 * command has no line.
 */
export function lineWithWordsToFill(
  command: PrintedCommand | ExternalCommand,
  ...toFill: readonly string[]
): string | null {
  return quotedLineWithWordsToFill(command, ...toFill);
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
  const commsError: CommsError = withMarkerHint(toCommsError(error), options.platform);
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

/** What a loosening says when it has to be refused, and what it asks when it does not. */
export interface PersonGate {
  /** The refusal when an agent runs it, e.g. "only a person can decide which clients they trust". */
  refusedToAgent: string;
  /** The refusal when there is no terminal to ask at. */
  refusedWithoutTerminal: string;
  /** The command the person should run themselves, named in both refusals: located, or why there is none here. */
  command: PrintedCommand | CliCommandNotLocated;
  /**
   * What learns when the person has run `command` — an approval's wait (design 2026-10-05 §D7) — named to an agent
   * refused, so it need not ask the person to say so: located, or why there is none here. Left out where nothing waits.
   */
  wait?: PrintedCommand | CliCommandNotLocated | undefined;
  /** The one line said before the challenge. */
  prompt: string;
  color: boolean;
  json?: boolean | undefined;
  noInput?: boolean | undefined;
}

/**
 * The gate every loosening goes through: an agent is refused, anything without a terminal is refused, and a person
 * types the challenge back.
 *
 * One function because it was four copies — two in Gmail, one in Slack, one in the core CLI — each with the same
 * three steps and its own wording, and a security gate kept in four places is one that will eventually differ in
 * one of them. The callers keep their own messages and build their own consent; the order of the checks, the hint
 * wording and the challenge are here.
 */
export async function requirePerson(env: NodeJS.ProcessEnv, streams: Streams, gate: PersonGate): Promise<void> {
  refuseUnlessPerson(env, streams, gate);
  await askChallenge(streams, { prompt: gate.prompt, color: gate.color });
}

/**
 * The first two steps of `requirePerson` — an agent is refused, then anything without a terminal — for a command
 * whose code is not its own to make up.
 *
 * `agentcomms approve` asks for a code the approval store issued and will check, so it cannot use `askChallenge`;
 * but it refuses in exactly the same order and words, because it is the same gate.
 */
export function refuseUnlessPerson(env: NodeJS.ProcessEnv, streams: Streams, gate: Omit<PersonGate, 'prompt'>): void {
  const marker = agentMarker(env);
  if (marker) {
    const wait = gate.wait;
    throw new CommsError('LOOSENING_REFUSED', gate.refusedToAgent, {
      hint: gateSentence(gate.command, (command) =>
        wait === undefined
          ? `Ask the user to run ${command} in their own terminal.`
          : gateSentence(
              wait,
              (learn) => `Ask the user to run ${command} in their own terminal; learn when they have with ${learn}.`,
              `Ask the user to run ${command} in their own terminal.`,
            ),
      ),
      details: { marker },
    });
  }
  const prompting: { json?: boolean; noInput?: boolean } = {};
  if (gate.json !== undefined) prompting.json = gate.json;
  if (gate.noInput !== undefined) prompting.noInput = gate.noInput;
  if (!canPrompt(env, streams, prompting)) {
    throw new CommsError('LOOSENING_REFUSED', gate.refusedWithoutTerminal, {
      hint: gateSentence(gate.command, (command) => `Run ${command} directly in a terminal.`),
    });
  }
}

/**
 * A gate's command in a sentence: in backticks, or the sentence saying why there is none in its place — after
 * `instead`, when given.
 */
function gateSentence(command: PersonGate['command'], say: (command: string) => string, instead?: string): string {
  if (!('message' in command)) return say(inlineCommand(command));
  return instead === undefined ? command.message : `${instead} ${command.message}`;
}
