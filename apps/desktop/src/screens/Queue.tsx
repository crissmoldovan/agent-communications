import {
  AlertDialog,
  Button,
  Chip,
  EmptyState,
  IconButton,
  InfoTip,
  Panel,
  Select,
  Spinner,
  Tabs,
} from '@cueplusplus/ui';
import { Check, ExternalLink, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { NeedsNewerCli } from '../components/NeedsNewerCli.tsx';
import { OutsideText } from '../components/OutsideText.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { supports } from '../gates.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { type Call, type CliResult, errorMessage, type QueueChannel } from '../ipc.ts';
import { filterLanes, itemLane, type LaneView, narrowingRule, readLaneList } from '../lanes.ts';
import {
  FILTER_CHANNELS,
  filterRules,
  judgeWords,
  noQueueYet,
  openableLink,
  type QueueCounts,
  type QueueItem,
  type QueueListView,
  type QueueTab,
  queueChannelLabel,
  readCleared,
  readQueueList,
  readStateChange,
} from '../queue.ts';
import { LANES_COPY, LaneChip, LanesView } from './QueueLanes.tsx';
import { ScreenFrame } from './Screen.tsx';

/** The screen's words (design 2026-10-25-action-queue §4.5): a few each, with what only explains in a hint. */
export const QUEUE_COPY = {
  title: 'Queue',
  tabs: { open: 'Open', done: 'Done', dismissed: 'Dismissed' } satisfies Record<QueueTab, string>,
  about:
    'Each message a rule sent to the queue, with what its judge said. Mark it done or dismiss it once you have dealt with it. Items are kept on this Mac only, for their rule’s retention, whatever their state.',
  notInstalled: "The events service isn't installed.",
  noQueue: 'Nothing sends to the queue yet.',
  noQueueHint: 'Add a queue target and a rule that sends to it, then approve both in the terminal.',
  nothingWaiting: 'Nothing is waiting.',
  nothingDone: 'Nothing marked done.',
  nothingDismissed: 'Nothing dismissed.',
  noMatch: 'No items match these filters.',
  more: 'More items matched than are shown. Narrow a filter.',
  unreadable: 'The queue could not be read.',
  refresh: 'Read again',
  filters: 'Filters',
  rule: 'Rule',
  channel: 'Channel',
  allRules: 'All rules',
  allChannels: 'All channels',
  done: 'Done',
  dismiss: 'Dismiss',
  reopen: 'Reopen',
  clear: 'Clear done and dismissed',
  clearTitle: 'Clear done and dismissed items?',
  clearBody: 'They are removed from this Mac now, rather than when their retention ends. Open items stay.',
  clearAction: 'Clear',
  gone: 'This item is no longer in the queue.',
  aboutAnswer: 'About this answer',
  asked: 'The rule asked:',
  uncalibratedHint: "Uncalibrated: a local model server's score, not a probability.",
  keptUntil: 'Kept until',
  arrived: 'Arrived',
  markedDone: 'Done',
  markedDismissed: 'Dismissed',
} as const;

/** `Cleared <n> items.`, or `Cleared.` when the answer did not say how many. */
export function clearedLine(count: number | null): string {
  return count === null ? 'Cleared.' : `Cleared ${count} ${count === 1 ? 'item' : 'items'}.`;
}

/** How often the shown list is read again while the window is visible (§4.5). */
export const QUEUE_POLL_MS = 30_000;

/** How many items one read lists: the allow-list takes 1 to 200. */
export const QUEUE_LIMIT = 100;

/** The exit the event service's queue answers for an item it does not have (§8). */
const NO_SUCH_ITEM = 66;

// ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs the allow-listed `queue list` when its call changes, keeping only the answer of the read asked last, and again
 * whenever `reload` is called. The read shown is the one for this call: a read of another call shows as loading.
 */
function useQueueList(call: Call): { read: Loadable<QueueListView>; reload: () => Promise<void> } {
  const bridge = useBridge();
  const key = JSON.stringify(call);
  const [shown, setShown] = useState<{ key: string; read: Loadable<QueueListView> } | null>(null);
  const asked = useRef(0);
  const reload = useCallback(async () => {
    const ask = ++asked.current;
    let next: Loadable<QueueListView>;
    try {
      const result = await bridge.cli(JSON.parse(key) as Call);
      if (result.status === 'ok') {
        const value = readQueueList(result.data);
        next = value === null ? { state: 'error', message: QUEUE_COPY.unreadable } : { state: 'ready', value };
      } else if (result.status === 'failed') {
        next = { state: 'error', message: result.message };
      } else {
        next = { state: 'error', message: QUEUE_COPY.unreadable };
      }
    } catch (error) {
      next = { state: 'error', message: errorMessage(error) };
    }
    if (ask === asked.current) setShown({ key, read: next });
  }, [bridge, key]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { read: shown === null || shown.key !== key ? { state: 'loading' } : shown.read, reload };
}

/**
 * Reads the list again every 30 seconds while the window is visible, with the counts (`withCounts`), so a tab's count
 * never lags its list; and the list alone at once when the window is visible again, has the focus again or Rust says
 * something changed (§4.5), when the reads the screens share read the counts themselves.
 */
function useQueuePoll(reload: () => Promise<void>, withCounts: () => Promise<void>): void {
  const { visible } = useAppData();
  const latest = useRef(reload);
  const latestWithCounts = useRef(withCounts);
  useEffect(() => {
    latest.current = reload;
    latestWithCounts.current = withCounts;
  });
  const wasVisible = useRef(visible);
  useEffect(() => {
    const before = wasVisible.current;
    wasVisible.current = visible;
    if (!visible) return;
    if (!before) void latest.current().catch(() => undefined);
    const timer = setInterval(() => void latestWithCounts.current().catch(() => undefined), QUEUE_POLL_MS);
    return () => clearInterval(timer);
  }, [visible]);
  useReloadOnReturn(reload);
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
 * The action queue (design 2026-10-25-action-queue §4.5, §7, §8): each match a rule sent to a queue target, as a card the
 * person works through — what arrived and from whom, all of it a sender's and shown as plain text marked From outside;
 * which rule matched; what its judge said. Done and Dismiss change only the person's own list, so the app applies them
 * itself (DA10), as Reopen and Clear. Read only through the allow-listed `queue` calls, and only once the events
 * service's own version is one that has them (0.30.0).
 */
export function Queue() {
  return (
    <ScreenFrame title={QUEUE_COPY.title}>
      <QueueGate>
        <QueueViews />
      </QueueGate>
    </ScreenFrame>
  );
}

/** Its children once the events service is here and has the queue; otherwise what it needs first, and nothing runs. */
function QueueGate({ children }: { children: ReactNode }) {
  const { installation, eventsVersion } = useAppData();
  const present = installation.state === 'ready' && installation.value.present.includes('events-daemon');
  if (!present || eventsVersion === 'absent') {
    return (
      <Panel>
        <EmptyState title={QUEUE_COPY.notInstalled} />
      </Panel>
    );
  }
  if (eventsVersion.state === 'loading') return <Spinner label={COPY.loading} />;
  if (eventsVersion.state === 'error') return <Problem message={eventsVersion.message} />;
  if (!supports(eventsVersion.value, 'queue')) return <NeedsNewerEvents version={eventsVersion.value} />;
  return children;
}

/** The update line, with the events service's version; read again when the window comes back, as an update may land. */
function NeedsNewerEvents({ version }: { version: string }) {
  const { refresh } = useAppData();
  useReloadOnReturn(useCallback(() => refresh('eventsVersion'), [refresh]));
  return <NeedsNewerCli feature="queue" installed={version} />;
}

const ALL = 'all';

interface Filters {
  rule: string | null;
  channel: QueueChannel | null;
  /** A lane's name (0.31.0): the list read is filtered to the lane's items here, as `queue list` takes no lane. */
  lane: string | null;
}

/**
 * The call one tab's list makes, with only the filters set: each a closed word or a checked id. A lane narrows it by
 * the lane's one rule, when it has one and no rule is chosen, so the lane's items are not lost past the limit.
 */
function listCall(tab: QueueTab, filters: Filters, lanes: readonly LaneView[]): Call {
  const lane = filters.lane === null ? undefined : lanes.find((each) => each.name === filters.lane);
  const rule = filters.rule ?? (lane === undefined ? null : narrowingRule(lane));
  return {
    kind: 'queueList',
    state: tab,
    ...(rule === null ? {} : { rule }),
    ...(filters.channel === null ? {} : { channel: filters.channel }),
    limit: QUEUE_LIMIT,
  };
}

/** The screen's views: the three tabs of items, then its lanes (0.31.0). */
type QueueView = QueueTab | 'lanes';

/**
 * Reads the events service's `lane list` (0.31.0) when it has lanes, and again whenever `reload` is called, keeping
 * only the answer of the read asked last; `unsupported`, and nothing is asked, before it. A window's folder is shown
 * with the person's home as `~`.
 */
function useLanes(supported: boolean): { lanes: Loadable<LaneView[]> | 'unsupported'; reload: () => Promise<void> } {
  const bridge = useBridge();
  const { installation } = useAppData();
  const home = installation.state === 'ready' ? (installation.value.home ?? null) : null;
  const [read, setRead] = useState<Loadable<LaneView[]>>({ state: 'loading' });
  const asked = useRef(0);
  const reload = useCallback(async () => {
    if (!supported) return;
    const ask = ++asked.current;
    let next: Loadable<LaneView[]>;
    try {
      const result = await bridge.cli({ kind: 'laneList' });
      if (result.status === 'ok') {
        const value = readLaneList(result.data, home);
        next = value === null ? { state: 'error', message: LANES_COPY.unreadable } : { state: 'ready', value };
      } else {
        next = { state: 'error', message: result.status === 'failed' ? result.message : LANES_COPY.unreadable };
      }
    } catch (error) {
      next = { state: 'error', message: errorMessage(error) };
    }
    if (ask === asked.current) setRead(next);
  }, [bridge, supported, home]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { lanes: supported ? read : 'unsupported', reload };
}

function QueueViews() {
  const { queueCounts, refresh, eventsVersion } = useAppData();
  const version = eventsVersion !== 'absent' && eventsVersion.state === 'ready' ? eventsVersion.value : '';
  const [view, setView] = useState<QueueView>('open');
  // The items' tab last shown: its list stays read while the lanes are.
  const [tab, setTab] = useState<QueueTab>('open');
  const [filters, setFilters] = useState<Filters>({ rule: null, channel: null, lane: null });
  const [cleared, setCleared] = useState<string | null>(null);
  const [clearProblem, setClearProblem] = useState<string | null>(null);
  const lanesOn = supports(version, 'lanes');
  const { lanes, reload: reloadLanes } = useLanes(lanesOn);
  const known = lanes !== 'unsupported' && lanes.state === 'ready' ? lanes.value : [];
  const { read, reload } = useQueueList(listCall(tab, filters, known));
  const again = useCallback(async () => {
    await Promise.all([reload(), refresh('queue'), reloadLanes()]);
  }, [reload, refresh, reloadLanes]);
  useQueuePoll(reload, again);
  // A binding is made at a terminal: the lanes are read again when the person comes back.
  useReloadOnReturn(reloadLanes);

  const counts = typeof queueCounts === 'string' || queueCounts.state !== 'ready' ? null : queueCounts.value;

  if (counts !== null && noQueueYet(counts)) {
    return (
      <Panel>
        <EmptyState title={QUEUE_COPY.noQueue} hint={QUEUE_COPY.noQueueHint} />
      </Panel>
    );
  }
  return (
    <div className="flex flex-col gap-(--cue-space-4)">
      {typeof queueCounts !== 'string' && queueCounts.state === 'error' ? (
        <Problem message={queueCounts.message} />
      ) : null}
      <Tabs.Root
        value={view}
        onValueChange={(value) => {
          const next = value as QueueView;
          setView(next);
          if (next !== 'lanes') setTab(next);
        }}
        className="flex flex-col gap-(--cue-space-4)"
      >
        <div className="flex flex-wrap items-center gap-(--cue-space-3)">
          <Tabs.List aria-label={QUEUE_COPY.title} className="self-start">
            <Tabs.Tab value={'open' satisfies QueueTab}>
              {QUEUE_COPY.tabs.open} <OpenCount counts={counts} />
            </Tabs.Tab>
            <Tabs.Tab value={'done' satisfies QueueTab}>
              {QUEUE_COPY.tabs.done}
              <QuietCount count={counts?.done ?? null} />
            </Tabs.Tab>
            <Tabs.Tab value={'dismissed' satisfies QueueTab}>
              {QUEUE_COPY.tabs.dismissed}
              <QuietCount count={counts?.dismissed ?? null} />
            </Tabs.Tab>
            <Tabs.Tab value={'lanes' satisfies QueueView}>
              {LANES_COPY.tab}
              <QuietCount count={known.length} />
            </Tabs.Tab>
            <Tabs.Indicator />
          </Tabs.List>
          {view === 'lanes' ? (
            <InfoTip label="About lanes" text={LANES_COPY.about} />
          ) : (
            <InfoTip label="About the queue" text={QUEUE_COPY.about} />
          )}
          <span className="ml-auto flex items-center gap-(--cue-space-2)">
            {/* Clear touches only the done and dismissed, so only their tabs offer it. */}
            {view !== 'done' && view !== 'dismissed' ? null : (
              <ClearButton
                counts={counts}
                onCleared={(line) => {
                  setCleared(line);
                  void again();
                }}
                onFailed={setClearProblem}
              />
            )}
            <IconButton aria-label={QUEUE_COPY.refresh} icon={RefreshCw} size="sm" onClick={() => void again()} />
          </span>
        </div>
        {view === 'lanes' ? null : (
          <FilterBar counts={counts} lanes={filterLanes(known)} filters={filters} onChange={setFilters} />
        )}
        {cleared === null ? null : (
          <p role="status" className="text-(length:--cue-text-ui) text-fg-muted">
            {cleared}
          </p>
        )}
        {clearProblem === null ? null : <Problem message={clearProblem} />}
        {QUEUE_TAB_ORDER.map((each) => (
          <Tabs.Panel key={each} value={each}>
            <section aria-label={QUEUE_COPY.tabs[each]} className="flex flex-col gap-(--cue-space-3)">
              <Items
                tab={each}
                read={read}
                lanes={lanesOn ? known : null}
                lane={filters.lane}
                filtered={filters.rule !== null || filters.channel !== null || filters.lane !== null}
                onChanged={again}
              />
            </section>
          </Tabs.Panel>
        ))}
        <Tabs.Panel value={'lanes' satisfies QueueView}>
          <section aria-label={LANES_COPY.tab} className="flex flex-col gap-(--cue-space-3)">
            <LanesView
              version={version}
              lanes={lanes === 'unsupported' ? { state: 'loading' } : lanes}
              counts={counts}
              onChanged={again}
            />
          </section>
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

const QUEUE_TAB_ORDER: readonly QueueTab[] = ['open', 'done', 'dismissed'];

/** The Open tab's count, said in full to a screen reader; nothing until the counts are read. */
function OpenCount({ counts }: { counts: QueueCounts | null }) {
  if (counts === null) return null;
  return (
    <Chip tone="neutral" variant="tag" data-slot="tab-count">
      <span aria-hidden="true">{counts.open}</span>
      <span className="sr-only">{`${counts.open} waiting`}</span>
    </Chip>
  );
}

/** A tab's count of what it holds, quietly, beside its name. */
function QuietCount({ count }: { count: number | null }) {
  if (count === null || count === 0) return null;
  return (
    <>
      {' '}
      <span className="text-fg-muted tabular-nums" data-slot="tab-quiet-count">
        {count}
      </span>
    </>
  );
}

/**
 * The filters, each a closed choice: the rules the counts name with an id the allow-list takes, the channels, and —
 * once there are lanes (0.31.0) — the lanes with a name the allow-list takes.
 */
function FilterBar({
  counts,
  lanes,
  filters,
  onChange,
}: {
  counts: QueueCounts | null;
  lanes: readonly LaneView[];
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  const rules = counts === null ? [] : filterRules(counts);
  return (
    <section aria-label={QUEUE_COPY.filters} className="grid grid-cols-2 gap-(--cue-space-2) md:grid-cols-4">
      <Select
        aria-label={QUEUE_COPY.rule}
        size="sm"
        items={[
          { value: ALL, label: QUEUE_COPY.allRules },
          ...rules.map((rule) => ({ value: rule.ruleId, label: rule.name })),
        ]}
        value={filters.rule ?? ALL}
        onValueChange={(value) => onChange({ ...filters, rule: value === null || value === ALL ? null : value })}
      />
      <Select
        aria-label={QUEUE_COPY.channel}
        size="sm"
        items={[
          { value: ALL, label: QUEUE_COPY.allChannels },
          ...FILTER_CHANNELS.map((channel) => ({ value: channel, label: queueChannelLabel(channel) })),
        ]}
        value={filters.channel ?? ALL}
        onValueChange={(value) =>
          onChange({ ...filters, channel: value === null || value === ALL ? null : (value as QueueChannel) })
        }
      />
      {lanes.length === 0 ? null : (
        <Select
          aria-label={LANES_COPY.lane}
          size="sm"
          items={[
            { value: ALL, label: LANES_COPY.allLanes },
            ...lanes.map((lane) => ({ value: lane.name, label: lane.name })),
          ]}
          value={filters.lane ?? ALL}
          onValueChange={(value) => onChange({ ...filters, lane: value === null || value === ALL ? null : value })}
        />
      )}
    </section>
  );
}

/**
 * Clear, which asks first: only its own Clear runs it, and Cancel, Escape or closing it runs nothing. Off when nothing
 * is done or dismissed.
 */
function ClearButton({
  counts,
  onCleared,
  onFailed,
}: {
  counts: QueueCounts | null;
  onCleared: (line: string) => void;
  onFailed: (problem: string | null) => void;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const nothing = counts !== null && counts.done + counts.dismissed === 0;
  const clear = async () => {
    setBusy(true);
    onFailed(null);
    try {
      const result = await bridge.cli({ kind: 'queueClear' });
      if (result.status === 'ok') onCleared(clearedLine(readCleared(result.data)));
      else onFailed(result.status === 'failed' ? result.message : QUEUE_COPY.unreadable);
    } catch (error) {
      onFailed(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        render={
          <Button size="sm" variant="ghost" icon={Trash2} disabled={busy || nothing} loading={busy}>
            {QUEUE_COPY.clear}
          </Button>
        }
      />
      <AlertDialog.Content>
        <AlertDialog.Title>{QUEUE_COPY.clearTitle}</AlertDialog.Title>
        <AlertDialog.Description>{QUEUE_COPY.clearBody}</AlertDialog.Description>
        <AlertDialog.Footer>
          <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
          <AlertDialog.Action tone="danger" onClick={() => void clear()}>
            {QUEUE_COPY.clearAction}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/** What a tab says when it holds nothing. */
const EMPTY: Readonly<Record<QueueTab, string>> = {
  open: QUEUE_COPY.nothingWaiting,
  done: QUEUE_COPY.nothingDone,
  dismissed: QUEUE_COPY.nothingDismissed,
};

/**
 * One tab's items, newest first, as cards, each with its lane when it is in one — once the events service has lanes
 * (`lanes` is null before) — and only the chosen lane's, when one is; what it says when there are none; and that more
 * matched.
 */
function Items({
  tab,
  read,
  lanes,
  lane,
  filtered,
  onChanged,
}: {
  tab: QueueTab;
  read: Loadable<QueueListView>;
  lanes: readonly LaneView[] | null;
  lane: string | null;
  filtered: boolean;
  onChanged: () => Promise<void>;
}) {
  const laneOf = (item: QueueItem): string | null => (lanes === null ? null : itemLane(item, lanes));
  // An item marked here leaves its tab at once, before the list is read again; each new read says again what is here.
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (read.state === 'ready') setLeft(new Set());
  }, [read]);
  if (read.state === 'loading') return <Spinner label={COPY.loading} />;
  if (read.state === 'error') return <Problem message={read.message} />;
  const items = read.value.items.filter(
    (item) => item.state === tab && !left.has(item.id) && (lane === null || laneOf(item) === lane),
  );
  if (items.length === 0) {
    return (
      <Panel>
        <EmptyState title={filtered ? QUEUE_COPY.noMatch : EMPTY[tab]} />
      </Panel>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-(--cue-space-3)">
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            lane={laneOf(item)}
            onChanged={async () => {
              setLeft((before) => new Set([...before, item.id]));
              await onChanged();
            }}
            onGone={onChanged}
          />
        ))}
      </ul>
      {read.value.more ? (
        <p role="status" className="text-(length:--cue-text-ui) text-fg-muted">
          {QUEUE_COPY.more}
        </p>
      ) : null}
    </>
  );
}

// ── Times ──────────────────────────────────────────────────────────────────────────────────────────────────────

const FULL = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** A moment, short: the time alone when it is today, the day and time otherwise; the full moment on hover. */
function Short({ at, title }: { at: string; title?: string }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <UntrustedText text={at} />;
  const today = date.toDateString() === new Date().toDateString();
  const shown = today
    ? date.toLocaleTimeString(undefined, { timeStyle: 'short' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <time dateTime={date.toISOString()} title={title ?? date.toLocaleString(undefined, FULL)}>
      {shown}
    </time>
  );
}

/** The full moment, in words, for a hover. */
function full(at: string | null): string | null {
  if (at === null) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, FULL);
}

// ── One item ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What applying a change came to: done, the item gone (exit 66), or a failure to say. */
type Applied = { state: 'applied' } | { state: 'gone' } | { state: 'failed'; message: string };

async function apply(cli: (call: Call) => Promise<CliResult>, call: Call): Promise<Applied> {
  try {
    const result = await cli(call);
    if (result.status === 'ok') {
      return readStateChange(result.data) === null
        ? { state: 'failed', message: QUEUE_COPY.unreadable }
        : { state: 'applied' };
    }
    if (result.status === 'failed' && result.exit === NO_SUCH_ITEM) return { state: 'gone' };
    return { state: 'failed', message: result.status === 'failed' ? result.message : QUEUE_COPY.unreadable };
  } catch (error) {
    return { state: 'failed', message: errorMessage(error) };
  }
}

/**
 * One item, as a card in the soft look: its channel and account and when it arrived; who it is from and its subject or
 * first words, each a sender's, plain text marked From outside; the rule that matched and what its judge said; and its
 * actions — Done and Dismiss while open, Reopen once not, and Open in Gmail or Slack when it has a link the app opens.
 */
function ItemCard({
  item,
  lane,
  onChanged,
  onGone,
}: {
  item: QueueItem;
  /** The lane it is in (0.31.0), or null. */
  lane: string | null;
  onChanged: () => Promise<void>;
  onGone: () => Promise<void>;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const link = openableLink(item.link);
  const where = [queueChannelLabel(item.channel), item.account.alias || item.account.id].filter(Boolean).join(' · ');
  const what = item.subject ?? item.text;
  const run = async (call: Call) => {
    setBusy(true);
    setProblem(null);
    const outcome = await apply((each) => bridge.cli(each), call);
    setBusy(false);
    if (outcome.state === 'applied') await onChanged();
    else if (outcome.state === 'gone') {
      setProblem(QUEUE_COPY.gone);
      await onGone();
    } else setProblem(outcome.message);
  };
  const open = () => {
    if (link === null) return;
    setProblem(null);
    bridge.openLink(link.url).catch((error: unknown) => setProblem(errorMessage(error)));
  };
  const arrived = full(item.arrivedAt);
  const kept = full(item.expiresAt);
  const hover = [
    arrived === null ? null : `${QUEUE_COPY.arrived} ${arrived}`,
    kept === null ? null : `${QUEUE_COPY.keptUntil} ${kept}`,
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <li data-item={item.id} data-state={item.state} data-channel={item.channel}>
      <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <div className="flex items-center gap-(--cue-space-3) text-(length:--cue-text-label) text-fg-muted">
          <span data-slot="queue-where">{where}</span>
          {lane === null ? null : <LaneChip lane={lane} />}
          <Chip tone="warn" variant="tag" data-slot="from-outside-label">
            {COPY.fromOutside}
          </Chip>
          <span className="ml-auto flex items-center gap-(--cue-space-2)">
            {/* When it arrived, in the same place on every tab; when it was marked, after it. */}
            <Short at={item.arrivedAt} {...(hover === '' ? {} : { title: hover })} />
            {item.state === 'open' || item.stateAt === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {item.state === 'done' ? QUEUE_COPY.markedDone : QUEUE_COPY.markedDismissed}{' '}
                  <Short at={item.stateAt} />
                </span>
              </>
            )}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-(--cue-space-1)">
          <From from={item.from} />
          {what === null ? null : (
            <span className="text-fg" data-slot="queue-what">
              <OutsideText text={what} />
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-(--cue-space-3) gap-y-(--cue-space-2)">
          <span className="text-(length:--cue-text-ui) text-fg-muted">
            <span className="sr-only">{QUEUE_COPY.rule}: </span>
            <span data-slot="queue-rule">
              <UntrustedText text={item.rule.name ?? item.rule.id} />
            </span>
          </span>
          <Judge item={item} />
          <span className="ml-auto flex flex-wrap items-center gap-(--cue-space-2)">
            {link === null ? null : (
              <Button size="sm" variant="ghost" icon={ExternalLink} onClick={open}>
                {link.label}
              </Button>
            )}
            {!item.actionable ? null : item.state === 'open' ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={X}
                  disabled={busy}
                  onClick={() => void run({ kind: 'queueDismiss', itemId: item.id })}
                >
                  {QUEUE_COPY.dismiss}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Check}
                  disabled={busy}
                  onClick={() => void run({ kind: 'queueDone', itemId: item.id })}
                >
                  {QUEUE_COPY.done}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                icon={RotateCcw}
                disabled={busy}
                onClick={() => void run({ kind: 'queueReopen', itemId: item.id })}
              >
                {QUEUE_COPY.reopen}
              </Button>
            )}
          </span>
        </div>
        {problem === null ? null : <Problem message={problem} />}
      </Panel>
    </li>
  );
}

/** Who an item is from: their name, and their address after it, each as they wrote it. */
function From({ from }: { from: QueueItem['from'] }) {
  if (from.name === null && from.address === null) return null;
  return (
    <span
      className="flex min-w-0 flex-wrap items-baseline gap-x-(--cue-space-2) font-medium text-fg"
      data-slot="queue-from"
    >
      {from.name === null ? null : (
        <span>
          <OutsideText text={from.name} />
        </span>
      )}
      {from.address === null ? null : (
        <span className="font-normal text-(length:--cue-text-ui) text-fg-muted">
          <OutsideText text={from.address} />
        </span>
      )}
    </span>
  );
}

/**
 * What the judge said, as a quiet chip (§4.5, Q3): "Jev: yes, 0.86", with what the rule asked, and why a local model's
 * score is uncalibrated, in one hint beside it; that its answer is no longer kept; that the person let it through; or
 * nothing, when the rule asked no judge.
 */
function Judge({ item }: { item: QueueItem }) {
  const words = judgeWords(item.judge);
  if (words === null) return null;
  const { judge } = item;
  if (judge.state !== 'answered') {
    return (
      <span className="text-(length:--cue-text-ui) text-fg-subtle" data-slot="queue-judge" data-judge={judge.state}>
        {words}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-(--cue-space-1)">
      <Chip variant="tag" data-slot="queue-judge" data-judge={judge.state}>
        {words}
      </Chip>
      {judge.question === null && !judge.uncalibrated ? null : (
        <InfoTip
          label={QUEUE_COPY.aboutAnswer}
          text={
            <span className="flex flex-col gap-(--cue-space-1)">
              {judge.question === null ? null : (
                <span>
                  {QUEUE_COPY.asked} <UntrustedText text={judge.question} />
                </span>
              )}
              {judge.uncalibrated ? <span>{QUEUE_COPY.uncalibratedHint}</span> : null}
            </span>
          }
        />
      )}
    </span>
  );
}
