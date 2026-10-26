/**
 * The environment variable an MCP server sets in its own process at start, so every program it starts inherits it
 * (design 2026-10-26-owner-feedback-0320 §4): core's server, each channel's and the event service's
 * (`agent-events mcp`, which keeps its own copy of this name). A read that is the person's — `agentcomms activity
 * items`, the event service's queue, deliveries, dry runs and messages — refuses where it is set: no agent reaches it
 * through a server it drives. A shell an agent runs is the person's own and is not marked; no CLI gate could make that
 * true.
 */
export const MCP_SERVER_MARKER = 'AGENTCOMMS_MCP_SERVER';

/** Marks this process as the MCP server `name` — `core`, `gmail`, `slack` — for itself and every child it starts. */
export function markMcpServerProcess(env: NodeJS.ProcessEnv, name: string): void {
  env[MCP_SERVER_MARKER] = name;
}

/** The server whose process this is, or one started by it; undefined outside every MCP server. */
export function mcpServerOf(env: NodeJS.ProcessEnv): string | undefined {
  const marker = env[MCP_SERVER_MARKER];
  return marker === undefined || marker === '' ? undefined : marker;
}
