import { createInterface } from 'node:readline/promises';
import {
  agentMarker,
  CommsError,
  canPrompt,
  escapeForDisplay,
  isCommsError,
  isDangerous,
  resolvePaths,
} from '@agentcomms/core';
import { Command, CommanderError } from 'commander';
import { createEventsMcpServer } from '../mcp/server.ts';
import { approvalView } from '../operations/approval-view.ts';
import {
  approve,
  disclosureChallenge,
  pendingRuleJudgeTest,
  pendingTargetTest,
  type TerminalApprovalStart,
} from '../operations/approve.ts';
import {
  B3_SECRET_TERMINAL_ORIGIN,
  type B3CliRegistrar,
  type B3ControlOperation,
  type B3PendingTargetSelectorV1,
  isB3SecretOperation,
  renderB3ApprovalPreviewV1,
} from '../operations/b3-contract.ts';
import { catalogueList, catalogueShow } from '../operations/catalogue.ts';
import { decideHeld, deliveriesList, dropDelivery, heldList, retryDelivery } from '../operations/deliveries.ts';
import { disableAll } from '../operations/disable-all.ts';
import { doctor } from '../operations/doctor.ts';
import { dryrunList, dryrunShow } from '../operations/dryrun.ts';
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
import { laneBind, laneList, laneUnbind } from '../operations/lanes.ts';
import { pause, resume } from '../operations/pause.ts';
import {
  queueClear,
  queueCounts,
  queueDismiss,
  queueDone,
  queueItems,
  queueList,
  queueReopen,
  queueShow,
} from '../operations/queue.ts';
import { ruleTest, ruleTestRetained } from '../operations/rule-test.ts';
import {
  createRule,
  disableRule,
  enableRule,
  removeRule,
  ruleShow,
  rulesList,
  updateRule,
} from '../operations/rules.ts';
import { run as runOwner } from '../operations/run.ts';
import {
  judgeKeyRotate,
  judgeKeySet,
  migrateSecrets,
  subscriberTokenCreate,
  subscriberTokenRotate,
  targetSecretCreate,
  targetSecretRotate,
  targetUrlSet,
} from '../operations/secrets.ts';
import { sourceShow, sourcesList } from '../operations/sources.ts';
import { status } from '../operations/status.ts';
import { stop } from '../operations/stop.ts';
import { addSubscriber, removeSubscriber, subscribersList, updateSubscriber } from '../operations/subscribers.ts';
import { targetResume } from '../operations/target-resume.ts';
import { targetTest } from '../operations/target-test.ts';
import { addTarget, removeTarget, targetsList, updateTarget } from '../operations/targets.ts';
import type { PendingRuleJudgeTestSelector } from '../runtime/b3-pending-rule-judge-test.ts';
import { requireLaneName, requireLaneWindowId } from '../runtime/lanes.ts';
import { parseQueueQuery, requireQueueItemId } from '../runtime/queue.ts';
import { assertHumanTerminal, renderDryRunList, renderDryRunRecord } from '../targets/dry-run.ts';
import { assertNotMcpServer, markMcpServerProcess, renderQueueItem, renderQueueList } from '../targets/queue.ts';
import { VERSION } from '../version.ts';

export interface EventsCliStreams {
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream & { readonly isTTY?: boolean };
}

export interface EventsCliDeps {
  readonly streams?: EventsCliStreams | undefined;
  readonly startMcp?: (() => Promise<void>) | undefined;
  /** Task 1 seam: later B3 commands share this typed owner path; it registers nothing yet. */
  readonly b3Registrar?: B3CliRegistrar | undefined;
  /** Test-only synthetic hidden-input seam. Production always uses the no-echo terminal reader below. */
  readonly readSecret?: ((prompt: string) => Promise<string>) | undefined;
  /** Tests supply an isolated marker environment; production uses the process environment. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

interface EventsCliOptions {
  readonly json?: boolean;
  readonly stateDir?: string;
  readonly configDir?: string;
}

/**
 * D13: a terminal never receives a raw control, bidi or invisible character, whatever a stored document holds. The JSON
 * keeps the exact data: every such character is written as its `\uXXXX` escape (a surrogate pair for an astral one),
 * which a terminal shows as text and any JSON reader decodes back to the same value.
 */
export function terminalSafeJson(value: unknown): string {
  let out = '';
  for (const char of JSON.stringify(value) ?? 'null') {
    if (!isDangerous(char.codePointAt(0) ?? 0)) {
      out += char;
      continue;
    }
    for (let index = 0; index < char.length; index += 1)
      out += `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`;
  }
  return out;
}

/** The approval preview a person reads before deciding: the B3 terminal renderer, with every dangerous character shown. */
export function renderApprovalViewForTerminal(result: unknown): string {
  return escapeForDisplay(renderB3ApprovalPreviewV1(result).terminal);
}

/**
 * An optional test the owner refused is reported and the approval goes on to its challenge (CUE-475): declining the
 * test was always allowed, so a test that could not run must not end the approval for the person.
 */
async function optionalTest(label: Record<string, number>, test: () => Promise<unknown>): Promise<unknown> {
  try {
    return await test();
  } catch (error) {
    if (!isCommsError(error)) throw error;
    return { ...label, test: 'not run', reason: error.message };
  }
}

/** Runs the only interactive terminal approval path; the owner, not this client, made every pending-target selector. */
export async function runTerminalApprovalFlow(input: {
  readonly approvalId: string;
  readonly terminal: { question(prompt: string): Promise<string> };
  readonly start: (approvalId: string) => Promise<TerminalApprovalStart>;
  readonly testPendingTarget: (selector: B3PendingTargetSelectorV1) => Promise<unknown>;
  readonly testPendingRuleJudge?: ((selector: PendingRuleJudgeTestSelector) => Promise<unknown>) | undefined;
  readonly approve: (approvalId: string, answer: string) => Promise<unknown>;
  readonly print: (result: unknown) => void;
}): Promise<void> {
  const start = await input.start(input.approvalId);
  for (let index = 0; index < start.pendingTargetSelectors.length; index += 1) {
    const selector = start.pendingTargetSelectors[index];
    if (selector === undefined) continue;
    const answer = await input.terminal.question(
      `Test pending target ${index + 1} with the fixed synthetic payload before approving? [y/N] `,
    );
    if (/^\s*(?:y|yes)\s*$/iu.test(answer))
      input.print(await optionalTest({ pendingTarget: index + 1 }, () => input.testPendingTarget(selector)));
  }
  for (let index = 0; index < start.pendingRuleJudgeTestSelectors.length; index += 1) {
    const selector = start.pendingRuleJudgeTestSelectors[index];
    if (selector === undefined) continue;
    const answer = await input.terminal.question(
      `Test pending rule judge ${index + 1} with the fixed synthetic payload before approving? [y/N] `,
    );
    const testPendingRuleJudge = input.testPendingRuleJudge;
    if (/^\s*(?:y|yes)\s*$/iu.test(answer) && testPendingRuleJudge !== undefined)
      input.print(await optionalTest({ pendingRuleJudge: index + 1 }, () => testPendingRuleJudge(selector)));
  }
  const answer = await input.terminal.question(
    `Type this approval challenge: ${escapeForDisplay(start.challenge)}\n> `,
  );
  input.print(await input.approve(input.approvalId, answer));
}

/** Retained dry-run listings as a person reads them: stored rule ids can hold any character a document allowed. */
export function renderDryRunListForTerminal(entries: Parameters<typeof renderDryRunList>[0]): string {
  return escapeForDisplay(renderDryRunList(entries));
}

/** One retained dry-run record as a person reads it; its body is already enveloped, its header ids are not. */
export function renderDryRunRecordForTerminal(record: Parameters<typeof renderDryRunRecord>[0]): string {
  return escapeForDisplay(renderDryRunRecord(record));
}

/** Runs the intentionally small Task B1 command surface. */
export async function run(argv: readonly string[], deps: EventsCliDeps = {}): Promise<number> {
  const streams = deps.streams ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  // The program's version is CLI metadata, not an operation. It is answered only as the sole argument: a program-wide
  // Commander `--version` would swallow the subcommands' own `--version <n>`, and positional parsing would break the
  // trailing `--json` every command documents.
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
    streams.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const env = deps.env ?? process.env;
  const program = new Command();
  runEnvironment.set(program, env);
  let ran = false;

  program
    .name('agent-events')
    .description('The local event-emission service: one foreground owner and local control clients.')
    .option('--json', 'write machine-readable output')
    .option('--no-color', 'never colour the output')
    .option('--config-dir <dir>', 'pin the configuration directory for this run')
    .option('--state-dir <dir>', 'pin the state directory for this run')
    .option('--data-dir <dir>', 'pin the data directory for this run')
    .option('--secrets-dir <dir>', 'pin the secrets directory for this run')
    .option('--downloads-dir <dir>', 'pin the downloads directory for this run')
    .configureOutput({
      writeOut: (text) => streams.stdout.write(escapeForDisplay(text)),
      writeErr: (text) => streams.stderr.write(escapeForDisplay(text)),
    })
    .exitOverride();

  program
    .command('status')
    .description('report whether the local event service has an owner')
    .action(async () => {
      ran = true;
      const result = await status(controlOptions(program));
      if (program.opts<EventsCliOptions>().json) streams.stdout.write(`${terminalSafeJson(result)}\n`);
      else streams.stdout.write(`Local event service owner: ${escapeForDisplay(String(result.owner))}\n`);
    });

  program
    .command('run')
    .description('start the foreground local event owner until it receives a clean stop request')
    .action(async () => {
      ran = true;
      await runOwner(controlOptions(program));
    });

  for (const [name, description, operation] of [
    ['stop', 'ask the foreground owner to stop cleanly', stop],
    ['pause', 'pause polling, evaluation and delivery claims without purging state', pause],
    ['resume', 'resume operational work retained by pause', resume],
    ['disable-all', 'disable collection, advance the global generation and purge B1 work', disableAll],
    ['enable-all', 'report the standing approval required before collection can be enabled', enableAll],
    [
      'doctor',
      'report content-free lineage, retry, recovery, judge authority, hold-clock and global switch health',
      doctor,
    ],
  ] as const) {
    program
      .command(name)
      .description(description)
      .action(async () => {
        ran = true;
        const result = await operation(controlOptions(program));
        if (program.opts<EventsCliOptions>().json) streams.stdout.write(`${terminalSafeJson(result)}\n`);
        else streams.stdout.write(`${terminalSafeJson(result)}\n`);
      });
  }

  const print = (result: unknown) => streams.stdout.write(`${terminalSafeJson(result)}\n`);
  const humanB3 = async (
    operation: B3ControlOperation,
    args: Record<string, unknown>,
    throughOwner: () => Promise<unknown>,
  ): Promise<unknown> =>
    deps.b3Registrar === undefined
      ? throughOwner()
      : deps.b3Registrar.owner.handle({
          operation,
          args,
          ...(isB3SecretOperation(operation) || operation === 'decideHeld'
            ? { origin: B3_SECRET_TERMINAL_ORIGIN }
            : {}),
        });
  const assertHuman = (): void => assertHumanTerminal(env, streams, program.opts<EventsCliOptions>().json === true);
  const hidden = async (prompt: string): Promise<string> =>
    deps.readSecret === undefined ? readHiddenTerminal(streams, prompt) : deps.readSecret(prompt);
  const printHumanResult = (result: unknown): void => {
    if (isTerminalSecretReveal(result)) {
      // This is deliberately the sole renderer that ever receives a generated credential.  It runs only after the
      // terminal gate and prints it once, followed by the receipt-shaped record that audit/log/result paths accept.
      streams.stdout.write(`Generated credential (shown once): ${result.terminalReveal}\n`);
      print(result.receipt);
      return;
    }
    if (isRenderedResult(result)) {
      streams.stdout.write(`${escapeForDisplay(result.rendered)}\n`);
      return;
    }
    if (isMigrationResult(result)) {
      streams.stdout.write(`Moved ${result.moved} event secret references.\n`);
      if (result.leftovers.length > 0) {
        streams.stdout.write('Leftover references (retry this migration before rotating):\n');
        for (const reference of result.leftovers) streams.stdout.write(`${escapeForDisplay(reference)}\n`);
      }
      return;
    }
    print(result);
  };
  const jsonArgument = (value: string, name: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      throw new CommsError('USAGE', `${name} must be valid JSON`);
    }
  };
  const catalogueArgument = (
    value: string,
  ): { readonly type: string; readonly version: number; readonly exampleIndex: number } => {
    const match = /^([a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+)@(\d+):(\d+)$/.exec(value);
    if (!match) throw new CommsError('USAGE', 'catalogue example must be type@version:index');
    const version = Number(match[2]);
    const exampleIndex = Number(match[3]);
    if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(exampleIndex) || exampleIndex < 0)
      throw new CommsError('USAGE', 'catalogue example must contain a positive version and a non-negative index');
    return { type: match[1] as string, version, exampleIndex };
  };

  const approval = program.command('approval').description('view the authoritative pending disclosure approval');
  approval
    .command('view <approval-id>')
    .requiredOption('--digest <digest>')
    .action(async (approvalId: string, options) => {
      ran = true;
      const result = await approvalView(approvalId, options.digest as string, controlOptions(program));
      if (program.opts<EventsCliOptions>().json) print(result);
      else streams.stdout.write(`${renderApprovalViewForTerminal(result)}\n`);
    });
  const catalogue = program.command('catalogue').description('inspect the local event catalogue');
  catalogue.command('list').action(async () => {
    ran = true;
    print(await catalogueList(controlOptions(program)));
  });
  catalogue.command('show <type>').action(async (type: string) => {
    ran = true;
    print(await catalogueShow(type, controlOptions(program)));
  });

  const sources = program.command('sources').description('inspect configured event sources');
  sources.command('list').action(async () => {
    ran = true;
    print(await sourcesList(controlOptions(program)));
  });
  program
    .command('source')
    .description('inspect one configured event source')
    .command('show <source>')
    .action(async (source: string) => {
      ran = true;
      print(await sourceShow(source, controlOptions(program)));
    });

  const rules = program.command('rules').description('inspect immutable local event rule versions');
  rules.command('list').action(async () => {
    ran = true;
    print(await rulesList(controlOptions(program)));
  });
  const rule = program.command('rule').description('create, inspect and control immutable event rules');
  rule.command('show <rule-id>').action(async (ruleId: string) => {
    ran = true;
    print(await ruleShow(ruleId, controlOptions(program)));
  });
  rule.command('create <document>').action(async (document: string) => {
    ran = true;
    print(await createRule(jsonArgument(document, 'rule document'), controlOptions(program)));
  });
  rule.command('update <document>').action(async (document: string) => {
    ran = true;
    print(await updateRule(jsonArgument(document, 'rule document'), controlOptions(program)));
  });
  rule.command('enable <rule-id> <version>').action(async (ruleId: string, version: string) => {
    ran = true;
    print(await enableRule(ruleId, parseVersion(version), controlOptions(program)));
  });
  for (const [name, operation] of [
    ['disable', disableRule],
    ['remove', removeRule],
  ] as const) {
    rule.command(`${name} <rule-id>`).action(async (ruleId: string) => {
      ran = true;
      print(await operation(ruleId, controlOptions(program)));
    });
  }
  rule.command('test <document> <catalogue-example>').action(async (document: string, catalogueExample: string) => {
    ran = true;
    print(
      await ruleTest(
        jsonArgument(document, 'rule document'),
        catalogueArgument(catalogueExample),
        controlOptions(program),
      ),
    );
  });
  rule
    .command('test-retained <event-id>')
    .requiredOption('--rule <rule-id>')
    .requiredOption('--version <version>')
    .action(async (eventId: string, options) => {
      ran = true;
      assertHuman();
      const ruleId = options.rule as string;
      const ruleVersion = parseVersion(options.version as string);
      printHumanResult(
        await humanB3('ruleTestRetained', { eventId, ruleId, ruleVersion }, () =>
          ruleTestRetained(eventId, ruleId, ruleVersion, controlOptions(program)),
        ),
      );
    });

  const targets = program.command('targets').description('inspect immutable local event target versions');
  targets.command('list').action(async () => {
    ran = true;
    print(await targetsList(controlOptions(program)));
  });
  const target = program.command('target').description('create, inspect and revoke immutable dry-run targets');
  for (const [name, operation] of [
    ['add', addTarget],
    ['update', updateTarget],
  ] as const) {
    target.command(`${name} <document>`).action(async (document: string) => {
      ran = true;
      print(await operation(jsonArgument(document, 'target document'), controlOptions(program)));
    });
  }
  target.command('remove <target-id>').action(async (targetId: string) => {
    ran = true;
    print(await removeTarget(targetId, controlOptions(program)));
  });
  target
    .command('test <target-id>')
    .requiredOption('--version <version>')
    .action(async (targetId: string, options) => {
      ran = true;
      print(await targetTest(targetId, parseVersion(options.version as string), controlOptions(program)));
    });
  target
    .command('resume <target-id>')
    .requiredOption('--version <version>')
    .action(async (targetId: string, options) => {
      ran = true;
      assertHuman();
      const targetVersion = parseVersion(options.version as string);
      printHumanResult(
        await humanB3('targetResume', { targetId, targetVersion }, () =>
          targetResume(targetId, targetVersion, controlOptions(program)),
        ),
      );
    });
  const targetSecret = target.command('secret').description('create or rotate terminal-only webhook signing material');
  targetSecret
    .command('create <target-id>')
    .requiredOption('--version <version>')
    .action(async (targetId: string, options) => {
      ran = true;
      assertHuman();
      const version = parseVersion(options.version as string);
      printHumanResult(
        await humanB3('targetSecretCreate', { targetId, version }, () =>
          targetSecretCreate(targetId, version, controlOptions(program)),
        ),
      );
    });
  targetSecret
    .command('rotate <target-id>')
    .requiredOption('--version <version>')
    .action(async (targetId: string, options) => {
      ran = true;
      assertHuman();
      const version = parseVersion(options.version as string);
      printHumanResult(
        await humanB3('targetSecretRotate', { targetId, version }, () =>
          targetSecretRotate(targetId, version, controlOptions(program)),
        ),
      );
    });
  const targetUrl = target
    .command('url')
    .description('set a concealed webhook URL into a new immutable target version');
  targetUrl
    .command('set <target-id>')
    .option('--predecessor-version <version>')
    .option('--draft <inert-target-document>')
    .requiredOption('--new-version <version>')
    .action(async (targetId: string, options) => {
      ran = true;
      assertHuman();
      const predecessorVersion =
        options.predecessorVersion === undefined ? undefined : parseVersion(options.predecessorVersion as string);
      const inertDraft =
        options.draft === undefined
          ? undefined
          : (jsonArgument(options.draft as string, 'inert target draft') as Record<string, unknown>);
      const newVersion = parseVersion(options.newVersion as string);
      const value = await hidden('Webhook URL');
      const args = {
        targetId,
        ...(predecessorVersion === undefined ? {} : { predecessorVersion }),
        ...(inertDraft === undefined ? {} : { inertDraft }),
        newVersion,
        hidden: value,
      };
      printHumanResult(
        await humanB3('targetUrlSet', args, () =>
          targetUrlSet(
            targetId,
            { predecessorVersion, inertDraft, newVersion },
            { ...controlOptions(program), hidden: value },
          ),
        ),
      );
    });

  const subscribers = program.command('subscribers').description('inspect immutable SSE subscriber versions');
  subscribers.command('list').action(async () => {
    ran = true;
    print(await subscribersList(controlOptions(program)));
  });
  const subscriber = program.command('subscriber').description('create, update, and revoke immutable SSE subscribers');
  subscriber.command('add <document>').action(async (document: string) => {
    ran = true;
    print(await addSubscriber(jsonArgument(document, 'subscriber document'), controlOptions(program)));
  });
  subscriber.command('update <document>').action(async (document: string) => {
    ran = true;
    print(await updateSubscriber(jsonArgument(document, 'subscriber document'), controlOptions(program)));
  });
  subscriber.command('remove <subscriber-id>').action(async (subscriberId: string) => {
    ran = true;
    print(await removeSubscriber(subscriberId, controlOptions(program)));
  });
  const subscriberToken = subscriber.command('token').description('create or rotate a terminal-only SSE bearer token');
  for (const [name, operation, request] of [
    ['create', subscriberTokenCreate, 'subscriberTokenCreate'],
    ['rotate', subscriberTokenRotate, 'subscriberTokenRotate'],
  ] as const) {
    subscriberToken
      .command(`${name} <subscriber-id>`)
      .requiredOption('--version <version>')
      .action(async (subscriberId: string, options) => {
        ran = true;
        assertHuman();
        const version = parseVersion(options.version as string);
        printHumanResult(
          await humanB3(request, { subscriberId, version }, () =>
            operation(subscriberId, version, controlOptions(program)),
          ),
        );
      });
  }

  const judges = program.command('judges').description('inspect immutable content-free judge metadata');
  judges.command('list').action(async () => {
    ran = true;
    print(await judgesList(controlOptions(program)));
  });
  const judge = program.command('judge').description('manage immutable judges and run fixed synthetic tests');
  judge.command('add <document>').action(async (document: string) => {
    ran = true;
    const parsed = jsonArgument(document, 'judge document');
    print(await humanB3('addJudge', { document: parsed }, () => addJudge(parsed, controlOptions(program))));
  });
  judge.command('update <document>').action(async (document: string) => {
    ran = true;
    const parsed = jsonArgument(document, 'judge document');
    print(await humanB3('updateJudge', { document: parsed }, () => updateJudge(parsed, controlOptions(program))));
  });
  judge.command('remove <judge-id>').action(async (judgeId: string) => {
    ran = true;
    print(await humanB3('removeJudge', { judgeId }, () => removeJudge(judgeId, controlOptions(program))));
  });
  judge
    .command('test <judge-id>')
    .requiredOption('--version <version>')
    .action(async (judgeId: string, options) => {
      ran = true;
      print(await judgeTest(judgeId, parseVersion(options.version as string), controlOptions(program)));
    });
  const budget = program.command('budget').description('inspect or prepare the immutable global judge budget');
  budget.command('show').action(async () => {
    ran = true;
    print(await budgetShow(controlOptions(program)));
  });
  budget.command('update <document>').action(async (document: string) => {
    ran = true;
    const parsed = jsonArgument(document, 'budget document');
    print(await humanB3('updateBudget', { document: parsed }, () => updateBudget(parsed, controlOptions(program))));
  });
  const judgeKinds = judge
    .command('kinds')
    .description('list each judge kind as disabled or enabled, or Laya as unavailable here with its reason');
  judgeKinds.command('list').action(async () => {
    ran = true;
    print(await judgeKindsList(controlOptions(program)));
  });
  const judgeKind = judge.command('kind').description('prepare enablement or immediately disable one judge kind');
  judgeKind.command('enable <kind>').action(async (kind: string) => {
    ran = true;
    print(await humanB3('enableJudgeKind', { kind }, () => enableJudgeKind(kind, controlOptions(program))));
  });
  judgeKind.command('disable <kind>').action(async (kind: string) => {
    ran = true;
    print(await humanB3('disableJudgeKind', { kind }, () => disableJudgeKind(kind, controlOptions(program))));
  });
  const judgeModel = judge
    .command('model')
    .description('report the local Laya runtime and model state, or remove its files while Laya is disabled');
  judgeModel.command('status').action(async () => {
    ran = true;
    print(await judgeModelStatus(controlOptions(program)));
  });
  judgeModel.command('remove').action(async () => {
    ran = true;
    print(await removeJudgeModel(controlOptions(program)));
  });
  const judgeKey = judge.command('key').description('set or rotate a terminal-only hosted judge credential');
  for (const [name, operation, request] of [
    ['set', judgeKeySet, 'judgeKeySet'],
    ['rotate', judgeKeyRotate, 'judgeKeyRotate'],
  ] as const) {
    judgeKey
      .command(`${name} <judge-id>`)
      .requiredOption('--version <version>')
      .action(async (judgeId: string, options) => {
        ran = true;
        assertHuman();
        const version = parseVersion(options.version as string);
        const value = await hidden('Judge key');
        printHumanResult(
          await humanB3(request, { judgeId, version, hidden: value }, () =>
            operation(judgeId, version, { ...controlOptions(program), hidden: value }),
          ),
        );
      });
  }

  const deliveries = program.command('deliveries').description('inspect content-free delivery metadata');
  deliveries.command('list').action(async () => {
    ran = true;
    print(await deliveriesList(controlOptions(program)));
  });
  const delivery = program.command('delivery').description('retry or drop one exact delivery');
  delivery.command('retry <delivery-id>').action(async (deliveryId: string) => {
    ran = true;
    print(await retryDelivery(deliveryId, controlOptions(program)));
  });
  delivery.command('drop <delivery-id>').action(async (deliveryId: string) => {
    ran = true;
    print(await dropDelivery(deliveryId, controlOptions(program)));
  });
  const held = program.command('held').description('inspect typed held decisions');
  held.command('list').action(async () => {
    ran = true;
    print(await heldList(controlOptions(program)));
  });
  held.command('decide <decision-id> <accept|reject>').action(async (decisionId: string, decision: string) => {
    ran = true;
    assertHuman();
    if (decision !== 'accept' && decision !== 'reject')
      throw new CommsError('USAGE', 'held decision is accept or reject');
    printHumanResult(
      await humanB3('decideHeld', { decisionId, decision }, () =>
        decideHeld(decisionId, decision, controlOptions(program)),
      ),
    );
  });

  const dryrun = program.command('dryrun').description('inspect retained local records at an interactive terminal');
  dryrun.command('list').action(async () => {
    ran = true;
    assertHumanTerminal(env, streams, program.opts<EventsCliOptions>().json === true);
    streams.stdout.write(`${renderDryRunListForTerminal(await dryrunList(controlOptions(program)))}\n`);
  });
  dryrun.command('show <delivery-id>').action(async (deliveryId: string) => {
    ran = true;
    assertHumanTerminal(env, streams, program.opts<EventsCliOptions>().json === true);
    streams.stdout.write(`${renderDryRunRecordForTerminal(await dryrunShow(deliveryId, controlOptions(program)))}\n`);
  });

  // The action queue (action queue design §4.4, §8). list and show give a person the content, at a terminal or in the
  // app (which runs them with --json); they refuse inside an MCP server's process (Q1). The rest are content-free.
  const queue = program
    .command('queue')
    .description('work through the action queue: what matched your queue rules, and what you have done with it');
  const queueFilters = (options: Record<string, unknown>, withSince: boolean) => {
    const filters = {
      ...(options.state === undefined ? {} : { state: options.state as string }),
      ...(options.rule === undefined ? {} : { rule: options.rule as string }),
      ...(options.channel === undefined ? {} : { channel: options.channel as string }),
      ...(withSince && options.since !== undefined ? { since: options.since as string } : {}),
      ...(options.limit === undefined ? {} : { limit: parseLimit(options.limit as string) }),
    };
    // The owner parses these again; checking here first gives a bad argument its exit (64) without the owner.
    parseQueueQuery(filters, Date.now(), { since: withSince });
    return filters;
  };
  const printQueue = (result: unknown, render: () => string): void => {
    if (program.opts<EventsCliOptions>().json) print(result);
    else streams.stdout.write(`${escapeForDisplay(render())}\n`);
  };
  queue
    .command('list')
    .description('list queue items with what they say, newest first (a person at a terminal or in the app)')
    .option('--state <state>', 'open (the default), done, dismissed or all')
    .option('--rule <rule-id>', 'only this rule')
    .option('--channel <channel>', 'gmail, slack, resend or whatsapp')
    .option('--since <when>', 'an ISO time, or a span back from now such as 7d or 12h')
    .option('--limit <n>', 'at most this many items (1 to 500, default 50)')
    .action(async (options: Record<string, unknown>) => {
      ran = true;
      assertNotMcpServer(env);
      const result = await queueList(queueFilters(options, true), controlOptions(program));
      printQueue(result, () => renderQueueList(result));
    });
  queue
    .command('show <item-id>')
    .description('show one queue item with what it says (a person at a terminal or in the app)')
    .action(async (itemId: string) => {
      ran = true;
      assertNotMcpServer(env);
      const result = await queueShow(requireQueueItemId(itemId), controlOptions(program));
      printQueue(result, () => renderQueueItem(result.item));
    });
  queue
    .command('items')
    .description('list queue items without what they say: ids, rules, channels, accounts, states and times')
    .option('--state <state>', 'open (the default), done, dismissed or all')
    .option('--rule <rule-id>', 'only this rule')
    .option('--channel <channel>', 'gmail, slack, resend or whatsapp')
    .option('--limit <n>', 'at most this many items (1 to 500, default 50)')
    .action(async (options: Record<string, unknown>) => {
      ran = true;
      print(await queueItems(queueFilters(options, false), controlOptions(program)));
    });
  queue
    .command('counts')
    .description('count open, done and dismissed queue items, and each rule’s open items')
    .action(async () => {
      ran = true;
      print(await queueCounts(controlOptions(program)));
    });
  for (const [name, description, operation] of [
    ['done', 'mark one queue item done', queueDone],
    ['dismiss', 'dismiss one queue item', queueDismiss],
    ['reopen', 'reopen a done or dismissed queue item', queueReopen],
  ] as const) {
    queue
      .command(`${name} <item-id>`)
      .description(description)
      .action(async (itemId: string) => {
        ran = true;
        print(await operation(requireQueueItemId(itemId), controlOptions(program)));
      });
  }
  queue
    .command('clear')
    .description('remove done and dismissed queue items now; open items stay (a person at a terminal or in the app)')
    .action(async () => {
      ran = true;
      // An agent must not be able to make the person's queue disappear: clear is the terminal's and the app's.
      assertNotMcpServer(env, 'clear');
      print(await queueClear(controlOptions(program)));
    });

  // Routing's lanes (routing design 2026-10-25, §6): every lane and the window bound to it, binding — the person's act
  // at a terminal, which refuses inside the event service's MCP server (B1) — and unbinding, applied at once.
  const lane = program
    .command('lane')
    .description(
      'bind a lane — a queue your rules send to — to the one agent window woken for its items, and unbind it',
    );
  lane
    .command('list')
    .description('list every lane, its rules, channels and open items, and the agent window bound to it')
    .action(async () => {
      ran = true;
      print(await laneList(controlOptions(program)));
    });
  lane
    .command('bind <lane>')
    .description('bind a lane to one agent window, by the id events_lane_whoami gives (a person at a terminal)')
    .requiredOption('--window <id>', "the window's Claude Code session id, or its activity session key")
    .action(async (name: string, options: Record<string, unknown>) => {
      ran = true;
      assertNotMcpServer(env, 'bind');
      print(await laneBind(requireLaneName(name), requireLaneWindowId(options.window), controlOptions(program)));
    });
  lane
    .command('unbind <lane>')
    .description('unbind a lane from its window at once; its watches end')
    .action(async (name: string) => {
      ran = true;
      print(await laneUnbind(requireLaneName(name), controlOptions(program)));
    });

  program
    .command('approve <approval-id>')
    .description('approve a standing disclosure by typing its challenge at this terminal, after optional target tests')
    .action(async (approvalId: string) => {
      ran = true;
      const options = program.opts<EventsCliOptions>();
      const marker = agentMarker(env);
      if (marker !== null)
        throw new CommsError('APPROVAL_REQUIRED', 'only a person can approve standing disclosure, not an agent', {
          details: { marker },
        });
      if (!canPrompt(env, streams, { json: options.json === true })) {
        throw new CommsError('APPROVAL_REQUIRED', 'approving standing disclosure needs an interactive terminal');
      }
      const terminal = createInterface({ input: streams.stdin, output: streams.stdout });
      try {
        await runTerminalApprovalFlow({
          approvalId,
          terminal,
          start: (id) => disclosureChallenge(id, controlOptions(program)),
          testPendingTarget: (selector) => pendingTargetTest(selector, controlOptions(program)),
          testPendingRuleJudge: (selector) => pendingRuleJudgeTest(selector, controlOptions(program)),
          approve: (id, answer) => approve(id, answer, controlOptions(program)),
          print,
        });
      } finally {
        terminal.close();
      }
    });

  program
    .command('mcp')
    .description('serve the MCP interface over standard input and output')
    .action(async () => {
      ran = true;
      // Every program this server starts inherits the mark, so none of them can read the queue's content (Q1).
      markMcpServerProcess(env, 'events');
      if (deps.startMcp) await deps.startMcp();
      else await (await createEventsMcpServer(controlOptions(program))).connectStdio();
    });

  const secrets = program.command('secrets').description('migrate the daemon-owned secret backend at a human terminal');
  secrets
    .command('migrate')
    .requiredOption('--to <keychain|file>')
    .action(async (options) => {
      ran = true;
      assertHuman();
      const to = options.to as string;
      if (to !== 'file' && to !== 'keychain')
        throw new CommsError('USAGE', 'secret migration destination is file or keychain');
      printHumanResult(await humanB3('migrateSecrets', { to }, () => migrateSecrets(to, controlOptions(program))));
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
    if (!ran) program.outputHelp();
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (isCommsError(error)) {
      streams.stderr.write(`${escapeForDisplay(error.message)}\n`);
      if (error.hint !== undefined) streams.stderr.write(`${escapeForDisplay(error.hint)}\n`);
      return error.exitCode;
    }
    streams.stderr.write(`${escapeForDisplay(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}

/**
 * The state directory a control client looks in: the one pinned for this run, or the one the environment this CLI was
 * given resolves to. A caller that passes its own `env` to `run` reaches its own owner, never the one the process
 * environment names.
 */
function controlOptions(program: Command): { stateDir?: string } {
  const { stateDir } = program.opts<EventsCliOptions>();
  if (stateDir !== undefined) return { stateDir };
  const env = runEnvironment.get(program);
  return env === undefined ? {} : { stateDir: resolvePaths({ env }).stateDir };
}

/** The environment each program was made with, read by `controlOptions` outside `run`'s closure. */
const runEnvironment = new WeakMap<Command, NodeJS.ProcessEnv>();

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(limit)) throw new CommsError('USAGE', '--limit is a whole number');
  return limit;
}

function parseVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new CommsError('USAGE', 'rule version must be a positive integer');
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRenderedResult(value: unknown): value is { readonly rendered: string } {
  return isRecord(value) && typeof value.rendered === 'string';
}

function isMigrationResult(value: unknown): value is { readonly moved: number; readonly leftovers: readonly string[] } {
  return (
    isRecord(value) &&
    typeof value.moved === 'number' &&
    Array.isArray(value.leftovers) &&
    value.leftovers.every((reference) => typeof reference === 'string')
  );
}

function isTerminalSecretReveal(
  value: unknown,
): value is { readonly receipt: Record<string, unknown>; readonly terminalReveal: string } {
  return isRecord(value) && isRecord(value.receipt) && typeof value.terminalReveal === 'string';
}

/** Reads one terminal-only value in raw mode. Nothing is echoed, written to a history, or accepted from a pipe. */
function readHiddenTerminal(streams: EventsCliStreams, prompt: string): Promise<string> {
  const input = streams.stdin as EventsCliStreams['stdin'] & {
    setRawMode?: (enabled: boolean) => void;
    resume?: () => void;
  };
  if (input.setRawMode === undefined)
    return Promise.reject(new CommsError('APPROVAL_REQUIRED', 'secret input needs an interactive terminal'));
  streams.stdout.write(`${prompt}: `);
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const done = (error?: Error): void => {
      input.off('data', onData);
      input.off('error', onError);
      input.setRawMode?.(false);
      streams.stdout.write('\n');
      if (error !== undefined) reject(error);
      else if (value.length === 0) reject(new CommsError('USAGE', 'secret input is required'));
      else resolve(value);
    };
    const onError = (error: Error): void => done(error);
    const onData = (chunk: string | Uint8Array): void => {
      for (const character of Buffer.from(chunk).toString('utf8')) {
        if (character === '\r' || character === '\n') {
          done();
          return;
        }
        if (character === '\u0003') {
          done(new CommsError('APPROVAL_REQUIRED', 'secret input was cancelled'));
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on('data', onData);
    input.once('error', onError);
    input.setRawMode?.(true);
    input.resume?.();
  });
}
