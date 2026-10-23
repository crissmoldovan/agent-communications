import { type ChildProcess, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { channelServer } from './channel-servers.ts';
import type { Core } from './core.ts';
import { CommsError } from './errors.ts';
import { handoffSentence, isCommand, requireHandoffs } from './handoffs.ts';
import { npmLatestVersion } from './npm.ts';
import { releaseFactsReader, type UpdateDeps, updateCheck } from './operations/update.ts';
import { PATH_OPTIONS, type ResolvedPaths } from './paths.ts';
import { DECLARATION_DEADLINE_MS } from './release-facts.ts';
import { childEnvironment } from './system-programs.ts';
import { TERMINAL_CHECK_WAIT_MS, type TerminalUpdateHooks } from './update-gate.ts';
import type { ReleaseVerifier } from './update-release.ts';
import {
  changeUpdateCheck,
  EMPTY_UPDATE_CHECK,
  type ReleaseFacts,
  readUpdateCheck,
  UPDATE_CHECK_LEASE_MS,
  UPDATE_NOTICE_LOCK,
  type UpdateCheckRecord,
  updateCheckDue,
  updateCheckEnabled,
  updateCheckUnderway,
} from './update-state.ts';
import { VERSION } from './version.ts';
import { isPlainVersion, isVersion } from './versions.ts';

/**
 * The daily update check's checker: the half that asks the registry (design 2026-09-28 §1).
 *
 * At most once in 24 hours for the whole machine, it reads the `latest` dist-tag of `@agentcomms/core` — every
 * package here is released together under one version, so that one number is the latest of each — and runs the same
 * "what is behind" check `comms_update` runs with `check`, handing it that number, so the registry is asked once. What
 * it found goes in `update-check.json`, where every server and command reads it.
 *
 * Two processes finding the file a day old at the same moment do not both ask: the first to take the file's lock
 * claims the check (`checking`), and the second, reading the file under the same lock, finds it claimed. The day's
 * `lastChecked` is written when the ask is over, so an ask cut short — a command the person interrupted, a server
 * whose client closed it — does not use up the day: its claim runs out (`UPDATE_CHECK_LEASE_MS`) and the next process
 * asks. An ask that fails — offline, a registry that does not answer — is recorded as the day's ask, keeps the last
 * result, and changes nothing else. It never throws.
 *
 * Nothing here gives up on the registry sooner than the registry's own timeout: a command at a terminal stops
 * *waiting* after about three seconds and goes on, and the check carries on beside it — in a detached child of its
 * own (`UPDATE_CHECK_CHILD_COMMAND`), so the command's process, and its output, end when the command does (#48). Cut
 * off at three seconds, a registry that takes five would have been asked every day and heard from never.
 *
 * WhatsApp imports none of this: see `update-state.ts`.
 */

const CORE_PACKAGE = channelServer('core').packageName;

export interface UpdateCheckOptions {
  /** The registry and `npm ls`, for a test — nothing a test runs reads the real ones. */
  deps?: UpdateDeps | undefined;
  now?: (() => Date) | undefined;
  /**
   * A channel's server: the ask handed to core's CLI at this channel's own version, which verifies what a release
   * declares (design 2026-10-22, P2) — when that core is found and starts; otherwise the ask is this process's, as it
   * always was. Never with `deps`, which a child could not be handed. Core's own server gives none.
   */
  handOff?: CoreHandOff | undefined;
}

/**
 * How a channel hands its update check to core's CLI (design 2026-10-22, P2). A channel carries core's code but not
 * its Sigstore verifier, so its own check can believe nothing a release declares; core's CLI, installed beside it at
 * the same version, can. Each part is a test's seam: a channel's command and its server pass `{}`, and core's own pass
 * nothing at all.
 */
export interface CoreHandOff {
  /** Core's command for `update-check-child <claimedAt>`, as words; null when there is none. Default `coreUpdateCheckWords`. */
  locate?: ((core: Core, claimedAt: string) => readonly string[] | null) | undefined;
  /**
   * Starts the words detached, with no shell, waiting until `deadline` at most; false when it could not start, or ended
   * badly before it said the ask is over. Default `startCheckChild`. A command starts its own child with it too, when
   * core's could not be started.
   */
  start?: ((words: readonly string[], env: NodeJS.ProcessEnv, deadline: number) => Promise<boolean>) | undefined;
}

export interface UpdateCheckOutcome {
  /**
   * Whether this call's claim was asked under — here, or by core's CLI it was handed to: false when the check is off,
   * not due, or another process is asking.
   */
  asked: boolean;
  record: UpdateCheckRecord;
}

/** The check, when it is on and due — once a day on `auto`, once in 14 days on `every-14-days` — per machine. */
export async function checkForUpdates(
  core: Core,
  env: NodeJS.ProcessEnv,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckOutcome> {
  const stateDir = core.paths.stateDir;
  try {
    const enabled = await updateCheckEnabled(core, env);
    if (!enabled.on) return { asked: false, record: await readUpdateCheck(stateDir) };
    const claimedAt = await claimUpdateCheck(core, { now: options.now, intervalMs: enabled.intervalMs });
    if (claimedAt === null) return { asked: false, record: await readUpdateCheck(stateDir) };
    // A channel's server hands the ask to core's CLI, and waits for it no longer than the claim holds: past that,
    // another process may claim the check and ask, and nothing here would be waiting for anything of this one's.
    const handed =
      options.handOff !== undefined &&
      options.deps === undefined &&
      (await handToCore(core, env, claimedAt, options.handOff, Date.now() + UPDATE_CHECK_LEASE_MS));
    if (!handed) await askUnderClaim(core, env, claimedAt, options);
    return { asked: true, record: await readUpdateCheck(stateDir) };
  } catch {
    // The check never stops anything, a command least of all: whatever went wrong, the file is what it was.
    return { asked: false, record: await readUpdateCheck(stateDir).catch(() => ({ ...EMPTY_UPDATE_CHECK })) };
  }
}

/**
 * The day's claim, when the check is due and nobody else is asking: the claim's time, written to the file as
 * `checking`, or null — not due, claimed by another process, or the file could not be written. Whoever is handed the
 * time asks under it (`askUnderClaim`). Whether the check is on at all is the caller's to decide first.
 *
 * Under the lock, due or not — and claimed by another process or not — is decided on the file as it is now, and the
 * claim written before anyone asks, so of two processes that both found it a day old, one asks. The time is read under
 * the lock too: read before it, the second process's time could be earlier than the first's claim, which reads as a
 * clock gone back.
 *
 * A claim is best effort, as a notice is (`UPDATE_NOTICE_LOCK`): 2 s at most for the lock, however often it changes
 * hands meanwhile, then null, and a later process claims. Every command's and every tool call's check claims here,
 * before the person's output is done; waited out holder by holder, as a record that matters waits, a busy machine's
 * refreshes kept a finished command's process and its stdout open for up to 15 s (0.26.0 review B).
 */
export async function claimUpdateCheck(
  core: Core,
  options: { now?: (() => Date) | undefined; intervalMs?: number | undefined } = {},
): Promise<string | null> {
  const now = options.now ?? (() => new Date());
  // Due by the machine's level: a day on `auto`, 14 days on `every-14-days` (design 2026-10-16, U2).
  const enabled = options.intervalMs === undefined ? await updateCheckEnabled(core, {}).catch(() => null) : null;
  const intervalMs = options.intervalMs ?? (enabled?.on ? enabled.intervalMs : undefined);
  const claim = await changeUpdateCheck<string>(
    core.paths.stateDir,
    (record) => {
      const claimedAt = now();
      if (!updateCheckDue(record, claimedAt, intervalMs) || updateCheckUnderway(record, claimedAt)) return null;
      const checking = claimedAt.toISOString();
      return { record: { ...record, checking }, result: checking };
    },
    UPDATE_NOTICE_LOCK,
  ).catch(() => null);
  return claim?.result ?? null;
}

/**
 * The ask, under a claim already taken (`claimUpdateCheck`): the registry, then `comms_update`'s own check. What it
 * found is written — the day's check recorded, and the claim given up — only while the claim in the file is still
 * `claimedAt`. It claims nothing itself.
 */
export async function askUnderClaim(
  core: Core,
  env: NodeJS.ProcessEnv,
  claimedAt: string,
  options: UpdateCheckOptions = {},
): Promise<void> {
  await ask(core, env, { ...options, now: options.now ?? (() => new Date()), claimedAt });
}

async function ask(
  core: Core,
  env: NodeJS.ProcessEnv,
  options: UpdateCheckOptions & { now: () => Date; claimedAt: string },
): Promise<void> {
  const deps = options.deps ?? {};
  /**
   * The ask is over: what it found is written, the day's check recorded as of the claim, and the claim given up — if
   * the claim is still this ask's. A check a person asked for, or an update, records what it found and gives up any
   * claim as it does; so does another process once this claim ran out and it claimed the check itself. Either way
   * what is in the file is newer than what this ask found, and writing over it would put back the machine as it was
   * before an update: "update" where "restart" is right.
   */
  const settle = (found: Partial<UpdateCheckRecord> | ((record: UpdateCheckRecord) => Partial<UpdateCheckRecord>)) =>
    changeUpdateCheck(core.paths.stateDir, (record) =>
      record.checking === options.claimedAt
        ? {
            record: {
              ...record,
              ...(typeof found === 'function' ? found(record) : found),
              lastChecked: options.claimedAt,
              checking: null,
            },
          }
        : null,
    ).catch(() => undefined);
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
  let latest: string;
  try {
    latest = await (deps.latestVersion ?? ((name: string) => npmLatestVersion(name, { env })))(CORE_PACKAGE);
    if (!isVersion(latest))
      throw new Error(
        // What it named is not repeated: the registry's answer can be anything at all.
        'the npm registry names something that is not a version as the latest release',
      );
  } catch (error) {
    await settle({ lastError: reason(error) });
    return;
  }
  if (!isPlainVersion(latest)) {
    // Not a release: a prerelease's words or build metadata are the registry's text, so nothing of it is recorded or
    // said, and nobody is told of it (re-review of 0.20.0, severity 6). The version is not repeated.
    await settle({
      latest: null,
      behind: null,
      current: null,
      lastError:
        'the npm registry names something that is not a plain release (MAJOR.MINOR.PATCH) as the latest: it is not counted',
    });
    return;
  }
  // What the latest declares — a security fix, a decision a release on the way needs (design 2026-10-16, U5, U7) —
  // read from its own verified tarball (design 2026-10-22 P1, §8.1), where this process can verify: core's hands in
  // its verifier, a channel's has none, and reads nothing (P2). Read first for this release, so a machine that cannot
  // be read still learns it; the check then asks again for the oldest release it finds here. The one reader is handed
  // to the check, so its answer — known or not, within its deadline — is the check's too: the tarball is not asked for
  // again (review B of 0.26.0, finding 2). A test's stand-in registry hands in its own, or none is read. Null: read,
  // and not known now. Undefined: not read here. For either, the record keeps what core's verified check found of the
  // same version — a version npm never publishes twice — and otherwise makes no claim.
  // Its reads stop a fixed time into the claim, not into this ask, which a command's child may start late.
  const read =
    deps.releaseFacts !== undefined
      ? deps.releaseFacts
      : releaseFactsReader(env, deps, core.paths.stateDir, {
          deadline: Date.parse(options.claimedAt) + DECLARATION_DEADLINE_MS,
        });
  const release: ReleaseFacts | null | undefined =
    read === null
      ? undefined
      : await read(CORE_PACKAGE, latest, VERSION).then(
          (facts) =>
            facts === null ? null : { version: latest, security: facts.security, needsDecision: facts.needsDecision },
          () => null,
        );
  try {
    // `comms_update`'s own check, handed the one number and the reader: it records what it finds, by this clock, and
    // so ends the ask — under this ask's claim, so only while the claim is still its own.
    await updateCheck(
      core,
      env,
      {
        ...deps,
        latestVersion: async () => latest,
        releaseFacts: read,
        now: options.now,
      },
      options.claimedAt,
    );
  } catch (error) {
    // The registry answered, and something here could not be read: what is known is recorded, and the rest is not.
    await settle((record) => ({
      latest,
      behind: null,
      current: null,
      lastError: reason(error),
      // As `recordFound` keeps it: read here and known, what was read; not read here, or not known now, what core's
      // verified check found of this same version, and nothing of another (design 2026-10-22 P2).
      release: release ?? (record.release?.version === latest ? record.release : null),
    }));
  }
}

// ── The rest of a command's check, in a child of its own ───────────────────────────────────────────────────────────

/**
 * The hidden command every CLI that asks the registry answers to — `agentcomms`, `agent-gmail`, `agent-slack`,
 * `agent-resend` — with the claim's time after it: the ask a command handed on (`terminalUpdateHooks`). Not in any
 * help, never given the update notice, and nothing a person or an agent runs.
 */
export const UPDATE_CHECK_CHILD_COMMAND = 'update-check-child';

/** How to start this CLI again: a program and the arguments before the hidden command. */
export interface UpdateCheckChildEntry {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * How to start the CLI this process is running: this Node, the flags it was started with, and the script it runs —
 * when that script is a CLI's entry, `cli.mjs` built or `cli.ts` from a checkout. Links are followed first: npm's
 * `agentcomms` is a link to `dist/cli.mjs`, and on Windows its `.cmd` shim has already started Node on the `.mjs`, so
 * no shim is ever started here. Every package that answers the hidden command bundles this function into its own
 * build, so the entry is the running script, not this module's neighbour — core's own CLI, next to a bundled copy of
 * core, is not the command the person ran.
 *
 * Null when the script is not a CLI's entry: a CLI's `run()` called from something else, a test runner for one. The
 * check is then asked in this process, as it always was.
 */
export function updateCheckChildEntry(
  script: string | undefined = process.argv[1],
  execArgv: readonly string[] = process.execArgv,
): UpdateCheckChildEntry | null {
  if (!script) return null;
  let path: string;
  try {
    path = realpathSync.native(script);
  } catch {
    return null;
  }
  if (!/^cli\.(?:mjs|ts)$/.test(basename(path))) return null;
  return { command: process.execPath, args: [...withoutDebugger(execArgv), path] };
}

/**
 * Node's own flags, less a debugger's. A child started with `--inspect-brk` would wait for a debugger nobody attaches
 * until its claim ran out, and one with `--inspect` would ask for the port the command already holds. The rest —
 * `--experimental-strip-types` for a checkout, say — the child needs as the command did.
 */
function withoutDebugger(execArgv: readonly string[]): string[] {
  return keptWords(execArgv.map((word) => ({ word, raw: word }))).map(({ raw }) => raw);
}

/** Words as Node reads them, each with how it was written, less a debugger's; `--inspect-port 9229` is two words. */
function keptWords<T extends { word: string }>(words: readonly T[]): T[] {
  const kept: T[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as T;
    // Node reads `_` in an option's name as `-`: `--inspect_brk=0` is `--inspect-brk=0`.
    const equals = word.word.indexOf('=');
    const name = (equals < 0 ? word.word : word.word.slice(0, equals)).replaceAll('_', '-');
    if (!/^--(?:inspect|debug)(?:-brk(?:-node)?|-port|-wait)?$/.test(name)) {
      kept.push(word);
      continue;
    }
    // `--inspect-port=9229` and `--inspect=9229` are one word; `--inspect-port 9229` takes the next.
    if (equals < 0 && /^--(?:inspect|debug)-port$/.test(name)) index++;
  }
  return kept;
}

/**
 * `NODE_OPTIONS` split as Node splits it: at a space — not a tab or a new line — except inside double quotes, where a backslash takes the
 * character after it as it is. Each word keeps how it was written, so what is kept goes to the child unchanged —
 * `--require "/tmp/with --inspect hook.js"` is one word, and not a debugger's.
 */
function nodeOptionWords(options: string): { word: string; raw: string }[] {
  const words: { word: string; raw: string }[] = [];
  let index = 0;
  while (index < options.length) {
    while (index < options.length && options[index] === ' ') index++;
    if (index >= options.length) break;
    const start = index;
    let word = '';
    let quoted = false;
    for (; index < options.length; index++) {
      const character = options[index] ?? '';
      if (quoted) {
        if (character === '\\' && index + 1 < options.length) word += options[++index];
        else if (character === '"') quoted = false;
        else word += character;
      } else if (character === ' ') {
        break;
      } else if (character === '"') {
        quoted = true;
      } else {
        word += character;
      }
    }
    words.push({ word, raw: options.slice(start, index) });
  }
  return words;
}

/**
 * The child's environment: the command's, with a debugger's flags taken out of `NODE_OPTIONS` too. Node reads
 * `NODE_OPTIONS` before any flag, so a command debugged through it — `NODE_OPTIONS=--inspect-brk` — would start a child
 * that waits for a debugger, holds its claim until the lease runs out, and outlives the command. Every other option in
 * it is kept as written; with none left, `NODE_OPTIONS` is left out. On Windows a variable's name is the same in any
 * case, so `node_options` is read, and taken out, as `NODE_OPTIONS` is.
 */
export function updateCheckChildEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const child = { ...childEnvironment(env, platform) };
  const names = Object.keys(child).filter((name) =>
    platform === 'win32' ? name.toUpperCase() === 'NODE_OPTIONS' : name === 'NODE_OPTIONS',
  );
  if (names.length === 0) return child;
  const kept = names
    .map((name) =>
      keptWords(nodeOptionWords(child[name] ?? ''))
        .map(({ raw }) => raw)
        .join(' '),
    )
    .filter((options) => options !== '')
    .join(' ');
  for (const name of names) delete child[name];
  if (kept !== '') child.NODE_OPTIONS = kept;
  return child;
}

/**
 * The day's check at a terminal, handed on (#48). The command claims the check itself, as it always has, so only one
 * process asks — then starts this CLI again, detached, with the hidden command and the claim's time, and waits up to
 * the notice's three seconds for it to say the ask is over. After that it lets go of the child, which carries on alone,
 * and the command's process ends when the command does: before, it lived until the ask was over — the registry's ten
 * seconds, then `npm ls`'s minute — and a `$(…)`, a pipe or an agent's shell waited with it. A fast answer is written
 * before the wait ends, and the notice reads the file after it, so the day's first command still says so.
 *
 * The child holds none of the command's output — stdin, stdout and stderr ignored, only the IPC channel for its one
 * message — or whatever reads that output would wait for the child as it waited for the check. Detached, so a
 * Ctrl-C at the terminal does not cut the ask short, and hidden, so Windows opens no console for it.
 *
 * A channel's command hands the ask to core's CLI first (design 2026-10-22, P2): core's command, located at the
 * channel's own version, with the same hidden command, the same claim and the same environment. Core's child verifies
 * what a release declares, which the channel's own could not.
 *
 * When the child cannot be started — no core, no entry to start, a program not there or not allowed, a `.cmd` that
 * would need a shell, a launcher whose Node was removed, which starts and ends at once — the next is tried: the
 * channel's own child, then the check in this process, as it was before. It never throws.
 */
async function handUpdateCheckToChild(
  core: Core,
  env: NodeJS.ProcessEnv,
  options: {
    now?: (() => Date) | undefined;
    entry?: UpdateCheckChildEntry | null | undefined;
    verifyRelease?: ReleaseVerifier | undefined;
    handOff?: CoreHandOff | undefined;
  },
): Promise<void> {
  const deadline = Date.now() + TERMINAL_CHECK_WAIT_MS;
  try {
    // Switched off — `CI`, a switch, the level `never` — nothing is claimed, and no child is started.
    const enabled = await updateCheckEnabled(core, env);
    if (!enabled.on) return;
    const claimedAt = await claimUpdateCheck(core, { now: options.now, intervalMs: enabled.intervalMs });
    if (claimedAt === null) return;
    if (options.handOff !== undefined && (await handToCore(core, env, claimedAt, options.handOff, deadline))) return;
    const entry = options.entry === undefined ? updateCheckChildEntry() : options.entry;
    const started =
      entry !== null &&
      (await startedSafely(
        options.handOff?.start ?? startCheckChild,
        ownChildWords(entry, claimedAt, core.paths),
        updateCheckChildEnvironment(env),
        deadline,
      ));
    if (!started) {
      await askUnderClaim(core, env, claimedAt, {
        now: options.now,
        ...(options.verifyRelease ? { deps: { verifyRelease: options.verifyRelease } } : {}),
      });
    }
  } catch {
    // The check never stops anything, a command least of all.
  }
}

/** This CLI again, as its child: the entry, every folder pinned, the hidden command and the claim. */
function ownChildWords(entry: UpdateCheckChildEntry, claimedAt: string, paths: ResolvedPaths): string[] {
  const pathArgs = PATH_OPTIONS.flatMap(({ key, flag }) => [flag, paths[key]]);
  return [entry.command, ...entry.args, ...pathArgs, UPDATE_CHECK_CHILD_COMMAND, claimedAt];
}

/**
 * Core's own command for `update-check-child <claimedAt>`, as the words to start: `core.handoffs.core(…)` with every
 * folder pinned, located as the channel finds core — its installed dependency, at exactly the channel's own version,
 * through the stable way in a managed runtime keeps (`locateCliCommand`). Locating checks files and runs nothing.
 *
 * Located for this process's own system, whatever shell its printed commands are quoted for: these words are started
 * here, and a managed runtime's stable launcher is started one way on Windows and another elsewhere.
 *
 * Null for core's own process, which asks itself and is never handed its own check; for a core opened without its
 * caller, which can locate nothing; and where no such core is found.
 */
export function coreUpdateCheckWords(core: Core, claimedAt: string): readonly string[] | null {
  if (core.handoffs === undefined || core.handoffs.caller.packageName === CORE_PACKAGE) return null;
  try {
    const handoffs = requireHandoffs(core, process.platform);
    const handoff = handoffs.core([UPDATE_CHECK_CHILD_COMMAND, claimedAt], { downloads: true });
    return isCommand(handoff) ? handoff.words : null;
  } catch {
    return null;
  }
}

/**
 * The ask handed to core's CLI (design 2026-10-22, P2): its command located (`handOff.locate`), started with the
 * claim and this command's child environment (`handOff.start`), and waited for until `deadline`. False when there is
 * no such command, or it did not start: then nothing was asked, and the claim is still this process's to ask under. It
 * never throws.
 */
async function handToCore(
  core: Core,
  env: NodeJS.ProcessEnv,
  claimedAt: string,
  handOff: CoreHandOff,
  deadline: number,
): Promise<boolean> {
  let words: readonly string[] | null;
  try {
    words = (handOff.locate ?? coreUpdateCheckWords)(core, claimedAt);
  } catch {
    return false;
  }
  if (words === null || words.length === 0) return false;
  return startedSafely(handOff.start ?? startCheckChild, words, updateCheckChildEnvironment(env), deadline);
}

/** A start's answer, with one that throws counted as not started: the fallback after it is all that is left. */
async function startedSafely(
  start: NonNullable<CoreHandOff['start']>,
  words: readonly string[],
  env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<boolean> {
  try {
    return (await start(words, env, deadline)) === true;
  } catch {
    return false;
  }
}

/**
 * Starts `words` — a program, then its arguments — detached and hidden, with no shell and `env` as given, and waits,
 * until `deadline` at most, for it to say the ask is over, or to end. False when it could not be started at all, or
 * when it ended with a code other than 0, or by a signal, before it said the ask is over — a launcher whose Node was
 * removed starts, and ends at once with 127 (0.26.0 review B). Either way nothing was asked, and the claim is still
 * this process's to ask under.
 *
 * Never through a shell: each word is one argument, as located, and nothing in them is read as a shell would read it.
 * A program only a shell could start — a Windows `.cmd` or `.bat`, which Node refuses without one (EINVAL) — is not
 * started, and the caller falls back.
 */
export async function startCheckChild(
  words: readonly string[],
  env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<boolean> {
  const [command, ...args] = words;
  if (command === undefined) return false;
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env,
    });
  } catch {
    return false;
  }
  // Attached before the next `await`, and never taken off: `spawn` reports a program that is not there, or not
  // allowed, on the following tick, and an 'error' event with no listener is thrown past every catch here.
  child.on('error', () => undefined);
  // Whichever comes first decides, and nothing after it changes the answer.
  const started = await new Promise<boolean>((resolve) => {
    // Still going at the deadline: it started, and carries on alone.
    const timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
    const done = (started: boolean) => {
      clearTimeout(timer);
      resolve(started);
    };
    // Without a process id the child never started: the ask is this process's after all.
    child.once('error', () => done(child.pid !== undefined));
    child.on('message', (message: { type?: unknown } | null) => {
      if (message?.type === 'settled') done(true);
    });
    /*
     * Ended, and its channel closed too: a message it sent before it ended comes through the channel before the
     * channel's end does, whichever of the two Node reports first. Ended with 0, it finished; ended with any other
     * code, or by a signal, before it said the ask is over, it asked nothing (0.26.0 review B).
     */
    let ended: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const over = () => {
      if (ended !== null && !child.connected) done(ended.code === 0 && ended.signal === null);
    };
    child.once('exit', (code, signal) => {
      ended = { code, signal };
      over();
    });
    child.once('disconnect', over);
  });
  // Let go: the channel closed and the child unreferenced, so nothing of it keeps this process alive.
  if (child.connected) child.disconnect();
  child.unref();
  return started;
}

/**
 * The hidden command's work, in the child a command started (`UPDATE_CHECK_CHILD_COMMAND`): the ask, under the claim
 * the command took and handed over. It claims nothing itself, and asks only while the file still holds that claim —
 * a claim that ran out, and that another process took since, is that process's to ask under. It says `settled` to the
 * command if the command is still listening, lets go of the channel, and ends; a command that stopped listening has
 * already gone on, and the ask is finished all the same. Results are written only while the claim is this child's.
 */
export async function runUpdateCheckChild(
  core: Core,
  env: NodeJS.ProcessEnv,
  claimedAt: string | undefined,
  /**
   * What the ask reads and runs: core's CLI hands in its own — the verifier, so what a release declares is read from
   * its verified tarball — or a test's stand-ins. A channel's child has nothing to verify with, and hands in none.
   */
  options: { deps?: UpdateDeps | undefined } = {},
): Promise<void> {
  if (claimedAt === undefined || !Number.isFinite(Date.parse(claimedAt))) {
    throw new CommsError('USAGE', `${UPDATE_CHECK_CHILD_COMMAND} takes the time of the claim it asks under`, {
      hint: handoffSentence(
        requireHandoffs(core).core(['update', '--check']),
        (command) => `Nothing runs this but a command finishing the day’s update check; ${command} asks now.`,
      ),
    });
  }
  try {
    if ((await readUpdateCheck(core.paths.stateDir)).checking === claimedAt) {
      await askUnderClaim(core, env, claimedAt, options.deps !== undefined ? { deps: options.deps } : {});
    }
  } finally {
    settled();
  }
}

/** Tells the command that started this child the ask is over, if it is still listening, and closes the channel. */
function settled(): void {
  if (!process.send || !process.connected) return;
  // With a callback, a channel the command closed meanwhile is an error handed to it, not one thrown.
  process.send({ type: 'settled' }, undefined, {}, () => {
    if (process.connected) process.disconnect();
  });
}

/**
 * What a command at a terminal hands the update notice (`updateNoticeAtTerminal`): the check.
 *
 * Every command but WhatsApp's is given it. WhatsApp's is given none, and reads the file as it is.
 */
export function terminalUpdateHooks(
  core: Core,
  env: NodeJS.ProcessEnv,
  options: {
    /** Stand-ins for the registry and `npm ls`, for a test: the check is then asked in this process. */
    deps?: UpdateDeps | undefined;
    now?: (() => Date) | undefined;
    /**
     * How to start the child the check is handed to: this CLI, found from the running script, when left out. For a
     * test, one that cannot be started, or null for none, and the check is asked in this process instead.
     */
    childEntry?: UpdateCheckChildEntry | null | undefined;
    /**
     * Verifies what a release declares before the check counts it: core's CLI hands in its own. A channel's has none,
     * and what it reads of a release's manifest counts for nothing.
     */
    verifyRelease?: ReleaseVerifier | undefined;
    /**
     * A channel's command: the check handed to core's CLI at this channel's own version, which verifies (design
     * 2026-10-22, P2), before the channel's own child. Core's command gives none.
     */
    handOff?: CoreHandOff | undefined;
  } = {},
): TerminalUpdateHooks {
  return {
    check: async () => {
      // A child could not be handed a test's stand-ins: with them, the check is asked here, as it always was.
      if (options.deps !== undefined) {
        await checkForUpdates(core, env, { deps: options.deps, now: options.now });
        return;
      }
      await handUpdateCheckToChild(core, env, {
        now: options.now,
        entry: options.childEntry,
        verifyRelease: options.verifyRelease,
        handOff: options.handOff,
      });
    },
  };
}
