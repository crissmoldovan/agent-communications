/**
 * How a command's words are quoted for the shell it is pasted into, and shown when no line is safe (CUE-306, CUE-403).
 *
 * Internal to core, and not exported from its entry: a command for a person is one of two kinds, each made in one place
 * — one of this suite's own CLIs by the locator (`locateCliCommand`, a `PrintedCommand`), any other program by
 * `externalCommand` (an `ExternalCommand`) — and both quote their words here when they are made. Everything that shows
 * a command takes one of those two (`inlineCommand`, `commandText` in `cli-runtime.ts`), so there is no third way to
 * make words into something printed as a command.
 */

/**
 * Words quoted for a shell, as `quoteCommand` quotes them — or, on Windows, cannot. The shape both kinds of command
 * have: a `PrintedCommand` and an `ExternalCommand` are each made with their words quoted here, and rendered from
 * these fields alone.
 */
export interface QuotedCommand {
  /** The words, as the program is to receive them. */
  readonly words: readonly string[];
  /** The line to paste; null when no supported shell-specific rendering is safe. */
  readonly line: string | null;
  readonly platform: NodeJS.Platform;
  /** Present when `line` is deliberately for one shell rather than the Windows common subset. */
  readonly shell?: 'powershell' | undefined;
}

/**
 * A command line for a person to copy and run, each word quoted only where the shell it is pasted into would need it.
 * Every command this suite prints to be run — a change to run again with its approval, a folder to take out, an entry
 * to register again or remove — is quoted here, when the locator or `externalCommand` makes it, so no printer quotes
 * for a shell of its own.
 *
 * Everywhere but Windows that shell is a POSIX one, and a word goes in single quotes, inside which nothing is special
 * but the quote itself. Windows has two shells, and neither reads single quotes that way: cmd.exe does not take them
 * as quotes at all, so `'C:\Profiles\First Last\outgoing'` reached the command as two words, quote marks and all, and
 * PowerShell does, but escapes a quote inside them by doubling it rather than as `'\''`. A common line printed on
 * Windows has to be safe in both — and safe is not enough:
 * the program has to receive the same words from either. Three readers stand between the line and the program. cmd.exe
 * hands the program the line as it is, and the program's own parser (the C runtime's, Node's) splits it. PowerShell
 * reads the line itself, a double-quoted word with its backslashes as plain characters, and then writes a new command
 * line for the program: Windows PowerShell 5.1 the old way ("Legacy" in about_Parsing, "Passing arguments to native
 * applications") — a word quoted only when it holds whitespace, as it is, and an empty word dropped — and PowerShell
 * 7.3 and later its own way ("Standard") — quoted when it must be, with every backslash before a quote doubled. For a
 * `.cmd` script, which is how npm installs `agentcomms`, `claude` and `codex` on Windows, PowerShell 7 goes back to the
 * old way, and cmd.exe then reads that new line. So on Windows:
 *
 * - A word of letters, digits and `_ + = : . / \`, with `@` and `-` anywhere but first, is left as it is: no reader
 *   does anything with it, and a backslash is an ordinary character to all of them, at the end too. A first `@` is
 *   splatting to PowerShell, and a `,` its array operator — two words — so a word with either is quoted. So is a word
 *   that starts with a digit, which PowerShell may read as a number (`1kb`, `0x10`), and one that starts with `-` but
 *   is not a plain option, which PowerShell may read as a parameter of its own and split (`-name.x`).
 * - A word that double quotes bring through all three readers whole goes in double quotes. Inside them cmd.exe reads
 *   `& | < > ^ ( )` and spaces as ordinary characters, and PowerShell reads everything as ordinary but `$`, the
 *   backtick and a double quote. What is left special in one or the other is kept out: a double quote, which ends the
 *   quoting in both — and PowerShell takes the curly ones, `“ ” „`, for one too; `$` and the backtick, PowerShell's
 *   expansion and escape; `%`, which cmd.exe expands as `%NAME%` before it looks at quotes at all; `!`, which it
 *   expands as `!NAME!` inside quotes too wherever delayed expansion is on, and which then makes a `^` inside quotes an
 *   escape; and any control or formatting character — a line break ends the command in cmd.exe even inside quotes, a
 *   tab pasted into cmd.exe can complete a file name, and a right-to-left override shows a line other than the one
 *   that runs. Three more cannot come through: an empty word, which Windows PowerShell drops; a word ending in a
 *   backslash, which the C runtime reads with the closing quote as `\"` — and doubled for it, PowerShell 7 passes both
 *   backslashes on where cmd.exe and Windows PowerShell pass one; and a word with `& | < > ^ ( )` but no whitespace,
 *   which PowerShell passes to a `.cmd` script unquoted, for cmd.exe to run `&whoami` from or to split at `|`.
 * - With any other word in it, the common renderer has no line, and the printers show the command's words
 *   as JSON instead, saying it has to be typed. Not a line with the word left out: a placeholder in its place was
 *   still a command that ran — `claude mcp remove NAME` removed whatever entry was called `NAME`, and an install
 *   hint's `--force` replaced it — and before that, a word quoted for PowerShell's single quotes, which cmd.exe reads
 *   as characters, ran `whoami` from a server named `$x&whoami&`. See `commandAsJson` for why the JSON runs nothing.
 *
 * - The program itself has to be left as it is in the common form. Quoted, it is a string to PowerShell rather than a
 *   command. When its path needs quoting, CUE-410 may emit a labelled PowerShell line: `&`, then every word in single
 *   quotes, with an inner single quote doubled. Empty words, trailing backslashes, double quotes and control or
 *   formatting characters retain the inert-JSON fallback because their native-program boundary cannot be proved
 *   across the supported PowerShell versions.
 *
 * Everywhere else there is always a line: single quotes make any word safe.
 *
 * Not a way to make a command for a person: what it returns is not one, and nothing that shows a command takes it. One
 * of this suite's own commands comes from `locateCliCommand`, any other program's from `externalCommand`, and each of
 * them quotes its words here.
 */
export function quoteCommand(words: readonly string[], platform: NodeJS.Platform): QuotedCommand {
  if (platform !== 'win32') return { words, line: words.map(posixShellWord).join(' '), platform };
  const printed = words.map(windowsShellWord);
  const programBare = words.length === 0 || printed[0] === words[0];
  if (!printed.includes(null) && programBare) return { words, line: printed.join(' '), platform };
  if (!programBare && printed.slice(1).every((word) => word !== null)) {
    const powershell = words.map(powerShellWord);
    if (!powershell.includes(null)) {
      return { words, line: `& ${powershell.join(' ')}`, platform, shell: 'powershell' };
    }
  }
  return { words, line: null, platform };
}

/**
 * A printed command's line with words the agent is to fill in — a placeholder such as `<folder>`, printed as written,
 * never quoted as a word — before the command's first `--`, where the CLI still reads them as options. Null when the
 * command has no line.
 */
export function quotedLineWithWordsToFill(command: QuotedCommand, ...toFill: readonly string[]): string | null {
  if (command.line === null) return null;
  const sentinel = command.words.indexOf('--');
  if (sentinel < 0) return [command.line, ...toFill].join(' ');
  if (command.shell === 'powershell') {
    const printed = command.words.map((each) => powerShellWord(each) as string);
    return `& ${[...printed.slice(0, sentinel), ...toFill, ...printed.slice(sentinel)].join(' ')}`;
  }
  const word = command.platform === 'win32' ? windowsShellWord : posixShellWord;
  // The command has a line, so every word in it has a printed form.
  const printed = command.words.map((each) => word(each) as string);
  return [...printed.slice(0, sentinel), ...toFill, ...printed.slice(sentinel)].join(' ');
}

/** Whether a Windows command has no line because its program's path needs quotes, which PowerShell would not run. */
function programNeedsQuotes(command: QuotedCommand): boolean {
  const [program] = command.words;
  return command.platform === 'win32' && program !== undefined && windowsShellWord(program) !== program;
}

function posixShellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The word as cmd.exe, Windows PowerShell and PowerShell 7 all hand it to a program, or null when no printing of it
 * does (see `quoteCommand`). Bare: a plain option, or ordinary characters that do not start like a number.
 */
function windowsShellWord(word: string): string | null {
  if (/^(?:--?[A-Za-z][A-Za-z0-9-]*|(?!\+?\.?\d)[\w+=:./\\][\w@+=:./\\-]*)$/.test(word)) return word;
  if (word === '' || word.endsWith('\\')) return null;
  if (/["$`%!\u201C-\u201E]|[\p{C}\p{Zl}\p{Zp}]/u.test(word)) return null;
  if (/[&|<>^()]/.test(word) && !/\s/.test(word)) return null;
  return `"${word}"`;
}

/** One native-command word in a PowerShell single-quoted literal, or null when a one-line call is not provable. */
function powerShellWord(word: string): string | null {
  // Windows PowerShell cannot reliably forward an empty native argument, and a trailing slash can escape the quote
  // it reconstructs for the C runtime. Controls and formatting characters can end or visually rewrite the line.
  if (word === '' || word.endsWith('\\') || /["\u201C-\u201E]|[\p{C}\p{Zl}\p{Zp}]/u.test(word)) return null;
  return `'${word.replaceAll("'", "''")}'`;
}

/**
 * The words of a command as a JSON array, for a command that cannot be printed as a line: something to read, and to
 * parse, and nothing to run.
 *
 * Pasted into either Windows shell by mistake, it runs nothing. PowerShell refuses it before running anything: a `[`
 * opens a type name, and a quoted string is none. cmd.exe looks for a program called `["agentcomms"` or the like, and
 * finds none — and nothing in the line is anything else to it: every character it acts on, inside quotes or out (`%`,
 * `!`), is written as a `\u` escape, and so is every double quote inside a word, so the quotes cmd.exe sees are the
 * JSON's own, in pairs, and `&`, `|`, `<`, `>`, `^` and the parentheses are only ever inside them, where it reads them
 * as characters. `$` and the backtick are escaped too, so that PowerShell would expand nothing even if it read on, and
 * so is everything outside printable ASCII — a line break, a curly quote, a right-to-left override. A backslash is
 * doubled, as JSON has it.
 */
export function commandAsJson(words: readonly string[]): string {
  const word = (text: string) => {
    let json = '';
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      const char = text[index] as string;
      if (char === '\\') json += '\\\\';
      else if (code >= 0x20 && code <= 0x7e && !'"%!$`'.includes(char)) json += char;
      else json += `\\u${code.toString(16).padStart(4, '0')}`;
    }
    return `"${json}"`;
  };
  return `[${words.map(word).join(',')}]`;
}

/** What is said beside a command shown as JSON. */
const TO_TYPE =
  "the command's words, written as JSON: one of them cannot be quoted the same way for cmd.exe and for PowerShell, so type the command yourself, with that word quoted for the shell you use";

/** What is said beside a command shown as JSON because its program's path needs quotes. */
const TO_TYPE_PROGRAM =
  "the command's words, written as JSON: the program's path needs quoting and at least one word cannot be represented safely in a one-line PowerShell call, so type the command yourself, with each word quoted for the shell you use and, in PowerShell, `&` before the program";

function toType(command: QuotedCommand): string {
  return programNeedsQuotes(command) ? TO_TYPE_PROGRAM : TO_TYPE;
}

/** Quoted words in backticks, for a sentence — as words in JSON, saying it has to be typed, when there is no line. */
export function inlineQuoted(command: QuotedCommand): string {
  if (command.line === null) return `\`${commandAsJson(command.words)}\` (${toType(command)})`;
  return `\`${command.line}\`${command.shell === 'powershell' ? ' (PowerShell)' : ''}`;
}

/** Quoted words as text of their own — a list's line, a field's value — or as words in JSON, saying to type them. */
export function quotedText(command: QuotedCommand): string {
  if (command.line === null) return `${commandAsJson(command.words)} (${toType(command)})`;
  return command.shell === 'powershell' ? `PowerShell:\n${command.line}` : command.line;
}

/**
 * The same command with words the agent is to fill in — a placeholder such as `<folder>` — before its first `--`: for
 * showing as words in JSON when the command has no line. With a line, `quotedLineWithWordsToFill` prints them as they
 * are written instead, never quoted as a word.
 */
export function quotedWithWordsToFill(command: QuotedCommand, toFill: readonly string[]): QuotedCommand {
  const sentinel = command.words.indexOf('--');
  const at = sentinel < 0 ? command.words.length : sentinel;
  return quoteCommand([...command.words.slice(0, at), ...toFill, ...command.words.slice(at)], command.platform);
}
