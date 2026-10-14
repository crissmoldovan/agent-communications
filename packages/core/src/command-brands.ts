import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteCommand, quotedText } from './command-line.ts';
import { EXECUTABLE_EXTENSION, SUITE_COMMANDS, suitePackageRootOf } from './package-roots.ts';

/**
 * A command for a person to run that is not this suite's: `chmod`, or an MCP client's own `claude mcp …` and
 * `codex mcp …` (design 2026-10-04, D5).
 *
 * Every command printed for a person is one of two kinds. One of this suite's own CLIs is a `PrintedCommand`, which
 * only the locator makes (`cli-command.ts`): it names this Node and a checked file of the product, because a bare
 * `agent-gmail` is not on the PATH of most people it is printed for (CUE-403). Anything else is an `ExternalCommand`,
 * made here and nowhere else, with the reason that program is one a person may be told to run.
 *
 * So that this is not a way round the locator, `externalCommand` refuses words that would start one of this suite's
 * products by another route: a word containing one of the suite's commands — in any case, alone, as a path's last
 * part or inside a wrapper's payload (`sh -c "agent-gmail …"`) — a word naming a package of the suite
 * (`npx @agentcomms/gmail`), or a path inside the root of a suite package, as written or through a link
 * (`node …/packages/gmail/dist/cli.mjs`). Every word is looked at, not only the first: the program is often a wrapper.
 *
 * This module is a leaf: it reads the manifests' facts and the files a path names, and imports nothing that registers,
 * scans or locates, so nothing it refuses can be routed back through it.
 */

/** The gate a constructor call has to pass: only this module holds it. */
const GATE: unique symbol = Symbol('externalCommand');

/**
 * One reviewed command of a program that is not this suite's. Rendered as every printed command is — a line to paste,
 * or on Windows its words as JSON when no line is safe in every shell (`inlineCommand`, `commandText`).
 *
 * A class with a private field, so the type is nominal: an object literal with the same fields is not one, and nor is
 * a spread copy of one with other words in it. Only the type is exported; the class is not.
 */
class ExternalCommand {
  readonly #reason: string;
  /** The words, as the program is to receive them. */
  readonly words: readonly string[];
  /** The line to paste; null when no supported common or labelled shell rendering is safe. */
  readonly line: string | null;
  readonly platform: NodeJS.Platform;
  readonly shell?: 'powershell' | undefined;

  constructor(gate: typeof GATE, words: readonly string[], platform: NodeJS.Platform, reason: string) {
    if (gate !== GATE) throw new TypeError('an external command is made by externalCommand, and only there');
    this.#reason = reason;
    this.words = Object.freeze([...words]);
    const quoted = quoteCommand(this.words, platform);
    this.line = quoted.line;
    this.platform = platform;
    if (quoted.shell !== undefined) this.shell = quoted.shell;
    Object.freeze(this);
  }

  /** Why this program, which is not part of this suite, is one a person may be told to run. */
  get reason(): string {
    return this.#reason;
  }

  /** As JSON, the text it always was: its line, or its words as JSON with what to do (as a `PrintedCommand`). */
  toJSON(): string {
    return quotedText(this);
  }

  /** Never interpolated: rendered with `commandText` or `inlineCommand`. */
  [Symbol.toPrimitive](): never {
    throw new TypeError('an external command is rendered with commandText or inlineCommand, never interpolated');
  }
}

export type { ExternalCommand };

/** A package specifier of the suite, with either separator: `@agentcomms/gmail`, `node_modules\@agentcomms\gmail`. */
const SUITE_PACKAGE = /@agentcomms[\\/]/i;

/**
 * The parts of a word a shell or a wrapper could take as a command name: split wherever a character could not be part
 * of one, so `sh -c "cd x && agent-gmail approve"`, `--run=agent-gmail` and `C:\npm\agent-gmail.cmd` each yield
 * `agent-gmail`. Compared without case, as Windows compares executable names; on a case-sensitive system that refuses
 * a little more than it must, and nothing that it should not.
 */
function commandNames(word: string): string[] {
  return word
    .split(/[^A-Za-z0-9._-]+/)
    .map((part) =>
      part
        .replace(/^\.+|\.+$/g, '')
        .replace(EXECUTABLE_EXTENSION, '')
        .toLowerCase(),
    )
    .filter(Boolean);
}

/**
 * The paths in a word: the word itself, and each part of it between spaces, quotes, `=` and a shell's separators, that
 * is absolute, `~/…`, or a `file:` URL. A relative path is not resolved: the folder a person pastes the command in is
 * not known here, and a server called `7/gmail` is a name, not a path.
 */
function pathsIn(word: string): string[] {
  const paths: string[] = [];
  for (const part of [word, ...word.split(/[\s"'`=;&|<>(),]+/)]) {
    if (part.length === 0) continue;
    if (/^file:/i.test(part)) {
      try {
        paths.push(fileURLToPath(part));
      } catch {
        // Not a file URL Node can read; nothing to check.
      }
    } else if (part === '~' || /^~[\\/]/.test(part)) {
      paths.push(join(homedir(), part.slice(2)));
    } else if (isAbsolute(part)) {
      paths.push(part);
    }
  }
  return paths;
}

/** Why these words must not be an external command, or null when they may be. */
function refusal(words: readonly string[]): string | null {
  for (const [index, word] of words.entries()) {
    if (SUITE_PACKAGE.test(word)) return `word ${index} names a package of this suite`;
    for (const path of pathsIn(word)) {
      const root = suitePackageRootOf(path);
      if (root !== null) return `word ${index} is a path inside ${root}, a package of this suite`;
    }
    if (commandNames(word).some((name) => SUITE_COMMANDS.has(name)))
      return `word ${index} names a command of this suite`;
  }
  return null;
}

/**
 * The one way to make an `ExternalCommand`: `words` for a program that is not this suite's, and `reason`, why a person
 * may be told to run it. Throws a `TypeError` for words that would start a product of this suite (see the module), so
 * a call site whose words come from somewhere else — a server's name read from a client's file, a folder — says what
 * to do in prose instead when one is refused. `platform` is the shell it is quoted for.
 */
export function externalCommand(
  words: readonly string[],
  reason: string,
  platform: NodeJS.Platform = process.platform,
): ExternalCommand {
  if (words.length === 0 || (words[0] ?? '').length === 0) throw new TypeError('an external command needs a program');
  if (reason.trim().length === 0) throw new TypeError('an external command needs the reason it may be run');
  const refused = refusal(words);
  if (refused !== null) {
    throw new TypeError(`not an external command: ${refused}; a command of this suite comes from locateCliCommand`);
  }
  return new ExternalCommand(GATE, words, platform, reason);
}
