import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  PageShell,
  Panel,
  SegmentedControl,
  Select,
  Spinner,
} from '@cueplusplus/ui';
import { RefreshCw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { NeedsNewerCli } from '../components/NeedsNewerCli.tsx';
import { COPY, type Screen } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { supports } from '../gates.ts';
import { useReloadOnReturn, useReloadOnServiceTurn } from '../hooks/use-reload-on-return.ts';
import { type Bridge, type Call, errorMessage, type Product } from '../ipc.ts';
import { type AccountsInfo, NO_ACCOUNTS, readAccounts } from '../messages/accounts.ts';
import {
  accountChoices,
  filterMessages,
  type JoinedMessage,
  type JoinOptions,
  join,
  SHOWS,
  type Show,
  showCounts,
  TAKING_SHOWS,
  takeContext,
} from '../messages/join.ts';
import {
  type ActivityItems,
  cursorMillis,
  isEventId,
  type MessageEvent,
  type MessagesPage,
  type Millis,
  readActivityItems,
  readMessagesPage,
  type TakesRead,
  type TakingRead,
} from '../messages/read.ts';
import { cardSteps, type StoryContext, whereWords } from '../messages/story.ts';
import { readTakes, readTakingSettings } from '../messages/takes.ts';
import { takeDestination } from '../navigation.tsx';
import { Problem, Said, Sender, StatusChip } from './MessageParts.tsx';
import { MessageByEvent, MessageStory } from './MessageStory.tsx';

/** The screen's words (spec 2026-10-26-owner-feedback-0320 §3.6, prototype row 4). */
export const MESSAGES_COPY = {
  title: 'Messages',
  about:
    'What happened to each message that came in: whether a rule caught it, whether an agent read it, and whether anyone replied.',
  show: 'Show',
  shows: {
    all: 'All',
    waiting: 'Waiting for you',
    handled: 'Handled by an agent',
    unseen: 'No agent has seen',
    'not-taken': 'Nobody took it',
    'handed-back': 'Handed back',
  } satisfies Record<Show, string>,
  account: 'Account',
  allAccounts: 'All accounts',
  refresh: 'Read again',
  older: 'Show older messages',
  moreOlder: 'Older messages are on the next page.',
  moreUnpaged: 'More messages are older than these.',
  nothing: 'No messages in the last 30 days.',
  nothingHint:
    'A message shows here once the event service sees it in an account it watches, or an agent reads it through Agent Comms.',
  noMatch: 'No messages match these filters.',
  unreadable: 'The messages could not be read.',
  activityUnreadable: 'What agents did could not be read.',
  takesUnreadable: 'Who has each message could not be read, so the list shows without it.',
  noEventService:
    "The event service isn't installed, so only the messages an agent read through Agent Comms are shown.",
  olderEventService:
    'The event service needs 0.32.0 or later to show the messages it saw. Update agent-communications to use this. Until then, only the messages an agent read through Agent Comms are shown.',
  footnote:
    "Shown: messages in the accounts the event service watches, and any message an agent read through Agent Comms. Kept 30 days. The message itself stays in Gmail, Slack or WhatsApp. What you did in Gmail or Slack yourself isn't here.",
} as const;

/** How far back the screen reads: the last 30 days, the activity log's default retention. */
export const MESSAGES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How many events one page reads: the event service's default. */
export const MESSAGES_LIMIT = 100;

// ── Times ──────────────────────────────────────────────────────────────────────────────────────────────────────

const FULL = { dateStyle: 'medium', timeStyle: 'short' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** A time of day, today; the day and the time, before. */
export function timeWords(at: Millis): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { timeStyle: 'short' });
  if (sameDay(date, new Date())) return time;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** When a card's message came in: the time today, Yesterday, or the day; the whole moment on hover. */
function When({ at }: { at: Millis }) {
  const date = new Date(at);
  const now = new Date();
  const shown = sameDay(date, now)
    ? date.toLocaleTimeString(undefined, { timeStyle: 'short' })
    : sameDay(date, new Date(now.getTime() - DAY_MS))
      ? 'Yesterday'
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(undefined, FULL)}>
      {shown}
    </time>
  );
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────

export type { AccountsInfo } from '../messages/accounts.ts';

async function readPage(bridge: Bridge, call: Call): Promise<Loadable<MessagesPage>> {
  try {
    const result = await bridge.cli(call);
    if (result.status === 'ok') {
      const page = readMessagesPage(result.data);
      return page === null ? { state: 'error', message: MESSAGES_COPY.unreadable } : { state: 'ready', value: page };
    }
    return { state: 'error', message: result.status === 'failed' ? result.message : MESSAGES_COPY.unreadable };
  } catch (error) {
    return { state: 'error', message: errorMessage(error) };
  }
}

async function readActivity(bridge: Bridge, since: Millis): Promise<Loadable<ActivityItems>> {
  try {
    const result = await bridge.cli({ kind: 'activityItems', since });
    if (result.status === 'ok') {
      const items = readActivityItems(result.data);
      return items === null
        ? { state: 'error', message: MESSAGES_COPY.activityUnreadable }
        : { state: 'ready', value: items };
    }
    return { state: 'error', message: result.status === 'failed' ? result.message : MESSAGES_COPY.activityUnreadable };
  } catch (error) {
    return { state: 'error', message: errorMessage(error) };
  }
}

/** Every page of events read so far, oldest page last, each event once. */
function withPage(pages: MessagesPage, next: MessagesPage): MessagesPage {
  const have = new Set(pages.messages.map((each) => each.eventId));
  return {
    messages: [...pages.messages, ...next.messages.filter((each) => !have.has(each.eventId))],
    before: next.before,
    more: next.more,
  };
}

export interface MessagesReads {
  /** The window's start: what both reads were asked `--since`. */
  since: Millis;
  /** When they were asked: the moment "nobody took it" is judged at. */
  readAt: Millis;
  /** The events read, page by page; `off` when the event service is not asked. */
  events: Loadable<MessagesPage> | 'off';
  activity: Loadable<ActivityItems>;
  accounts: AccountsInfo;
  /** Core's takes and each account's taking settings (0.35.0); `off` before core takes messages. */
  takes: Loadable<TakesRead> | 'off';
  taking: Loadable<TakingRead> | 'off';
}

/**
 * How the reads are joined: the accounts' names, and — once core's takes are read — who has each message and whether
 * nobody took it in time. A takes read that failed joins none, and the screen says so.
 */
export function joinOptionsOf(reads: MessagesReads): JoinOptions {
  const { takes, taking } = reads;
  if (takes === 'off' || takes.state !== 'ready') return { aliases: reads.accounts.aliases };
  const settings = taking !== 'off' && taking.state === 'ready' ? taking.value.accounts : [];
  return { aliases: reads.accounts.aliases, takes: takeContext(takes.value.takes, settings, reads.readAt) };
}

/**
 * Reads the screen's things for the same window — the event service's first page (when `eventsOn`), core's activity by
 * message, the accounts' names, and with `takingOn` (core 0.35.0) core's takes and taking settings — when it opens, and
 * again on `reload`, keeping only the answers of the read asked last. `older` reads the next page of events and adds
 * it.
 */
function useMessagesReads(eventsOn: boolean, takingOn: boolean) {
  const bridge = useBridge();
  const { installation } = useAppData();
  const present = installation.state === 'ready' ? installation.value.present : [];
  const presentKey = present.join(',');
  const [reads, setReads] = useState<MessagesReads>(() => {
    const readAt = Date.now();
    return {
      since: readAt - MESSAGES_WINDOW_MS,
      readAt,
      events: eventsOn ? { state: 'loading' } : 'off',
      activity: { state: 'loading' },
      accounts: NO_ACCOUNTS,
      takes: takingOn ? { state: 'loading' } : 'off',
      taking: takingOn ? { state: 'loading' } : 'off',
    };
  });
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderProblem, setOlderProblem] = useState<string | null>(null);
  const asked = useRef(0);
  const reload = useCallback(async () => {
    const ask = ++asked.current;
    const readAt = Date.now();
    const since = readAt - MESSAGES_WINDOW_MS;
    const products = presentKey === '' ? [] : (presentKey.split(',') as Product[]);
    const [events, activity, accounts, takes, taking] = await Promise.all([
      eventsOn
        ? readPage(bridge, { kind: 'eventsMessagesList', since, limit: MESSAGES_LIMIT })
        : Promise.resolve('off' as const),
      readActivity(bridge, since),
      readAccounts(bridge, products, { resend: takingOn }),
      takingOn ? readTakes(bridge) : Promise.resolve('off' as const),
      takingOn ? readTakingSettings(bridge) : Promise.resolve('off' as const),
    ]);
    if (ask !== asked.current) return;
    setOlderProblem(null);
    setReads({ since, readAt, events, activity, accounts, takes, taking });
  }, [bridge, eventsOn, takingOn, presentKey]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useReloadOnReturn(reload);
  useReloadOnServiceTurn(reload);
  const older = useCallback(async () => {
    const { events, since } = reads;
    if (events === 'off' || events.state !== 'ready' || events.value.before === null) return;
    const ask = asked.current;
    setOlderBusy(true);
    setOlderProblem(null);
    const next = await readPage(bridge, {
      kind: 'eventsMessagesList',
      since,
      before: events.value.before,
      limit: MESSAGES_LIMIT,
    });
    setOlderBusy(false);
    if (ask !== asked.current) return;
    if (next.state !== 'ready') {
      setOlderProblem(next.state === 'error' ? next.message : MESSAGES_COPY.unreadable);
      return;
    }
    setReads((before) =>
      before.events === 'off' || before.events.state !== 'ready'
        ? before
        : { ...before, events: { state: 'ready', value: withPage(before.events.value, next.value) } },
    );
  }, [bridge, reads]);
  return { reads, reload, older, olderBusy, olderProblem };
}

// ── The screen ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A quiet line of the screen's own. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-(length:--cue-text-ui) text-fg-muted">
      {children}
    </p>
  );
}

/** Whether the event service is asked: `on`, or why not. */
type EventsMode = 'on' | 'absent' | 'older' | 'loading' | { problem: string };

function useEventsMode(): EventsMode {
  const { installation, eventsVersion } = useAppData();
  const present = installation.state === 'ready' && installation.value.present.includes('events-daemon');
  if (!present || eventsVersion === 'absent') return 'absent';
  if (eventsVersion.state === 'loading') return 'loading';
  if (eventsVersion.state === 'error') return { problem: eventsVersion.message };
  return supports(eventsVersion.value, 'messages') ? 'on' : 'older';
}

/**
 * Messages (spec 2026-10-26-owner-feedback-0320 §3.6): each message that came in, as a card saying where it came in,
 * who it is from (the sender's words, From outside), how far it got and the steps on the way. Read from core's
 * `activity items`, and from the event service's `messages list` once it is 0.32.0 or later; joined here, in the app.
 */
export function Messages({ onScreen }: { onScreen?: (screen: Screen) => void }) {
  // A message another screen asked for, by its event id (`navigation.tsx`): read once, as the screen opens.
  const [requested] = useState(() => {
    const eventId = takeDestination('messages')?.eventId ?? null;
    return eventId !== null && isEventId(eventId) ? eventId : null;
  });
  const { installation } = useAppData();
  const core = installation.state === 'ready' ? installation.value.version : null;
  const mode = useEventsMode();
  if (!supports(core, 'messages')) {
    return (
      <Frame>
        <NeedsNewerCli feature="messages" installed={core} />
      </Frame>
    );
  }
  if (mode === 'loading') {
    return (
      <Frame>
        <Spinner label={COPY.loading} />
      </Frame>
    );
  }
  return (
    <MessagesView
      key={mode === 'on' ? 'on' : 'off'}
      mode={mode}
      takingOn={supports(core, 'taking')}
      onScreen={onScreen}
      requested={mode === 'on' ? requested : null}
    />
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <PageShell title={MESSAGES_COPY.title} subtitle={MESSAGES_COPY.about} width="wide">
      <div className="flex flex-col gap-(--cue-space-4)">{children}</div>
    </PageShell>
  );
}

const ALL = 'all';

function MessagesView({
  mode,
  takingOn = false,
  onScreen,
  requested = null,
}: {
  mode: Exclude<EventsMode, 'loading'>;
  /** Core takes messages (0.35.0): who has each is read, and its two filters are offered. */
  takingOn?: boolean;
  onScreen?: ((screen: Screen) => void) | undefined;
  /** An event whose story opens first, as another screen asked. */
  requested?: string | null;
}) {
  const { installation } = useAppData();
  const home = installation.state === 'ready' ? (installation.value.home ?? null) : null;
  const { reads, reload, older, olderBusy, olderProblem } = useMessagesReads(mode === 'on', takingOn);
  const [show, setShow] = useState<Show>('all');
  const [account, setAccount] = useState<string | null>(null);
  // The message whose story is open, by its key; the list keeps its filters while it is.
  const [open, setOpen] = useState<string | null>(requested === null ? null : `event:${requested}`);
  const context: StoryContext = useMemo(() => ({ time: timeWords, home }), [home]);
  const { events, activity } = reads;
  const views = takingOn ? TAKING_SHOWS : SHOWS;
  const joined = useMemo(() => {
    if (activity.state !== 'ready') return null;
    if (events !== 'off' && events.state !== 'ready') return null;
    const loaded: readonly MessageEvent[] = events === 'off' ? [] : events.value.messages;
    const more = events !== 'off' && events.value.more;
    // The event service pages by when it observed each event: the oldest observed so far is where this page ends.
    const oldest = loaded.reduce<Millis | null>((least, each) => {
      const at = each.observedAt ?? each.occurredAt;
      return at === null ? least : least === null ? at : Math.min(least, at);
    }, null);
    return join(loaded, activity.value, { ...joinOptionsOf(reads), cutoff: more ? oldest : null });
  }, [events, activity, reads]);

  const loading = activity.state === 'loading' || (events !== 'off' && events.state === 'loading');
  const problems = [
    events !== 'off' && events.state === 'error' ? events.message : null,
    activity.state === 'error' ? activity.message : null,
    typeof mode === 'object' ? mode.problem : null,
    // Who has each message could not be read: the list shows without it, and says so.
    reads.takes !== 'off' && reads.takes.state === 'error' ? MESSAGES_COPY.takesUnreadable : null,
  ].filter((each): each is string => each !== null);
  // A read that failed shows what went wrong, and no list joined from half of what it needs.
  const failedRead = (events !== 'off' && events.state === 'error') || activity.state === 'error';
  const choices = joined === null ? [] : accountChoices(joined);
  const counts = joined === null ? null : showCounts(joined, account);
  const shown = joined === null ? [] : filterMessages(joined, { show, account });
  const page = events !== 'off' && events.state === 'ready' ? events.value : null;
  const pageable = page?.more === true && page.before !== null && cursorMillis(page.before) > reads.since;
  const opened = open === null ? undefined : joined?.find((message) => message.key === open);

  if (opened !== undefined) {
    return (
      <MessageStory
        listed={opened}
        reads={reads}
        context={context}
        onBack={() => setOpen(null)}
        onScreen={onScreen}
        onChanged={reload}
      />
    );
  }
  // An event another screen asked for that the list's page does not hold: its story from `message show` alone.
  if (open?.startsWith('event:') && joined !== null && mode === 'on') {
    return (
      <MessageByEvent
        eventId={open.slice('event:'.length)}
        reads={reads}
        context={context}
        onBack={() => setOpen(null)}
        onScreen={onScreen}
        onChanged={reload}
      />
    );
  }
  return (
    <Frame>
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <SegmentedControl
          indicator
          aria-label={MESSAGES_COPY.show}
          size="sm"
          items={views.map((each) => ({
            value: each,
            label:
              each === 'all' || counts === null ? (
                MESSAGES_COPY.shows[each]
              ) : (
                <>
                  {MESSAGES_COPY.shows[each]} <span className="text-fg-muted tabular-nums">{counts[each]}</span>
                </>
              ),
          }))}
          value={show}
          onValueChange={(value) => setShow(value as Show)}
        />
        <span className="ml-auto flex items-center gap-(--cue-space-2)">
          <Select
            aria-label={MESSAGES_COPY.account}
            size="sm"
            items={[
              { value: ALL, label: MESSAGES_COPY.allAccounts },
              ...choices.map((choice) => ({ value: choice, label: choice })),
            ]}
            value={account ?? ALL}
            onValueChange={(value) => setAccount(value === null || value === ALL ? null : value)}
          />
          <IconButton aria-label={MESSAGES_COPY.refresh} icon={RefreshCw} size="sm" onClick={() => void reload()} />
        </span>
      </div>
      {mode === 'absent' ? <Note>{MESSAGES_COPY.noEventService}</Note> : null}
      {mode === 'older' ? <Note>{MESSAGES_COPY.olderEventService}</Note> : null}
      {problems.map((problem) => (
        <Problem key={problem} message={problem} />
      ))}
      {loading ? (
        <Spinner label={COPY.loading} />
      ) : failedRead ? null : joined === null || joined.length === 0 ? (
        <Panel>
          <EmptyState title={MESSAGES_COPY.nothing} hint={MESSAGES_COPY.nothingHint} />
        </Panel>
      ) : shown.length === 0 ? (
        <Panel>
          <EmptyState title={MESSAGES_COPY.noMatch} />
        </Panel>
      ) : (
        <ul className="flex flex-col gap-(--cue-space-3)">
          {shown.map((message) => (
            <MessageCard key={message.key} message={message} context={context} onOpen={() => setOpen(message.key)} />
          ))}
        </ul>
      )}
      {page === null || !page.more ? null : pageable ? (
        <div className="flex flex-wrap items-center gap-(--cue-space-3)">
          <Note>{MESSAGES_COPY.moreOlder}</Note>
          <Button size="sm" variant="secondary" loading={olderBusy} disabled={olderBusy} onClick={() => void older()}>
            {MESSAGES_COPY.older}
          </Button>
        </div>
      ) : (
        <Note>{MESSAGES_COPY.moreUnpaged}</Note>
      )}
      {olderProblem === null ? null : <Problem message={olderProblem} />}
      <p className="text-(length:--cue-text-label) text-fg-subtle">{MESSAGES_COPY.footnote}</p>
    </Frame>
  );
}

// ── One message ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One message, as a card in the soft look that opens its story: where it came in and when, its status; who it is from
 * and what about, a sender's words marked From outside; and its line of steps.
 */
function MessageCard({
  message,
  context,
  onOpen,
}: {
  message: JoinedMessage;
  context: StoryContext;
  onOpen: () => void;
}) {
  const steps = cardSteps(message, context);
  return (
    <li data-message={message.key} data-status={message.status.kind} data-channel={message.channel}>
      <Panel>
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full cursor-pointer flex-col gap-(--cue-space-2) p-(--cue-space-4) text-left transition-colors duration-fast hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          <span className="flex items-center gap-(--cue-space-2) text-(length:--cue-text-label) text-fg-subtle">
            <span data-slot="message-where">{whereWords(message)}</span>
            {message.sender === null ? null : (
              <Chip tone="warn" variant="tag" data-slot="from-outside-label">
                {COPY.fromOutside}
              </Chip>
            )}
            <span className="ml-auto flex items-center gap-(--cue-space-2)">
              <StatusChip message={message} />
              <When at={message.at} />
            </span>
          </span>
          <Sender sender={message.sender} channel={message.channel} />
          <span
            className="flex flex-wrap items-center gap-x-(--cue-space-2) gap-y-(--cue-space-1) text-(length:--cue-text-ui) text-fg-muted"
            data-slot="message-steps"
          >
            {steps.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the steps come in their order and never move.
              <span key={index} className="contents">
                {index === 0 ? null : (
                  <span aria-hidden="true" className="text-fg-subtle">
                    ›
                  </span>
                )}
                <span className="rounded-control bg-surface-2 px-(--cue-space-2)" data-slot="message-step">
                  <Said parts={step} />
                </span>
              </span>
            ))}
          </span>
        </button>
      </Panel>
    </li>
  );
}
