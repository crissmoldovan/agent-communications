/**
 * One delivery's page (owner feedback 0.32.0, §3.5), from `delivery show`: the message — where and when, and its sender
 * and subject where a dry run kept them, as outside text — with Open in Gmail or Slack and a link to its story; why it
 * was passed on; for a dry run, the record it would have delivered, every field a sender wrote as outside text; for a
 * webhook, its host; and its tries, with Try now while it will try again and Stop trying… once it has failed.
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
import { COPY, needsLine, SCREEN_LABELS, type Screen } from '../../copy.ts';
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
  stateWords,
} from '../../events-deliveries.ts';
import { channelOf, describeCondition, judgeName, type TargetView } from '../../events-rules.ts';
import { atLeast } from '../../gates.ts';
import { useCall } from '../../hooks/use-call.ts';
import { type Call, errorMessage } from '../../ipc.ts';
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
  signed: 'Signed with the target’s key',
  tries: 'Tries',
  counted: 'Earlier tries are counted, not kept one by one.',
  recorded: 'Recorded · nothing sent',
  written: 'Written to the dry-run log on this Mac',
  tryNow: 'Try now',
  stopTrying: 'Stop trying…',
  stopTitle: 'Stop trying this delivery?',
  stopBody: 'It failed, and the message it kept for it is deleted now. Nothing is sent for it.',
  stopAction: 'Stop trying',
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

/** A name and what it says, in a two-column list. */
function Pair({ name, children, field }: { name: string; children: ReactNode; field?: string }) {
  return (
    <>
      <dt className="text-(length:--cue-text-label) text-fg-muted">{name}</dt>
      <dd className="min-w-0 break-words text-fg" {...(field === undefined ? {} : { 'data-field': field })}>
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

/** Try now, while it will try again; Stop trying…, once it has failed; and what either came to when it failed. */
function Actions({
  row,
  onChanged,
  onProblem,
}: {
  row: DeliveryRow;
  onChanged: () => Promise<void>;
  onProblem: (problem: string | null) => void;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  if (!row.openable || (row.state !== 'retryable' && row.state !== 'dead-lettered')) return null;
  const apply = async (call: Call) => {
    setBusy(true);
    onProblem(null);
    try {
      const result = await bridge.cli(call);
      if (result.status === 'ok') await onChanged();
      else onProblem(result.status === 'failed' ? result.message : DELIVERY_COPY.unreadable);
    } catch (error) {
      onProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  if (row.state === 'retryable') {
    return (
      <Button
        size="sm"
        disabled={busy}
        loading={busy}
        onClick={() => void apply({ kind: 'eventsDeliveryRetry', deliveryId: row.id })}
      >
        {DELIVERY_COPY.tryNow}
      </Button>
    );
  }
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        render={
          <Button size="sm" variant="danger-outline" disabled={busy} loading={busy}>
            {DELIVERY_COPY.stopTrying}
          </Button>
        }
      />
      <AlertDialog.Content>
        <AlertDialog.Title>{DELIVERY_COPY.stopTitle}</AlertDialog.Title>
        <AlertDialog.Description>{DELIVERY_COPY.stopBody}</AlertDialog.Description>
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
  );
}

/** The page's state chip: "Will try again at 12:10", "Recorded · nothing sent", or the state in plain words. */
function StateChip({ row, kind }: { row: DeliveryRow; kind: string | null }) {
  const { words, tone } = stateWords({ state: row.state, targetKind: kind });
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

/** The link to the message's story (§3.6), when the app has its screen; until then, its words alone. */
function Story({ onScreen }: { onScreen?: ((screen: Screen) => void) | undefined }) {
  const routable = onScreen !== undefined && Object.keys(SCREEN_LABELS).includes('messages');
  if (!routable) {
    return (
      <p data-slot="message-story" aria-disabled="true" className="text-(length:--cue-text-label) text-fg-muted">
        {DELIVERY_COPY.story}
      </p>
    );
  }
  return (
    <p className="text-(length:--cue-text-label)">
      <Link variant="underline" render={<button type="button" />} onClick={() => onScreen('messages' as Screen)}>
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
  onScreen,
  onProblem,
}: {
  row: DeliveryRow;
  detail: Detail | null;
  record: unknown;
  lists: EventsLists;
  onScreen?: ((screen: Screen) => void) | undefined;
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
      <Story onScreen={onScreen} />
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
        <Link variant="underline" render={<button type="button" />} onClick={() => nav.openRule(row.ruleId)}>
          <UntrustedText text={row.ruleId} />
        </Link>
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
              <Pair key={field.name} name={field.name} field={field.name}>
                {field.service ? (
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
  action,
}: {
  row: DeliveryRow;
  kind: string | null;
  retryLimit: number | null;
  expiresAt: number | null;
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
        {row.state === 'dead-lettered'
          ? ` It gave up after ${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'}.`
          : null}
        {row.state === 'delivered' && row.deliveredAt !== null ? (
          <>
            {' Delivered at '}
            <Short at={row.deliveredAt} />.
          </>
        ) : null}
      </p>
      {answer === null ? null : <p className="text-fg">{`Its last try: ${answer}.`}</p>}
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

export function DeliveryDetail({
  id,
  lists,
  nav,
  onScreen,
}: {
  id: string;
  lists: EventsLists;
  nav: EventsNav;
  onScreen?: ((screen: Screen) => void) | undefined;
}) {
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
    await Promise.all([show.reload(), lists.reloadDeliveries()]);
  };
  const action = <Actions row={row} onChanged={reload} onProblem={setProblem} />;
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
        onScreen={onScreen}
        onProblem={setProblem}
      />
      <Why row={row} detail={detail} lists={lists} nav={nav} />
      {detail !== null && kind === 'dry-run' ? (
        <WouldHave dryRun={detail.dryRun} read={dryRunKept ? dry.read : null} />
      ) : null}
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
        action={null}
      />
    </section>
  );
}
