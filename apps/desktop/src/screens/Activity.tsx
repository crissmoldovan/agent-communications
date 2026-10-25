import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  InfoTip,
  Panel,
  Row,
  SegmentedControl,
  Select,
  Spinner,
  Timeline,
} from '@cueplusplus/ui';
import { ArrowLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTIVITY_KINDS,
  ACTIVITY_OUTCOMES,
  byMinute,
  channelLabel,
  type Filters,
  filterChannels,
  hasOutside,
  KIND_WORDS,
  type LineView,
  lineWords,
  NO_FILTERS,
  OUTCOME_WORDS,
  type Part,
  RANGES,
  type Range,
  readSessions,
  readTimeline,
  runnerOf,
  type SessionsView,
  type SessionView,
  STATUS_WORDS,
  sinceOf,
  type TimelineView,
} from '../activity.ts';
import { useBridge } from '../bridge-context.tsx';
import { Gated } from '../components/NeedsNewerCli.tsx';
import { OutsideText } from '../components/OutsideText.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY } from '../copy.ts';
import { isAccountName } from '../grammar.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { type Call, errorMessage } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/** The screen's words (design 2026-10-25-activity §4.5): a few each, with what only explains in a hint. */
export const ACTIVITY_COPY = {
  title: 'Activity',
  about:
    'What agent sessions read, were told about, did and sent through agent-communications: subjects, senders, searches and recipients, never a message body. Kept on this Mac only, for 30 days by default.',
  range: 'Time range',
  refresh: 'Read again',
  allSessions: 'All sessions',
  sessions: 'Sessions',
  noSessions: 'No agent activity in this range.',
  noSessionsHint: 'Calls an agent makes through agent-communications show here.',
  unreadable: 'The activity log could not be read.',
  folderUnknown: 'Folder unknown',
  asTheClientSays: 'as the client says',
  oneWindow: 'One agent window',
  onItsOwn: 'On its own',
  groupingHint:
    'Calls are grouped as one agent window when the processes that made them share the window that started them and its folder. Anything that could not be grouped stays on its own: grouping is a convenience, never a claim.',
  clientHint: 'A client names itself: this is what it said, not proof of what it is.',
  started: 'Started',
  lastSeen: 'Last seen',
  nothingInRange: 'Nothing from this session in this range.',
  noMatch: 'No calls match these filters.',
  more: 'More calls matched than are shown. Narrow the range or a filter.',
  timeline: 'Timeline',
  filters: 'Filters',
  allChannels: 'All channels',
  allAccounts: 'All accounts',
  allKinds: 'All kinds',
  allOutcomes: 'All outcomes',
} as const;

// ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a read came to: loading, there, nothing in the range (core's NOT_FOUND, exit 66), or what went wrong. */
type Read<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'nothing' }
  | { state: 'error'; message: string };

/**
 * Runs one allow-listed read when its call changes and on `tick`, keeping only the answer of the read asked last, as
 * `useCall` does — and telling core's NOT_FOUND, which `show` answers for a session with nothing in the range, from a
 * failure.
 */
function useRead<T>(call: Call, parse: (value: unknown) => T | null, tick: number): Read<T> {
  const bridge = useBridge();
  const key = JSON.stringify(call);
  // What was read, and for which call: a read of another call is not shown, and the new one shows as loading.
  const [shown, setShown] = useState<{ key: string; read: Read<T> } | null>(null);
  const asked = useRef(0);
  const latestParse = useRef(parse);
  latestParse.current = parse;
  const run = useCallback(async () => {
    const ask = ++asked.current;
    let next: Read<T>;
    try {
      const result = await bridge.cli(JSON.parse(key) as Call);
      if (result.status === 'ok') {
        const value = latestParse.current(result.data);
        next = value === null ? { state: 'error', message: ACTIVITY_COPY.unreadable } : { state: 'ready', value };
      } else if (result.status === 'failed' && result.code === 'NOT_FOUND') {
        next = { state: 'nothing' };
      } else if (result.status === 'failed') {
        next = { state: 'error', message: result.message };
      } else {
        next = { state: 'error', message: ACTIVITY_COPY.unreadable };
      }
    } catch (error) {
      next = { state: 'error', message: errorMessage(error) };
    }
    if (ask === asked.current) setShown({ key, read: next });
  }, [bridge, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tick is what asks for the read again.
  useEffect(() => {
    void run();
  }, [run, tick]);
  useReloadOnReturn(run);
  return shown === null || shown.key !== key ? { state: 'loading' } : shown.read;
}

/** What went wrong, as text. */
function Problem({ message }: { message: string }) {
  return (
    <p role="alert" className="text-danger">
      <UntrustedText text={message} />
    </p>
  );
}

// ── The screen ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What agent sessions read, were told about, did and sent (design 2026-10-25-activity §4.5, S1–S3): the sessions with
 * activity in the range, newest first, and one session's timeline, a line a call, grouped by minute, filtered by
 * channel, account, kind and outcome. Read-only: it changes nothing. Everything a sender wrote is plain text, marked
 * From outside. It reads only through the allow-listed `activity sessions` and `activity show`, and only once the CLI
 * is one that has them (0.29.0).
 */
export function Activity() {
  return (
    <ScreenFrame title={ACTIVITY_COPY.title}>
      <Gated feature="activity">
        <ActivityViews />
      </Gated>
    </ScreenFrame>
  );
}

function ActivityViews() {
  const [range, setRange] = useState<Range>('7d');
  const [open, setOpen] = useState<SessionView | null>(null);
  const [tick, setTick] = useState(0);
  // Today is today when the range is chosen: read again, it is still that day's start.
  const since = useMemo(() => sinceOf(range), [range]);
  return (
    <div className="flex flex-col gap-(--cue-space-4)">
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        {open === null ? (
          <span className="flex items-center gap-(--cue-space-2) text-fg-muted">
            {ACTIVITY_COPY.sessions}
            <InfoTip label="About activity" text={ACTIVITY_COPY.about} />
          </span>
        ) : (
          <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => setOpen(null)}>
            {ACTIVITY_COPY.allSessions}
          </Button>
        )}
        <span className="ml-auto flex items-center gap-(--cue-space-2)">
          <SegmentedControl
            aria-label={ACTIVITY_COPY.range}
            size="sm"
            items={RANGES.map(({ value, label }) => ({ value, label }))}
            value={range}
            onValueChange={(value) => setRange(value as Range)}
          />
          <IconButton
            aria-label={ACTIVITY_COPY.refresh}
            icon={RefreshCw}
            size="sm"
            onClick={() => setTick((n) => n + 1)}
          />
        </span>
      </div>
      {open === null ? (
        <Sessions since={since} tick={tick} onOpen={setOpen} />
      ) : (
        <OneSession key={open.key} summary={open} since={since} tick={tick} />
      )}
    </div>
  );
}

// ── Times ──────────────────────────────────────────────────────────────────────────────────────────────────────

const FULL = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** A moment, short: the time alone when it is today, the day and time otherwise; the full moment on hover. */
function Short({ at }: { at: string }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <UntrustedText text={at} />;
  const today = date.toDateString() === new Date().toDateString();
  const shown = today
    ? date.toLocaleTimeString(undefined, { timeStyle: 'short' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(undefined, FULL)}>
      {shown}
    </time>
  );
}

// ── Sessions ───────────────────────────────────────────────────────────────────────────────────────────────────

function Sessions({
  since,
  tick,
  onOpen,
}: {
  since: ReturnType<typeof sinceOf>;
  tick: number;
  onOpen: (session: SessionView) => void;
}) {
  const read = useRead<SessionsView>({ kind: 'activitySessions', since }, readSessions, tick);
  if (read.state === 'loading') return <Spinner label={COPY.loading} />;
  if (read.state === 'error') return <Problem message={read.message} />;
  const sessions = read.state === 'ready' ? read.value.sessions : [];
  return (
    <section aria-label={ACTIVITY_COPY.sessions}>
      <Panel>
        {sessions.length === 0 ? (
          <EmptyState title={ACTIVITY_COPY.noSessions} hint={ACTIVITY_COPY.noSessionsHint} />
        ) : (
          sessions.map((session) => (
            <Row
              key={session.key}
              interactive
              data-session={session.key}
              onClick={() => onOpen(session)}
              className="items-center gap-(--cue-space-4) text-left"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
                <Folder session={session} />
                <span className="flex flex-wrap gap-x-(--cue-space-2) text-(length:--cue-text-label) text-fg-muted">
                  {isService(session) ? null : (
                    <>
                      <Runner session={session} />
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span>{session.grouped ? ACTIVITY_COPY.oneWindow : ACTIVITY_COPY.onItsOwn}</span>
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-(--cue-space-1)">
                <Counts session={session} end />
                <span className="text-(length:--cue-text-label) text-fg-muted">
                  {ACTIVITY_COPY.started} <Short at={session.firstSeen} /> · {ACTIVITY_COPY.lastSeen.toLowerCase()}{' '}
                  <Short at={session.lastSeen} />
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="size-(--cue-icon-sm) shrink-0 text-fg-subtle" />
            </Row>
          ))
        )}
      </Panel>
    </section>
  );
}

/** A session's folder, with the home as `~`, in mono: a path. */
function Folder({ session }: { session: SessionView }) {
  if (isService(session)) return <span className="text-fg">{runnerOf(session).said}</span>;
  if (session.folder === null) return <span className="text-fg-muted">{ACTIVITY_COPY.folderUnknown}</span>;
  return (
    <span className="truncate font-mono text-fg" title={session.folder}>
      {session.folder}
    </span>
  );
}

/** The event service's own session: it has no folder, and is named where one would be. */
function isService(session: SessionView): boolean {
  return session.folder === null && session.surfaces.includes('daemon');
}

/** Who ran it: its client as the client says, the event service, or a command. */
function Runner({ session }: { session: SessionView }) {
  const runner = runnerOf(session);
  return (
    <span>
      {runner.said}
      {runner.asTheClientSays ? <span className="text-fg-subtle">, {ACTIVITY_COPY.asTheClientSays}</span> : null}
    </span>
  );
}

/** Its counts by kind, those with any; refused and failed calls apart, in their tones. At a row's end, or under a head. */
function Counts({ session, end = false }: { session: SessionView; end?: boolean }) {
  const kinds = ACTIVITY_KINDS.filter((kind) => session.kinds[kind] > 0);
  return (
    <span
      className={`flex flex-wrap items-center gap-x-(--cue-space-3) gap-y-(--cue-space-1) ${end ? 'justify-end' : ''}`}
    >
      {kinds.length === 0 ? null : (
        <span className="text-(length:--cue-text-ui) text-fg-muted" data-slot="activity-counts">
          {kinds.map((kind) => `${KIND_WORDS[kind]} ${session.kinds[kind]}`).join(' · ')}
        </span>
      )}
      {session.outcomes.refused > 0 ? (
        <Chip tone="warn" variant="tinted" data-slot="activity-refused">
          {`${session.outcomes.refused} refused`}
        </Chip>
      ) : null}
      {session.outcomes.failed > 0 ? (
        <Chip tone="danger" variant="tinted" data-slot="activity-failed">
          {`${session.outcomes.failed} failed`}
        </Chip>
      ) : null}
    </span>
  );
}

// ── One session ────────────────────────────────────────────────────────────────────────────────────────────────

/** The call `show` makes for this session, range and filters: only the filters set, each a closed word or a name. */
function showCall(key: string, since: ReturnType<typeof sinceOf>, filters: Filters): Call {
  return {
    kind: 'activityShow',
    session: key,
    since,
    ...(filters.kind === null ? {} : { activityKind: filters.kind }),
    ...(filters.channel === null ? {} : { channel: filters.channel }),
    ...(filters.account === null ? {} : { account: filters.account }),
    ...(filters.outcome === null ? {} : { outcome: filters.outcome }),
  };
}

function OneSession({
  summary,
  since,
  tick,
}: {
  summary: SessionView;
  since: ReturnType<typeof sinceOf>;
  tick: number;
}) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const read = useRead<TimelineView>(showCall(summary.key, since, filters), readTimeline, tick);
  // The head is the session over the range asked, once it is read; the list's until then.
  const session = read.state === 'ready' ? read.value.session : summary;
  return (
    <div className="flex flex-col gap-(--cue-space-4)">
      <SessionHead session={session} />
      <FilterBar session={session} filters={filters} onChange={setFilters} />
      <section aria-label={ACTIVITY_COPY.timeline}>
        <Panel>
          {read.state === 'loading' ? (
            <div className="p-(--cue-space-4)">
              <Spinner label={COPY.loading} />
            </div>
          ) : read.state === 'error' ? (
            <div className="p-(--cue-space-4)">
              <Problem message={read.message} />
            </div>
          ) : read.state === 'nothing' ? (
            <EmptyState title={ACTIVITY_COPY.nothingInRange} />
          ) : read.value.lines.length === 0 ? (
            <EmptyState title={ACTIVITY_COPY.noMatch} />
          ) : (
            <Lines lines={read.value.lines} />
          )}
        </Panel>
        {read.state === 'ready' && read.value.more ? (
          <p role="status" className="mt-(--cue-space-3) text-(length:--cue-text-ui) text-fg-muted">
            {ACTIVITY_COPY.more}
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** The session's head: where and by what it ran, how it was grouped, when, and its counts. */
function SessionHead({ session }: { session: SessionView }) {
  const runner = runnerOf(session);
  return (
    <section aria-label="Session" className="flex flex-col gap-(--cue-space-2)">
      <h2 className="min-w-0 text-(length:--cue-text-emphasis) font-semibold text-fg">
        {isService(session) ? (
          runner.said
        ) : session.folder === null ? (
          <span className="text-fg-muted">{ACTIVITY_COPY.folderUnknown}</span>
        ) : (
          <span className="break-all font-mono">{session.folder}</span>
        )}
      </h2>
      <p className="flex flex-wrap items-center gap-x-(--cue-space-2) gap-y-(--cue-space-1) text-fg-muted">
        {isService(session) ? null : (
          <>
            <span>{runner.said}</span>
            {runner.asTheClientSays ? (
              <span className="flex items-center gap-(--cue-space-1) text-fg-subtle">
                {ACTIVITY_COPY.asTheClientSays}
                <InfoTip label="About the client's name" text={ACTIVITY_COPY.clientHint} />
              </span>
            ) : null}
            <span aria-hidden="true">·</span>
          </>
        )}
        <span className="flex items-center gap-(--cue-space-1)">
          {session.grouped ? ACTIVITY_COPY.oneWindow : ACTIVITY_COPY.onItsOwn}
          {session.processes > 1 ? `, ${session.processes} processes` : ''}
          <InfoTip label="About grouping" text={ACTIVITY_COPY.groupingHint} />
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {ACTIVITY_COPY.started} <Short at={session.firstSeen} />
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {ACTIVITY_COPY.lastSeen} <Short at={session.lastSeen} />
        </span>
      </p>
      <Counts session={session} />
    </section>
  );
}

const ALL = 'all';

/** The four filters, each a closed choice: the session's own channels and accounts, every kind, every outcome. */
function FilterBar({
  session,
  filters,
  onChange,
}: {
  session: SessionView;
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  const channels = filterChannels(session);
  // Only a name the allow-list takes is offered: the account is passed on, and Rust refuses any other.
  const accounts = session.accounts.filter(isAccountName);
  // Each value is one of the closed words the select offered, or `all`, which clears it.
  const pick = (name: keyof Filters) => (value: string | null) =>
    onChange({ ...filters, [name]: value === null || value === ALL ? null : value } as Filters);
  return (
    <section aria-label={ACTIVITY_COPY.filters} className="grid grid-cols-2 gap-(--cue-space-2) md:grid-cols-4">
      <Select
        aria-label="Channel"
        size="sm"
        items={[
          { value: ALL, label: ACTIVITY_COPY.allChannels },
          ...channels.map((channel) => ({ value: channel, label: channelLabel(channel) })),
        ]}
        value={filters.channel ?? ALL}
        onValueChange={pick('channel')}
      />
      <Select
        aria-label="Account"
        size="sm"
        items={[
          { value: ALL, label: ACTIVITY_COPY.allAccounts },
          ...accounts.map((account) => ({ value: account, label: account })),
        ]}
        value={filters.account ?? ALL}
        onValueChange={pick('account')}
      />
      <Select
        aria-label="Kind"
        size="sm"
        items={[
          { value: ALL, label: ACTIVITY_COPY.allKinds },
          ...ACTIVITY_KINDS.map((kind) => ({ value: kind, label: KIND_WORDS[kind] })),
        ]}
        value={filters.kind ?? ALL}
        onValueChange={pick('kind')}
      />
      <Select
        aria-label="Outcome"
        size="sm"
        items={[
          { value: ALL, label: ACTIVITY_COPY.allOutcomes },
          ...ACTIVITY_OUTCOMES.map((outcome) => ({ value: outcome, label: OUTCOME_WORDS[outcome] })),
        ]}
        value={filters.outcome ?? ALL}
        onValueChange={pick('outcome')}
      />
    </section>
  );
}

// ── The timeline ───────────────────────────────────────────────────────────────────────────────────────────────

/** A minute's dot: danger when a call in it failed, warn when one was refused, a quiet ring otherwise. */
function minuteTone(lines: readonly LineView[]): 'danger' | 'warn' | 'idle' {
  if (lines.some((line) => line.outcome === 'failed')) return 'danger';
  if (lines.some((line) => line.outcome === 'refused')) return 'warn';
  return 'idle';
}

/** The lines, newest first, under the minute they fall in. */
function Lines({ lines }: { lines: readonly LineView[] }) {
  return (
    <Timeline.Root className="px-(--cue-pad-row-x) py-(--cue-space-4)">
      {byMinute(lines).map((minute) => {
        const tone = minuteTone(minute.lines);
        return (
          <Timeline.Item key={minute.at} data-minute={minute.at}>
            {/* The marker's disc is the panel's ground, which it sits on, so the rail runs behind it unbroken. */}
            <Timeline.Marker
              tone={tone}
              className="bg-surface-1"
              label={tone === 'danger' ? 'a call failed' : tone === 'warn' ? 'a call was refused' : 'calls'}
            />
            {/* Timeline.Content sets its text in a bare `font-mono`; the lines are prose, in the Look's own face. */}
            <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-2) text-(length:--cue-text-ui) text-fg">
              <h3 className="text-(length:--cue-text-label) text-fg-subtle">
                <Short at={minute.at} />
              </h3>
              <ul className="flex flex-col gap-(--cue-space-2)">
                {minute.lines.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: two calls can share a moment; the list never moves.
                  <LineRow key={`${line.at}-${index}`} line={line} />
                ))}
              </ul>
            </div>
          </Timeline.Item>
        );
      })}
    </Timeline.Root>
  );
}

/** A run of a line's words: the app's as text, an id in mono, a sender's boxed and marked. */
function Words({ parts }: { parts: readonly Part[] }) {
  return (
    <>
      {parts.map((part, index) =>
        'outside' in part ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are never reordered.
          <OutsideText key={index} text={part.outside} />
        ) : 'literal' in part ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are never reordered.
          <span key={index} className="font-mono">
            {part.literal}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are never reordered.
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** One call: what it did in a few words, and where — its channel and account — with From outside when a sender wrote any of it. */
function LineRow({ line }: { line: LineView }) {
  const words = lineWords(line);
  const status = words.status;
  const where = [channelLabel(line.channel), line.account.alias || line.account.id].filter(Boolean).join(' · ');
  return (
    <li className="flex items-baseline gap-(--cue-space-3)" data-kind={line.kind} data-outcome={line.outcome}>
      <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
        <span className="text-fg">
          {status === null ? null : (
            <span className={status === 'failed' ? 'font-medium text-danger' : 'font-medium text-warn'}>
              {STATUS_WORDS[status]}
              {words.headline.length === 0 ? '' : ': '}
            </span>
          )}
          <Words parts={words.headline} />
        </span>
        {words.detail === null ? null : (
          <span className="text-(length:--cue-text-ui) text-fg-muted">
            <Words parts={words.detail} />
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-(--cue-space-2) text-(length:--cue-text-label) text-fg-muted">
        {hasOutside(words) ? (
          <Chip tone="warn" variant="tag" data-slot="from-outside-label">
            {COPY.fromOutside}
          </Chip>
        ) : null}
        <span>{where}</span>
      </span>
    </li>
  );
}
