import { Command, CommanderError } from 'commander';
import { createEventsMcpServer } from '../mcp/server.ts';
import { status } from '../operations/status.ts';

export interface EventsCliStreams {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export interface EventsCliDeps {
  readonly streams?: EventsCliStreams | undefined;
  readonly startMcp?: (() => Promise<void>) | undefined;
}

/** Runs the intentionally small Task B1 command surface. */
export async function run(argv: readonly string[], deps: EventsCliDeps = {}): Promise<number> {
  const streams = deps.streams ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  const program = new Command();
  let ran = false;

  program
    .name('agent-events')
    .description('The held local event-emission service. It does not start an owner in this release.')
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
      const result = await status();
      if (program.opts<{ json?: boolean }>().json) streams.stdout.write(`${JSON.stringify(result)}\n`);
      else streams.stdout.write('Local event service owner: not running\n');
    });

  program
    .command('mcp')
    .description('serve the MCP interface over standard input and output')
    .action(async () => {
      ran = true;
      if (deps.startMcp) await deps.startMcp();
      else await (await createEventsMcpServer()).connectStdio();
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
    if (!ran) program.outputHelp();
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    streams.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
