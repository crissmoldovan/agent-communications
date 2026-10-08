import { isCommsError } from '@agentcomms/core';
import { Command, CommanderError } from 'commander';
import { createEventsMcpServer } from '../mcp/server.ts';
import { disableAll } from '../operations/disable-all.ts';
import { doctor } from '../operations/doctor.ts';
import { enableAll } from '../operations/enable-all.ts';
import { pause, resume } from '../operations/pause.ts';
import { run as runOwner } from '../operations/run.ts';
import { status } from '../operations/status.ts';
import { stop } from '../operations/stop.ts';

export interface EventsCliStreams {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export interface EventsCliDeps {
  readonly streams?: EventsCliStreams | undefined;
  readonly startMcp?: (() => Promise<void>) | undefined;
}

interface EventsCliOptions {
  readonly json?: boolean;
  readonly stateDir?: string;
}

/** Runs the intentionally small Task B1 command surface. */
export async function run(argv: readonly string[], deps: EventsCliDeps = {}): Promise<number> {
  const streams = deps.streams ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
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
    ['doctor', 'report content-free owner, protocol and global switch health', doctor],
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

  program
    .command('mcp')
    .description('serve the MCP interface over standard input and output')
    .action(async () => {
      ran = true;
      if (deps.startMcp) await deps.startMcp();
      else await (await createEventsMcpServer(controlOptions(program))).connectStdio();
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
