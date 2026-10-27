import {
  type CliHandoffs,
  describeFenceReport,
  escapeForDisplay,
  handoffSentenceToFill,
  paint,
  type TakenView,
  truncateDisplay,
} from '@agentcomms/core';
import type { AccountView, AddedAccount, PolicyReport, RemovedAccount } from '../operations/accounts.ts';
import type { DoctorResult } from '../operations/doctor.ts';
import type { Readable } from '../operations/read.ts';
import type { CancelledEmail } from '../operations/scheduled.ts';
import type { SendPreparation, SendResult, SendStatus } from '../operations/send.ts';
import type { TakenResult, TakeResult } from '../operations/take.ts';

/**
 * What a person reads at the terminal. `--json` prints the whole result instead; nothing here is the only place a
 * fact is shown. Everything that came from Resend or from a sender passes through core's escaper, so no byte of it
 * can move a cursor or repaint a line.
 */

const show = (value: unknown): string => escapeForDisplay(value === null || value === undefined ? '—' : String(value));

export function renderAccount(view: AccountView, color: boolean): string {
  return [
    paint(color, 'bold', view.name),
    `  id          ${view.id}`,
    `  key         ${view.key === 'full_access' ? 'full access' : 'sending only'}${view.domainLock ? ` (declared: ${view.domainLock})` : ''}`,
    `  mode        ${view.mode}${view.canSend ? '' : ' — cannot send'}`,
    `  send policy ${view.sendPolicy}${view.sendPolicyFrom === 'default' ? ' (the machine default)' : ''}`,
    `  ${view.guarantee}`,
  ].join('\n');
}

/** The accounts; with none, how a person adds one — this installation's own command, `handoffs`'s, or why there is none. */
export function renderAccounts(result: { accounts: AccountView[] }, color: boolean, handoffs: CliHandoffs): string {
  if (result.accounts.length === 0) {
    return handoffSentenceToFill(
      handoffs.own(['account', 'add']),
      ['<org/resend>'],
      (command) => `No Resend account yet. A person adds one with ${command}.`,
      { instead: 'No Resend account yet.' },
    );
  }
  return result.accounts.map((view) => renderAccount(view, color)).join('\n\n');
}

export function renderAdded(view: AddedAccount, color: boolean): string {
  const domains = view.domains.map((domain) => `  ${show(domain.name)}  ${show(domain.status)}`);
  return [
    paint(color, 'green', `Connected ${view.name}.`),
    renderAccount(view, color),
    ...(domains.length > 0 ? ['Domains:', ...domains] : []),
  ].join('\n');
}

export function renderRemoved(result: RemovedAccount): string {
  return `Removed ${result.name}; its key is gone from this machine.${
    result.approvalsVoided.length > 0 ? ` ${result.approvalsVoided.length} waiting approval(s) voided.` : ''
  }`;
}

export function renderPolicy(report: PolicyReport): string {
  return [
    `${report.name}: ${report.mode} mode, send policy ${report.sendPolicy}${report.sendPolicyFrom === 'default' ? ' (the machine default)' : ''}`,
    `Changes to it are approved under the machine's change policy: ${report.changePolicy}.`,
    `A send to more than ${report.confirmAboveRecipients} people needs a person at a terminal, whatever the policy.`,
    // What a change to never did to the approvals prepared before it.
    ...(report.fenced === undefined ? [] : describeFenceReport(report.fenced)),
  ].join('\n');
}

export function renderDoctor(result: DoctorResult, color: boolean): string {
  const line = (check: { ok: boolean; name: string; detail: string; fix?: string | undefined }) =>
    `${check.ok ? paint(color, 'green', 'ok ') : paint(color, 'red', 'no ')} ${check.name}: ${show(check.detail)}${
      check.fix ? `\n     fix: ${show(check.fix)}` : ''
    }`;
  return [
    paint(color, 'bold', result.readOnly),
    '',
    ...result.checks.map(line),
    ...result.accounts.flatMap((account) => [
      '',
      paint(color, 'bold', `${account.name} (${account.key}, ${account.mode})`),
      `  ${account.guarantee}`,
      ...account.checks.map((check) => `  ${line(check)}`),
    ]),
  ].join('\n');
}

/** Any read result: unavailable said plainly, otherwise the data as indented JSON-ish lines. */
export function renderRead(result: Readable<object>, color: boolean): string {
  if (!result.available) return `${paint(color, 'yellow', 'Not available')} for ${result.account}: ${result.reason}`;
  const { account: _account, available: _available, ...data } = result as Record<string, unknown>;
  return escapeForDisplay(JSON.stringify(data, null, 2));
}

export function renderPrepared(result: SendPreparation): string {
  return `${result.preview}\n\nNext: ${escapeForDisplay(result.nextStep)}`;
}

/**
 * What Resend's acceptance means (`said`), with its id when it gave one: a scheduled send is accepted for its time and
 * never called sent; one with no id says so, and names none.
 */
export function renderSent(result: SendResult): string {
  const to = truncateDisplay(result.to.join(', '), 200);
  const said = `${result.said.charAt(0).toUpperCase()}${result.said.slice(1)}`;
  const sent =
    result.resendId === undefined
      ? result.state === 'scheduled'
        ? `${said} — scheduled for ${result.scheduledAt ?? '?'}, to ${to}.`
        : `${said} — to ${to}.`
      : result.state === 'scheduled'
        ? `${said}, as ${result.resendId}, to ${to}.`
        : `Sent as ${result.resendId}, to ${to}.`;
  return result.note ? `${sent}\nNote: ${escapeForDisplay(result.note)}.` : sent;
}

export function renderStatus(result: SendStatus): string {
  return `${result.approvalId}: ${escapeForDisplay(result.verdict)}`;
}

export function renderCancelled(result: CancelledEmail): string {
  const cancelled = `Cancelled ${result.id} (${result.recipients} recipient(s)). It cannot be rescheduled.`;
  return result.hint ? `${cancelled}\nNote: ${escapeForDisplay(result.hint)}` : cancelled;
}

/** Who has an email, in the closed words an agent sees (design 2026-10-26-taking-messages, T7). */
function takenText(taken: TakenView): string {
  if (taken === null) return 'nobody has taken it';
  const back = taken.handedBack === undefined ? '' : `; handed back: ${taken.handedBack.join(', ')}`;
  if (taken.state === 'open') return `nobody has it${back}`;
  if (taken.state === 'offered') {
    const until = taken.offered?.until ?? null;
    return `offered to ${taken.offered?.to ?? 'another session'}${until === null ? '' : ` until ${until}`}${back}`;
  }
  const who = taken.by === 'you' ? 'this session' : (taken.by ?? 'another session');
  return `${taken.state === 'done' ? 'done by' : 'taken by'} ${who}${taken.since === undefined ? '' : ` since ${taken.since}`}${back}`;
}

export function renderTake(result: TakeResult): string {
  const said =
    result.step === 'take'
      ? result.changed
        ? `Taken: ${result.account} ${result.message} is this session's`
        : `Still this session's: ${result.account} ${result.message}`
      : result.step === 'hand-back'
        ? `Handed back: ${result.account} ${result.message} is open to every session again`
        : `Done: ${result.account} ${result.message}; other sessions stay refused it`;
  return result.leaseUntil === null ? `${said}.` : `${said}, until ${result.leaseUntil} without another act on it.`;
}

export function renderTaken(result: TakenResult): string {
  if (result.messages.length === 0) return `This session holds no email in ${result.account}.`;
  return result.messages.map((entry) => `${entry.id}  ${takenText(entry.taken)}`).join('\n');
}
