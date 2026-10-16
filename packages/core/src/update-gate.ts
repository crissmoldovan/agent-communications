import { CHANNEL_SNAPSHOT } from './channels.generated.ts';
import type { OutputOptions, Streams } from './cli-runtime.ts';
import type { Core } from './core.ts';
import { handoffSentence, requireHandoffs } from './handoffs.ts';
import {
  changeUpdateCheck,
  type PendingUpdate,
  pendingUpdate,
  readUpdateCheck,
  UPDATE_STARTED_BY_ENV,
  type UpdateCheckRecord,
  updateCheckDue,
  updateCheckEnabled,
  updateCheckSwitchedOff,
  updateSnoozed,
  updateVerdict,
} from './update-state.ts';

/**
 * The update notice, where every server and every command meets it (design 2026-10-16, U1). It replaces the stop of
 * the daily update check (design 2026-09-28): nothing is refused for being behind any more. A server's first tool
 * result of its process carries one line beside the result; a command prints the same line once on stderr, at most
 * once a day for the machine, and runs.
 *
 * Reader only, like `update-state.ts`: what asks the registry is handed in — `refresh` to a server's notice, `check` to
 * a command's — by every package but WhatsApp, which has no network code and hands in nothing.
 */

/** The product, as a notice names it: never a command's name, which a sentence would read as one to run (CUE-403). */
const PRODUCT = 'agent-communications';

// ── A server: its first tool result ───────────────────────────────────────────────────────────────────────────

/**
 * What `strictToolArguments` asks once a tool has answered: the one line to carry beside that result, or null. It is
 * asked of every call, and answers a line at most once in the life of the process.
 */
export type ToolNotice = (tool: string) => Promise<string | null>;

export interface UpdateToolNoticeOptions {
  core: Core;
  env: NodeJS.ProcessEnv;
  /** Its channel, `gmail`, `core`: whose registrations say whether restarting the client would start `latest`. */
  channel: string;
  /** The version this server is. */
  running: string;
  /**
   * Tools whose results never carry the notice, and do not use it up: the update's own, and the doctor — each says
   * what is behind already, in its own words.
   */
  exempt: readonly string[];
  /**
   * The check, run in the background — never awaited by a call — whenever a call arrives and none is running. Absent
   * for WhatsApp, which reads the file as whatever else on the machine last left it.
   */
  refresh?: (() => Promise<unknown>) | undefined;
  now?: (() => Date) | undefined;
}

/**
 * A server's notice. After a tool answers: if a newer release is out, the check is on — the setting, `CI` and
 * `AGENT_COMMS_UPDATE_CHECK` — and the tool is not exempt, the result carries one line, and no later result of this
 * process carries it again. Nothing is ever refused, and nothing waits for the check: the file is read as it is.
 *
 * At most once per process, on the first result there is something to say on: a server started on a day the check is
 * due learns of the release a moment after its first call, and says so on the next.
 */
export function updateToolNotice(options: UpdateToolNoticeOptions): ToolNotice {
  const exempt = new Set(options.exempt);
  let running: Promise<unknown> | null = null;
  let given = false;
  // One decision at a time, so two calls answered together cannot both carry the line.
  let turn: Promise<unknown> = Promise.resolve();
  return (tool) => {
    // Switched off by the environment: nothing — no check, no notice.
    if (updateCheckSwitchedOff(options.env) !== null) return Promise.resolve(null);
    if (options.refresh && running === null) {
      running = options
        .refresh()
        .catch(() => undefined)
        .finally(() => {
          running = null;
        });
    }
    if (given || exempt.has(tool)) return Promise.resolve(null);
    const decided = turn.then(async () => {
      if (given) return null;
      const pending = await pendingUpdate({ ...options, surface: 'server' });
      if (pending === null) return null;
      given = true;
      return serverNoticeLine(pending, options.env);
    });
    turn = decided.catch(() => null);
    return decided.catch(() => null);
  };
}

/** Who started a server from a release it pins itself, in words: the plugin's, the extension's. */
function startedByWords(startedBy: string): string {
  if (startedBy === 'claude-code-plugin') return 'the Claude Code plugin';
  if (startedBy === 'gemini-extension') return 'the Gemini extension';
  return 'a plugin or an extension';
}

/**
 * The server's line. "Installed" only on the check's positive finding that restarting starts `latest`; a server a
 * plugin or an extension started is updated where it was installed, which `comms_update` never moves.
 */
export function serverNoticeLine(pending: PendingUpdate, env: NodeJS.ProcessEnv = {}): string {
  if (pending.kind === 'restart') {
    return `${PRODUCT} ${pending.latest} is installed; restart the client (in Claude Code, /mcp → Reconnect) to use it.`;
  }
  const startedBy = env[UPDATE_STARTED_BY_ENV]?.trim();
  if (startedBy) {
    return `${PRODUCT} ${pending.latest} is out; this server came with ${startedByWords(startedBy)}, and is updated there when it suits you.`;
  }
  return `${PRODUCT} ${pending.latest} is out; say "update" when it suits you.`;
}

// ── A command at a terminal ──────────────────────────────────────────────────────────────────────────────────────

/** The commands that never print the notice, by their first word; `mcp` alone runs a server, which has its own. */
const EXEMPT_COMMANDS: readonly string[] = Object.freeze(['update', 'doctor', 'paths', 'approve', 'approvals', 'help']);

/**
 * Whether a command is left alone by the update notice: `update` in every form, `doctor`, `paths`, `approve`,
 * `approvals`, help, and `mcp` alone — the server, which gives its own notice. `mcp install` and `mcp prune` are not.
 * `also` adds a channel's own — WhatsApp's `status`, its doctor. `--help` and `--version` never reach a command.
 */
export function exemptFromUpdateNotice(path: readonly string[], also: readonly string[] = []): boolean {
  const [first] = path;
  if (first === undefined) return true;
  if (EXEMPT_COMMANDS.includes(first) || also.includes(first)) return true;
  return first === 'mcp' && path.length === 1;
}

/** The shape of a Commander command this needs: its name, and the command it is under (null for the program). */
export interface CommandLike {
  name(): string;
  readonly parent: CommandLike | null;
}

/** A Commander command's path below the program, `['mcp', 'install']`: what `exemptFromUpdateNotice` reads. */
export function commandPathOf(command: CommandLike): string[] {
  const path: string[] = [];
  for (let at: CommandLike | null = command; at?.parent; at = at.parent) path.unshift(at.name());
  return path;
}

/** What asks the registry for a command: handed in by every CLI but WhatsApp's — see `terminalUpdateHooks`. */
export interface TerminalUpdateHooks {
  /**
   * The check, when the file is due. It never throws, and it is never cut short: the notice stops waiting for it after
   * about three seconds, and it carries on beside the command — in a detached child of its own, which holds none of the
   * command's output, so the command's process ends when the command does (#48).
   */
  check?: (() => Promise<void>) | undefined;
}

export interface TerminalNoticeOptions extends TerminalUpdateHooks {
  core: Core;
  env: NodeJS.ProcessEnv;
  /** Its channel, `gmail`, `core`: whose global package says whether running the command again would run `latest`. */
  channel: string;
  /** The version this command is. */
  running: string;
  output: OutputOptions;
  streams: Streams;
  now?: (() => Date) | undefined;
  /** How long the command waits for the check before it goes on without it. About three seconds. */
  waitMs?: number | undefined;
}

export const TERMINAL_CHECK_WAIT_MS = 3_000;

/** How often a command says it, for the whole machine: once a day. */
export const COMMAND_NOTICE_INTERVAL_MS: number = 24 * 60 * 60 * 1000;

/** A few minutes for two processes' clocks, read at slightly different moments, as the check allows. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The update notice at a terminal, before a command runs. It never stops the command, and never throws.
 *
 * It reads the file first. If the check is due it asks the registry — through `check` — waiting at most about three
 * seconds and going on without it after that. Then, when a newer release is out and no command on this machine has
 * said so in the last day, it prints one line on stderr — never on stdout, where a result or `--json` is — and the
 * command runs.
 */
export async function updateNoticeAtTerminal(options: TerminalNoticeOptions): Promise<void> {
  const { core, env, streams } = options;
  const now = options.now ?? (() => new Date());
  try {
    if (!(await updateCheckEnabled(core, env)).on) return;
    if (options.check && updateCheckDue(await readUpdateCheck(core.paths.stateDir), now())) {
      // Stops waiting, and goes on: the check itself is not cut short, and finishes beside the command. A timer that
      // keeps the process alive, so the wait is the wait, whatever the check is waiting on.
      let timer: NodeJS.Timeout | undefined;
      const gaveUp = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.waitMs ?? TERMINAL_CHECK_WAIT_MS);
      });
      try {
        await Promise.race([options.check().catch(() => undefined), gaveUp]);
      } finally {
        clearTimeout(timer);
      }
    }
    const line = await commandNotice(options, now);
    if (line !== null) streams.stderr.write(`${line}\n`);
  } catch {
    // The notice never stops anything, a command least of all.
  }
}

/** Whether a command said it less than a day ago: a time from the future — a clock gone back — is not trusted. */
function saidToday(record: UpdateCheckRecord, at: Date): boolean {
  if (record.commandNoticeAt === null) return false;
  const since = at.getTime() - Date.parse(record.commandNoticeAt);
  return since >= -CLOCK_SKEW_MS && since < COMMAND_NOTICE_INTERVAL_MS;
}

/**
 * The command's line, decided and recorded under the file's lock — so of two commands started together, one says it —
 * or null: nothing newer, put off, or already said today.
 */
async function commandNotice(options: TerminalNoticeOptions, now: () => Date): Promise<string | null> {
  const where = { channel: options.channel, surface: 'command' as const };
  const decided = await changeUpdateCheck<PendingUpdate>(options.core.paths.stateDir, (record) => {
    const at = now();
    if (updateSnoozed(record, at) || saidToday(record, at)) return null;
    const pending = updateVerdict(record, options.running, where);
    if (pending === null) return null;
    return { record: { ...record, commandNoticeAt: at.toISOString() }, result: pending };
  });
  const pending = decided.result;
  if (pending === undefined) return null;
  return commandNoticeLine(options.core, pending, options.channel, options.output.platform);
}

/**
 * The CLI a notice names, in product words — "Gmail CLI", "core CLI" — never its binary, which is no command most
 * people can run, and which a sentence would read as one (CUE-403).
 */
function cliOf(channel: string): string {
  if (channel === 'core') return 'core CLI';
  return `${CHANNEL_SNAPSHOT.find((entry) => entry.manifest.channel === channel)?.manifest.label ?? channel} CLI`;
}

/**
 * The command's line: the update, as core's own command located from what is printing — or why there is none here —
 * or, when this command's package is installed globally at `latest` and an older copy is running, to run that one.
 */
export function commandNoticeLine(
  core: Pick<Core, 'handoffs'>,
  pending: PendingUpdate,
  channel: string,
  platform?: NodeJS.Platform | undefined,
): string {
  if (pending.kind === 'restart') {
    return `${PRODUCT} ${pending.latest} is installed; this ${cliOf(channel)} is ${pending.running}, started from somewhere else — npx's cache, a project's own install, a checkout: run it from the installed one.`;
  }
  const update = requireHandoffs(core, platform).core(['update']);
  return `${PRODUCT} ${pending.latest} is out (this is ${pending.running}); ${handoffSentence(update, (command) => `run ${command} when it suits you.`)}`;
}
