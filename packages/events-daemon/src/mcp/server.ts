import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { catalogueList, catalogueShow } from '../operations/catalogue.ts';
import { disableAll } from '../operations/disable-all.ts';
import { doctor } from '../operations/doctor.ts';
import { enableAll } from '../operations/enable-all.ts';
import { pause, resume } from '../operations/pause.ts';
import {
  createRule,
  disableRule,
  enableRule,
  removeRule,
  ruleShow,
  rulesList,
  updateRule,
} from '../operations/rules.ts';
import { sourceShow, sourcesList } from '../operations/sources.ts';
import { status } from '../operations/status.ts';
import { stop } from '../operations/stop.ts';
import { addTarget, removeTarget, targetsList, updateTarget } from '../operations/targets.ts';

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

  const controlTool = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodType>,
    operation: (args: Record<string, unknown>) => Promise<unknown>,
    destructiveHint = false,
  ) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema,
        annotations: {
          readOnlyHint: !destructiveHint,
          destructiveHint,
          idempotentHint: !destructiveHint,
          openWorldHint: false,
        },
      },
      async (args) => reply(await operation(args)),
    );
  };
  controlTool(
    'events_catalogue_list',
    'List local event catalogue',
    'Lists selectable local event definitions.',
    {},
    () => catalogueList(options),
  );
  controlTool(
    'events_catalogue_show',
    'Show local event definition',
    'Shows one selectable local event definition.',
    { type: z.string() },
    (args) => catalogueShow(args.type as string, options),
  );
  controlTool('events_sources_list', 'List event sources', 'Lists configured local event sources.', {}, () =>
    sourcesList(options),
  );
  controlTool(
    'events_source_show',
    'Show event source',
    'Shows one configured local event source.',
    { source: z.string() },
    (args) => sourceShow(args.source as string, options),
  );
  controlTool('events_rules_list', 'List event rules', 'Lists immutable local event rule versions.', {}, () =>
    rulesList(options),
  );
  controlTool(
    'events_rule_show',
    'Show event rule',
    'Shows immutable versions of one event rule.',
    { ruleId: z.string() },
    (args) => ruleShow(args.ruleId as string, options),
  );
  controlTool(
    'events_rule_create',
    'Create inert event rule',
    'Creates an inert immutable event rule version.',
    { document: z.unknown() },
    (args) => createRule(args.document, options),
    true,
  );
  controlTool(
    'events_rule_update',
    'Update event rule',
    'Creates another inert immutable event rule version.',
    { document: z.unknown() },
    (args) => updateRule(args.document, options),
    true,
  );
  controlTool(
    'events_rule_enable',
    'Prepare event rule enablement',
    'Prepares the standing disclosure for a rule version.',
    { ruleId: z.string(), version: z.number().int().positive() },
    (args) => enableRule(args.ruleId as string, args.version as number, options),
    true,
  );
  controlTool(
    'events_rule_disable',
    'Disable event rule',
    'Immediately disables the active event rule.',
    { ruleId: z.string() },
    (args) => disableRule(args.ruleId as string, options),
    true,
  );
  controlTool(
    'events_rule_remove',
    'Remove event rule',
    'Immediately removes the active event rule.',
    { ruleId: z.string() },
    (args) => removeRule(args.ruleId as string, options),
    true,
  );
  controlTool('events_targets_list', 'List event targets', 'Lists immutable local event target versions.', {}, () =>
    targetsList(options),
  );
  controlTool(
    'events_target_add',
    'Add inert event target',
    'Creates an inert immutable dry-run target.',
    { document: z.unknown() },
    (args) => addTarget(args.document, options),
    true,
  );
  controlTool(
    'events_target_update',
    'Update event target',
    'Creates another inert immutable dry-run target version.',
    { document: z.unknown() },
    (args) => updateTarget(args.document, options),
    true,
  );
  controlTool(
    'events_target_remove',
    'Remove event target',
    'Revokes every live version of a dry-run target.',
    { targetId: z.string() },
    (args) => removeTarget(args.targetId as string, options),
    true,
  );

  return {
    server,
    async connectStdio(): Promise<void> {
      const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      await server.connect(new StdioServerTransport());
    },
  };
}
