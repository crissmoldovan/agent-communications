import { McpServer } from '@modelcontextprotocol/server';
import { status } from '../operations/status.ts';

export interface EventsMcpServer {
  readonly server: McpServer;
  connectStdio(): Promise<void>;
}

function reply(data: unknown) {
  const structured = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  return {
    structuredContent: structured,
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
  };
}

/** Creates the held local-event service's deliberately content-free MCP surface. */
export async function createEventsMcpServer(): Promise<EventsMcpServer> {
  const server = new McpServer({ name: 'agent-events', version: '0.14.1' });

  server.registerTool(
    'events_status',
    {
      title: 'Local event service status',
      description: 'Reports whether the local event service has an owner.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => reply(await status()),
  );

  return {
    server,
    async connectStdio(): Promise<void> {
      const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      await server.connect(new StdioServerTransport());
    },
  };
}
