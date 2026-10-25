import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { approvalView } from '../operations/approval-view.ts';
import type { B3ControlOperation, B3McpRegistrar } from '../operations/b3-contract.ts';
import { catalogueList, catalogueShow } from '../operations/catalogue.ts';
import { deliveriesList, dropDelivery, heldList, retryDelivery } from '../operations/deliveries.ts';
import { disableAll } from '../operations/disable-all.ts';
import { doctor } from '../operations/doctor.ts';
import { enableAll } from '../operations/enable-all.ts';
import {
  addJudge,
  budgetShow,
  disableJudgeKind,
  enableJudgeKind,
  judgeKindsList,
  judgeModelStatus,
  judgesList,
  judgeTest,
  removeJudge,
  removeJudgeModel,
  updateBudget,
  updateJudge,
} from '../operations/judges.ts';
import { pause, resume } from '../operations/pause.ts';
import { queueCounts, queueDismiss, queueDone, queueItems, queueReopen } from '../operations/queue.ts';
import { ruleTest } from '../operations/rule-test.ts';
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
import { addSubscriber, removeSubscriber, subscribersList, updateSubscriber } from '../operations/subscribers.ts';
import { targetTest } from '../operations/target-test.ts';
import { addTarget, removeTarget, targetsList, updateTarget } from '../operations/targets.ts';
import { VERSION } from '../version.ts';

export interface EventsMcpServer {
  readonly server: McpServer;
  connectStdio(): Promise<void>;
}

export interface EventsMcpOptions {
  readonly stateDir?: string | undefined;
  /** Task 1 seam: later B3 tools share this typed owner path; it registers nothing yet. */
  readonly b3Registrar?: B3McpRegistrar | undefined;
}

function reply(data: unknown) {
  const structured = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  return {
    structuredContent: structured,
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
  };
}

/** Creates the local event service's deliberately content-free MCP surface. */
export async function createEventsMcpServer(options: EventsMcpOptions = {}): Promise<EventsMcpServer> {
  const server = new McpServer({ name: 'agent-events', version: VERSION });
  const b3 = (operation: B3ControlOperation, args: Record<string, unknown>, throughOwner: () => Promise<unknown>) =>
    options.b3Registrar === undefined ? throughOwner() : options.b3Registrar.owner.handle({ operation, args });

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
    'Reports content-free lineage, retry, recovery, judge authority, hold-clock and protocol health.',
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
  /** B3 selectors are closed: an omitted field is not permission to smuggle an approval-flow selector or a document. */
  const strictControlTool = (
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
        inputSchema: z.strictObject(inputSchema),
        annotations: {
          readOnlyHint: !destructiveHint,
          destructiveHint,
          idempotentHint: !destructiveHint,
          openWorldHint: false,
        },
      },
      async (args) => reply(await operation(args as Record<string, unknown>)),
    );
  };
  strictControlTool(
    'events_catalogue_list',
    'List local event catalogue',
    'Lists selectable local event definitions.',
    {},
    () => catalogueList(options),
  );

  strictControlTool(
    'events_approval_view',
    'View pending disclosure approval',
    'Returns the daemon-authoritative preview and fresh challenge without claiming it.',
    { approvalId: z.string().min(1), digest: z.string().min(1) },
    (args) => approvalView(args.approvalId as string, args.digest as string, options),
  );
  strictControlTool(
    'events_rule_test',
    'Test a rule with a catalogue example',
    'Locally evaluates one selectable catalogue example without provider or judge I/O.',
    {
      document: z.unknown(),
      catalogue: z.strictObject({
        type: z.string().min(1),
        version: z.number().int().positive(),
        exampleIndex: z.number().int().min(0),
      }),
    },
    (args) =>
      ruleTest(
        args.document,
        args.catalogue as { readonly type: string; readonly version: number; readonly exampleIndex: number },
        options,
      ),
  );
  server.registerTool(
    'events_target_test',
    {
      title: 'Test one active target',
      description: 'Sends the fixed synthetic event only to one exact active target version.',
      inputSchema: z.strictObject({ targetId: z.string().min(1), targetVersion: z.number().int().positive() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => reply(await targetTest(args.targetId as string, args.targetVersion as number, options)),
  );
  strictControlTool('events_subscribers_list', 'List subscribers', 'Lists immutable subscriber metadata.', {}, () =>
    subscribersList(options),
  );
  strictControlTool(
    'events_subscriber_add',
    'Add subscriber',
    'Creates one immutable subscriber version.',
    { document: z.unknown() },
    (args) => addSubscriber(args.document, options),
    true,
  );
  strictControlTool(
    'events_subscriber_update',
    'Update subscriber',
    'Creates one replacement immutable subscriber version.',
    { document: z.unknown() },
    (args) => updateSubscriber(args.document, options),
    true,
  );
  strictControlTool(
    'events_subscriber_remove',
    'Remove subscriber',
    'Revokes every live version of one subscriber and closes its streams.',
    { subscriberId: z.string().min(1) },
    (args) => removeSubscriber(args.subscriberId as string, options),
    true,
  );
  strictControlTool('events_judges_list', 'List judges', 'Lists content-free immutable judge metadata.', {}, () =>
    judgesList(options),
  );
  strictControlTool(
    'events_judge_add',
    'Add judge',
    'Creates an immutable, initially inactive judge version.',
    { document: z.unknown() },
    (args) => b3('addJudge', { document: args.document }, () => addJudge(args.document, options)),
    true,
  );
  strictControlTool(
    'events_judge_update',
    'Update judge',
    'Creates an immutable replacement judge version.',
    { document: z.unknown() },
    (args) => b3('updateJudge', { document: args.document }, () => updateJudge(args.document, options)),
    true,
  );
  strictControlTool(
    'events_judge_remove',
    'Remove judge',
    'Removes every live immutable version of one judge.',
    { judgeId: z.string().min(1) },
    (args) => b3('removeJudge', { judgeId: args.judgeId }, () => removeJudge(args.judgeId as string, options)),
    true,
  );
  strictControlTool(
    'events_judge_test',
    'Test judge',
    'Tests one active exact judge version with the daemon-fixed synthetic event.',
    { judgeId: z.string().min(1), version: z.number().int().positive() },
    (args) => judgeTest(args.judgeId as string, args.version as number, options),
  );
  strictControlTool(
    'events_budget_show',
    'Show budget',
    'Lists immutable judge budgets and the active singleton.',
    {},
    () => budgetShow(options),
  );
  strictControlTool(
    'events_budget_update',
    'Update budget',
    'Creates a pending immutable global budget and prepares its approval.',
    { document: z.unknown() },
    (args) => b3('updateBudget', { document: args.document }, () => updateBudget(args.document, options)),
    true,
  );
  strictControlTool(
    'events_judge_kinds_list',
    'List judge kinds',
    'Lists each judge kind as disabled or enabled, or Laya as unavailable here with its reason.',
    {},
    () => judgeKindsList(options),
  );
  strictControlTool(
    'events_judge_kind_enable',
    'Enable judge kind',
    'Prepares, but never approves or claims, judge-kind enablement.',
    { kind: z.string().min(1) },
    (args) => b3('enableJudgeKind', { kind: args.kind }, () => enableJudgeKind(args.kind as string, options)),
    true,
  );
  strictControlTool(
    'events_judge_kind_disable',
    'Disable judge kind',
    'Immediately disables one judge kind; for Laya it also cancels a download and keeps verified files.',
    { kind: z.string().min(1) },
    (args) => {
      const kind = args.kind as string;
      return b3('disableJudgeKind', { kind }, () => disableJudgeKind(kind, options));
    },
    true,
  );
  strictControlTool(
    'events_judge_model_status',
    'Judge model status',
    'Reports the local Laya runtime and model state, byte progress and any failure or unavailable reason.',
    {},
    () => judgeModelStatus(options),
  );
  strictControlTool(
    'events_judge_model_remove',
    'Remove judge model',
    'Deletes the verified Laya model and runtime files, only while Laya is disabled.',
    {},
    () => removeJudgeModel(options),
    true,
  );
  strictControlTool('events_deliveries_list', 'List deliveries', 'Lists content-free delivery metadata.', {}, () =>
    deliveriesList(options),
  );
  strictControlTool(
    'events_delivery_retry',
    'Retry delivery',
    'Retries one exact retryable delivery.',
    { deliveryId: z.string().min(1) },
    (args) => retryDelivery(args.deliveryId as string, options),
    true,
  );
  strictControlTool(
    'events_delivery_drop',
    'Drop delivery',
    'Drops one exact dead-letter delivery and its retained payload.',
    { deliveryId: z.string().min(1) },
    (args) => dropDelivery(args.deliveryId as string, options),
    true,
  );
  strictControlTool(
    'events_held_list',
    'List held decisions',
    'Lists content-free held-decision metadata; only a terminal/app may resolve one.',
    {},
    () => heldList(options),
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

  // The action queue (action queue design Q1, Q5): an agent can find an item and mark it, never read what it says.
  // No tool here returns a sender, subject, text or link; `queue list` and `queue show` are the person's, at the CLI.
  // Nor can an agent clear the queue: `queue clear` would make the person's done and dismissed items disappear.
  const queueFilters = {
    state: z.enum(['open', 'done', 'dismissed', 'all']).optional().describe('Which items: open (the default) or all.'),
    rule: z.string().min(1).max(256).optional().describe("Only this rule's items, by rule id."),
    channel: z.enum(['gmail', 'slack', 'resend', 'whatsapp']).optional().describe("Only this channel's items."),
    limit: z.number().int().min(1).max(500).optional().describe('At most this many items, newest first (default 50).'),
  };
  const queueItemId = {
    itemId: z
      .string()
      .regex(/^qi_[0-9A-HJKMNP-TV-Z]{26}$/u)
      .describe('The item, as events_queue_items gives it: qi_ and 26 Crockford base32 characters.'),
  };
  strictControlTool(
    'events_queue_items',
    'List queue items',
    "Lists the action queue's items without what they say: id, rule, channel, account, state and times.",
    queueFilters,
    (args) =>
      queueItems(
        {
          ...(args.state === undefined ? {} : { state: args.state as string }),
          ...(args.rule === undefined ? {} : { rule: args.rule as string }),
          ...(args.channel === undefined ? {} : { channel: args.channel as string }),
          ...(args.limit === undefined ? {} : { limit: args.limit as number }),
        },
        options,
      ),
  );
  strictControlTool(
    'events_queue_counts',
    'Count queue items',
    'Counts open, done and dismissed queue items, and each rule’s open items.',
    {},
    () => queueCounts(options),
  );
  for (const [name, title, description, operation] of [
    ['events_queue_done', 'Mark queue item done', 'Marks one queue item done; it stays for its retention.', queueDone],
    [
      'events_queue_dismiss',
      'Dismiss queue item',
      'Dismisses one queue item; it stays for its retention.',
      queueDismiss,
    ],
    ['events_queue_reopen', 'Reopen queue item', 'Reopens one done or dismissed queue item.', queueReopen],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: z.strictObject(queueItemId),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => reply(await operation(args.itemId as string, options)),
    );
  }

  return {
    server,
    async connectStdio(): Promise<void> {
      const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      await server.connect(new StdioServerTransport());
    },
  };
}
