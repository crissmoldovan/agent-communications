import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { truncateDisplay } from './render.ts';
import { STANDING_MAX_REPLY_LENGTH, type StandingAct } from './standing.ts';
import type { Notice, Notifier } from './standing-use.ts';
import { childEnvironment, notifierProgram } from './system-programs.ts';

/**
 * The notification on the person's screen for every standing act (design 2026-10-19-standing-approvals, S10 and §8
 * item 6). It is how a person learns what an agent sent without asking — never through the agent — so it is raised by
 * the operating system, best effort: a missing program, a failure or a timeout is said in the result, for the audit, and
 * never fails the act.
 *
 * The text — what was sent, where, under which standing approval — is never spliced into a script:
 * - macOS: `osascript` runs a fixed AppleScript whose run handler takes the body and the title as its arguments, after
 *   `--`, so that a text starting with `-e` is an argument and never another line of script;
 * - Linux: `notify-send` takes the title and the body as its arguments, after `--`;
 * - Windows: PowerShell runs a fixed toast script that reads them from two environment values, because `-Command`
 *   joins any argument after it into the script. The script puts each in a text node, so neither is read as XML.
 */

/** Starts `program` with `args` and `env`, as `execFile` does with no shell; rejects when it fails or takes too long. */
export type NoticeRunner = (program: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

/** How long a notification program may take before it is stopped, and the act carries on without it. */
export const NOTICE_TIMEOUT_MS = 5000;

/** Every notice's title. */
export const NOTICE_TITLE = 'agent-communications';

/** The environment values the Windows script reads the title and the body from. */
const TITLE_VARIABLE = 'AGENTCOMMS_NOTICE_TITLE';
const BODY_VARIABLE = 'AGENTCOMMS_NOTICE_BODY';

/** The fixed AppleScript, a line to each `-e`: it shows its run handler's first argument under its second. */
const DARWIN_SCRIPT: readonly string[] = Object.freeze([
  '-e',
  'on run argv',
  '-e',
  'display notification (item 1 of argv) with title (item 2 of argv)',
  '-e',
  'end run',
]);

/**
 * The fixed Windows toast script. It holds no double quote and no line break, so the command line Windows builds
 * around it is a plain pair of quotes; the AppUserModelID is Windows PowerShell's own, which every Windows has
 * registered, so the toast needs no shortcut of this package's.
 */
const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$text = $xml.GetElementsByTagName('text')",
  `$null = $text.Item(0).AppendChild($xml.CreateTextNode([string]$env:${TITLE_VARIABLE}))`,
  `$null = $text.Item(1).AppendChild($xml.CreateTextNode([string]$env:${BODY_VARIABLE}))`,
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
].join('; ');

/** The program each system raises a notice with, by the name a failure is said under. */
const PROGRAM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'osascript',
  linux: 'notify-send',
  win32: 'PowerShell',
};

/** `env` for Windows, with the notice's texts in it: any value already set under those names, in any case, replaced. */
function withNoticeText(env: NodeJS.ProcessEnv, notice: Notice): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(childEnvironment(env, 'win32'))) {
    const upper = key.toUpperCase();
    if (upper !== TITLE_VARIABLE && upper !== BODY_VARIABLE) out[key] = value;
  }
  out[TITLE_VARIABLE] = notice.title;
  out[BODY_VARIABLE] = notice.body;
  return out;
}

/** What `program` is started with to show `notice` on `platform`: the text an argument or an environment value. */
export function noticeCommand(
  notice: Notice,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  program: string,
): { program: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (platform === 'darwin') {
    return { program, args: [...DARWIN_SCRIPT, '--', notice.body, notice.title], env: childEnvironment(env, platform) };
  }
  if (platform === 'win32') {
    return {
      program,
      args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TOAST_SCRIPT],
      env: withNoticeText(env, notice),
    };
  }
  return { program, args: ['--', notice.title, notice.body], env: childEnvironment(env, platform) };
}

/** A file there that may be run: a lookup that never throws. */
async function executableFile(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real runner: `execFile`, no shell, stopped after `NOTICE_TIMEOUT_MS`. A backstop a second later settles it even
 * when the program was stopped but its output was held open by another, since `execFile` waits for that to close.
 */
function runNoticeProgram(program: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const backstop = setTimeout(
      () => reject(Object.assign(new Error('timed out'), { killed: true })),
      NOTICE_TIMEOUT_MS + 1000,
    );
    backstop.unref();
    try {
      execFile(
        program,
        [...args],
        { env, timeout: NOTICE_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, shell: false },
        (error) => {
          clearTimeout(backstop);
          if (error) reject(error);
          else resolve();
        },
      );
    } catch (error) {
      // Thrown rather than passed back: a program that could not be started at all.
      clearTimeout(backstop);
      reject(error);
    }
  });
}

/**
 * Why a notice was not raised, in a few words of this package's own: never the error's message, which holds the whole
 * command line and so the notice's text, and a code or signal only when it is one.
 */
function reasonOf(name: string, error: unknown): string {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
  };
  if (typeof failure.code === 'number' && Number.isInteger(failure.code)) {
    return `${name} ended with status ${failure.code}`;
  }
  if (typeof failure.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)) {
    return `${name} failed (${failure.code})`;
  }
  if (failure.killed === true) return `${name} took longer than ${NOTICE_TIMEOUT_MS / 1000} seconds and was stopped`;
  if (typeof failure.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(failure.signal)) {
    return `${name} was stopped (${failure.signal})`;
  }
  return `${name} failed`;
}

/**
 * A notifier for `platform`: it finds the program, starts it with the notice, and says whether it was raised. It never
 * throws — a missing program, a runner that throws or rejects, a timeout, even an environment that cannot be read, is
 * `{ raised: false, reason }`.
 */
export function makeNotifier(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run?: NoticeRunner;
  exists?: (path: string) => Promise<boolean>;
}): Notifier {
  const { platform, env } = options;
  const run = options.run ?? runNoticeProgram;
  const exists = options.exists ?? executableFile;
  const name = PROGRAM_NAMES[platform] ?? 'the notifier';
  return async (notice) => {
    try {
      const program = await notifierProgram(platform, env, exists);
      if (program === null) {
        return {
          raised: false,
          reason: platform === 'linux' ? 'no notify-send on PATH' : `no notifier on ${platform}`,
        };
      }
      const command = noticeCommand(notice, platform, env, program);
      await run(command.program, command.args, command.env);
      return { raised: true };
    } catch (error) {
      return { raised: false, reason: reasonOf(name, error) };
    }
  };
}

/**
 * The notice for one standing act: what was sent — `:name:` for a reaction, the reply in quotes — where, and under
 * which standing approval. Each part is flattened to one line with its invisible characters made visible, the place cut
 * to 80 characters.
 */
export function ackNotice(input: { act: StandingAct; text: string; place: string; standingId: string }): Notice {
  const text = truncateDisplay(input.text, STANDING_MAX_REPLY_LENGTH);
  const what = input.act === 'reaction' ? `:${text}:` : `"${text}"`;
  const place = truncateDisplay(input.place, 80);
  const id = truncateDisplay(input.standingId, 80);
  return { title: NOTICE_TITLE, body: `Your agent sent ${what} in ${place} (standing approval ${id})` };
}
