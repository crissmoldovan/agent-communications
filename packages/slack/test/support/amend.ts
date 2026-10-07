import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AuditRecord, asV2, type CommsError } from '@agentcomms/core';
import { SlackContext } from '../../src/context.ts';
import { type Harness, newHarness } from './harness.ts';

/**
 * A workspace, a scripted Slack and a message of this account's in it — for the edit and deletion tests.
 *
 * Slack is a function standing in for `fetch`, as `reaction-outcome.test.ts` has one: it records each method with the
 * parameters it was sent, answers from a script a test can change mid-way, and never reaches the real Slack. The
 * message is this account's (`U0001`, the harness's user), in `C1`, at {@link TS} — a test lays fields over it.
 */

export const TS = '1700000000.000100';
/** A thread's parent, for a reply that lives only in its thread. */
export const PARENT_TS = '1699999990.000100';
export const WORDS = 'shipping in ten minuets';

/** What a scripted method returns to have the call fail as a dropped connection does: Slack may have acted. */
export const DROP: unique symbol = Symbol('drop the connection instead of answering');

export interface Asked {
  readonly method: string;
  readonly params: URLSearchParams;
}

export type Script = Record<string, (params: URLSearchParams) => unknown>;

/** A Slack reached through the injected transport: what it was asked, and a script a test can change mid-way. */
export interface ScriptedSlack {
  readonly script: Script;
  readonly asked: Asked[];
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** How many times `method` was asked. */
  count(method: string): number;
  /** Every method asked, in order. */
  methods(): string[];
}

export function scriptedSlack(script: Script): ScriptedSlack {
  const asked: Asked[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    const params = new URLSearchParams(String(init?.body ?? ''));
    asked.push({ method, params });
    const answer = script[method]?.(params) ?? { ok: false, error: 'unknown_method' };
    if (answer === DROP) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer));
  };
  return {
    script,
    asked,
    fetch,
    count: (method) => asked.filter((one) => one.method === method).length,
    methods: () => asked.map((one) => one.method),
  };
}

/** This account's message, as `conversations.history` returns it, with `over` laid on top. */
export function mine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'message', user: 'U0001', text: WORDS, ts: TS, ...over };
}

export interface AmendWorld {
  readonly harness: Harness;
  readonly fake: ScriptedSlack;
  readonly context: SlackContext;
  readonly slack: { fetch: ScriptedSlack['fetch'] };
  /** Replaces the message Slack holds at {@link TS}: in the channel itself, or — `inThread` — only in its thread. */
  setMessage(message: Record<string, unknown> | null, inThread?: boolean): void;
}

/**
 * A workspace that can edit and delete under `policy`, with this account's message in `#eng` (four members, joined),
 * and a Slack that accepts `chat.update` and `chat.delete`.
 */
export async function amendWorld(
  options: {
    policy?: 'chat' | 'confirm' | 'never';
    mode?: 'read' | 'send';
    grantedScopes?: readonly string[];
    message?: Record<string, unknown>;
    room?: Record<string, unknown>;
  } = {},
): Promise<AmendWorld> {
  const harness = await newHarness();
  await harness.addWorkspace({
    alias: 'acme',
    mode: options.mode ?? 'send',
    sendPolicy: options.policy ?? 'chat',
    ...(options.grantedScopes ? { grantedScopes: options.grantedScopes } : {}),
  });
  let message: Record<string, unknown> | null = mine(options.message);
  let threaded = false;
  const fake = scriptedSlack({
    'conversations.history': (params) => ({
      ok: true,
      messages: message !== null && !threaded && params.get('latest') === message.ts ? [message] : [],
    }),
    'conversations.replies': (params) =>
      message !== null && threaded && params.get('ts') === message.ts
        ? { ok: true, messages: [{ type: 'message', user: 'U0002', text: 'the parent', ts: PARENT_TS }, message] }
        : { ok: false, error: 'thread_not_found' },
    'conversations.info': () => ({
      ok: true,
      channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true, ...options.room },
    }),
    'chat.update': (params) => ({
      ok: true,
      channel: params.get('channel'),
      ts: params.get('ts'),
      text: params.get('text'),
    }),
    'chat.delete': (params) => ({ ok: true, channel: params.get('channel'), ts: params.get('ts') }),
  });
  const context = new SlackContext({ core: harness.core, env: harness.env, platform: 'darwin', surface: 'mcp' });
  return {
    harness,
    fake,
    context,
    slack: { fetch: fake.fetch },
    setMessage(next, inThread = false) {
      message = next;
      threaded = inThread;
    },
  };
}

/** A file under the harness's home, where the attachment jail lets a draft take it from. */
export function homeFile(harness: Harness, name: string, contents: string): string {
  const docs = join(harness.home, 'docs');
  mkdirSync(docs, { recursive: true });
  const path = join(docs, name);
  writeFileSync(path, contents);
  return realpathSync.native(path);
}

/** The audit records of one operation, oldest first. */
export async function audited(harness: Harness, operation: string): Promise<AuditRecord[]> {
  return (await harness.core.audit.tail({ limit: 50 })).filter((record) => record.operation === operation);
}

/** Where an approval stands in the store now. */
export async function stateOf(harness: Harness, approvalId: string): Promise<string | undefined> {
  return asV2(await harness.core.approvals.get(approvalId))?.state;
}

/** The error a promise rejects with — failing the test, with `what`, if it resolves. */
export async function refusal(work: Promise<unknown>, what: string): Promise<CommsError> {
  return work.then(
    (value) => {
      throw new Error(`${what}: it went through — ${JSON.stringify(value)}`);
    },
    (error: unknown) => error as CommsError,
  );
}
