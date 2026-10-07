import { CHANNEL_SNAPSHOT } from './channels.generated.ts';
import { inlineCommand } from './cli-runtime.ts';
import {
  type CliHandoffs,
  type Handoff,
  type HandoffSentenceOptions,
  handoffSentence,
  isCommand,
} from './handoff-text.ts';

/**
 * What a person and an agent are told while an approval waits for the person (design 2026-10-05 §D3 and §D7): the
 * person's `approve`, and the wait the agent learns the outcome from — each made by the 0.13.1 handoffs from the package
 * that prints, so every one is a located command, or the sentence saying why there is none here. Never a bare name.
 *
 * Kept beside the handoffs' words (`handoff-text.ts`) rather than the locator, as they are: the approval store prints
 * these too, and the locator's imports reach the configuration store.
 */

/** Where an approval is asked from: a command line, or an MCP server's tool. */
export type ApprovalSurface = 'cli' | 'mcp' | 'app' | 'daemon';

/** One surface's wait for an approval: its words after the program, the id going last, and its tool. */
export interface ApprovalWaitNames {
  readonly words: readonly string[];
  readonly tool: string;
}

/**
 * The waits there are (design 2026-10-05 §D3), by the manifest channel whose CLI and server have one: exactly the
 * `capabilities.json` rows whose operation is `waitForApproval`, which `test/parity.test.mjs` holds this table to —
 * each command one its CLI defines, each tool one its server registers, each row reaching the wait. A channel with none
 * of its own — WhatsApp, which approves only changes, and only at its command line — is waited on with core's.
 */
export const APPROVAL_WAITS: Readonly<Record<string, ApprovalWaitNames>> = Object.freeze({
  core: Object.freeze({ words: Object.freeze(['approval', 'wait']), tool: 'comms_approval_wait' }),
  gmail: Object.freeze({ words: Object.freeze(['send', 'wait']), tool: 'gmail_send_wait' }),
  resend: Object.freeze({ words: Object.freeze(['send', 'wait']), tool: 'resend_send_wait' }),
  slack: Object.freeze({ words: Object.freeze(['approval', 'wait']), tool: 'slack_approval_wait' }),
});

/** The wait for an approval, as each surface takes it: its tool, and its command — located, or why there is none. */
export interface ApprovalWaitHandoff {
  readonly tool: string;
  readonly command: Handoff;
}

/** The manifest channel of the package that prints, or undefined for a package that is not a channel. */
function printingChannel(handoffs: CliHandoffs): string | undefined {
  return CHANNEL_SNAPSHOT.find((entry) => entry.packageName === handoffs.caller.packageName)?.manifest.channel;
}

/**
 * The wait for `approvalId` the printing package hands over: its own — the server's tool, and its CLI's command,
 * located, pinned to the same folders as its `approve` — or, for a channel with none, core's, located as the core this
 * package has installed.
 */
export function approvalWaitOf(handoffs: CliHandoffs, approvalId: string): ApprovalWaitHandoff {
  const channel = printingChannel(handoffs);
  const own = channel !== undefined && Object.hasOwn(APPROVAL_WAITS, channel) ? APPROVAL_WAITS[channel] : undefined;
  if (own !== undefined) return { tool: own.tool, command: handoffs.own([...own.words, approvalId]) };
  const core = APPROVAL_WAITS.core as ApprovalWaitNames;
  return { tool: core.tool, command: handoffs.core([...core.words, approvalId]) };
}

/**
 * A sentence naming the wait for `approvalId` as `surface` takes it: `say` with its tool over MCP, or with its located
 * command, in backticks, at the command line — and with no command here, `instead` (when given), then why.
 */
export function waitSentence(
  handoffs: CliHandoffs,
  surface: ApprovalSurface,
  approvalId: string,
  say: (wait: string) => string,
  options: HandoffSentenceOptions = {},
): string {
  const wait = approvalWaitOf(handoffs, approvalId);
  return surface === 'mcp' ? say(wait.tool) : handoffSentence(wait.command, say, options);
}

/**
 * A sentence handing an approval to a person (design 2026-10-05 §D7): `say(approve, wait)` with the person's located
 * `approve` and the agent's wait — its tool over MCP, its located command at the command line — both in backticks but
 * the tool. With no `approve` here, `instead` (when given) and why there is none; with an `approve` and no wait
 * command, `say(approve, undefined)` and why there is none. Never a bare name in either's place.
 */
export function approveAndWaitSentence(
  handoffs: CliHandoffs,
  surface: ApprovalSurface,
  approvalId: string,
  say: (approve: string, wait: string | undefined) => string,
  options: HandoffSentenceOptions = {},
): string {
  return handoffSentence(
    handoffs.own(['approve', approvalId]),
    (approve) => {
      const wait = approvalWaitOf(handoffs, approvalId);
      if (surface === 'mcp') return say(approve, wait.tool);
      return isCommand(wait.command)
        ? say(approve, inlineCommand(wait.command))
        : `${say(approve, undefined)} ${wait.command.message}`;
    },
    options,
  );
}

/**
 * What an agent is told when a change waits for a person at a terminal (design 2026-10-05 §D6, §D7): the person's
 * `approve`, the wait, and to try again with the same approval.
 */
export function changePendingHint(handoffs: CliHandoffs, surface: ApprovalSurface, approvalId: string): string {
  return approveAndWaitSentence(handoffs, surface, approvalId, (approve, wait) =>
    wait === undefined
      ? `Ask the user to run ${approve} in their own terminal, then try again with the same approval.`
      : `Ask the user to run ${approve} in their own terminal; learn when they have with ${wait}, then try again with the same approval.`,
  );
}

/**
 * What an agent is told when it ran a person's `approve` itself and was refused: the person runs it in their own
 * terminal, and the agent learns when they have with the wait — the command line's, for the command line it used.
 */
export function approveRefusedHint(handoffs: CliHandoffs, approvalId: string): string {
  return approveAndWaitSentence(handoffs, 'cli', approvalId, (approve, wait) =>
    wait === undefined
      ? `Ask the user to run ${approve} in their own terminal.`
      : `Ask the user to run ${approve} in their own terminal; learn when they have with ${wait}.`,
  );
}
