import { Button, Grid, InfoTip, Panel, Row, SectionHeader, StatusDot, type StatusTone } from '@cueplusplus/ui';
import { type ReactNode, useId } from 'react';
import type { DoctorProduct, DoctorView } from '../cli-types.ts';
import { productLabel, readApprovals, When } from '../components/ApprovalCard.tsx';
import { Gated } from '../components/NeedsNewerCli.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY, needsLine, type Screen } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { GATES } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { PRODUCTS } from '../ipc.ts';
import { noQueueYet } from '../queue.ts';
import { NOTHING_WAITING } from './Approvals.tsx';
import { QUEUE_COPY } from './Queue.tsx';
import { ScreenFrame } from './Screen.tsx';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What each tone of dot says to a screen reader: the row beside it says the rest. */
const DOT_LABELS: Readonly<Record<StatusTone, string>> = {
  ok: 'healthy',
  warn: 'warning',
  danger: 'failing',
  busy: 'checking',
  idle: 'not run',
};

/** Why Gmail's doctor waits to be asked: the hint beside its row. */
export const GMAIL_WAITS = 'Runs only when you ask, from Doctor, because it calls Google.';

/** A status dot that says its state, and carries its tone for anything that reads the page. */
function Dot({ tone, size }: { tone: StatusTone; size?: number }) {
  return size === undefined ? (
    <StatusDot tone={tone} label={DOT_LABELS[tone]} data-tone={tone} />
  ) : (
    <StatusDot tone={tone} label={DOT_LABELS[tone]} size={size} data-tone={tone} />
  );
}

/** A row of a block: what it is, then what it says, at the far end. */
function Line({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <Row>
      <span className="shrink-0 text-fg-muted">{name}</span>
      <span className="ml-auto min-w-0 break-words text-right text-fg">{children}</span>
    </Row>
  );
}

/** A block's panel while its read is loading or failed, or its rows once it is there. */
function Rows<T>({ value, children }: { value: Loadable<T>; children: (value: T) => ReactNode }) {
  if (value.state === 'ready') return <>{children(value.value)}</>;
  return (
    <Row>
      <ScreenState value={value}>{() => null}</ScreenState>
    </Row>
  );
}

/** A titled list of the Overview: the label stays when a newer CLI is needed, so the reader knows what is missing. */
function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <SectionHeader label={label}>{children}</SectionHeader>
    </section>
  );
}

/**
 * One of the Overview's headline readings (the mockup's tiles): what it is, the reading, and an action under it. The
 * tile is the region its label names.
 */
function Tile({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <Panel className="flex h-full flex-col gap-(--cue-space-2) p-(--cue-space-5)">
        <span id={id} className="text-(length:--cue-text-ui) text-fg-muted">
          {label}
        </span>
        {children}
        {action === undefined ? null : <div className="mt-auto pt-(--cue-space-2)">{action}</div>}
      </Panel>
    </section>
  );
}

/** A tile's reading: large, in the page's own face. */
function Reading({ children }: { children: ReactNode }) {
  return (
    <span
      data-slot="tile-reading"
      className="flex min-w-0 items-start gap-(--cue-space-3) font-semibold text-(length:--cue-text-title) text-fg tabular-nums leading-tight tracking-tight"
    >
      {children}
    </span>
  );
}

/** A tile's line under its reading, or what it says when the reading is not there. */
function Caption({ children }: { children: ReactNode }) {
  return <span className="min-w-0 break-words text-(length:--cue-text-ui) text-fg-muted">{children}</span>;
}

/** A tile's reading once its read is there; until then, its loading or what went wrong, in the caption's place. */
function TileState<T>({ value, children }: { value: Loadable<T>; children: (value: T) => ReactNode }) {
  if (value.state === 'ready') return <>{children(value.value)}</>;
  return (
    <Caption>
      <ScreenState value={value}>{() => null}</ScreenState>
    </Caption>
  );
}

/** The background job, in words, with its last run. */
function jobWords(job: Record<string, unknown>): ReactNode {
  const state = textOf(job.state);
  const lastRun = textOf(job.lastRun);
  if (state === 'installed') {
    const prefix = job.working === false ? 'set up, but not working' : 'set up';
    return lastRun === null ? (
      `${prefix}; it has not run yet`
    ) : (
      <span>
        {`${prefix}; last ran `}
        <When iso={lastRun} />
      </span>
    );
  }
  if (state === 'not-set-up') return 'not set up';
  if (state === 'unsupported') return 'not available on this system';
  if (state === 'unreadable') return textOf(job.reason) ?? 'could not be read';
  return state ?? 'unknown';
}

/** The update status (DA5.1): the level, the background job with its last run, and any pause. */
function UpdateStatusRows() {
  const { updateStatus } = useAppData();
  if (updateStatus === 'unsupported') return null;
  return (
    <Panel>
      <Rows value={updateStatus}>
        {(status) => {
          if (!isRecord(status)) return <Row>The update status could not be read.</Row>;
          const pausedUntil = textOf(status.pausedUntil);
          return (
            <>
              <Line name="Level">{textOf(status.level) ?? 'unknown'}</Line>
              <Line name="Background job">{isRecord(status.job) ? jobWords(status.job) : 'unknown'}</Line>
              <Line name="Update notices">
                {pausedUntil === null ? (
                  'not paused'
                ) : (
                  <span>
                    {'paused until '}
                    <When iso={pausedUntil} />
                  </span>
                )}
              </Line>
            </>
          );
        }}
      </Rows>
    </Panel>
  );
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** A doctor's result, in a tone and a few words: danger on any failure, warn on any warning. */
function doctorState(
  product: DoctorProduct,
  result: Loadable<DoctorView> | undefined,
): { tone: StatusTone; words: ReactNode } {
  if (result === undefined) {
    return product === 'gmail'
      ? {
          tone: 'idle',
          words: (
            <span className="inline-flex items-center gap-(--cue-space-2)">
              Only when you ask
              <InfoTip text={GMAIL_WAITS} label="Why Gmail's doctor waits" />
            </span>
          ),
        }
      : { tone: 'idle', words: 'Not run yet.' };
  }
  if (result.state === 'loading') return { tone: 'busy', words: 'Checking…' };
  if (result.state === 'error') return { tone: 'danger', words: <UntrustedText text={result.message} /> };
  const { checks, healthy } = result.value;
  const failing = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  if (failing > 0) return { tone: 'danger', words: `${plural(failing, 'check', 'checks')} failing` };
  if (!healthy) return { tone: 'danger', words: 'Not healthy' };
  if (warnings > 0) return { tone: 'warn', words: plural(warnings, 'warning', 'warnings') };
  return { tone: 'ok', words: checks.length === 1 ? '1 check passes' : `All ${checks.length} checks pass` };
}

/** A row per doctor of each product that is here, in the products' order. */
function DoctorRows({ present }: { present: readonly DoctorProduct[] }) {
  const { doctors } = useAppData();
  return (
    <Panel>
      {PRODUCTS.filter((product) => present.includes(product)).map((product) => {
        const { tone, words } = doctorState(product, doctors[product]);
        return (
          <Row key={product} data-product={product}>
            <Dot tone={tone} />
            <span className="text-fg">{productLabel(product)}</span>
            <span className="ml-auto min-w-0 break-words text-right text-fg-muted">{words}</span>
          </Row>
        );
      })}
    </Panel>
  );
}

/** How many approvals wait: the count, and the empty state's own line when there are none. */
function ApprovalsWaiting() {
  const { approvals } = useAppData();
  return (
    <TileState value={approvals}>
      {(value) => {
        const list = readApprovals(value);
        if (list === null) return <Caption>The approvals list could not be read.</Caption>;
        return (
          <>
            <Reading>{list.length}</Reading>
            {list.length === 0 ? <Caption>{NOTHING_WAITING}</Caption> : null}
          </>
        );
      }}
    </TileState>
  );
}

/**
 * How many items wait in the queue (design 2026-10-25-action-queue §4.6), from the counts the app shares: the count, and
 * the Queue screen's own empty lines when there are none; or what the events service needs first.
 */
function QueueWaiting() {
  const { queueCounts, eventsVersion } = useAppData();
  if (queueCounts === 'absent') return null;
  if (queueCounts === 'unsupported') {
    const version = eventsVersion !== 'absent' && eventsVersion.state === 'ready' ? eventsVersion.value : null;
    return <Caption>{needsLine(GATES.queue, version)}</Caption>;
  }
  return (
    <TileState value={queueCounts}>
      {(counts) => (
        <>
          <Reading>{counts.open}</Reading>
          {counts.open > 0 ? null : (
            <Caption>{noQueueYet(counts) ? QUEUE_COPY.noQueue : QUEUE_COPY.nothingWaiting}</Caption>
          )}
        </>
      )}
    </TileState>
  );
}

/** Where a standing approval holds, in a few words: its conversations' ids, or the threads the account is in. */
function placesWords(places: unknown): ReactNode {
  if (!isRecord(places)) return null;
  if (places.kind === 'threads-i-am-in') return <span className="text-fg-muted">threads I am in</span>;
  if (places.kind !== 'exact' || !Array.isArray(places.places)) return null;
  const ids = places.places.filter(isRecord).flatMap((place) => {
    const id = textOf(place.id);
    return id === null ? [] : [id];
  });
  return ids.length === 0 ? null : <span className="font-mono text-fg-muted">{ids.join(', ')}</span>;
}

/**
 * The standing approvals that are active (spec 3), read once when the Overview opens. `standing list` prints
 * `{ approvals: StandingView[] }`; one that waits for its approval, or has ended, is not active.
 */
function StandingRows() {
  const { result } = useCall<unknown>({ kind: 'standingList' });
  return (
    <Panel>
      <Rows value={result}>
        {(value) => {
          if (!isRecord(value) || !Array.isArray(value.approvals)) {
            return <Row>The standing approvals could not be read.</Row>;
          }
          const active = value.approvals.filter(isRecord).filter((standing) => standing.state === 'active');
          if (active.length === 0) return <Row>No standing approval is active.</Row>;
          return active.map((standing, index) => {
            const places = placesWords(standing.places);
            const expiresAt = textOf(standing.expiresAt);
            const uses = typeof standing.usesToday === 'number' ? standing.usesToday : null;
            return (
              <Row key={textOf(standing.id) ?? index}>
                <span className="text-fg">{textOf(standing.workspace) ?? 'a workspace'}</span>
                {places}
                <span className="ml-auto min-w-0 break-words text-right text-fg-muted">
                  {expiresAt === null ? null : (
                    <>
                      {'until '}
                      <When iso={expiresAt} />
                    </>
                  )}
                  {uses === null
                    ? null
                    : `${expiresAt === null ? '' : '; '}used ${plural(uses, 'time', 'times')} today`}
                </span>
              </Row>
            );
          });
        }}
      </Rows>
    </Panel>
  );
}

/** The events service's state, from its bare status. */
function eventsState(status: unknown): { tone: StatusTone; words: string } {
  if (!isRecord(status)) return { tone: 'danger', words: "The events service's status could not be read." };
  if (status.owner !== 'running') return { tone: 'idle', words: 'Not running' };
  if (status.enabled === false) return { tone: 'idle', words: 'Running, switched off' };
  if (status.paused === true) return { tone: 'warn', words: 'Running, paused' };
  return { tone: 'ok', words: 'Running' };
}

function EventsReading() {
  const { events } = useAppData();
  if (events === 'absent') return null;
  return (
    <TileState value={events}>
      {(status) => {
        const { tone, words } = eventsState(status);
        return isRecord(status) ? (
          <Reading>
            <span className="flex h-lh shrink-0 items-center">
              <Dot tone={tone} size={8} />
            </span>
            <span className="min-w-0 text-balance break-words">{words}</span>
          </Reading>
        ) : (
          <Caption>
            <span className="inline-flex items-center gap-(--cue-space-2)">
              <Dot tone={tone} />
              {words}
            </span>
          </Caption>
        );
      }}
    </TileState>
  );
}

/**
 * The version, the update status, each doctor, what waits, standing approvals and the events service (DA5.1), from
 * the data the app shares. Only the standing approvals are read here, once. The readings a person looks for first are
 * tiles — the approvals waiting and, with the events service, the queue beside them (0.30.0, §4.6) — and the rest are
 * quiet lists under them.
 */
export function Overview({ onScreen }: { onScreen?: (screen: Screen) => void }) {
  const { installation } = useAppData();
  const installed = installation.state === 'ready' ? installation.value : null;
  const present = installed?.present ?? [];
  const version = installed?.version ?? null;
  const events = present.includes('events-daemon');

  return (
    <ScreenFrame title="Overview">
      <div className="flex flex-col gap-(--cue-space-6)">
        <Grid cols={events ? 4 : 2} gap={4}>
          <Tile
            label="Approvals waiting"
            action={
              onScreen === undefined ? undefined : (
                <Button variant="secondary" size="sm" onClick={() => onScreen('approvals')}>
                  Open Approvals
                </Button>
              )
            }
          >
            <ApprovalsWaiting />
          </Tile>
          {events ? (
            <Tile
              label="Queue"
              action={
                onScreen === undefined ? undefined : (
                  <Button variant="secondary" size="sm" onClick={() => onScreen('queue')}>
                    Open Queue
                  </Button>
                )
              }
            >
              <QueueWaiting />
            </Tile>
          ) : null}
          {events ? (
            <Tile label="Event service">
              <EventsReading />
            </Tile>
          ) : null}
          <Tile label="agent-communications">
            {version === null ? <Caption>{`at ${COPY.unreadableVersion}`}</Caption> : <Reading>{version}</Reading>}
            {installed?.problem ? (
              <Caption>
                <UntrustedText text={installed.problem} />
              </Caption>
            ) : null}
          </Tile>
        </Grid>
        <Block label="Doctor">
          <DoctorRows present={present} />
        </Block>
        <Block label="Standing approvals">
          <Gated feature="standing">
            <StandingRows />
          </Gated>
        </Block>
        <Block label="Updates">
          <Gated feature="updateStatus">
            <UpdateStatusRows />
          </Gated>
        </Block>
      </div>
    </ScreenFrame>
  );
}
