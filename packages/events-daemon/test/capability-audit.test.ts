import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  ['events-daemon.rules.list', 'rules list', 'events_rules_list', 'both', 'rulesList'],
  ['events-daemon.rule.show', 'rule show', 'events_rule_show', 'both', 'ruleShow'],
  ['events-daemon.rule.create', 'rule create', 'events_rule_create', 'both', 'createRule'],
  ['events-daemon.rule.update', 'rule update', 'events_rule_update', 'both', 'updateRule'],
  ['events-daemon.rule.enable', 'rule enable', 'events_rule_enable', 'both', 'enableRule'],
  ['events-daemon.rule.disable', 'rule disable', 'events_rule_disable', 'both', 'disableRule'],
  ['events-daemon.rule.remove', 'rule remove', 'events_rule_remove', 'both', 'removeRule'],
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
  ['events-daemon.rule.test', 'rule test', 'events_rule_test', 'both', 'ruleTest'],
  ['events-daemon.rule.test-retained', 'rule test-retained', null, 'exception', 'ruleTestRetained'],
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

const rowShape = (row: Capability) => ({
  id: row.id,
  cli: row.cli,
  mcp: row.mcp,
  status: row.status,
  ...(row.operation === undefined ? {} : { operation: row.operation }),
});

const shapedRows = (source: readonly (readonly [string, string, string | null, string, string?])[]) =>
  source.map(([id, cli, mcp, status, operation]) => ({
    id,
    cli,
    mcp,
    status,
    ...(operation === undefined ? {} : { operation }),
  }));

const expectedRows = [
  ...shapedRows(EXPECTED_B1_ROWS.slice(0, 27)),
  ...shapedRows(EXPECTED_B3_ROWS),
  ...shapedRows(EXPECTED_B1_ROWS.slice(27)),
];

function headings(page: string): string[] {
  return [...page.matchAll(/^### `([^`]+)`$/gm)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

test('PAR-B1: capability audit freezes the completed Decision 6 inventory', async () => {
  const table = JSON.parse(await readFile(join(ROOT, 'capabilities.json'), 'utf8')) as {
    readonly capabilities: readonly Capability[];
  };
  const rows = table.capabilities.filter((row) => row.package === 'events-daemon');

  assert.deepEqual(rows.map(rowShape), expectedRows);
  assert.equal(new Set(rows.map((row) => row.id)).size, expectedRows.length);
  assert.ok(rows.every((row) => row.status !== 'pending'));

  const exceptions = new Map(rows.filter((row) => row.status === 'exception').map((row) => [row.id, row]));
  for (const id of [
    'events-daemon.run',
    'events-daemon.approve',
    'events-daemon.dryrun.list',
    'events-daemon.dryrun.show',
  ]) {
    const row = exceptions.get(id);
    assert.equal(row?.mcp, null, `${id} stays a human-only or owner-starting exception`);
  }
  const expectedB3Exceptions = [
    [
      'events-daemon.rule.test-retained',
      'rule test-retained',
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
  for (const [id, cli, operation, reason] of expectedB3Exceptions) {
    const row = exceptions.get(id);
    assert.deepEqual(
      row === undefined
        ? undefined
        : {
            cli: row.cli,
            mcp: row.mcp,
            operation: row.operation,
            reason: (row as Capability & { reason?: string }).reason,
          },
      { cli, mcp: null, operation, reason },
      `${id} is an exact, individual terminal-only exception row`,
    );
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

  for (const command of ['rule test-retained', 'target resume', 'held decide', 'secrets migrate'])
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
    'rule test',
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
    'rule test-retained',
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
