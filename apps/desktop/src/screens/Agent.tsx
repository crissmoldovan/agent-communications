import { Button, Chip, EmptyState, Panel, SectionHeader, StatusDot, Table, Tabs } from '@cueplusplus/ui';
import { type ReactNode, useState } from 'react';
import type {
  BehaviourChangeResult,
  BehaviourReport,
  LabelReport,
  StandingReport,
  StandingView,
} from '../cli-types.ts';
import { ChangePreview } from '../components/ChangePreview.tsx';
import { Fact, Facts } from '../components/Facts.tsx';
import { Gated } from '../components/NeedsNewerCli.tsx';
import { RuleForm } from '../components/RuleForm.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { supports } from '../gates.ts';
import { isAccountName, isApprovalId, isConversation } from '../grammar.ts';
import { useCall } from '../hooks/use-call.ts';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import type { Call } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;

/** A read a view shows, and asks again after a change. */
type Read<T> = { result: Loadable<T>; reload(): Promise<void> };

/** The screen's three views, in the tab bar's order: what every message carries comes first. */
type View = 'label' | 'rules' | 'standing';

/**
 * What agents are and may do here (DA5.4), in three views (D7): the label they carry, read-only; the behaviour rules
 * (0.22.0), where a tightening applies at once and a loosening shows its preview with Approve in Terminal (DA10); and
 * the standing approvals (0.23.0), each revoked here, or all ended at once.
 *
 * The screen reads all three when it opens, as it did on one page, and keeps every view mounted: a count on a tab says
 * what its view holds — the rules, the standing approvals that hold, and in the warn tone anything to look at — and a
 * preview waiting in one view is not revoked by looking at another. A gated view reads nothing, and its tab is marked
 * "needs an update" in the warn tone, so the line asking for a newer CLI is never behind an unmarked tab.
 */
export function Agent() {
  const { installation } = useAppData();
  const installed = installation.state === 'ready' ? installation.value.version : null;
  const label = useCall<LabelReport>({ kind: 'label' });
  const rules = useCall<BehaviourReport>(supports(installed, 'behaviour') ? { kind: 'behaviour' } : null);
  const standing = useCall<StandingReport>(supports(installed, 'standing') ? { kind: 'standingList' } : null);
  useReloadOnReturn(label.reload);
  useReloadOnReturn(rules.reload);
  useReloadOnReturn(standing.reload);
  const [view, setView] = useState<View>('label');

  return (
    <ScreenFrame title="Agent">
      <Tabs.Root value={view} onValueChange={(value) => setView(value as View)}>
        {/* A space before each count, which the flex row does not draw, keeps the tab's name two words apart. */}
        <Tabs.List aria-label="Agent" className="self-start">
          <Tabs.Tab value="label">
            Label <LabelCount result={label.result} />
          </Tabs.Tab>
          <Tabs.Tab value="rules">
            Behaviour rules{' '}
            {supports(installed, 'behaviour') ? <RulesCount result={rules.result} /> : <TabNeedsUpdate />}
          </Tabs.Tab>
          <Tabs.Tab value="standing">
            Standing approvals{' '}
            {supports(installed, 'standing') ? <StandingCount result={standing.result} /> : <TabNeedsUpdate />}
          </Tabs.Tab>
          <Tabs.Indicator />
        </Tabs.List>
        <Tabs.Panel value="label" keepMounted>
          <section aria-label="The label">
            <LabelView result={label.result} />
          </section>
        </Tabs.Panel>
        <Tabs.Panel value="rules" keepMounted>
          <section aria-label="Behaviour rules">
            <Gated feature="behaviour">
              <Rules read={rules} />
            </Gated>
          </section>
        </Tabs.Panel>
        <Tabs.Panel value="standing" keepMounted>
          <section aria-label="Standing approvals">
            <Gated feature="standing">
              <Standing read={standing} />
            </Gated>
          </section>
        </Tabs.Panel>
      </Tabs.Root>
    </ScreenFrame>
  );
}

/**
 * A tab's count, said in full to a screen reader: what its view holds, or, in the warn tone, how much in it to look
 * at. Nothing when there is nothing.
 */
function TabCount({ count, tone, says }: { count: number; tone: 'neutral' | 'warn'; says: string }) {
  if (count === 0) return null;
  return (
    <Chip tone={tone} variant={tone === 'warn' ? 'tinted' : 'tag'} data-slot="tab-count" data-tone={tone}>
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{says}</span>
    </Chip>
  );
}

/**
 * A view this CLI is too old for, marked on its tab: its read never runs, so it has nothing to count, and the line that
 * says which version it needs is in the view (DA12), not hidden behind an unmarked tab.
 */
function TabNeedsUpdate() {
  return (
    <span data-slot="tab-gate" data-tone="warn" className="inline-flex">
      <StatusDot tone="warn" label="needs an update" />
    </span>
  );
}

/** A view whose read failed, marked on its tab: what went wrong is in the view. */
function TabFailed({ result }: { result: Loadable<unknown> }) {
  return result.state === 'error' ? <StatusDot tone="danger" label="could not be read" /> : null;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The label's tab: its rules that match no account, to look at. */
function LabelCount({ result }: { result: Loadable<LabelReport> }) {
  if (result.state !== 'ready') return <TabFailed result={result} />;
  const none = result.value.rules.filter((rule) => !rule.matches).length;
  return <TabCount count={none} tone="warn" says={plural(none, 'rule matches no account', 'rules match no account')} />;
}

/** The rules' tab: any rule this release cannot read or that names no connected account; otherwise how many. */
function RulesCount({ result }: { result: Loadable<BehaviourReport> }) {
  if (result.state !== 'ready') return <TabFailed result={result} />;
  const { rules, unreadable } = result.value;
  const look = unreadable.length + rules.filter((rule) => rule.orphan).length;
  return look > 0 ? (
    <TabCount count={look} tone="warn" says={plural(look, 'rule to look at', 'rules to look at')} />
  ) : (
    <TabCount count={rules.length} tone="neutral" says={plural(rules.length, 'rule', 'rules')} />
  );
}

/** The standing approvals' tab: those that hold or wait, the ones an agent could act under. */
function StandingCount({ result }: { result: Loadable<StandingReport> }) {
  if (result.state !== 'ready') return <TabFailed result={result} />;
  const live = result.value.approvals.filter((each) => each.state !== 'ended');
  return <TabCount count={live.length} tone="neutral" says={tally(live)} />;
}

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

/** The label (`label`), shown and never changed here: its word, its name, its rules, and each workspace's style. */
function LabelView({ result }: { result: Loadable<LabelReport> }) {
  return (
    <Pending value={result}>
      {(report) => {
        const slack = report.accounts.filter((account) => account.platform === 'slack');
        return (
          <div className="flex flex-col gap-(--cue-space-6)">
            <Panel className="p-(--cue-space-5)">
              <Facts>
                <Fact name="Word">{report.word}</Fact>
                <Fact name="Name">
                  {report.name === null ? (
                    <span className="text-fg-muted">Not set</span>
                  ) : (
                    <UntrustedText text={report.name} />
                  )}
                </Fact>
                <Fact name="Rules">
                  {report.rules.length === 0 ? (
                    <span className="text-fg-muted">None</span>
                  ) : (
                    <span className="flex flex-col gap-(--cue-space-2)">
                      {report.rules.map((rule) => (
                        <span key={rule.text} className="flex flex-wrap items-center gap-(--cue-space-2)">
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
                </Fact>
              </Facts>
            </Panel>
            <SectionHeader label="Slack">
              {slack.length === 0 ? (
                <p className="text-fg-muted">No Slack workspace is connected.</p>
              ) : (
                <Panel>
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
                </Panel>
              )}
            </SectionHeader>
          </div>
        );
      }}
    </Pending>
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
function Rules({ read }: { read: Read<BehaviourReport> }) {
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
function Standing({ read }: { read: Read<StandingReport> }) {
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
