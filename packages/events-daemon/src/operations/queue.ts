import { EventControlClient } from '../control/client.ts';
import type { LaneWindowIdentity } from '../domain/lanes.ts';
import type {
  QueueClearResultV1,
  QueueCountsResultV1,
  QueueItemsResultV1,
  QueueItemV1,
  QueueListResultV1,
  QueueStateChangeResultV1,
} from '../runtime/queue.ts';

/**
 * `caller` is the agent window an MCP call comes from, which the event service's MCP server passes: the owner then
 * leaves out every lane item that window is not bound to (routing design B4). The CLI and the app pass none.
 */
type Options = { readonly stateDir?: string | undefined; readonly caller?: LaneWindowIdentity | undefined };

function scoped(args: Record<string, unknown>, options: Options): Record<string, unknown> {
  return options.caller === undefined ? args : { ...args, caller: options.caller };
}

/** `queue list`'s filters, as the CLI passes them: the owner parses and refuses anything else (64). */
export interface QueueListFilters {
  readonly state?: string | undefined;
  readonly rule?: string | undefined;
  readonly channel?: string | undefined;
  readonly since?: string | undefined;
  readonly limit?: number | undefined;
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Item content, for a person at a terminal or in the app only: no MCP tool reaches this (action queue design Q1). */
export async function queueList(filters: QueueListFilters, options: Options = {}): Promise<QueueListResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request(
    'queue-list',
    defined({ ...filters }),
  )) as QueueListResultV1;
}

/** One item's content, for a person at a terminal or in the app only (Q1). */
export async function queueShow(itemId: string, options: Options = {}): Promise<{ readonly item: QueueItemV1 }> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('queue-show', { itemId })) as {
    readonly item: QueueItemV1;
  };
}

/** The content-free list an agent may read: ids, rules, channels, accounts, states and times, never content (Q5). */
export async function queueItems(
  filters: Omit<QueueListFilters, 'since'>,
  options: Options = {},
): Promise<QueueItemsResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request(
    'queue-items',
    scoped(defined({ ...filters }), options),
  )) as QueueItemsResultV1;
}

/** Content-free totals, for the app's badge and an agent's "is anything waiting". */
export async function queueCounts(options: Options = {}): Promise<QueueCountsResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request(
    'queue-counts',
    scoped({}, options),
  )) as QueueCountsResultV1;
}

export async function queueDone(itemId: string, options: Options = {}): Promise<QueueStateChangeResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request(
    'queue-done',
    scoped({ itemId }, options),
  )) as QueueStateChangeResultV1;
}

export async function queueDismiss(itemId: string, options: Options = {}): Promise<QueueStateChangeResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request(
    'queue-dismiss',
    scoped({ itemId }, options),
  )) as QueueStateChangeResultV1;
}

export async function queueReopen(itemId: string, options: Options = {}): Promise<QueueStateChangeResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request(
    'queue-reopen',
    scoped({ itemId }, options),
  )) as QueueStateChangeResultV1;
}

/** Purges done and dismissed items now; open items stay. */
export async function queueClear(options: Options = {}): Promise<QueueClearResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('queue-clear')) as QueueClearResultV1;
}
