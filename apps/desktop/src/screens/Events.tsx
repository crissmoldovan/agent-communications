import { Button, DescriptionList, EmptyState, Panel, Table } from '@cueplusplus/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { SectionPanel } from '../components/SectionPanel.tsx';
import { TerminalResult } from '../components/TerminalResult.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { When } from '../components/When.tsx';
import { COPY, needsLine } from '../copy.ts';
import { useAppData } from '../data.tsx';
import { GATES, supports } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { type Call, errorMessage, type TerminalOutcome } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/*
 * What this screen reads of the events service's bare JSON, field by field (DA13: its CLI keeps its own shape).
 *   status          `packages/events-daemon/src/operations/status.ts`, `EventsDaemonStatus`
 *   rules list      `runtime/owner.ts`, `ruleRows`: one row per rule version, its columns as SQLite names them
 *   deliveries list `runtime/b3-operator-control.ts`, `deliveriesList`: content-free metadata, times in epoch ms
 *   judge model status  `operations/contracts/laya-model-status-v1.schema.json`: Laya's closed status (E2)
 */

/** `EventsDaemonStatus`: whether the service has an owner, and its switch. */
interface EventsStatus {
  owner: string;
  enabled?: boolean;
  paused?: boolean;
}

type Row = Record<string, unknown>;

/** A column of a list: its heading, and what a row shows under it. */
interface Column {
  label: string;
  show: (row: Row) => ReactNode;
  numeric?: boolean;
}

/** The most deliveries the table shows; the CLI and MCP list every one. */
const DELIVERIES_SHOWN = 100;

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
  { label: 'Rule', show: (row) => plain(row.rule_id) },
  { label: 'Version', show: (row) => plain(row.version), numeric: true },
  { label: 'State', show: (row) => plain(row.state) },
  { label: 'Approval', show: (row) => plain(row.approval_id) },
  { label: 'Activation', show: (row) => plain(row.authorization_activation_id) },
  { label: 'Digest', show: (row) => digest(row.digest) },
];

const DELIVERY_COLUMNS: readonly Column[] = [
  { label: 'Delivery', show: (row) => plain(row.deliveryId) },
  { label: 'Rule', show: (row) => versioned(row.ruleId, row.ruleVersion) },
  { label: 'Target', show: (row) => versioned(row.targetId, row.targetVersion) },
  { label: 'Account', show: (row) => plain(row.accountId) },
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
      <p role="alert" className="text-danger">
        The list could not be read.
      </p>
    );
  }
  const rows = arrange(value.filter(isRecord));
  if (rows.length === 0) return <EmptyState title={empty} />;
  const shown = limit === undefined ? rows : rows.slice(0, limit);
  return (
    <>
      <Table.Root>
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
                  {column.show(row)}
                </Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {shown.length < rows.length ? (
        <p className="text-fg-muted">
          The {shown.length} most recent of {rows.length}. The events CLI and MCP list every one.
        </p>
      ) : null}
    </>
  );
}

/** The status, as words: whether the service runs, and whether it collects. */
function StatusView({ value }: { value: unknown }) {
  if (!isRecord(value) || typeof value.owner !== 'string') {
    return (
      <p role="alert" className="text-danger">
        The status could not be read.
      </p>
    );
  }
  const status = value as unknown as EventsStatus;
  const running = status.owner === 'running';
  const collecting = status.enabled === true ? (status.paused === true ? 'paused' : 'on') : 'off';
  return (
    <DescriptionList.Root>
      <DescriptionList.Term>Service</DescriptionList.Term>
      <DescriptionList.Detail>{running ? 'running' : 'not running'}</DescriptionList.Detail>
      {running ? (
        <>
          <DescriptionList.Term>Collecting</DescriptionList.Term>
          <DescriptionList.Detail>{collecting}</DescriptionList.Detail>
        </>
      ) : null}
    </DescriptionList.Root>
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
    <SectionPanel
      title="Status"
      actions={
        <div className="flex gap-(--cue-space-2)">
          <Button size="sm" disabled={busy || !running || paused} onClick={() => void act({ kind: 'eventsPause' })}>
            Pause
          </Button>
          <Button size="sm" disabled={busy || !running || !paused} onClick={() => void act({ kind: 'eventsResume' })}>
            Resume
          </Button>
        </div>
      }
    >
      {events === 'absent' ? null : <ScreenState value={events}>{(value) => <StatusView value={value} />}</ScreenState>}
      {failure === null ? null : (
        <div role="alert" className="flex flex-col gap-(--cue-space-1)">
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
    </SectionPanel>
  );
}

const RULES: Call = { kind: 'eventsRules' };
const DELIVERIES: Call = { kind: 'eventsDeliveries' };

function Rules() {
  const { result } = useCall<unknown>(RULES);
  return (
    <SectionPanel title="Rules">
      <ScreenState value={result}>
        {(value) => <ListTable caption="Rules" columns={RULE_COLUMNS} value={value} empty="No rules yet." />}
      </ScreenState>
    </SectionPanel>
  );
}

function Deliveries() {
  const { result } = useCall<unknown>(DELIVERIES);
  return (
    <SectionPanel title="Recent deliveries">
      <ScreenState value={result}>
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
      </ScreenState>
    </SectionPanel>
  );
}

/*
 * Laya, the events service's local judge (E2 Task 11, desktop design DA16). Its status is the daemon's own `judge model
 * status`, read field by field as laya-model-status-v1 has it: the app shows its state, bytes and stable codes as plain
 * text, and adds no state, estimate or reason of its own. Enable opens the terminal with `judge kind enable laya`,
 * where the daemon's preview and the person's approval happen: the app prepares nothing and never approves. Disable
 * applies at once, a tightening. Removing the model files stays in the CLI and MCP. Nothing is read until the events
 * service's own version is one that has these calls (DA12).
 */

const LAYA_TITLE = 'Laya judge';
const LAYA_VERSION: Call = { kind: 'version', product: 'events-daemon' };
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
  'runtime-failed': 'Its runtime could not be installed.',
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
            <UntrustedText text={status.manifestId} />
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

/**
 * Laya's section. Nothing is read until the events service's own `--version` says it has the calls (DA12); then its
 * status is read when the screen opens, again when the window comes back (the person may have approved in the
 * terminal), and with the screen's poll while its bytes are moving (DA14). Only the latest-started read is kept
 * (`useCall`, DA16). Enable opens the terminal; Disable applies at once and reads the status again.
 */
function Laya() {
  const bridge = useBridge();
  const { events } = useAppData();
  const { run } = useChange();
  const { result: version } = useCall<string>(LAYA_VERSION);
  const supported = version.state === 'ready' && supports(version.value, 'layaJudge');
  const { result, reload } = useCall<unknown>(supported ? LAYA_STATUS : null);
  useReloadOnReturn(reload);
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
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);

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
    setBusy(false);
  };

  return (
    <SectionPanel
      title={LAYA_TITLE}
      actions={
        action === 'enable' ? (
          <Button size="sm" disabled={busy} onClick={() => void enable()}>
            Enable in Terminal
          </Button>
        ) : action === 'disable' ? (
          <Button size="sm" disabled={busy} onClick={() => void disable()}>
            Disable
          </Button>
        ) : null
      }
    >
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
      {opened === null ? null : (
        <div className="flex flex-col gap-(--cue-space-1)">
          <TerminalResult outcome={opened} />
          <p className="text-fg-muted">Its preview and its approval are in the terminal.</p>
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
    </SectionPanel>
  );
}

/**
 * The events service (DA5.6), mostly read-only: its status with Pause and Resume, its rules, its recent deliveries,
 * and Laya's state with Enable (in the terminal) and Disable. Everything else stays in its CLI and MCP, which carry its
 * secret-handling rules. Nothing here runs unless its launcher is installed.
 */
export function Events() {
  const { installation } = useAppData();
  const present = installation.state === 'ready' && installation.value.present.includes('events-daemon');
  return (
    <ScreenFrame title="Events">
      {present ? (
        <>
          <Status />
          <Laya />
          <Rules />
          <Deliveries />
        </>
      ) : (
        <Panel>
          <EmptyState title="The events service isn't installed." />
        </Panel>
      )}
    </ScreenFrame>
  );
}
