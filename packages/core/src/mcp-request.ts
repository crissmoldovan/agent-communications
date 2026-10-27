import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClientInfo } from './activity.ts';

/**
 * Who an MCP request says it comes from, in both protocol eras (single-server design D7, and the spike's finding 3).
 *
 * On 2025-11-25 a client names itself once, in `initialize`, and the SDK keeps it: `getClientVersion()`. On 2026-07-28
 * there is no `initialize`: every request carries the client in its own envelope, `_meta` key
 * `io.modelcontextprotocol/clientInfo`, which the SDK lifts out to `ctx.mcpReq.envelope` — and under `serveStdio` it
 * never sets `getClientVersion()` at all. A server that read only the accessor saw no client on every modern request:
 * Gmail's approval form, offered only to a client the person chose to trust by its name, would vanish, and every
 * activity line would lose the client's name. So every server reads the request's envelope first, as the event service
 * does (`callerOf`), and the accessor after it.
 *
 * What a client says it is stays what it said, never proof of what it is (activity design §4.3).
 */

/** The envelope key a 2026-07-28 request names its client under. */
export const ENVELOPE_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

/** A `clientInfo` as a client sent it, kept only when it has a name: its name and, when it gave one, its version. */
function clientInfoOf(said: unknown): ClientInfo | undefined {
  if (typeof said !== 'object' || said === null) return undefined;
  const { name, version } = said as { readonly name?: unknown; readonly version?: unknown };
  if (typeof name !== 'string' || name === '') return undefined;
  return { name, ...(typeof version === 'string' ? { version } : {}) };
}

/** The client a request's own envelope names (2026-07-28), or undefined for a request that carries none. */
export function envelopeClient(ctx: unknown): ClientInfo | undefined {
  const envelope = (ctx as { readonly mcpReq?: { readonly envelope?: unknown } } | undefined)?.mcpReq?.envelope;
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  return clientInfoOf((envelope as Record<string, unknown>)[ENVELOPE_CLIENT_INFO]);
}

/**
 * The client a request comes from: its envelope's (2026-07-28) first, then what the client said on connecting
 * (`connected`, a server's `getClientVersion()`, 2025-11-25).
 */
export function requestClient(ctx: unknown, connected?: () => unknown): ClientInfo | undefined {
  return envelopeClient(ctx) ?? clientInfoOf(connected?.());
}

/** The tool call being handled, for code that runs inside it and is handed no context of its own. */
const TOOL_REQUEST = new AsyncLocalStorage<{ readonly client: ClientInfo | undefined }>();

/**
 * Runs a tool's handler with its request's client in scope, so the activity line the call records — written deep in an
 * operation that is handed no request context — names the client of this request (`toolRequestClient`). Every server's
 * tools are registered through `strictToolArguments`, which runs each handler this way.
 */
export function withToolRequest<T>(ctx: unknown, run: () => T): T {
  return TOOL_REQUEST.run({ client: envelopeClient(ctx) }, run);
}

/** The client the tool call being handled named in its own envelope, or undefined outside a call or for none. */
export function toolRequestClient(): ClientInfo | undefined {
  return TOOL_REQUEST.getStore()?.client;
}

/**
 * The `clientInfo` an activity context reads: the client of the tool call being handled, from its envelope, and the
 * one the client named on connecting where the call carried none.
 */
export function activityClient(connected: () => unknown): () => ClientInfo | undefined {
  return () => toolRequestClient() ?? clientInfoOf(connected());
}

/**
 * Resolves when this process's stdin ends: a client that closes the connection, or dies without closing it. A server
 * served by `serveStdio` waits on it, so the process does not outlive its client.
 */
export function stdinClosed(stdin: NodeJS.ReadableStream = process.stdin): Promise<void> {
  return new Promise<void>((resolve) => {
    stdin.once('end', () => resolve());
    stdin.once('close', () => resolve());
  });
}
