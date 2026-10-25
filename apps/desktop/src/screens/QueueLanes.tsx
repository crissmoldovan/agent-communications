import { AlertDialog, Button, Chip, Dialog, EmptyState, InfoTip, Panel, Row, Spinner } from '@cueplusplus/ui';
import { Link2Off, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readSessions, type SessionView } from '../activity.ts';
import { useBridge } from '../bridge-context.tsx';
import { NeedsNewerCli } from '../components/NeedsNewerCli.tsx';
import { TerminalResult } from '../components/TerminalResult.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { Ago } from '../components/When.tsx';
import { COPY } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { supports } from '../gates.ts';
import { errorMessage, type TerminalOutcome } from '../ipc.ts';
import {
  clientWords,
  type LaneBinding,
  type LaneView,
  type PickableWindow,
  pickerWindows,
  readUnbound,
  ruleNames,
} from '../lanes.ts';
import { type QueueCounts, queueChannelLabel } from '../queue.ts';

/** The Lanes view's words (design 2026-10-25-routing §2, B1, B4): a few each, with what only explains in a hint. */
export const LANES_COPY = {
  tab: 'Lanes',
  about:
    'A lane is a queue with a name. The agent window bound to it is woken for each new item, and may read it. Other agent windows never see its items; you see them all, here.',
  noLanes: 'No lanes yet.',
  noLanesHint: 'Give a queue target a lane in its rule, then approve the rule in the terminal.',
  unreadable: 'The lanes could not be read.',
  lane: 'Lane',
  allLanes: 'All lanes',
  notBound: 'Not bound',
  since: 'since',
  folderUnknown: 'Folder unknown',
  asTheClientSays: 'as the client says',
  clientHint: 'A client names itself: this is what it said, not proof of what it is.',
  unbind: 'Unbind',
  unbindBody: 'Its window is no longer woken for new items, and can no longer read them. This applies now.',
  gone: 'This lane is no longer there.',
  bind: 'Bind a window…',
  bindHint: 'You bind it at the terminal, so an agent can never bind itself.',
  pickerBody: 'Agent windows from the last 24 hours.',
  bindInTerminal: 'Bind in Terminal',
  pickerAfter: 'Run it in Terminal, then come back: the lane shows its window.',
  noWindows: 'No agent windows in the last 24 hours.',
  noWindowsHint: 'A window shows here once its agent has used agent-communications.',
  hiddenHint:
    'Only a session grouped as one agent window can be bound. A command, the event service or a process on its own cannot be told from another, so it is not listed.',
  windowsUnreadable: 'Recent windows could not be read.',
  lastSeen: 'Last seen',
  close: 'Close',
} as const;

/** `<n> open`. */
export function openWords(open: number): string {
  return `${open} open`;
}

/** `Unbind <lane>?` */
export function unbindTitle(lane: string): string {
  return `Unbind ${lane}?`;
}

/** `Unbound <lane>.` */
export function unboundLine(lane: string): string {
  return `Unbound ${lane}.`;
}

/** `Bind a window to <lane>` */
export function pickerTitle(lane: string): string {
  return `Bind a window to ${lane}`;
}

/** `<n> more not listed`: the sessions in the range the picker cannot offer. */
export function hiddenLine(count: number): string {
  return `${count} more not listed`;
}

/** `Bound to <lane>`: a window that has a lane already (one lane per window). */
export function boundElsewhere(lane: string): string {
  return `Bound to ${lane}`;
}

/** The exit the event service's `lane` commands answer for a lane it does not have (§6). */
const NO_SUCH_LANE = 66;

/** What went wrong, as text. */
function Problem({ message }: { message: string }) {
  return (
    <p role="alert" className="text-danger">
      <UntrustedText text={message} />
    </p>
  );
}

/** A queue item's lane, as a quiet chip: its name, said in full to a screen reader. */
export function LaneChip({ lane }: { lane: string }) {
  return (
    <Chip variant="tag" data-slot="queue-lane" data-item-lane={lane}>
      <span className="sr-only">{LANES_COPY.lane} </span>
      {lane}
    </Chip>
  );
}

const FULL = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** A moment, short: the time alone when it is today, the day and time otherwise; the full moment on hover. */
function Since({ at }: { at: string }) {
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

/**
 * The Lanes view (§2, B1): each lane with its rules and channels, its open count and the window bound to it, with
 * Unbind; or, when none is, Bind a window…, which opens a picker of recent agent windows whose Bind in Terminal opens
 * the person's terminal with the bind command. The app never binds (DA10); Unbind, a tightening, it applies itself,
 * once the person says so. Only once the events service's own version has lanes (0.31.0).
 */
export function LanesView({
  version,
  lanes,
  counts,
  onChanged,
}: {
  version: string;
  lanes: Loadable<LaneView[]>;
  counts: QueueCounts | null;
  onChanged: () => Promise<void>;
}) {
  const [line, setLine] = useState<string | null>(null);
  if (!supports(version, 'lanes')) return <NeedsNewerCli feature="lanes" installed={version} />;
  if (lanes.state === 'loading') return <Spinner label={COPY.loading} />;
  if (lanes.state === 'error') return <Problem message={lanes.message} />;
  if (lanes.value.length === 0) {
    return (
      <Panel>
        <EmptyState title={LANES_COPY.noLanes} hint={LANES_COPY.noLanesHint} />
      </Panel>
    );
  }
  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      {line === null ? null : (
        <p role="status" className="text-(length:--cue-text-ui) text-fg-muted">
          {line}
        </p>
      )}
      <Panel>
        <div data-slot="lane-list">
          {lanes.value.map((lane) => (
            <LaneRow
              key={lane.name}
              lane={lane}
              lanes={lanes.value}
              counts={counts}
              onUnbound={async (said) => {
                setLine(said);
                await onChanged();
              }}
              onGone={onChanged}
            />
          ))}
        </div>
      </Panel>
    </div>
  );
}

/** One lane, as a row: its name and open count; its rules and channels; its binding; and Unbind or Bind a window…. */
function LaneRow({
  lane,
  lanes,
  counts,
  onUnbound,
  onGone,
}: {
  lane: LaneView;
  lanes: LaneView[];
  counts: QueueCounts | null;
  onUnbound: (line: string) => Promise<void>;
  onGone: () => Promise<void>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const rules = ruleNames(lane, counts);
  const channels = lane.channels.map((channel) => queueChannelLabel(channel));
  const what = [rules.join(', '), channels.join(', ')].filter(Boolean).join(' · ');
  return (
    <Row
      data-lane={lane.name}
      data-bound={lane.binding === null ? 'false' : 'true'}
      className="items-start gap-(--cue-space-4)"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
        <span className="flex flex-wrap items-center gap-(--cue-space-2)">
          <span className="font-medium font-mono text-fg" data-slot="lane-name">
            <UntrustedText text={lane.name} />
          </span>
          <Chip variant="tag" data-slot="lane-open">
            {openWords(lane.open)}
          </Chip>
        </span>
        {what === '' ? null : (
          <span className="text-(length:--cue-text-label) text-fg-muted" data-slot="lane-rules">
            <UntrustedText text={what} />
          </span>
        )}
        <Binding binding={lane.binding} />
        {problem === null ? null : <Problem message={problem} />}
      </span>
      <span className="flex shrink-0 items-center gap-(--cue-space-1)">
        {!lane.actionable ? null : lane.binding === null ? (
          <BindWindow lane={lane} lanes={lanes} />
        ) : (
          <UnbindButton
            lane={lane.name}
            onUnbound={onUnbound}
            onGone={async () => {
              setProblem(LANES_COPY.gone);
              await onGone();
            }}
            onFailed={setProblem}
          />
        )}
      </span>
    </Row>
  );
}

/** A lane's binding: the window's folder in mono, with the home as `~`; its client, as the client says; and since. */
function Binding({ binding }: { binding: LaneBinding | null }) {
  if (binding === null) {
    return (
      <span className="text-(length:--cue-text-ui) text-fg-subtle" data-slot="lane-binding">
        {LANES_COPY.notBound}
      </span>
    );
  }
  const bound = binding.window;
  const client = clientWords(bound.client);
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-(--cue-space-2) gap-y-(--cue-space-1) text-(length:--cue-text-ui)"
      data-slot="lane-binding"
    >
      {bound.folder === null ? (
        <span className="text-fg-muted">{LANES_COPY.folderUnknown}</span>
      ) : (
        <span className="truncate font-mono text-fg" data-slot="lane-folder" title={bound.folder}>
          <UntrustedText text={bound.folder} />
        </span>
      )}
      {client === null ? null : (
        <>
          <span aria-hidden="true" className="text-fg-subtle">
            ·
          </span>
          <span className="flex items-center gap-(--cue-space-1) text-fg-muted" data-slot="lane-client">
            <span>
              <UntrustedText text={client} />
              <span className="text-fg-subtle">, {LANES_COPY.asTheClientSays}</span>
            </span>
            <InfoTip label="About the client" text={LANES_COPY.clientHint} />
          </span>
        </>
      )}
      {binding.since === null ? null : (
        <>
          <span aria-hidden="true" className="text-fg-subtle">
            ·
          </span>
          <span className="text-fg-muted" data-slot="lane-since">
            {LANES_COPY.since} <Since at={binding.since} />
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Unbind, which asks first: only its own Unbind runs `lane unbind <lane>`, and Cancel, Escape or closing it runs
 * nothing. A tightening, so the app applies it at once (B1).
 */
function UnbindButton({
  lane,
  onUnbound,
  onGone,
  onFailed,
}: {
  lane: string;
  onUnbound: (line: string) => Promise<void>;
  onGone: () => Promise<void>;
  onFailed: (problem: string | null) => void;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const unbind = async () => {
    setBusy(true);
    onFailed(null);
    try {
      const result = await bridge.cli({ kind: 'laneUnbind', lane });
      if (result.status === 'ok') {
        const unbound = readUnbound(result.data);
        if (unbound === null) onFailed(LANES_COPY.unreadable);
        else await onUnbound(unboundLine(unbound));
      } else if (result.status === 'failed' && result.exit === NO_SUCH_LANE) {
        await onGone();
      } else {
        onFailed(result.status === 'failed' ? result.message : LANES_COPY.unreadable);
      }
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
          <Button size="sm" variant="ghost" icon={Link2Off} disabled={busy} loading={busy}>
            {LANES_COPY.unbind}
          </Button>
        }
      />
      <AlertDialog.Content>
        <AlertDialog.Title>{unbindTitle(lane)}</AlertDialog.Title>
        <AlertDialog.Description>{LANES_COPY.unbindBody}</AlertDialog.Description>
        <AlertDialog.Footer>
          <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
          <AlertDialog.Action tone="danger" onClick={() => void unbind()}>
            {LANES_COPY.unbind}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/**
 * Bind a window…, which opens the picker: recent agent windows, grouped ones only, each with Bind in Terminal, which
 * opens the person's terminal with `lane bind <lane> --window <its activity key>` (B1). The app never runs it.
 */
function BindWindow({ lane, lanes }: { lane: LaneView; lanes: LaneView[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="flex items-center gap-(--cue-space-1)">
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger render={<Button size="sm">{LANES_COPY.bind}</Button>} />
        <Dialog.Content width="lg" showCloseButton={false}>
          <Dialog.Title>{pickerTitle(lane.name)}</Dialog.Title>
          <Dialog.Description>{LANES_COPY.pickerBody}</Dialog.Description>
          {open ? <Picker lane={lane.name} lanes={lanes} /> : null}
          <Dialog.Footer>
            <Dialog.Close render={<Button variant="ghost">{LANES_COPY.close}</Button>} />
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
      <InfoTip label="About binding" text={LANES_COPY.bindHint} />
    </span>
  );
}

/** Reads core's `activity sessions --since 24h` once, when the picker opens: only once core has the activity log. */
function useRecentSessions(supported: boolean): Loadable<SessionView[]> {
  const bridge = useBridge();
  const [read, setRead] = useState<Loadable<SessionView[]>>({ state: 'loading' });
  const asked = useRef(0);
  const load = useCallback(async () => {
    const ask = ++asked.current;
    let next: Loadable<SessionView[]>;
    try {
      const result = await bridge.cli({ kind: 'activitySessions', since: '24h' });
      if (result.status === 'ok') {
        const value = readSessions(result.data);
        next =
          value === null
            ? { state: 'error', message: LANES_COPY.windowsUnreadable }
            : { state: 'ready', value: value.sessions };
      } else {
        next = { state: 'error', message: result.status === 'failed' ? result.message : LANES_COPY.windowsUnreadable };
      }
    } catch (error) {
      next = { state: 'error', message: errorMessage(error) };
    }
    if (ask === asked.current) setRead(next);
  }, [bridge]);
  useEffect(() => {
    if (supported) void load();
  }, [supported, load]);
  return read;
}

/** The picker's list: each grouped window, with Bind in Terminal; how many others are not listed, and why. */
function Picker({ lane, lanes }: { lane: string; lanes: LaneView[] }) {
  const bridge = useBridge();
  const { installation } = useAppData();
  const core = installation.state === 'ready' ? installation.value.version : null;
  const supported = supports(core, 'activity');
  const sessions = useRecentSessions(supported);
  const [outcome, setOutcome] = useState<TerminalOutcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!supported) return <NeedsNewerCli feature="activity" installed={core} />;
  if (sessions.state === 'loading') return <Spinner label={COPY.loading} />;
  if (sessions.state === 'error') return <Problem message={sessions.message} />;
  const { windows, hidden } = pickerWindows(sessions.value, lanes);
  const bind = async (pick: PickableWindow) => {
    setBusy(pick.session.key);
    setProblem(null);
    setOutcome(null);
    try {
      setOutcome(await bridge.openInTerminal({ kind: 'laneBind', lane, window: pick.session.key }));
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      {windows.length === 0 ? (
        <EmptyState title={LANES_COPY.noWindows} hint={LANES_COPY.noWindowsHint} />
      ) : (
        <Panel data-slot="picker-windows">
          {windows.map((pick) => (
            <WindowRow key={pick.session.key} pick={pick} busy={busy !== null} onBind={() => void bind(pick)} />
          ))}
        </Panel>
      )}
      {hidden === 0 ? null : (
        <p
          className="flex items-center gap-(--cue-space-1) text-(length:--cue-text-ui) text-fg-muted"
          data-slot="picker-hidden"
        >
          {hiddenLine(hidden)}
          <InfoTip label="Why some are not listed" text={LANES_COPY.hiddenHint} />
        </p>
      )}
      {outcome === null ? null : (
        <div className="flex flex-col gap-(--cue-space-1) text-(length:--cue-text-ui)">
          <TerminalResult outcome={outcome} />
          <p className="text-fg-muted">{LANES_COPY.pickerAfter}</p>
        </div>
      )}
      {problem === null ? null : <Problem message={problem} />}
    </div>
  );
}

/** One window in the picker: its folder in mono, its client as it says, when it was last seen, and Bind in Terminal. */
function WindowRow({ pick, busy, onBind }: { pick: PickableWindow; busy: boolean; onBind: () => void }) {
  const { session, boundTo } = pick;
  const client = clientWords(session.client);
  return (
    <Row data-window={session.key} className="items-center gap-(--cue-space-4)">
      <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
        {session.folder === null ? (
          <span className="text-fg-muted">{LANES_COPY.folderUnknown}</span>
        ) : (
          <span className="truncate font-mono text-fg" title={session.folder}>
            <UntrustedText text={session.folder} />
          </span>
        )}
        <span className="flex flex-wrap gap-x-(--cue-space-2) text-(length:--cue-text-label) text-fg-muted">
          {client === null ? null : (
            <>
              <span>
                <UntrustedText text={client} />
                <span className="text-fg-subtle">, {LANES_COPY.asTheClientSays}</span>
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>
            {LANES_COPY.lastSeen} <Ago at={session.lastSeen} />
          </span>
        </span>
      </span>
      {boundTo === null ? (
        <Button size="sm" variant="secondary" icon={SquareTerminal} disabled={busy} onClick={onBind}>
          {LANES_COPY.bindInTerminal}
        </Button>
      ) : (
        <span className="shrink-0 text-(length:--cue-text-ui) text-fg-subtle" data-slot="window-bound">
          {boundElsewhere(boundTo)}
        </span>
      )}
    </Row>
  );
}
