/**
 * A 2026-07-28 client written by hand, as `packages/events-daemon/test/support/raw-mcp.ts` is: the SDK's `Client`
 * refuses a `resultType: "task"` answer, which is exactly what the task tests read. Every request carries the
 * per-request envelope; `tasks` says whether it declares the tasks extension.
 */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const CLIENT_INFO = { name: 'claude-code', version: '2.1.310' };

export function envelope(tasks, clientInfo = CLIENT_INFO) {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': clientInfo,
    'io.modelcontextprotocol/clientCapabilities': tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {},
  };
}

export async function rawClient(transport, { clientInfo = CLIENT_INFO } = {}) {
  let next = 0;
  const waiters = new Map();
  const notifications = [];
  transport.onmessage = (message) => {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    } else notifications.push(message);
  };
  await transport.start();
  return {
    notifications,
    request(method, params = {}, { tasks = true } = {}) {
      next += 1;
      const id = next;
      const { _meta, ...rest } = params;
      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params: { ...rest, _meta: { ...envelope(tasks, clientInfo), ...(_meta ?? {}) } },
      };
      return new Promise((resolve) => {
        waiters.set(id, resolve);
        void transport.send(message);
      });
    },
    close: () => transport.close(),
  };
}
