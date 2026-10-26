import { EventControlClient } from '../control/client.ts';
import type { MessageShowResultV1, MessagesListResultV1 } from '../domain/messages.ts';

/**
 * A story per message (0.32.0 spec §3.6): what happened to each message the event service observed. The person's read,
 * at a terminal or in the app, which runs the CLI with `--json`: no MCP tool reaches these, and the CLI refuses them
 * inside an MCP server's process (§4).
 */

type Options = { readonly stateDir?: string | undefined };

/** `messages list`'s arguments, as the CLI passes them: the owner parses them again and refuses anything else (64). */
export interface MessagesListFilters {
  /** Whole milliseconds since 1970: the oldest observation time to include. 30 days back by default. */
  readonly since?: number | undefined;
  /** Whole milliseconds since 1970, strictly before which to look, or the `next` an earlier page gave. */
  readonly before?: number | string | undefined;
  /** 1 to 500; 100 by default. */
  readonly limit?: number | undefined;
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Newest first: each observed message, its decisions, deliveries and queue item, and a cursor to the next page. */
export async function messagesList(filters: MessagesListFilters, options: Options = {}): Promise<MessagesListResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request(
    'messages-list',
    defined({ ...filters }),
  )) as MessagesListResultV1;
}

/** One message, by its event id, with every line of its queue item's history. */
export async function messageShow(eventId: string, options: Options = {}): Promise<MessageShowResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('message-show', {
    eventId,
  })) as MessageShowResultV1;
}
