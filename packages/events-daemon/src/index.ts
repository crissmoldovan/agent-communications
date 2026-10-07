/** Public entry for the held local event-emission service. */
export { createEventsMcpServer, type EventsMcpServer } from './mcp/server.ts';
export { type EventsDaemonStatus, status } from './operations/status.ts';
