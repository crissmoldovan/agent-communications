import { CONNECTION_ID_ENV, GATEWAY_PID_ENV } from '../../../src/connections.ts';
import { MCP_SERVER_MARKER } from '../../../src/mcp-marker.ts';

/**
 * Runs `body` with this process's environment as a part of the connection `id` has it — what its gateway sets for
 * every part: the connection's id, the gateway's pid, and the MCP server's mark (single-server design §4, D11) — or,
 * `gateway: false`, with the id alone, as any process could set it for itself. Every variable is put back after.
 */
export async function asPartOf<T>(
  id: string | undefined,
  body: () => Promise<T>,
  options: { gateway?: boolean } = {},
): Promise<T> {
  const names = [CONNECTION_ID_ENV, GATEWAY_PID_ENV, MCP_SERVER_MARKER] as const;
  const before = new Map(names.map((name) => [name, process.env[name]] as const));
  for (const name of names) delete process.env[name];
  if (id !== undefined) process.env[CONNECTION_ID_ENV] = id;
  if (id !== undefined && options.gateway !== false) {
    process.env[GATEWAY_PID_ENV] = String(process.ppid > 1 ? process.ppid : 4242);
    process.env[MCP_SERVER_MARKER] = 'core';
  }
  try {
    return await body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
