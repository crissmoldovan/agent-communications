import type { Readable, Writable } from 'node:stream';
import { CommsError, type Streams } from '@agentcomms/core';
import { isCancel, isTTY, select, text } from '@clack/prompts';
import { askFor } from './prompt.ts';

/**
 * The richer prompts, and the one decision about when not to use them.
 *
 * Three things drive this CLI and only one of them has eyes: a person at a terminal, an agent running commands,
 * and a script in CI. A radio list redrawing itself with cursor keys is the clearest thing for the first and
 * unreadable noise to the other two — so the same call has to be able to render as a list, as a plain question, or
 * as nothing at all.
 *
 * Everything here writes to **stderr**, never stdout. `--json` puts one document on stdout and a prompt drawn into
 * the middle of it would make that unparseable — the whole point of the JSON surface is that something else can
 * read it.
 */

export type Interaction =
  /** A person at a terminal: cursor keys, placeholders, a redrawing list. */
  | 'tui'
  /** A terminal that cannot redraw, or a person who asked for plain: one question, one line. */
  | 'plain'
  /** Nobody is there. Every answer must come from a flag, or the command reports what it still needs. */
  | 'none';

export interface InteractionInput {
  streams: Streams;
  env: NodeJS.ProcessEnv;
  json: boolean;
  noInput: boolean;
  /** `--no-tui`, for someone who wants the plain prompts on a terminal that could manage the other kind. */
  noTui: boolean;
  canPrompt: boolean;
}

/**
 * Which of the three this run is.
 *
 * `--json` is `none` whatever the terminal says: a caller asking for a document is not going to answer a question,
 * and a prompt on the way would corrupt the document anyway. CI is `plain` rather than `none` because a CI job may
 * still be feeding stdin, but it cannot render a list into a log nobody is watching.
 */
export function interactionFor(input: InteractionInput): Interaction {
  if (input.json || input.noInput || !input.canPrompt) return 'none';
  if (input.noTui) return 'plain';
  const env = input.env;
  const inCI = Boolean(env.CI || env.CONTINUOUS_INTEGRATION || env.BUILD_NUMBER || env.GITHUB_ACTIONS);
  if (inCI) return 'plain';
  // Both ends matter: the list is drawn on stderr and steered from stdin, and either one being a pipe makes it
  // unusable in a different way — an undrawable list, or one nobody can move the cursor in.
  const stdinIsTty = Boolean((input.streams.stdin as { isTTY?: boolean }).isTTY);
  return stdinIsTty && isTTY(input.streams.stderr as unknown as Writable) ? 'tui' : 'plain';
}

/** Cancelling is a decision, not a crash: Ctrl-C leaves the setup where it was, and it can be resumed. */
function cancelled(): never {
  throw new CommsError('USAGE', 'setup was cancelled; nothing was changed', {
    hint: 'Run `agent-gmail setup` again to pick up where you left off.',
  });
}

export interface AskOptions {
  message: string;
  /** Shown in the field while it is empty. Only the rich prompt can render it; the plain one appends it. */
  placeholder?: string | undefined;
  /** Used when the answer is empty. */
  defaultValue?: string | undefined;
}

/** One free-text answer. */
export async function askText(mode: Interaction, streams: Streams, options: AskOptions): Promise<string> {
  if (mode === 'tui') {
    const answer = await text({
      message: options.message,
      output: streams.stderr as unknown as Writable,
      input: streams.stdin as unknown as Readable,
      ...(options.placeholder ? { placeholder: options.placeholder } : {}),
      ...(options.defaultValue ? { defaultValue: options.defaultValue } : {}),
    });
    if (isCancel(answer)) cancelled();
    return String(answer ?? options.defaultValue ?? '').trim();
  }
  // The placeholder becomes part of the question, because there is no field to put it in.
  const hint = options.defaultValue
    ? ` [${options.defaultValue}]`
    : options.placeholder
      ? ` (e.g. ${options.placeholder})`
      : '';
  const typed = (await askFor(streams, { question: `${options.message}${hint}: ` })).trim();
  return typed || options.defaultValue || '';
}

export interface Choice<T> {
  value: T;
  label: string;
  /** The second line: what makes this one different from the others. */
  hint?: string | undefined;
}

/**
 * One choice from a list.
 *
 * The plain rendering is numbered rather than typed, for the same reason the rich one is a list: the things being
 * chosen between here are file paths like `client_secret_760917502475-7asd913….apps.googleusercontent.com.json`,
 * and asking somebody to retype one of those is asking them to make a mistake.
 */
export async function askChoice<T extends string>(
  mode: Interaction,
  streams: Streams,
  options: { message: string; choices: Choice<T>[]; initial?: T | undefined },
): Promise<T> {
  if (options.choices.length === 0) throw new CommsError('USAGE', 'nothing to choose from');

  if (mode === 'tui') {
    const answer = await select({
      message: options.message,
      output: streams.stderr as unknown as Writable,
      input: streams.stdin as unknown as Readable,
      // Cast because clack's `Option<Value>` is a conditional type (`Value extends Primitive ? … : …`) and
      // TypeScript cannot resolve it through an unresolved generic. The shape is exactly what it asks for.
      options: options.choices.map((choice) =>
        choice.hint
          ? { value: choice.value, label: choice.label, hint: choice.hint }
          : { value: choice.value, label: choice.label },
      ) as Parameters<typeof select<T>>[0]['options'],
      ...(options.initial ? { initialValue: options.initial } : {}),
    });
    if (isCancel(answer)) cancelled();
    return answer as T;
  }

  const initialIndex = options.initial
    ? options.choices.findIndex((choice) => choice.value === options.initial) + 1
    : 1;
  streams.stderr.write(`${options.message}\n`);
  for (const [index, choice] of options.choices.entries()) {
    streams.stderr.write(`  ${index + 1}) ${choice.label}${choice.hint ? `\n     ${choice.hint}` : ''}\n`);
  }
  for (;;) {
    const typed = (await askFor(streams, { question: `  which one? [${initialIndex}] ` })).trim();
    const picked = typed === '' ? initialIndex : Number(typed);
    if (Number.isInteger(picked) && picked >= 1 && picked <= options.choices.length) {
      return options.choices[picked - 1]?.value as T;
    }
    streams.stderr.write(`  Type a number between 1 and ${options.choices.length}.\n`);
  }
}

/** A yes or no. `defaultYes` is what an empty answer means, and is stated in the prompt. */
export async function askYesNo(
  mode: Interaction,
  streams: Streams,
  options: { message: string; defaultYes?: boolean },
): Promise<boolean> {
  const defaultYes = options.defaultYes !== false;
  if (mode === 'tui') {
    const answer = await select({
      message: options.message,
      output: streams.stderr as unknown as Writable,
      input: streams.stdin as unknown as Readable,
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
      initialValue: defaultYes ? 'yes' : 'no',
    });
    if (isCancel(answer)) cancelled();
    return answer === 'yes';
  }
  const typed = (await askFor(streams, { question: `${options.message} [${defaultYes ? 'Y/n' : 'y/N'}] ` })).trim();
  if (typed === '') return defaultYes;
  return /^y/i.test(typed);
}
