import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHANNEL_SNAPSHOT } from '../../src/channels.generated.ts';
import { inlineCommand } from '../../src/cli-runtime.ts';
import {
  type CliHandoffs,
  CORE_CALLER,
  cliHandoffs,
  type HandoffUse,
  handoffText,
  isCommand,
} from '../../src/handoffs.ts';
import type { ResolvedPaths } from '../../src/paths.ts';

/*
 * What core's own CLI and server print for a command, made the way they make it — for a test to compare output with.
 * Not a second way to make one: these call the same `cliHandoffs` from core's own caller, for the same folders and
 * shell. A test that cares what the command *is* — its program, its entry, its pins — asserts that on its words too.
 */

/** Core's own handoffs for these folders and this shell, as its CLI and server make them. */
export function coreHandoffs(
  paths: Readonly<ResolvedPaths>,
  platform: NodeJS.Platform = process.platform,
): CliHandoffs {
  return cliHandoffs({ caller: CORE_CALLER, paths, platform });
}

/** Core's own command with these words, as a value of its own: its line, or its words as JSON with what to do. */
export function coreCommand(
  paths: Readonly<ResolvedPaths>,
  words: readonly string[],
  platform: NodeJS.Platform = process.platform,
  use?: HandoffUse,
): string {
  return handoffText(coreHandoffs(paths, platform).own(words, use));
}

/** The same, in backticks, as a sentence gives it. */
export function coreInline(
  paths: Readonly<ResolvedPaths>,
  words: readonly string[],
  platform: NodeJS.Platform = process.platform,
  use?: HandoffUse,
): string {
  const handoff = coreHandoffs(paths, platform).own(words, use);
  assert.ok(isCommand(handoff), `core locates its own command here: ${'message' in handoff ? handoff.message : ''}`);
  return inlineCommand(handoff);
}

/** Every command of this suite, by name, in any case and with a Windows extension. */
const SUITE = CHANNEL_SNAPSHOT.flatMap(({ manifest }) => [manifest.binary, ...(manifest.server.bins ?? [])]);
const BARE = new RegExp(`(?:^|[\\s\`'"(\\[,])(?:${SUITE.join('|')})(?:\\.(?:cmd|exe|ps1|bat))?\\s+[\\w<\\[-]`, 'i');

/** Fails when `text` names a suite command by its bare name followed by anything to run with it. */
export function assertNoBareCommand(text: string, what = 'the output'): void {
  assert.doesNotMatch(text, BARE, `${what} names a suite command by its bare name: ${text}`);
}

/** Core's own CLI entry here: its source, since the tests run core from source. */
const CORE_SOURCE_CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

/**
 * Whether `program` is this Node: its own path, or a path on PATH that resolves to the same file — a `node` that is a
 * link to it, which a command names as PATH has it (CUE-492). A CLI run with the test's own PATH finds it so.
 */
function isThisNode(program: string): boolean {
  if (program === process.execPath) return true;
  try {
    return realpathSync(program) === realpathSync(process.execPath);
  } catch {
    return false;
  }
}

/**
 * The command in backticks in `text` that ends with `words`, checked to be core's own, located: this Node, then core's
 * CLI entry here, then path pins, then the words. For output whose folders a test cannot name in advance — a CLI run in
 * a fresh home — rather than for building an expected sentence.
 */
export function locatedCoreLine(text: string, words: readonly string[]): string {
  const tail = ` ${words.join(' ')}`;
  const line = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string).find((each) => each.endsWith(tail));
  assert.ok(line !== undefined, `no command ending in "${tail.trim()}" in: ${text}`);
  assert.ok(isThisNode(line.split(' ', 1)[0] ?? ''), `the program is this Node: ${line}`);
  assert.ok(line.includes(` ${CORE_SOURCE_CLI} `), `it runs core's own CLI: ${line}`);
  assert.match(line, / --config-dir /, 'with the folders pinned');
  assertNoBareCommand(text);
  return line;
}
