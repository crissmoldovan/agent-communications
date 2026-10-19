import { Button, Panel, Row, SectionHeader, StatusDot, type StatusTone } from '@cueplusplus/ui';
import type { ReactNode } from 'react';
import type { DoctorProduct, DoctorView } from '../cli-types.ts';
import { productLabel, readApprovals, When } from '../components/ApprovalCard.tsx';
import { Gated } from '../components/NeedsNewerCli.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY, type Screen } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { useCall } from '../hooks/use-call.ts';
import { PRODUCTS } from '../ipc.ts';
import { NOTHING_WAITING } from './Approvals.tsx';
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

/** A status dot that says its state, and carries its tone for anything that reads the page. */
function Dot({ tone }: { tone: StatusTone }) {
  return <StatusDot tone={tone} label={DOT_LABELS[tone]} data-tone={tone} />;
}

/** A row of a block: what it is, then what it says, at the far end. */
function Line({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <Row>
      <span className="text-fg-muted">{name}</span>
      <span className="ml-auto text-right text-fg">{children}</span>
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

/** A titled block of the Overview: the label stays when a newer CLI is needed, so the reader knows what is missing. */
function Block({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <SectionHeader label={label} action={action}>
        {children}
      </SectionHeader>
    </section>
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
      ? { tone: 'idle', words: 'Runs only when you ask, from Doctor, because it calls Google.' }
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
            <span className="ml-auto text-right text-fg-muted">{words}</span>
          </Row>
        );
      })}
    </Panel>
  );
}

/** How many approvals wait, in words. */
function waitingWords(count: number): string {
  if (count === 0) return NOTHING_WAITING;
  return count === 1 ? '1 approval is waiting.' : `${count} approvals are waiting.`;
}

function ApprovalsWaiting() {
  const { approvals } = useAppData();
  return (
    <Panel>
      <Rows value={approvals}>
        {(value) => {
          const list = readApprovals(value);
          return <Row>{list === null ? 'The approvals list could not be read.' : waitingWords(list.length)}</Row>;
        }}
      </Rows>
    </Panel>
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
                <span className="ml-auto text-right text-fg-muted">
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

function EventsRows() {
  const { events } = useAppData();
  if (events === 'absent') return null;
  return (
    <Panel>
      <Rows value={events}>
        {(status) => {
          const { tone, words } = eventsState(status);
          return (
            <Row>
              <Dot tone={tone} />
              <span className="text-fg">{words}</span>
            </Row>
          );
        }}
      </Rows>
    </Panel>
  );
}

/**
 * The version, the update status, each doctor, what waits, standing approvals and the events service (DA5.1), from
 * the data the app shares. Only the standing approvals are read here, once.
 */
export function Overview({ onScreen }: { onScreen?: (screen: Screen) => void }) {
  const { installation } = useAppData();
  const installed = installation.state === 'ready' ? installation.value : null;
  const present = installed?.present ?? [];
  const version = installed?.version ?? null;

  return (
    <ScreenFrame title="Overview">
      <section aria-label="Version">
        <Panel>
          <Row>
            <span className="text-fg">
              {version === null
                ? `agent-communications, at ${COPY.unreadableVersion}`
                : `agent-communications ${version}`}
            </span>
          </Row>
          {installed?.problem ? (
            <Row>
              <span className="text-fg-muted">
                <UntrustedText text={installed.problem} />
              </span>
            </Row>
          ) : null}
        </Panel>
      </section>
      <Block label="Updates">
        <Gated feature="updateStatus">
          <UpdateStatusRows />
        </Gated>
      </Block>
      <Block label="Doctor">
        <DoctorRows present={present} />
      </Block>
      <Block
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
      </Block>
      <Block label="Standing approvals">
        <Gated feature="standing">
          <StandingRows />
        </Gated>
      </Block>
      {present.includes('events-daemon') ? (
        <Block label="Events">
          <EventsRows />
        </Block>
      ) : null}
    </ScreenFrame>
  );
}
