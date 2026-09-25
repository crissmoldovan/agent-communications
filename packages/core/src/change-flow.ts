import {
  beginChangeApproval,
  type ChangeRequest,
  type ChangeSurface,
  claimChange,
  finishChangeApproval,
  type PreparedChange,
  prepareChange,
  recordChangeApprovalRefused,
  revokeChange,
} from './changes.ts';
import { agentMarker, canPrompt, defaultStreams, paint, refuseUnlessPerson, type Streams } from './cli-runtime.ts';
import { type Config, classifyChange, type LooseningConsent } from './config.ts';
import type { Core } from './core.ts';
import { CommsError } from './errors.ts';

/**
 * One changing operation, run the same way from the CLI and from MCP.
 *
 * Every command and tool that changes an account — connecting one, widening it, loosening a policy, removing it —
 * goes through here, so the two surfaces cannot drift in how they ask. Three agents built those commands and tools in
 * parallel; one shape written once is the only way they stay the same shape.
 *
 * `plan` computes the change from the configuration as it stands *now*, and runs on both calls. That is what makes
 * the second call safe: the approval is claimed against the change as it would happen at that moment, and
 * `claimChange` refuses when that is no longer what the person approved.
 */
export interface GatedChange<T> {
  /** Computes the change from the configuration as it is now. */
  plan: (config: Config) => ChangeRequest | Promise<ChangeRequest>;
  /** Applies it. `consent` is what `ConfigStore.update` needs for a loosening; undefined when nothing loosens. */
  apply: (consent: LooseningConsent | undefined, request: ChangeRequest) => Promise<T>;
}

export type GatedOutcome<T> =
  | { status: 'applied'; result: T }
  | { status: 'approval-required'; prepared: PreparedChange };

/**
 * Applies a change at once when it needs nobody's agreement; otherwise prepares an approval the first time and claims
 * it on the second call, with its id.
 *
 * A change that loosens no setting and does nothing irreversible is applied directly: asking a person to agree to
 * something that needs no agreement teaches them to agree without reading.
 */
export async function gatedChange<T>(
  core: Core,
  change: GatedChange<T>,
  options: { surface: ChangeSurface; approvalId?: string | undefined },
): Promise<GatedOutcome<T>> {
  const request = await change.plan(await core.config.load());
  const loosens = classifyChange(request.before, request.after).loosened.length > 0;
  const acts = (request.effects ?? []).length > 0;
  if (!loosens && !acts) return { status: 'applied', result: await change.apply(undefined, request) };
  if (!options.approvalId) {
    return { status: 'approval-required', prepared: await prepareChange(core, request, { surface: options.surface }) };
  }
  const consent = await claimChange(core, options.approvalId, request, { surface: options.surface });
  return { status: 'applied', result: await change.apply(consent, request) };
}

/**
 * The same, as an MCP tool returns it.
 *
 * `approvalRequired` with the preview and what to do next, or the result. The agent shows the preview in full and
 * asks; under `chat` it calls the tool again with `approvalId` once the person says yes, and under `confirm` it gives
 * them the command and calls again after they have run it.
 */
export function changeToolResult<T>(outcome: GatedOutcome<T>): Record<string, unknown> {
  if (outcome.status === 'applied') return { applied: true, result: outcome.result as unknown };
  const { prepared } = outcome;
  return {
    applied: false,
    approvalRequired: true,
    approvalId: prepared.approvalId,
    policy: prepared.policy,
    summary: prepared.summary,
    preview: prepared.preview,
    expiresAt: prepared.expiresAt,
    next: prepared.next,
  };
}

/**
 * A changing command at the CLI.
 *
 * With `--approval <id>` it claims that approval and applies. Without one, a person at a terminal approves there and
 * then: a plain `yes` under `chat`, the typed code under `confirm` — the person *is* the approver, so there is nobody to
 * send away. An agent, or anything without a terminal, gets the preview and the approval id and exits 10, exactly as a
 * post waiting for approval does; it runs the command again with `--approval <id>` once the person has agreed.
 */
export async function gatedChangeAtTerminal<T>(
  core: Core,
  change: GatedChange<T>,
  options: {
    approvalId?: string | undefined;
    env: NodeJS.ProcessEnv;
    output: { json?: boolean | undefined; color: boolean };
    /** The command to run again with `--approval <id>`, for the message an agent gets. */
    command: string;
    streams?: Streams | undefined;
  },
): Promise<T> {
  const streams = options.streams ?? defaultStreams;
  const first = await gatedChange(core, change, { surface: 'cli', approvalId: options.approvalId });
  if (first.status === 'applied') return first.result;

  const { prepared } = first;
  const person =
    agentMarker(options.env) === null && canPrompt(options.env, streams, { json: options.output.json === true });
  if (!person) {
    throw new CommsError('APPROVAL_PENDING', `this change needs approval first: ${prepared.summary}`, {
      hint:
        prepared.policy === 'confirm'
          ? `Show the person the preview. They run \`agentcomms approve ${prepared.approvalId}\`; then run \`${options.command} --approval ${prepared.approvalId}\`.`
          : `Show the person the preview. Once they say yes, run \`${options.command} --approval ${prepared.approvalId}\`.`,
      details: {
        approvalId: prepared.approvalId,
        policy: prepared.policy,
        preview: prepared.preview,
        expiresAt: prepared.expiresAt,
      },
    });
  }

  if (prepared.policy === 'confirm') {
    const outcome = await approveChangeAtTerminal(core, prepared.approvalId, options.env, options.output, streams);
    if (outcome.state !== 'approved') throw cancelled();
  } else {
    streams.stdout.write(`${prepared.preview}\n\n`);
    const answer = await askLine(streams, `Type ${paint(options.output.color, 'bold', 'yes')} to apply this change: `);
    if (answer.trim().toLowerCase() !== 'yes') {
      await revokeChange(core, prepared.approvalId, 'cancelled at the terminal', { surface: 'cli' });
      throw cancelled();
    }
  }
  const second = await gatedChange(core, change, { surface: 'cli', approvalId: prepared.approvalId });
  if (second.status !== 'applied') throw new CommsError('UNEXPECTED', 'the approved change asked for approval again');
  return second.result;
}

/**
 * Approves a configuration change at a terminal, the way a person approves a send: read the preview, type the code.
 *
 * Under the `confirm` change policy this is what "a person approved it" means, so it is the one command here an agent
 * may not run for the user, and it is refused by the same gate every other loosening goes through. A shell agent can
 * get past that gate — `script -q /dev/null` makes any command see a terminal — so it is a speed bump against the
 * ordinary case, as it is for every approval, not a boundary.
 *
 * It approves and changes nothing. What prepared the change makes it, by claiming the approval once; and a refusal to
 * even ask is recorded, so the audit trail shows an agent that tried.
 *
 * Exported so the whole command can be tested with streams that are a terminal: a subprocess test cannot have one.
 */
export async function approveChangeAtTerminal(
  core: Core,
  approvalId: string,
  env: NodeJS.ProcessEnv,
  output: { json?: boolean | undefined; color: boolean },
  streams: Streams = defaultStreams,
): Promise<{ approvalId: string; state: 'approved' | 'cancelled' }> {
  try {
    refuseUnlessPerson(env, streams, {
      refusedToAgent: 'only a person can approve a change, not an agent',
      refusedWithoutTerminal: 'approving a change needs an interactive terminal',
      command: `agentcomms approve ${approvalId}`,
      color: output.color,
      json: output.json,
    });
  } catch (error) {
    await recordChangeApprovalRefused(core, approvalId, error, { surface: 'cli' });
    throw error;
  }
  const prompt = await beginChangeApproval(core, approvalId, { surface: 'cli' });
  streams.stdout.write(`${prompt.preview}\n\n`);
  const answer = await askLine(
    streams,
    `Type ${paint(output.color, 'bold', prompt.challenge)} to approve this change, or press Enter to cancel: `,
  );
  if (!answer.trim()) {
    await revokeChange(core, approvalId, 'cancelled at the terminal', { surface: 'cli' });
    return { approvalId, state: 'cancelled' };
  }
  await finishChangeApproval(core, approvalId, answer, { surface: 'cli' });
  return { approvalId, state: 'approved' };
}

function cancelled(): CommsError {
  return new CommsError('USAGE', 'cancelled: nothing was changed');
}

async function askLine(streams: Streams, question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({
    input: streams.stdin as NodeJS.ReadableStream,
    output: streams.stderr as NodeJS.WritableStream,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
