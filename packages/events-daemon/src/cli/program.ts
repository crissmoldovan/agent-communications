import { createInterface } from 'node:readline/promises';
import {
  agentMarker,
  CommsError,
  canPrompt,
  type DesktopOrigin,
  desktopAppOrigin,
  escapeForDisplay,
  isCommsError,
  isDangerous,
  resolvePaths,
} from '@agentcomms/core';
import { Command, CommanderError, Option } from 'commander';
import { ANALYSE_PROVIDERS, isAnalyseProvider } from '../domain/analyse-model.ts';
import {
  DESCRIBE_LIMITS,
  DESCRIBE_PROVIDERS,
  type DescribeProvider,
  isDescribeProvider,
  parseDescribeRequest,
} from '../domain/describe-brief.ts';
import {
  changeAtTerminal,
  isSetupJudgeKind,
  localSetupEndpoint,
  localSetupModel,
  PERSON_SETUP_ORIGINS,
  type PersonSetupOrigin,
  ruleApprovalWords,
  testBuildOutsideProfile,
} from '../domain/judge-setup.ts';
import { isJevProvider } from '../domain/judges.ts';
import type { LaneListResultV1 } from '../domain/lanes.ts';
import { JUDGE_KIND_TYPESAFE } from '../domain/lifecycle.ts';
import { EVENT_SECRET_PROVIDER_WORDS, isEventSecretProvider } from '../domain/providers.ts';
import { approvalViewForAgent } from '../mcp/agent-approval-view.ts';
import { createEventsMcpServer } from '../mcp/server.ts';
import { integrationSet, sessionQueueDrop, sessionQueueList } from '../operations/agent-sessions.ts';
import { ruleAnalyse } from '../operations/analyse.ts';
import { approvalView } from '../operations/approval-view.ts';
import {
  approve,
  approveEnableAllFromApp,
  approveRuleFromApp,
  disclosureChallenge,
  pendingRuleJudgeTest,
  pendingTargetTest,
  type TerminalApprovalStart,
} from '../operations/approve.ts';
import {
  B3_SECRET_TERMINAL_ORIGIN,
  type B3ApprovalPreviewContext,
  type B3CliRegistrar,
  type B3ControlOperation,
  type B3PendingTargetSelectorV1,
  isB3SecretOperation,
  renderB3ApprovalPreviewV1,
} from '../operations/b3-contract.ts';
import { catalogueList, catalogueShow } from '../operations/catalogue.ts';
import {
  decideHeld,
  deliveriesList,
  deliveryShow,
  dropDelivery,
  heldList,
  retryDelivery,
} from '../operations/deliveries.ts';
import { disableAll } from '../operations/disable-all.ts';
import { doctor } from '../operations/doctor.ts';
import { dryrunList, dryrunShow } from '../operations/dryrun.ts';
import { enableAll } from '../operations/enable-all.ts';
import { integrationShow } from '../operations/integrations.ts';
import {
  addJudge,
  budgetShow,
  disableJudgeKind,
  enableJudgeKind,
  judgeKindsList,
  judgeModelStatus,
  judgeSetup,
  judgeShow,
  judgesList,
  judgeTest,
  removeJudge,
  removeJudgeModel,
  updateBudget,
  updateJudge,
} from '../operations/judges.ts';
import { laneBind, laneList, laneUnbind } from '../operations/lanes.ts';
import { messageShow, messagesList } from '../operations/messages.ts';
import { pause, resume } from '../operations/pause.ts';
import {
  projectAdd,
  projectRemove,
  projectScan,
  projectShow,
  projectsList,
  projectUpdate,
} from '../operations/projects.ts';
import { providerKeyRemove, providerKeySet, providerList } from '../operations/providers.ts';
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
import { ruleCheck } from '../operations/rule-check.ts';
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
import { runCancel, runShow, runsList } from '../operations/runs.ts';
import {
  judgeKeyRotate,
  judgeKeySet,
  migrateSecrets,
  subscriberSecretCreate,
  subscriberSecretRotate,
  subscriberTokenCreate,
  subscriberTokenRotate,
  subscriberUrlSet,
  targetSecretCreate,
  targetSecretRotate,
  targetUrlSet,
} from '../operations/secrets.ts';
import { sourceShow, sourcesList } from '../operations/sources.ts';
import { status } from '../operations/status.ts';
import { stop } from '../operations/stop.ts';
import {
  addSubscriber,
  approveSubscriberFromApp,
  enableSubscriber,
  removeSubscriber,
  subscribersList,
  updateSubscriber,
} from '../operations/subscribers.ts';
import { targetResume } from '../operations/target-resume.ts';
import { targetTest } from '../operations/target-test.ts';
import { addTarget, removeTarget, targetsList, updateTarget } from '../operations/targets.ts';
import { workflowDescribe } from '../operations/workflow-describe.ts';
import { workflowEventsList, workflowEventsShow } from '../operations/workflow-events.ts';
import type { PendingRuleJudgeTestSelector } from '../runtime/b3-pending-rule-judge-test.ts';
import { parseJudgeShowArguments } from '../runtime/judge-show.ts';
import { requireLaneName, requireLaneWindowId } from '../runtime/lanes.ts';
import { parseMessagesQuery, requireEventId } from '../runtime/messages.ts';
import { parseQueueQuery, requireQueueItemId } from '../runtime/queue.ts';
import { ANALYSE_DRAFT_MAX_BYTES, parseRuleAnalyseArguments } from '../runtime/rule-analyse.ts';
import { withinTestProfile } from '../runtime/test-profile.ts';
import { RUN_STATES, type RunState } from '../runtime/workflow/run-show.ts';
import { assertHumanTerminal, dryRunRecordAsData, renderDryRunList, renderDryRunRecord } from '../targets/dry-run.ts';
import {
  assertNotMcpServer,
  MCP_SERVER_MARKER,
  markMcpServerProcess,
  renderQueueItem,
  renderQueueList,
} from '../targets/queue.ts';
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
  /** Test-only: where this process came from (core's `desktopAppOrigin`), which production always asks. */
  readonly desktopOrigin?: (() => Promise<DesktopOrigin>) | undefined;
  /** Test-only: a shorter deadline for the person's own `claude` than Describe it's 120 seconds. */
  readonly claudeDeadlineMs?: number | undefined;
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
export function renderApprovalViewForTerminal(result: unknown, context: B3ApprovalPreviewContext = {}): string {
  return escapeForDisplay(renderB3ApprovalPreviewV1(result, context).terminal);
}

/** Whether a ready view's rule adds a Linear issue: only then does the terminal ask whether a Linear key is kept. */
function previewHasLinear(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const view = result as {
    readonly kind?: unknown;
    readonly preview?: { readonly rule?: { readonly targets?: unknown } };
  };
  const targets = view.kind === 'READY' ? view.preview?.rule?.targets : undefined;
  return (
    Array.isArray(targets) &&
    targets.some(
      (target) => typeof target === 'object' && target !== null && (target as { kind?: unknown }).kind === 'linear',
    )
  );
}

/** Whether a ready view's rule sends to a lane: only then does the terminal read which window each lane is bound to. */
function previewHasLane(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const view = result as {
    readonly kind?: unknown;
    readonly preview?: { readonly rule?: { readonly targets?: unknown } };
  };
  const targets = view.kind === 'READY' ? view.preview?.rule?.targets : undefined;
  return (
    Array.isArray(targets) &&
    targets.some((target) => typeof target === 'object' && target !== null && 'lane' in (target as object))
  );
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
  // A document given as `-` is read from stdin (0.33.0 design §3.1): the desktop app hands the rule its editor made,
  // and each target it needs, to `rule create|update -` and `target add|update -` there, so no document rides in argv.
  const documentArgument = async (value: string, name: string): Promise<unknown> =>
    value === '-' ? jsonArgument(await stdinDocument(streams, name), name) : jsonArgument(value, name);
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
      // An agent's shell, or a program inside the event service's MCP server, gets the agent view: the preview alone,
      // with no challenge issued or shown, as events_approval_view gives it (security review of 0.34.0, finding 3). A
      // marker is a speed bump: a shell without one runs as the person.
      if (agentMarker(env) !== null || (env[MCP_SERVER_MARKER] ?? '') !== '') {
        print(
          approvalViewForAgent(
            await approvalView(approvalId, options.digest as string, { ...controlOptions(program), agentView: true }),
          ),
        );
        return;
      }
      const result = await approvalView(approvalId, options.digest as string, controlOptions(program));
      if (program.opts<EventsCliOptions>().json) print(result);
      else {
        // A rule that sends to a lane already bound adds what that window will read: the preview names the window.
        let lanes: B3ApprovalPreviewContext['lanes'];
        if (previewHasLane(result)) {
          try {
            lanes = ((await laneList(controlOptions(program))) as LaneListResultV1).lanes;
          } catch {
            lanes = undefined;
          }
        }
        // A Linear target's team and labels are checked against Linear only while a Linear key is kept: say when not.
        let linearConnected: boolean | undefined;
        if (previewHasLinear(result)) {
          try {
            const listed = (await providerList(controlOptions(program))) as {
              readonly providers: readonly { readonly id: string; readonly hasKey: boolean }[];
            };
            linearConnected = listed.providers.some((entry) => entry.id === 'linear' && entry.hasKey);
          } catch {
            linearConnected = undefined;
          }
        }
        streams.stdout.write(`${renderApprovalViewForTerminal(result, { lanes, linearConnected })}\n`);
      }
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

  // One word (workflows design 2026-10-27, W22): a workflow is what the event service stores as a rule version, and the
  // command line says so. `rules` and `rule` stay as aliases, so scripts and the desktop app keep working; the variable
  // names, like every identifier inside, keep saying rule.
  const rules = program.command('workflows').alias('rules').description('inspect immutable local workflow versions');
  rules.command('list').action(async () => {
    ran = true;
    print(await rulesList(controlOptions(program)));
  });
  const rule = program.command('workflow').alias('rule').description('create, inspect and control immutable workflows');
  rule
    .command('show <workflow-id>')
    .option('--version <version>', 'that one version alone, as a run of it draws its graph')
    .action(async (ruleId: string, options: { readonly version?: string }) => {
      ran = true;
      print(
        await ruleShow(ruleId, {
          ...controlOptions(program),
          ...(options.version === undefined ? {} : { version: parseVersion(options.version) }),
        }),
      );
    });
  rule.command('create <document>').action(async (document: string) => {
    ran = true;
    print(await createRule(await documentArgument(document, 'workflow document'), controlOptions(program)));
  });
  rule.command('update <document>').action(async (document: string) => {
    ran = true;
    print(await updateRule(await documentArgument(document, 'workflow document'), controlOptions(program)));
  });
  rule.command('enable <workflow-id> <version>').action(async (ruleId: string, version: string) => {
    ran = true;
    print(await enableRule(ruleId, parseVersion(version), controlOptions(program)));
  });
  for (const [name, operation] of [
    ['disable', disableRule],
    ['remove', removeRule],
  ] as const) {
    rule.command(`${name} <workflow-id>`).action(async (ruleId: string) => {
      ran = true;
      print(await operation(ruleId, controlOptions(program)));
    });
  }
  rule.command('test <document> <catalogue-example>').action(async (document: string, catalogueExample: string) => {
    ran = true;
    // A workflow with a flow is walked over the example (0.36.0 §7.7): each step named answers as asked, every other
    // with its first outcome. `-` reads the document from stdin, as the app gives it.
    const outcomes = outcomeArguments(ruleTestCommand.opts<{ readonly outcome: string[] }>().outcome);
    print(
      await ruleTest(await documentArgument(document, 'workflow document'), catalogueArgument(catalogueExample), {
        ...controlOptions(program),
        ...(outcomes === undefined ? {} : { outcomes }),
      }),
    );
  });
  // The command just made: the guarded line above is left as it is, and its option is added here.
  const ruleTestCommand = rule.commands.at(-1) as Command;
  ruleTestCommand
    .description('try a workflow on a catalogue example; a flow is walked, each effect a would, with no I/O')
    .option(
      '--outcome <step=outcome>',
      'the outcome a step of the flow answers with (repeat for more); every other step answers its first',
      collect,
      [],
    );
  rule
    .command('test-retained <event-id>')
    .addOption(new Option('--workflow <workflow-id>'))
    .addOption(new Option('--rule <workflow-id>').hideHelp())
    .requiredOption('--version <version>')
    .action(async (eventId: string, options, command: Command) => {
      ran = true;
      // `--workflow` is required, and the hidden `--rule` it replaced still names the same workflow (W22). Checked
      // before the terminal is, as Commander checks a required option.
      const ruleId = workflowOption(options, command, true) as string;
      assertHuman();
      const ruleVersion = parseVersion(options.version as string);
      printHumanResult(
        await humanB3('ruleTestRetained', { eventId, ruleId, ruleVersion }, () =>
          ruleTestRetained(eventId, ruleId, ruleVersion, controlOptions(program)),
        ),
      );
    });
  rule
    .command('check <document>')
    .description('check a workflow document as the event service reads it, every problem named; - reads it from stdin')
    .action(async (document: string) => {
      ran = true;
      print(await ruleCheck(await documentArgument(document, 'workflow document'), controlOptions(program)));
    });
  // A workflow's runs (0.36.0 workflows design §7.6, §11.1): `runs`, not `run`, which starts the service. Each command is
  // the person's alone, from the app or their terminal: personSetupOrigin refuses the event service's MCP server, an
  // agent's shell and, on macOS, a process the app did not start, before anything is asked; the owner takes them only
  // from the person's origin; and no tool reads or cancels a run.
  const asPersonForRuns = (what: string) =>
    personSetupOrigin(what, {
      where: "Events → Workflows, a workflow's Runs",
      action: 'runs',
      terminal: 'output',
      // Nothing here loosens anything: a list and a run are read, and a cancel is a tightening.
      unattested: 'accept',
    });
  const runs = program
    .command('runs')
    .description("a workflow's runs: list them, show one, cancel one (a person only)");
  runs
    .command('list')
    .description(
      'list the runs, newest first, at most 200: their state, version and what each waits on (a person only)',
    )
    .option('--workflow <workflow-id>', "only this workflow's runs")
    .option('--state <state>', `only the runs in this state: ${RUN_STATES.join(', ')}`)
    .action(async (options: { readonly workflow?: string; readonly state?: string }) => {
      ran = true;
      const origin = await asPersonForRuns("list your workflows' runs");
      if (options.state !== undefined && !(RUN_STATES as readonly string[]).includes(options.state))
        throw new CommsError('USAGE', `a run's state is ${RUN_STATES.join(', ')}`);
      print(
        await runsList({
          ...controlOptions(program),
          origin,
          ruleId: options.workflow,
          state: options.state as RunState | undefined,
        }),
      );
    });
  runs
    .command('show <run-id>')
    .description(
      "show one run of the version it started on: its path, each step's outcome, output and wait, and the events it raised (a person only)",
    )
    .action(async (runId: string) => {
      ran = true;
      const origin = await asPersonForRuns('see a run');
      print(await runShow(runId, { ...controlOptions(program), origin }));
    });
  runs
    .command('cancel <run-id>')
    .description(
      'cancel a live run at once: its waiting deliveries and undelivered events are cancelled and what it kept purged (a person only)',
    )
    .option('--interrupt', 'also interrupt the turn it gave a session; without it, that turn runs on')
    .action(async (runId: string, options: { readonly interrupt?: boolean }) => {
      ran = true;
      const origin = await asPersonForRuns('cancel a run');
      print(await runCancel(runId, { interrupt: options.interrupt === true }, { ...controlOptions(program), origin }));
    });

  rule
    .command('analyse <workflow-id>')
    .description(
      "suggest improvements to a workflow, or to a draft of it, from its own text and its last 30 days' content-free counts (a person)",
    )
    .option(
      '--draft <source>',
      'analyse a draft workflow document instead of the stored version: - reads it from stdin',
    )
    .option('--provider <provider>', `the provider Analyse's model runs on: ${ANALYSE_PROVIDERS.join(' or ')}`)
    .action(async (ruleId: string, options: Record<string, unknown>) => {
      ran = true;
      // Analyse is a person's act (0.33.0 §3.3): it runs when they press it, on their own key. As `provider key set`
      // is, it is taken only from the Agent Comms app (attested on macOS) or an interactive terminal — one whose output
      // the person reads, since a draft may come on stdin — and an agent's shell and the MCP server are refused before
      // anything is read or sent (security review of 0.33.0, finding 10).
      await personSetupOrigin('analyse a rule', {
        where: 'Events → Rules, Analyse',
        action: 'analyse',
        terminal: 'output',
        // It changes nothing: Windows and Linux keep `provider key set`'s former rule for it (second look of 0.33.0).
        unattested: 'accept',
      });
      const provider = options.provider as string | undefined;
      if (provider !== undefined && !isAnalyseProvider(provider))
        throw new CommsError('USAGE', `Analyse's provider is ${ANALYSE_PROVIDERS.join(' or ')}`);
      let draft: Readonly<Record<string, unknown>> | undefined;
      if (options.draft !== undefined) {
        if (options.draft !== '-') throw new CommsError('USAGE', '--draft reads the draft from stdin: give it -');
        draft = await draftInput(streams);
      }
      // The owner reads these again; checking here first gives a bad argument its exit (64) without the owner.
      parseRuleAnalyseArguments({ ruleId, ...(draft === undefined ? {} : { draft }), provider });
      print(await ruleAnalyse(ruleId, { ...controlOptions(program), draft, provider }));
    });

  // Describe it (0.36.0 workflows design §11.4, W21): the person's words drafted into a workflow, written nowhere. It is
  // the person's, as Analyse is: from the app (attested on macOS) or a terminal whose output they read; the event
  // service's MCP server, an agent's shell and, on macOS, a process the app did not start are refused before anything
  // is read or sent. Their own `claude` runs here, in this process, never in the event service.
  rule
    .command('describe')
    .description(
      'draft a workflow from your words on stdin — { words, example?, answers?, draft? } as JSON, or the words alone — by your Claude, OpenRouter or Anthropic; nothing is saved (a person)',
    )
    .option(
      '--provider <provider>',
      `who drafts it: ${DESCRIBE_PROVIDERS.join(', ')}; your Claude first when it is found`,
    )
    .action(async (options: Record<string, unknown>) => {
      ran = true;
      const origin = await personSetupOrigin('describe a workflow', {
        where: 'Events → Workflows, Describe it in the designer',
        action: 'describe',
        terminal: 'output',
        // It changes nothing: as Analyse, Windows and Linux take it from an unattested origin.
        unattested: 'accept',
      });
      const provider = options.provider as string | undefined;
      if (provider !== undefined && !isDescribeProvider(provider))
        throw new CommsError('USAGE', `Describe it's provider is ${DESCRIBE_PROVIDERS.join(', ')}`);
      const request = await describeInput(streams);
      // The owner reads it again; checking here first gives a bad request its exit (64) before anything is sent.
      parseDescribeRequest(request);
      print(
        await workflowDescribe(
          request,
          { provider: provider as DescribeProvider | undefined },
          { ...controlOptions(program), origin, env, claudeDeadlineMs: deps.claudeDeadlineMs },
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
      print(await operation(await documentArgument(document, 'target document'), controlOptions(program)));
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

  const subscribers = program
    .command('subscribers')
    .description('inspect immutable subscriber versions: live on this Mac, or by signed webhook');
  subscribers.command('list').action(async () => {
    ran = true;
    print(await subscribersList(controlOptions(program)));
  });
  const subscriber = program
    .command('subscriber')
    .description('create, update, enable and revoke immutable subscribers: live on this Mac, or by signed webhook');
  // A document given as `-` is read from stdin (0.36.0, plan I7): the app hands the subscriber it made there.
  subscriber.command('add <document>').action(async (document: string) => {
    ran = true;
    print(await addSubscriber(await documentArgument(document, 'subscriber document'), controlOptions(program)));
  });
  subscriber.command('update <document>').action(async (document: string) => {
    ran = true;
    print(await updateSubscriber(await documentArgument(document, 'subscriber document'), controlOptions(program)));
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
  // Workflow events (0.36.0, W29): a subscriber version given events is inert until the person approves it. `enable`
  // prepares that approval — an agent may — and the person approves it with `approve` at a terminal or `subscriber
  // approve` from the app; a webhook subscriber's signing secret and secret URL are made at the terminal only.
  subscriber
    .command('enable <subscriber-id> <version>')
    .description("prepare the person's approval of an inert subscriber version's events; nothing is approved here")
    .action(async (subscriberId: string, version: string) => {
      ran = true;
      print(await enableSubscriber(subscriberId, parseVersion(version), controlOptions(program)));
    });
  subscriber
    .command('approve <approval-id>')
    .description("approve a subscriber version's events from the Agent Comms app, after its preview, as the person")
    .requiredOption('--digest <digest>', 'the fingerprint of the activation the preview showed')
    .action(async (approvalId: string, options: { readonly digest: string }) => {
      ran = true;
      // As for a workflow: Windows and Linux attest nothing, so there the person is sent to their terminal; the owner
      // refuses the same origin too.
      const origin = await personSetupOrigin("approve a subscriber's events", {
        where: 'Events → Subscribers, Approve',
        action: 'approve',
        unattested: { words: ruleApprovalWords(approvalId) },
      });
      print(await approveSubscriberFromApp(approvalId, options.digest, { ...controlOptions(program), origin }));
    });
  const subscriberSecret = subscriber
    .command('secret')
    .description("create or rotate a webhook subscriber's terminal-only signing secret");
  for (const [name, operation, request] of [
    ['create', subscriberSecretCreate, 'subscriberSecretCreate'],
    ['rotate', subscriberSecretRotate, 'subscriberSecretRotate'],
  ] as const) {
    subscriberSecret
      .command(`${name} <subscriber-id>`)
      .requiredOption('--version <version>')
      .action(async (subscriberId: string, options) => {
        ran = true;
        assertNotMcpServer(env, 'secret');
        assertHuman();
        const version = parseVersion(options.version as string);
        printHumanResult(
          await humanB3(request, { subscriberId, version }, () =>
            operation(subscriberId, version, controlOptions(program)),
          ),
        );
      });
  }
  subscriber
    .command('url')
    .description("set a webhook subscriber's concealed URL into a new immutable version")
    .command('set <subscriber-id>')
    .requiredOption('--version <version>', 'the new version to make, from the newest one before it')
    .action(async (subscriberId: string, options) => {
      ran = true;
      assertNotMcpServer(env, 'secret');
      assertHuman();
      const version = parseVersion(options.version as string);
      const value = await hidden('Webhook URL');
      printHumanResult(
        await humanB3('subscriberUrlSet', { subscriberId, version, hidden: value }, () =>
          subscriberUrlSet(subscriberId, version, { ...controlOptions(program), hidden: value }),
        ),
      );
    });

  // The step event catalogue (W25, Appendix W.3): every schema's words and closed outputs, content-free.
  const workflowEvents = program
    .command('workflow-events')
    .description('the step event catalogue: the events each step kind can raise, and what they carry');
  workflowEvents.command('list').action(async () => {
    ran = true;
    print(await workflowEventsList(controlOptions(program)));
  });
  workflowEvents.command('show <schema>').action(async (schema: string) => {
    ran = true;
    print(await workflowEventsShow(schema, controlOptions(program)));
  });

  const judges = program.command('judges').description('inspect immutable content-free judge metadata');
  judges.command('list').action(async () => {
    ran = true;
    print(await judgesList(controlOptions(program)));
  });
  const judge = program.command('judge').description('manage immutable judges and run fixed synthetic tests');
  judge
    .command('show <judge-id>')
    .description("show one judge version's exact canonical document, its digest and its state; never a key")
    .option('--version <version>', 'that version, rather than the newest live one')
    .action(async (judgeId: string, options) => {
      ran = true;
      const version = options.version === undefined ? undefined : parseVersion(options.version as string);
      // The owner reads these again; checking here first gives a bad argument its exit (64) without the owner.
      parseJudgeShowArguments({ judgeId, ...(version === undefined ? {} : { version }) });
      print(await judgeShow(judgeId, { ...controlOptions(program), version }));
    });
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

  // The person's own setup (owner decision 2026-10-26): Jev or a local model server set up and turned on in one step,
  // and the AI provider keys Jev uses. The app runs these; a person may run them at a terminal. After the release's
  // security review (2026-10-26) each is taken only from where the person is: an interactive terminal, or the Agent
  // Comms app — on macOS one core's `desktopAppOrigin` finds started this process (a speed bump against agents, not a
  // boundary against code running as the person); on Windows and Linux, which check nothing (a known limit), a process
  // without an agent's marker, said to be unattested.
  // An agent's shell, the event service's MCP server, and on macOS a pipe the app did not start are refused before
  // anything is read or sent, and no MCP tool performs them.
  // Person-only reads and acts an agent has no tool for (security review of 0.33.0, finding 10): an agent's shell is
  // refused too, by its agent marker — a speed bump against agents, not a boundary against code running as the person.
  const refuseAgentShell = (what: string, where: string): void => {
    const marker = agentMarker(env);
    if (marker !== null)
      throw new CommsError(
        'APPROVAL_REQUIRED',
        `only a person can ${what}, in the app or at their terminal, not an agent`,
        {
          details: { marker },
          hint: `Ask the person to do it in the app: ${where}.`,
        },
      );
  };
  const personSetupOrigin = async (
    what: string,
    options: {
      readonly where?: string;
      readonly action?: 'setup' | 'relay' | 'analyse' | 'approve' | 'projects' | 'runs' | 'describe';
      // `prompt`: a terminal the person types into (a key is their hidden input); `output`: one whose output they read.
      readonly terminal?: 'prompt' | 'output';
      /**
       * An unattested origin (Windows, Linux): a change is refused there and sent to the terminal, with the event
       * service's words to type (`words`); only `rule analyse`, which changes nothing, takes it (second look of 0.33.0).
       */
      readonly unattested?: { readonly words: string } | 'accept';
    } = {},
  ): Promise<PersonSetupOrigin> => {
    const where = options.where ?? 'Events → Judges, and Settings → AI providers';
    const action = options.action ?? 'setup';
    const terminal = options.terminal ?? 'prompt';
    assertNotMcpServer(env, action);
    const marker = agentMarker(env);
    if (marker !== null)
      throw new CommsError(
        'APPROVAL_REQUIRED',
        `only a person can ${what}, in the app or at their terminal, not an agent`,
        {
          details: { marker },
          hint: `Ask the person to do it in the app: ${where}.`,
        },
      );
    if (
      terminal === 'prompt'
        ? canPrompt(env, streams, { json: program.opts<EventsCliOptions>().json === true })
        : readsOutput(env, streams)
    )
      return PERSON_SETUP_ORIGINS.terminal;
    // The folders this run is for, found only when the app's origin is checked: a test build speaks only for a marked
    // test profile's config folder, and only when every other folder the act touches is in that profile too — here
    // the state folder, whose event service the act goes to (security review of 0.34.0, finding 1). Core's
    // `desktopAppOrigin` takes them as `folders` (core 0.34.0); the same check runs here as well, so a core without it,
    // and a test's injected origin, are held to it too. The event service checks its own state folder as well.
    const configDir = () => program.opts<EventsCliOptions>().configDir ?? resolvePaths({ env }).configDir;
    const stateDir = () => program.opts<EventsCliOptions>().stateDir ?? resolvePaths({ env }).stateDir;
    const attest = () => {
      // A variable, not a literal: a core from before `folders` takes the config folder alone.
      const check = { configDir: configDir(), folders: [{ what: 'state folder', path: stateDir() }] };
      return desktopAppOrigin(check);
    };
    const found = await (deps.desktopOrigin ?? attest)();
    const origin =
      found.ok && found.build === 'test' && !withinTestProfile(configDir(), stateDir())
        ? ({ ok: false, reason: 'outside-test-profile', outside: 'state folder' } as const)
        : found;
    if (origin.ok)
      return origin.build === 'test' ? PERSON_SETUP_ORIGINS.desktopAppTestBuild : PERSON_SETUP_ORIGINS.desktopApp;
    if (origin.reason === 'outside-test-profile') {
      const outside = (origin as { readonly outside?: unknown }).outside;
      throw testBuildOutsideProfile(typeof outside === 'string' ? outside : 'a folder it touches');
    }
    if (origin.reason === 'unattested-platform') {
      if (options.unattested === 'accept') return PERSON_SETUP_ORIGINS.desktopAppUnattested;
      throw changeAtTerminal(what, options.unattested?.words ?? 'command, with the same words');
    }
    throw new CommsError(
      'APPROVAL_REQUIRED',
      `only a person can ${what}: in the Agent Comms app, or at an interactive terminal`,
      {
        details: { reason: origin.reason },
        hint: `Do it in the app: ${where}; or run this at your own terminal.`,
      },
    );
  };
  judge
    .command('setup <kind>')
    .description(
      'set up and turn on Jev (typesafe) or a model server on this machine (local-endpoint) in one step, as the person',
    )
    .option('--provider <provider>', "Jev's provider: typesafe (the default) or openrouter")
    .option('--url <url>', "the local model server's URL: http://127.0.0.1:<port> or http://[::1]:<port>")
    .option('--model <name>', "the local model server's model (default nimble)")
    .action(async (kind: string, options: Record<string, unknown>) => {
      ran = true;
      const origin = await personSetupOrigin('set up a judge', {
        unattested: { words: `judge setup ${isSetupJudgeKind(kind) ? kind : '<kind>'}, with the same options` },
      });
      if (!isSetupJudgeKind(kind)) throw new CommsError('USAGE', 'judge setup takes typesafe or local-endpoint');
      const provider = options.provider as string | undefined;
      const url = options.url as string | undefined;
      const model = options.model as string | undefined;
      // The words are checked here too, so a mistyped one exits 64 without reaching the owner.
      if (kind === JUDGE_KIND_TYPESAFE) {
        if (url !== undefined || model !== undefined)
          throw new CommsError('USAGE', 'Jev takes --provider, not --url or --model');
        if (provider !== undefined && !isJevProvider(provider))
          throw new CommsError('USAGE', 'Jev’s provider is typesafe or openrouter');
      } else {
        if (provider !== undefined) throw new CommsError('USAGE', 'a local model server takes --url, not --provider');
        localSetupEndpoint(url);
        localSetupModel(model);
      }
      print(await judgeSetup(kind, { provider, url, model }, { ...controlOptions(program), origin }));
    });

  const providers = program
    .command('provider')
    .description(
      'the providers whose keys the event service keeps — TypeSafe, OpenRouter and Anthropic for Jev and Analyse, Linear for a Linear target — and whether each has a key',
    );
  providers
    .command('list')
    .description('list each provider and whether it has a key; never a key')
    .action(async () => {
      ran = true;
      print(await providerList(controlOptions(program)));
    });
  const providerKey = providers.command('key').description("set or remove a provider's key, as the person");
  providerKey
    .command('set <provider>')
    .description('store a provider key, read from your hidden input or the app’s stdin, never from argv')
    .action(async (provider: string) => {
      ran = true;
      const origin = await personSetupOrigin("set a provider's key", {
        unattested: {
          words: `provider key set ${isEventSecretProvider(provider) ? provider : '<provider>'}, which asks for the key, hidden`,
        },
      });
      if (!isEventSecretProvider(provider))
        throw new CommsError('USAGE', `the provider is ${EVENT_SECRET_PROVIDER_WORDS}`);
      const value = await providerKeyInput(streams, deps.readSecret, origin === PERSON_SETUP_ORIGINS.terminal);
      print(await providerKeySet(provider, { ...controlOptions(program), hidden: value, origin }));
    });
  providerKey
    .command('remove <provider>')
    .description('remove a provider key, and the copy its Jev judges hold; a Linear target then adds no issue')
    .action(async (provider: string) => {
      ran = true;
      const origin = await personSetupOrigin("remove a provider's key", {
        unattested: { words: `provider key remove ${isEventSecretProvider(provider) ? provider : '<provider>'}` },
      });
      if (!isEventSecretProvider(provider))
        throw new CommsError('USAGE', `the provider is ${EVENT_SECRET_PROVIDER_WORDS}`);
      print(await providerKeyRemove(provider, { ...controlOptions(program), origin }));
    });

  // A rule's activation, approved in the app after its preview (0.33.0 design §3.1): the person's own act, as judge
  // setup is, from the same origins. At a terminal the person approves with `approve`, which asks for the challenge.
  rule
    .command('approve <approval-id>')
    .description("approve a workflow's activation from the Agent Comms app, after its preview, as the person")
    .requiredOption('--digest <digest>', 'the fingerprint of the activation the preview showed')
    .action(async (approvalId: string, options: { readonly digest: string }) => {
      ran = true;
      // Windows and Linux attest nothing: a standing disclosure is approved there at the terminal, never on a missing
      // marker alone (security review of 0.33.0, finding 2). The owner refuses the same origin too.
      const origin = await personSetupOrigin('approve a rule', {
        where: 'Events → Rules, Review and approve',
        action: 'approve',
        unattested: { words: ruleApprovalWords(approvalId) },
      });
      print(await approveRuleFromApp(approvalId, options.digest, { ...controlOptions(program), origin }));
    });

  // Switching the event service on, approved in the app after the preview of what `enable-all` prepared (0.34.0 design
  // B4): the person's own act, as a rule's approval is, from the same origins. At a terminal the person approves with
  // `approve`, which asks for the challenge; switching off is `disable-all`, which applies at once.
  const collection = program
    .command('collection')
    .description(
      'the event service watching your accounts: switched on by the approval enable-all prepares, off at once with disable-all',
    );
  collection
    .command('approve <approval-id>')
    .description(
      'approve switching the event service on — the approval enable-all prepared — from the Agent Comms app, after its preview, as the person',
    )
    .requiredOption('--digest <digest>', 'the fingerprint of the activation the preview showed')
    .action(async (approvalId: string, options: { readonly digest: string }) => {
      ran = true;
      // As for a rule: Windows and Linux attest nothing, so there the person is sent to their terminal; the owner
      // refuses the same origin too.
      const origin = await personSetupOrigin('switch the event service on', {
        where: 'Events → Service, Switch on',
        action: 'approve',
        unattested: { words: ruleApprovalWords(approvalId) },
      });
      print(await approveEnableAllFromApp(approvalId, options.digest, { ...controlOptions(program), origin }));
    });

  // Settings → Integrations: what the person's Linear key can see (0.33.0 design §3.4), and where their claude-stream
  // relay is (§3.5) — theirs to set, from the app or their terminal, like an AI provider's key — and the items waiting
  // for a busy session, theirs to read and drop.
  const integration = program
    .command('integration')
    .description(
      'the services a workflow can act in — Linear, and agent-sessions (your claude-stream relay) — and what each can see (a person only)',
    );
  integration
    .command('show <integration>')
    .description(
      'linear: whether a key is kept, its workspace and teams (with --team, that team’s labels); agent-sessions: where the relay is and whether it is ready',
    )
    .option('--team <key>', 'linear: a team, by its key (such as CUE) or its id, whose labels to list')
    .action(async (name: string, options: { readonly team?: string }) => {
      ran = true;
      // The person's view, at a terminal or in the app: never inside an MCP server's process, nor an agent's shell.
      assertNotMcpServer(env, name === 'agent-sessions' ? 'relay' : 'integration');
      refuseAgentShell(
        name === 'agent-sessions' ? 'see where your claude-stream relay is' : 'see what your Linear key can see',
        'Settings → Integrations',
      );
      if (name === 'agent-sessions') {
        if (options.team !== undefined)
          throw new CommsError('USAGE', 'integration show agent-sessions takes no --team');
        print(await integrationShow(name, controlOptions(program)));
        return;
      }
      if (name !== 'linear') throw new CommsError('USAGE', 'the integration is linear or agent-sessions');
      print(await integrationShow(name, { ...controlOptions(program), team: options.team }));
    });
  integration
    .command('set <integration>')
    .description(
      'set where the relay is, or a folder a file part may be read from (a person, at a terminal or in the app)',
    )
    .option('--relay-home <path>', "the relay's home folder, where its control.token is; default for the defaults")
    .option('--relay-port <port>', "the relay's port; default for the Pilot app's record, else 4318")
    .option('--allow-folder <path>', 'a folder a session’s file parts may be read from (repeat for more)', collect, [])
    .option('--remove-folder <path>', 'a folder to take off that list (repeat for more)', collect, [])
    .action(async (name: string, options: Record<string, unknown>) => {
      ran = true;
      if (name !== 'agent-sessions') throw new CommsError('USAGE', 'integration set takes agent-sessions');
      const origin = await personSetupOrigin('change where Agent Comms finds your claude-stream relay', {
        where: 'Settings → Integrations → Agent sessions',
        action: 'relay',
        unattested: { words: 'integration set agent-sessions, with the same options' },
      });
      const port = options.relayPort as string | undefined;
      print(
        await integrationSet(
          name,
          {
            ...(options.relayHome === undefined ? {} : { relayHome: options.relayHome as string }),
            ...(port === undefined ? {} : { relayPort: port === 'default' ? 'default' : parseRelayPort(port) }),
            ...((options.allowFolder as string[]).length === 0
              ? {}
              : { allowFolders: options.allowFolder as string[] }),
            ...((options.removeFolder as string[]).length === 0
              ? {}
              : { removeFolders: options.removeFolder as string[] }),
          },
          { ...controlOptions(program), origin },
        ),
      );
    });
  // Projects (0.36.0 workflows design §8.1): the GitHub repositories on this Mac, their folders, a profile and hints.
  // Each command is the person's alone, from the app or their terminal: personSetupOrigin refuses the event service's
  // MCP server, an agent's shell and, on macOS, a process the app did not start, before anything is read; the owner
  // takes them only from the person's origin; and no tool reads or changes a project (taking design T7).
  const asPerson = (what: string) =>
    personSetupOrigin(what, {
      where: 'Events → Projects',
      action: 'projects',
      terminal: 'output',
      // Nothing here approves anything: a project's folders become authority only inside a workflow's own approval.
      unattested: 'accept',
    });
  program
    .command('projects')
    .description('the GitHub repositories on this Mac a workflow can route to (a person only)')
    .command('list')
    .description(
      'list every project, with its folders, profile and hints, and the relay sessions working in it, busy or idle (a person only)',
    )
    .action(async () => {
      ran = true;
      const origin = await asPerson('list your projects');
      print(await projectsList({ ...controlOptions(program), origin }));
    });
  const project = program
    .command('project')
    .description(
      'add, show, change, remove or find a project: a GitHub repository, its folders on this Mac, a profile and hints (a person only)',
    );
  project
    .command('show <project-id>')
    .description('show one project, with the relay sessions working in it, busy or idle (a person only)')
    .action(async (projectId: string) => {
      ran = true;
      const origin = await asPerson('see a project');
      print(await projectShow(projectId, { ...controlOptions(program), origin }));
    });
  for (const [name, operation, what] of [
    ['add', projectAdd, 'add a project'],
    ['update', projectUpdate, 'change a project'],
  ] as const) {
    project
      .command(`${name} <document>`)
      .description(
        `${what} from its JSON document { projectId, name, repo, profile, hints, folders }, or - to read it from stdin (a person only)`,
      )
      .action(async (document: string) => {
        ran = true;
        const origin = await asPerson(what);
        print(
          await operation(await documentArgument(document, 'project document'), { ...controlOptions(program), origin }),
        );
      });
  }
  project
    .command('remove <project-id>')
    .description(
      'remove a project and its folders; a workflow that chose among them then finds it changed (a person only)',
    )
    .action(async (projectId: string) => {
      ran = true;
      const origin = await asPerson('remove a project');
      print(await projectRemove(projectId, { ...controlOptions(program), origin }));
    });
  project
    .command('scan')
    .description(
      "find the GitHub checkouts under the relay's allowed roots, else ~/work and ~/code, to 4 folders down; reads no file (a person only)",
    )
    .option('--root <path>', 'a folder to look under instead (repeat for more, at most 8)', collect, [])
    .action(async (options: { readonly root: string[] }) => {
      ran = true;
      const origin = await asPerson('look for your projects');
      print(await projectScan(options.root, { ...controlOptions(program), origin }));
    });
  const sessionQueue = program
    .command('session-queue')
    .description('the matches waiting for a busy agent session, each passed on when the session’s run ends');
  sessionQueue
    .command('list')
    .description('list every match waiting for a busy session, oldest first: ids and times (a person)')
    .action(async () => {
      ran = true;
      assertNotMcpServer(env, 'sessions');
      // Every session's waiting matches are the person's; a bound window sees its own lane's with its MCP tool.
      refuseAgentShell('list the matches waiting for every session', 'Events → Deliveries');
      print(await sessionQueueList(controlOptions(program)));
    });
  sessionQueue
    .command('drop <delivery-id>')
    .description('drop a waiting match: its delivery is cancelled and what it held purged, at once (a person)')
    .action(async (deliveryId: string) => {
      ran = true;
      assertNotMcpServer(env, 'sessions');
      refuseAgentShell('drop a match waiting for a session', 'Events → Deliveries');
      print(await sessionQueueDrop(deliveryId, controlOptions(program)));
    });

  const deliveries = program.command('deliveries').description('inspect content-free delivery metadata');
  deliveries.command('list').action(async () => {
    ran = true;
    print(await deliveriesList(controlOptions(program)));
  });
  const delivery = program.command('delivery').description('show, retry or drop one exact delivery');
  delivery
    .command('show <delivery-id>')
    .description('show one delivery: its decision, the event and its source ids, and its target (a person only)')
    .action(async (deliveryId: string) => {
      ran = true;
      // The person's view, at a terminal or in the app (0.32.0, §3.5): never inside an MCP server's process.
      assertNotMcpServer(env, 'delivery');
      print(await deliveryShow(deliveryId, controlOptions(program)));
    });
  delivery.command('retry <delivery-id>').action(async (deliveryId: string) => {
    ran = true;
    print(await retryDelivery(deliveryId, controlOptions(program)));
  });
  delivery.command('drop <delivery-id>').action(async (deliveryId: string) => {
    ran = true;
    // Stopping a delivery that will be tried again is the person's: inside an MCP server's process the owner refuses it.
    const insideMcpServer = (env[MCP_SERVER_MARKER] ?? '') !== '';
    print(await dropDelivery(deliveryId, { ...controlOptions(program), insideMcpServer }));
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

  // The dry-run log (0.32.0, owner feedback §3.5; events design D7: "at the terminal or in the app"): the person's, at a
  // terminal or in the app, which runs it with --json. Like the queue's content reads (Q1), it refuses inside an MCP
  // server's process. With --json a record is data, for the app to render as outside text; a terminal gets it enveloped.
  // The rule version that made a record, for which of its fields the sender controls; null when it cannot be read.
  const dryRunRule = async (record: { readonly ruleId: string; readonly ruleVersion: number }) => {
    try {
      const versions = (await ruleShow(record.ruleId, controlOptions(program))) as readonly {
        readonly document?: { readonly version?: unknown; readonly event?: unknown; readonly mapping?: unknown };
      }[];
      const document = versions.find((entry) => entry.document?.version === record.ruleVersion)?.document;
      const event = document?.event as { readonly type?: unknown; readonly version?: unknown } | undefined;
      if (typeof event?.type !== 'string' || typeof event.version !== 'number') return null;
      return { event: { type: event.type, version: event.version }, mapping: document?.mapping };
    } catch (error) {
      if (isCommsError(error)) return null;
      throw error;
    }
  };
  const dryrun = program
    .command('dryrun')
    .description('read the dry-run log: what a dry-run target would have delivered, kept 24 hours at most');
  dryrun
    .command('list')
    .description('list the dry-run log without what it holds (a person, at a terminal or in the app)')
    .action(async () => {
      ran = true;
      assertNotMcpServer(env, 'dryrun');
      const entries = await dryrunList(controlOptions(program));
      if (program.opts<EventsCliOptions>().json) print(entries);
      else streams.stdout.write(`${renderDryRunListForTerminal(entries)}\n`);
    });
  dryrun
    .command('show <delivery-id>')
    .description(
      'show one dry-run record: the exact event it would have delivered (a person, at a terminal or in the app)',
    )
    .action(async (deliveryId: string) => {
      ran = true;
      assertNotMcpServer(env, 'dryrun');
      const record = await dryrunShow(deliveryId, controlOptions(program));
      if (program.opts<EventsCliOptions>().json) print(dryRunRecordAsData(record, await dryRunRule(record)));
      else streams.stdout.write(`${renderDryRunRecordForTerminal(record)}\n`);
    });

  // The action queue (action queue design §4.4, §8). list and show give a person the content, at a terminal or in the
  // app (which runs them with --json); they refuse inside an MCP server's process (Q1). The rest are content-free.
  const queue = program
    .command('queue')
    .description('work through the action queue: what your workflows sent to it, and what you have done with it');
  const queueFilters = (options: Record<string, unknown>, withSince: boolean, command: Command) => {
    // The filter keeps its identifier, `rule`; the person names the workflow with `--workflow` (W22).
    const workflow = workflowOption(options, command, false);
    const filters = {
      ...(options.state === undefined ? {} : { state: options.state as string }),
      ...(workflow === undefined ? {} : { rule: workflow }),
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
    .option('--workflow <workflow-id>', "only this workflow's items")
    .addOption(new Option('--rule <workflow-id>').hideHelp())
    .option('--channel <channel>', 'gmail, slack, resend or whatsapp')
    .option('--since <when>', 'an ISO time, or a span back from now such as 7d or 12h')
    .option('--limit <n>', 'at most this many items (1 to 500, default 50)')
    .action(async (options: Record<string, unknown>, command: Command) => {
      ran = true;
      assertNotMcpServer(env);
      const result = await queueList(queueFilters(options, true, command), controlOptions(program));
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
    .description('list queue items without what they say: ids, workflows, channels, accounts, states and times')
    .option('--state <state>', 'open (the default), done, dismissed or all')
    .option('--workflow <workflow-id>', "only this workflow's items")
    .addOption(new Option('--rule <workflow-id>').hideHelp())
    .option('--channel <channel>', 'gmail, slack, resend or whatsapp')
    .option('--limit <n>', 'at most this many items (1 to 500, default 50)')
    .action(async (options: Record<string, unknown>, command: Command) => {
      ran = true;
      print(await queueItems(queueFilters(options, false, command), controlOptions(program)));
    });
  queue
    .command('counts')
    .description('count open, done and dismissed queue items, and each workflow’s open items')
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
      'bind a lane — a queue your workflows send to — to the one agent window woken for its items, and unbind it',
    );
  lane
    .command('list')
    .description('list every lane, its workflows, channels and open items, and the agent window bound to it')
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
      const laneName = requireLaneName(name);
      const window = requireLaneWindowId(options.window);
      // Binding lets one agent window read a lane, so it is a person's act (B1): an agent's shell is refused, and so
      // is anything without an interactive terminal, as dryrun show is; then the person types the lane's name. The
      // prompt goes to stderr, so --json still prints only the result.
      assertHumanTerminal(env, streams, false, {
        agent: 'only a person at an interactive terminal can bind a lane, not an agent',
        terminal: 'binding a lane needs an interactive terminal, where you type the lane’s name',
      });
      const terminal = createInterface({ input: streams.stdin, output: streams.stderr, terminal: false });
      let typed: string;
      try {
        // The first line typed is the answer; a terminal that closes before one is typed answers nothing, which binds
        // nothing. A line typed ahead of the prompt is read too: 'line' comes before 'close'.
        typed = await new Promise<string>((resolve) => {
          terminal.once('line', resolve);
          terminal.once('close', () => resolve(''));
          streams.stderr.write(
            `Binding lane ${laneName} lets the agent window ${window} be woken for, and read, every new item in it.\nType the lane’s name to bind it: `,
          );
        });
      } finally {
        terminal.close();
      }
      if (typed.trim() !== laneName)
        throw new CommsError('APPROVAL_REQUIRED', `the name typed was not ${laneName}, so nothing was bound`);
      print(await laneBind(laneName, window, controlOptions(program)));
    });
  lane
    .command('unbind <lane>')
    .description('unbind a lane from its window at once; its watches end')
    .action(async (name: string) => {
      ran = true;
      print(await laneUnbind(requireLaneName(name), controlOptions(program)));
    });

  // A story per message (0.32.0 §3.6): what happened to each message the event service observed — each rule's decision,
  // each delivery, its queue item and that item's history. The person's, at a terminal or in the app (which runs it with
  // --json); it refuses inside an MCP server's process, as the queue's content reads do.
  const messages = program
    .command('messages')
    .description('what happened to each message the event service observed: matched, judged, delivered, queued, read');
  messages
    .command('list')
    .description('list observed messages newest first, each with its decisions, deliveries and queue item (a person)')
    .option('--since <ms>', 'the oldest observation time, in milliseconds since 1970 (default: 30 days back)')
    .option('--before <ms|next>', 'only messages observed before this time, or the next an earlier page gave')
    .option('--limit <n>', 'at most this many messages (1 to 500, default 100)')
    .action(async (options: Record<string, unknown>) => {
      ran = true;
      assertNotMcpServer(env, 'messages');
      const filters = {
        ...(options.since === undefined ? {} : { since: parseMilliseconds(options.since as string, '--since') }),
        ...(options.before === undefined ? {} : { before: parseBefore(options.before as string) }),
        ...(options.limit === undefined ? {} : { limit: parseLimit(options.limit as string) }),
      };
      // The owner parses these again; checking here first gives a bad argument its exit (64) without the owner.
      parseMessagesQuery(filters, Date.now());
      print(await messagesList(filters, controlOptions(program)));
    });
  program
    .command('message')
    .description('one message the event service observed, by its event id')
    .command('show <event-id>')
    .description('show one message, with every line of its queue item’s history (a person)')
    .action(async (eventId: string) => {
      ran = true;
      assertNotMcpServer(env, 'messages');
      print(await messageShow(requireEventId(eventId), controlOptions(program)));
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

/** A whole number of milliseconds since 1970, as `--since` and `--before` take one. */
function parseMilliseconds(value: string, flag: string): number {
  const at = Number(value);
  if (!/^\d{1,16}$/u.test(value) || !Number.isSafeInteger(at))
    throw new CommsError('USAGE', `${flag} is a time in whole milliseconds since 1970`);
  return at;
}

/** `--before`: whole milliseconds, or the `next` cursor an earlier page of `messages list` gave, as it gave it. */
function parseBefore(value: string): number | string {
  return /^\d+$/u.test(value) ? parseMilliseconds(value, '--before') : value;
}

function parseVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new CommsError('USAGE', 'a version must be a positive integer');
  return version;
}

/**
 * The workflow a command names (W22): `--workflow`, or the hidden `--rule` it replaced, which scripts and the desktop
 * app still pass. Both naming different workflows is a usage error. A required one that is missing is refused in
 * Commander's own words for a missing required option, which name `--workflow`.
 */
function workflowOption(options: Record<string, unknown>, command: Command, required: boolean): string | undefined {
  const { workflow, rule } = options as { readonly workflow?: string; readonly rule?: string };
  if (workflow !== undefined && rule !== undefined && workflow !== rule)
    throw new CommsError('USAGE', 'name the workflow once, with --workflow <workflow-id>');
  const named = workflow ?? rule;
  if (named === undefined && required)
    command.error("error: required option '--workflow <workflow-id>' not specified", {
      code: 'commander.missingMandatoryOptionValue',
    });
  return named;
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

/** Commander's repeatable option: each value given, in order. */
/** `--outcome <step>=<outcome>`, each once: the steps of a flow a test answers for (0.36.0 §7.7). */
function outcomeArguments(values: readonly string[] | undefined): Readonly<Record<string, string>> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const outcomes: Record<string, string> = {};
  for (const value of values) {
    const match = /^([a-z][a-z0-9-]{0,31})=([a-z][a-z-]{0,31})$/u.exec(value);
    if (match === null) throw new CommsError('USAGE', '--outcome is a step and its outcome: step=outcome');
    const [, step, outcome] = match as unknown as [string, string, string];
    if (Object.hasOwn(outcomes, step)) throw new CommsError('USAGE', `--outcome names the step ${step} twice`);
    Object.defineProperty(outcomes, step, { value: outcome, enumerable: true });
  }
  return outcomes;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseRelayPort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(value) || Number(value) > 65_535)
    throw new CommsError('USAGE', "the relay's port is a whole number from 1 to 65535, or default");
  return Number(value);
}

/** The most a document read from stdin may be: well past any rule, and short of filling memory. */
const STDIN_DOCUMENT_MAX_BYTES = 1024 * 1024;

/** A JSON document from stdin, as `-` names it: at most 1 MiB, its text as given. */
async function stdinDocument(streams: EventsCliStreams, name: string): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of streams.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > STDIN_DOCUMENT_MAX_BYTES) throw new CommsError('USAGE', `${name} on stdin is at most 1 MiB`);
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') throw new CommsError('USAGE', `${name} is required, on stdin`);
  return text;
}

/**
 * Whether the person reads this run's output at a terminal: its output is a terminal's, and it is not CI. A command whose
 * input may be a pipe (Analyse's draft) asks this rather than whether it can prompt.
 */
function readsOutput(env: NodeJS.ProcessEnv, streams: EventsCliStreams): boolean {
  if (env.CI && env.CI !== '0' && env.CI !== 'false') return false;
  return Boolean(streams.stdout.isTTY);
}

/** Analyse's draft (0.33.0 §3.3): one JSON rule document on stdin, as the app's editor sends it. */
async function draftInput(streams: EventsCliStreams): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of streams.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > ANALYSE_DRAFT_MAX_BYTES)
      throw new CommsError('USAGE', `a draft is at most ${ANALYSE_DRAFT_MAX_BYTES} bytes of JSON`);
    chunks.push(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new CommsError('USAGE', 'the draft on stdin must be one JSON workflow document');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new CommsError('USAGE', 'the draft on stdin must be one JSON workflow document');
  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * What Describe it is asked, on stdin (0.36.0 §11.4): one JSON object `{ words, example?, answers?, draft? }`, or plain
 * words, which are the words alone. At most the largest request a draft rides in.
 */
async function describeInput(streams: EventsCliStreams): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const most = DESCRIBE_LIMITS.draftBytes + 4 * (DESCRIBE_LIMITS.words + DESCRIBE_LIMITS.example) + 16_384;
  for await (const chunk of streams.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > most) throw new CommsError('USAGE', 'what Describe it is asked is too large');
    chunks.push(bytes);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new CommsError('USAGE', 'what Describe it is asked is UTF-8 text');
  }
  if (text.trimStart().startsWith('{')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CommsError('USAGE', 'what Describe it is asked is one JSON object, or your words alone');
    }
  }
  return { words: text.replace(/\r?\n$/u, '') };
}

/** The most a provider key read from the app's stdin may be. */
const PROVIDER_KEY_MAX_BYTES = 4096;

/**
 * A provider key, from the person (owner decision 2026-10-26): at an interactive terminal their hidden input, exactly
 * as `judge key set` reads one, and never a pipe; from the desktop app, which `personSetupOrigin` found started this
 * process, its stdin — one line, at most 4 KiB, its line ending dropped. Never argv, and never echoed.
 */
async function providerKeyInput(
  streams: EventsCliStreams,
  readSecret: ((prompt: string) => Promise<string>) | undefined,
  atTerminal: boolean,
): Promise<string> {
  if (atTerminal) return readSecret !== undefined ? readSecret('API key') : readHiddenTerminal(streams, 'API key');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of streams.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > PROVIDER_KEY_MAX_BYTES) throw new CommsError('USAGE', 'a provider key is at most 4096 bytes');
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/u, '');
  if (value.length === 0) throw new CommsError('USAGE', 'the provider key is required, on stdin');
  if (/[\r\n]/u.test(value)) throw new CommsError('USAGE', 'a provider key is one line');
  return value;
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
