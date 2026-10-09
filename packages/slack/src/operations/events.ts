import type { PathOverrides } from '@agentcomms/core';
import { CommsError } from '@agentcomms/core';
import { callSlack, type SlackResponse } from '../api/call.ts';
import type { FetchLike } from '../api/guard.ts';
import { SlackContext } from '../context.ts';
import { readMessage } from '../text/message.ts';
import { openWorkspace, type SessionDeps } from './session.ts';

type Raw = Record<string, unknown>;

/** A Slack timestamp is an opaque exact decimal, never a JavaScript number. */
const SLACK_TIMESTAMP = /^[0-9]+\.[0-9]{6}$/u;

export interface SlackEventMessage {
  readonly ts: string;
  readonly threadTs: string | null;
  readonly text: string;
  readonly truncated: boolean;
  readonly mismatch: boolean;
  readonly unrenderable: boolean;
  readonly author: {
    readonly userId?: string | undefined;
    readonly botId?: string | undefined;
    readonly name: string | null;
    readonly app: boolean;
    readonly external: boolean;
  };
  readonly editedTs: string | null;
  readonly replyCount: number;
  readonly mentions: readonly {
    readonly kind: 'user' | 'channel' | 'usergroup';
    readonly id: string;
    readonly label: string | null;
  }[];
  readonly files: readonly { readonly id: string; readonly name: string | null; readonly mimeType: string | null }[];
}

export interface SlackEventPage {
  readonly messages: readonly SlackEventMessage[];
  readonly nextCursor: string | null;
  /** Slack alone reports a retained-history boundary. An ordinary empty page is never one. */
  readonly retainedHistoryBoundary: boolean;
}

export interface SlackEventConversation {
  readonly id: string;
  readonly name: string | null;
  readonly kind: 'public_channel' | 'private_channel' | 'im' | 'mpim';
}

export interface SlackEventSource {
  readonly accountId: string;
  /** The configured workspace alias, never a provider id substituted as a display name. */
  readonly accountAlias: string;
  readonly workspaceId: string;
  conversation(input: Readonly<{ conversationId: string }>): Promise<SlackEventConversation>;
  history(
    input: Readonly<{
      conversationId: string;
      oldest: string;
      latest: string;
      cursor?: string | undefined;
      limit?: number | undefined;
    }>,
  ): Promise<SlackEventPage>;
  replies(
    input: Readonly<{
      conversationId: string;
      parentTs: string;
      latest: string;
      cursor?: string | undefined;
      limit?: number | undefined;
    }>,
  ): Promise<SlackEventPage>;
}

export interface SlackEventSourceOptions {
  /** The injected inner fetch used by package tests; production uses the context's standard guarded transport. */
  readonly fetch?: FetchLike | undefined;
  readonly baseUrl?: string | undefined;
}

function timestamp(value: string, field: string): string {
  if (!SLACK_TIMESTAMP.test(value)) throw new CommsError('BAD_DATA', `the Slack ${field} is not an exact timestamp`);
  return value;
}

/** Exact decimal comparison for Slack's six-digit timestamp grammar. */
export function compareSlackTimestamps(left: string, right: string): -1 | 0 | 1 {
  const a = timestamp(left, 'timestamp');
  const b = timestamp(right, 'timestamp');
  const [aSeconds, aMicros] = a.split('.') as [string, string];
  const [bSeconds, bMicros] = b.split('.') as [string, string];
  const aInteger = aSeconds.replace(/^0+(?=\d)/u, '');
  const bInteger = bSeconds.replace(/^0+(?=\d)/u, '');
  if (aInteger.length !== bInteger.length) return aInteger.length < bInteger.length ? -1 : 1;
  if (aInteger !== bInteger) return aInteger < bInteger ? -1 : 1;
  if (aMicros === bMicros) return 0;
  return aMicros < bMicros ? -1 : 1;
}

function raws(value: unknown): readonly Raw[] {
  return Array.isArray(value)
    ? value.filter((item): item is Raw => typeof item === 'object' && item !== null && !Array.isArray(item))
    : [];
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function cursorOf(response: SlackResponse): string | null {
  const cursor = response.response_metadata?.next_cursor;
  return typeof cursor === 'string' && cursor !== '' ? cursor : null;
}

function conversation(response: SlackResponse, expectedId: string): SlackEventConversation {
  const value = response.channel;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CommsError('BAD_DATA', 'Slack conversation metadata is missing');
  const raw = value as Raw;
  const id = string(raw.id);
  if (id === undefined || id !== expectedId)
    throw new CommsError('BAD_DATA', 'Slack conversation metadata has a different id');
  const kind =
    raw.is_im === true
      ? 'im'
      : raw.is_mpim === true
        ? 'mpim'
        : raw.is_private === true
          ? 'private_channel'
          : 'public_channel';
  return { id, name: string(raw.name) ?? null, kind };
}

/** Converts one provider object into the channel package's tainted, typed event fact. */
export function normaliseSlackEventMessage(raw: Raw, accountName: string, workspaceId: string): SlackEventMessage {
  const ts = timestamp(string(raw.ts) ?? '', 'message timestamp');
  const threadTs = string(raw.thread_ts);
  if (threadTs !== undefined) timestamp(threadTs, 'thread timestamp');
  const seen = readMessage(raw, { accountName, ourTeamId: workspaceId });
  // `readMessage` makes the one model-facing envelope. The daemon receives this envelope, never the provider's
  // bare text; a later event mapper can select documented fields while retaining their taint provenance.
  const references = [...seen.references, ...seen.fallbackReferences];
  const mentionKeys = new Set<string>();
  const mentions: SlackEventMessage['mentions'][number][] = [];
  for (const reference of references) {
    if (reference.kind !== 'user' && reference.kind !== 'channel' && reference.kind !== 'usergroup') continue;
    if (reference.id === '') continue;
    const label = reference.label ?? null;
    const key = `${reference.kind}\u0000${reference.id}\u0000${label ?? ''}`;
    if (mentionKeys.has(key)) continue;
    mentionKeys.add(key);
    mentions.push({ kind: reference.kind, id: reference.id, label });
  }
  const authorName = seen.attribution.app
    ? (seen.attribution.appName?.text ?? seen.attribution.chosenName?.text ?? null)
    : (seen.attribution.chosenName?.text ?? null);
  return {
    ts,
    threadTs: threadTs ?? null,
    text: seen.enveloped,
    truncated: seen.truncated,
    mismatch: seen.mismatch,
    unrenderable: seen.unrenderable,
    author: {
      ...(seen.attribution.userId === undefined ? {} : { userId: seen.attribution.userId }),
      ...(seen.attribution.botId === undefined ? {} : { botId: seen.attribution.botId }),
      name: authorName,
      app: seen.attribution.app,
      external: seen.attribution.external,
    },
    editedTs: seen.editedTs === undefined ? null : timestamp(seen.editedTs, 'edited timestamp'),
    replyCount: seen.replyCount ?? 0,
    mentions,
    files:
      seen.files
        ?.filter((file) => file.id !== '')
        .map((file) => ({ id: file.id, name: file.name?.text ?? null, mimeType: file.mimetype ?? null })) ?? [],
  };
}

function page(response: SlackResponse, accountName: string, workspaceId: string): SlackEventPage {
  return {
    messages: raws(response.messages).map((message) => normaliseSlackEventMessage(message, accountName, workspaceId)),
    nextCursor: cursorOf(response),
    retainedHistoryBoundary: response.is_limited === true,
  };
}

/**
 * Opens the package's narrow read-only event boundary. It deliberately exposes only the two conversations methods
 * the daemon needs; no caller gets a provider client or a write-capable route.
 */
export async function openSlackEventSource(
  context: SlackContext,
  alias: string,
  options: SlackEventSourceOptions = {},
): Promise<SlackEventSource> {
  const session = await openWorkspace(context, alias, {
    fetch: options.fetch ?? context.fetch,
    baseUrl: options.baseUrl ?? context.slackBaseUrl,
  } satisfies SessionDeps);
  const eventPage = async (
    method: 'conversations.history' | 'conversations.replies',
    params: Record<string, string | number | boolean | undefined>,
  ): Promise<SlackEventPage> => page(await callSlack(session.call, method, params), session.name, session.teamId);
  const limit = (value: number | undefined): number => {
    const selected = value ?? 100;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > 200)
      throw new CommsError('BAD_DATA', 'the Slack event page limit must be between 1 and 200');
    return selected;
  };
  return {
    accountId: session.accountId,
    accountAlias: alias,
    workspaceId: session.teamId,
    conversation: async ({ conversationId }) =>
      conversation(await callSlack(session.call, 'conversations.info', { channel: conversationId }), conversationId),
    history: (input) =>
      eventPage('conversations.history', {
        channel: input.conversationId,
        oldest: timestamp(input.oldest, 'history oldest timestamp'),
        latest: timestamp(input.latest, 'history latest timestamp'),
        inclusive: true,
        cursor: input.cursor,
        limit: limit(input.limit),
      }),
    replies: async (input) => {
      const result = await eventPage('conversations.replies', {
        channel: input.conversationId,
        ts: timestamp(input.parentTs, 'reply parent timestamp'),
        latest: timestamp(input.latest, 'reply latest timestamp'),
        inclusive: true,
        cursor: input.cursor,
        limit: limit(input.limit),
      });
      // Slack returns the parent on the first page. It is a top-level occurrence, never a reply occurrence.
      return { ...result, messages: result.messages.filter((message) => message.ts !== input.parentTs) };
    },
  };
}

/** Opens Slack's own guarded read context for the held local event owner; no provider client escapes this operation. */
export async function openSlackEventSourceForPaths(
  input: Readonly<{
    alias: string;
    pathOverrides: PathOverrides;
  }>,
): Promise<SlackEventSource> {
  return openSlackEventSource(new SlackContext({ pathOverrides: input.pathOverrides }), input.alias);
}
