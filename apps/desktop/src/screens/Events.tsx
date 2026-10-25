import {
  AlertDialog,
  Button,
  Chip,
  DescriptionList,
  EmptyState,
  InfoTip,
  Row as Line,
  Link,
  Panel,
  SectionHeader,
  Spinner,
  Switch,
  Table,
  TableScrollRegion,
  Tabs,
} from '@cueplusplus/ui';
import { Fragment, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { TerminalResult } from '../components/TerminalResult.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { Ago, When } from '../components/When.tsx';
import { COPY, needsLine } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { GATES, supports } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn, useReloadOnServiceTurn } from '../hooks/use-reload-on-return.ts';
import {
  type Call,
  type EndpointJudgeKind,
  type EventServiceState,
  type EventServiceStatus,
  errorMessage,
  type TerminalOutcome,
} from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/*
 * What this screen reads of the events service's bare JSON, field by field (DA13: its CLI keeps its own shape).
 *   status          `packages/events-daemon/src/operations/status.ts`, `EventsDaemonStatus`
 *   rules list      `runtime/owner.ts`, `ruleRows`: one row per rule version, its columns as SQLite names them
 *   deliveries list `runtime/b3-operator-control.ts`, `deliveriesList`: content-free metadata, times in epoch ms
 *   judge model status  `operations/contracts/laya-model-status-v1.schema.json`: Laya's closed status (E2)
 *   judge kinds list    `operations/contracts/b3-control-v2.schema.json`, `judgeKindEntry`: each kind's state
 *   judges list         `operations/contracts/b3-control-v3.schema.json`, `judgeInventoryEntry`: content-free judges
 */

/** `EventsDaemonStatus`: whether the service has an owner, and its switch. */
interface EventsStatus {
  owner: string;
  enabled?: boolean;
  paused?: boolean;
}

type Row = Record<string, unknown>;

/** A column of a list: its heading, what a row shows under it, and whether that is a literal value, set in mono. */
interface Column {
  label: string;
  show: (row: Row) => ReactNode;
  numeric?: boolean;
  literal?: boolean;
}

/** The most deliveries the table shows; the CLI and MCP list every one. */
const DELIVERIES_SHOWN = 100;

/** The padding of what a panel holds that is not one of its rows: a spinner, an error, a line, so it lines up with them. */
const INSET = 'px-(--cue-pad-row-x) py-(--cue-space-3)';

/** A read inside a panel: its spinner or its error inset, and its value as `children` lay it out. */
function InPanel<T>({ value, children }: { value: Loadable<T>; children: (value: T) => ReactNode }) {
  if (value.state === 'ready') return <>{children(value.value)}</>;
  return (
    <div className={INSET}>
      <ScreenState value={value}>{() => null}</ScreenState>
    </div>
  );
}

const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value as text and only text: nothing in it is read as markup. A missing one is a dash. */
function plain(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'string') return <UntrustedText text={value} />;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return <UntrustedText text={JSON.stringify(value)} />;
}

/** An id and its version, as `rule_x v2`. */
function versioned(id: unknown, version: unknown): ReactNode {
  if (typeof id !== 'string') return '-';
  return <UntrustedText text={typeof version === 'number' ? `${id} v${version}` : id} />;
}

/** A time in epoch milliseconds, or a dash. */
function moment(value: unknown): ReactNode {
  return typeof value === 'number' ? <When at={value} /> : '-';
}

/** A digest's first twelve characters, the whole of it on hover. */
function digest(value: unknown): ReactNode {
  if (typeof value !== 'string') return '-';
  return (
    <span title={value}>
      <UntrustedText text={value.length > 12 ? `${value.slice(0, 12)}…` : value} />
    </span>
  );
}

const RULE_COLUMNS: readonly Column[] = [
  { label: 'Rule', show: (row) => plain(row.rule_id), literal: true },
  { label: 'Version', show: (row) => plain(row.version), numeric: true },
  { label: 'State', show: (row) => plain(row.state) },
  { label: 'Approval', show: (row) => plain(row.approval_id), literal: true },
  { label: 'Activation', show: (row) => plain(row.authorization_activation_id), literal: true },
  { label: 'Digest', show: (row) => digest(row.digest), literal: true },
];

const DELIVERY_COLUMNS: readonly Column[] = [
  { label: 'Delivery', show: (row) => plain(row.deliveryId), literal: true },
  { label: 'Rule', show: (row) => versioned(row.ruleId, row.ruleVersion), literal: true },
  { label: 'Target', show: (row) => versioned(row.targetId, row.targetVersion), literal: true },
  { label: 'Account', show: (row) => plain(row.accountId), literal: true },
  { label: 'State', show: (row) => plain(row.state) },
  { label: 'Attempts', show: (row) => plain(row.attempts), numeric: true },
  { label: 'Next try', show: (row) => moment(row.nextAt) },
  { label: 'Expires', show: (row) => moment(row.expiresAt) },
];

/**
 * The most recent deliveries first. The list comes in id order; a delivery's expiry is its creation plus the time it
 * is kept, so the latest to expire are the latest made.
 */
function recentFirst(rows: Row[]): Row[] {
  const expires = (row: Row) => (typeof row.expiresAt === 'number' ? row.expiresAt : Number.NEGATIVE_INFINITY);
  return [...rows].sort((a, b) => expires(b) - expires(a));
}

/** A list from the events service as a table of its own fields, or what it came to when it is empty or unreadable. */
function ListTable({
  caption,
  columns,
  value,
  empty,
  arrange = (rows) => rows,
  limit,
}: {
  caption: string;
  columns: readonly Column[];
  value: unknown;
  empty: string;
  arrange?: (rows: Row[]) => Row[];
  limit?: number;
}) {
  if (!Array.isArray(value)) {
    return (
      <p role="alert" className={`${INSET} text-danger`}>
        The list could not be read.
      </p>
    );
  }
  const rows = arrange(value.filter(isRecord));
  if (rows.length === 0) return <EmptyState title={empty} />;
  const shown = limit === undefined ? rows : rows.slice(0, limit);
  return (
    <>
      {/* Wider than the panel with long ids and times: it scrolls sideways on its own, never the page. */}
      <TableScrollRegion aria-label={`${caption} table`}>
        {/* Each row stays on one line, the region scrolling, rather than a column of ids wrapping into a tall row. */}
        <Table.Root className="min-w-max">
          <Table.Caption className="sr-only">{caption}</Table.Caption>
          <Table.Header>
            <Table.Row>
              {columns.map((column) => (
                <Table.Head key={column.label} numeric={column.numeric ?? false}>
                  {column.label}
                </Table.Head>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shown.map((row, index) => (
              // Rows have no id of their own across both lists; their place in this read is what keys them.
              // biome-ignore lint/suspicious/noArrayIndexKey: a read's rows are replaced whole, never reordered in place
              <Table.Row key={index}>
                {columns.map((column) => (
                  <Table.Cell key={column.label} numeric={column.numeric ?? false}>
                    {column.literal === true ? <span className="font-mono">{column.show(row)}</span> : column.show(row)}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </TableScrollRegion>
      {shown.length < rows.length ? (
        <p className={`${INSET} flex items-center gap-(--cue-space-2) text-fg-muted`}>
          <span>
            The {shown.length} most recent of {rows.length}.
          </span>
          <InfoTip text={EVENTS_COPY.everyOne} label={EVENTS_COPY.everyOneLabel} />
        </p>
      ) : null}
    </>
  );
}

/** The screen's own words beside the event service's and the judges' (below): its tabs, and the hints it moved. */
export const EVENTS_COPY = {
  tabs: { service: 'Service', judges: 'Judges', rules: 'Rules', deliveries: 'Deliveries' },
  toLookAt: 'to look at',
  everyOne: 'The events CLI and MCP list every one.',
  everyOneLabel: 'Where every one is listed',
} as const;

/** A fact about the status: what it is, then what it says, at the far end, as Overview's rows say theirs. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <Line>
      <span className="text-fg-muted">{name}</span>
      <span className="ml-auto text-right text-fg">{children}</span>
    </Line>
  );
}

/** The status, as words: whether the service runs, and whether it collects. */
function StatusView({ value }: { value: unknown }) {
  if (!isRecord(value) || typeof value.owner !== 'string') {
    return (
      <p role="alert" className={`${INSET} text-danger`}>
        The status could not be read.
      </p>
    );
  }
  const status = value as unknown as EventsStatus;
  const running = status.owner === 'running';
  const collecting = status.enabled === true ? (status.paused === true ? 'paused' : 'on') : 'off';
  return (
    <>
      <Fact name="Service">{running ? 'running' : 'not running'}</Fact>
      {running ? <Fact name="Collecting">{collecting}</Fact> : null}
    </>
  );
}

/** The status, polled with the shared data, and Pause and Resume, which apply at once. */
function Status() {
  const { events, refresh } = useAppData();
  const { run } = useChange();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ChangeOutcome, { state: 'failed' }> | null>(null);
  const status = events !== 'absent' && events.state === 'ready' && isRecord(events.value) ? events.value : null;
  const running = status?.owner === 'running';
  const paused = status?.paused === true;

  const act = async (call: Call) => {
    setBusy(true);
    setFailure(null);
    const result = await run(call);
    if (result.state === 'failed') setFailure(result);
    await refresh('events');
    setBusy(false);
  };

  return (
    <section aria-label="Status">
      <SectionHeader
        label="Status"
        action={
          <>
            <Button size="sm" disabled={busy || !running || paused} onClick={() => void act({ kind: 'eventsPause' })}>
              Pause
            </Button>
            <Button size="sm" disabled={busy || !running || !paused} onClick={() => void act({ kind: 'eventsResume' })}>
              Resume
            </Button>
          </>
        }
      >
        <Panel>
          {events === 'absent' ? null : <InPanel value={events}>{(value) => <StatusView value={value} />}</InPanel>}
          {failure === null ? null : (
            <div role="alert" className={`${INSET} flex flex-col gap-(--cue-space-1)`}>
              <p className="text-danger">
                <UntrustedText text={failure.message} />
              </p>
              {failure.hint === null ? null : (
                <p className="text-fg-muted">
                  <UntrustedText text={failure.hint} />
                </p>
              )}
            </div>
          )}
        </Panel>
      </SectionHeader>
    </section>
  );
}

/*
 * The event service the app runs (design D2, D4, D5, D6). Its supervisor, in Rust, starts, adopts, restarts and stops
 * it; this section shows what the supervisor says, and asks it. The switch, Try again and Restart to use it are the
 * supervisor's commands: nothing here approves anything, and nothing reads the event database.
 */

const SERVICE_TITLE = 'Event service';

/** The section's words, as the plan's Global Constraints give them. */
export const SERVICE_COPY = {
  switch: 'Run the event service',
  starting: 'Starting the event service…',
  stopping: 'Stopping the event service…',
  windows: "The event service doesn't run on Windows yet.",
  restarted: 'Restarted',
  stoppedFromOutside: 'Stopped from outside at',
  gaveUp: 'The event service stopped 5 times in 10 minutes, so Agent Comms stopped restarting it.',
  tryAgain: 'Try again',
  restartToUse: 'Restart to use it',
  fullDiskAccess: 'Events from WhatsApp need Full Disk Access for Agent Comms.',
  openSystemSettings: 'Open System Settings',
} as const;

/** `A newer event service is installed (<version>).` */
export function newerServiceLine(version: string): string {
  return `A newer event service is installed (${version}).`;
}

/** Where the service stands, in a word. Giving up is said in full beneath it; starting and stopping, by a spinner. */
const SERVICE_WORDS: Readonly<Record<EventServiceStatus, string>> = {
  unavailable: 'Not available',
  stopped: 'Stopped',
  starting: SERVICE_COPY.starting,
  running: 'Running',
  stopping: SERVICE_COPY.stopping,
  gaveUp: 'Stopped',
};

/** The states that are on their way to another, shown with a spinner beside their words. */
const UNDER_WAY: ReadonlySet<EventServiceStatus> = new Set(['starting', 'stopping']);

/** Asks the supervisor something; what it answers with is the state shown next. */
type Ask = (command: () => Promise<EventServiceState | null>) => Promise<void>;

/** A dot in a well's tone, beside its line: the tint and the dot say the tone, the line stays in the page's ink. */
function ToneDot({ tone }: { tone: 'warn' | 'danger' }) {
  return (
    <span
      aria-hidden="true"
      className={`size-(--cue-space-2) shrink-0 rounded-full ${tone === 'warn' ? 'bg-warn' : 'bg-danger'}`}
    />
  );
}

/** A line, and the one button that acts on it, on a well tinted by what the line is: news, or a caution. */
function Offer({ line, tone, action }: { line: string; tone: 'fg' | 'warn'; action: ReactNode }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-(--cue-space-3) rounded-control px-(--cue-space-3) py-(--cue-space-2) ${tone === 'warn' ? 'bg-(color:--cue-warn-soft)' : 'bg-surface-2'}`}
    >
      {tone === 'warn' ? <ToneDot tone="warn" /> : null}
      <p className="min-w-0 flex-1 text-fg">{line}</p>
      {action}
    </div>
  );
}

/**
 * What the supervisor says of where the service stands, as one quiet line of facts beneath the switch: its state, since
 * when, its version, who started it, its last restart and a stop from outside. Each is said only when it is true.
 */
function ServiceFacts({ state }: { state: EventServiceState }) {
  const running = state.status === 'running';
  const facts: { key: string; fact: ReactNode }[] = [
    {
      key: 'status',
      fact: UNDER_WAY.has(state.status) ? (
        <span className="flex items-center gap-(--cue-space-2)">
          {/* The spinner says it to a screen reader; the words beside it are for the eye, so it is said once. */}
          <Spinner size="sm" label={SERVICE_WORDS[state.status]} />
          <span className="text-fg" aria-hidden="true">
            {SERVICE_WORDS[state.status]}
          </span>
        </span>
      ) : (
        <span className="text-fg">{SERVICE_WORDS[state.status]}</span>
      ),
    },
  ];
  if (running && state.since !== null) {
    facts.push({
      key: 'since',
      fact: (
        <span>
          since <When at={state.since} />
        </span>
      ),
    });
  }
  if (running && state.version !== null) {
    facts.push({
      key: 'version',
      fact: (
        <span>
          Version <span className="text-fg tabular-nums">{state.version}</span>
        </span>
      ),
    });
  }
  if (running && state.startedBy === 'terminal')
    facts.push({ key: 'terminal', fact: <span>Started from a terminal</span> });
  if (state.lastRestartAt !== null) {
    facts.push({
      key: 'restarted',
      fact: (
        <span>
          {SERVICE_COPY.restarted} <Ago at={state.lastRestartAt} />
        </span>
      ),
    });
  }
  if (state.stoppedFromOutsideAt !== null) {
    facts.push({
      key: 'outside',
      fact: (
        <span>
          {SERVICE_COPY.stoppedFromOutside} <When at={state.stoppedFromOutsideAt} />
        </span>
      ),
    });
  }
  return (
    <div className="flex flex-wrap items-center gap-x-(--cue-space-2) gap-y-(--cue-space-1) text-(length:--cue-text-ui) text-fg-muted">
      {facts.map(({ key, fact }, index) => (
        <Fragment key={key}>
          {index === 0 ? null : <span aria-hidden="true">·</span>}
          {fact}
        </Fragment>
      ))}
    </div>
  );
}

/** The state, as its supervisor sent it: the switch, where it stands, and what it offers. */
function ServiceView({ state, busy, ask }: { state: EventServiceState; busy: boolean; ask: Ask }) {
  const bridge = useBridge();
  const labelId = useId();
  if (!state.available) return <p className="text-fg-muted">{SERVICE_COPY.windows}</p>;
  const running = state.status === 'running';
  return (
    <>
      <div className="flex items-center gap-(--cue-space-4)">
        <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
          <span id={labelId} className="font-medium text-fg">
            {SERVICE_COPY.switch}
          </span>
          <ServiceFacts state={state} />
        </div>
        <Switch
          aria-labelledby={labelId}
          size="lg"
          checked={state.wanted}
          disabled={busy}
          onCheckedChange={(on) => void ask(() => bridge.setEventService(on))}
        />
      </div>
      {state.status === 'gaveUp' ? (
        <div
          role="alert"
          className="flex flex-col gap-(--cue-space-3) rounded-control bg-(color:--cue-danger-soft) px-(--cue-space-3) py-(--cue-space-3)"
        >
          <div className="flex flex-wrap items-center gap-(--cue-space-3)">
            <ToneDot tone="danger" />
            <p className="min-w-0 flex-1 text-fg">{SERVICE_COPY.gaveUp}</p>
            <Button size="sm" disabled={busy} onClick={() => void ask(() => bridge.eventServiceRetry())}>
              {SERVICE_COPY.tryAgain}
            </Button>
          </div>
          {state.logTail.length === 0 ? null : (
            <div className="flex flex-col rounded-control bg-sunken p-(--cue-space-3) font-mono text-(length:--cue-text-ui) text-fg-muted">
              {state.logTail.map((line, index) => (
                // The lines come in the log's order and are replaced whole; their place is what tells two apart.
                // biome-ignore lint/suspicious/noArrayIndexKey: a state's lines are never reordered in place
                <div key={index}>
                  <UntrustedText text={line} />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {running && state.newerVersion !== null ? (
        <Offer
          line={newerServiceLine(state.newerVersion)}
          tone="fg"
          action={
            <Button size="sm" disabled={busy} onClick={() => void ask(() => bridge.restartEventService())}>
              {SERVICE_COPY.restartToUse}
            </Button>
          }
        />
      ) : null}
      {/* Wanted, and stopped: one started from a terminal went away, and is not the app's to restart (D4). */}
      {state.wanted && state.status === 'stopped' && !state.firstStartQuestion ? (
        <div>
          <Button size="sm" disabled={busy} onClick={() => void ask(() => bridge.setEventService(true))}>
            Start
          </Button>
        </div>
      ) : null}
      {state.fullDiskAccess === 'missing' ? (
        <Offer
          line={SERVICE_COPY.fullDiskAccess}
          tone="warn"
          action={
            <Button
              size="sm"
              onClick={() =>
                void ask(async () => {
                  await bridge.openFullDiskAccess();
                  return null;
                })
              }
            >
              {SERVICE_COPY.openSystemSettings}
            </Button>
          }
        />
      ) : null}
    </>
  );
}

/**
 * The event service's section: what its supervisor last said, read once and then sent on each change (`data.tsx`),
 * and what each command answered with. A command that fails says why, and the state stays as the supervisor last said:
 * the first-start question's answer too, since that question has closed by then (`EventServiceQuestions.tsx`).
 */
function Service() {
  const {
    eventService,
    showEventService,
    eventServiceProblem: problem,
    showEventServiceProblem: setProblem,
  } = useAppData();
  const [busy, setBusy] = useState(false);

  const ask: Ask = async (command) => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await command();
      if (next !== null) showEventService(next);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (eventService === 'absent') return null;
  // Its region is named by the section, not a heading: the Service tab and the switch's own words already say what it is.
  return (
    <section aria-label={SERVICE_TITLE}>
      <Panel>
        <div className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
          <ScreenState value={eventService}>
            {(state) => <ServiceView state={state} busy={busy} ask={ask} />}
          </ScreenState>
          {problem === null ? null : (
            <p role="alert" className="text-danger">
              <UntrustedText text={problem} />
            </p>
          )}
        </div>
      </Panel>
    </section>
  );
}

/**
 * What the Service tab holds that waits on the person, so its badge says it while another tab is open: a service the
 * app gave up restarting, a newer version to restart onto, and Full Disk Access to give. Each as the section shows it.
 */
function serviceAttention(eventService: Loadable<EventServiceState> | 'absent'): number {
  if (eventService === 'absent' || eventService.state !== 'ready' || !eventService.value.available) return 0;
  const state = eventService.value;
  return [
    state.status === 'gaveUp',
    state.status === 'running' && state.newerVersion !== null,
    state.fullDiskAccess === 'missing',
  ].filter(Boolean).length;
}

const RULES: Call = { kind: 'eventsRules' };
const DELIVERIES: Call = { kind: 'eventsDeliveries' };

/** How many rules a read lists: each rule once, whatever its versions; nothing when it is not a list. */
function ruleCount(result: Loadable<unknown>): number | null {
  if (result.state !== 'ready' || !Array.isArray(result.value)) return null;
  const ids = result.value.filter(isRecord).map((row) => row.rule_id);
  return new Set(ids.filter((id) => typeof id === 'string')).size;
}

/** How many deliveries a read lists, every one of them and not only those shown; nothing when it is not a list. */
function deliveryCount(result: Loadable<unknown>): number | null {
  if (result.state !== 'ready' || !Array.isArray(result.value)) return null;
  return result.value.filter(isRecord).length;
}

/** The rules: read when the screen opens, and again when the service starts or stops running, since they come from it. */
function Rules({ result }: { result: Loadable<unknown> }) {
  return (
    <section aria-label="Rules">
      <Panel>
        <InPanel value={result}>
          {(value) => <ListTable caption="Rules" columns={RULE_COLUMNS} value={value} empty="No rules yet." />}
        </InPanel>
      </Panel>
    </section>
  );
}

/** The recent deliveries, read as the rules are. */
function Deliveries({ result }: { result: Loadable<unknown> }) {
  return (
    <section aria-label="Recent deliveries">
      <Panel>
        <InPanel value={result}>
          {(value) => (
            <ListTable
              caption="Recent deliveries"
              columns={DELIVERY_COLUMNS}
              value={value}
              empty="No deliveries yet."
              arrange={recentFirst}
              limit={DELIVERIES_SHOWN}
            />
          )}
        </InPanel>
      </Panel>
    </section>
  );
}

/*
 * The Judges section (0.27.1): every judge kind the events service has — TypeSafe's hosted Jev, Laya and a model server
 * on this machine — read from its `judge kinds list` and `judges list`, each with its name, where messages go, its state
 * and its judges. A kind that is off turns on in the terminal, with `judge kind enable <kind>`, where the daemon's
 * preview and the person's approval happen: the app prepares nothing and never approves (DA10). One that is on turns
 * off at once, a tightening, once its dialog is answered. Adding a judge, its key and a model stays in the CLI and MCP.
 * Nothing is read until the events service's own version is one with judges (DA12).
 */

/** The section's words, as the lead gave them. */
export const JUDGES_COPY = {
  title: 'Judges',
  kinds: {
    typesafe: {
      name: 'Jev, by TypeSafe',
      where: 'A hosted judge. The fields a rule names are sent to TypeSafe, with your TypeSafe API key.',
    },
    laya: { name: 'Laya', where: 'A judge that runs on this Mac. Nothing leaves it.' },
    'local-endpoint': {
      name: 'A local model server',
      where: 'A model server you run on this machine, at 127.0.0.1 or ::1. Nothing leaves this machine.',
    },
  },
  off: 'Off',
  on: 'On',
  unavailable: 'Unavailable',
  notOffered: 'Not offered in this release yet.',
  turnOnInTerminal: 'Turn on in Terminal',
  turnOff: 'Turn off',
  turnOffBody:
    "Decisions waiting on its judges are cancelled, and its rules can't call it until it is turned on again.",
  next: 'Next: add a judge and its key at the terminal.',
  nextLocal: 'Next: add a judge at the terminal.',
  howToSetUp: 'How to set it up',
  inTerminal: 'Its preview and its approval are in the terminal.',
  unreadableKinds: 'The judge kinds could not be read.',
  unreadableKind: 'Its state could not be read.',
  unreadableJudges: 'The judges could not be read.',
} as const;

/** `Turn off <name>?` */
export function turnOffTitle(name: string): string {
  return `Turn off ${name}?`;
}

/**
 * The events service's README at its Judges section: where "How to set it up" goes, through `open_link`, which opens
 * exactly this URL beside the pages doctor fixes name (`links.rs`, `JUDGES_HELP`).
 */
export const JUDGES_HELP =
  'https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges';

const EVENTS_VERSION: Call = { kind: 'version', product: 'events-daemon' };
const JUDGE_KINDS: Call = { kind: 'judgeKindsList' };
const JUDGES: Call = { kind: 'judgesList' };

/*
 * Laya, the events service's local judge (E2 Task 11, desktop design DA16), now the Judges section's Laya row. Its
 * status is the daemon's own `judge model status`, read field by field as laya-model-status-v1 has it: the app shows its
 * state, bytes and stable codes as plain text, and adds no state, estimate or reason of its own. Turn on in Terminal
 * opens the terminal with `judge kind enable laya`; Turn off applies at once, a tightening. Removing the model files
 * stays in the CLI and MCP. Its status is not read until the events service's own version is one that has these calls.
 */

const LAYA_STATUS: Call = { kind: 'eventsJudgeModelStatus' };

const LAYA_STATES = ['idle', 'installing', 'downloading', 'verifying', 'ready', 'failed', 'unavailable'] as const;
const LAYA_FAILURES = ['boundary-failed', 'download-failed', 'integrity', 'runtime-failed'] as const;
const LAYA_REASONS = [
  'E2_EXTERNAL_REFERENCE_BLOCKED',
  'LAYA_PLATFORM_UNAVAILABLE',
  'LAYA_SANDBOX_UNAVAILABLE',
] as const;
const LAYA_FIELDS = [
  'state',
  'manifestId',
  'runtimeLockDigest',
  'bytesVerified',
  'totalBytes',
  'failureCode',
  'reason',
  'updatedAt',
] as const;

type LayaState = (typeof LAYA_STATES)[number];
type LayaFailure = (typeof LAYA_FAILURES)[number];
type LayaReason = (typeof LAYA_REASONS)[number];

/** `judge model status`, as the daemon answers it. */
interface LayaStatus {
  state: LayaState;
  manifestId: string | null;
  runtimeLockDigest: string | null;
  bytesVerified: number;
  totalBytes: number;
  failureCode: LayaFailure | null;
  reason: LayaReason | null;
  updatedAt: number | null;
}

/** What the answer is: a status, B3's placeholder from an events service before E2, or nothing the app can read. */
type LayaRead = { kind: 'status'; status: LayaStatus } | { kind: 'beforeE2' } | { kind: 'unreadable' };

const UNREADABLE: LayaRead = { kind: 'unreadable' };

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Reads the answer as laya-model-status-v1 has it, and refuses anything else rather than guess at it: exactly its
 * eight fields, each closed, and its coupling of state, failure code and reason. B3's typed `E2_REQUIRED` placeholder
 * is an events service from before E2, whatever version it says it is.
 */
function readLaya(value: unknown): LayaRead {
  if (!isRecord(value)) return UNREADABLE;
  const keys = Object.keys(value);
  if (keys.length === 3 && value.kind === 'unavailable' && value.code === 'E2_REQUIRED' && value.phase === 'E2') {
    return { kind: 'beforeE2' };
  }
  if (keys.length !== LAYA_FIELDS.length || !LAYA_FIELDS.every((key) => Object.hasOwn(value, key))) return UNREADABLE;
  const { state, manifestId, runtimeLockDigest, bytesVerified, totalBytes, failureCode, reason, updatedAt } = value;
  if (!oneOf(LAYA_STATES, state)) return UNREADABLE;
  if (manifestId !== null && !(typeof manifestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifestId)))
    return UNREADABLE;
  if (
    runtimeLockDigest !== null &&
    !(typeof runtimeLockDigest === 'string' && /^[a-f0-9]{64}$/.test(runtimeLockDigest))
  )
    return UNREADABLE;
  if (!isCount(bytesVerified) || !isCount(totalBytes)) return UNREADABLE;
  if (updatedAt !== null && !isCount(updatedAt)) return UNREADABLE;
  if (failureCode !== null && !oneOf(LAYA_FAILURES, failureCode)) return UNREADABLE;
  if (reason !== null && !oneOf(LAYA_REASONS, reason)) return UNREADABLE;
  const coupled =
    state === 'unavailable'
      ? failureCode === null && reason !== null
      : state === 'failed'
        ? failureCode !== null &&
          (reason === null || (failureCode === 'boundary-failed' && reason !== 'E2_EXTERNAL_REFERENCE_BLOCKED'))
        : failureCode === null && reason === null;
  if (!coupled) return UNREADABLE;
  return {
    kind: 'status',
    status: {
      state,
      manifestId: manifestId as string | null,
      runtimeLockDigest: runtimeLockDigest as string | null,
      bytesVerified,
      totalBytes,
      failureCode: failureCode as LayaFailure | null,
      reason: reason as LayaReason | null,
      updatedAt: updatedAt as number | null,
    },
  };
}

/** The one button a state allows: Enable for a disabled kind, Disable for an enabled one, neither when unavailable. */
function actionFor(state: LayaState): 'enable' | 'disable' | null {
  switch (state) {
    case 'idle':
      return 'enable';
    case 'installing':
    case 'downloading':
    case 'verifying':
    case 'ready':
    case 'failed':
      return 'disable';
    case 'unavailable':
      return null;
  }
}

/** The states whose bytes are still moving: the screen's poll reads the status again while it is in one. */
const IN_PROGRESS: ReadonlySet<LayaState> = new Set(['installing', 'downloading', 'verifying']);

/** What each closed failure code means, beside the code itself. */
const FAILURE_LINES: Readonly<Record<LayaFailure, string>> = {
  'boundary-failed': 'Its network boundary could not be proven, so it does not run.',
  'download-failed': 'Its model could not be downloaded.',
  integrity: 'Its files no longer match the reviewed ones.',
  'runtime-failed': 'Its runtime could not be installed, or would not load, crashed or ran out of time while loading.',
};

/** What each closed reason means, beside the reason itself. */
const REASON_LINES: Readonly<Record<LayaReason, string>> = {
  E2_EXTERNAL_REFERENCE_BLOCKED: "Laya isn't offered in this release.",
  LAYA_PLATFORM_UNAVAILABLE: "Laya isn't offered on this computer.",
  LAYA_SANDBOX_UNAVAILABLE: "macOS's sandbox can't be used here.",
};

/** A closed code, then what it means. */
function Code({ code, line }: { code: string; line: string }) {
  return (
    <span className="flex flex-col gap-(--cue-space-1)">
      <span className="font-mono">{code}</span>
      <span className="text-fg-muted">{line}</span>
    </span>
  );
}

/** The status, as words: the daemon's state, bytes and codes, and nothing the app made up. */
function LayaView({ read }: { read: LayaRead }) {
  if (read.kind === 'unreadable') {
    return (
      <p role="alert" className="text-danger">
        Laya's status could not be read.
      </p>
    );
  }
  if (read.kind === 'beforeE2') {
    return (
      <div className="flex flex-col gap-(--cue-space-1)">
        <p className="text-fg">{COPY.updateToUse}</p>
        <p className="text-fg-muted">This events service is from before Laya.</p>
      </div>
    );
  }
  const { status } = read;
  return (
    <DescriptionList.Root>
      <DescriptionList.Term>State</DescriptionList.Term>
      <DescriptionList.Detail>{status.state}</DescriptionList.Detail>
      {status.manifestId === null ? null : (
        <>
          <DescriptionList.Term>Model</DescriptionList.Term>
          <DescriptionList.Detail>
            <span className="font-mono">
              <UntrustedText text={status.manifestId} />
            </span>
          </DescriptionList.Detail>
        </>
      )}
      {status.totalBytes === 0 ? null : (
        <>
          <DescriptionList.Term>Verified</DescriptionList.Term>
          <DescriptionList.Detail>{`${status.bytesVerified} of ${status.totalBytes} bytes`}</DescriptionList.Detail>
        </>
      )}
      {status.failureCode === null ? null : (
        <>
          <DescriptionList.Term>Failure</DescriptionList.Term>
          <DescriptionList.Detail>
            <Code code={status.failureCode} line={FAILURE_LINES[status.failureCode]} />
          </DescriptionList.Detail>
        </>
      )}
      {status.reason === null ? null : (
        <>
          <DescriptionList.Term>Reason</DescriptionList.Term>
          <DescriptionList.Detail>
            <Code code={status.reason} line={REASON_LINES[status.reason]} />
          </DescriptionList.Detail>
        </>
      )}
      {status.updatedAt === null ? null : (
        <>
          <DescriptionList.Term>Updated</DescriptionList.Term>
          <DescriptionList.Detail>
            <When at={status.updatedAt} />
          </DescriptionList.Detail>
        </>
      )}
    </DescriptionList.Root>
  );
}

/** What went wrong with a row's last action, as the CLI or the app said it. */
interface Problem {
  message: string;
  hint: string | null;
}

/** A row's last action: where the terminal opened, or what went wrong. */
function ActionOutcome({ opened, problem }: { opened: TerminalOutcome | null; problem: Problem | null }) {
  return (
    <>
      {opened === null ? null : (
        <div className="flex flex-col gap-(--cue-space-1)">
          <TerminalResult outcome={opened} />
          <p className="text-fg-muted">{JUDGES_COPY.inTerminal}</p>
        </div>
      )}
      {problem === null ? null : (
        <div role="alert" className="flex flex-col gap-(--cue-space-1)">
          <p className="text-danger">
            <UntrustedText text={problem.message} />
          </p>
          {problem.hint === null ? null : (
            <p className="text-fg-muted">
              <UntrustedText text={problem.hint} />
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** The judge kinds, in the order the events service lists them. */
const KIND_NAMES = ['typesafe', 'laya', 'local-endpoint'] as const;
type KindName = (typeof KIND_NAMES)[number];

/** The codes an unavailable Laya carries in `judge kinds list`: B3's `E2_REQUIRED` before E2, then E2's own. */
const KIND_CODES = ['E2_REQUIRED', ...LAYA_REASONS] as const;
type KindCode = (typeof KIND_CODES)[number];

/** The codes that mean no release offers Laya yet, rather than that this machine cannot run it. */
const NOT_OFFERED_CODES: ReadonlySet<KindCode> = new Set(['E2_REQUIRED', 'E2_EXTERNAL_REFERENCE_BLOCKED']);

/** One kind's entry of `judge kinds list`, as the app reads it, or what it could not read. */
type KindRead =
  | { state: 'off' }
  | { state: 'on'; version: number }
  | { state: 'unavailable'; code: KindCode }
  | { state: 'unreadable' };

const UNREADABLE_KIND: KindRead = { state: 'unreadable' };

const isPositive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

/**
 * One kind's entry, read as b3-control-v2's `judgeKindEntry` has it, and refused rather than guessed at: exactly
 * `kind`, `state` and `version`, disabled with none or enabled with one; or, for Laya alone, exactly `kind`, `state` and
 * `code`, unavailable with one of its closed codes.
 */
function readKind(value: Row, kind: KindName): KindRead {
  const keys = Object.keys(value).sort().join(',');
  if (keys === 'kind,state,version') {
    if (value.state === 'disabled' && value.version === null) return { state: 'off' };
    if (value.state === 'enabled' && isPositive(value.version)) return { state: 'on', version: value.version };
    return UNREADABLE_KIND;
  }
  if (kind === 'laya' && keys === 'code,kind,state' && value.state === 'unavailable' && oneOf(KIND_CODES, value.code)) {
    return { state: 'unavailable', code: value.code };
  }
  return UNREADABLE_KIND;
}

/** `judge kinds list`: each kind read from its one entry, or `null` when the answer is not a list at all. */
function readKinds(value: unknown): Record<KindName, KindRead> | null {
  if (!Array.isArray(value)) return null;
  const read = (kind: KindName): KindRead => {
    const entries = value.filter((entry) => isRecord(entry) && entry.kind === kind);
    return entries.length === 1 && isRecord(entries[0]) ? readKind(entries[0], kind) : UNREADABLE_KIND;
  };
  return { typesafe: read('typesafe'), laya: read('laya'), 'local-endpoint': read('local-endpoint') };
}

/** One entry of `judges list`: content-free metadata, the person's own ids and names shown as text. */
interface Judge {
  judgeId: string;
  version: number;
  kind: KindName;
  provider: string;
  model: string;
  revokedAt: number | null;
}

const JUDGE_FIELDS = ['judgeId', 'version', 'kind', 'provider', 'model', 'revokedAt'] as const;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** `judges list`, as b3-control-v3's inventory has it, or `null` when any of it is not: then nothing is claimed. */
function readJudges(value: unknown): Judge[] | null {
  if (!Array.isArray(value)) return null;
  const judges: Judge[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (Object.keys(entry).length !== JUDGE_FIELDS.length || !JUDGE_FIELDS.every((key) => Object.hasOwn(entry, key)))
      return null;
    const { judgeId, version, kind, provider, model, revokedAt } = entry;
    if (!isText(judgeId) || !isPositive(version) || !oneOf(KIND_NAMES, kind) || !isText(provider) || !isText(model))
      return null;
    if (revokedAt !== null && !isCount(revokedAt)) return null;
    judges.push({ judgeId, version, kind, provider, model, revokedAt });
  }
  return judges;
}

/** A kind's state in a word, and the tone it is said in. */
const KIND_WORDS = { off: JUDGES_COPY.off, on: JUDGES_COPY.on, unavailable: JUDGES_COPY.unavailable } as const;
const KIND_TONES = { off: 'neutral', on: 'ok', unavailable: 'info' } as const;

/** A kind's state: Off, On, or Unavailable with its code as plain text, unless the row says that code already. */
function KindState({ read, code }: { read: KindRead; code: boolean }) {
  if (read.state === 'unreadable') return null;
  return (
    <span className="flex items-center gap-(--cue-space-2)">
      <Chip tone={KIND_TONES[read.state]} variant="tag">
        {KIND_WORDS[read.state]}
      </Chip>
      {read.state === 'unavailable' && code ? <span className="font-mono text-fg-muted">{read.code}</span> : null}
    </span>
  );
}

/** One kind: its name, where messages go, its state and its one action, then what more it has to say. */
function KindRow({
  kind,
  state,
  action,
  children,
}: {
  kind: KindName;
  state: ReactNode;
  action: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  const { name, where } = JUDGES_COPY.kinds[kind];
  return (
    <section aria-labelledby={id}>
      <Line className="items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-2)">
          <div className="flex flex-col gap-(--cue-space-1)">
            <span id={id} className="text-(length:--cue-text-body) font-medium text-fg">
              {name}
            </span>
            <span className="text-fg-muted">{where}</span>
          </div>
          {children}
        </div>
        <div className="flex shrink-0 items-center gap-(--cue-space-3)">
          {state}
          {action}
        </div>
      </Line>
    </section>
  );
}

/**
 * Turn off, which asks first (cue-ui's AlertDialog): only its own Turn off runs `confirm`, and Cancel, Escape or
 * closing it runs nothing.
 */
function TurnOff({ name, disabled, confirm }: { name: string; disabled: boolean; confirm: () => void }) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        render={
          <Button size="sm" disabled={disabled}>
            {JUDGES_COPY.turnOff}
          </Button>
        }
      />
      <AlertDialog.Content>
        <AlertDialog.Title>{turnOffTitle(name)}</AlertDialog.Title>
        <AlertDialog.Description>{JUDGES_COPY.turnOffBody}</AlertDialog.Description>
        <AlertDialog.Footer>
          <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
          <AlertDialog.Action tone="danger" onClick={confirm}>
            {JUDGES_COPY.turnOff}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/**
 * A kind's judges, each its id, version and model; a removed one is none. A kind that is on with none says what is next,
 * with a link to how to set one up. `judges` is `null` while the list is not read: then nothing is claimed.
 */
function KindJudges({ kind, on, judges }: { kind: KindName; on: boolean; judges: Judge[] | null }) {
  const bridge = useBridge();
  const [problem, setProblem] = useState<string | null>(null);
  if (judges === null) return null;
  const { name } = JUDGES_COPY.kinds[kind];
  const live = judges.filter((judge) => judge.kind === kind && judge.revokedAt === null);
  return (
    <>
      {live.length === 0 ? null : (
        <Table.Root>
          <Table.Caption className="sr-only">{`${name} judges`}</Table.Caption>
          <Table.Header>
            <Table.Row>
              <Table.Head>Judge</Table.Head>
              <Table.Head numeric>Version</Table.Head>
              <Table.Head>Model</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {live.map((judge) => (
              <Table.Row key={JSON.stringify([judge.judgeId, judge.version])}>
                <Table.Cell>
                  <span className="font-mono">
                    <UntrustedText text={judge.judgeId} />
                  </span>
                </Table.Cell>
                <Table.Cell numeric>{String(judge.version)}</Table.Cell>
                <Table.Cell>
                  <span className="font-mono">
                    <UntrustedText text={judge.model} />
                  </span>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
      {on && live.length === 0 ? (
        <p className="text-fg-muted">
          <span>{kind === 'typesafe' ? JUDGES_COPY.next : JUDGES_COPY.nextLocal}</span>{' '}
          <Link
            href={JUDGES_HELP}
            external
            onClick={(event) => {
              // The window never leaves the app: the link opens in the browser, through `open_link`.
              event.preventDefault();
              setProblem(null);
              bridge.openLink(JUDGES_HELP).catch((error: unknown) => setProblem(errorMessage(error)));
            }}
          >
            {JUDGES_COPY.howToSetUp}
          </Link>
        </p>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-danger">
          <UntrustedText text={problem} />
        </p>
      )}
    </>
  );
}

/**
 * Jev, or a local model server: a kind whose judges name an endpoint. Off offers Turn on in Terminal, which opens the
 * terminal with `judge kind enable <kind>`; On offers Turn off, which applies at once once its dialog is answered, and
 * reads the kinds again.
 */
function EndpointKind({
  kind,
  read,
  judges,
  reloadKinds,
}: {
  kind: EndpointJudgeKind;
  read: KindRead;
  judges: Judge[] | null;
  reloadKinds: () => Promise<void>;
}) {
  const bridge = useBridge();
  const { run } = useChange();
  const { name } = JUDGES_COPY.kinds[kind];
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<TerminalOutcome | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const turnOn = async () => {
    setBusy(true);
    setProblem(null);
    setOpened(null);
    try {
      setOpened(await bridge.openInTerminal({ kind: 'judgeKindEnable', judgeKind: kind }));
    } catch (error) {
      setProblem({ message: errorMessage(error), hint: null });
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setProblem(null);
    setOpened(null);
    const outcome = await run({ kind: 'judgeKindDisable', judgeKind: kind });
    if (outcome.state === 'failed') setProblem({ message: outcome.message, hint: outcome.hint });
    if (outcome.state === 'needsTerminal') setProblem({ message: `${name} was not turned off.`, hint: null });
    await reloadKinds();
    setBusy(false);
  };

  return (
    <KindRow
      kind={kind}
      state={<KindState read={read} code />}
      action={
        read.state === 'off' ? (
          <Button size="sm" disabled={busy} onClick={() => void turnOn()}>
            {JUDGES_COPY.turnOnInTerminal}
          </Button>
        ) : read.state === 'on' ? (
          <TurnOff name={name} disabled={busy} confirm={() => void turnOff()} />
        ) : null
      }
    >
      {read.state === 'unreadable' ? <p className="text-danger">{JUDGES_COPY.unreadableKind}</p> : null}
      <KindJudges kind={kind} on={read.state === 'on'} judges={judges} />
      <ActionOutcome opened={opened} problem={problem} />
    </KindRow>
  );
}

/**
 * Laya's row. Its Off, On or Unavailable is its entry of `judge kinds list`, and its details are its own status, read
 * once the events service's own version says it has Laya's calls (DA12); then again when the window comes back (the
 * person may have approved in the terminal), and with the screen's poll while its bytes are moving (DA14). Only the
 * latest-started read is kept (`useCall`, DA16). Its one action is its status's: Turn on in Terminal opens the
 * terminal; Turn off applies at once and reads the status again.
 */
function Laya({
  version,
  read: kindRead,
  judges,
  reloadKinds,
}: {
  version: Loadable<string>;
  read: KindRead;
  judges: Judge[] | null;
  reloadKinds: () => Promise<void>;
}) {
  const bridge = useBridge();
  const { events } = useAppData();
  const { run } = useChange();
  const supported = version.state === 'ready' && supports(version.value, 'layaJudge');
  const { result, reload } = useCall<unknown>(supported ? LAYA_STATUS : null);
  useReloadOnReturn(reload);
  useReloadOnServiceTurn(reload);
  const read = supported && result.state === 'ready' ? readLaya(result.value) : null;
  const status = read?.kind === 'status' ? read.status : null;
  const action = status === null ? null : actionFor(status.state);

  // Each read of the events service the screen's poll makes is Laya's cue too, while a download is in progress.
  const inProgress = useRef(false);
  useEffect(() => {
    inProgress.current = status !== null && IN_PROGRESS.has(status.state);
  });
  useEffect(() => {
    if (events !== 'absent' && inProgress.current) void reload();
  }, [events, reload]);

  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<TerminalOutcome | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const enable = async () => {
    setBusy(true);
    setProblem(null);
    setOpened(null);
    try {
      setOpened(await bridge.openInTerminal({ kind: 'eventsJudgeKindEnable' }));
    } catch (error) {
      setProblem({ message: errorMessage(error), hint: null });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setProblem(null);
    setOpened(null);
    const outcome = await run({ kind: 'eventsJudgeKindDisable' });
    if (outcome.state === 'failed') setProblem({ message: outcome.message, hint: outcome.hint });
    if (outcome.state === 'needsTerminal') setProblem({ message: 'Laya was not disabled.', hint: null });
    await reload();
    await reloadKinds();
    setBusy(false);
  };

  // Its code is said once: in its details' reason when they carry the same one, otherwise beside Unavailable.
  const codeShown = kindRead.state !== 'unavailable' || status?.reason !== kindRead.code;
  return (
    <KindRow
      kind="laya"
      state={<KindState read={kindRead} code={codeShown} />}
      action={
        action === 'enable' ? (
          <Button size="sm" disabled={busy} onClick={() => void enable()}>
            {JUDGES_COPY.turnOnInTerminal}
          </Button>
        ) : action === 'disable' ? (
          <TurnOff name={JUDGES_COPY.kinds.laya.name} disabled={busy} confirm={() => void disable()} />
        ) : null
      }
    >
      {kindRead.state === 'unreadable' ? <p className="text-danger">{JUDGES_COPY.unreadableKind}</p> : null}
      {/* Said once: when Laya's own details are shown, they already say it is not offered. */}
      {kindRead.state === 'unavailable' &&
      NOT_OFFERED_CODES.has(kindRead.code) &&
      !(supported && result.state === 'ready') ? (
        <p className="text-fg-muted">{JUDGES_COPY.notOffered}</p>
      ) : null}
      {supported ? (
        <ScreenState value={result}>{(value) => <LayaView read={readLaya(value)} />}</ScreenState>
      ) : (
        <ScreenState value={version}>
          {(installed) => (
            <div className="flex flex-col gap-(--cue-space-1)">
              <p className="text-fg">{COPY.updateToUse}</p>
              <p className="text-fg-muted">{needsLine(GATES.layaJudge, installed)}</p>
            </div>
          )}
        </ScreenState>
      )}
      <KindJudges kind="laya" on={kindRead.state === 'on'} judges={judges} />
      <ActionOutcome opened={opened} problem={problem} />
    </KindRow>
  );
}

/** The three rows, once `judge kinds list` is read; and what `judges list` came to, when it is not a list of judges. */
function KindRows({
  value,
  judges,
  version,
  reloadKinds,
}: {
  value: unknown;
  judges: Loadable<unknown>;
  version: Loadable<string>;
  reloadKinds: () => Promise<void>;
}) {
  const kinds = readKinds(value);
  if (kinds === null) {
    return (
      <p role="alert" className={`${INSET} text-danger`}>
        {JUDGES_COPY.unreadableKinds}
      </p>
    );
  }
  const listed = judges.state === 'ready' ? readJudges(judges.value) : null;
  return (
    <>
      <div className="flex flex-col divide-y divide-border">
        <EndpointKind kind="typesafe" read={kinds.typesafe} judges={listed} reloadKinds={reloadKinds} />
        <Laya version={version} read={kinds.laya} judges={listed} reloadKinds={reloadKinds} />
        <EndpointKind kind="local-endpoint" read={kinds['local-endpoint']} judges={listed} reloadKinds={reloadKinds} />
      </div>
      {judges.state === 'error' ? (
        <p role="alert" className={`${INSET} text-danger`}>
          <UntrustedText text={judges.message} />
        </p>
      ) : null}
      {judges.state === 'ready' && listed === null ? (
        <p role="alert" className={`${INSET} text-danger`}>
          {JUDGES_COPY.unreadableJudges}
        </p>
      ) : null}
    </>
  );
}

/** What the Judges section reads: the events service's version, then, once it has judges, its kinds and its judges. */
interface JudgeReads {
  version: Loadable<string>;
  hasJudges: boolean;
  kinds: Loadable<unknown>;
  judges: Loadable<unknown>;
  reloadKinds: () => Promise<void>;
}

/**
 * The Judges section's reads. Nothing is read until the events service's own `--version` says it has judges (DA12);
 * then its kinds and judges are read when the screen opens, and again when the window comes back, since the person may
 * have turned a kind on, or added a judge, at the terminal. Only the latest-started read of each is kept (`useCall`,
 * DA16). The screen holds them, so its Judges tab can say what waits there while another tab is open.
 */
function useJudgeReads(): JudgeReads {
  const { result: version } = useCall<string>(EVENTS_VERSION);
  const hasJudges = version.state === 'ready' && supports(version.value, 'judges');
  const { result: kinds, reload: reloadKinds } = useCall<unknown>(hasJudges ? JUDGE_KINDS : null);
  const { result: judges, reload: reloadJudges } = useCall<unknown>(hasJudges ? JUDGES : null);
  const reload = useCallback(async () => {
    await Promise.all([reloadKinds(), reloadJudges()]);
  }, [reloadKinds, reloadJudges]);
  useReloadOnReturn(reload);
  useReloadOnServiceTurn(reload);
  return { version, hasJudges, kinds, judges, reloadKinds };
}

/**
 * How many kinds are on with no judge: each is a row that says what is next, exactly as `KindJudges` decides it. Nothing
 * is counted while either list is unread or unreadable, since then the rows claim nothing either.
 */
function judgesWaiting({ hasJudges, kinds, judges }: JudgeReads): number {
  if (!hasJudges || kinds.state !== 'ready' || judges.state !== 'ready') return 0;
  const read = readKinds(kinds.value);
  const listed = readJudges(judges.value);
  if (read === null || listed === null) return 0;
  return KIND_NAMES.filter(
    (kind) => read[kind].state === 'on' && !listed.some((judge) => judge.kind === kind && judge.revokedAt === null),
  ).length;
}

/** The Judges section: its three kinds, once the events service has judges, or what it needs first. */
function Judges({ reads }: { reads: JudgeReads }) {
  const { version, hasJudges, kinds, judges, reloadKinds } = reads;
  return (
    <section aria-label={JUDGES_COPY.title}>
      <Panel>
        {hasJudges ? (
          <InPanel value={kinds}>
            {(value) => <KindRows value={value} judges={judges} version={version} reloadKinds={reloadKinds} />}
          </InPanel>
        ) : (
          <div className={INSET}>
            <ScreenState value={version}>
              {(installed) => (
                <div className="flex flex-col gap-(--cue-space-1)">
                  <p className="text-fg">{COPY.updateToUse}</p>
                  <p className="text-fg-muted">{needsLine(GATES.judges, installed)}</p>
                </div>
              )}
            </ScreenState>
          </div>
        )}
      </Panel>
    </section>
  );
}

/** A tab's count of what waits in it for the person, as a caution chip; said in words to a screen reader. */
function Attention({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <>
      {' '}
      <Chip tone="warn" data-slot="tab-attention">
        {count}
      </Chip>{' '}
      <span className="sr-only">{EVENTS_COPY.toLookAt}</span>
    </>
  );
}

/** A tab's count of what its list holds, quietly, beside its name. */
function Count({ count }: { count: number | null }) {
  if (count === null || count === 0) return null;
  return (
    <>
      {' '}
      <span className="text-fg-muted tabular-nums">{count}</span>
    </>
  );
}

type EventsTab = keyof typeof EVENTS_COPY.tabs;

/**
 * The screen's four views (desktop design D7): the event service and its status first, then the judges, the rules and
 * the recent deliveries. Every view stays mounted while another is shown, so each is read when the screen opens, as it
 * always was, and a tab's badge can say what waits in it: nothing is hidden behind a tab.
 */
function EventsTabs() {
  const { eventService } = useAppData();
  const judgeReads = useJudgeReads();
  const rules = useCall<unknown>(RULES);
  useReloadOnServiceTurn(rules.reload);
  const deliveries = useCall<unknown>(DELIVERIES);
  useReloadOnServiceTurn(deliveries.reload);
  const { tabs } = EVENTS_COPY;
  const tab = (value: EventsTab, badge: ReactNode) => (
    <Tabs.Tab value={value}>
      {tabs[value]}
      {badge}
    </Tabs.Tab>
  );
  return (
    <Tabs.Root defaultValue={'service' satisfies EventsTab}>
      <Tabs.List aria-label="Events" className="self-start">
        {tab('service', <Attention count={serviceAttention(eventService)} />)}
        {tab('judges', <Attention count={judgesWaiting(judgeReads)} />)}
        {tab('rules', <Count count={ruleCount(rules.result)} />)}
        {tab('deliveries', <Count count={deliveryCount(deliveries.result)} />)}
      </Tabs.List>
      <Tabs.Panel value={'service' satisfies EventsTab} keepMounted>
        <div className="flex flex-col gap-(--cue-space-6)">
          <Service />
          <Status />
        </div>
      </Tabs.Panel>
      <Tabs.Panel value={'judges' satisfies EventsTab} keepMounted>
        <Judges reads={judgeReads} />
      </Tabs.Panel>
      <Tabs.Panel value={'rules' satisfies EventsTab} keepMounted>
        <Rules result={rules.result} />
      </Tabs.Panel>
      <Tabs.Panel value={'deliveries' satisfies EventsTab} keepMounted>
        <Deliveries result={deliveries.result} />
      </Tabs.Panel>
    </Tabs.Root>
  );
}

/**
 * The events service (DA5.6), mostly read-only: the app's switch for running it (D2), its status with Pause and
 * Resume, its judges with Turn on in Terminal and Turn off, its rules and its recent deliveries. Everything else stays in
 * its CLI and MCP, which carry its secret-handling rules. Nothing here runs unless its launcher is installed.
 */
export function Events() {
  const { installation } = useAppData();
  const present = installation.state === 'ready' && installation.value.present.includes('events-daemon');
  return (
    <ScreenFrame title="Events">
      {present ? (
        <EventsTabs />
      ) : (
        <Panel>
          <EmptyState title="The events service isn't installed." />
        </Panel>
      )}
    </ScreenFrame>
  );
}
