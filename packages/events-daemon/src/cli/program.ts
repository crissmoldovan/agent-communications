import { createInterface } from 'node:readline/promises';
import { agentMarker, CommsError, canPrompt, isCommsError } from '@agentcomms/core';
import { Command, CommanderError } from 'commander';
import { createEventsMcpServer } from '../mcp/server.ts';
import { approvalView } from '../operations/approval-view.ts';
import { approve, disclosureChallenge } from '../operations/approve.ts';
import {
  B3_SECRET_TERMINAL_ORIGIN,
  type B3CliRegistrar,
  type B3ControlOperation,
  isB3SecretOperation,
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
import { pause, resume } from '../operations/pause.ts';
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
import { assertHumanTerminal, renderDryRunList, renderDryRunRecord } from '../targets/dry-run.ts';

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

/** Runs the intentionally small Task B1 command surface. */
export async function run(argv: readonly string[], deps: EventsCliDeps = {}): Promise<number> {
  const streams = deps.streams ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  const env = deps.env ?? process.env;
  const program = new Command();
  let ran = false;

  program
    .name('agent-events')
    .description('The held local event-emission service with one foreground owner and local control clients.')
    .option('--json', 'write machine-readable output')
    .option('--no-color', 'never colour the output')
    .option('--config-dir <dir>', 'pin the configuration directory for this run')
    .option('--state-dir <dir>', 'pin the state directory for this run')
    .option('--data-dir <dir>', 'pin the data directory for this run')
    .option('--secrets-dir <dir>', 'pin the secrets directory for this run')
    .option('--downloads-dir <dir>', 'pin the downloads directory for this run')
    .configureOutput({
      writeOut: (text) => streams.stdout.write(text),
      writeErr: (text) => streams.stderr.write(text),
    })
    .exitOverride();

  program
    .command('status')
    .description('report whether the local event service has an owner')
    .action(async () => {
      ran = true;
      const result = await status(controlOptions(program));
      if (program.opts<EventsCliOptions>().json) streams.stdout.write(`${JSON.stringify(result)}\n`);
      else streams.stdout.write(`Local event service owner: ${result.owner}\n`);
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
      'report content-free lineage validation, pending source retry health, recovery and global switch health',
      doctor,
    ],
  ] as const) {
    program
      .command(name)
      .description(description)
      .action(async () => {
        ran = true;
        const result = await operation(controlOptions(program));
        if (program.opts<EventsCliOptions>().json) streams.stdout.write(`${JSON.stringify(result)}\n`);
        else streams.stdout.write(`${JSON.stringify(result)}\n`);
      });
  }

  const print = (result: unknown) => streams.stdout.write(`${JSON.stringify(result)}\n`);
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
          ...(isB3SecretOperation(operation) ? { origin: B3_SECRET_TERMINAL_ORIGIN } : {}),
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
      streams.stdout.write(`${result.rendered}\n`);
      return;
    }
    if (isMigrationResult(result)) {
      streams.stdout.write(`Moved ${result.moved} event secret references.\n`);
      if (result.leftovers.length > 0) {
        streams.stdout.write('Leftover references (retry this migration before rotating):\n');
        for (const reference of result.leftovers) streams.stdout.write(`${reference}\n`);
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
      print(await approvalView(approvalId, options.digest as string, controlOptions(program)));
    });
  const catalogue = program.command('catalogue').description('inspect the held local event catalogue');
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

  const judges = program.command('judges').description('inspect typed pre-Phase-E judge controls');
  judges.command('list').action(async () => {
    ran = true;
    print(await judgesList(controlOptions(program)));
  });
  const judge = program.command('judge').description('use typed unavailable judge controls until Phase E');
  judge.command('add <document>').action(async (document: string) => {
    ran = true;
    print(await addJudge(jsonArgument(document, 'judge document'), controlOptions(program)));
  });
  judge.command('update <document>').action(async (document: string) => {
    ran = true;
    print(await updateJudge(jsonArgument(document, 'judge document'), controlOptions(program)));
  });
  judge.command('remove <judge-id>').action(async (judgeId: string) => {
    ran = true;
    print(await removeJudge(judgeId, controlOptions(program)));
  });
  judge
    .command('test <judge-id>')
    .requiredOption('--version <version>')
    .action(async (judgeId: string, options) => {
      ran = true;
      print(await judgeTest(judgeId, parseVersion(options.version as string), controlOptions(program)));
    });
  const budget = program.command('budget').description('use typed unavailable budget controls until Phase E');
  budget.command('show').action(async () => {
    ran = true;
    print(await budgetShow(controlOptions(program)));
  });
  budget.command('update <document>').action(async (document: string) => {
    ran = true;
    print(await updateBudget(jsonArgument(document, 'budget document'), controlOptions(program)));
  });
  const judgeKinds = judge.command('kinds').description('list typed unavailable judge kinds until Phase E');
  judgeKinds.command('list').action(async () => {
    ran = true;
    print(await judgeKindsList(controlOptions(program)));
  });
  const judgeKind = judge.command('kind').description('use typed unavailable judge kind controls until Phase E');
  judgeKind.command('enable <kind>').action(async (kind: string) => {
    ran = true;
    print(await enableJudgeKind(kind, controlOptions(program)));
  });
  judgeKind.command('disable <kind>').action(async (kind: string) => {
    ran = true;
    print(await disableJudgeKind(kind, controlOptions(program)));
  });
  const judgeModel = judge.command('model').description('use typed unavailable Laya model controls until Phase E2');
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
    streams.stdout.write(`${renderDryRunList(await dryrunList(controlOptions(program)))}\n`);
  });
  dryrun.command('show <delivery-id>').action(async (deliveryId: string) => {
    ran = true;
    assertHumanTerminal(env, streams, program.opts<EventsCliOptions>().json === true);
    streams.stdout.write(`${renderDryRunRecord(await dryrunShow(deliveryId, controlOptions(program)))}\n`);
  });

  program
    .command('approve <approval-id>')
    .description('approve a standing disclosure by typing its challenge at this terminal')
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
      const challenge = await disclosureChallenge(approvalId, controlOptions(program));
      const terminal = createInterface({ input: streams.stdin, output: streams.stdout });
      try {
        const answer = await terminal.question(`Type this approval challenge: ${challenge}\n> `);
        print(await approve(approvalId, answer, controlOptions(program)));
      } finally {
        terminal.close();
      }
    });

  program
    .command('mcp')
    .description('serve the MCP interface over standard input and output')
    .action(async () => {
      ran = true;
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
      streams.stderr.write(`${error.message}\n`);
      if (error.hint !== undefined) streams.stderr.write(`${error.hint}\n`);
      return error.exitCode;
    }
    streams.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function controlOptions(program: Command): { stateDir?: string } {
  const { stateDir } = program.opts<EventsCliOptions>();
  return stateDir === undefined ? {} : { stateDir };
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
