import { Chip, EmptyState, Panel, Row, Spinner } from '@cueplusplus/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { COPY } from '../copy.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { errorMessage, FINISHED_APPROVAL_STATES } from '../ipc.ts';
import { productLabel } from './ApprovalCard.tsx';
import { UntrustedText } from './UntrustedText.tsx';

/** Recent's words. */
export const RECENT_COPY = {
  nothing: 'Nothing finished in the last 30 days.',
  unreadable: 'The approvals list could not be read.',
  someUnreadable: 'Some finished approvals could not be read:',
} as const;

/** How far back Recent looks: 30 days (design 2026-10-25-activity §4.5). The store keeps 90. */
export const RECENT_DAYS = 30;

/** One finished approval, as Recent shows it: never anything a sender wrote. */
export interface FinishedApproval {
  approvalId: string;
  kind: string | null;
  channel: string | null;
  /** The mailbox or account it belonged to, by its id: software data, never a name a sender chose. */
  account: string | null;
  state: string;
  /** When it was decided or ended, by its state: used, approved, failed, expired, revoked. */
  at: string | null;
  /** Why it failed, was revoked or ended unknown, in core's words. */
  reason: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The moment a record's state names: when it was used, approved, failed, expired or revoked; its creation else. */
function decidedAt(record: Record<string, unknown>, state: string): string | null {
  const first = (...keys: string[]) => keys.map((key) => text(record[key])).find((value) => value !== null) ?? null;
  switch (state) {
    case 'used':
      return first('usedAt', 'sentAt', 'approvedAt', 'createdAt');
    case 'approved':
    case 'answered':
      return first('approvedAt', 'usedAt', 'createdAt');
    case 'failed':
      return first('failedAt', 'sendingAt', 'createdAt');
    case 'unknown':
      return first('unknownAt', 'sendingAt', 'createdAt');
    case 'expired':
      return first('expiredAt', 'expiresAt', 'createdAt');
    case 'revoked':
      return first('revokedAt', 'createdAt');
    default:
      return first('createdAt');
  }
}

/** One list `approvals list --state <state>` gave, read: null when it is not a list. */
export function readFinished(value: unknown): FinishedApproval[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isRecord).flatMap((record) => {
    const approvalId = text(record.approvalId);
    if (approvalId === null) return [];
    const state = text(record.state) ?? 'unknown';
    return [
      {
        approvalId,
        kind: text(record.kind),
        channel: text(record.channel),
        account: text(record.inboxId),
        state,
        at: decidedAt(record, state),
        reason: state === 'failed' || state === 'unknown' || state === 'revoked' ? text(record.reason) : null,
      },
    ];
  });
}

/** Those decided in the last `RECENT_DAYS` days, newest first, each once. */
export function recentOf(lists: readonly FinishedApproval[][], now: number = Date.now()): FinishedApproval[] {
  const from = now - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const time = (each: FinishedApproval) => (each.at === null ? Number.NaN : Date.parse(each.at));
  return lists
    .flat()
    .filter((each) => {
      if (seen.has(each.approvalId)) return false;
      seen.add(each.approvalId);
      const at = time(each);
      return Number.isFinite(at) && at >= from;
    })
    .sort((a, b) => time(b) - time(a));
}

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

/** The decision, in a word or two, and its tone: what happened to it in the end. */
export function decisionOf(approval: FinishedApproval): { words: string; tone: Tone } {
  switch (approval.state) {
    case 'used':
      return {
        words:
          approval.kind === 'send'
            ? 'Sent'
            : approval.kind === 'change'
              ? 'Applied'
              : approval.kind === 'download'
                ? 'Saved'
                : 'Used',
        tone: 'ok',
      };
    case 'approved':
      return { words: 'Approved', tone: 'ok' };
    case 'answered':
      return { words: 'Answered', tone: 'ok' };
    case 'failed':
      return { words: 'Failed', tone: 'danger' };
    case 'unknown':
      return { words: 'Outcome unknown', tone: 'warn' };
    case 'expired':
      return { words: 'Expired', tone: 'neutral' };
    case 'revoked':
      return { words: 'Revoked', tone: 'neutral' };
    default:
      return { words: approval.state, tone: 'neutral' };
  }
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  send: 'Send',
  change: 'Change',
  download: 'Download',
  disclosure: 'Disclosure',
  standing: 'Standing approval',
};

const FULL = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** When, short: the time when it is today, the day otherwise, and the full moment on hover. */
function When({ at }: { at: string }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <UntrustedText text={at} />;
  const today = date.toDateString() === new Date().toDateString();
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(undefined, FULL)}>
      {today
        ? date.toLocaleTimeString(undefined, { timeStyle: 'short' })
        : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
    </time>
  );
}

type Lists =
  | { state: 'loading' }
  | { state: 'ready'; approvals: FinishedApproval[]; problems: string[] }
  | { state: 'error'; message: string };

/**
 * Every finished state's list (S5), read together when Recent opens and again when the window comes back: one
 * allow-listed `approvalsFinished` call for each state, since `approvals list` takes one. A list that fails is said,
 * beside what the others found.
 */
function useFinished(): Lists {
  const bridge = useBridge();
  const [lists, setLists] = useState<Lists>({ state: 'loading' });
  const asked = useRef(0);
  const run = useCallback(async () => {
    const ask = ++asked.current;
    const answers = await Promise.all(
      FINISHED_APPROVAL_STATES.map(async (state) => {
        try {
          const result = await bridge.cli({ kind: 'approvalsFinished', state });
          if (result.status === 'ok') {
            const list = readFinished(result.data);
            return list === null ? { problem: RECENT_COPY.unreadable } : { list };
          }
          return { problem: result.status === 'failed' ? result.message : RECENT_COPY.unreadable };
        } catch (error) {
          return { problem: errorMessage(error) };
        }
      }),
    );
    if (ask !== asked.current) return;
    const found = answers.flatMap((answer) => ('list' in answer ? [answer.list] : []));
    const problems = [...new Set(answers.flatMap((answer) => ('problem' in answer ? [answer.problem] : [])))];
    setLists(
      found.length === 0
        ? { state: 'error', message: problems[0] ?? RECENT_COPY.unreadable }
        : { state: 'ready', approvals: recentOf(found), problems },
    );
  }, [bridge]);
  useEffect(() => {
    void run();
  }, [run]);
  useReloadOnReturn(run);
  return lists;
}

/**
 * Approvals → Recent (design 2026-10-25-activity S5): what was approved, used, refused, expired or revoked in the last
 * 30 days, from the approval store, newest first. Read-only: a row is a record, with its kind and channel, the account
 * by its id, the decision and when, and its id in mono. Nothing a sender wrote is shown here.
 */
export function RecentApprovals() {
  const lists = useFinished();
  if (lists.state === 'loading') return <Spinner label={COPY.loading} />;
  if (lists.state === 'error') {
    return (
      <p role="alert" className="text-danger">
        <UntrustedText text={lists.message} />
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      {lists.problems.length === 0 ? null : (
        <p role="alert" className="text-danger">
          <UntrustedText text={`${RECENT_COPY.someUnreadable} ${lists.problems.join(' ')}`} />
        </p>
      )}
      <Panel>
        {lists.approvals.length === 0 ? (
          <EmptyState title={RECENT_COPY.nothing} />
        ) : (
          <ul aria-label="Finished approvals">
            {lists.approvals.map((approval) => {
              const decision = decisionOf(approval);
              const kind =
                (approval.kind === null ? undefined : KIND_WORDS[approval.kind]) ?? approval.kind ?? 'Approval';
              return (
                <li key={approval.approvalId} data-approval={approval.approvalId} data-state={approval.state}>
                  <Row className="items-center gap-(--cue-space-4)">
                    <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
                      <span className="text-fg">{`${kind} · ${productLabel(approval.channel)}`}</span>
                      <span className="flex min-w-0 flex-wrap gap-x-(--cue-space-2) text-(length:--cue-text-label) text-fg-muted">
                        <span className="break-all font-mono">{approval.approvalId}</span>
                        {approval.account === null ? null : (
                          <span className="break-all">
                            <span className="text-fg-subtle">Account </span>
                            <span className="font-mono">{approval.account}</span>
                          </span>
                        )}
                      </span>
                      {approval.reason === null ? null : (
                        <span className="text-(length:--cue-text-label) text-fg-muted">
                          <UntrustedText text={approval.reason} />
                        </span>
                      )}
                    </span>
                    <Chip tone={decision.tone} variant="tinted" data-slot="decision">
                      {decision.words}
                    </Chip>
                    <span className="shrink-0 text-right text-(length:--cue-text-label) text-fg-muted">
                      {approval.at === null ? null : <When at={approval.at} />}
                    </span>
                  </Row>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
