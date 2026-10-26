import type { Transport } from '@modelcontextprotocol/server';

/**
 * A 2026-07-28 client written by hand, as the routing spike's probe was (2026-10-25): the SDK's client does not take a
 * `resultType: "task"` answer, which is exactly what these tests read. Every request carries the per-request envelope;
 * `tasks` says whether it declares the tasks extension.
 */

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

export interface RawMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface RawClient {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { readonly tasks?: boolean },
  ): Promise<RawMessage>;
  /** Every notification the server sent, in order. */
  readonly notifications: readonly RawMessage[];
  /** Every message either way, for a scan of what the window was told. */
  readonly wire: readonly string[];
  close(): Promise<void>;
}

export function envelope(tasks: boolean): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'lane-test-client', version: '0.0.1' },
    'io.modelcontextprotocol/clientCapabilities': tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {},
  };
}

export async function rawClient(transport: Transport): Promise<RawClient> {
  let next = 0;
  const waiters = new Map<number | string, (message: RawMessage) => void>();
  const notifications: RawMessage[] = [];
  const wire: string[] = [];
  transport.onmessage = (raw) => {
    const message = raw as unknown as RawMessage;
    wire.push(JSON.stringify(message));
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    } else notifications.push(message);
  };
  await transport.start();
  return {
    notifications,
    wire,
    request(method, params = {}, options = {}) {
      next += 1;
      const id = next;
      const { _meta, ...rest } = params as { _meta?: Record<string, unknown> };
      const message = {
        jsonrpc: '2.0' as const,
        id,
        method,
        params: { ...rest, _meta: { ...envelope(options.tasks ?? true), ...(_meta ?? {}) } },
      };
      wire.push(JSON.stringify(message));
      return new Promise<RawMessage>((resolve) => {
        waiters.set(id, resolve);
        void transport.send(message as never);
      });
    },
    close: () => transport.close(),
  };
}

/** The text of a tool result's first content block. */
export function resultText(message: RawMessage): string {
  const content = (message.result as { content?: readonly { text?: string }[] } | undefined)?.content;
  return content?.[0]?.text ?? '';
}
