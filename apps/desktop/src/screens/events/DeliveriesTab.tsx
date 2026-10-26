/**
 * Events → Deliveries (owner feedback 0.32.0, §3.5): each delivery a rule made, newest first, as a row that reads
 * "rule → where it went", with its channel and account, its state in plain words and its time; filtered by All, Will
 * try again, Failed and Done, or narrowed to one rule's. A row opens the delivery's page (`DeliveryDetail`).
 *
 * A next try is said only while a delivery waits to be tried, and only as a positive time (`nextTry`): the owner saw
 * "next try 1970" on every delivered row, where the event service had left 0.
 */
import { Button, Chip, EmptyState, InfoTip, Panel, Row, SegmentedControl, Spinner } from '@cueplusplus/ui';
import { Bot, ChevronRight, FileText, Inbox, Link2, ListTodo, Radio } from 'lucide-react';
import { type ComponentType, type ReactNode, useState } from 'react';
import { aliasOf } from '../../account-aliases.ts';
import { productLabel } from '../../components/ApprovalCard.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY } from '../../copy.ts';
import {
  type DeliveryGroup,
  type DeliveryRow,
  deliveryGroup,
  nextTry,
  stateWords,
  waitingForSession,
} from '../../events-deliveries.ts';
import { channelOf } from '../../events-rules.ts';
import { DeliveryDetail } from './DeliveryDetail.tsx';
import type { EventsLists, EventsNav } from './lists.ts';
import { FactsLine, Problem, Short } from './parts.tsx';
import { documentOf, madeAtOf, targetOf, whereItWent } from './targets.ts';

/** The tab's words (the approved prototype, row 3), in sentence case. */
export const DELIVERIES_COPY = {
  intro:
    'A delivery is one message a rule passed on: to the Queue, to a webhook, or to the dry-run log. Open one to see the message, why it was passed on, and each try.',
  dryRunLog:
    'The dry-run log is a private record on this Mac of what a rule would have delivered, for trying a rule out. Nothing in it is sent anywhere, and each entry is deleted after 24 hours.',
  show: 'Show',
  filters: { all: 'All', trying: 'Will try again', waiting: 'Waiting for a session', failed: 'Failed', done: 'Done' },
  empty: 'No deliveries yet.',
  noneHere: 'No deliveries here.',
  onlyOf: (rule: string) => `Only ${rule}'s deliveries`,
  showAll: 'Show all',
  everyOne: 'The events CLI and MCP list every one.',
  everyOneLabel: 'Where every one is listed',
  untilFree: "passed on when the session's run ends",
} as const;

/** `The <n> most recent of <all>.` */
export function mostRecentLine(shown: number, all: number): string {
  return `The ${shown} most recent of ${all}.`;
}

/** The most deliveries the list shows; the CLI and MCP list every one. */
const SHOWN = 100;

type Filter = 'all' | DeliveryGroup;
const FILTERS: readonly Filter[] = ['all', 'trying', 'waiting', 'failed', 'done'];

const ICONS: Readonly<Record<string, ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>>> = {
  queue: Inbox,
  'dry-run': FileText,
  webhook: Link2,
  sse: Radio,
  linear: ListTodo,
  session: Bot,
};

/** The facts beneath a row's title: its channel and account, then what its tries came to, in a few words. */
function rowFacts(lists: EventsLists, row: DeliveryRow): ReactNode[] {
  const channel = channelOf(documentOf(lists, row));
  const next = nextTry(row);
  const kind = row.targetKind ?? targetOf(lists, row)?.kind ?? null;
  const tries = (count: number) => `tried ${count} ${count === 1 ? 'time' : 'times'}`;
  const facts: ReactNode[] = [channel === null ? null : productLabel(channel), aliasOf(lists.names, row.accountId)];
  switch (row.state) {
    case 'delivered':
      if (kind === 'dry-run') facts.push('nothing was sent');
      break;
    case 'queued':
      facts.push(row.attempts === 0 ? 'not tried yet' : tries(row.attempts));
      break;
    case 'retryable':
      facts.push(waitingForSession(row) ? DELIVERIES_COPY.untilFree : tries(row.attempts));
      break;
    case 'disclosing':
      facts.push(tries(row.attempts));
      break;
    case 'dead-lettered':
      facts.push(`gave up after ${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'}`);
      break;
    case 'content-unreadable':
      facts.push('its message could not be read');
      break;
    case 'retention-expired':
      facts.push('it ran out of time before it was delivered');
      break;
    default:
      break;
  }
  if (next !== null) {
    facts.push(
      <span data-slot="next-try">
        next try <Short at={next} />
      </span>,
    );
  }
  return facts;
}

/** One delivery's row: the whole row opens its page, when its id is one the allow-list takes. */
function DeliveryLine({ row, lists, onOpen }: { row: DeliveryRow; lists: EventsLists; onOpen: () => void }) {
  const kind = row.targetKind ?? targetOf(lists, row)?.kind ?? '';
  const Icon = ICONS[kind] ?? FileText;
  const { words, tone } = stateWords({
    state: row.state,
    targetKind: kind === '' ? null : kind,
    lastErrorCode: row.lastErrorCode,
  });
  const made = madeAtOf(lists, row);
  const body = (
    <>
      <span className="flex size-(--cue-control-md) shrink-0 items-center justify-center rounded-control bg-surface-2 text-fg-muted">
        <Icon aria-hidden="true" className="size-(--cue-icon-sm)" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
        <span data-slot="delivery-title" className="truncate font-medium text-fg">
          <UntrustedText text={`${row.ruleId} → ${whereItWent(lists, row)}`} />
        </span>
        <FactsLine facts={rowFacts(lists, row)} />
      </span>
      <Chip tone={tone}>{words}</Chip>
      <span
        data-slot="made-at"
        className="w-(--cue-space-8) shrink-0 text-right text-(length:--cue-text-label) text-fg-muted"
      >
        {made === null ? null : <Short at={made} />}
      </span>
      {row.openable ? (
        <ChevronRight data-slot="opens" aria-hidden="true" className="size-(--cue-icon-sm) shrink-0 text-fg-subtle" />
      ) : null}
    </>
  );
  const layout = 'items-center gap-(--cue-space-4) text-left';
  return row.openable ? (
    <Row interactive data-delivery={row.id} onClick={onOpen} className={layout}>
      {body}
    </Row>
  ) : (
    <Row data-delivery={row.id} className={layout}>
      {body}
    </Row>
  );
}

/** The newest first, by when each was made; one made at an unknown time by its expiry, as the list always sorted. */
function newestFirst(lists: EventsLists, rows: readonly DeliveryRow[]): DeliveryRow[] {
  const key = (row: DeliveryRow) => madeAtOf(lists, row) ?? row.expiresAt ?? Number.NEGATIVE_INFINITY;
  return [...rows].sort((a, b) => key(b) - key(a));
}

/** The list of deliveries, or one delivery's page when one is open. */
export function DeliveriesTab({ lists, nav }: { lists: EventsLists; nav: EventsNav }) {
  const [filter, setFilter] = useState<Filter>('all');
  if (nav.delivery !== null) return <DeliveryDetail id={nav.delivery} lists={lists} nav={nav} />;
  const { deliveries } = lists;
  return (
    <section aria-label="Deliveries" className="flex flex-col gap-(--cue-space-4)">
      <div className="flex flex-col gap-(--cue-space-1)">
        <p className="text-fg-muted">{DELIVERIES_COPY.intro}</p>
        <p className="text-(length:--cue-text-label) text-fg-muted">{DELIVERIES_COPY.dryRunLog}</p>
      </div>
      {deliveries.state === 'loading' ? (
        <Spinner label={COPY.loading} />
      ) : deliveries.state === 'error' ? (
        <Panel className="p-(--cue-space-4)">
          <Problem message={deliveries.message} />
        </Panel>
      ) : deliveries.value.length === 0 ? (
        <Panel>
          <EmptyState title={DELIVERIES_COPY.empty} />
        </Panel>
      ) : (
        <DeliveryLines rows={deliveries.value} lists={lists} nav={nav} filter={filter} onFilter={setFilter} />
      )}
    </section>
  );
}

function DeliveryLines({
  rows,
  lists,
  nav,
  filter,
  onFilter,
}: {
  rows: readonly DeliveryRow[];
  lists: EventsLists;
  nav: EventsNav;
  filter: Filter;
  onFilter: (filter: Filter) => void;
}) {
  const ofRule = nav.deliveriesOf === null ? rows : rows.filter((row) => row.ruleId === nav.deliveriesOf);
  const count = (each: Filter) =>
    each === 'all' ? ofRule.length : ofRule.filter((row) => deliveryGroup(row) === each).length;
  const matching = newestFirst(
    lists,
    ofRule.filter((row) => filter === 'all' || deliveryGroup(row) === filter),
  );
  const shown = matching.slice(0, SHOWN);
  return (
    <>
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <SegmentedControl
          indicator
          aria-label={DELIVERIES_COPY.show}
          size="sm"
          items={FILTERS
            // Waiting for a session shows only when a match waits for one (0.33.0), or it is the filter chosen.
            .filter((each) => each !== 'waiting' || count(each) > 0 || filter === each)
            .map((each) => ({ value: each, label: `${DELIVERIES_COPY.filters[each]} ${count(each)}` }))}
          value={filter}
          onValueChange={(value) => onFilter(value as Filter)}
        />
        {nav.deliveriesOf === null ? null : (
          <span className="flex items-center gap-(--cue-space-2) text-fg-muted">
            <UntrustedText text={DELIVERIES_COPY.onlyOf(nav.deliveriesOf)} />
            <Button size="sm" variant="ghost" onClick={() => nav.showDeliveriesOf(null)}>
              {DELIVERIES_COPY.showAll}
            </Button>
          </span>
        )}
      </div>
      {shown.length === 0 ? (
        <Panel>
          <EmptyState title={DELIVERIES_COPY.noneHere} />
        </Panel>
      ) : (
        <Panel>
          {shown.map((row) => (
            <DeliveryLine key={row.id} row={row} lists={lists} onOpen={() => nav.openDelivery(row.id)} />
          ))}
        </Panel>
      )}
      {shown.length < matching.length ? (
        <p className="flex items-center gap-(--cue-space-2) text-fg-muted">
          <span>{mostRecentLine(shown.length, matching.length)}</span>
          <InfoTip text={DELIVERIES_COPY.everyOne} label={DELIVERIES_COPY.everyOneLabel} />
        </p>
      ) : null}
    </>
  );
}
