import type { CliCommandCaller, CliCommandNotLocated, PrintedCommand } from './cli-command.ts';
import { commandText, inlineCommand, lineWithWordsToFill } from './cli-runtime.ts';
import type { ExternalCommand } from './command-brands.ts';
import { inlineQuoted, quotedText, quotedWithWordsToFill } from './command-line.ts';
import type { RegisteredServer } from './mcp-clients.ts';
import type { PathName } from './paths.ts';

/**
 * A handoff as words a person reads, and what a core function that prints one is given (CUE-403; CONTRIBUTING.md,
 * "Telling a person what to run"). `handoffs.ts` makes located handoffs and re-exports all of this.
 *
 * Kept apart from the locator on purpose: the configuration store, the secret stores and the attachment jail print
 * handoffs too, and the locator's own imports reach the configuration store, so importing it from them would be a
 * cycle. Nothing here locates anything or imports a module that does: a located command is made by `handoffs.ts` and
 * handed in, and what is here only renders one. With none handed in, there is nothing to render: a package that did not
 * give core its caller and is asked for a command has a programming error, not a bare name to fall back on.
 */

/** A command for a person to run, located, or the sentence saying why there is none here. */
export type Handoff = PrintedCommand | CliCommandNotLocated;

export interface HandoffUse {
  /** The suite folders the command reads or writes; the four every command opens when left out. */
  readonly uses?: readonly PathName[] | undefined;
  /** It also reads or writes downloads, so the downloads folder is pinned too. */
  readonly downloads?: boolean | undefined;
}

/**
 * The commands a package tells a person to run, made once per printing process from its caller (`handoffs.ts`,
 * `cliHandoffs`): `openCore({ caller })` puts them on `core.handoffs`. Each method takes the CLI's own words, never the
 * program, and returns a `Handoff`.
 */
export interface CliHandoffs {
  /** The printing package: one of its own modules and its name. */
  readonly caller: CliCommandCaller;
  /** The shell the commands are quoted for. */
  readonly platform: NodeJS.Platform;
  /** The printing package's own CLI, with these words after the program. */
  own(words: readonly string[], use?: HandoffUse): Handoff;
  /** The core CLI: the printing package's own when that is core, the core it has installed otherwise. */
  core(words: readonly string[], use?: HandoffUse): Handoff;
  /** The CLI of `channel` — `core`, `gmail`, `slack` …: own, core, or another product found among its registrations. */
  of(channel: string, words: readonly string[], use?: HandoffUse): Handoff;
  /** The same commands, quoted for another shell. */
  on(platform: NodeJS.Platform): CliHandoffs;
  /**
   * The same, able to find another product: with the servers registered with this machine's MCP clients read now, from
   * the environment these were made with. Read once per call; nothing a registration names is run.
   */
  registered(): Promise<CliHandoffs>;
  /** The same, finding another product among these registrations: a scan the caller has already read. */
  withRegistrations(registrations: readonly RegisteredServer[]): CliHandoffs;
}

/**
 * The handoffs a store or a deep function was given (`core.handoffs`, handed on by `openCore`), for the command one of
 * its refusals names. A programming error when there are none: the package that opened core did not give it its
 * caller (`openCore({ caller })`), and there is no command to print in its place — not a bare name, not a guess.
 */
export function requiredHandoffs(handoffs: CliHandoffs | undefined): CliHandoffs {
  if (handoffs === undefined) {
    throw new TypeError('core was opened without its caller, so it cannot locate a command: pass openCore({ caller })');
  }
  return handoffs;
}

/** Whether a handoff is a command to run, rather than the sentence saying why there is none. */
export function isCommand(handoff: Handoff | ExternalCommand): handoff is PrintedCommand | ExternalCommand {
  return !('message' in handoff);
}

/**
 * A handoff as a value of its own — a list's line, a field's value: the command's line, or its words as JSON with what
 * to do when no line is safe in every Windows shell; or, with no command, the sentence saying why.
 */
export function handoffText(handoff: Handoff | ExternalCommand): string {
  return isCommand(handoff) ? commandText(handoff) : handoff.message;
}

/**
 * As `handoffText`, with words the agent fills in — a placeholder such as `<client_secret.json>`, printed as written —
 * before the command's first `--`. With no line, its words as JSON, these among them, saying it has to be typed; with
 * no command, why there is none here.
 */
export function handoffTextToFill(handoff: Handoff | ExternalCommand, toFill: readonly string[]): string {
  if (!isCommand(handoff)) return handoff.message;
  const line = lineWithWordsToFill(handoff, ...toFill);
  if (line === null) return quotedText(quotedWithWordsToFill(handoff, toFill));
  return handoff.shell === 'powershell' ? `PowerShell:\n${line}` : line;
}

/** The brand of a `Remedy`: only `remedy` makes one. */
declare const REMEDY: unique symbol;

/**
 * What fixes something, in words a person follows — a doctor's `fix`, a list of next steps: commands — this suite's,
 * located, or why there is none here; another program's — and words around them, one step a line. Made only by
 * `remedy`, so a field typed `Remedy` takes no plain string, template or argument fragment in place of a command. It is
 * text all the same, so it is written out, and read by an agent, exactly as it always was.
 */
export type Remedy = string & { readonly [REMEDY]: true };

/** Part of a remedy's line: a command, shown as a value of its own (`handoffText`), or words. */
export type RemedyPart = Handoff | ExternalCommand | string;

/**
 * A remedy, a line per argument: one part, or the parts of one line in order — `[remove, ', then add it again']`.
 * A command is shown as `handoffText` shows it: its line, its words as JSON with what to do when no Windows line is
 * safe, or why there is none here.
 */
export function remedy(...lines: readonly (RemedyPart | readonly RemedyPart[])[]): Remedy {
  const part = (each: RemedyPart): string => (typeof each === 'string' ? each : handoffText(each));
  return lines
    .map((line) => (Array.isArray(line) ? line.map(part).join('') : part(line as RemedyPart)))
    .join('\n') as Remedy;
}

export interface HandoffSentenceOptions {
  /**
   * Said before the reason when there is no command: another way to do it that needs no command — a tool to call from
   * a chat — as a sentence of its own. The command's sentence usually names it too.
   */
  readonly instead?: string | undefined;
}

/** The sentence saying why there is no command, after another way when there is one. */
function noCommand(handoff: CliCommandNotLocated, options: HandoffSentenceOptions): string {
  return options.instead === undefined ? handoff.message : `${options.instead} ${handoff.message}`;
}

/**
 * A sentence that gives the command, in backticks, made by `say`; or, with no command, the sentence saying why there is
 * none — after `instead`, when given — never `say` with something else in the command's place.
 */
export function handoffSentence(
  handoff: Handoff | ExternalCommand,
  say: (command: string) => string,
  options: HandoffSentenceOptions = {},
): string {
  return isCommand(handoff) ? say(inlineCommand(handoff)) : noCommand(handoff, options);
}

/**
 * As `handoffSentence`, for a command with words the agent is to fill in — a placeholder such as `<folder>`, printed as
 * written — before its first `--`. With no line to show them in, the command is shown as its words, placeholders among
 * them, saying it has to be typed.
 */
export function handoffSentenceToFill(
  handoff: Handoff | ExternalCommand,
  toFill: readonly string[],
  say: (command: string) => string,
  options: HandoffSentenceOptions = {},
): string {
  if (!isCommand(handoff)) return noCommand(handoff, options);
  const line = lineWithWordsToFill(handoff, ...toFill);
  if (line !== null) return say(`\`${line}\`${handoff.shell === 'powershell' ? ' (PowerShell)' : ''}`);
  return say(inlineQuoted(quotedWithWordsToFill(handoff, toFill)));
}

/**
 * Commands that each could do it — one per channel, say — as one phrase: the commands joined by "or", then, for each
 * that has none here, the sentence saying why. `none` is said when not one of them is a command.
 */
export function handoffChoices(
  handoffs: readonly Handoff[],
  none: string,
  options: { conjunction?: 'or' | 'and' } = {},
): string {
  const commands = handoffs
    .filter((handoff): handoff is PrintedCommand => isCommand(handoff))
    .map((handoff) => inlineCommand(handoff));
  const missing = handoffs.filter((handoff): handoff is CliCommandNotLocated => !isCommand(handoff));
  // The same reason for each is said once: five mailboxes on a product that is not registered are one reason.
  const reasons = [...new Set(missing.map((handoff) => handoff.message))].join(' ');
  if (commands.length === 0) return `${none} ${reasons}`.trim();
  const conjunction = options.conjunction ?? 'or';
  const joined =
    commands.length === 1
      ? (commands[0] as string)
      : `${commands.slice(0, -1).join(', ')} ${conjunction} ${commands.at(-1)}`;
  return reasons === '' ? joined : `${joined} (${reasons.replace(/\.$/, '')})`;
}
