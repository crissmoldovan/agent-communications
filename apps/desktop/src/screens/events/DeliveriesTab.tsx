/**
 * Events → Deliveries (owner feedback 0.32.0, §3.5): each delivery a rule made, newest first, as a row that reads
 * "rule → where it went", with its channel and account, its state in plain words and its time; filtered by All, Will
 * try again, Failed and Done, or narrowed to one rule's. A row opens the delivery's page (`DeliveryDetail`).
 *
 * A next try is said only while a delivery waits to be tried, and only as a positive time (`nextTry`): the owner saw
 * "next try 1970" on every delivered row, where the event service had left 0.
 *
 * Since 0.34.0 (design B5, the board `Deliveries.dc.html`): a rule in dry-run says so above the rows, and who can read
 * its log; a Dry-run log filter beside the state filters lists what the log holds, from the same `deliveries list`; a
 * dry run whose entry is gone keeps its row, folded under "<n> removed after 24 hours"; and a note, Something reached
 * your agent?, says where a match can reach an agent — the Queue, a session — and that the dry-run log is the person's.
 */
import { Button, Chip, EmptyState, InfoTip, Link, Panel, Row, SegmentedControl, Spinner } from '@cueplusplus/ui';
import { Bot, ChevronRight, FileText, Inbox, Link2, ListTodo, Radio } from 'lucide-react';
import { type ComponentType, type ReactNode, useState } from 'react';
import { aliasOf } from '../../account-aliases.ts';
import { productLabel } from '../../components/ApprovalCard.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY, type Screen } from '../../copy.ts';
import {
  type DeliveryGroup,
  type DeliveryRow,
  deliveryGroup,
  dryRunRemoved,
  nextTry,
  stateWords,
  waitingForSession,
} from '../../events-deliveries.ts';
import { channelOf, currentVersion, dryRunOnly } from '../../events-rules.ts';
import { useNavigate } from '../../navigation.tsx';
import { DeliveryDetail } from './DeliveryDetail.tsx';
import { type EventsLists, type EventsNav, readVersions } from './lists.ts';
import { FactsLine, Problem, Short } from './parts.tsx';
import { documentOf, madeAtOf, targetOf, whereItWent } from './targets.ts';
import { inWords } from './Watching.tsx';

/** The tab's words (the approved prototype, row 3), in sentence case. */
export const DELIVERIES_COPY = {
  intro:
    'A delivery is one match a workflow passed on: to the Queue, an agent session, Linear, a webhook, or the dry-run log. Open one to see the message, why it was passed on, and each try.',
  show: 'Show',
  filters: {
    all: 'All',
    trying: 'Will try again',
    waiting: 'Waiting for a session',
    failed: 'Failed',
    done: 'Done',
    dryRun: 'Dry-run log',
  },
  inDryRun:
    "each match is written to the dry-run log instead of being sent anywhere. Agents can't read it through their tools; one with a terminal, such as Claude Code, runs commands as you and can.",
  openLog: 'Open the dry-run log ›',
  removedNote: 'kept 24 hours, then removed',
  removed: 'Removed',
  reach: {
    title: 'Something reached your agent?',
    intro: "A workflow's match goes to one of these. Two are meant for an agent; the dry-run log is meant for you.",
    forAgent: 'An agent sees it',
    forYou: 'For you',
    queue: 'The Queue',
    queueWhat: 'Items an agent works through, one at a time.',
    queueLink: 'Open the Queue ›',
    session: 'A session',
    sessionWhat: 'A workflow that hands the message to an agent session claude-stream runs on this Mac.',
    sessionLink: 'Settings → Integrations ›',
    log: 'The dry-run log',
    logWhat:
      "For trying a workflow out. Nothing is sent. An agent with a terminal can read it as you can; its tools can't.",
    others: 'A workflow can also add a Linear issue or call a webhook. Neither reaches an agent here.',
  },
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

/** `<rule> is in dry-run:`, or `<a> and <b> are in dry-run:`. */
export function inDryRunLead(rules: readonly string[]): string {
  return `${inWords(rules)} ${rules.length === 1 ? 'is' : 'are'} in dry-run:`;
}

/** `<n> removed after 24 hours` */
export function removedLine(count: number): string {
  return `${count} removed after 24 hours`;
}

/** The most deliveries the list shows; the CLI and MCP list every one. */
const SHOWN = 100;

type Filter = 'all' | DeliveryGroup | 'dryRun';
const FILTERS: readonly Filter[] = ['all', 'trying', 'waiting', 'failed', 'done', 'dryRun'];

/** Where a delivery went, by its kind: as the list says it, or as its rule version's document does. */
function kindOf(lists: EventsLists, row: DeliveryRow): string | null {
  return row.targetKind ?? targetOf(lists, row)?.kind ?? null;
}

/** Whether a delivery is under `filter`: All, a state's, or the dry-run log's. */
function under(lists: EventsLists, row: DeliveryRow, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'dryRun') return kindOf(lists, row) === 'dry-run';
  return deliveryGroup(row) === filter;
}

/** Whether a dry run's entry has left the log (`dryRunRemoved`), by its target's own retention. */
function removedFromLog(lists: EventsLists, row: DeliveryRow, now: number): boolean {
  return dryRunRemoved({ ...row, kind: kindOf(lists, row) }, targetOf(lists, row)?.retentionMs ?? null, now);
}

/** The rules that are on and only write to the dry-run log, by id, as the Rules tab reads them; one rule's, when asked. */
function rulesInDryRun(lists: EventsLists, only: string | null): string[] {
  if (lists.rules.state !== 'ready') return [];
  return lists.rules.value
    .filter((rule) => rule.status === 'on' && (only === null || rule.id === only))
    .filter((rule) => {
      const versions = readVersions(lists, rule.id);
      return versions !== null && dryRunOnly(currentVersion(versions)?.document ?? null);
    })
    .map((rule) => rule.id);
}

const ICONS: Readonly<Record<string, ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>>> = {
  queue: Inbox,
  'dry-run': FileText,
  webhook: Link2,
  sse: Radio,
  linear: ListTodo,
  session: Bot,
};

/** The facts beneath a row's title: its channel and account, then what its tries came to, in a few words. */
function rowFacts(lists: EventsLists, row: DeliveryRow, removed: boolean): ReactNode[] {
  const channel = channelOf(documentOf(lists, row));
  const next = nextTry(row);
  const kind = kindOf(lists, row);
  const tries = (count: number) => `tried ${count} ${count === 1 ? 'time' : 'times'}`;
  const facts: ReactNode[] = [channel === null ? null : productLabel(channel), aliasOf(lists.names, row.accountId)];
  switch (row.state) {
    case 'delivered':
      if (kind === 'dry-run') facts.push(removed ? DELIVERIES_COPY.removedNote : 'nothing was sent');
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
function DeliveryLine({
  row,
  lists,
  removed = false,
  onOpen,
}: {
  row: DeliveryRow;
  lists: EventsLists;
  /** A dry run whose entry has left the log: its row stays, and says so. */
  removed?: boolean;
  onOpen: () => void;
}) {
  const kind = kindOf(lists, row) ?? '';
  const Icon = ICONS[kind] ?? FileText;
  const { words, tone } = removed
    ? { words: DELIVERIES_COPY.removed, tone: 'neutral' as const }
    : stateWords({
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
        <FactsLine facts={rowFacts(lists, row, removed)} />
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

/** The line above the rows for the rules in dry-run: what that means, who can read the log, and the way to it. */
function InDryRun({ rules, onOpenLog }: { rules: readonly string[]; onOpenLog: (() => void) | null }) {
  return (
    <div
      role="note"
      data-slot="in-dry-run"
      className="flex items-start gap-(--cue-space-3) rounded-control bg-accent-soft px-(--cue-space-4) py-(--cue-space-3)"
    >
      <span className="flex size-(--cue-control-md) shrink-0 items-center justify-center rounded-control bg-surface-1 text-accent">
        <FileText aria-hidden="true" className="size-(--cue-icon-sm)" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
        <p className="text-fg">
          <span className="font-semibold">
            <UntrustedText text={inDryRunLead(rules)} />
          </span>{' '}
          {DELIVERIES_COPY.inDryRun}
        </p>
        {onOpenLog === null ? null : (
          <div>
            <Link variant="underline" render={<button type="button" />} onClick={onOpenLog}>
              {DELIVERIES_COPY.openLog}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

/** One place a match can go, who it is meant for, and the way to it. */
function Way({ name, who, what, link }: { name: string; who: 'agent' | 'you'; what: string; link: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--cue-space-1) border-border border-t pt-(--cue-space-3)">
      <div className="flex items-center gap-(--cue-space-2)">
        <span className="min-w-0 flex-1 font-medium text-fg">{name}</span>
        <Chip tone={who === 'agent' ? 'ok' : 'neutral'}>
          {who === 'agent' ? DELIVERIES_COPY.reach.forAgent : DELIVERIES_COPY.reach.forYou}
        </Chip>
      </div>
      <span className="text-fg-muted">{what}</span>
      {link}
    </div>
  );
}

/** A way to another place, as a link; none where the screen was shown without the shell, which has nowhere to go. */
function WayLink({ label, onClick }: { label: string; onClick: (() => void) | null }) {
  if (onClick === null) return null;
  return (
    <div>
      <Link variant="underline" render={<button type="button" />} onClick={onClick}>
        {label}
      </Link>
    </div>
  );
}

/**
 * Something reached your agent? (the board's side note): where a rule's match can reach an agent — the Queue, which an
 * agent works through, and a session, which a rule hands the message to — and the dry-run log, which is the person's.
 */
function ReachedYourAgent({
  onScreen,
  onOpenLog,
}: {
  onScreen: ((screen: Screen) => void) | undefined;
  onOpenLog: () => void;
}) {
  const navigate = useNavigate();
  const { reach } = DELIVERIES_COPY;
  return (
    <aside aria-label={reach.title}>
      <Panel>
        <div className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
          <h2 className="font-semibold text-fg">{reach.title}</h2>
          <p className="text-fg-muted">{reach.intro}</p>
          <Way
            name={reach.queue}
            who="agent"
            what={reach.queueWhat}
            link={<WayLink label={reach.queueLink} onClick={onScreen === undefined ? null : () => onScreen('queue')} />}
          />
          <Way
            name={reach.session}
            who="agent"
            what={reach.sessionWhat}
            link={
              <WayLink
                label={reach.sessionLink}
                onClick={navigate === null ? null : () => navigate({ screen: 'settings', section: 'integrations' })}
              />
            }
          />
          <Way
            name={reach.log}
            who="you"
            what={reach.logWhat}
            link={<WayLink label={DELIVERIES_COPY.openLog} onClick={onOpenLog} />}
          />
          <p className="text-(length:--cue-text-label) text-fg-muted">{reach.others}</p>
        </div>
      </Panel>
    </aside>
  );
}

/** The list of deliveries, or one delivery's page when one is open. */
export function DeliveriesTab({
  lists,
  nav,
  onScreen,
}: {
  lists: EventsLists;
  nav: EventsNav;
  onScreen?: ((screen: Screen) => void) | undefined;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  if (nav.delivery !== null) return <DeliveryDetail id={nav.delivery} lists={lists} nav={nav} />;
  const { deliveries } = lists;
  const dryRun = rulesInDryRun(lists, nav.deliveriesOf);
  const openLog = () => setFilter('dryRun');
  return (
    <section
      aria-label="Deliveries"
      className="grid items-start gap-(--cue-space-4) xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]"
    >
      <div className="flex min-w-0 flex-col gap-(--cue-space-4)">
        {dryRun.length === 0 ? null : <InDryRun rules={dryRun} onOpenLog={filter === 'dryRun' ? null : openLog} />}
        <p className="text-fg-muted">{DELIVERIES_COPY.intro}</p>
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
      </div>
      <ReachedYourAgent onScreen={onScreen} onOpenLog={openLog} />
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
  const [showRemoved, setShowRemoved] = useState(false);
  const ofRule = nav.deliveriesOf === null ? rows : rows.filter((row) => row.ruleId === nav.deliveriesOf);
  const count = (each: Filter) => ofRule.filter((row) => under(lists, row, each)).length;
  const now = Date.now();
  const listed = newestFirst(
    lists,
    ofRule.filter((row) => under(lists, row, filter)),
  );
  // A dry run whose entry has left the log keeps its row, folded at the end.
  const removed = listed.filter((row) => removedFromLog(lists, row, now));
  const matching = listed.filter((row) => !removedFromLog(lists, row, now));
  const shown = matching.slice(0, SHOWN);
  return (
    <>
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <SegmentedControl
          indicator
          aria-label={DELIVERIES_COPY.show}
          size="sm"
          items={FILTERS
            // Waiting for a session shows only when a match waits for one (0.33.0), and the dry-run log only when a rule
            // wrote to it (0.34.0), or it is the filter chosen.
            .filter((each) => (each !== 'waiting' && each !== 'dryRun') || count(each) > 0 || filter === each)
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
      {shown.length === 0 && removed.length === 0 ? (
        <Panel>
          <EmptyState title={DELIVERIES_COPY.noneHere} />
        </Panel>
      ) : (
        <Panel>
          {shown.map((row) => (
            <DeliveryLine key={row.id} row={row} lists={lists} onOpen={() => nav.openDelivery(row.id)} />
          ))}
          {removed.length === 0 ? null : (
            <>
              <Row
                interactive
                data-slot="removed-fold"
                aria-expanded={showRemoved}
                onClick={() => setShowRemoved(!showRemoved)}
                className="items-center gap-(--cue-space-3) text-left"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={`size-(--cue-icon-sm) shrink-0 text-fg-muted transition-transform ${showRemoved ? 'rotate-90' : ''}`}
                />
                <span className="min-w-0 flex-1 font-medium text-fg-muted">{removedLine(removed.length)}</span>
                <span className="text-(length:--cue-text-label) text-fg-muted">{DELIVERIES_COPY.removedNote}</span>
              </Row>
              {showRemoved
                ? removed.map((row) => (
                    <DeliveryLine
                      key={row.id}
                      row={row}
                      lists={lists}
                      removed
                      onOpen={() => nav.openDelivery(row.id)}
                    />
                  ))
                : null}
            </>
          )}
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
