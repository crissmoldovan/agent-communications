/**
 * One account's Agents here (0.34.0, spec 2026-10-26-desktop-0340 §B2, boards AccountSlack and AccountGmail): what
 * agents may do there, a switch per act, with the conversations (Slack) or the people and domains (mail) that allow less
 * or more; how their messages look there (Slack); and the replies approved in advance there (Slack). Every change that
 * only takes away applies at once; every one that lets an agent do more shows core's preview and is approved by the
 * person (`change-flow.tsx`). Making a standing approval stays at the terminal, with its code: the section says so.
 */
import {
  Avatar,
  Button,
  Checkbox,
  CheckboxGroup,
  Chip,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Link,
  Radio,
  RadioGroup,
  Row,
  Switch,
} from '@cueplusplus/ui';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import type { BehaviourAct, BehaviourReport, LabelReport, StandingReport, StandingView } from '../../cli-types.ts';
import { Fact, Facts } from '../../components/Facts.tsx';
import { Gated } from '../../components/NeedsNewerCli.tsx';
import { ScreenState } from '../../components/ScreenState.tsx';
import { SectionPanel } from '../../components/SectionPanel.tsx';
import { TakingHere } from '../../components/TakingSettings.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import type { Loadable } from '../../data.tsx';
import { isApprovalId, isMailConversation, isSlackConversation } from '../../grammar.ts';
import { useCall } from '../../hooks/use-call.ts';
import { useReloadOnReturn } from '../../hooks/use-reload-on-return.ts';
import type { Call } from '../../ipc.ts';
import { useNavigate } from '../../navigation.tsx';
import type { Read } from '../Agent.tsx';
import {
  ACTS,
  type ActingChannel,
  actsArgument,
  actsInWords,
  actWords,
  allowedActs,
  approvedFor,
  hasAccountRule,
  mayInWords,
  overrideText,
  placeWord,
  switchCall,
} from './acts.ts';
import { type Flow, useFlow } from './change-flow.tsx';

/** The page's words that are not a sentence about one change. */
export const AGENTS_HERE_COPY = {
  may: 'What agents may do here',
  mayIntro: 'Turning one off applies at once. Turning one on asks you to approve it.',
  unreadable: 'A rule this release cannot read holds this account to nothing:',
  notActing: 'Agents do nothing from this account through Agent Comms.',
  conversations: 'In one conversation',
  conversationsIntro: (account: string) => `A conversation can allow less than the rest of ${account}, or more.`,
  noConversations: (account: string) => `None: every conversation allows what ${account} allows.`,
  addConversation: 'Add a conversation…',
  people: 'For some people',
  peopleIntro: (account: string) =>
    `An address, or @ and a domain for everyone there, can allow less than the rest of ${account}, or more. An email goes only if everyone on it is allowed.`,
  noPeople: (account: string) => `None: agents may write to anyone ${account} may.`,
  addPerson: 'Add a person or domain…',
  conversation: 'Conversation',
  conversationHint:
    'Its id, as Slack shows it at the bottom of the conversation’s details: C… for a channel, G… or D… for a group or direct message, or U… for your direct messages with that person.',
  conversationProblem: 'Give the conversation’s id as Slack shows it, such as C0123ABCD, not its name.',
  who: 'Address, or @ and a domain',
  whoProblem: 'Type an address, such as jo@client.test, or @ and a domain, such as @client.test, for everyone there.',
  agentsMay: 'Agents may',
  addSlackHint: (account: string) =>
    `Allowing less than the rest of ${account} applies at once. Allowing more asks you to approve it.`,
  addMailHint: (account: string) =>
    `Tick nothing to keep agents from writing to them at all. Allowing less than the rest of ${account} applies at once; allowing more asks you to approve it.`,
  save: 'Save',
  cancel: 'Cancel',
  remove: 'Remove…',
  look: 'How their messages look here',
  asApp: 'As the Agent Comms app',
  asAppHint: 'Slack shows an APP badge beside it, which nobody can fake.',
  asYou: 'As you, tagged',
  asYouHint: 'Your own name, with the tag at the start of the message.',
  sample: 'Thanks, I’ll look at this today.',
  sampleTime: '10:42',
  appBadge: 'APP',
  whereNoApp: 'Where the app can’t post, such as a direct message, it goes as you, tagged.',
  lookHow: 'Choosing the app applies at once. Choosing “as you, tagged” asks you to approve it.',
  exceptions: 'Exceptions, such as reactions sent as you, are in',
  yourAgents: 'Your agents',
  lookUnknown: 'This workspace’s look could not be read.',
  advance: 'Replies you approved in advance',
  advanceIntro:
    'Your yes given ahead of time, for quick acknowledgements only: a reaction or a short fixed reply to a new message.',
  noAdvance: 'None. An agent can prepare one; you approve it at your terminal.',
  endOne: 'End',
  endAll: 'End all',
  endingApplies: 'Ending one applies at once.',
  picks:
    'The agent picks which new message to acknowledge, and with which of these. It never writes the words, and it can’t pick an old message or another channel.',
  answerWith: 'An agent may answer a new message with',
  howOften: 'How often',
  ends: 'Ends',
  active: 'Active',
  pending: 'Waiting for your terminal',
  fromLine: (phrase: string) => `How the From line looks, “${phrase}”, is set in`,
} as const;

/** The whole Agents here of one account. Nothing in it reads until it is shown. */
export function AgentsHere({
  channel,
  account,
  behaviour,
  label,
}: {
  channel: ActingChannel;
  account: string;
  behaviour: Read<BehaviourReport>;
  label: Read<LabelReport>;
}) {
  return (
    <div className="flex flex-col gap-(--cue-space-5)">
      <Gated feature="behaviour">
        <MaySection channel={channel} account={account} read={behaviour} />
      </Gated>
      {/* Taking messages (0.35.0), as Settings has it for every account: shown once core takes messages. */}
      <TakingHere account={account} />
      {channel === 'slack' ? (
        <>
          <LookSection account={account} read={label} />
          <Gated feature="standing">
            <AdvanceSection account={account} />
          </Gated>
        </>
      ) : (
        <FromLine account={account} label={label.result} />
      )}
    </div>
  );
}

/** A read's loading and error states, in the section's place. */
function Pending<T>({ value, children }: { value: Loadable<T>; children: (value: T) => ReactNode }) {
  if (value.state !== 'ready') return <ScreenState value={value}>{() => null}</ScreenState>;
  return <>{children(value.value)}</>;
}

/** A link to Your agents, where what spans every account is set. */
function YourAgentsLink() {
  const navigate = useNavigate();
  if (navigate === null) return <span>{AGENTS_HERE_COPY.yourAgents}.</span>;
  return (
    <Link variant="underline" render={<button type="button" />} onClick={() => navigate({ screen: 'agent' })}>
      {AGENTS_HERE_COPY.yourAgents} ›
    </Link>
  );
}

// ── What agents may do here ────────────────────────────────────────────────────────────────────────────────────────

function MaySection({
  channel,
  account,
  read,
}: {
  channel: ActingChannel;
  account: string;
  read: Read<BehaviourReport>;
}) {
  const flow = useFlow(read.reload);
  return (
    <SectionPanel title={AGENTS_HERE_COPY.may}>
      <p className="text-fg-muted">{AGENTS_HERE_COPY.mayIntro}</p>
      <Pending value={read.result}>
        {(report) => {
          const view = report.accounts.find((each) => each.account === account);
          if (view === undefined) return <p className="text-fg-muted">{AGENTS_HERE_COPY.notActing}</p>;
          const holding = report.unreadable.filter((each) => each.account === null || each.account === account);
          return (
            <>
              {holding.length === 0 ? null : (
                <div className="flex flex-col gap-(--cue-space-1) rounded-surface bg-(--cue-warn-soft) px-(--cue-space-4) py-(--cue-space-3)">
                  <p className="text-warn">{AGENTS_HERE_COPY.unreadable}</p>
                  <p className="text-fg">
                    <UntrustedText text={holding.map((each) => each.reason).join('\n')} />
                  </p>
                </div>
              )}
              <Switches channel={channel} account={account} report={report} view={view} flow={flow} />
              {channel === 'resend' ? null : <Overrides channel={channel} account={account} view={view} flow={flow} />}
            </>
          );
        }}
      </Pending>
      {flow.view}
    </SectionPanel>
  );
}

function Switches({
  channel,
  account,
  report,
  view,
  flow,
}: {
  channel: ActingChannel;
  account: string;
  report: BehaviourReport;
  view: BehaviourReport['accounts'][number];
  flow: Flow;
}) {
  const allowed = allowedActs(channel, view.allowed);
  const where = `${placeWord(channel)} ${account}`;
  const mail = channel !== 'slack';
  const flip = (act: BehaviourAct, on: boolean) => {
    const words = actWords(channel, act);
    const call = switchCall(channel, account, view.allowed, act, on, hasAccountRule(report, account));
    void flow.run(act, call, {
      applied: on
        ? `Agents may now ${words.verb} ${where}.`
        : `Applied at once: agents may no longer ${words.verb} ${where}.`,
      asking: on
        ? {
            title: `Let agents ${words.verb} ${where}? Approve it`,
            body: mail
              ? `Agents could then ${words.verb} ${where}. Each email still waits for your yes before it goes.${channel === 'gmail' ? ' The people and domains below keep their own line.' : ''}`
              : `Agents could then ${words.verb} here. Each one still waits for your yes before it happens. A conversation with a line of its own below keeps it.`,
            approved: `Approved. Agents may now ${words.verb} ${where}. ${mail ? 'Each email' : 'Each one'} still waits for your yes.`,
            approve: approvedFor(call),
          }
        : undefined,
    });
  };
  return (
    <ul aria-label={AGENTS_HERE_COPY.may} className="flex flex-col">
      {ACTS[channel].map((each) => (
        <li key={each.act}>
          <Row className="items-center gap-(--cue-space-4)">
            <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
              <span className="font-medium text-fg">{each.label}</span>
              <span className="text-(length:--cue-text-label) text-fg-muted">{each.hint}</span>
            </span>
            <Switch
              aria-label={each.label}
              checked={allowed.includes(each.act)}
              disabled={flow.busy !== null}
              onCheckedChange={(on) => flip(each.act, on)}
            />
          </Row>
        </li>
      ))}
    </ul>
  );
}

/** The conversations (Slack), or the people and domains (mail), that allow less than the account, or more. */
function Overrides({
  channel,
  account,
  view,
  flow,
}: {
  channel: Exclude<ActingChannel, 'resend'>;
  account: string;
  view: BehaviourReport['accounts'][number];
  flow: Flow;
}) {
  const [adding, setAdding] = useState(false);
  const id = useId();
  const slack = channel === 'slack';
  const accountActs = allowedActs(channel, view.allowed);
  const remove = (place: string) => {
    const call: Extract<Call, { kind: 'behaviourClear' }> = { kind: 'behaviourClear', account, conversation: place };
    const domain = place.startsWith('@');
    void flow.run(place, call, {
      applied: slack
        ? `Removed at once: ${place} now allows what the rest of ${account} allows.`
        : `Removed at once: ${place} is treated like everyone else.`,
      asking: {
        title: `Remove the line for ${place}? Approve it`,
        body: slack
          ? `${place} would then allow what the rest of ${account} allows: ${actsInWords(channel, accountActs)}.`
          : `Agents could then write to ${domain ? `anyone at ${place.slice(1)}` : place} as they may to anyone else: ${actsInWords(channel, accountActs)}.`,
        approved: slack
          ? `Approved. ${place} now allows what the rest of ${account} allows.`
          : `Approved. ${place} is treated like everyone else now.`,
        approve: approvedFor(call),
      },
    });
  };
  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <h3 id={id} className="flex-1 font-semibold text-fg">
          {slack ? AGENTS_HERE_COPY.conversations : AGENTS_HERE_COPY.people}
        </h3>
        <Button size="sm" disabled={adding} onClick={() => setAdding(true)}>
          {slack ? AGENTS_HERE_COPY.addConversation : AGENTS_HERE_COPY.addPerson}
        </Button>
      </div>
      <p className="text-(length:--cue-text-label) text-fg-muted">
        {slack ? AGENTS_HERE_COPY.conversationsIntro(account) : AGENTS_HERE_COPY.peopleIntro(account)}
      </p>
      {view.conversations.length === 0 ? (
        <p className="text-fg-muted">
          {slack ? AGENTS_HERE_COPY.noConversations(account) : AGENTS_HERE_COPY.noPeople(account)}
        </p>
      ) : (
        <ul aria-labelledby={id} className="flex flex-col">
          {view.conversations.map((each) => (
            <li key={each.conversation}>
              <Row className="items-center gap-(--cue-space-4)">
                <span className="min-w-0 font-mono text-fg">
                  <UntrustedText text={each.conversation} />
                </span>
                <span className="min-w-0 flex-1 text-fg-muted">
                  {overrideText(channel, each.conversation, each.allowed)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove the line for ${each.conversation}`}
                  loading={flow.busy === each.conversation}
                  disabled={flow.busy !== null && flow.busy !== each.conversation}
                  onClick={() => remove(each.conversation)}
                >
                  {AGENTS_HERE_COPY.remove}
                </Button>
              </Row>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <AddOverride
          channel={channel}
          account={account}
          busy={flow.busy !== null}
          onCancel={() => setAdding(false)}
          onSave={(place, acts) => {
            setAdding(false);
            const call: Extract<Call, { kind: 'behaviourAllow' }> = {
              kind: 'behaviourAllow',
              account,
              acts: actsArgument(acts),
              conversation: place,
            };
            const extra = acts.filter((act) => !accountActs.includes(act));
            const scope = slack ? `in ${place}` : `for ${place}`;
            void flow.run(place, call, {
              applied: `Added at once, because it allows no more than the rest of ${account}: ${scope}, ${mayInWords(channel, acts)}.`,
              asking: {
                title: slack
                  ? `Let agents do more in ${place} than in the rest of ${account}? Approve it`
                  : `Let agents do more for ${place} than for everyone else? Approve it`,
                body:
                  extra.length > 0
                    ? `${slack ? place : `For ${place}`}${slack ? ' would allow' : ','} ${slack ? actsInWords(channel, acts) : mayInWords(channel, acts)}. That includes ${actsInWords(channel, extra)}, which the rest of ${account} doesn’t allow.`
                    : `${scope.charAt(0).toUpperCase()}${scope.slice(1)}, ${mayInWords(channel, acts)}: more than it allows now.`,
                approved: `Approved. ${scope.charAt(0).toUpperCase()}${scope.slice(1)}, ${mayInWords(channel, acts)}.`,
                approve: approvedFor(call),
              },
            });
          }}
        />
      ) : null}
    </div>
  );
}

/** Adding a line: the conversation, or the address or domain, and what agents may do there. Checked before it is sent. */
function AddOverride({
  channel,
  account,
  busy,
  onCancel,
  onSave,
}: {
  channel: Exclude<ActingChannel, 'resend'>;
  account: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (place: string, acts: BehaviourAct[]) => void;
}) {
  const slack = channel === 'slack';
  const [place, setPlace] = useState('');
  const [acts, setActs] = useState<string[]>([]);
  const [issues, setIssues] = useState<{ message: string }[]>([]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const given = place.trim();
    const fits = slack ? isSlackConversation(given) : isMailConversation(given);
    if (!fits) {
      setIssues([{ message: slack ? AGENTS_HERE_COPY.conversationProblem : AGENTS_HERE_COPY.whoProblem }]);
      return;
    }
    onSave(
      given,
      ACTS[channel].map((each) => each.act).filter((act) => acts.includes(act)),
    );
  };
  const title = slack ? 'Add a conversation' : 'Add a person or domain';
  return (
    <form
      aria-label={title}
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-(--cue-space-3) rounded-surface bg-surface-2 p-(--cue-space-4)"
    >
      <p className="font-medium text-fg">{title}</p>
      <Field name="conversation" invalid={issues.length > 0}>
        <FieldLabel>{slack ? AGENTS_HERE_COPY.conversation : AGENTS_HERE_COPY.who}</FieldLabel>
        <Input
          value={place}
          placeholder={slack ? 'C0123ABCD' : 'jo@client.test or @client.test'}
          onChange={(event) => {
            setPlace(event.target.value);
            setIssues([]);
          }}
        />
        {slack ? <FieldDescription>{AGENTS_HERE_COPY.conversationHint}</FieldDescription> : null}
        <FieldError issues={issues} />
      </Field>
      <Field name="acts">
        <FieldLabel>{AGENTS_HERE_COPY.agentsMay}</FieldLabel>
        <CheckboxGroup
          aria-label={AGENTS_HERE_COPY.agentsMay}
          className="flex-row flex-wrap gap-x-(--cue-space-5)"
          value={acts}
          onValueChange={(value) => setActs([...value])}
        >
          {ACTS[channel].map((each) => (
            <Checkbox key={each.act} value={each.act} label={each.label} />
          ))}
        </CheckboxGroup>
      </Field>
      <p className="text-(length:--cue-text-label) text-fg-muted">
        {slack ? AGENTS_HERE_COPY.addSlackHint(account) : AGENTS_HERE_COPY.addMailHint(account)}
      </p>
      <div className="flex gap-(--cue-space-2)">
        <Button type="submit" variant="primary" disabled={busy}>
          {AGENTS_HERE_COPY.save}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {AGENTS_HERE_COPY.cancel}
        </Button>
      </div>
    </form>
  );
}

// ── How their messages look here (Slack) ───────────────────────────────────────────────────────────────────────────

/** The phrase recipients see: the account's, or the name and word as they would make it. */
function phraseOf(report: LabelReport, view: LabelReport['accounts'][number] | undefined): string {
  return view?.phrase ?? `${report.name ?? 'Your name'} (${report.word})`;
}

/** A person's initials, for the tagged preview's picture. */
function initials(name: string): string {
  const letters = name
    .split(/\s+/u)
    .filter((part) => part !== '')
    .map((part) => [...part][0] ?? '')
    .join('');
  return [...letters].slice(0, 2).join('').toUpperCase();
}

function LookSection({ account, read }: { account: string; read: Read<LabelReport> }) {
  const flow = useFlow(read.reload);
  return (
    <SectionPanel title={AGENTS_HERE_COPY.look}>
      <Pending value={read.result}>
        {(report) => {
          const view = report.accounts.find((each) => each.account === account);
          if (view?.style === undefined) return <p className="text-fg-muted">{AGENTS_HERE_COPY.lookUnknown}</p>;
          const phrase = phraseOf(report, view);
          const name = report.name ?? 'You';
          const choose = (style: string) => {
            if (style === view.style) return;
            if (style === 'app') {
              void flow.run(
                'style',
                { kind: 'labelStyle', account, style: 'app' },
                {
                  applied: `Applied at once: agents’ messages in ${account} now come from the Agent Comms app, with Slack’s APP badge.`,
                },
              );
              return;
            }
            void flow.run(
              'style',
              { kind: 'labelStyle', account, style: 'labelled' },
              {
                applied: `Agents’ messages in ${account} now go as you, tagged “${phrase}:”.`,
                asking: {
                  title: `Post as you, tagged, in ${account}? Approve it`,
                  body: `People will see your own name, with “${phrase}:” at the start of each message, instead of Slack’s APP badge.`,
                  approved: `Approved. Agents’ messages in ${account} now go as you, tagged “${phrase}:”.`,
                  approve: (approvalId) => ({ kind: 'labelStyleApproved', account, style: 'labelled', approvalId }),
                },
              },
            );
          };
          return (
            <>
              <RadioGroup
                aria-label={AGENTS_HERE_COPY.look}
                className="grid gap-(--cue-space-3) sm:grid-cols-2"
                value={view.style}
                disabled={flow.busy !== null}
                onValueChange={(value) => choose(String(value))}
              >
                <Radio
                  value="app"
                  label={
                    <LookChoice title={AGENTS_HERE_COPY.asApp} hint={AGENTS_HERE_COPY.asAppHint}>
                      <Avatar fallback="A" />
                      <span className="flex min-w-0 flex-col gap-(--cue-space-1)">
                        <span className="flex flex-wrap items-center gap-(--cue-space-2)">
                          <span className="font-semibold text-fg">
                            <UntrustedText text={phrase} />
                          </span>
                          <Chip variant="tag">{AGENTS_HERE_COPY.appBadge}</Chip>
                          <span className="text-(length:--cue-text-label) text-fg-subtle">
                            {AGENTS_HERE_COPY.sampleTime}
                          </span>
                        </span>
                        <span className="text-fg">{AGENTS_HERE_COPY.sample}</span>
                      </span>
                    </LookChoice>
                  }
                />
                <Radio
                  value="labelled"
                  label={
                    <LookChoice title={AGENTS_HERE_COPY.asYou} hint={AGENTS_HERE_COPY.asYouHint}>
                      <Avatar fallback={initials(name)} />
                      <span className="flex min-w-0 flex-col gap-(--cue-space-1)">
                        <span className="flex flex-wrap items-center gap-(--cue-space-2)">
                          <span className="font-semibold text-fg">
                            <UntrustedText text={name} />
                          </span>
                          <span className="text-(length:--cue-text-label) text-fg-subtle">
                            {AGENTS_HERE_COPY.sampleTime}
                          </span>
                        </span>
                        <span className="text-fg">
                          <span className="font-semibold">
                            <UntrustedText text={`${phrase}:`} />
                          </span>{' '}
                          {AGENTS_HERE_COPY.sample}
                        </span>
                      </span>
                    </LookChoice>
                  }
                />
              </RadioGroup>
              {view.appRoute === false && view.note !== undefined ? (
                <p className="text-warn">
                  <UntrustedText text={view.note} />
                </p>
              ) : null}
              <p className="text-fg-muted">{AGENTS_HERE_COPY.whereNoApp}</p>
              <p className="text-(length:--cue-text-label) text-fg-muted">
                {AGENTS_HERE_COPY.lookHow} {AGENTS_HERE_COPY.exceptions} <YourAgentsLink />
              </p>
            </>
          );
        }}
      </Pending>
      {flow.view}
    </SectionPanel>
  );
}

/** One way messages may look: its name, what it means, and a message drawn that way. */
function LookChoice({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-(--cue-space-2)">
      <span className="font-medium text-fg">{title}</span>
      <span className="text-(length:--cue-text-label) text-fg-muted">{hint}</span>
      <span
        aria-hidden="true"
        className="flex items-start gap-(--cue-space-3) rounded-surface bg-surface-2 p-(--cue-space-3)"
      >
        {children}
      </span>
    </span>
  );
}

/** Mail's From line is set where every account's label is: Your agents. */
function FromLine({ account, label }: { account: string; label: Loadable<LabelReport> }) {
  if (label.state !== 'ready') return null;
  const view = label.value.accounts.find((each) => each.account === account);
  return (
    <p className="text-(length:--cue-text-label) text-fg-muted">
      <UntrustedText text={AGENTS_HERE_COPY.fromLine(phraseOf(label.value, view))} /> <YourAgentsLink />
    </p>
  );
}

// ── Replies approved in advance (Slack) ────────────────────────────────────────────────────────────────────────────

/** Where a standing approval holds, in words: "In #general", or "In threads you're in". */
function placesText(approval: StandingView): string {
  if (approval.places.kind === 'threads-i-am-in') return 'In threads you’re in';
  const names = approval.places.places.map((place) => (place.name === null ? place.id : `#${place.name}`));
  return `In ${names.join(', ')}`;
}

/** When an active one ends, from now: "In 5 days", "Within a day". */
function endsIn(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const days = Math.ceil((at - now) / 86_400_000);
  if (days <= 1) return 'Within a day';
  return `In ${days} days`;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** What an ended-every-one answer could not do, said beside it (core's `partial`). */
function partialOf(data: unknown): string[] {
  const partial = (data as { partial?: unknown } | null)?.partial;
  return Array.isArray(partial) ? partial.filter((note): note is string => typeof note === 'string') : [];
}

function AdvanceSection({ account }: { account: string }) {
  const read = useCall<StandingReport>({ kind: 'standingList' });
  useReloadOnReturn(read.reload);
  const flow = useFlow(read.reload);
  const all = read.result.state === 'ready' ? read.result.value.approvals : [];
  const live = (approval: StandingView) => approval.state !== 'ended';
  const here = all.filter((approval) => approval.workspace === account && live(approval));
  const elsewhere = all.filter((approval) => approval.workspace !== account && live(approval)).length;
  // Ending them all is offered whenever there may be one to end here: while the list could not be read, too.
  const offerOff = read.result.state === 'error' || here.length > 0;
  const endAll = () =>
    void flow.run(
      'off',
      { kind: 'standingOff' },
      {
        applied: (data) =>
          [
            elsewhere > 0
              ? 'Ended at once: no replies are approved in advance on this computer now, in any workspace.'
              : `Ended at once: no replies are approved in advance in ${account} now.`,
            ...partialOf(data),
          ].join('\n'),
      },
    );
  const endOne = (approval: StandingView) => {
    if (!isApprovalId(approval.id)) {
      flow.refuse('This standing approval has an id that cannot be passed on safely.');
      return;
    }
    void flow.run(
      approval.id,
      { kind: 'standingRevoke', id: approval.id },
      {
        applied: `Ended at once. ${placesText(approval)}, agents ask you before each acknowledgement again.`,
      },
    );
  };
  return (
    <SectionPanel
      title={AGENTS_HERE_COPY.advance}
      actions={
        <Button
          size="sm"
          variant="danger-outline"
          disabled={!offerOff || (flow.busy !== null && flow.busy !== 'off')}
          loading={flow.busy === 'off'}
          onClick={endAll}
        >
          {AGENTS_HERE_COPY.endAll}
        </Button>
      }
    >
      <p className="text-fg-muted">{AGENTS_HERE_COPY.advanceIntro}</p>
      <Pending value={read.result}>
        {() =>
          here.length === 0 ? (
            <EmptyState title={AGENTS_HERE_COPY.noAdvance} />
          ) : (
            <ul aria-label={AGENTS_HERE_COPY.advance} className="flex flex-col gap-(--cue-space-3)">
              {here.map((approval) => (
                <li
                  key={approval.id}
                  className="flex flex-col gap-(--cue-space-3) rounded-surface bg-surface-2 p-(--cue-space-4)"
                >
                  <div className="flex flex-wrap items-center gap-(--cue-space-3)">
                    <Chip tone={approval.state === 'active' ? 'ok' : 'info'}>
                      {approval.state === 'active' ? AGENTS_HERE_COPY.active : AGENTS_HERE_COPY.pending}
                    </Chip>
                    <span className="min-w-0 flex-1 font-medium text-fg">
                      <UntrustedText text={placesText(approval)} />
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`End the replies approved in advance ${placesText(approval).replace(/^In/u, 'in')}`}
                      loading={flow.busy === approval.id}
                      disabled={flow.busy !== null && flow.busy !== approval.id}
                      onClick={() => endOne(approval)}
                    >
                      {AGENTS_HERE_COPY.endOne}
                    </Button>
                  </div>
                  <Facts>
                    <Fact name={AGENTS_HERE_COPY.answerWith}>
                      <span className="flex flex-col gap-(--cue-space-1)">
                        {approval.contents.map((content) => (
                          <UntrustedText
                            key={content.digest}
                            text={content.kind === 'reaction' ? `a :${content.text}: reaction` : `“${content.text}”`}
                          />
                        ))}
                      </span>
                    </Fact>
                    <Fact name={AGENTS_HERE_COPY.howOften}>
                      <span className="flex flex-col gap-(--cue-space-1)">
                        <span>{`At most ${approval.limits.perHour} an hour`}</span>
                        <span className="text-(length:--cue-text-label) text-fg-muted">
                          {`${approval.limits.perDay} a day, ${approval.limits.perThread} in each thread · ${approval.usesToday} used today`}
                        </span>
                      </span>
                    </Fact>
                    <Fact name={AGENTS_HERE_COPY.ends}>
                      {approval.expiresAt === null ? (
                        `${approval.limits.expiresDays} days after you approve it`
                      ) : (
                        <span className="flex flex-col gap-(--cue-space-1)">
                          <span>{endsIn(approval.expiresAt, Date.now())}</span>
                          <span className="text-(length:--cue-text-label) text-fg-muted">
                            {when(approval.expiresAt)}
                          </span>
                        </span>
                      )}
                    </Fact>
                  </Facts>
                  <p className="text-(length:--cue-text-label) text-fg-muted">{AGENTS_HERE_COPY.picks}</p>
                </li>
              ))}
            </ul>
          )
        }
      </Pending>
      <p className="text-(length:--cue-text-label) text-fg-muted">{AGENTS_HERE_COPY.endingApplies}</p>
      {elsewhere > 0 ? (
        <p className="text-(length:--cue-text-label) text-fg-muted">
          {`End all also ends the ${elsewhere} in other workspaces: it ends every reply approved in advance on this computer.`}
        </p>
      ) : null}
      {flow.view}
    </SectionPanel>
  );
}
