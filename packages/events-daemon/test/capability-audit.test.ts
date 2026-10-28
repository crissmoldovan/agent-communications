import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// @ts-expect-error Repository tooling is executable Node ESM without a declaration surface.
import { deriveRegistries, scratchEnv } from '../../../scripts/registries.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const exec = promisify(execFile);

type Capability = {
  readonly id: string;
  readonly package: string;
  readonly cli: string | null;
  readonly mcp: string | null;
  readonly status: string;
  readonly operation?: string;
  readonly argv?: readonly string[];
  readonly args?: { readonly source?: string };
  readonly expect?: { readonly source?: string };
  readonly reason?: string;
};

const EXPECTED_B1_ROWS = [
  ['events-daemon.status', 'status', 'events_status', 'both', 'status'],
  // B3 (Task 1): every CLI exception names the operation its driver runs.
  ['events-daemon.run', 'run', null, 'exception', 'run'],
  ['events-daemon.stop', 'stop', 'events_stop', 'both', 'stop'],
  ['events-daemon.pause', 'pause', 'events_pause', 'both', 'pause'],
  ['events-daemon.resume', 'resume', 'events_resume', 'both', 'resume'],
  ['events-daemon.disable-all', 'disable-all', 'events_disable_all', 'both', 'disableAll'],
  ['events-daemon.enable-all', 'enable-all', 'events_enable_all', 'both', 'enableAll'],
  ['events-daemon.doctor', 'doctor', 'events_doctor', 'both', 'doctor'],
  ['events-daemon.catalogue.list', 'catalogue list', 'events_catalogue_list', 'both', 'catalogueList'],
  ['events-daemon.catalogue.show', 'catalogue show', 'events_catalogue_show', 'both', 'catalogueShow'],
  ['events-daemon.sources.list', 'sources list', 'events_sources_list', 'both', 'sourcesList'],
  ['events-daemon.source.show', 'source show', 'events_source_show', 'both', 'sourceShow'],
  ['events-daemon.source.show.slack', 'source show', 'events_source_show', 'both', 'sourceShow'],
  ['events-daemon.source.show.resend', 'source show', 'events_source_show', 'both', 'sourceShow'],
  ['events-daemon.source.show.whatsapp', 'source show', 'events_source_show', 'both', 'sourceShow'],
  ['events-daemon.rules.list', 'workflows list', 'events_rules_list', 'both', 'rulesList'],
  ['events-daemon.rule.show', 'workflow show', 'events_rule_show', 'both', 'ruleShow'],
  ['events-daemon.rule.create', 'workflow create', 'events_rule_create', 'both', 'createRule'],
  ['events-daemon.rule.update', 'workflow update', 'events_rule_update', 'both', 'updateRule'],
  ['events-daemon.rule.enable', 'workflow enable', 'events_rule_enable', 'both', 'enableRule'],
  ['events-daemon.rule.disable', 'workflow disable', 'events_rule_disable', 'both', 'disableRule'],
  ['events-daemon.rule.remove', 'workflow remove', 'events_rule_remove', 'both', 'removeRule'],
  ['events-daemon.targets.list', 'targets list', 'events_targets_list', 'both', 'targetsList'],
  ['events-daemon.target.add', 'target add', 'events_target_add', 'both', 'addTarget'],
  ['events-daemon.target.update', 'target update', 'events_target_update', 'both', 'updateTarget'],
  ['events-daemon.target.remove', 'target remove', 'events_target_remove', 'both', 'removeTarget'],
  ['events-daemon.approve', 'approve', null, 'exception', 'approve'],
  ['events-daemon.dryrun.list', 'dryrun list', null, 'exception', 'dryrunList'],
  ['events-daemon.dryrun.show', 'dryrun show', null, 'exception', 'dryrunShow'],
  ['events-daemon.mcp.serve', 'mcp', null, 'exception'],
] as const;

/** Tasks 5–6 register B3's paired rows and its deliberately unpaired terminal exceptions in plan-table order. */
const EXPECTED_B3_ROWS = [
  ['events-daemon.approval.view', 'approval view', 'events_approval_view', 'both', 'approvalView'],
  ['events-daemon.rule.test', 'workflow test', 'events_rule_test', 'both', 'ruleTest'],
  ['events-daemon.rule.test-retained', 'workflow test-retained', null, 'exception', 'ruleTestRetained'],
  ['events-daemon.target.test', 'target test', 'events_target_test', 'both', 'targetTest'],
  ['events-daemon.target.resume', 'target resume', null, 'exception', 'targetResume'],
  ['events-daemon.subscribers.list', 'subscribers list', 'events_subscribers_list', 'both', 'subscribersList'],
  ['events-daemon.subscriber.add', 'subscriber add', 'events_subscriber_add', 'both', 'addSubscriber'],
  ['events-daemon.subscriber.update', 'subscriber update', 'events_subscriber_update', 'both', 'updateSubscriber'],
  ['events-daemon.subscriber.remove', 'subscriber remove', 'events_subscriber_remove', 'both', 'removeSubscriber'],
  ['events-daemon.judges.list', 'judges list', 'events_judges_list', 'both', 'judgesList'],
  ['events-daemon.judge.add', 'judge add', 'events_judge_add', 'both', 'addJudge'],
  ['events-daemon.judge.update', 'judge update', 'events_judge_update', 'both', 'updateJudge'],
  ['events-daemon.judge.remove', 'judge remove', 'events_judge_remove', 'both', 'removeJudge'],
  ['events-daemon.judge.test', 'judge test', 'events_judge_test', 'both', 'judgeTest'],
  ['events-daemon.budget.show', 'budget show', 'events_budget_show', 'both', 'budgetShow'],
  ['events-daemon.budget.update', 'budget update', 'events_budget_update', 'both', 'updateBudget'],
  ['events-daemon.judge-kinds.list', 'judge kinds list', 'events_judge_kinds_list', 'both', 'judgeKindsList'],
  ['events-daemon.judge-kind.enable', 'judge kind enable', 'events_judge_kind_enable', 'both', 'enableJudgeKind'],
  ['events-daemon.judge-kind.disable', 'judge kind disable', 'events_judge_kind_disable', 'both', 'disableJudgeKind'],
  ['events-daemon.judge-model.status', 'judge model status', 'events_judge_model_status', 'both', 'judgeModelStatus'],
  ['events-daemon.judge-model.remove', 'judge model remove', 'events_judge_model_remove', 'both', 'removeJudgeModel'],
  ['events-daemon.deliveries.list', 'deliveries list', 'events_deliveries_list', 'both', 'deliveriesList'],
  ['events-daemon.delivery.retry', 'delivery retry', 'events_delivery_retry', 'both', 'retryDelivery'],
  ['events-daemon.delivery.drop', 'delivery drop', 'events_delivery_drop', 'both', 'dropDelivery'],
  ['events-daemon.held.list', 'held list', 'events_held_list', 'both', 'heldList'],
  ['events-daemon.held.decide', 'held decide', null, 'exception', 'decideHeld'],
  ['events-daemon.target-secret.create', 'target secret create', null, 'exception', 'targetSecretCreate'],
  ['events-daemon.target-secret.rotate', 'target secret rotate', null, 'exception', 'targetSecretRotate'],
  ['events-daemon.target-url.set', 'target url set', null, 'exception', 'targetUrlSet'],
  ['events-daemon.subscriber-token.create', 'subscriber token create', null, 'exception', 'subscriberTokenCreate'],
  ['events-daemon.subscriber-token.rotate', 'subscriber token rotate', null, 'exception', 'subscriberTokenRotate'],
  ['events-daemon.judge-key.set', 'judge key set', null, 'exception', 'judgeKeySet'],
  ['events-daemon.judge-key.rotate', 'judge key rotate', null, 'exception', 'judgeKeyRotate'],
  ['events-daemon.secrets.migrate', 'secrets migrate', null, 'exception', 'migrateSecrets'],
] as const;

/** The action queue (0.30.0): content reads are terminal/app exceptions (Q1); the rest are paired and content-free. */
const EXPECTED_QUEUE_ROWS = [
  ['events-daemon.queue.list', 'queue list', null, 'exception', 'queueList'],
  ['events-daemon.queue.show', 'queue show', null, 'exception', 'queueShow'],
  ['events-daemon.queue.items', 'queue items', 'events_queue_items', 'both', 'queueItems'],
  ['events-daemon.queue.counts', 'queue counts', 'events_queue_counts', 'both', 'queueCounts'],
  ['events-daemon.queue.done', 'queue done', 'events_queue_done', 'both', 'queueDone'],
  ['events-daemon.queue.dismiss', 'queue dismiss', 'events_queue_dismiss', 'both', 'queueDismiss'],
  ['events-daemon.queue.reopen', 'queue reopen', 'events_queue_reopen', 'both', 'queueReopen'],
  ['events-daemon.queue.clear', 'queue clear', null, 'exception', 'queueClear'],
] as const;

/** 0.32.0 (owner feedback §3.5): one delivery's details are the person's, at a terminal or in the app. */
const EXPECTED_READABLE_ROWS = [
  ['events-daemon.delivery.show', 'delivery show', null, 'exception', 'deliveryShow'],
] as const;

/**
 * Routing's lanes (0.31.0): the person lists, binds and unbinds; binding is terminal-only (B1); an agent window's own
 * identity, watch, long-poll and lane read are MCP-only exceptions, each with its reason (§3.7).
 */
const EXPECTED_LANE_ROWS = [
  ['events-daemon.lane.list', 'lane list', 'events_lane_list', 'both', 'laneList'],
  ['events-daemon.lane.bind', 'lane bind', null, 'exception', 'laneBind'],
  ['events-daemon.lane.unbind', 'lane unbind', 'events_lane_unbind', 'both', 'laneUnbind'],
  ['events-daemon.lane.whoami', null, 'events_lane_whoami', 'exception'],
  ['events-daemon.lane.watch', null, 'events_watch', 'exception'],
  ['events-daemon.lane.wait', null, 'events_wait', 'exception'],
  ['events-daemon.lane.item', null, 'events_lane_item', 'exception'],
] as const;

/**
 * A story per message (0.32.0 spec §3.6): what happened to each message is the person's own view, at a terminal or in
 * the app, and a CLI-only exception (§4) — no tool returns it.
 */
const EXPECTED_MESSAGE_ROWS = [
  ['events-daemon.messages.list', 'messages list', null, 'exception', 'messagesList'],
  ['events-daemon.message.show', 'message show', null, 'exception', 'messageShow'],
] as const;

/**
 * The person's own setup (owner decision 2026-10-26): judge setup and the two provider key commands are CLI-only, the
 * person's; whether each provider has a key is both.
 */
const EXPECTED_SETUP_ROWS = [
  ['events-daemon.judge.setup', 'judge setup', null, 'exception', 'judgeSetup'],
  ['events-daemon.provider.list', 'provider list', 'events_provider_list', 'both', 'providerList'],
  ['events-daemon.provider-key.set', 'provider key set', null, 'exception', 'providerKeySet'],
  ['events-daemon.provider-key.remove', 'provider key remove', null, 'exception', 'providerKeyRemove'],
] as const;

/**
 * Rules edited in the app (0.33.0 design §3.1): a rule's activation is approved by the person in the app, after its
 * preview, the app's only path; at a terminal the person types the challenge with `approve`. Switching the event
 * service on (0.34.0 design B4) is approved the same way.
 */
const EXPECTED_RULE_APPROVAL_ROWS = [
  ['events-daemon.rule.approve', 'workflow approve', null, 'exception', 'approveRuleFromApp'],
  ['events-daemon.collection.approve', 'collection approve', null, 'exception', 'approveEnableAllFromApp'],
] as const;

/** Analyse (0.33.0 design §3.3, §3.7): the person's view of one rule and its last 30 days, a CLI-only exception. */
const EXPECTED_ANALYSE_ROWS = [
  ['events-daemon.rule.analyse', 'workflow analyse', null, 'exception', 'ruleAnalyse'],
  // Describe it (0.36.0 workflows design §11.4, W21): the person's words drafted into a workflow, written nowhere.
  ['events-daemon.rule.describe', 'workflow describe', null, 'exception', 'workflowDescribe'],
] as const;

/** Settings → Integrations (0.33.0 design §3.4): what the person's Linear key can see is their own read, CLI-only. */
/** One judge version's exact canonical document (0.33.0): content-free, as judges list is, so CLI and MCP alike. */
const EXPECTED_JUDGE_SHOW_ROWS = [
  ['events-daemon.judge.show', 'judge show', 'events_judge_show', 'both', 'judgeShow'],
] as const;

const EXPECTED_INTEGRATION_ROWS = [
  ['events-daemon.integration.show', 'integration show', null, 'exception', 'integrationShow'],
] as const;

/**
 * Agent sessions through claude-stream (0.33.0 §3.5): where the relay is, and dropping a waiting match, are the
 * person's, CLI-only; the waiting matches are both, a bound window's own lane's over MCP.
 */
const EXPECTED_SESSION_ROWS = [
  ['events-daemon.integration.show-agent-sessions', 'integration show', null, 'exception', 'integrationShow'],
  ['events-daemon.integration.set', 'integration set', null, 'exception', 'integrationSet'],
  ['events-daemon.session-queue.list', 'session-queue list', 'events_session_queue_list', 'both', 'sessionQueueList'],
  ['events-daemon.session-queue.drop', 'session-queue drop', null, 'exception', 'sessionQueueDrop'],
] as const;

/**
 * Projects (0.36.0 workflows design §8.1): the GitHub repositories on this Mac, their folders, a profile and hints —
 * the person's alone, CLI-only, with no tool.
 */
const EXPECTED_PROJECT_ROWS = [
  ['events-daemon.projects.list', 'projects list', null, 'exception', 'projectsList'],
  ['events-daemon.project.show', 'project show', null, 'exception', 'projectShow'],
  ['events-daemon.project.add', 'project add', null, 'exception', 'projectAdd'],
  ['events-daemon.project.update', 'project update', null, 'exception', 'projectUpdate'],
  ['events-daemon.project.remove', 'project remove', null, 'exception', 'projectRemove'],
  ['events-daemon.project.scan', 'project scan', null, 'exception', 'projectScan'],
] as const;

const rowShape = (row: Capability) => ({
  id: row.id,
  cli: row.cli,
  mcp: row.mcp,
  status: row.status,
  ...(row.operation === undefined ? {} : { operation: row.operation }),
});

const shapedRows = (source: readonly (readonly [string, string | null, string | null, string, string?])[]) =>
  source.map(([id, cli, mcp, status, operation]) => ({
    id,
    cli,
    mcp,
    status,
    ...(operation === undefined ? {} : { operation }),
  }));

/**
 * Workflow events (0.36.0, W29, W25): a webhook subscriber's secrets are the person's at the terminal; a subscription is
 * prepared by anyone, CLI and MCP alike, and approved from the app only by the person; the step event catalogue is
 * content-free. They sit after the subscriber token rows.
 */
const EXPECTED_WORKFLOW_EVENT_ROWS = [
  ['events-daemon.subscriber-secret.create', 'subscriber secret create', null, 'exception', 'subscriberSecretCreate'],
  ['events-daemon.subscriber-secret.rotate', 'subscriber secret rotate', null, 'exception', 'subscriberSecretRotate'],
  ['events-daemon.subscriber-url.set', 'subscriber url set', null, 'exception', 'subscriberUrlSet'],
  ['events-daemon.subscriber.enable', 'subscriber enable', 'events_subscriber_enable', 'both', 'enableSubscriber'],
  ['events-daemon.subscriber.approve', 'subscriber approve', null, 'exception', 'approveSubscriberFromApp'],
  [
    'events-daemon.workflow-events.list',
    'workflow-events list',
    'events_workflow_events_list',
    'both',
    'workflowEventsList',
  ],
  [
    'events-daemon.workflow-events.show',
    'workflow-events show',
    'events_workflow_events_show',
    'both',
    'workflowEventsShow',
  ],
] as const;

/**
 * A workflow's runs and its checks (0.36.0 workflows design §7.6, §7.7, plan B6–B7): checking a document is content-free,
 * CLI and MCP alike; listing, showing and cancelling a run are the person's, CLI-only, with no tool. They sit after
 * `workflow test`.
 */
const EXPECTED_WORKFLOW_RUN_ROWS = [
  ['events-daemon.rule.check', 'workflow check', 'events_rule_check', 'both', 'ruleCheck'],
  ['events-daemon.runs.list', 'runs list', null, 'exception', 'runsList'],
  ['events-daemon.runs.show', 'runs show', null, 'exception', 'runShow'],
  ['events-daemon.runs.cancel', 'runs cancel', null, 'exception', 'runCancel'],
] as const;

const ruleTestRows = EXPECTED_B3_ROWS.findIndex((row) => row[0] === 'events-daemon.rule.test') + 1;
const subscriberTokenRows = EXPECTED_B3_ROWS.findIndex((row) => row[0] === 'events-daemon.subscriber-token.rotate') + 1;

const expectedRows = [
  ...shapedRows(EXPECTED_B1_ROWS.slice(0, 27)),
  ...shapedRows(EXPECTED_B3_ROWS.slice(0, ruleTestRows)),
  ...shapedRows(EXPECTED_WORKFLOW_RUN_ROWS),
  ...shapedRows(EXPECTED_B3_ROWS.slice(ruleTestRows, subscriberTokenRows)),
  ...shapedRows(EXPECTED_WORKFLOW_EVENT_ROWS),
  ...shapedRows(EXPECTED_B3_ROWS.slice(subscriberTokenRows)),
  ...shapedRows(EXPECTED_B1_ROWS.slice(27, 29)),
  ...shapedRows(EXPECTED_READABLE_ROWS),
  ...shapedRows(EXPECTED_QUEUE_ROWS),
  ...shapedRows(EXPECTED_LANE_ROWS),
  ...shapedRows(EXPECTED_MESSAGE_ROWS),
  ...shapedRows(EXPECTED_SETUP_ROWS),
  ...shapedRows(EXPECTED_RULE_APPROVAL_ROWS),
  ...shapedRows(EXPECTED_ANALYSE_ROWS),
  ...shapedRows(EXPECTED_INTEGRATION_ROWS),
  ...shapedRows(EXPECTED_SESSION_ROWS.slice(0, 2)),
  ...shapedRows(EXPECTED_PROJECT_ROWS),
  ...shapedRows(EXPECTED_SESSION_ROWS.slice(2)),
  ...shapedRows(EXPECTED_JUDGE_SHOW_ROWS),
  ...shapedRows(EXPECTED_B1_ROWS.slice(29)),
];

/** Copy the production parity inputs, leaving package manager state immutable. The copied source is what the
 * production parity script imports, so an export mutation cannot accidentally be masked by the worktree module. */
async function parityFixture(): Promise<{ readonly root: string; readonly parent: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'events-daemon-parity-fixture-'));
  const root = join(parent, 'repository');
  const skip = (source: string) =>
    !source
      .split(/[\\/]/)
      .some((part) => part === '.git' || part === 'node_modules' || part === 'dist' || part === '.mutants');
  for (const path of ['scripts', 'packages', 'skills', 'capabilities.json', 'package.json'])
    await cp(join(ROOT, path), join(root, path), { recursive: true, filter: skip });
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await symlink(
      join(ROOT, 'packages', entry.name, 'node_modules'),
      join(root, 'packages', entry.name, 'node_modules'),
      'dir',
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { root, parent };
}

async function expectStrictParityFailure(root: string, explanation: string): Promise<string> {
  try {
    await exec(process.execPath, ['scripts/parity.mjs', '--strict'], { cwd: root });
  } catch (error) {
    const failed = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
    assert.equal(failed.code, 1, explanation);
    return `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
  }
  assert.fail(explanation);
}

const EXPECTED_B3_EXCEPTIONS = [
  [
    'events-daemon.rule.test-retained',
    'workflow test-retained',
    'ruleTestRetained',
    'Retained sender content may be selected only by a person outside model context.',
  ],
  [
    'events-daemon.target.resume',
    'target resume',
    'targetResume',
    'A person, not model context, decides to reopen a degraded target reset barrier.',
  ],
  [
    'events-daemon.held.decide',
    'held decide',
    'decideHeld',
    'A held model decision can be resolved only by a person at terminal/app, never by model context.',
  ],
  [
    'events-daemon.target-secret.create',
    'target secret create',
    'targetSecretCreate',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.target-secret.rotate',
    'target secret rotate',
    'targetSecretRotate',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.target-url.set',
    'target url set',
    'targetUrlSet',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.subscriber-token.create',
    'subscriber token create',
    'subscriberTokenCreate',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.subscriber-token.rotate',
    'subscriber token rotate',
    'subscriberTokenRotate',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.subscriber-secret.create',
    'subscriber secret create',
    'subscriberSecretCreate',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.subscriber-secret.rotate',
    'subscriber secret rotate',
    'subscriberSecretRotate',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.subscriber-url.set',
    'subscriber url set',
    'subscriberUrlSet',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.judge-key.set',
    'judge key set',
    'judgeKeySet',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.judge-key.rotate',
    'judge key rotate',
    'judgeKeyRotate',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
  [
    'events-daemon.secrets.migrate',
    'secrets migrate',
    'migrateSecrets',
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
  ],
] as const;

function assertDaemonCapabilityAudit(rows: readonly Capability[]): void {
  assert.deepEqual(rows.map(rowShape), expectedRows);
  assert.equal(new Set(rows.map((row) => row.id)).size, expectedRows.length);
  assert.ok(rows.every((row) => row.status !== 'pending'));

  const exceptions = new Map(rows.filter((row) => row.status === 'exception').map((row) => [row.id, row]));
  for (const id of [
    'events-daemon.run',
    'events-daemon.approve',
    'events-daemon.dryrun.list',
    'events-daemon.dryrun.show',
    'events-daemon.delivery.show',
    'events-daemon.queue.list',
    'events-daemon.queue.show',
    'events-daemon.queue.clear',
    'events-daemon.lane.bind',
    'events-daemon.messages.list',
    'events-daemon.message.show',
    'events-daemon.judge.setup',
    'events-daemon.provider-key.set',
    'events-daemon.provider-key.remove',
    'events-daemon.rule.approve',
    'events-daemon.collection.approve',
    'events-daemon.rule.analyse',
    'events-daemon.rule.describe',
    'events-daemon.integration.show',
    'events-daemon.integration.show-agent-sessions',
    'events-daemon.integration.set',
    'events-daemon.session-queue.drop',
    'events-daemon.subscriber.approve',
    ...EXPECTED_PROJECT_ROWS.map(([id]) => id),
    ...EXPECTED_WORKFLOW_RUN_ROWS.filter(([, , mcp]) => mcp === null).map(([id]) => id),
  ]) {
    const row = exceptions.get(id);
    assert.equal(row?.mcp, null, `${id} stays a human-only or owner-starting exception`);
  }
  for (const id of [
    'events-daemon.lane.whoami',
    'events-daemon.lane.watch',
    'events-daemon.lane.wait',
    'events-daemon.lane.item',
  ]) {
    const row = exceptions.get(id);
    assert.equal(row?.cli, null, `${id} is an agent window's own, with no command`);
    assert.equal(row?.operation, undefined, `${id} has no command whose operation could be checked against it`);
    assert.ok((row?.reason ?? '').length > 40, `${id} says why it is MCP only`);
  }
  for (const [id, cli, operation, reason] of EXPECTED_B3_EXCEPTIONS) {
    const row = exceptions.get(id);
    assert.deepEqual(
      row === undefined
        ? undefined
        : {
            cli: row.cli,
            mcp: row.mcp,
            operation: row.operation,
            reason: row.reason,
          },
      { cli, mcp: null, operation, reason },
      `${id} is an exact, individual terminal-only exception row`,
    );
  }
}

function headings(page: string): string[] {
  return [...page.matchAll(/^### `([^`]+)`$/gm)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

test('PAR-B1: capability audit freezes the completed Decision 6 inventory', async () => {
  const table = JSON.parse(await readFile(join(ROOT, 'capabilities.json'), 'utf8')) as {
    readonly capabilities: readonly Capability[];
  };
  const rows = table.capabilities.filter((row) => row.package === 'events-daemon');

  assertDaemonCapabilityAudit(rows);
});

test('PAR-B3: capability audit rejects fixture copies that remove a row or weaken an exception reason', async () => {
  const table = JSON.parse(await readFile(join(ROOT, 'capabilities.json'), 'utf8')) as {
    readonly capabilities: readonly Capability[];
  };
  const removed = structuredClone(table) as { capabilities: Capability[] };
  removed.capabilities = removed.capabilities.filter((row) => row.id !== 'events-daemon.approval.view');
  assert.throws(
    () => assertDaemonCapabilityAudit(removed.capabilities.filter((row) => row.package === 'events-daemon')),
    /Expected values to be strictly deep-equal/u,
    'the completed capability inventory cannot silently lose a paired control row',
  );

  const weakened = structuredClone(table) as { capabilities: Array<Capability & { reason?: string }> };
  const secret = weakened.capabilities.find((row) => row.id === 'events-daemon.target-secret.create');
  assert.ok(secret, 'the fixture contains an individual terminal-only secret exception');
  secret.reason = 'terminal secret operation';
  assert.throws(
    () => assertDaemonCapabilityAudit(weakened.capabilities.filter((row) => row.package === 'events-daemon')),
    /exact, individual terminal-only exception row/u,
    'the audit rejects a vague replacement for the reviewed exception reason',
  );
});

test('PAR-B3: strict parity rejects a fixture copy with a removed B3 capability row', async () => {
  const fixture = await parityFixture();
  try {
    const path = join(fixture.root, 'capabilities.json');
    const table = JSON.parse(await readFile(path, 'utf8')) as { capabilities: Array<{ id: string }> };
    table.capabilities = table.capabilities.filter((row) => row.id !== 'events-daemon.approval.view');
    await writeFile(path, `${JSON.stringify(table, null, 2)}\n`);
    const output = await expectStrictParityFailure(
      fixture.root,
      'the strict production parity script must reject a missing paired B3 row',
    );
    assert.match(output, /agent-events approval view.*no row|events_approval_view.*no row/su);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('PAR-B3: strict parity rejects a fixture copy with a removed B3 operation export', async () => {
  const fixture = await parityFixture();
  try {
    const path = join(fixture.root, 'packages/events-daemon/src/operations/rule-test.ts');
    const source = await readFile(path, 'utf8');
    const changed = source.replace('export async function ruleTest(', 'async function ruleTest(');
    assert.notEqual(changed, source, 'the operation-export mutant removes the real rule-test export');
    await writeFile(path, changed);
    const output = await expectStrictParityFailure(
      fixture.root,
      'the strict production parity script must reject a B3 row whose operation is no longer exported',
    );
    assert.match(output, /ruleTest|does not provide an export named/u);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('D7: each registered source has a distinct source-show parity invocation', async () => {
  const table = JSON.parse(await readFile(join(ROOT, 'capabilities.json'), 'utf8')) as {
    readonly capabilities: readonly Capability[];
  };
  const rows = table.capabilities.filter((row) => row.id.startsWith('events-daemon.source.show'));
  assert.deepEqual(
    rows.map((row) => ({ id: row.id, argv: row.argv, args: row.args, expect: row.expect })),
    [
      {
        id: 'events-daemon.source.show',
        argv: ['gmail'],
        args: { source: 'gmail' },
        expect: { source: 'gmail' },
      },
      {
        id: 'events-daemon.source.show.slack',
        argv: ['slack'],
        args: { source: 'slack' },
        expect: { source: 'slack' },
      },
      {
        id: 'events-daemon.source.show.resend',
        argv: ['resend'],
        args: { source: 'resend' },
        expect: { source: 'resend' },
      },
      {
        id: 'events-daemon.source.show.whatsapp',
        argv: ['whatsapp'],
        args: { source: 'whatsapp' },
        expect: { source: 'whatsapp' },
      },
    ],
  );
});

test('PAR-B3: generated daemon references exactly describe the completed registries', async () => {
  const registries = await deriveRegistries({ env: scratchEnv() });
  const daemon = registries['events-daemon'];
  assert.ok(daemon, 'the service declaration supplies a surface registry');
  const [cliPage, mcpPage] = await Promise.all([
    readFile(join(ROOT, 'docs/reference/events-daemon-cli.md'), 'utf8'),
    readFile(join(ROOT, 'docs/reference/events-daemon-mcp-tools.md'), 'utf8'),
  ]);

  const cliCommands = headings(cliPage).map((heading) => heading.slice(daemon.binary.length + 1));
  assert.deepEqual([...new Set(cliCommands)].sort(), [...new Set([...daemon.commands, ...daemon.groups])].sort());
  assert.deepEqual(headings(mcpPage).sort(), [...daemon.tools].sort());

  for (const command of ['workflow test-retained', 'target resume', 'held decide', 'secrets migrate'])
    assert.match(cliPage, new RegExp(`\\bagent-events ${command}\\b`, 'u'));
  for (const tool of [
    'events_run',
    'events_approve',
    'events_dryrun_list',
    'events_dryrun_show',
    'events_target_resume',
    'events_target_secret_create',
    'events_subscriber_token_create',
    'events_held_decide',
  ]) {
    assert.ok(!daemon.tools.includes(tool), `${tool} cannot expose a model-context content or authority boundary`);
  }

  await exec(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    join(ROOT, 'scripts', 'sync-reference.mjs'),
    '--check',
  ]);
});

test('PAR-B3: paired controls and terminal-only exceptions occupy their deliberate separate surfaces', async () => {
  const table = JSON.parse(await readFile(join(ROOT, 'capabilities.json'), 'utf8')) as {
    readonly capabilities: readonly Capability[];
  };
  const rows = table.capabilities.filter((row) => row.package === 'events-daemon');
  const doctor = rows.find((row) => row.id === 'events-daemon.doctor');
  assert.ok(doctor, 'B2 preserves the B1 doctor capability row');
  assert.deepEqual(rowShape(doctor), {
    id: 'events-daemon.doctor',
    cli: 'doctor',
    mcp: 'events_doctor',
    status: 'both',
    operation: 'doctor',
  });

  const registries = await deriveRegistries({ env: scratchEnv() });
  const daemon = registries['events-daemon'];
  assert.ok(daemon, 'the daemon service surface remains discoverable');
  assert.ok(daemon.commands.includes('doctor'));
  assert.ok(daemon.tools.includes('events_doctor'));

  const pairedCommands = [
    'approval view',
    'workflow test',
    'target test',
    'subscriber add',
    'subscriber remove',
    'judge test',
    'budget update',
    'delivery retry',
    'delivery drop',
    'held list',
  ];
  const pairedTools = [
    'events_approval_view',
    'events_rule_test',
    'events_target_test',
    'events_subscriber_add',
    'events_subscriber_remove',
    'events_judge_test',
    'events_budget_update',
    'events_delivery_retry',
    'events_delivery_drop',
    'events_held_list',
  ];
  for (const command of pairedCommands) assert.ok(daemon.commands.includes(command), `${command} is paired in Task 5`);
  for (const tool of pairedTools) assert.ok(daemon.tools.includes(tool), `${tool} is paired in Task 5`);

  const humanOnlyCommands = [
    'workflow test-retained',
    'target resume',
    'held decide',
    'target secret create',
    'target secret rotate',
    'target url set',
    'subscriber token create',
    'subscriber token rotate',
    'judge key set',
    'judge key rotate',
    'secrets migrate',
  ];
  const humanOnlyTools = [
    'events_rule_test_retained',
    'events_target_resume',
    'events_held_decide',
    'events_target_secret_create',
    'events_target_secret_rotate',
    'events_target_url_set',
    'events_subscriber_token_create',
    'events_subscriber_token_rotate',
    'events_judge_key_set',
    'events_judge_key_rotate',
    'events_secrets_migrate',
  ];
  for (const command of humanOnlyCommands)
    assert.ok(daemon.commands.includes(command), `${command} is a terminal-only CLI leaf`);
  for (const tool of humanOnlyTools) assert.ok(!daemon.tools.includes(tool), `${tool} stays absent from MCP`);
  const forbiddenCommands = ['delivery hold', 'target replay'];
  const forbiddenTools = ['events_delivery_hold', 'events_target_replay'];
  for (const command of forbiddenCommands)
    assert.ok(!daemon.commands.includes(command), `${command} remains deferred beyond B2`);
  for (const tool of forbiddenTools) assert.ok(!daemon.tools.includes(tool), `${tool} remains deferred beyond B2`);
});
