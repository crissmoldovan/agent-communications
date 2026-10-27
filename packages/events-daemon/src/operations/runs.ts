import { EventControlClient } from '../control/client.ts';
import type { PersonSetupOrigin } from '../domain/judge-setup.ts';
import type { RunCancelResultV1, RunShowResultV1, RunState, RunsListResultV1 } from '../runtime/workflow/run-show.ts';

/*
 * A workflow's runs (workflows design §7.6, §11.1): list them, show one, cancel one. Every one of these is the person's,
 * from the app or their terminal: the CLI refuses the event service's MCP server, an agent's shell and, on macOS, a
 * process the app did not start, before anything is asked; the owner takes them only from the person's origin; and no
 * MCP tool calls any of them.
 */

interface Options {
  readonly stateDir?: string | undefined;
  /** Who is asking, as the CLI found it: the terminal, or the app. */
  readonly origin: PersonSetupOrigin;
}

function client(options: Options): EventControlClient {
  return new EventControlClient({ stateDir: options.stateDir, clientName: options.origin });
}

/** The runs, newest first, at most 200: of one workflow (`ruleId`), or in one state, when asked. */
export async function runsList(
  options: Options & { readonly ruleId?: string | undefined; readonly state?: RunState | undefined },
): Promise<RunsListResultV1> {
  return (await client(options).request('runs-list', {
    ...(options.ruleId === undefined ? {} : { ruleId: options.ruleId }),
    ...(options.state === undefined ? {} : { state: options.state }),
  })) as RunsListResultV1;
}

/** One run, of the version it started on: its path, each step it reached, its waits and the events it raised. */
export async function runShow(runId: string, options: Options): Promise<RunShowResultV1> {
  return (await client(options).request('run-show', { runId })) as RunShowResultV1;
}

/**
 * Cancels a live run, at once (a tightening): its waiting deliveries and undelivered events are cancelled, its waits
 * dropped and its record purged. Its session's turn is interrupted only with `interrupt`.
 */
export async function runCancel(
  runId: string,
  input: { readonly interrupt: boolean },
  options: Options,
): Promise<RunCancelResultV1> {
  return (await client(options).request('run-cancel', { runId, interrupt: input.interrupt })) as RunCancelResultV1;
}
