import { Button, Chip, PageShell, Panel, Spinner, Timeline } from '@cueplusplus/ui';
import { ChevronLeft, ExternalLink, History } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { OutsideText } from '../components/OutsideText.tsx';
import { SectionPanel } from '../components/SectionPanel.tsx';
import { COPY, type Screen } from '../copy.ts';
import { errorMessage } from '../ipc.ts';
import { type JoinedMessage, join } from '../messages/join.ts';
import { type Millis, readMessageShow, slackParts } from '../messages/read.ts';
import {
  channelWords,
  type EntryTone,
  type StoryContext,
  storySummary,
  timeline,
  unknownSender,
  whereWords,
  windowsOf,
} from '../messages/story.ts';
import { queueLink } from '../queue.ts';
import { Problem, Said, Sender, StatusChip } from './MessageParts.tsx';
import type { AccountsInfo, MessagesReads } from './Messages.tsx';

/** The story's words (spec 2026-10-26-owner-feedback-0320 §3.6, prototype "MessageTimeline"). */
export const STORY_COPY = {
  back: 'Messages',
  from: 'A message from',
  message: 'The message',
  happened: 'What happened',
  windows: 'Agent windows that touched it',
  noWindows: 'No agent window touched it through Agent Comms.',
  seeInActivity: 'See in Activity',
  honest: "Built from what Agent Comms saw. Anything an agent did outside Agent Comms isn't here.",
  gone: 'The event service no longer keeps this message’s details, so this is what the list read.',
  notKept: 'The event service no longer keeps this message.',
} as const;

/** The exit the event service answers for an event it does not have. */
const NO_SUCH_EVENT = 66;

const FULL = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** A step's moment, to the second: the time today, the day and the time before. */
function stepTime(at: Millis): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { timeStyle: 'medium' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** A marker's tone, in the status vocabulary the timeline takes. */
const MARKER: Readonly<Record<EntryTone, 'idle' | 'busy' | 'warn' | 'ok'>> = {
  idle: 'idle',
  accent: 'busy',
  warn: 'warn',
  ok: 'ok',
};

/**
 * Where the message opens: Gmail at the message, in its account; Slack at its thread, in its workspace. Only in the
 * shapes the app opens a queue item's link in (`queue.ts`, `queueLink`), which Rust checks again before anything opens.
 */
export function messageLink(message: JoinedMessage, accounts: AccountsInfo): { label: string; url: string } | null {
  if (message.sourceId === null || message.accountId === null) return null;
  let url: string | null = null;
  if (message.channel === 'gmail') {
    const address = accounts.gmailAddresses.get(message.accountId);
    if (address !== undefined) {
      url = `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#all/${message.sourceId}`;
    }
  } else if (message.channel === 'slack') {
    const team = accounts.slackTeams.get(message.accountId);
    const parts = slackParts(message.sourceId);
    if (team !== undefined && parts !== null) {
      url = `https://app.slack.com/client/${team}/${parts.channelId}/thread/${parts.channelId}-${parts.ts}`;
    }
  }
  if (url === null || !queueLink(url)) return null;
  return { label: `Open in ${channelWords(message.channel)}`, url };
}

/**
 * When the person approved each reply, by the draft it sent, from the approvals they used: read only when a reply was
 * sent, and nothing when the read fails — the send then says it came after their approval.
 */
function useApprovedAt(message: JoinedMessage): ReadonlyMap<string, Millis> {
  const bridge = useBridge();
  const drafts = message.touches.flatMap((touch) =>
    touch.kind === 'sent' && touch.draftId !== null ? [touch.draftId] : [],
  );
  const wanted = drafts.join(',');
  const [approved, setApproved] = useState<ReadonlyMap<string, Millis>>(new Map());
  useEffect(() => {
    if (wanted === '') return;
    let current = true;
    bridge
      .cli({ kind: 'approvalsFinished', state: 'used' })
      .then((result) => {
        if (!current || result.status !== 'ok' || !Array.isArray(result.data)) return;
        const found = new Map<string, Millis>();
        const want = new Set(wanted.split(','));
        for (const approval of result.data as unknown[]) {
          if (typeof approval !== 'object' || approval === null) continue;
          const { draftId, approvedAt } = approval as { draftId?: unknown; approvedAt?: unknown };
          if (typeof draftId !== 'string' || !want.has(draftId) || typeof approvedAt !== 'string') continue;
          const at = Date.parse(approvedAt);
          if (!Number.isNaN(at)) found.set(draftId, at);
        }
        setApproved(found);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge, wanted]);
  return approved;
}

type Shown =
  | { state: 'list' }
  | { state: 'shown'; message: JoinedMessage }
  | { state: 'gone' }
  | { state: 'failed'; problem: string };

/**
 * The message with its event as `message show` gives it — every line of its queue item's history — joined again with
 * the activity the list read; the list's own while it reads, and when it cannot.
 */
function useShown(listed: JoinedMessage, reads: MessagesReads, read: boolean): Shown {
  const bridge = useBridge();
  const event = listed.event;
  const eventId = !read && event?.openable ? event.eventId : null;
  const [shown, setShown] = useState<Shown>({ state: 'list' });
  useEffect(() => {
    if (eventId === null || reads.activity.state !== 'ready') return;
    const activity = reads.activity.value;
    let current = true;
    bridge
      .cli({ kind: 'eventsMessageShow', eventId })
      .then((result) => {
        if (!current) return;
        if (result.status === 'failed') {
          setShown(result.exit === NO_SUCH_EVENT ? { state: 'gone' } : { state: 'failed', problem: result.message });
          return;
        }
        const read = result.status === 'ok' ? readMessageShow(result.data) : null;
        const joined =
          read === null
            ? undefined
            : join([read], activity, { aliases: reads.accounts.aliases }).find((each) => each.key === listed.key);
        setShown(joined === undefined ? { state: 'list' } : { state: 'shown', message: joined });
      })
      .catch((error: unknown) => {
        if (current) setShown({ state: 'failed', problem: errorMessage(error) });
      });
    return () => {
      current = false;
    };
  }, [bridge, eventId, listed.key, reads]);
  return shown;
}

/**
 * One message's story (prototype "MessageTimeline"): who it is from and how far it got; what happened, step by step;
 * the agent windows that touched it; and that it is built only from what Agent Comms saw.
 */
export function MessageStory({
  listed,
  reads,
  context,
  onBack,
  onScreen,
  read = false,
}: {
  listed: JoinedMessage;
  reads: MessagesReads;
  context: StoryContext;
  onBack: () => void;
  onScreen?: ((screen: Screen) => void) | undefined;
  /** The message is already `message show`'s: it is not asked for again. */
  read?: boolean;
}) {
  const bridge = useBridge();
  const shown = useShown(listed, reads, read);
  const message = shown.state === 'shown' ? shown.message : listed;
  const approvedAt = useApprovedAt(message);
  const storyContext = useMemo(() => ({ ...context, approvedAt }), [context, approvedAt]);
  const [problem, setProblem] = useState<string | null>(null);
  const link = messageLink(message, reads.accounts);
  const entries = timeline(message, storyContext);
  const windows = windowsOf(message, storyContext);
  const name = message.sender?.name ?? null;
  const title =
    name === null ? (
      `A ${channelWords(message.channel)} message`
    ) : (
      <>
        {STORY_COPY.from} <OutsideText text={name} />
      </>
    );
  const open = () => {
    if (link === null) return;
    setProblem(null);
    bridge.openLink(link.url).catch((error: unknown) => setProblem(errorMessage(error)));
  };
  return (
    <PageShell
      width="wide"
      eyebrow={
        <Button variant="ghost" size="sm" icon={ChevronLeft} onClick={onBack} className="self-start">
          {STORY_COPY.back}
        </Button>
      }
      title={title}
      actions={
        <span className="flex items-center gap-(--cue-space-2)">
          <StatusChip message={message} />
          {link === null ? null : (
            <Button size="sm" variant="secondary" icon={ExternalLink} onClick={open}>
              {link.label}
            </Button>
          )}
        </span>
      }
    >
      <div className="flex flex-col gap-(--cue-space-4)">
        {shown.state === 'gone' ? (
          <p role="status" className="text-(length:--cue-text-ui) text-fg-muted">
            {STORY_COPY.gone}
          </p>
        ) : null}
        {shown.state === 'failed' ? <Problem message={shown.problem} /> : null}
        {problem === null ? null : <Problem message={problem} />}
        <section aria-label={STORY_COPY.message}>
          <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
            <span className="flex flex-wrap items-center gap-(--cue-space-2) text-(length:--cue-text-label) text-fg-subtle">
              <span>
                {whereWords(message)} ·{' '}
                <time dateTime={new Date(message.at).toISOString()}>
                  {new Date(message.at).toLocaleString(undefined, FULL)}
                </time>
              </span>
              {message.sender === null ? null : (
                <Chip tone="warn" variant="tag" data-slot="from-outside-label">
                  {COPY.fromOutside}
                </Chip>
              )}
            </span>
            {message.sender === null ? (
              <span className="text-fg-muted">{unknownSender(message.channel)}</span>
            ) : (
              <Sender sender={{ ...message.sender, name: null }} channel={message.channel} />
            )}
            <p className="text-fg-muted">{storySummary(message, storyContext)}</p>
          </Panel>
        </section>
        <SectionPanel title={STORY_COPY.happened}>
          <Timeline.Root>
            {entries.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the entries come in their order and never move.
              <Timeline.Item key={index}>
                {/* The marker's disc is the panel's ground, which it sits on, so the rail runs behind it unbroken. */}
                <Timeline.Marker tone={MARKER[entry.tone]} className="bg-surface-1" />
                <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1) pb-(--cue-space-2)">
                  <span className="flex flex-wrap items-baseline gap-x-(--cue-space-3)">
                    <span className="font-medium text-fg" data-slot="story-what">
                      <Said parts={entry.what} />
                    </span>
                    {entry.at === null ? null : (
                      <time
                        dateTime={new Date(entry.at).toISOString()}
                        className="ml-auto text-(length:--cue-text-label) text-fg-subtle tabular-nums"
                      >
                        {stepTime(entry.at)}
                      </time>
                    )}
                  </span>
                  {entry.sub === null ? null : (
                    <span className="text-(length:--cue-text-ui) text-fg-muted">
                      <Said parts={entry.sub} />
                    </span>
                  )}
                </div>
              </Timeline.Item>
            ))}
          </Timeline.Root>
        </SectionPanel>
        <SectionPanel title={STORY_COPY.windows}>
          {windows.length === 0 ? (
            <p className="text-fg-muted">{STORY_COPY.noWindows}</p>
          ) : (
            <ul className="flex flex-col gap-(--cue-space-3)">
              {windows.map((window) => (
                <li key={window.key} className="flex items-center gap-(--cue-space-3)" data-window={window.key}>
                  <span
                    aria-hidden="true"
                    className="flex size-chip shrink-0 items-center justify-center rounded-control bg-accent-soft font-semibold text-(length:--cue-text-ui) text-accent"
                  >
                    {window.initial}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="break-all font-medium text-fg">{window.folder ?? 'An agent window'}</span>
                    <span className="text-(length:--cue-text-ui) text-fg-muted">{window.line}</span>
                  </span>
                  {onScreen === undefined ? null : (
                    <Button size="sm" variant="ghost" icon={History} onClick={() => onScreen('activity')}>
                      {STORY_COPY.seeInActivity}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionPanel>
        <p className="text-(length:--cue-text-label) text-fg-subtle">{STORY_COPY.honest}</p>
      </div>
    </PageShell>
  );
}

type ByEvent =
  | { state: 'loading' }
  | { state: 'ready'; message: JoinedMessage }
  | { state: 'gone' }
  | { state: 'failed'; problem: string };

/**
 * One message's story by its event id alone (`navigation.tsx`, a destination another screen asked for), when the list's
 * page does not hold it: read with `message show`, and joined with the activity the list read. An event the event
 * service no longer keeps says so; Back goes to the list either way.
 */
export function MessageByEvent({
  eventId,
  reads,
  context,
  onBack,
  onScreen,
}: {
  eventId: string;
  reads: MessagesReads;
  context: StoryContext;
  onBack: () => void;
  onScreen?: ((screen: Screen) => void) | undefined;
}) {
  const bridge = useBridge();
  const [found, setFound] = useState<ByEvent>({ state: 'loading' });
  useEffect(() => {
    const activity = reads.activity.state === 'ready' ? reads.activity.value : new Map();
    let current = true;
    bridge
      .cli({ kind: 'eventsMessageShow', eventId })
      .then((result) => {
        if (!current) return;
        if (result.status === 'failed') {
          setFound(result.exit === NO_SUCH_EVENT ? { state: 'gone' } : { state: 'failed', problem: result.message });
          return;
        }
        const read = result.status === 'ok' ? readMessageShow(result.data) : null;
        const message =
          read === null
            ? undefined
            : join([read], activity, { aliases: reads.accounts.aliases }).find(
                (each) => each.key === `event:${read.eventId}`,
              );
        setFound(message === undefined ? { state: 'gone' } : { state: 'ready', message });
      })
      .catch((error: unknown) => {
        if (current) setFound({ state: 'failed', problem: errorMessage(error) });
      });
    return () => {
      current = false;
    };
  }, [bridge, eventId, reads]);
  if (found.state === 'ready') {
    return (
      <MessageStory listed={found.message} reads={reads} context={context} onBack={onBack} onScreen={onScreen} read />
    );
  }
  return (
    <PageShell
      width="wide"
      eyebrow={
        <Button variant="ghost" size="sm" icon={ChevronLeft} onClick={onBack} className="self-start">
          {STORY_COPY.back}
        </Button>
      }
      title={STORY_COPY.message}
    >
      {found.state === 'loading' ? (
        <Spinner label={COPY.loading} />
      ) : found.state === 'gone' ? (
        <p role="status" className="text-fg-muted">
          {STORY_COPY.notKept}
        </p>
      ) : (
        <Problem message={found.problem} />
      )}
    </PageShell>
  );
}
