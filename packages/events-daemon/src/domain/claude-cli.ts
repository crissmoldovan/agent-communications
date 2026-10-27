import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { CommsError } from '@agentcomms/core';
import { DESCRIBE_SYSTEM, type DescribePrompt } from './describe-brief.ts';

/**
 * Describe it on the person's own Claude subscription (workflows design §11.4): `claude`, on this Mac, signed in, run in
 * the CLI process the person started — never in the event service. One file pins how: where it is looked for, the flags
 * it is run with, its deadline and its output's cap.
 *
 * It runs by `execFile` at an absolute path, with no shell; in an empty, owner-only temporary folder that is removed
 * afterwards; with the prompt on stdin; and with no tools, no MCP servers, and as little of the person's own settings
 * and hooks as the CLI allows. The flags were read from `claude --help` of Claude Code 2.1.311 on 2026-10-27:
 *
 * - `-p` (`--print`) and `--output-format json`: one answer, as one JSON result, then exit;
 * - `--safe-mode`: CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and agents off, sign-in kept (`--bare`
 *   would also skip hooks, but reads no subscription sign-in, so it is not used);
 * - `--tools ""`: no built-in tool at all;
 * - `--strict-mcp-config` with `--mcp-config {"mcpServers":{}}`: no MCP server, whatever is configured elsewhere;
 * - `--permission-prompts none`: anything that would ask is denied;
 * - `--no-session-persistence`: nothing saved to resume;
 * - `--system-prompt`: Claude Code's own coding prompt replaced by Describe it's one line (`DESCRIBE_SYSTEM`); the
 *   brief, the grammar and the person's turn ride on stdin, so no word of the prompt is in its arguments.
 *
 * `--setting-sources` is not passed: an empty list is not one its help documents, and `--safe-mode` already turns the
 * person's customisations off. A CLI that refuses one of these flags says so, and the person is offered a key.
 */

/** The CLI these flags were read from, and when. */
export const CLAUDE_CLI_CHECKED: { readonly version: '2.1.311'; readonly readAt: '2026-10-27' } = Object.freeze({
  version: '2.1.311',
  readAt: '2026-10-27',
} as const);

/** Where `claude` is looked for after `PATH`: the home's own installs first, then Homebrew's and the system's. */
export const CLAUDE_CLI_CANDIDATES: readonly string[] = Object.freeze([
  '~/.claude/local/claude',
  '~/.local/bin/claude',
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
]);

/** The flags every call passes, before `--system-prompt` and its line. */
export const CLAUDE_CLI_FLAGS: readonly string[] = Object.freeze([
  '-p',
  '--output-format',
  'json',
  '--safe-mode',
  '--tools',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--permission-prompts',
  'none',
  '--no-session-persistence',
]);

/** One call's deadline, and the most its output may be (§11.4). */
export const CLAUDE_CLI_DEADLINE_MS = 120_000;
export const CLAUDE_CLI_MAX_OUTPUT_BYTES = 262_144;

/**
 * The variables `claude` keeps: what it needs to find its sign-in and run. Nothing of Agent Comms', and nothing that
 * would mark it an agent's shell.
 */
const KEPT_VARIABLES: readonly string[] = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'CLAUDE_CONFIG_DIR',
];

async function executable(path: string): Promise<boolean> {
  try {
    const found = await stat(path);
    if (!found.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `claude`'s absolute path: the first executable file named `claude` in `PATH`'s absolute folders, then in the
 * candidates; null when there is none. A relative `PATH` entry is passed over, so the current folder never chooses.
 */
export async function findClaude(env: NodeJS.ProcessEnv): Promise<string | null> {
  const home = typeof env.HOME === 'string' && isAbsolute(env.HOME) ? env.HOME : null;
  const folders = (env.PATH ?? '').split(delimiter).filter((folder) => folder !== '' && isAbsolute(folder));
  const candidates = [
    ...folders.map((folder) => join(folder, 'claude')),
    ...CLAUDE_CLI_CANDIDATES.flatMap((candidate) =>
      candidate.startsWith('~/') ? (home === null ? [] : [join(home, candidate.slice(2))]) : [candidate],
    ),
  ];
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  return null;
}

/** Why `claude` gave no draft, in closed words: never its own output, which could carry anything. */
export type ClaudeCliRefusal =
  | 'CLAUDE_DEADLINE_EXCEEDED'
  | 'CLAUDE_RESPONSE_TOO_LARGE'
  | 'CLAUDE_FLAG_REFUSED'
  | 'CLAUDE_FAILED'
  | 'CLAUDE_RESPONSE_MALFORMED'
  | 'CLAUDE_REFUSED';

function refused(reason: ClaudeCliRefusal): never {
  const flags = reason === 'CLAUDE_FLAG_REFUSED';
  throw new CommsError(
    'PROVIDER_UNAVAILABLE',
    flags
      ? 'this Claude Code does not take the flags Describe it runs it with, which turn its tools, MCP servers and hooks off'
      : reason === 'CLAUDE_DEADLINE_EXCEEDED'
        ? 'Claude did not answer within 120 seconds'
        : reason === 'CLAUDE_RESPONSE_TOO_LARGE'
          ? 'Claude’s answer was larger than 256 KB'
          : 'Claude gave no draft',
    {
      details: { reason },
      hint: flags
        ? 'Update Claude Code, or describe it with a key kept for Analyse: --provider openrouter or --provider anthropic.'
        : 'Try again, or describe it with a key kept for Analyse: --provider openrouter or --provider anthropic.',
    },
  );
}

/** The model's text and name from `claude -p --output-format json`'s one result. */
export function readClaudeOutput(stdout: string): { readonly text: string; readonly model: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return refused('CLAUDE_RESPONSE_MALFORMED');
  }
  const result = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  if (result === null) return refused('CLAUDE_RESPONSE_MALFORMED');
  const fields = result as Readonly<Record<string, unknown>>;
  if (fields.type !== 'result') return refused('CLAUDE_RESPONSE_MALFORMED');
  if (fields.is_error === true || fields.subtype !== 'success') return refused('CLAUDE_REFUSED');
  if (typeof fields.result !== 'string') return refused('CLAUDE_RESPONSE_MALFORMED');
  const usage = fields.modelUsage;
  const models =
    typeof usage === 'object' && usage !== null && !Array.isArray(usage)
      ? Object.keys(usage).filter((name) => /^[A-Za-z0-9._:@/-]{1,128}$/u.test(name))
      : [];
  return { text: fields.result, model: models[0] ?? null };
}

/** What a call needs beside the prompt: the variables it may keep, and, for a test, a shorter deadline or cap. */
export interface ClaudeCliOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly deadlineMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

/**
 * Runs `claude` once at `path` (absolute), with the pinned flags and the prompt on stdin, in a new empty folder only
 * the person can read, which is removed afterwards whatever happens. Its answer is read from its one JSON result;
 * past the deadline it is killed, and an answer past the cap is refused.
 */
export async function runClaude(
  path: string,
  prompt: DescribePrompt,
  options: ClaudeCliOptions,
): Promise<{ readonly text: string; readonly model: string | null }> {
  if (!isAbsolute(path)) throw new TypeError('claude runs at an absolute path');
  const folder = await mkdtemp(join(tmpdir(), 'agentcomms-describe-'));
  try {
    // mkdtemp makes the folder the person's alone (0700); it holds nothing, so Claude sees no file of theirs.
    if ((await readdir(folder)).length !== 0) throw new TypeError('the describe folder is not empty');
    const env: NodeJS.ProcessEnv = {};
    for (const name of KEPT_VARIABLES) if (typeof options.env[name] === 'string') env[name] = options.env[name];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        path,
        [...CLAUDE_CLI_FLAGS, '--system-prompt', DESCRIBE_SYSTEM],
        {
          cwd: folder,
          env,
          shell: false,
          windowsHide: true,
          timeout: options.deadlineMs ?? CLAUDE_CLI_DEADLINE_MS,
          killSignal: 'SIGKILL',
          maxBuffer: options.maxOutputBytes ?? CLAUDE_CLI_MAX_OUTPUT_BYTES,
          encoding: 'utf8',
        },
        (error, out, err) => {
          if (error === null) {
            resolve(out);
            return;
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new Refusal('CLAUDE_RESPONSE_TOO_LARGE'));
          else if (failure.killed === true || failure.signal === 'SIGKILL')
            reject(new Refusal('CLAUDE_DEADLINE_EXCEEDED'));
          else if (/unknown option|unrecognized option|unexpected argument|invalid option/iu.test(String(err)))
            reject(new Refusal('CLAUDE_FLAG_REFUSED'));
          else reject(new Refusal('CLAUDE_FAILED'));
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(`${prompt.system}\n\n${prompt.user}`);
    }).catch((error: unknown) => {
      if (error instanceof Refusal) return refused(error.reason);
      throw error;
    });
    return readClaudeOutput(stdout);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

class Refusal extends Error {
  readonly reason: ClaudeCliRefusal;
  constructor(reason: ClaudeCliRefusal) {
    super(reason);
    this.reason = reason;
  }
}
