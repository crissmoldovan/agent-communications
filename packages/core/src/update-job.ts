import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import type { AuditLog } from './audit.ts';
import { CommsError } from './errors.ts';
import { replaceFileInPlace, writeFileAtomic } from './fs.ts';
import { launcherPaths } from './launcher.ts';
import { withFileLock } from './lock.ts';
import { nodeProgram } from './node-program.ts';
import { homeDirectory, homeForDiscovery } from './paths.ts';
import { absoluteSearchPath, childEnvironment, windowsSystemProgram } from './system-programs.ts';

/**
 * The per-user background update job (design 2026-10-16 U4; plan Track C): one writer per platform, each needing no
 * administrator, each running the stable core launcher with `update --background` once a day.
 *
 * - **macOS:** `~/Library/LaunchAgents/com.agentcomms.update.plist`, `StartCalendarInterval` at 10 and a minute chosen
 *   at random when it is set up, `RunAtLoad` false; loaded with `launchctl bootstrap gui/<uid>`, removed with
 *   `launchctl bootout gui/<uid>/com.agentcomms.update` and the file deleted. launchd starts a calendar job missed
 *   while the Mac slept at the next wake (launchd.plist(5)).
 * - **Linux:** `~/.config/systemd/user/agentcomms-update.service` and `.timer`, `OnCalendar=daily`, `Persistent=true`,
 *   `RandomizedDelaySec=1h`, enabled with `systemctl --user enable --now` (systemd.timer(5)).
 * - **Windows:** a task `agentcomms-update` of the person's own, daily at 10:00, `-RandomDelay 1h`,
 *   `-StartWhenAvailable`, `-AllowStartIfOnBatteries`, registered and unregistered through `Register-ScheduledTask` and
 *   `Unregister-ScheduledTask` without elevation.
 *
 * The job runs `<data>/launch/core` — Track B's stable launcher, `launcherPaths(dataDir, 'core').launcher` — with the
 * four folder pins every registration carries (CUE-403) and then `update --background`. A launchd or systemd job
 * starts with none of the shell's environment, so a folder chosen there (`AGENT_COMMS_CONFIG_DIR`, `XDG_CONFIG_HOME`)
 * would not reach it: pinned, the run reads exactly the installation that set it up.
 *
 * On Windows the launcher is a Node script with no extension (`launcher.ts`), which Task Scheduler cannot start: the
 * task's program is the Node the locator names (CUE-492), as a managed registration's is, and the launcher is its
 * first argument.
 *
 * Every command goes through a runner (`UpdateJobRunner`): the real one runs the system's own program, a test hands in
 * one that records. Nothing here is a change on its own — setting the job up is a change the person approves, in
 * `operations/update-job.ts` — and nothing here ever sends, posts or approves anything.
 *
 * **The record.** Setting it up writes `<state>/update-job.json`, holding `{ platform, installedAt, label }`, and
 * removing it deletes that file. Every background run adds `lastRun` to it (`recordUpdateJobRun`). Track A reads it
 * through `updateJobHealth`: the job counts as working only when it ran in the last 48 hours, or was set up less than 48
 * hours ago and has not had its first run yet. A job switched off in Login Items, a timer that never fires, a task the
 * scheduler cannot start all leave the record in place, and a record alone silenced every notice, the security line
 * included. Otherwise `auto` behaves as a daily check with a notice that offers the setup (U2). The record is also what
 * tells this installation's job from one another installation wrote at the same per-user place: the place is fixed,
 * the installations are not.
 */

/** macOS's launchd label, and the plist's name. */
export const UPDATE_JOB_LABEL = 'com.agentcomms.update';
/** The systemd units' and the Windows task's name. */
export const UPDATE_JOB_NAME = 'agentcomms-update';
/** The hour, local time, the job runs at on macOS and Windows. */
export const UPDATE_JOB_HOUR = 10;
/** The words the launcher is run with, after the folder pins. */
export const UPDATE_JOB_WORDS: readonly string[] = Object.freeze(['update', '--background']);

/** The platforms a background job is offered on. */
export type UpdateJobPlatform = 'darwin' | 'linux' | 'win32';

export function updateJobSupported(platform: NodeJS.Platform): platform is UpdateJobPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

/** What a command the job's setup runs answered: its exit status (non-zero when it could not be started) and output. */
export interface UpdateJobCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs one of the system's own programs — never a shell — and answers with what it said. */
export type UpdateJobRunner = (program: string, args: readonly string[]) => Promise<UpdateJobCommandResult>;

/** What a test, or a caller with reasons of its own, hands in instead of the real thing. */
export interface UpdateJobDeps {
  /** The runner every command goes through. The real one runs the program; a test's records it. */
  run?: UpdateJobRunner | undefined;
  /** The user whose launchd domain the macOS job is loaded into: `gui/<uid>`. */
  uid?: number | undefined;
  /** A number in [0, 1): the minute past 10 the macOS job runs at is chosen from it, once, as it is set up. */
  random?: (() => number) | undefined;
  /** The clock `installedAt` is read from. */
  now?: (() => Date) | undefined;
  /**
   * The Node the Windows task starts the launcher with: an absolute path. Left out, the one the locator names
   * (`nodeProgram`, CUE-492), as a managed registration's is.
   */
  node?: string | undefined;
  /** Where `systemctl` is looked for: `SYSTEMCTL_DIRECTORIES` unless a test hands in a folder of its own. */
  systemDirectories?: readonly string[] | undefined;
}

/** Everything one platform's writer needs, resolved once. */
export interface UpdateJobContext {
  platform: NodeJS.Platform;
  home: string;
  stateDir: string;
  /** The stable core launcher the job runs. */
  launcher: string;
  /** The Node the Windows task starts the launcher with: the task's program there. Unused elsewhere. */
  node: string;
  /** The folder pins every registration carries, in the installer's order, before `update --background`. */
  pins: readonly string[];
  /** Where `systemctl` is looked for, in order (`systemctlProgram`). */
  systemDirectories: readonly string[];
  env: NodeJS.ProcessEnv;
  run: UpdateJobRunner;
  uid: number;
  random: () => number;
  now: () => Date;
  /** Where a removal the job's own rules make — not the person's — is recorded. */
  audit?: Pick<AuditLog, 'append'> | undefined;
}

/** Core as the job needs it: its folders, and its audit log. */
export interface UpdateJobCore {
  paths: { configDir: string; stateDir: string; dataDir: string; secretsDir: string };
  audit?: Pick<AuditLog, 'append'> | undefined;
}

/** Track B's stable launcher for core, `<data>/launch/core`: what the job runs. */
export function coreLauncherPath(dataDir: string): string {
  return launcherPaths(dataDir, 'core').launcher;
}

export function updateJobContext(
  core: UpdateJobCore,
  env: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform | undefined;
    launcher?: string | undefined;
    deps?: UpdateJobDeps | undefined;
  } = {},
): UpdateJobContext {
  const platform = options.platform ?? process.platform;
  const deps = options.deps ?? {};
  const { configDir, stateDir, dataDir, secretsDir } = core.paths;
  const node = deps.node ?? (platform === 'win32' ? nodeProgram(env, platform) : process.execPath);
  if (!posix.isAbsolute(node) && !win32.isAbsolute(node)) {
    throw new CommsError(
      'CONFIG',
      `the background update job's Node has to be named by its full path, not ${JSON.stringify(node)}`,
    );
  }
  return {
    platform,
    home: homeForDiscovery(homeDirectory(env), "the background update job's launch agent", env),
    stateDir,
    launcher: options.launcher ?? coreLauncherPath(dataDir),
    node,
    pins: ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir],
    systemDirectories: deps.systemDirectories ?? SYSTEMCTL_DIRECTORIES,
    env,
    run: deps.run ?? systemRunner(env, platform),
    uid: deps.uid ?? process.getuid?.() ?? 0,
    random: deps.random ?? Math.random,
    now: deps.now ?? (() => new Date()),
    audit: core.audit,
  };
}

/**
 * What the job runs: the launcher, the folder pins, `update --background` — on Windows after the Node, which is the
 * task's program there: the launcher is a Node script with no extension, and Task Scheduler cannot start one.
 */
export function updateJobCommand(context: Pick<UpdateJobContext, 'platform' | 'node' | 'launcher' | 'pins'>): string[] {
  const words = [context.launcher, ...context.pins, ...UPDATE_JOB_WORDS];
  return context.platform === 'win32' ? [context.node, ...words] : words;
}

/** The real runner: the program by its path, no shell, a minute at most, its window hidden on Windows. */
function systemRunner(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): UpdateJobRunner {
  return (program, args) =>
    new Promise((resolve) => {
      execFile(
        program,
        [...args],
        {
          env: childEnvironment(env, platform),
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) return resolve({ status: 0, stdout, stderr });
          const status = typeof error.code === 'number' ? error.code : 1;
          resolve({ status, stdout: stdout ?? '', stderr: stderr || error.message });
        },
      );
    });
}

// ── The record ──────────────────────────────────────────────────────────────────────────────────────────────────

/** `<state>/update-job.json`: written when the job is set up, deleted when it is removed. */
export interface UpdateJobMarker {
  platform: UpdateJobPlatform;
  installedAt: string;
  /** The job's name on its platform: the launchd label, the systemd timer, the Windows task. */
  label: string;
  /** When a background run last ran, as an ISO time: what says the job works, not only that it was set up. */
  lastRun?: string | undefined;
}

export function updateJobMarkerPath(stateDir: string): string {
  return join(stateDir, 'update-job.json');
}

/** One write of the record at a time: its setup, its removal and every run's `lastRun`. */
function withMarkerLock<T>(stateDir: string, change: () => Promise<T>): Promise<T> {
  return withFileLock(join(stateDir, '.update-job.lock'), change, { timeoutMs: 5_000 });
}

const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** The record, or null when there is none — or none this release can read, which is treated as none. */
export async function readUpdateJobMarker(stateDir: string): Promise<UpdateJobMarker | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(updateJobMarkerPath(stateDir), 'utf8'));
  } catch {
    return null;
  }
  const record = parsed as Partial<UpdateJobMarker> | null;
  if (
    typeof record !== 'object' ||
    record === null ||
    !updateJobSupported(String(record.platform) as NodeJS.Platform) ||
    typeof record.installedAt !== 'string' ||
    typeof record.label !== 'string'
  ) {
    return null;
  }
  return {
    platform: record.platform as UpdateJobPlatform,
    installedAt: record.installedAt,
    label: record.label,
    ...(isTime(record.lastRun) ? { lastRun: record.lastRun } : {}),
  };
}

/** Whether this installation has set up its background job: the record is there. Not whether it works. */
export async function updateJobInstalled(core: { paths: { stateDir: string } }): Promise<boolean> {
  return (await readUpdateJobMarker(core.paths.stateDir)) !== null;
}

/**
 * How long a job may go without a run and still count as working: two days, so one missed day — a Mac asleep through
 * its hour, a laptop off for a day — is not a failure, and a job that never runs is found within two.
 */
export const UPDATE_JOB_SILENT_MS: number = 48 * 60 * 60 * 1000;

/** A few minutes either way, as two processes' clocks are read at slightly different moments. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function within(at: string | undefined, now: Date, intervalMs: number): boolean {
  if (at === undefined || !isTime(at)) return false;
  const since = now.getTime() - Date.parse(at);
  return since >= -CLOCK_SKEW_MS && since < intervalMs;
}

/** What the record says of the job: whether it works, and since when it has been silent when it does not. */
export interface UpdateJobHealth {
  marker: UpdateJobMarker;
  /**
   * It ran in the last 48 hours, or was set up less than 48 hours ago and has not had its first run yet. A time from
   * more than a few minutes in the future is not trusted.
   */
  working: boolean;
  /** When it last ran — or, never having run, when it was set up: what "has not run since" names. */
  since: string;
}

/** The job's health, from its record; null when there is none (`readUpdateJobMarker`). */
export async function updateJobHealth(stateDir: string, now: Date = new Date()): Promise<UpdateJobHealth | null> {
  const marker = await readUpdateJobMarker(stateDir);
  if (marker === null) return null;
  return {
    marker,
    working: within(marker.lastRun, now, UPDATE_JOB_SILENT_MS) || within(marker.installedAt, now, UPDATE_JOB_SILENT_MS),
    since: marker.lastRun ?? marker.installedAt,
  };
}

/**
 * Records that a background run ran, at `at`, on the job's record — when there is one: a run with no job set up, one a
 * person started by hand, writes none. Every run does, one that finds nothing to do included. Says whether it wrote.
 */
export async function recordUpdateJobRun(stateDir: string, at: Date): Promise<boolean> {
  // Nearly always read once and done with: no record, no lock, and no state folder made for one.
  if ((await readUpdateJobMarker(stateDir)) === null) return false;
  return withMarkerLock(stateDir, async () => {
    const marker = await readUpdateJobMarker(stateDir);
    if (marker === null) return false;
    await writeFileAtomic(
      updateJobMarkerPath(stateDir),
      `${JSON.stringify({ ...marker, lastRun: at.toISOString() }, null, 2)}\n`,
    );
    return true;
  });
}

function labelOf(platform: UpdateJobPlatform): string {
  return platform === 'darwin' ? UPDATE_JOB_LABEL : platform === 'linux' ? `${UPDATE_JOB_NAME}.timer` : UPDATE_JOB_NAME;
}

// ── macOS ───────────────────────────────────────────────────────────────────────────────────────────────────────

const LAUNCHCTL = '/bin/launchctl';

export function launchAgentPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${UPDATE_JOB_LABEL}.plist`);
}

function xmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function xmlUnescape(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** The LaunchAgent, exactly as this release writes it: hour 10, `minute`, never at load. */
export function launchAgentPlist(command: readonly string[], minute: number): string {
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new CommsError('UNEXPECTED', `${minute} is not a minute of the hour`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t<string>${UPDATE_JOB_LABEL}</string>`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...command.map((word) => `\t\t<string>${xmlText(word)}</string>`),
    '\t</array>',
    '\t<key>StartCalendarInterval</key>',
    '\t<dict>',
    '\t\t<key>Hour</key>',
    `\t\t<integer>${UPDATE_JOB_HOUR}</integer>`,
    '\t\t<key>Minute</key>',
    `\t\t<integer>${minute}</integer>`,
    '\t</dict>',
    '\t<key>RunAtLoad</key>',
    '\t<false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** What a plist at the job's place says of itself: its label, what it runs, its minute — read loosely, as anyone's. */
function readLaunchAgent(text: string): { label: string | null; command: string[]; minute: number | null } {
  const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '';
  const command = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => xmlUnescape(match[1] as string));
  const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1];
  return {
    label: label === undefined ? null : xmlUnescape(label),
    command,
    minute: minute === undefined ? null : Number(minute),
  };
}

/** Any C0 control — tab and line breaks among them — or DEL: never part of a path a job should be handed. */
function hasControlCharacter(word: string): boolean {
  for (const char of word) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// ── Linux ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where `systemctl` is looked for, in order: the system's own folders, never PATH — as `launchctl` is `/bin/launchctl`
 * and `ps` is `/bin/ps` or `/usr/bin/ps`. A name is looked up, and a lookup can reach the folder this was started from,
 * where a download may have saved a stranger's `systemctl`, which would then run with the person's rights.
 */
export const SYSTEMCTL_DIRECTORIES: readonly string[] = Object.freeze(['/usr/bin', '/bin']);

/** The first executable `systemctl` in `directories` — absolute folders only — or null when none holds one. */
export async function systemctlProgram(directories: readonly string[] = SYSTEMCTL_DIRECTORIES): Promise<string | null> {
  for (const directory of absoluteSearchPath(directories)) {
    const candidate = join(directory, 'systemctl');
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** `systemctl` for this context, or refused — before anything is written or run — when the system has none of its own. */
async function requireSystemctl(context: UpdateJobContext, removing = false): Promise<string> {
  const found = await systemctlProgram(context.systemDirectories);
  if (found !== null) return found;
  throw new CommsError(
    'CONFIG',
    `systemd's systemctl is not in ${context.systemDirectories.join(' or ')}, so ${removing ? 'the background update job was left as it is' : 'nothing was set up'}`,
    {
      hint: 'It is looked for only where the system keeps it, never through PATH. A systemd user session is what the background update job needs on Linux.',
    },
  );
}

const UNIT_HEADER = '# Written by agent-communications. Its update --background-job off removes it.';
const UNIT_DESCRIPTION = 'agent-communications: install verified releases in the background';

export function systemdUnitPaths(home: string): { service: string; timer: string } {
  const directory = join(home, '.config', 'systemd', 'user');
  return {
    service: join(directory, `${UPDATE_JOB_NAME}.service`),
    timer: join(directory, `${UPDATE_JOB_NAME}.timer`),
  };
}

/**
 * One word of `ExecStart=`, in double quotes: inside them systemd reads `\\` and `\"` as escapes, and everywhere it
 * expands `%` specifiers and `$` variables, so those are doubled (systemd.service(5), "Command lines").
 */
function systemdWord(word: string): string {
  if (hasControlCharacter(word)) {
    throw new CommsError(
      'CONFIG',
      `the background update job cannot run a path with a control character: ${JSON.stringify(word)}`,
    );
  }
  return `"${word.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`;
}

/** The words of an `ExecStart=` this release wrote, read back. Anything else reads as what it can be read as. */
function readSystemdWords(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    (match[1] as string).replace(/\\(.)/g, '$1').replaceAll('%%', '%').replaceAll('$$', '$'),
  );
}

/** The service, exactly as this release writes it: one run of `command`. */
export function systemdService(command: readonly string[]): string {
  return [
    UNIT_HEADER,
    '[Unit]',
    `Description=${UNIT_DESCRIPTION}`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${command.map(systemdWord).join(' ')}`,
    '',
  ].join('\n');
}

/** The timer, exactly as this release writes it: daily, caught up after a missed day, within an hour of midnight. */
export function systemdTimer(): string {
  return [
    UNIT_HEADER,
    '[Unit]',
    `Description=${UNIT_DESCRIPTION}, daily`,
    '',
    '[Timer]',
    'OnCalendar=daily',
    'Persistent=true',
    'RandomizedDelaySec=1h',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

// ── Windows ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A PowerShell single-quoted string: nothing inside is special but a single quote — the curly ones too — doubled. */
function powerShellLiteral(text: string): string {
  return `'${text.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

/**
 * One word of the task's `-Argument`, as the launcher's own parser (the C runtime's, Node's) splits a command line:
 * as it is when nothing in it needs quoting, else in double quotes with the backslashes before the closing one doubled.
 * A word holding what cmd.exe expands even inside quotes (`%`, `!`), a double quote, or a control character is refused
 * rather than quoted on a guess: a launcher that is a `.cmd` script reads its line through cmd.exe.
 */
function windowsWord(word: string): string {
  if (/["%!]/.test(word) || hasControlCharacter(word)) {
    throw new CommsError(
      'CONFIG',
      `the background update job cannot pass ${JSON.stringify(word)} on Windows: a double quote, % or ! is read by the command line before the launcher sees it`,
      { hint: 'Use folders whose paths have none of these, and set it up again.' },
    );
  }
  if (word !== '' && !/[\s&|<>^()]/.test(word)) return word;
  return `"${word.replace(/\\+$/, (slashes) => slashes + slashes)}"`;
}

const SCRIPT_START = "$ErrorActionPreference = 'Stop'";
const TASK = `-TaskPath '\\' -TaskName ${powerShellLiteral(UPDATE_JOB_NAME)}`;

/** The script that registers the task, exactly as this release writes it. `-Force` replaces this installation's own. */
export function windowsRegisterScript(command: readonly string[]): string {
  const [program = '', ...args] = command;
  return [
    SCRIPT_START,
    `$action = New-ScheduledTaskAction -Execute ${powerShellLiteral(program)} -Argument ${powerShellLiteral(args.map(windowsWord).join(' '))}`,
    `$trigger = New-ScheduledTaskTrigger -Daily -At '${UPDATE_JOB_HOUR}:00' -RandomDelay (New-TimeSpan -Hours 1)`,
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries',
    `Register-ScheduledTask ${TASK} -Description 'Installs verified agent-communications releases in the background. Its update --background-job off removes it.' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    '',
  ].join('\n');
}

export function windowsUnregisterScript(): string {
  return [SCRIPT_START, `Unregister-ScheduledTask ${TASK} -Confirm:$false`, ''].join('\n');
}

/** Asks the scheduler what the task runs: `null`, or its first action's program and arguments, as JSON. */
export function windowsQueryScript(): string {
  return [
    SCRIPT_START,
    `$task = Get-ScheduledTask ${TASK} -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) { [Console]::Out.Write('null') } else { $first = @($task.Actions)[0]; [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ execute = [string]$first.Execute; arguments = [string]$first.Arguments })) }",
    '',
  ].join('\n');
}

/** Windows PowerShell 5.1, by its full path under the Windows folder (`system-programs.ts`). */
function powerShell(context: UpdateJobContext): string {
  return windowsSystemProgram('WindowsPowerShell\\v1.0\\powershell.exe', context.env);
}

function runPowerShell(context: UpdateJobContext, script: string): Promise<UpdateJobCommandResult> {
  return context.run(powerShell(context), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]);
}

async function queryWindowsTask(context: UpdateJobContext): Promise<{ execute: string; arguments: string } | null> {
  const answer = await runPowerShell(context, windowsQueryScript());
  if (answer.status !== 0) throw commandFailed('the scheduler could not be asked about the task', answer);
  const text = answer.stdout.replace(/^﻿/, '').trim();
  const parsed = JSON.parse(text === '' ? 'null' : text) as { execute?: unknown; arguments?: unknown } | null;
  if (parsed === null) return null;
  return { execute: String(parsed.execute ?? ''), arguments: String(parsed.arguments ?? '') };
}

// ── What is there ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where the job stands:
 * - `not-set-up`: nothing at its place, and no record;
 * - `installed`: this installation's, exactly as this release writes it;
 * - `missing`: recorded as set up, and gone;
 * - `foreign`: something at its place that this installation did not write — another installation's, or a person's;
 * - `stale`: this installation's, but not what this release writes, its launcher gone, or its record lost.
 */
export type UpdateJobState = 'not-set-up' | 'installed' | 'missing' | 'foreign' | 'stale';

export interface UpdateJobInspection {
  state: UpdateJobState;
  platform: NodeJS.Platform;
  /** The job's file — the service, on Linux — or on Windows its task, as a person would look it up. */
  where: string;
  /** Every file it is made of: none on Windows. */
  files: string[];
  marker: UpdateJobMarker | null;
  /** Why it is foreign or stale, in words. */
  reason?: string | undefined;
  /** What a foreign job runs, as far as it could be read. */
  runs?: string | undefined;
  /** The macOS job's minute, read from its file. */
  minute?: number | undefined;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The first word of a task's arguments, as `windowsWord` writes one: in double quotes, or up to the first space. */
function firstWindowsWord(text: string): string {
  const quoted = /^"([^"]*)"/.exec(text);
  // `windowsWord` doubles the backslashes before a closing quote: halved again here.
  if (quoted) return (quoted[1] as string).replace(/\\+$/, (slashes) => slashes.slice(0, slashes.length / 2));
  return text.split(/\s/)[0] ?? '';
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Ours, and as it should be: `installed` — or `stale`, saying why not. The launcher it runs being there is part of
 * being as it should: a job running a launcher that has gone fails every day, and nobody sees it.
 */
async function oursAsItShould(
  context: UpdateJobContext,
  base: Omit<UpdateJobInspection, 'state'>,
  current: boolean,
): Promise<UpdateJobInspection> {
  if (!current) return { ...base, state: 'stale', reason: 'it is not what this release writes' };
  if (!(await exists(context.launcher))) {
    return { ...base, state: 'stale', reason: `the launcher it runs, ${context.launcher}, is not there` };
  }
  if (base.marker === null) return { ...base, state: 'stale', reason: 'this machine has no record of setting it up' };
  return { ...base, state: 'installed' };
}

/**
 * Where the job stands. Files are read on macOS and Linux; on Windows the scheduler is asked — through the runner —
 * always when `query` is `always`, and only when the job is recorded when it is `when-recorded`, so that a doctor on a
 * machine that never set one up starts no program at all.
 */
export async function inspectUpdateJob(
  context: UpdateJobContext,
  options: { query?: 'always' | 'when-recorded' } = {},
): Promise<UpdateJobInspection> {
  const marker = await readUpdateJobMarker(context.stateDir);
  const command = updateJobCommand(context);
  const { platform } = context;
  if (platform === 'darwin') {
    const where = launchAgentPath(context.home);
    const base = { platform, where, files: [where], marker };
    const text = await readText(where);
    if (text === null) return { ...base, state: marker === null ? 'not-set-up' : 'missing' };
    const read = readLaunchAgent(text);
    const minute = read.minute !== null && read.minute >= 0 && read.minute <= 59 ? read.minute : undefined;
    const runs = read.command.join(' ');
    if (read.label !== UPDATE_JOB_LABEL || (read.command[0] !== context.launcher && marker === null)) {
      return {
        ...base,
        state: 'foreign',
        runs,
        reason: read.label !== UPDATE_JOB_LABEL ? `its label is ${String(read.label)}` : `it runs ${runs}`,
      };
    }
    const current = minute !== undefined && text === launchAgentPlist(command, minute);
    return oursAsItShould(context, { ...base, minute }, current);
  }
  if (platform === 'linux') {
    const units = systemdUnitPaths(context.home);
    const base = { platform, where: units.service, files: [units.service, units.timer], marker };
    const [service, timer] = await Promise.all([readText(units.service), readText(units.timer)]);
    if (service === null && timer === null) return { ...base, state: marker === null ? 'not-set-up' : 'missing' };
    const execLine = /^ExecStart=(.*)$/m.exec(service ?? '')?.[1] ?? '';
    const words = readSystemdWords(execLine);
    const runs = words.length > 0 ? words.join(' ') : execLine;
    if (marker === null && (service === null || words[0] !== context.launcher)) {
      return {
        ...base,
        state: 'foreign',
        runs,
        reason: service === null ? 'it is a timer with no service' : `it runs ${runs}`,
      };
    }
    const current = service === systemdService(command) && timer === systemdTimer();
    return oursAsItShould(context, base, current);
  }
  if (platform === 'win32') {
    const where = `the task ${UPDATE_JOB_NAME} in Task Scheduler`;
    const base = { platform, where, files: [], marker };
    if (marker === null && options.query === 'when-recorded') return { ...base, state: 'not-set-up' };
    const task = await queryWindowsTask(context);
    if (task === null) return { ...base, state: marker === null ? 'not-set-up' : 'missing' };
    const runs = `${task.execute} ${task.arguments}`.trim();
    // Ours: a Node starting this launcher — or 0.20.0's task, which named the launcher as its program and never ran.
    const ours =
      samePath(firstWindowsWord(task.arguments), context.launcher, platform) ||
      samePath(task.execute, context.launcher, platform);
    if (!ours) {
      return marker === null
        ? { ...base, state: 'foreign', runs, reason: `it runs ${runs}` }
        : { ...base, state: 'stale', runs, reason: `it runs ${runs}` };
    }
    const [program = '', ...args] = command;
    return oursAsItShould(
      context,
      base,
      samePath(task.execute, program, platform) && task.arguments === args.map(windowsWord).join(' '),
    );
  }
  return { platform, where: '', files: [], marker, state: 'not-set-up' };
}

// ── Setting it up, and taking it away ───────────────────────────────────────────────────────────────────────────

export interface UpdateJobInstalled {
  platform: UpdateJobPlatform;
  label: string;
  where: string;
  files: string[];
  command: string[];
  /** The macOS job's minute past 10. */
  minute?: number | undefined;
}

/** A command the system refused, with the first lines of what it said. A removal's says the job was left as it was. */
function commandFailed(what: string, answer: UpdateJobCommandResult, removing = false): CommsError {
  const said = (answer.stderr || answer.stdout).trim().split(/\r?\n/).slice(0, 3).join(' ');
  return new CommsError('CONFIG', `${what} (exit ${answer.status})${said ? `: ${said}` : ''}`, {
    hint: removing
      ? 'The job was left as it is. Run the doctor to see where it stands, and try again.'
      : 'Nothing was left set up. Run the doctor to see where the job stands.',
  });
}

/** The macOS minute: the one the file already has when this installation is writing its own again, else at random. */
function minuteFor(context: UpdateJobContext, inspection: UpdateJobInspection): number {
  if (inspection.minute !== undefined && (inspection.state === 'stale' || inspection.state === 'installed')) {
    return inspection.minute;
  }
  return Math.min(59, Math.max(0, Math.floor(context.random() * 60)));
}

/**
 * Writes this platform's job, loads it, and records it. Refuses a place that holds a job this installation did not
 * write. A load the system refuses leaves no file and no record: nothing is half set up.
 */
export async function installUpdateJob(
  context: UpdateJobContext,
  inspection?: UpdateJobInspection,
): Promise<UpdateJobInstalled> {
  const { platform } = context;
  if (!updateJobSupported(platform)) {
    throw new CommsError('CONFIG', 'a background update job is offered on macOS, Linux and Windows only');
  }
  const seen = inspection ?? (await inspectUpdateJob(context, { query: 'always' }));
  if (seen.state === 'foreign') {
    throw new CommsError(
      'CONFIG',
      `nothing was set up: ${seen.where} is a job this installation did not write (${seen.reason})`,
    );
  }
  const command = updateJobCommand(context);
  const label = labelOf(platform);
  let minute: number | undefined;
  if (platform === 'darwin') {
    minute = minuteFor(context, seen);
    // This installation's own, loaded: unloaded first, since launchd refuses to bootstrap a label it already has.
    if (seen.state === 'stale' || seen.state === 'installed') await bootout(context, { tolerant: true });
    await replaceFileInPlace(seen.where, launchAgentPlist(command, minute));
    const loaded = await context.run(LAUNCHCTL, ['bootstrap', `gui/${context.uid}`, seen.where]);
    if (loaded.status !== 0) {
      await rm(seen.where, { force: true });
      throw commandFailed('launchd did not load the background update job', loaded);
    }
  } else if (platform === 'linux') {
    const systemctl = await requireSystemctl(context);
    const units = systemdUnitPaths(context.home);
    await replaceFileInPlace(units.service, systemdService(command));
    await replaceFileInPlace(units.timer, systemdTimer());
    for (const args of [
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', `${UPDATE_JOB_NAME}.timer`],
    ]) {
      const answer = await context.run(systemctl, args);
      if (answer.status !== 0) {
        await Promise.all([rm(units.service, { force: true }), rm(units.timer, { force: true })]);
        await context.run(systemctl, ['--user', 'daemon-reload']);
        throw commandFailed('systemd did not enable the background update timer', answer);
      }
    }
  } else {
    const script = windowsRegisterScript(command);
    const answer = await runPowerShell(context, script);
    if (answer.status !== 0) throw commandFailed('Task Scheduler did not register the background update task', answer);
  }
  const marker: UpdateJobMarker = { platform, installedAt: context.now().toISOString(), label };
  await withMarkerLock(context.stateDir, () =>
    writeFileAtomic(updateJobMarkerPath(context.stateDir), `${JSON.stringify(marker, null, 2)}\n`),
  );
  return {
    platform,
    label,
    where: seen.where,
    files: seen.files,
    command,
    ...(minute === undefined ? {} : { minute }),
  };
}

/** launchd's answer to a bootout of a label it does not have loaded: nothing to unload, which is not a failure. */
function notLoaded(answer: UpdateJobCommandResult): boolean {
  return answer.status === 3 || answer.status === 113 || /no such process|could not find/i.test(answer.stderr);
}

async function bootout(context: UpdateJobContext, options: { tolerant: boolean }): Promise<void> {
  const answer = await context.run(LAUNCHCTL, ['bootout', `gui/${context.uid}/${UPDATE_JOB_LABEL}`]);
  if (answer.status !== 0 && !options.tolerant && !notLoaded(answer)) {
    throw commandFailed('launchd did not unload the background update job; it was left as it is', answer, true);
  }
}

export interface UpdateJobRemoved {
  /** True when a job of this installation's, or its record, was taken away. */
  removed: boolean;
  where: string;
  /** The files deleted. */
  files: string[];
  /** A job at the place that this installation did not write, left as it is, and why it is not this one's. */
  foreign?: { where: string; reason: string } | undefined;
}

/**
 * Takes this installation's job away: unloads it, deletes its files and its record. A job at the place that this
 * installation did not write is left as it is, and said; its record, if any, is deleted all the same.
 */
export async function removeUpdateJob(
  context: UpdateJobContext,
  inspection?: UpdateJobInspection,
): Promise<UpdateJobRemoved> {
  const seen = inspection ?? (await inspectUpdateJob(context, { query: 'always' }));
  const forget = () =>
    withMarkerLock(context.stateDir, () => rm(updateJobMarkerPath(context.stateDir), { force: true }));
  if (seen.state === 'not-set-up') return { removed: false, where: seen.where, files: [] };
  if (seen.state === 'foreign') {
    await forget();
    return {
      removed: seen.marker !== null,
      where: seen.where,
      files: [],
      foreign: { where: seen.where, reason: seen.reason ?? 'it is not this installation’s' },
    };
  }
  const { platform } = context;
  const deleted: string[] = [];
  if (platform === 'darwin') {
    // Missing: the file is gone, and the label may still be loaded until the next login — unloaded, whatever it says.
    await bootout(context, { tolerant: seen.state === 'missing' });
    if (seen.state !== 'missing') {
      await rm(seen.where, { force: true });
      deleted.push(seen.where);
    }
  } else if (platform === 'linux') {
    const units = systemdUnitPaths(context.home);
    if (seen.state !== 'missing') {
      const systemctl = await requireSystemctl(context, true);
      const answer = await context.run(systemctl, ['--user', 'disable', '--now', `${UPDATE_JOB_NAME}.timer`]);
      if (answer.status !== 0 && !/not loaded|does not exist|no such file/i.test(answer.stderr)) {
        throw commandFailed('systemd did not disable the background update timer; it was left as it is', answer, true);
      }
      for (const file of [units.service, units.timer]) {
        if (await exists(file)) deleted.push(file);
        await rm(file, { force: true });
      }
      await context.run(systemctl, ['--user', 'daemon-reload']);
    }
  } else if (platform === 'win32' && seen.state !== 'missing') {
    const answer = await runPowerShell(context, windowsUnregisterScript());
    if (answer.status !== 0) {
      throw commandFailed(
        'Task Scheduler did not unregister the background update task; it was left as it is',
        answer,
        true,
      );
    }
  }
  await forget();
  return { removed: true, where: seen.where, files: deleted };
}

// ── What other tracks call ──────────────────────────────────────────────────────────────────────────────────────

/** The levels at which nothing installs in the background, so the job goes (U4): Track A's level change reads it. */
export const LEVELS_WITHOUT_JOB: readonly string[] = Object.freeze(['every-14-days', 'never']);

/**
 * The line a level change's preview carries when it takes the job away (U4), or null when there is no job of this
 * installation's to take. Asks the Windows scheduler only when a job is recorded.
 */
export async function updateJobRemovalEffect(context: UpdateJobContext): Promise<string | null> {
  const seen = await inspectUpdateJob(context, { query: 'when-recorded' });
  if (seen.state === 'not-set-up' || seen.state === 'foreign') return null;
  return `removes the background update job, ${seen.where}: at this level nothing installs in the background`;
}

/**
 * Step one of a background run, for this job (U5 step 1, U8; Review focus 5): an organisation profile that has since
 * turned background updates off stops the job. It removes the job, records why in the audit log, and hands back the
 * notice the next session shows. With background updates allowed it touches nothing.
 *
 * `background` is the profile's `updates.background`, as Track A's reader gives it: false when any profile here says so.
 */
export async function backgroundJobAtRun(
  context: UpdateJobContext,
  policy: { background: boolean },
): Promise<{ removed: boolean; notice: string | null }> {
  if (policy.background) return { removed: false, notice: null };
  const removed = await removeUpdateJob(context);
  if (!removed.removed) return { removed: false, notice: null };
  await context.audit?.append({
    inboxId: '',
    operation: 'update.job.removed',
    outcome: 'ok',
    surface: 'daemon',
    origin: 'daemon',
    reason: 'an organisation profile turned background updates off',
  });
  return {
    removed: true,
    notice:
      'An organisation profile on this machine turned background updates off, so the background update job was removed. Updates are still checked daily, and a notice says when one is out.',
  };
}
