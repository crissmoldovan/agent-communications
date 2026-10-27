import { EventControlClient } from '../control/client.ts';
import type {
  LaneBindResultV1,
  LaneListForWindowV1,
  LaneListResultV1,
  LaneUnbindResultV1,
  LaneWindowIdentity,
} from '../domain/lanes.ts';
import type { LaneItemV1, LaneTaskV1, LaneWaitResultV1, LaneWhoamiV1 } from '../runtime/lanes.ts';

/**
 * Routing's lanes (routing design 2026-10-25, §3.7 and §6). `laneList`, `laneBind` and `laneUnbind` are the person's,
 * at a terminal or in the app; over MCP the event service's server passes the window it runs in as `caller`, and the
 * owner answers for that window alone (B4). The rest are an agent window's own and are reached only through that
 * server: who it is, its watch, its long-poll and its lane's items.
 */

interface Options {
  readonly stateDir?: string | undefined;
  /** The agent window asking, as the event service's MCP server works it out; absent for the person. */
  readonly caller?: LaneWindowIdentity | undefined;
}

function client(options: Options): EventControlClient {
  return new EventControlClient({ stateDir: options.stateDir });
}

function withCaller(args: Record<string, unknown>, options: Options): Record<string, unknown> {
  return options.caller === undefined ? args : { ...args, caller: options.caller };
}

/** Every lane, its rules, channels, open items and binding (the person); names and "bound to this window" (a window). */
export async function laneList(options: Options = {}): Promise<LaneListResultV1 | LaneListForWindowV1> {
  return (await client(options).request('lane-list', withCaller({}, options))) as
    | LaneListResultV1
    | LaneListForWindowV1;
}

/** Binds a lane to the window with this id: the person's act at a terminal (B1). */
export async function laneBind(lane: string, window: string, options: Options = {}): Promise<LaneBindResultV1> {
  return (await client(options).request('lane-bind', { lane, window })) as LaneBindResultV1;
}

/** Unbinds a lane at once: any lane for the person, only its own for a window. */
export async function laneUnbind(lane: string, options: Options = {}): Promise<LaneUnbindResultV1> {
  return (await client(options).request('lane-unbind', withCaller({ lane }, options))) as LaneUnbindResultV1;
}

/** This window, the id to bind it with, and its lane: content-free. */
export async function laneWhoami(options: Options & { readonly caller: LaneWindowIdentity }): Promise<LaneWhoamiV1> {
  return (await client(options).request('lane-whoami', withCaller({}, options))) as LaneWhoamiV1;
}

/** Makes a watch of this window's lane in the owner's task store. */
export async function laneWatch(
  lane: string,
  options: Options & { readonly caller: LaneWindowIdentity },
): Promise<LaneTaskV1> {
  return (await client(options).request('lane-watch', withCaller({ lane }, options))) as LaneTaskV1;
}

export async function laneTaskGet(
  taskId: string,
  options: Options & { readonly caller: LaneWindowIdentity },
): Promise<LaneTaskV1> {
  return (await client(options).request('lane-task-get', withCaller({ taskId }, options))) as LaneTaskV1;
}

export async function laneTaskCancel(
  taskId: string,
  options: Options & { readonly caller: LaneWindowIdentity },
): Promise<Record<string, never>> {
  return (await client(options).request('lane-task-cancel', withCaller({ taskId }, options))) as Record<string, never>;
}

/** Waits up to `seconds` (1–50) for this window's lane's next item. */
export async function laneWait(
  lane: string,
  seconds: number,
  options: Options & { readonly caller: LaneWindowIdentity; readonly signal?: AbortSignal | undefined },
): Promise<LaneWaitResultV1> {
  // The MCP request's signal: a client that cancels ends the wait in the owner too, which then takes no item.
  return (await client(options).request('lane-wait', withCaller({ lane, seconds }, options), {
    signal: options.signal,
  })) as LaneWaitResultV1;
}

/** One item of this window's lane, enveloped as `queue show` gives it. */
export async function laneItem(
  itemId: string,
  options: Options & { readonly caller: LaneWindowIdentity },
): Promise<{ readonly item: LaneItemV1 }> {
  return (await client(options).request('lane-item', withCaller({ itemId }, options))) as {
    readonly item: LaneItemV1;
  };
}
