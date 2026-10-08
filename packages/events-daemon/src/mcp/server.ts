import { McpServer } from '@modelcontextprotocol/server';
import { disableAll } from '../operations/disable-all.ts';
import { doctor } from '../operations/doctor.ts';
import { enableAll } from '../operations/enable-all.ts';
import { pause, resume } from '../operations/pause.ts';
import { status } from '../operations/status.ts';
import { stop } from '../operations/stop.ts';

export interface EventsMcpServer {
  readonly server: McpServer;
  connectStdio(): Promise<void>;
}

export interface EventsMcpOptions {
  readonly stateDir?: string | undefined;
}

function reply(data: unknown) {
  const structured = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  return {
    structuredContent: structured,
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
  };
}

/** Creates the held local-event service's deliberately content-free MCP surface. */
export async function createEventsMcpServer(options: EventsMcpOptions = {}): Promise<EventsMcpServer> {
  const server = new McpServer({ name: 'agent-events', version: '0.14.1' });

  server.registerTool(
    'events_status',
    {
      title: 'Local event service status',
      description: 'Reports whether the local event service has an owner.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => reply(await status({ stateDir: options.stateDir })),
  );

  const runtimeTool = (
    name: string,
    title: string,
    description: string,
    operation: (options: EventsMcpOptions) => Promise<unknown>,
    annotations: { readonly destructiveHint: boolean; readonly idempotentHint: boolean },
  ) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {},
        annotations: { readOnlyHint: false, openWorldHint: false, ...annotations },
      },
      async () => reply(await operation(options)),
    );
  };

  runtimeTool('events_stop', 'Stop local event owner', 'Requests a clean stop from the local owner.', stop, {
    destructiveHint: true,
    idempotentHint: true,
  });
  runtimeTool(
    'events_pause',
    'Pause local event work',
    'Pauses polling, evaluation and delivery claims without purging state.',
    pause,
    {
      destructiveHint: false,
      idempotentHint: true,
    },
  );
  runtimeTool('events_resume', 'Resume local event work', 'Resumes work retained by an operational pause.', resume, {
    destructiveHint: false,
    idempotentHint: true,
  });
  runtimeTool(
    'events_disable_all',
    'Disable all local event work',
    'Disables collection, advances the global generation and purges B1 work.',
    disableAll,
    { destructiveHint: true, idempotentHint: true },
  );
  runtimeTool(
    'events_enable_all',
    'Prepare global enablement',
    'Reports that a standing disclosure approval is required before enablement.',
    enableAll,
    { destructiveHint: false, idempotentHint: true },
  );
  runtimeTool(
    'events_doctor',
    'Local event service doctor',
    'Reports content-free owner and protocol health.',
    doctor,
    {
      destructiveHint: false,
      idempotentHint: true,
    },
  );

  return {
    server,
    async connectStdio(): Promise<void> {
      const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      await server.connect(new StdioServerTransport());
    },
  };
}
