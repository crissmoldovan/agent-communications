import { Button, DescriptionList, EmptyState, Panel, Table } from '@cueplusplus/ui';
import { type ReactNode, useState } from 'react';
import { ScreenState } from '../components/ScreenState.tsx';
import { SectionPanel } from '../components/SectionPanel.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { When } from '../components/When.tsx';
import { useAppData } from '../data.tsx';
import { useCall } from '../hooks/use-call.ts';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import type { Call } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/*
 * What this screen reads of the events service's bare JSON, field by field (DA13: its CLI keeps its own shape).
 *   status          `packages/events-daemon/src/operations/status.ts`, `EventsDaemonStatus`
 *   rules list      `runtime/owner.ts`, `ruleRows`: one row per rule version, its columns as SQLite names them
 *   deliveries list `runtime/b3-operator-control.ts`, `deliveriesList`: content-free metadata, times in epoch ms
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

/**
 * The events service (DA5.6), mostly read-only: its status with Pause and Resume, its rules and its recent
 * deliveries. Everything else stays in its CLI and MCP, which carry its secret-handling rules. Nothing here runs
 * unless its launcher is installed.
 */
export function Events() {
  const { installation } = useAppData();
  const present = installation.state === 'ready' && installation.value.present.includes('events-daemon');
  return (
    <ScreenFrame title="Events">
      {present ? (
        <>
          <Status />
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
