import { Button, Chip, EmptyState, Panel, Table } from '@cueplusplus/ui';
import { type ReactNode, useState } from 'react';
import type { BehaviourChangeResult, BehaviourReport, StandingReport, StandingView } from '../cli-types.ts';
import { ChangePreview } from '../components/ChangePreview.tsx';
import { Fact, Facts } from '../components/Facts.tsx';
import { RuleForm } from '../components/RuleForm.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY } from '../copy.ts';
import type { Loadable } from '../data.tsx';
import { isAccountName, isApprovalId, isConversation } from '../grammar.ts';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import type { Call } from '../ipc.ts';

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;

/*
 * The old Agent screen's behaviour rules and standing approvals (0.22.0, 0.23.0), left here for the account pages
 * (0.34.0, B2) to reuse or replace: the screen itself is Your agents now (`YourAgents.tsx`), which shows only the label.
 */

/** A read a view shows, and asks again after a change. */
export type Read<T> = { result: Loadable<T>; reload(): Promise<void> };

/** A read's loading and error states in a panel of their own; its value as the view lays it out. */
function Pending<T>({ value, children }: { value: Loadable<T>; children: (value: T) => ReactNode }) {
  if (value.state !== 'ready') {
    return (
      <Panel className="p-(--cue-space-5)">
        <ScreenState value={value}>{() => null}</ScreenState>
      </Panel>
    );
  }
  return <>{children(value.value)}</>;
}

/** What went wrong, and what to do about it, as the CLI said them. */
function Refusal({ message, hint }: { message: string; hint: string | null }) {
  return (
    <div className="flex flex-col gap-(--cue-space-1)">
      <p role="alert" className="text-danger">
        <UntrustedText text={message} />
      </p>
      {hint === null ? null : (
        <p className="text-fg-muted">
          <UntrustedText text={hint} />
        </p>
      )}
    </div>
  );
}

/** A warning that sits above what it is about, on the warn tint. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--cue-space-1) rounded-surface bg-(--cue-warn-soft) px-(--cue-space-5) py-(--cue-space-4)">
      {children}
    </div>
  );
}

/** What an agent may start, as a rule or the report says it. */
function actsText(acts: readonly string[] | 'all'): string {
  if (acts === 'all') return 'all';
  return acts.length === 0 ? 'nothing' : acts.join(', ');
}

/** What an applied change says: what it did, or why nothing was written. */
function appliedLine(data: unknown): string {
  const result = (typeof data === 'object' && data !== null ? data : {}) as Partial<BehaviourChangeResult>;
  const note = typeof result.note === 'string' && result.note !== '' ? result.note : null;
  if (result.changed === false) return note ?? 'Nothing was changed.';
  return note === null ? 'Applied.' : `Applied. ${note}`;
}

/**
 * The behaviour rules (`behaviour`, 0.22.0), and the one flow every change to them goes through (DA10): the CLI is
 * asked once, with `--json`. A tightening applies there and then, and the rules are read again; a loosening comes back
 * waiting, and its preview shows under the app's own header, with Approve in Terminal. The app never approves it, and
 * never asks again with the approval.
 */
export function Rules({ read }: { read: Read<BehaviourReport> }) {
  const { result, reload } = read;
  const change = useChange();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [opened, setOpened] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ message: string; hint: string | null } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const run = async (call: Extract<Call, { kind: 'behaviourAllow' | 'behaviourClear' }>) => {
    setSaid(null);
    setRefused(null);
    setOpened(false);
    const outcome = await change.run(call);
    switch (outcome.state) {
      case 'applied':
        setWaiting(null);
        setSaid(appliedLine(outcome.data));
        await reload();
        return;
      case 'needsTerminal':
        setWaiting(outcome);
        return;
      case 'failed':
        setRefused({ message: outcome.message, hint: outcome.hint });
        return;
    }
  };

  const remove = async (rule: BehaviourReport['rules'][number]) => {
    if (!isAccountName(rule.account) || (rule.conversation !== undefined && !isConversation(rule.conversation))) {
      setRefused({ message: 'This rule names a place that cannot be passed on safely.', hint: null });
      return;
    }
    const key = placeKey(rule);
    setRemoving(key);
    try {
      await run({
        kind: 'behaviourClear',
        account: rule.account,
        ...(rule.conversation === undefined ? {} : { conversation: rule.conversation }),
      });
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="flex flex-col gap-(--cue-space-5)">
      <Pending value={result}>
        {(report) => (
          <>
            {report.unreadable.length === 0 ? null : (
              <Notice>
                <p className="text-warn">
                  Rules this release cannot read hold their account, or every account, to nothing:
                </p>
                <p className="text-fg">
                  <UntrustedText
                    text={report.unreadable
                      .map((each) => (each.account === null ? each.reason : `${each.account}: ${each.reason}`))
                      .join('\n')}
                  />
                </p>
              </Notice>
            )}
            <Panel>
              {report.rules.length === 0 ? (
                <EmptyState
                  title="No rules: agents may do whatever each account allows."
                  hint="A rule narrows what an agent may start on an account, or in one conversation of it."
                />
              ) : (
                <Table.Root>
                  <Table.Caption className="sr-only">Rules</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Account</Table.Head>
                      <Table.Head>Conversation</Table.Head>
                      <Table.Head>Agents may</Table.Head>
                      <Table.Head>
                        <span className="sr-only">Actions</span>
                      </Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {report.rules.map((rule) => (
                      <Table.Row key={placeKey(rule)}>
                        <Table.Cell>
                          <span className="flex items-center gap-(--cue-space-2)">
                            <span>{rule.account}</span>
                            {rule.orphan ? (
                              <Chip tone="warn" variant="tag">
                                not connected
                              </Chip>
                            ) : null}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          {rule.conversation === undefined ? (
                            <span className="text-fg-muted">the whole account</span>
                          ) : (
                            <UntrustedText text={rule.conversation} />
                          )}
                        </Table.Cell>
                        <Table.Cell>{actsText(rule.acts)}</Table.Cell>
                        <Table.Cell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={removing === placeKey(rule)}
                            disabled={removing !== null && removing !== placeKey(rule)}
                            onClick={() => void remove(rule)}
                          >
                            Remove
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              )}
            </Panel>
            <Panel>
              <RuleForm accounts={report.accounts.map((account) => account.account)} onSubmit={run} />
            </Panel>
          </>
        )}
      </Pending>
      {said === null && refused === null && waiting === null ? null : (
        <div className="flex flex-col gap-(--cue-space-3)">
          {said === null ? null : (
            <p role="status" className="text-fg">
              <UntrustedText text={said} />
            </p>
          )}
          {refused === null ? null : <Refusal message={refused.message} hint={refused.hint} />}
          {waiting === null ? null : (
            <ChangePreview
              key={waiting.approvalId}
              change={waiting}
              onDone={(done) => {
                if (done === 'cancelled') {
                  setWaiting(null);
                  setSaid('Cancelled: nothing was changed.');
                  return;
                }
                setOpened(true);
                void reload();
              }}
            />
          )}
          {waiting !== null && opened ? (
            <p className="text-fg-muted">
              Confirm it in Terminal. The rules here are read again when you come back to this window.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** One place, one rule: an account, and a conversation or none. */
function placeKey(rule: { account: string; conversation?: string }): string {
  return `${rule.account}\u0000${rule.conversation ?? ''}`;
}

/** A standing approval's state, in the shared vocabulary. */
const STATE_TONE: Record<StandingView['state'], 'ok' | 'info' | 'neutral'> = {
  active: 'ok',
  pending: 'info',
  ended: 'neutral',
};

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** How many standing approvals are in each state, in the chips' words: `1 active · 1 ended`. */
function tally(approvals: readonly StandingView[]): string {
  return (['active', 'pending', 'ended'] as const)
    .map((state) => [state, approvals.filter((each) => each.state === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(' · ');
}

/**
 * The standing approvals (`standing list`, 0.23.0): what each lets an agent do in Slack without asking, where, how
 * often, and until when. Each change here only takes away, so it applies at once: `Revoke` ends one, and `End every
 * standing approval` ends them all. Making one, or allowing more, is Slack's, approved with a code at a terminal.
 */
export function Standing({ read }: { read: Read<StandingReport> }) {
  const { result, reload } = read;
  const change = useChange();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ message: string; hint: string | null } | null>(null);

  const run = async (call: Extract<Call, { kind: 'standingRevoke' | 'standingOff' }>) => {
    setSaid(null);
    setRefused(null);
    if (call.kind === 'standingRevoke' && !isApprovalId(call.id)) {
      setRefused({ message: 'This standing approval has an id that cannot be passed on safely.', hint: null });
      return;
    }
    setBusy(call.kind === 'standingRevoke' ? call.id : 'off');
    try {
      const outcome = await change.run(call);
      if (outcome.state === 'applied') {
        // What could not be done while ending them all the same (core's `partial`): said beside it.
        const partial = (outcome.data as { partial?: unknown } | null)?.partial;
        const notes = Array.isArray(partial) ? partial.filter((note): note is string => typeof note === 'string') : [];
        const done = call.kind === 'standingOff' ? 'Every standing approval has ended.' : `Revoked ${call.id}.`;
        setSaid([done, ...notes].join('\n'));
        await reload();
      } else if (outcome.state === 'failed') {
        setRefused({ message: outcome.message, hint: outcome.hint });
      } else {
        // Never: these only take away. Nothing is sent to Terminal for them.
        setRefused({
          message: 'The CLI asked for an approval this change should not need. Nothing was changed.',
          hint: null,
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const live = result.state === 'ready' ? result.value.approvals.filter((each) => each.state !== 'ended') : [];
  // Ending them all is offered whenever there may be one to end: while the list could not be read, too.
  const offerOff = result.state === 'error' || live.length > 0;
  const counted = result.state === 'ready' ? tally(result.value.approvals) : '';

  return (
    <div className="flex flex-col gap-(--cue-space-4)">
      {offerOff || counted !== '' ? (
        <div className="flex min-h-control-md items-center gap-(--cue-space-3)">
          <span className="text-fg-muted">{counted}</span>
          {offerOff ? (
            <Button
              className="ml-auto"
              size="sm"
              variant="danger-outline"
              loading={busy === 'off'}
              disabled={busy !== null && busy !== 'off'}
              onClick={() => void run({ kind: 'standingOff' })}
            >
              {COPY.endEveryStanding}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Pending value={result}>
        {(report) =>
          report.approvals.length === 0 ? (
            <Panel>
              <EmptyState
                title="No standing approvals."
                hint="An agent proposes one in Slack, and you approve it with its code at your own terminal."
              />
            </Panel>
          ) : (
            <ul aria-label="Standing approvals" className="flex flex-col gap-(--cue-space-3)">
              {report.approvals.map((approval) => (
                <li key={approval.id}>
                  <Panel className="flex flex-col gap-(--cue-space-4) p-(--cue-space-5)">
                    <div className="flex flex-wrap items-center gap-(--cue-space-3)">
                      <Chip tone={STATE_TONE[approval.state]}>{approval.state}</Chip>
                      <span className="font-mono text-fg">{approval.id}</span>
                      <span className="text-fg-muted">{approval.workspace}</span>
                      {approval.state === 'ended' ? null : (
                        <Button
                          className="ml-auto"
                          size="sm"
                          variant="ghost"
                          loading={busy === approval.id}
                          disabled={busy !== null && busy !== approval.id}
                          onClick={() => void run({ kind: 'standingRevoke', id: approval.id })}
                        >
                          {COPY.revoke}
                        </Button>
                      )}
                    </div>
                    <Facts>
                      <Fact name="Allows">
                        <span className="flex flex-col gap-(--cue-space-1)">
                          {approval.contents.map((content) => (
                            <UntrustedText key={content.digest} text={`${content.kind}: ${content.text}`} />
                          ))}
                        </span>
                      </Fact>
                      <Fact name="Where">
                        {approval.places.kind === 'threads-i-am-in' ? (
                          'threads I am in'
                        ) : (
                          <span className="flex flex-col gap-(--cue-space-1)">
                            {approval.places.places.map((place) => (
                              <UntrustedText
                                key={place.id}
                                text={place.name === null ? place.id : `${place.name} (${place.id})`}
                              />
                            ))}
                          </span>
                        )}
                      </Fact>
                      <Fact name="Limits">
                        <span className="flex flex-wrap gap-x-(--cue-space-2)">
                          <span>{`${approval.limits.perThread} a thread`}</span>
                          <span aria-hidden="true" className="text-fg-subtle">
                            ·
                          </span>
                          <span>{`${approval.limits.perHour} an hour`}</span>
                          <span aria-hidden="true" className="text-fg-subtle">
                            ·
                          </span>
                          <span>{`${approval.limits.perDay} a day`}</span>
                        </span>
                      </Fact>
                      <Fact name="Ends">
                        {approval.state === 'ended' ? (
                          <UntrustedText text={approval.reason ?? 'ended'} />
                        ) : approval.expiresAt === null ? (
                          `${approval.limits.expiresDays} days from its approval`
                        ) : (
                          when(approval.expiresAt)
                        )}
                      </Fact>
                      <Fact name="Uses">{`${approval.usesToday} today`}</Fact>
                    </Facts>
                  </Panel>
                </li>
              ))}
            </ul>
          )
        }
      </Pending>
      {said === null && refused === null ? null : (
        <div className="flex flex-col gap-(--cue-space-1)">
          {said === null ? null : (
            <p role="status" className="text-fg">
              <UntrustedText text={said} />
            </p>
          )}
          {refused === null ? null : <Refusal message={refused.message} hint={refused.hint} />}
        </div>
      )}
    </div>
  );
}
