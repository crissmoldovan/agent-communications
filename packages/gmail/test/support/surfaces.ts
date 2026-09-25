import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../../src/cli/program.ts';
import { createGmailMcpServer } from '../../src/mcp/server.ts';
import type { Harness } from './harness.ts';

/*
 * Both surfaces, driven the way a person and an agent drive them, for the tests that hold a tool to the command it
 * mirrors: an MCP client talking to the server over an in-memory pair, and the CLI run in-process with streams that
 * can be a terminal or not.
 */

export interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

export interface Connected {
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  names: () => Promise<string[]>;
  close: () => Promise<void>;
}

/** Connects an SDK client to a Gmail server, over the same messages a stdio client would exchange. */
export async function connect(options: Parameters<typeof createGmailMcpServer>[0]): Promise<Connected> {
  const built = await createGmailMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as ToolResult,
    names: async () => (await client.listTools()).tools.map((tool) => tool.name).sort(),
    close: async () => {
      await client.close();
      await built.close();
    },
  };
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  envelope: <T>() => Envelope<T>;
}

/**
 * Runs the CLI in-process. With `answer`, a person at the terminal answers the first question it asks: `yes` under
 * the `chat` change policy, and the code the approval store issued under `confirm` — read back off the prompt, since
 * it is invented per run.
 *
 * With `replies`, each reply is typed once its prompt has appeared, in order. A plain prompt reads whatever is waiting
 * on standard input, so answers written up front are all swallowed by the first question.
 *
 * Standard input stays open unless `endStdin` is set, because a person typing answers keeps it open. An agent's shell
 * is the other case: its standard input has usually ended before the command starts (or was never a terminal at
 * all), and a command that reads it then must not mistake "nothing" for an answer — nor wait for more.
 */
export async function cli(
  harness: Harness,
  argv: string[],
  options: {
    tty?: boolean;
    answer?: boolean;
    stdin?: string;
    endStdin?: boolean;
    env?: NodeJS.ProcessEnv;
    replies?: ReadonlyArray<readonly [RegExp, string]>;
  } = {},
): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  const input = new PassThrough();
  if (options.endStdin) input.end(options.stdin ?? '');
  else if (options.stdin !== undefined) input.write(options.stdin);
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  let answered = false;
  let replied = 0;
  let seen = 0;
  err.on('data', (chunk) => {
    stderr += String(chunk);
    for (const replies = options.replies ?? []; replied < replies.length; ) {
      const [prompt, reply] = replies[replied] as readonly [RegExp, string];
      const found = prompt.exec(stderr.slice(seen));
      if (!found) break;
      seen += found.index + found[0].length;
      replied += 1;
      input.write(`${reply}\n`);
    }
    if (options.answer && !answered) {
      const asked = /Type (\S+) to (?:apply this change|approve this change|confirm)/.exec(stderr);
      if (asked) {
        answered = true;
        input.write(`${asked[1]}\n`);
      }
    }
  });
  const tty = options.tty ?? false;
  const code = await run(argv, {
    core: harness.core,
    env: { ...harness.env, ...options.env },
    streams: {
      stdout: Object.assign(out, { isTTY: tty }),
      stderr: Object.assign(err, { isTTY: tty }),
      stdin: Object.assign(input, { isTTY: tty }),
    },
  });
  return { code, stdout, stderr, envelope: <T>() => JSON.parse(stdout) as Envelope<T> };
}

/** The approval id a command that stopped for approval handed back, asserting that is what it did. */
export function pendingApproval(run: CliRun): string {
  assert.equal(run.code, 10, `expected the command to wait for approval: ${run.stdout}${run.stderr}`);
  const error = run.envelope().error;
  assert.equal(error?.code, 'APPROVAL_PENDING', run.stdout);
  const id = error?.details?.approvalId;
  assert.equal(typeof id, 'string', run.stdout);
  return String(id);
}

/**
 * A changing command as an agent runs it under the `chat` change policy: once to prepare the change, and again with
 * `--approval <id>` once the person has said yes. A command that needed no approval is returned from the first run.
 */
export async function approving(harness: Harness, argv: string[]): Promise<CliRun> {
  const first = await cli(harness, [...argv, '--json']);
  if (first.code !== 10 || first.envelope().error?.code !== 'APPROVAL_PENDING') return first;
  return cli(harness, [...argv, '--json', '--approval', pendingApproval(first)]);
}

/**
 * A tool's result as a client receives it: JSON, so a key whose value is `undefined` is not there at all, exactly as
 * it is not in the CLI's envelope. The in-memory transport hands the object over as it was built.
 */
export function wire(result: ToolResult): Record<string, unknown> {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(JSON.stringify(result.structuredContent)) as Record<string, unknown>;
}

/** The error a tool returned, as the envelope's `error` is shaped. */
export function toolError(result: ToolResult): { code: string; message: string; hint: string | null } {
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent?.error as { code: string; message: string; hint: string | null };
}

/** A tool's answer when it stopped for approval: the id and preview, asserting that is what it did. */
export function approvalAsked(result: ToolResult): {
  approvalId: string;
  policy: string;
  preview: string;
  next: string;
} {
  const body = wire(result);
  assert.equal(body.applied, false, JSON.stringify(body));
  assert.equal(body.approvalRequired, true, JSON.stringify(body));
  return {
    approvalId: String(body.approvalId),
    policy: String(body.policy),
    preview: String(body.preview),
    next: String(body.next),
  };
}

/** What a tool did, asserting it was applied. */
export function applied<T = Record<string, unknown>>(result: ToolResult): T {
  const body = wire(result);
  assert.equal(body.applied, true, JSON.stringify(body));
  return body.result as T;
}
