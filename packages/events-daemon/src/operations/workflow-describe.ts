import { CommsError } from '@agentcomms/core';
import { EventControlClient } from '../control/client.ts';
import { findClaude, runClaude } from '../domain/claude-cli.ts';
import type { DescribePrompt, DescribeProvider, WorkflowDescribeResultV1 } from '../domain/describe-brief.ts';
import type { PersonSetupOrigin } from '../domain/judge-setup.ts';

/**
 * Describe it (workflows design §11.4, W21): the person's words drafted into a workflow, written nowhere. On the
 * person's own Claude subscription, `claude` runs here, in the CLI process the person started — the event service only
 * gives the prompt and reads the answer back; with a key kept for Analyse, the event service asks the model itself. The
 * draft comes back with where each step came from, the model's questions, and the text's and `workflow check`'s
 * problems. Nothing is saved: a draft becomes a version only when the person saves it, and runs only once they approve.
 *
 * The person's alone: the CLI refuses the event service's MCP server, an agent's shell and, on macOS, a process the app
 * did not start; the owner takes it only from the person's origin; and no MCP tool reaches it.
 */

interface Options {
  readonly stateDir?: string | undefined;
  /** Who is asking, as the CLI found it: the terminal, or the app. */
  readonly origin: PersonSetupOrigin;
  /** The CLI's environment: where `claude` is found, and what it keeps. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Test seams: a shorter deadline, a smaller cap. */
  readonly claudeDeadlineMs?: number | undefined;
  readonly claudeMaxOutputBytes?: number | undefined;
}

/**
 * `workflow describe [--provider claude-cli|openrouter|anthropic]`, its request `{ words, example?, answers?, draft? }`.
 * With no provider named, the person's own Claude is used when it is found on this Mac, else the first key kept for
 * Analyse (§11.4, Q14).
 */
export async function workflowDescribe(
  request: unknown,
  choice: { readonly provider?: DescribeProvider | undefined },
  options: Options,
): Promise<WorkflowDescribeResultV1> {
  const env = options.env ?? process.env;
  const client = new EventControlClient({ stateDir: options.stateDir, clientName: options.origin });
  const claude = choice.provider === undefined || choice.provider === 'claude-cli' ? await findClaude(env) : null;
  const provider = choice.provider ?? (claude === null ? undefined : 'claude-cli');
  if (provider !== 'claude-cli')
    return (await client.request('workflow-describe', {
      request,
      ...(provider === undefined ? {} : { provider }),
    })) as WorkflowDescribeResultV1;
  if (claude === null)
    throw new CommsError('PROVIDER_UNAVAILABLE', 'Claude Code was not found on this Mac', {
      details: { reason: 'CLAUDE_NOT_FOUND' },
      hint: 'Install and sign in to Claude Code, or describe it with a key kept for Analyse: --provider openrouter or --provider anthropic.',
    });
  const prompt = (await client.request('workflow-describe-brief', { request })) as DescribePrompt;
  const answer = await runClaude(claude, prompt, {
    env,
    deadlineMs: options.claudeDeadlineMs,
    maxOutputBytes: options.claudeMaxOutputBytes,
  });
  return (await client.request('workflow-describe', {
    request,
    provider: 'claude-cli',
    answer: answer.text,
    ...(answer.model === null ? {} : { model: answer.model }),
  })) as WorkflowDescribeResultV1;
}
