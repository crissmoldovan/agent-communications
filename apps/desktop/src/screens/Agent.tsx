import { Button, Chip, DescriptionList, EmptyState, Panel, PanelHeader, Table } from '@cueplusplus/ui';
import { type ReactNode, useState } from 'react';
import type {
  BehaviourChangeResult,
  BehaviourReport,
  LabelReport,
  StandingReport,
  StandingView,
} from '../cli-types.ts';
import { ChangePreview } from '../components/ChangePreview.tsx';
import { Gated } from '../components/NeedsNewerCli.tsx';
import { RuleForm } from '../components/RuleForm.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY } from '../copy.ts';
import type { Loadable } from '../data.tsx';
import { isAccountName, isApprovalId, isConversation } from '../grammar.ts';
import { useCall } from '../hooks/use-call.ts';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import type { Call } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;

/**
 * What agents are and may do here (DA5.4): the label they carry, read-only; the behaviour rules (0.22.0), where a
 * tightening applies at once and a loosening shows its preview with Approve in Terminal (DA10); and the standing
 * approvals (0.23.0), each revoked here, or all ended at once.
 */
export function Agent() {
  return (
    <ScreenFrame title="Agent">
      <section aria-label="The label">
        <Label />
      </section>
      <section aria-label="Behaviour rules">
        <Gated feature="behaviour">
          <Rules />
        </Gated>
      </section>
      <section aria-label="Standing approvals">
        <Gated feature="standing">
          <Standing />
        </Gated>
      </section>
    </ScreenFrame>
  );
}

/** A read's loading and error states padded inside its panel; its value edge to edge. */
function PanelState<T>({ value, children }: { value: Loadable<T>; children: (value: T) => ReactNode }) {
  if (value.state !== 'ready') {
    return (
      <div className="p-(--cue-space-4)">
        <ScreenState value={value}>{() => null}</ScreenState>
      </div>
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

/** The label (`label`), shown and never changed here: its word, its name, its rules, and each workspace's style. */
function Label() {
  const { result, reload } = useCall<LabelReport>({ kind: 'label' });
  useReloadOnReturn(reload);
  return (
    <Panel>
      <PanelHeader title="The label" />
      <PanelState value={result}>
        {(report) => {
          const slack = report.accounts.filter((account) => account.platform === 'slack');
          return (
            <div className="flex flex-col gap-(--cue-space-4) p-(--cue-space-4)">
              <DescriptionList.Root>
                <DescriptionList.Term>Word</DescriptionList.Term>
                <DescriptionList.Detail>{report.word}</DescriptionList.Detail>
                <DescriptionList.Term>Name</DescriptionList.Term>
                <DescriptionList.Detail>
                  {report.name === null ? 'Not set' : <UntrustedText text={report.name} />}
                </DescriptionList.Detail>
                <DescriptionList.Term>Rules</DescriptionList.Term>
                <DescriptionList.Detail>
                  {report.rules.length === 0 ? (
                    'None'
                  ) : (
                    <span className="flex flex-col gap-(--cue-space-1)">
                      {report.rules.map((rule) => (
                        <span key={rule.text} className="flex items-center gap-(--cue-space-2)">
                          <UntrustedText text={rule.text} />
                          {rule.matches ? null : (
                            <Chip tone="warn" variant="tag">
                              matches no account
                            </Chip>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </DescriptionList.Detail>
              </DescriptionList.Root>
              {slack.length === 0 ? (
                <p className="text-fg-muted">No Slack workspace is connected.</p>
              ) : (
                <Table.Root>
                  <Table.Caption className="sr-only">Slack style</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Workspace</Table.Head>
                      <Table.Head>Slack style</Table.Head>
                      <Table.Head>How an agent's messages go</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {slack.map((account) => (
                      <Table.Row key={account.account}>
                        <Table.Cell>{account.account}</Table.Cell>
                        <Table.Cell>{account.style ?? '—'}</Table.Cell>
                        <Table.Cell>
                          <UntrustedText
                            text={
                              account.appRoute === false
                                ? (account.note ?? 'As you, labelled: the agent app cannot post from here.')
                                : account.style === 'labelled'
                                  ? 'As you, labelled'
                                  : 'As the agent app, where it can post'
                            }
                          />
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              )}
            </div>
          );
        }}
      </PanelState>
    </Panel>
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
function Rules() {
  const { result, reload } = useCall<BehaviourReport>({ kind: 'behaviour' });
  useReloadOnReturn(reload);
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
    <Panel>
      <PanelHeader title="What agents may do" />
      <PanelState value={result}>
        {(report) => (
          <>
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
                      <Table.Cell>
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
            {report.unreadable.length === 0 ? null : (
              <div className="flex flex-col gap-(--cue-space-1) p-(--cue-space-4)">
                <p className="text-warn">
                  Rules this release cannot read hold their account, or every account, to nothing:
                </p>
                <p className="text-fg-muted">
                  <UntrustedText
                    text={report.unreadable
                      .map((each) => (each.account === null ? each.reason : `${each.account}: ${each.reason}`))
                      .join('\n')}
                  />
                </p>
              </div>
            )}
            <RuleForm accounts={report.accounts.map((account) => account.account)} onSubmit={run} />
          </>
        )}
      </PanelState>
      {said === null && refused === null && waiting === null ? null : (
        <div className="flex flex-col gap-(--cue-space-3) px-(--cue-space-4) pb-(--cue-space-4)">
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
    </Panel>
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

/**
 * The standing approvals (`standing list`, 0.23.0): what each lets an agent do in Slack without asking, where, how
 * often, and until when. Each change here only takes away, so it applies at once: `Revoke` ends one, and `End every
 * standing approval` ends them all. Making one, or allowing more, is Slack's, approved with a code at a terminal.
 */
function Standing() {
  const { result, reload } = useCall<StandingReport>({ kind: 'standingList' });
  useReloadOnReturn(reload);
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
        setSaid(call.kind === 'standingOff' ? 'Every standing approval has ended.' : `Revoked ${call.id}.`);
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

  return (
    <Panel>
      <PanelHeader
        title="Standing approvals"
        actions={
          offerOff ? (
            <Button
              size="sm"
              variant="danger-outline"
              loading={busy === 'off'}
              disabled={busy !== null && busy !== 'off'}
              onClick={() => void run({ kind: 'standingOff' })}
            >
              {COPY.endEveryStanding}
            </Button>
          ) : null
        }
      />
      <PanelState value={result}>
        {(report) =>
          report.approvals.length === 0 ? (
            <EmptyState
              title="No standing approvals."
              hint="An agent proposes one in Slack, and you approve it with its code at your own terminal."
            />
          ) : (
            <Table.Root>
              <Table.Caption className="sr-only">Standing approvals</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Approval</Table.Head>
                  <Table.Head>Workspace</Table.Head>
                  <Table.Head>State</Table.Head>
                  <Table.Head>Allows</Table.Head>
                  <Table.Head>Where</Table.Head>
                  <Table.Head>Limits</Table.Head>
                  <Table.Head>Ends</Table.Head>
                  <Table.Head>Uses</Table.Head>
                  <Table.Head>
                    <span className="sr-only">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {report.approvals.map((approval) => (
                  <Table.Row key={approval.id}>
                    <Table.Cell>
                      <span className="font-mono">{approval.id}</span>
                    </Table.Cell>
                    <Table.Cell>{approval.workspace}</Table.Cell>
                    <Table.Cell>
                      <Chip tone={STATE_TONE[approval.state]}>{approval.state}</Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="flex flex-col gap-(--cue-space-1)">
                        {approval.contents.map((content) => (
                          <UntrustedText key={content.digest} text={`${content.kind}: ${content.text}`} />
                        ))}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
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
                    </Table.Cell>
                    <Table.Cell>
                      <span className="flex flex-col gap-(--cue-space-1) whitespace-nowrap">
                        <span>{`${approval.limits.perThread} a thread`}</span>
                        <span>{`${approval.limits.perHour} an hour`}</span>
                        <span>{`${approval.limits.perDay} a day`}</span>
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      {approval.state === 'ended' ? (
                        <UntrustedText text={approval.reason ?? 'ended'} />
                      ) : approval.expiresAt === null ? (
                        `${approval.limits.expiresDays} days from its approval`
                      ) : (
                        when(approval.expiresAt)
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <span className="whitespace-nowrap">{`${approval.usesToday} today`}</span>
                    </Table.Cell>
                    <Table.Cell>
                      {approval.state === 'ended' ? null : (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === approval.id}
                          disabled={busy !== null && busy !== approval.id}
                          onClick={() => void run({ kind: 'standingRevoke', id: approval.id })}
                        >
                          {COPY.revoke}
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )
        }
      </PanelState>
      {said === null && refused === null ? null : (
        <div className="flex flex-col gap-(--cue-space-1) p-(--cue-space-4)">
          {said === null ? null : (
            <p role="status" className="text-fg">
              {said}
            </p>
          )}
          {refused === null ? null : <Refusal message={refused.message} hint={refused.hint} />}
        </div>
      )}
    </Panel>
  );
}
