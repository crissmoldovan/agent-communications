/**
 * Settings → Taking messages (0.35.0, design 2026-10-26-taking-messages §9, board SettingsTaking), mirrored in each
 * account's Agents here: per account, whether a session must take a message before it acts on it; what a take says
 * to the sender (Slack's 👀, under a reply approved in advance, or nothing); and when a message nobody takes counts —
 * reminded, or only shown under the Queue's Not taken.
 *
 * Each change is core's `taking <account> …` through the one change flow (`change-flow.tsx`): requiring a take, saying
 * nothing, a shorter wait and a reminder apply at once; letting sessions act without taking, a 👀 on taking, a longer
 * wait and no reminder loosen, and are approved in the app — in Terminal where nothing attests the app. Core judges a
 * wait by the one in force, so a change of it always carries the words for asking. The 👀 is never posted by this setting itself: it is
 * made only under a standing approval the person made at their terminal (§7), and the line beside it names the one it
 * would use. The reminder is the event service's, and says so when it is not running.
 */
import { Chip, Panel, PanelHeader, Radio, RadioGroup, Row, SectionHeader, Select, Switch } from '@cueplusplus/ui';
import { type ReactNode, useId } from 'react';
import type { StandingReport, StandingView } from '../cli-types.ts';
import { COPY, needsLine } from '../copy.ts';
import { useAppData } from '../data.tsx';
import { GATES, supports } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import type { Call, TakingSetting } from '../ipc.ts';
import { eyesLine } from '../messages/eyes.ts';
import { readTaking, type TakingRead, type TakingSettingView } from '../messages/read.ts';
import { type Flow, useFlow } from '../screens/accounts/change-flow.tsx';
import { ScreenState } from './ScreenState.tsx';
import { SectionPanel } from './SectionPanel.tsx';
import { UntrustedText } from './UntrustedText.tsx';

type TakingChannel = TakingSettingView['channel'];

export const TAKING_COPY = {
  title: 'Taking messages',
  intro:
    'When several sessions read the same message, the first to take it has it. The others see that it is taken, and leave it. A session that finds a message isn’t for it hands it back, saying why, and it is open again.',
  flowTaken: [
    ['Waiting to be taken', 'warn'],
    ['Taken by one session', 'accent'],
    ['Answered', 'ok'],
    ['Done', 'ok'],
  ] as const,
  flowBack: [
    ['Taken', 'accent'],
    ['Handed back, with a reason', 'warn'],
    ['Waiting to be taken again', 'warn'],
  ] as const,
  or: 'or',
  must: 'A session must take a message before it acts on it',
  mustHint: {
    slack:
      'Reading stays open to every session. Reacting, replying or marking a message done needs that session to take it first.',
    gmail:
      'Reading stays open to every session. Drafting a reply, sending it or marking an email done needs that session to take it first.',
    resend:
      'Reading stays open to every session. Sending a reply or marking an email done needs that session to take it first.',
  } satisfies Record<TakingChannel, string>,
  says: 'When a session takes one',
  eyes: 'Say so to the sender with 👀',
  eyesHint:
    'A 👀 reaction under their message, as the Agent Comms app, once per message — made only under a reply you approved in advance.',
  nothing: 'Say nothing',
  nothingHint: 'The sender sees nothing until a reply comes.',
  mailSays: 'Says nothing to the sender.',
  mailSaysHint:
    'Email has no reactions, so taking an email tells its sender nothing. They hear back when you approve a reply.',
  noEyesApproval:
    'None yet: no reply you approved in advance here holds a 👀, so none would be posted. Make one at your terminal.',
  nobody: 'A message nobody takes',
  within: 'Within',
  thenWord: 'then',
  remind: 'remind me',
  queue: 'put it in the Queue',
  nobodyHint:
    'Remind me: a notice on this Mac. Put it in the Queue: no notice. Either way it shows under Queue → Not taken, and Messages’ Nobody took it.',
  onlyWhenMust: 'This counts only while a session must take a message first.',
  needsService: 'Reminders come from the event service.',
  serviceAbsent: 'The event service isn’t installed, so nobody is reminded and Not taken stays empty.',
  serviceOff:
    'The event service isn’t running now: until it runs, nobody is reminded. Switch it on in Events → Service.',
  serviceWindows: 'The event service doesn’t run on this computer, so nobody is reminded here.',
  problems: 'Some taking settings could not be read, so they count as the stricter value:',
  none: 'No account here takes messages: taking is for Gmail mailboxes, and Slack and Resend accounts.',
  sessions: 'What sessions can do with a message',
  sessionWords: [
    ['Take it', 'The answer is “taken”, or that another session or you have it. Only one session gets “taken”.'],
    [
      'Hand it back',
      'With a reason, such as “not mine”. The reason shows in the message’s story and on Messages; a note it adds is shown to you alone.',
    ],
    ['Ask who has it', 'Before it starts, so it doesn’t do work another session is doing.'],
    ['Mark it done', 'Other sessions then stay away from it.'],
  ] as const,
  sessionsFoot:
    'Through Agent Comms’ Gmail, Slack and Resend servers, in every app you connected, and the same at a terminal. A session that doesn’t take a message can still read it. Who has a message, Take back, Give to… and I’ll handle it are in Messages.',
} as const;

/** The waits the person chooses from, in minutes: core takes 5 to 240. */
const WAITS = [5, 15, 30, 60, 120, 240] as const;

function waitWords(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

/** What one account's change says, applied or asked for. */
function wordsFor(view: TakingSettingView, change: TakingSetting, standing: string | null) {
  const { account } = view;
  const mail = view.channel !== 'slack';
  switch (change.setting) {
    case 'require':
      return change.on
        ? { applied: `Applied at once: in ${account}, a session must take a message before it acts on it.` }
        : {
            applied: `In ${account}, a session no longer needs to take a message before it acts on it.`,
            asking: {
              title: `Let sessions act without taking, in ${account}? Approve it`,
              body: mail
                ? 'Any session could then draft or send a reply without taking the email first, so two sessions could answer the same email.'
                : 'Any session could then react, reply or mark a message done without taking it first, so two sessions could answer the same message.',
              approved: `Approved. In ${account}, a session no longer needs to take a message before it acts on it.`,
            },
          };
    case 'acknowledge':
      return change.acknowledge === 'nothing'
        ? { applied: `Applied at once: taking a message in ${account} says nothing to its sender.` }
        : {
            applied: `When a session takes a message in ${account}, it says so with 👀.`,
            asking: {
              title: `Say so with 👀 when a session takes a message in ${account}? Approve it`,
              body: `A 👀 goes under the message, as the Agent Comms app, once per message — only under a reply you approved in advance at your terminal, and within its limits. ${standing ?? TAKING_COPY.noEyesApproval}`,
              approved: `Approved. When a session takes a message in ${account}, it says so with 👀, under a reply you approved in advance.`,
            },
          };
    case 'unclaimed':
      // A longer wait lets a message nobody took go unnoticed for longer, so core asks first (security review of
      // 0.35.0); a shorter one applies at once.
      return {
        applied: `Saved: in ${account}, a message nobody takes within ${waitWords(change.minutes)} counts as not taken${view.unclaimed.notify ? ', and you’re reminded' : ''}.`,
        asking: {
          title: `Wait ${waitWords(change.minutes)} before a message nobody takes counts, in ${account}? Approve it`,
          body: `A message no session takes would wait ${waitWords(change.minutes)}, not ${waitWords(view.unclaimed.afterMinutes)}, before it shows under Queue → Not taken${view.unclaimed.notify ? ' and you’re reminded' : ''}.`,
          approved: `Approved. In ${account}, a message nobody takes within ${waitWords(change.minutes)} counts as not taken.`,
        },
      };
    case 'notify':
      return change.on
        ? {
            applied: `Saved: in ${account}, you’re reminded of a message nobody takes within ${waitWords(view.unclaimed.afterMinutes)}.`,
          }
        : {
            applied: `Saved: in ${account}, a message nobody takes waits under Queue → Not taken, with no notice.`,
            asking: {
              title: `Stop reminding you of a message nobody takes, in ${account}? Approve it`,
              body: 'No notice would come on this Mac: a message no session takes would only wait under Queue → Not taken, and Messages’ Nobody took it.',
              approved: `Approved. In ${account}, a message nobody takes waits under Queue → Not taken, with no notice.`,
            },
          };
  }
}

/** Where the event service stands, for the reminder's line. */
function useServiceLine(): string | null {
  const { installation, eventService } = useAppData();
  const present = installation.state === 'ready' && installation.value.present.includes('events-daemon');
  if (!present || eventService === 'absent') return TAKING_COPY.serviceAbsent;
  if (eventService.state !== 'ready') return null;
  if (!eventService.value.available) return TAKING_COPY.serviceWindows;
  return eventService.value.status === 'running' || eventService.value.status === 'stopping'
    ? null
    : TAKING_COPY.serviceOff;
}

/** One account's three settings: each a row, with what it means beside it. */
function TakingAccount({
  view,
  standing,
  flow,
}: {
  view: TakingSettingView;
  standing: readonly StandingView[] | null;
  flow: Flow;
}) {
  const mustId = useId();
  const service = useServiceLine();
  const eyes = standing === null ? null : eyesLine(standing, view.account);
  const change = (key: string, setting: TakingSetting) => {
    const call: Extract<Call, { kind: 'takingChange' }> = {
      kind: 'takingChange',
      account: view.account,
      change: setting,
    };
    const words = wordsFor(view, setting, eyes);
    void flow.run(key, call, {
      applied: words.applied,
      asking:
        'asking' in words && words.asking !== undefined
          ? { ...words.asking, approve: (approvalId: string) => ({ ...call, appApproval: approvalId }) }
          : undefined,
    });
  };
  const waits = [...new Set<number>([...WAITS, view.unclaimed.afterMinutes])].sort((a, b) => a - b);
  return (
    <div className="flex flex-col" data-account={view.account}>
      <Row className="items-start gap-(--cue-space-4) py-(--cue-space-3)">
        <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
          <span id={mustId} className="font-medium text-fg">
            {TAKING_COPY.must}
          </span>
          <span className="text-(length:--cue-text-label) text-fg-muted">{TAKING_COPY.mustHint[view.channel]}</span>
        </span>
        <Switch
          aria-labelledby={mustId}
          checked={view.required}
          disabled={flow.busy !== null}
          onCheckedChange={(on) => change('require', { setting: 'require', on })}
        />
      </Row>
      <Row className="items-start gap-(--cue-space-4) py-(--cue-space-3)">
        <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-2)">
          <span className="font-medium text-fg">{TAKING_COPY.says}</span>
          {view.channel === 'slack' ? (
            <>
              <RadioGroup
                aria-label={`${TAKING_COPY.says}, in ${view.account}`}
                className="flex flex-col gap-(--cue-space-2)"
                value={view.acknowledge}
                disabled={flow.busy !== null}
                onValueChange={(value) => {
                  if (value === view.acknowledge) return;
                  change('acknowledge', {
                    setting: 'acknowledge',
                    acknowledge: value === 'eyes' ? 'eyes' : 'nothing',
                  });
                }}
              >
                <Radio value="eyes" label={<Choice title={TAKING_COPY.eyes} hint={TAKING_COPY.eyesHint} />} />
                <Radio value="nothing" label={<Choice title={TAKING_COPY.nothing} hint={TAKING_COPY.nothingHint} />} />
              </RadioGroup>
              {standing === null ? null : (
                <span className="text-(length:--cue-text-label) text-fg-muted" data-slot="eyes-approval">
                  <UntrustedText text={eyes ?? TAKING_COPY.noEyesApproval} />
                </span>
              )}
            </>
          ) : (
            <>
              <span className="text-fg-muted">{TAKING_COPY.mailSays}</span>
              <span className="text-(length:--cue-text-label) text-fg-muted">{TAKING_COPY.mailSaysHint}</span>
            </>
          )}
        </span>
      </Row>
      <Row className="items-start gap-(--cue-space-4) py-(--cue-space-3)">
        <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-2)">
          <span className="font-medium text-fg">{TAKING_COPY.nobody}</span>
          <span className="flex flex-wrap items-center gap-(--cue-space-2)">
            <span className="text-fg-muted">{TAKING_COPY.within}</span>
            <Select
              aria-label={`How long, in ${view.account}`}
              size="sm"
              items={waits.map((minutes) => ({ value: String(minutes), label: waitWords(minutes) }))}
              value={String(view.unclaimed.afterMinutes)}
              disabled={flow.busy !== null}
              onValueChange={(value) => {
                const minutes = Number(value);
                if (!Number.isInteger(minutes) || minutes === view.unclaimed.afterMinutes) return;
                change('unclaimed', { setting: 'unclaimed', minutes });
              }}
            />
            <span className="text-fg-muted">{TAKING_COPY.thenWord}</span>
            <Select
              aria-label={`Then, in ${view.account}`}
              size="sm"
              items={[
                { value: 'remind', label: TAKING_COPY.remind },
                { value: 'queue', label: TAKING_COPY.queue },
              ]}
              value={view.unclaimed.notify ? 'remind' : 'queue'}
              disabled={flow.busy !== null}
              onValueChange={(value) => {
                const on = value === 'remind';
                if (on === view.unclaimed.notify) return;
                change('notify', { setting: 'notify', on });
              }}
            />
          </span>
          <span className="text-(length:--cue-text-label) text-fg-muted">{TAKING_COPY.nobodyHint}</span>
          {view.required ? null : (
            <span className="text-(length:--cue-text-label) text-fg-muted">{TAKING_COPY.onlyWhenMust}</span>
          )}
          {service === null ? null : (
            <span className="text-(length:--cue-text-label) text-warn" data-slot="needs-service">
              {`${TAKING_COPY.needsService} ${service}`}
            </span>
          )}
        </span>
      </Row>
    </div>
  );
}

/** A choice's name and what it means. */
function Choice({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-(--cue-space-1)">
      <span className="text-fg">{title}</span>
      <span className="text-(length:--cue-text-label) text-fg-muted">{hint}</span>
    </span>
  );
}

const TAKING: Call = { kind: 'taking' };
const STANDING: Call = { kind: 'standingList' };

/** Core's `taking`, read: what the screen shows, or what went wrong. */
function useTaking() {
  const read = useCall<unknown>(TAKING);
  useReloadOnReturn(read.reload);
  const result =
    read.result.state === 'ready'
      ? (() => {
          const value = readTaking(read.result.value);
          return value === null
            ? ({ state: 'error', message: 'The taking settings could not be read.' } as const)
            : ({ state: 'ready', value } as const);
        })()
      : read.result;
  return { result, reload: read.reload };
}

/** The standing approvals, for the 👀 line: read only where a Slack account is shown. */
function useStanding(wanted: boolean): readonly StandingView[] | null {
  const read = useCall<StandingReport>(wanted ? STANDING : null);
  useReloadOnReturn(read.reload);
  return read.result.state === 'ready' && Array.isArray(read.result.value?.approvals)
    ? read.result.value.approvals
    : null;
}

function Problems({ report }: { report: TakingRead }) {
  if (report.problems.length === 0) return null;
  return (
    <div className="flex flex-col gap-(--cue-space-1) rounded-surface bg-(--cue-warn-soft) px-(--cue-space-4) py-(--cue-space-3)">
      <p className="text-warn">{TAKING_COPY.problems}</p>
      <p className="text-fg">
        <UntrustedText text={report.problems.join('\n')} />
      </p>
    </div>
  );
}

/** The way a message goes, as chips: each state, and its tone. */
function FlowChips({
  steps,
  lead,
}: {
  steps: readonly (readonly [string, 'ok' | 'accent' | 'warn'])[];
  lead?: ReactNode;
}) {
  return (
    <span className="flex flex-wrap items-center gap-(--cue-space-2)">
      {lead}
      {steps.map(([step, tone], index) => (
        <span key={step} className="contents">
          {index === 0 ? null : (
            <span aria-hidden="true" className="text-fg-subtle">
              ›
            </span>
          )}
          <Chip tone={tone}>{step}</Chip>
        </span>
      ))}
    </span>
  );
}

/**
 * Settings → Taking messages: what taking is, each account's settings, and what sessions can do with a message. Nothing
 * runs before core is installed; an older core gets the update line, and nothing is read.
 */
export function TakingMessages() {
  const { installation } = useAppData();
  const installed = installation.state === 'ready' && installation.value.installed ? installation.value : null;
  if (installed === null) return null;
  return (
    <section aria-label={TAKING_COPY.title} className="flex flex-col gap-(--cue-space-3)">
      <SectionHeader label={TAKING_COPY.title}>
        <div className="flex flex-col gap-(--cue-space-3)">
          <p className="text-fg-muted">{TAKING_COPY.intro}</p>
          <FlowChips steps={TAKING_COPY.flowTaken} />
          <FlowChips steps={TAKING_COPY.flowBack} lead={<span className="text-fg-subtle">{TAKING_COPY.or}</span>} />
          {supports(installed.version, 'taking') ? (
            <EveryAccount />
          ) : (
            <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
              <p className="text-fg">{COPY.updateToUse}</p>
              <p className="text-fg-muted">{needsLine(GATES.taking, installed.version)}</p>
            </Panel>
          )}
        </div>
      </SectionHeader>
    </section>
  );
}

function EveryAccount() {
  const { result, reload } = useTaking();
  const slack = result.state === 'ready' && result.value.accounts.some((account) => account.channel === 'slack');
  const standing = useStanding(slack);
  return (
    <ScreenState value={result}>
      {(report) => (
        <div className="flex flex-col gap-(--cue-space-4)">
          <Problems report={report} />
          {report.accounts.length === 0 ? <p className="text-fg-muted">{TAKING_COPY.none}</p> : null}
          {report.accounts.map((view) => (
            <AccountPanel key={view.account} view={view} standing={standing} reload={reload} />
          ))}
          <SectionPanel title={TAKING_COPY.sessions}>
            <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-(--cue-space-4) gap-y-(--cue-space-2)">
              {TAKING_COPY.sessionWords.map(([term, meaning]) => (
                <div key={term} className="contents">
                  <dt className="font-medium text-fg">{term}</dt>
                  <dd className="text-fg-muted">{meaning}</dd>
                </div>
              ))}
            </dl>
            <p className="text-(length:--cue-text-label) text-fg-muted">{TAKING_COPY.sessionsFoot}</p>
          </SectionPanel>
        </div>
      )}
    </ScreenState>
  );
}

const CHANNEL_NAMES: Readonly<Record<TakingChannel, string>> = { gmail: 'Gmail', slack: 'Slack', resend: 'Resend' };

function AccountPanel({
  view,
  standing,
  reload,
}: {
  view: TakingSettingView;
  standing: readonly StandingView[] | null;
  reload: () => Promise<void>;
}) {
  const flow = useFlow(reload);
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Panel>
        <PanelHeader
          title={<span id={id}>{view.account}</span>}
          actions={<span className="text-(length:--cue-text-label) text-fg-muted">{CHANNEL_NAMES[view.channel]}</span>}
        />
        <div className="flex flex-col gap-(--cue-space-3) px-(--cue-space-4) pb-(--cue-space-4)">
          <TakingAccount view={view} standing={standing} flow={flow} />
          {flow.view}
        </div>
      </Panel>
    </section>
  );
}

/**
 * One account's Taking messages, in its Agents here (0.34.0 B2's mirror): the same three settings, the same flow. Shown
 * only once core takes messages; nothing is read before.
 */
export function TakingHere({ account }: { account: string }) {
  const { installation } = useAppData();
  const version = installation.state === 'ready' ? installation.value.version : null;
  if (!supports(version, 'taking')) return null;
  return <TakingHereRead account={account} />;
}

function TakingHereRead({ account }: { account: string }) {
  const { result, reload } = useTaking();
  const view = result.state === 'ready' ? result.value.accounts.find((each) => each.account === account) : undefined;
  const standing = useStanding(view?.channel === 'slack');
  const flow = useFlow(reload);
  if (result.state === 'ready' && view === undefined) return null;
  return (
    <SectionPanel title={TAKING_COPY.title}>
      <ScreenState value={result}>
        {(report) =>
          view === undefined ? null : (
            <>
              <Problems report={report} />
              <TakingAccount view={view} standing={standing} flow={flow} />
            </>
          )
        }
      </ScreenState>
      {flow.view}
    </SectionPanel>
  );
}
