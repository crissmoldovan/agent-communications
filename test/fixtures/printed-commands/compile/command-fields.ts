/*
 * §4 7a (CUE-403 task 15): every result field that carries a command a person runs is typed so that a plain string, a
 * template or an argument fragment does not compile in its place. A field whose value is the command is the command
 * itself — a `PrintedCommand` the locator made, the sentence saying why there is none here, or an `ExternalCommand` —
 * and is written out as text where it leaves the process. A field that mixes commands and words — a doctor's `fix`, a
 * list of next steps — is a `Remedy`, which only `remedy(…)` makes from those commands and words.
 *
 * Each `@ts-expect-error` below is a string that must not compile. Compiled by `test/printed-command-types.test.mjs`:
 * if any of these fields accepted a string, its directive would be unused, and that is a compile error too.
 */

import { approvalHint } from '../../../../packages/core/src/change-flow.ts';
import type { PrintedCommand } from '../../../../packages/core/src/cli-command.ts';
import {
  commandText,
  inlineCommand,
  lineWithWordsToFill,
  type PersonGate,
} from '../../../../packages/core/src/cli-runtime.ts';
import {
  type CliHandoffs,
  type Handoff,
  handoffSentence,
  handoffText,
  type Remedy,
  remedy,
} from '../../../../packages/core/src/handoff-text.ts';
import type { LooserOverride } from '../../../../packages/core/src/operations/change-policy.ts';
import type { DoctorCheck } from '../../../../packages/core/src/operations/maintenance.ts';
import type { LegacyServerFinding } from '../../../../packages/core/src/other-servers.ts';
import type { FinishRegistration, SetupHandoff } from '../../../../packages/gmail/src/cli/render.ts';
import type { Check as GmailCheck } from '../../../../packages/gmail/src/operations/doctor.ts';
import type { ImportResult } from '../../../../packages/gmail/src/operations/import-legacy.ts';
import type { DoctorCheck as ResendCheck } from '../../../../packages/resend/src/operations/doctor.ts';
import type { AppCreated } from '../../../../packages/slack/src/operations/app.ts';
import type { AppUpdateNeeded, SignInStarted } from '../../../../packages/slack/src/operations/changes.ts';
import type { Check as SlackCheck } from '../../../../packages/slack/src/operations/doctor.ts';
import { approveCommand, refileCommand } from '../../../../packages/slack/src/operations/send.ts';
import type { AddedAccount } from '../../../../packages/whatsapp/src/operations/accounts.ts';
import type { ChatListsResult } from '../../../../packages/whatsapp/src/operations/chat-lists.ts';

declare const handoffs: CliHandoffs;
declare const located: Handoff;
declare const alias: string;
// A channel's own functions take the handoffs it has — core's types as its build declares them — so each is named
// from the function itself: a mismatch between two copies of core's types must not be the error a directive meets.
declare const slackHandoffs: Parameters<typeof approveCommand>[1];

// ── core ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const looser: LooserOverride['tighten'] = {
  tool: 'comms_change_policy',
  arguments: { account: alias, set: 'confirm' },
  // @ts-expect-error a template with the binary in it is no command either
  command: `agentcomms policy --account ${alias} confirm`,
};

export const coreCheck: DoctorCheck = {
  name: 'config',
  ok: false,
  detail: 'x',
  // @ts-expect-error a doctor's fix is a remedy made from commands, never a string
  fix: 'agentcomms doctor',
};

export const finding: Pick<LegacyServerFinding, 'removal'> = {
  // @ts-expect-error how a rival is removed is a remedy too
  removal: 'claude mcp remove gmail',
};

export const gate: Pick<PersonGate, 'command'> = {
  // @ts-expect-error the command a person runs at the gate is located
  command: 'agentcomms approve ap_1',
};

// @ts-expect-error a command run again is located, never a line
approvalHint({ approvalId: 'ap_1', policy: 'chat' }, 'agentcomms policy chat --approval ap_1', handoffs);

// @ts-expect-error a command is rendered only from one of the two brands
inlineCommand('agent-gmail approve ap_1');
// @ts-expect-error nor from anything shaped like one
commandText({ words: ['agent-gmail', 'approve'], line: 'agent-gmail approve', platform: 'linux' });
// @ts-expect-error nor with words to fill
lineWithWordsToFill('agent-gmail client add', '<client_secret.json>');
// @ts-expect-error a handoff's text is made from a handoff
handoffText('agent-gmail setup');
// @ts-expect-error and so is its sentence
handoffSentence('agent-gmail setup', (command) => `Run ${command}.`);

// ── Gmail ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const gmailCheck: GmailCheck = {
  id: 'clients',
  title: 'x',
  status: 'fail',
  detail: 'x',
  // @ts-expect-error an option-only fragment is no fix
  fix: '--inbox work',
};

export const claim: Extract<FinishRegistration, { status: 'approval-required' }> = {
  client: 'cursor',
  status: 'approval-required',
  approvalId: 'ap_1',
  policy: 'chat',
  summary: 'x',
  preview: 'x',
  expiresAt: 'x',
  // @ts-expect-error the claim is this installation's own `mcp install`, located
  claim: 'agent-gmail mcp install --client cursor --approval ap_1',
  hint: 'x',
};

export const setupHandoff: SetupHandoff = {
  authUrl: 'https://accounts.example.test/',
  // @ts-expect-error the finish is located
  finish: `agent-gmail inbox add --finish ${alias}`,
};

export const imported: Pick<ImportResult, 'nextSteps'> = {
  // @ts-expect-error each next step is a remedy
  nextSteps: ['agent-gmail doctor'],
};

// ── Slack ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const finish: SignInStarted['finish'] = {
  tool: 'slack_workspace_finish',
  // @ts-expect-error the finish is located
  command: `agent-slack workspace add --finish ${alias}`,
};

export const alternative: Pick<AppUpdateNeeded, 'terminalAlternative'> = {
  // @ts-expect-error the terminal's alternative is located, or there is none
  terminalAlternative: 'agent-slack app update acme/slack --mode send',
};

export const created: Pick<AppCreated, 'next'> = {
  // @ts-expect-error what connects the new app is located
  next: 'agent-slack workspace add acme/slack --client-id 1.2',
};

export const slackCheck: Pick<SlackCheck, 'fix'> = {
  // @ts-expect-error a doctor's fix is a remedy
  fix: 'agent-slack doctor',
};

// @ts-expect-error the approve command a refusal carries is located
export const slackApprove: string = approveCommand('ap_1', slackHandoffs);
// @ts-expect-error and so is the draft's refile
export const slackRefile: string = refileCommand('acme/slack', 'd_1', slackHandoffs);

// ── Resend ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const resendCheck: ResendCheck = {
  name: 'key stored',
  ok: false,
  detail: 'x',
  // @ts-expect-error a doctor's fix is a remedy
  fix: 'agent-resend account remove acme/resend',
};

// ── WhatsApp ────────────────────────────────────────────────────────────────────────────────────────────────────

export const added: Pick<AddedAccount, 'next'> = {
  // @ts-expect-error the sync that follows is located
  next: 'agent-whatsapp sync --account personal/whatsapp',
};

export const lists: Pick<ChatListsResult, 'next'> = {
  // @ts-expect-error and so is the sync a list change asks for
  next: 'agent-whatsapp sync --account personal/whatsapp',
};

// ── What each field does take ───────────────────────────────────────────────────────────────────────────────────

export const accepted = {
  tighten: {
    tool: 'comms_change_policy',
    arguments: { set: 'confirm' },
    command: located,
  } satisfies LooserOverride['tighten'],
  check: { name: 'x', ok: true, detail: 'x', fix: remedy(located, 'words around it') } satisfies DoctorCheck,
  removal: remedy([located, ', then restart the client']) satisfies Remedy,
  returned: (command: PrintedCommand): PrintedCommand => command,
};
