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
  ['events-daemon.run', 'run', null, 'exception'],
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
  ['events-daemon.approve', 'approve', null, 'exception'],
  ['events-daemon.dryrun.list', 'dryrun list', null, 'exception'],
  ['events-daemon.dryrun.show', 'dryrun show', null, 'exception'],
  ['events-daemon.mcp.serve', 'mcp', null, 'exception'],
] as const;

const rowShape = (row: Capability) => ({
  id: row.id,
  cli: row.cli,
  mcp: row.mcp,
  status: row.status,
  ...(row.operation === undefined ? {} : { operation: row.operation }),
});

const expectedRows = EXPECTED_B1_ROWS.map(([id, cli, mcp, status, operation]) => ({
  id,
  cli,
  mcp,
  status,
  ...(operation === undefined ? {} : { operation }),
}));

function headings(page: string): string[] {
  return [...page.matchAll(/^### `([^`]+)`$/gm)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

test('PAR-B1: capability audit freezes the completed Decision 6 inventory', async () => {
  const table = JSON.parse(await readFile(join(ROOT, 'capabilities.json'), 'utf8')) as {
    readonly capabilities: readonly Capability[];
  };
  const rows = table.capabilities.filter((row) => row.package === 'events-daemon');

  assert.deepEqual(rows.map(rowShape), expectedRows);
  assert.equal(new Set(rows.map((row) => row.id)).size, EXPECTED_B1_ROWS.length);
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

test('PAR-B1: generated daemon references exactly describe the B1 registries', async () => {
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

  assert.doesNotMatch(cliPage, /\btarget resume\b/);
  assert.doesNotMatch(mcpPage, /\bevents_target_resume\b/);
  for (const tool of ['events_run', 'events_approve', 'events_dryrun_list', 'events_dryrun_show']) {
    assert.ok(!daemon.tools.includes(tool), `${tool} cannot expose a model-context content or authority boundary`);
  }

  await exec(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    join(ROOT, 'scripts', 'sync-reference.mjs'),
    '--check',
  ]);
});

test('PAR-B2: doctor remains the paired B1 operation and no B3/E public boundary is exposed', async () => {
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

  const forbiddenCommands = [
    'delivery retry',
    'delivery drop',
    'delivery hold',
    'subscriber list',
    'subscriber token create',
    'target secret create',
    'target url set',
    'target test',
    'target resume',
    'target replay',
    'judge test',
  ];
  const forbiddenTools = [
    'events_delivery_retry',
    'events_delivery_drop',
    'events_delivery_hold',
    'events_subscribers_list',
    'events_subscriber_token_create',
    'events_target_secret_create',
    'events_target_url_set',
    'events_target_test',
    'events_target_resume',
    'events_target_replay',
    'events_judge_test',
  ];
  for (const command of forbiddenCommands)
    assert.ok(!daemon.commands.includes(command), `${command} remains deferred beyond B2`);
  for (const tool of forbiddenTools) assert.ok(!daemon.tools.includes(tool), `${tool} remains deferred beyond B2`);
  for (const row of rows) {
    assert.ok(
      !/\b(?:delivery\.(?:retry|drop|hold)|subscriber|secret|migration|target\.(?:test|resume|replay)|judge)\b/.test(
        row.id,
      ),
      `${row.id} exposes a deferred B3/E capability`,
    );
  }
});
