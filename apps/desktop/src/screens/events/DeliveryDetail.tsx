/**
 * One delivery's page (owner feedback 0.32.0, §3.5), from `delivery show`: the message — where and when, and its sender
 * and subject where a dry run kept them, as outside text — with Open in Gmail or Slack and a link to its story; why it
 * was passed on; for a dry run, the record it would have delivered, every field a sender wrote as outside text; for a
 * webhook, its host; and its tries, with Try now while it will try again, and Stop trying… while it waits or will try
 * again (from the events service's 0.32.0) or once it has failed. A match waiting for a busy agent session (0.33.0)
 * says since when, from `session-queue list`, and is dropped with Drop…, confirmed first, by `session-queue drop`.
 *
 * `delivery show` and `dryrun show` answer the app from the events service's 0.32.0: before it, the page says so and
 * reads neither, and shows what the list knows. Earlier tries are not kept one by one, only their count and the last
 * answer, and the page says so.
 */
import { AlertDialog, Button, Chip, Link, Panel, Spinner } from '@cueplusplus/ui';
import { ExternalLink } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { aliasOf } from '../../account-aliases.ts';
import { useBridge } from '../../bridge-context.tsx';
import { productLabel } from '../../components/ApprovalCard.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY, needsLine } from '../../copy.ts';
import { type Loadable, useAppData } from '../../data.tsx';
import {
  type DeliveryJudge,
  type DeliveryRow,
  type DeliveryDetail as Detail,
  keptMessage,
  lastAnswer,
  messageLink,
  nextTry,
  readDeliveryShow,
  readDryrunShow,
  readSessionQueue,
  type SessionQueueItem,
  stateWords,
  waitingForSession,
} from '../../events-deliveries.ts';
import { channelOf, describeCondition, judgeName, type TargetView } from '../../events-rules.ts';
import { atLeast, GATES } from '../../gates.ts';
import { isRuleId } from '../../grammar.ts';
import { useCall } from '../../hooks/use-call.ts';
import { type Call, errorMessage } from '../../ipc.ts';
import { isEventId } from '../../messages/read.ts';
import { type Destination, useNavigate } from '../../navigation.tsx';
import { type EventsLists, type EventsNav, UNREADABLE_LIST } from './lists.ts';
import { BackTo, FromOutsideMark, Problem, SenderText, Sentence, Short } from './parts.tsx';
import { documentOf, madeAtOf, targetOf, whereItWent } from './targets.ts';

/** The first events service whose `delivery show` exists and whose `dryrun show` answers the app (`allowlist.rs`). */
export const DELIVERY_DETAIL_VERSION = '0.32.0';

/** The page's words, in sentence case. */
export const DELIVERY_COPY = {
  allDeliveries: 'All deliveries',
  message: 'The message',
  where: 'Where',
  from: 'From',
  subject: 'Subject',
  story: 'See everything that happened to this message',
  why: 'Why it was passed on',
  noJudge: 'No judge on this rule.',
  would: 'What it would have delivered',
  wouldNote:
    'Only the parts the rule keeps. Text the sender wrote is shown as plain text, never as links or formatting.',
  wouldGone: 'The dry-run log no longer has this entry: each is deleted after 24 hours.',
  sends: 'Where it sends',
  linearAdded: (identifier: string) => `Added ${identifier} in Linear.`,
  openInLinear: 'Open in Linear',
  signed: 'Signed with the target’s key',
  tries: 'Tries',
  counted: 'Earlier tries are counted, not kept one by one.',
  recorded: 'Recorded · nothing sent',
  written: 'Written to the dry-run log on this Mac',
  tryNow: 'Try now',
  stopTrying: 'Stop trying…',
  stopTitle: 'Stop trying this delivery?',
  stopTryingBody:
    'It is not tried again. The message it kept for its next try is deleted now, and nothing more is sent for it.',
  stopFailedBody: 'It failed, and the message it kept for it is deleted now. Nothing is sent for it.',
  inFlight: 'It is being sent right now, so it cannot be stopped yet. If this try fails, you can stop it then.',
  stopAction: 'Stop trying',
  drop: 'Drop…',
  dropTitle: 'Drop this waiting match?',
  dropBody:
    "It is waiting for the session's run to end. Dropping it cancels its delivery and deletes what it kept for the session, at once: it is never passed on.",
  dropAction: 'Drop it',
  waitingSince: "Waiting for the session's run to end since ",
  passedOnThen: ': it is passed on then.',
  waitingNoSince: "Waiting for the session's run to end: it is passed on then.",
  waitsUntil: 'It waits at most until ',
  released: "The session's run has ended: it is passed on in a moment.",
  unreadable: 'That answer could not be read.',
  gone: 'This delivery is no longer listed.',
} as const;

/** A titled part of the page, in a panel, with its action at the far end. */
function Part({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
        <div className="flex flex-wrap items-center gap-(--cue-space-2)">
          <h3 id={id} className="font-medium text-(length:--cue-text-label) text-fg-muted">
            {title}
          </h3>
          {action === undefined ? null : (
            <span className="ml-auto flex items-center gap-(--cue-space-2)">{action}</span>
          )}
        </div>
        {children}
      </Panel>
    </section>
  );
}

/** A name and what it says, in a two-column list; a record's field says which it is and who wrote it. */
function Pair({
  name,
  children,
  field,
  source,
}: {
  name: string;
  children: ReactNode;
  field?: string;
  source?: string;
}) {
  return (
    <>
      <dt className="text-(length:--cue-text-label) text-fg-muted">{name}</dt>
      <dd
        className="min-w-0 break-words text-fg"
        {...(field === undefined ? {} : { 'data-field': field })}
        {...(source === undefined ? {} : { 'data-source': source })}
      >
        {children}
      </dd>
    </>
  );
}

const PAIRS = 'grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-(--cue-space-4) gap-y-(--cue-space-2)';

/** What the judge said, in a few words: "Jev said yes, 0.86 sure", or that its answer is no longer kept. */
function judgeSaid(judge: DeliveryJudge): string {
  const name = judgeName(judge.kind);
  if (judge.answer === null) return `${name}'s answer is no longer kept.`;
  if (judge.confidence === null) return `${name} said ${judge.answer}.`;
  return judge.calibrated === false
    ? `${name} said ${judge.answer}, with a score of ${judge.confidence.toFixed(2)}.`
    : `${name} said ${judge.answer}, ${judge.confidence.toFixed(2)} sure.`;
}

/** Reads `call` when it is given, and reads its answer again with `read`; nothing while it is not. */
function useRead<T>(
  call: Call | null,
  read: (value: unknown) => T | null,
): { read: Loadable<T>; reload(): Promise<void> } {
  const { result, reload } = useCall<unknown>(call);
  if (result.state !== 'ready') return { read: result, reload };
  const value = read(result.value);
  return {
    read: value === null ? { state: 'error', message: DELIVERY_COPY.unreadable } : { state: 'ready', value },
    reload,
  };
}

/** The states Stop trying stops while a delivery will still be tried (from the events service's 0.32.0). */
const STOPPABLE_WHILE_TRYING: ReadonlySet<string> = new Set(['queued', 'retryable']);

/**
 * Whether a refusal is the event service's for a delivery being sent right now (`deliveryInFlight`, in
 * `b3-operator-control.ts`): its reason is not on the CLI's error line, so its words are read.
 */
export function refusedInFlight(result: { code: string; message: string }): boolean {
  return result.code === 'APPROVAL_VOID' && /being sent right now/u.test(result.message);
}

/**
 * Try now, while it will try again; Stop trying…, while it will be tried (from the events service's 0.32.0, which
 * stops one at once) or once it has failed (its kept message deleted); and what either came to when it went wrong.
 */
function Actions({
  row,
  stopsWhileTrying,
  dropsWaiting,
  onChanged,
  onProblem,
}: {
  row: DeliveryRow;
  /** Whether the events service stops a delivery that will be tried, not only a failed one (0.32.0). */
  stopsWhileTrying: boolean;
  /** Whether the events service drops a match from its busy queue (0.33.0). */
  dropsWaiting: boolean;
  onChanged: () => Promise<void>;
  onProblem: (problem: string | null) => void;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  // A match waiting for a busy session is not tried again by hand: the relay would say busy again. It is dropped from
  // the busy queue instead, which cancels its delivery.
  const waiting = waitingForSession(row);
  const tryNow = row.state === 'retryable' && !waiting;
  const stop =
    !waiting && (row.state === 'dead-lettered' || (stopsWhileTrying && STOPPABLE_WHILE_TRYING.has(row.state)));
  const drop = waiting && dropsWaiting;
  if (!row.openable || (!tryNow && !stop && !drop)) return null;
  const apply = async (call: Call) => {
    setBusy(true);
    onProblem(null);
    try {
      const result = await bridge.cli(call);
      if (result.status === 'ok') await onChanged();
      else if (result.status === 'failed' && refusedInFlight(result)) {
        onProblem(DELIVERY_COPY.inFlight);
        await onChanged();
      } else onProblem(result.status === 'failed' ? result.message : DELIVERY_COPY.unreadable);
    } catch (error) {
      onProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-(--cue-space-2)">
      {tryNow ? (
        <Button
          size="sm"
          disabled={busy}
          loading={busy}
          onClick={() => void apply({ kind: 'eventsDeliveryRetry', deliveryId: row.id })}
        >
          {DELIVERY_COPY.tryNow}
        </Button>
      ) : null}
      {stop ? (
        <AlertDialog.Root>
          <AlertDialog.Trigger
            render={
              <Button size="sm" variant="danger-outline" disabled={busy}>
                {DELIVERY_COPY.stopTrying}
              </Button>
            }
          />
          <AlertDialog.Content>
            <AlertDialog.Title>{DELIVERY_COPY.stopTitle}</AlertDialog.Title>
            <AlertDialog.Description>
              {row.state === 'dead-lettered' ? DELIVERY_COPY.stopFailedBody : DELIVERY_COPY.stopTryingBody}
            </AlertDialog.Description>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
              <AlertDialog.Action
                tone="danger"
                onClick={() => void apply({ kind: 'eventsDeliveryDrop', deliveryId: row.id })}
              >
                {DELIVERY_COPY.stopAction}
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Root>
      ) : null}
      {drop ? (
        <AlertDialog.Root>
          <AlertDialog.Trigger
            render={
              <Button size="sm" variant="danger-outline" disabled={busy}>
                {DELIVERY_COPY.drop}
              </Button>
            }
          />
          <AlertDialog.Content>
            <AlertDialog.Title>{DELIVERY_COPY.dropTitle}</AlertDialog.Title>
            <AlertDialog.Description>{DELIVERY_COPY.dropBody}</AlertDialog.Description>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
              <AlertDialog.Action
                tone="danger"
                onClick={() => void apply({ kind: 'sessionQueueDrop', deliveryId: row.id })}
              >
                {DELIVERY_COPY.dropAction}
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Root>
      ) : null}
    </span>
  );
}

/** Since when a match waits for a busy session, and until when at most; or that the session's run has ended. */
function Waiting({ item }: { item: SessionQueueItem | null }) {
  if (item?.released === true) return <p className="text-fg">{DELIVERY_COPY.released}</p>;
  return (
    <>
      <p className="text-fg" data-slot="waiting">
        {item === null ? (
          DELIVERY_COPY.waitingNoSince
        ) : (
          <>
            {DELIVERY_COPY.waitingSince}
            <Short at={item.queuedAt} />
            {DELIVERY_COPY.passedOnThen}
          </>
        )}
      </p>
      {item?.expiresAt == null ? null : (
        <p className="text-(length:--cue-text-label) text-fg-muted">
          {DELIVERY_COPY.waitsUntil}
          <Short at={item.expiresAt} />.
        </p>
      )}
    </>
  );
}

/** The page's state chip: "Will try again at 12:10", "Recorded · nothing sent", or the state in plain words. */
function StateChip({ row, kind }: { row: DeliveryRow; kind: string | null }) {
  const { words, tone } = stateWords({ state: row.state, targetKind: kind, lastErrorCode: row.lastErrorCode });
  const next = nextTry(row);
  if (row.state === 'delivered' && kind === 'dry-run') return <Chip tone={tone}>{DELIVERY_COPY.recorded}</Chip>;
  return (
    <Chip tone={tone}>
      {words}
      {row.state === 'retryable' && next !== null ? (
        <>
          {' at '}
          <Short at={next} />
        </>
      ) : null}
    </Chip>
  );
}

/**
 * What opens this message's story on the Messages screen (§3.6): `navigate({ screen: 'messages', eventId })`, through the
 * app's navigation (`navigation.tsx`). Messages reads that destination as it mounts and opens the story of the event
 * with this id — from its list, or from `message show` when the list's page does not hold it.
 *
 * Null, and the link is then its words alone, when there is no event id the event service makes (32 lowercase hex
 * digits), or no navigation (a page shown without the shell).
 */
export function messageStoryOpener(
  eventId: string | null,
  navigate: ((to: Destination) => void) | null,
): (() => void) | null {
  if (eventId === null || navigate === null || !isEventId(eventId)) return null;
  return () => navigate({ screen: 'messages', eventId });
}

/** The link to the message's story, when `messageStoryOpener` gives one; otherwise its words alone. */
function Story({ eventId }: { eventId: string | null }) {
  const open = messageStoryOpener(eventId, useNavigate());
  if (open === null) {
    return (
      <p data-slot="message-story" aria-disabled="true" className="text-(length:--cue-text-label) text-fg-muted">
        {DELIVERY_COPY.story}
      </p>
    );
  }
  return (
    <p className="text-(length:--cue-text-label)">
      <Link variant="underline" render={<button type="button" />} onClick={open}>
        {DELIVERY_COPY.story}
      </Link>
    </p>
  );
}

/** The message: where and when it arrived, and its sender and subject where a dry run kept them. */
function Message({
  row,
  detail,
  record,
  lists,
  onProblem,
}: {
  row: DeliveryRow;
  detail: Detail | null;
  record: unknown;
  lists: EventsLists;
  onProblem: (problem: string | null) => void;
}) {
  const bridge = useBridge();
  const channel = channelOf(documentOf(lists, row)) ?? detail?.event?.type?.split('.')[0] ?? null;
  const accountId = detail?.event?.accountId ?? row.accountId;
  const link = messageLink(detail?.event?.source ?? null, lists.names.get(accountId));
  const kept = keptMessage(record);
  const when = detail?.event?.occurredAt ?? detail?.event?.observedAt ?? null;
  const open = () => {
    if (link === null) return;
    onProblem(null);
    bridge.openLink(link.url).catch((error: unknown) => onProblem(errorMessage(error)));
  };
  return (
    <Part
      title={DELIVERY_COPY.message}
      action={
        <>
          {kept.from === null && kept.subject === null ? null : <FromOutsideMark />}
          {link === null ? null : (
            <Button size="sm" variant="ghost" icon={ExternalLink} onClick={open}>
              {link.label}
            </Button>
          )}
        </>
      }
    >
      <dl className={PAIRS}>
        <Pair name={DELIVERY_COPY.where}>
          {channel === null ? null : `${productLabel(channel)} · `}
          <UntrustedText text={aliasOf(lists.names, accountId)} />
          {when === null ? null : (
            <>
              {' · '}
              <Short at={when} />
            </>
          )}
        </Pair>
        {kept.from === null ? null : (
          <Pair name={DELIVERY_COPY.from}>
            <SenderText text={kept.from} />
          </Pair>
        )}
        {kept.subject === null ? null : (
          <Pair name={DELIVERY_COPY.subject}>
            <SenderText text={kept.subject} />
          </Pair>
        )}
      </dl>
      <Story eventId={detail?.event?.eventId ?? row.eventId} />
    </Part>
  );
}

/** Why it was passed on: the rule and its version, what it matches, and what its judge said. */
function Why({
  row,
  detail,
  lists,
  nav,
}: {
  row: DeliveryRow;
  detail: Detail | null;
  lists: EventsLists;
  nav: EventsNav;
}) {
  const document = documentOf(lists, row);
  const judge = detail?.decision?.judge ?? null;
  return (
    <Part title={DELIVERY_COPY.why}>
      <p className="text-fg">
        {'Rule '}
        {isRuleId(row.ruleId) ? (
          <Link variant="underline" render={<button type="button" />} onClick={() => nav.openRule(row.ruleId)}>
            <UntrustedText text={row.ruleId} />
          </Link>
        ) : (
          <UntrustedText text={row.ruleId} />
        )}
        {row.ruleVersion === null ? null : `, version ${row.ruleVersion}`}
        {document === null ? null : (
          <>
            {': '}
            <Sentence parts={describeCondition(document.condition, false)} names={lists.names} />
          </>
        )}
      </p>
      {detail === null ? null : (
        <p className="text-(length:--cue-text-label) text-fg-muted">
          {judge === null ? DELIVERY_COPY.noJudge : judgeSaid(judge)}
        </p>
      )}
    </Part>
  );
}

/** A dry run's would-be record: every field, a sender's as outside text; or that the log has deleted it. */
function WouldHave({
  dryRun,
  read,
}: {
  dryRun: Detail['dryRun'];
  read: Loadable<ReturnType<typeof readDryrunShow>> | null;
}) {
  return (
    <Part title={DELIVERY_COPY.would} action={dryRun?.expiresAt == null ? undefined : <FromOutsideMark />}>
      {dryRun?.expiresAt == null ? (
        <p className="text-fg-muted">{DELIVERY_COPY.wouldGone}</p>
      ) : read === null || read.state === 'loading' ? (
        <Spinner label={COPY.loading} />
      ) : read.state === 'error' ? (
        <Problem message={read.message} />
      ) : (
        <>
          <dl className={PAIRS}>
            {(read.value?.fields ?? []).map((field) => (
              <Pair key={field.name} name={field.name} field={field.name} source={field.source}>
                {field.source === 'attribute' ? (
                  <span className="font-mono text-(length:--cue-text-label)">
                    <UntrustedText text={field.value} />
                  </span>
                ) : (
                  <SenderText text={field.value} />
                )}
              </Pair>
            ))}
          </dl>
          <p className="text-(length:--cue-text-label) text-fg-muted">{DELIVERY_COPY.wouldNote}</p>
        </>
      )}
    </Part>
  );
}

/** Its tries: how many, and of how many; the last answer; the next try while it waits; and that only these are kept. */
function Tries({
  row,
  kind,
  retryLimit,
  expiresAt,
  waiting,
  action,
}: {
  row: DeliveryRow;
  kind: string | null;
  retryLimit: number | null;
  expiresAt: number | null;
  /** For a match waiting for a busy session: its item in the busy queue, or null while it is not known. */
  waiting: SessionQueueItem | null;
  action: ReactNode;
}) {
  const next = nextTry(row);
  const answer = lastAnswer({ ...row, targetKind: kind });
  if (kind === 'dry-run') {
    return (
      <Part title={DELIVERY_COPY.tries} action={action}>
        <p className="text-fg">
          {DELIVERY_COPY.written}
          {row.deliveredAt === null ? (
            '.'
          ) : (
            <>
              {' at '}
              <Short at={row.deliveredAt} />.
            </>
          )}
        </p>
        {expiresAt === null ? null : (
          <p className="text-(length:--cue-text-label) text-fg-muted">
            {'The dry-run log keeps this entry until '}
            <Short at={expiresAt} />
            {', then deletes it.'}
          </p>
        )}
      </Part>
    );
  }
  const times = (count: number) => `${count} ${count === 1 ? 'time' : 'times'}`;
  const count =
    row.attempts === 0
      ? 'Not tried yet.'
      : retryLimit === null
        ? `Tried ${times(row.attempts)}.`
        : `Tried ${row.attempts} of ${times(retryLimit)}.`;
  const left = retryLimit === null ? null : retryLimit - row.attempts;
  return (
    <Part title={DELIVERY_COPY.tries} action={action}>
      <p className="text-fg">
        {count}
        {row.state === 'dead-lettered' ? (
          <>
            {` It gave up after ${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'}`}
            {row.deadLetteredAt === null ? (
              '.'
            ) : (
              <>
                {', at '}
                <Short at={row.deadLetteredAt} />.
              </>
            )}
          </>
        ) : null}
        {row.state === 'delivered' && row.deliveredAt !== null ? (
          <>
            {' Delivered at '}
            <Short at={row.deliveredAt} />.
          </>
        ) : null}
      </p>
      {answer === null ? null : <p className="text-fg">{`Its last try: ${answer}.`}</p>}
      {waitingForSession(row) ? <Waiting item={waiting} /> : null}
      {next === null ? null : (
        <p className="text-fg" data-slot="next-try">
          {'Next try at '}
          <Short at={next} />
          {row.state === 'retryable' && left !== null && left > 0
            ? `. After ${left} more failed ${left === 1 ? 'try' : 'tries'} it stops, and the delivery shows as failed.`
            : '.'}
        </p>
      )}
      {row.attempts > 0 ? (
        <p className="text-(length:--cue-text-label) text-fg-muted">{DELIVERY_COPY.counted}</p>
      ) : null}
    </Part>
  );
}

/** The Linear issue a delivery added (0.33.0): its identifier, and its page, opened in the person's browser. */
function LinearIssue({
  issue,
  onProblem,
}: {
  issue: NonNullable<DeliveryRow['linear']>;
  onProblem: (problem: string | null) => void;
}) {
  const bridge = useBridge();
  const { url } = issue;
  return (
    <Part title={DELIVERY_COPY.sends}>
      <p className="text-fg">
        <UntrustedText text={DELIVERY_COPY.linearAdded(issue.identifier)} />
      </p>
      {url === null ? null : (
        <p>
          <Link
            href={url}
            external
            onClick={(event) => {
              // The window never leaves the app: the issue opens in the browser, through `open_link`.
              event.preventDefault();
              bridge.openLink(url).catch((error: unknown) => onProblem(errorMessage(error)));
            }}
          >
            {DELIVERY_COPY.openInLinear}
          </Link>
        </p>
      )}
    </Part>
  );
}

export function DeliveryDetail({ id, lists, nav }: { id: string; lists: EventsLists; nav: EventsNav }) {
  const { eventsVersion } = useAppData();
  const [problem, setProblem] = useState<string | null>(null);
  const installed = eventsVersion !== 'absent' && eventsVersion.state === 'ready' ? eventsVersion.value : null;
  const versionKnown = eventsVersion !== 'absent' && eventsVersion.state !== 'loading';
  const supported = installed !== null && atLeast(installed, DELIVERY_DETAIL_VERSION);
  const listed = lists.deliveries.state === 'ready' ? lists.deliveries.value.find((each) => each.id === id) : undefined;
  const show = useRead(supported ? { kind: 'eventsDeliveryShow', deliveryId: id } : null, readDeliveryShow);
  const detail = show.read.state === 'ready' ? show.read.value : null;
  const dryRunKept = detail?.dryRun != null && detail.dryRun.expiresAt !== null;
  const dry = useRead(dryRunKept ? { kind: 'eventsDryrunShow', deliveryId: id } : null, readDryrunShow);
  const row = detail?.delivery ?? listed ?? null;
  const dropsWaiting = installed !== null && atLeast(installed, GATES.ruleEditor);
  const waiting = row !== null && dropsWaiting && waitingForSession(row);
  const queue = useRead(waiting ? { kind: 'sessionQueueList' } : null, readSessionQueue);
  const queued =
    queue.read.state === 'ready' ? (queue.read.value.find((each) => each.deliveryId === id) ?? null) : null;
  const back = <BackTo label={DELIVERY_COPY.allDeliveries} onBack={() => nav.openDelivery(null)} />;
  if (row === null) {
    return (
      <section aria-label="Delivery" className="flex flex-col gap-(--cue-space-4)">
        {back}
        {show.read.state === 'error' ? (
          <Problem message={show.read.message} />
        ) : lists.deliveries.state === 'loading' || (supported && show.read.state === 'loading') ? (
          <Spinner label={COPY.loading} />
        ) : (
          <Problem message={lists.deliveries.state === 'error' ? UNREADABLE_LIST : DELIVERY_COPY.gone} />
        )}
      </section>
    );
  }
  const target = targetOf(lists, row);
  const kind = detail?.target.kind ?? row.targetKind ?? target?.kind ?? null;
  const host = detail?.target.host ?? target?.host ?? null;
  const where = whereItWent(lists, row, {
    ...(kind === null ? {} : { kind: kind as TargetView['kind'] }),
    ...(detail?.target.lane == null ? {} : { lane: detail.target.lane }),
    ...(host === null ? {} : { host }),
  });
  const made = madeAtOf(lists, row);
  const reload = async () => {
    await Promise.all([show.reload(), lists.reloadDeliveries(), ...(waiting ? [queue.reload()] : [])]);
  };
  const action = (
    <Actions
      row={row}
      stopsWhileTrying={supported}
      dropsWaiting={dropsWaiting}
      onChanged={reload}
      onProblem={setProblem}
    />
  );
  return (
    <section aria-label="Delivery" className="flex flex-col gap-(--cue-space-4)">
      {back}
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <h2 className="font-semibold text-(length:--cue-text-title) text-fg">
          <UntrustedText text={`${row.ruleId} → ${where}`} />
        </h2>
        <StateChip row={row} kind={kind} />
        {made === null ? null : (
          <span className="text-(length:--cue-text-label) text-fg-muted">
            <Short at={made} />
          </span>
        )}
        <span className="ml-auto">{action}</span>
      </div>
      {problem === null ? null : <Problem message={problem} />}
      {!versionKnown ? <Spinner label={COPY.loading} /> : null}
      {versionKnown && !supported ? (
        <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
          <p className="text-fg">{COPY.updateToUse}</p>
          <p className="text-fg-muted">{needsLine(DELIVERY_DETAIL_VERSION, installed)}</p>
        </Panel>
      ) : null}
      {show.read.state === 'error' ? <Problem message={show.read.message} /> : null}
      {supported && show.read.state === 'loading' ? <Spinner label={COPY.loading} /> : null}
      <Message
        row={row}
        detail={detail}
        record={dry.read.state === 'ready' ? dry.read.value?.record : null}
        lists={lists}
        onProblem={setProblem}
      />
      <Why row={row} detail={detail} lists={lists} nav={nav} />
      {detail !== null && kind === 'dry-run' ? (
        <WouldHave dryRun={detail.dryRun} read={dryRunKept ? dry.read : null} />
      ) : null}
      {row.linear === null ? null : <LinearIssue issue={row.linear} onProblem={setProblem} />}
      {kind === 'webhook' && host !== null ? (
        <Part title={DELIVERY_COPY.sends}>
          <p className="text-fg">
            {'To '}
            <span className="font-mono">
              <UntrustedText text={host} />
            </span>
          </p>
          <p className="text-(length:--cue-text-label) text-fg-muted">{DELIVERY_COPY.signed}</p>
        </Part>
      ) : null}
      <Tries
        row={row}
        kind={kind}
        retryLimit={target?.retryLimit ?? null}
        expiresAt={detail?.dryRun?.expiresAt ?? null}
        waiting={queued}
        action={null}
      />
    </section>
  );
}
