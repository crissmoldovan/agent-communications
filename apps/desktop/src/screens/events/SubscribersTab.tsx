/**
 * Events → Subscribers (workflows design W29–W33, §11.2): each subscriber — a program that receives the events workflows
 * raise — with its kind, what it receives and in which namespaces, its state, its listener on this Mac or that it posts
 * by signed webhook, and its backlog. Add a subscriber… stores an inert version; Approve… shows what it asks for and is
 * the person's approval; its token, signing secret and secret URL are made at a terminal ("Open in Terminal"), so the
 * app never has one; Remove applies at once, a tightening.
 *
 * Ids, namespaces and patterns are the person's or an agent's words, shown as text. Nothing here carries a sender's.
 */
import { Button, Chip, EmptyState, Panel, Spinner } from '@cueplusplus/ui';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { NeedsNewerCli } from '../../components/NeedsNewerCli.tsx';
import { TerminalResult } from '../../components/TerminalResult.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY } from '../../copy.ts';
import { useAppData } from '../../data.tsx';
import { supports } from '../../gates.ts';
import { isSubscriberId } from '../../grammar.ts';
import { useCall } from '../../hooks/use-call.ts';
import { useReloadOnServiceTurn } from '../../hooks/use-reload-on-return.ts';
import { errorMessage, type TerminalCommand, type TerminalOutcome } from '../../ipc.ts';
import { readSubscribers, type SubscriberEntryV2 } from '../../workflows/types.ts';
import { AddSubscriber } from './AddSubscriber.tsx';
import { FactsLine, Problem, Short } from './parts.tsx';
import { type PreparedSubscription, prepareSubscription, SubscriptionReview } from './SubscriptionReview.tsx';

export const SUBSCRIBERS_COPY = {
  intro:
    'A subscriber is a program that receives the events your workflows raise: live on this Mac, or by a signed webhook. Each receives only the events you approved for it, in its namespaces.',
  add: 'Add a subscriber…',
  empty: 'No subscriber yet.',
  unreadable: 'The subscribers could not be read.',
  added: (id: string) => `Added ${id}. It receives nothing until you approve it: Approve… below.`,
  approved: (id: string) => `${id} receives what you approved, from now on.`,
  removed: (id: string) => `Removed ${id}: it receives nothing more, and what waited for it is cancelled.`,
  kinds: { sse: 'Live on this Mac', webhook: 'Signed webhook' },
  states: {
    active: 'Approved',
    inert: 'Waiting for your approval',
    superseded: 'Replaced',
    streams: 'Receives what a workflow streams to it',
    removed: 'Removed',
  },
  receives: 'Receives',
  inNamespaces: (namespaces: readonly string[]) =>
    namespaces.length === 1 ? `in the namespace ${namespaces[0]}` : `in the namespaces ${namespaces.join(', ')}`,
  content: { none: 'Nothing a sender wrote.', enveloped: 'With what senders wrote, enveloped.' },
  streamsOnly: 'No events of its own: only what a workflow’s stream step sends it.',
  listening: (host: string, port: number) => `Listening at ${host.includes(':') ? `[${host}]` : host}:${port}`,
  portInUse: 'Its port is in use, so it is not listening.',
  notListening: 'Not listening: nothing delivers to it yet.',
  byWebhook: 'Posts each event to its address, signed.',
  backlog: (count: number) => (count === 1 ? '1 event waiting' : `${count} events waiting`),
  lastDelivered: 'last delivered',
  version: (version: number) => `version ${version}`,
  approve: 'Approve…',
  preparing: 'Preparing…',
  token: 'Make its token in Terminal',
  tokenRotate: 'Rotate its token in Terminal',
  secret: 'Make its signing secret in Terminal',
  secretRotate: 'Rotate its signing secret in Terminal',
  url: 'Set a secret address in Terminal',
  secretsAtTerminal: 'A token or a secret is shown once, at your terminal: never in this app.',
  remove: 'Remove',
} as const;

/** Each subscriber's versions, newest first, by its id: the subscriber is its newest version that is not removed. */
function bySubscriber(entries: readonly SubscriberEntryV2[]): { id: string; versions: SubscriberEntryV2[] }[] {
  const groups = new Map<string, SubscriberEntryV2[]>();
  for (const entry of entries) groups.set(entry.subscriberId, [...(groups.get(entry.subscriberId) ?? []), entry]);
  return [...groups.entries()]
    .map(([id, versions]) => ({ id, versions: [...versions].sort((a, b) => b.version - a.version) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function stateOf(entry: SubscriberEntryV2): { words: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (entry.revokedAt !== null) return { words: SUBSCRIBERS_COPY.states.removed, tone: 'neutral' };
  if (entry.events === null) return { words: SUBSCRIBERS_COPY.states.streams, tone: 'neutral' };
  if (entry.state === 'active') return { words: SUBSCRIBERS_COPY.states.active, tone: 'ok' };
  if (entry.state === 'superseded') return { words: SUBSCRIBERS_COPY.states.superseded, tone: 'neutral' };
  return { words: SUBSCRIBERS_COPY.states.inert, tone: 'warn' };
}

function whereWords(entry: SubscriberEntryV2): string {
  if (entry.kind === 'webhook') return SUBSCRIBERS_COPY.byWebhook;
  if (entry.listening !== null) return SUBSCRIBERS_COPY.listening(entry.listening.host, entry.listening.port);
  return entry.listenError === 'PORT_IN_USE' ? SUBSCRIBERS_COPY.portInUse : SUBSCRIBERS_COPY.notListening;
}

/** The secrets a subscriber version takes, each made at a terminal. */
function secretsOf(entry: SubscriberEntryV2): { label: string; command: TerminalCommand }[] {
  const { subscriberId, version } = entry;
  if (entry.kind === 'sse')
    return [
      { label: SUBSCRIBERS_COPY.token, command: { kind: 'subscriberToken', subscriberId, version, action: 'create' } },
      {
        label: SUBSCRIBERS_COPY.tokenRotate,
        command: { kind: 'subscriberToken', subscriberId, version, action: 'rotate' },
      },
    ];
  return [
    { label: SUBSCRIBERS_COPY.secret, command: { kind: 'subscriberSecret', subscriberId, version, action: 'create' } },
    {
      label: SUBSCRIBERS_COPY.secretRotate,
      command: { kind: 'subscriberSecret', subscriberId, version, action: 'rotate' },
    },
    { label: SUBSCRIBERS_COPY.url, command: { kind: 'subscriberUrl', subscriberId, version } },
  ];
}

function SubscriberCard({
  id,
  versions,
  onApprove,
  onRemoved,
}: {
  id: string;
  versions: SubscriberEntryV2[];
  onApprove: (entry: SubscriberEntryV2) => Promise<void>;
  onRemoved: (id: string) => Promise<void>;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState<TerminalOutcome | null>(null);
  const live = versions.filter((entry) => entry.revokedAt === null);
  const entry = live[0] ?? (versions[0] as SubscriberEntryV2);
  const removed = live.length === 0;
  const state = stateOf(entry);
  const canApprove = !removed && entry.events !== null && entry.state === 'inert';
  const openable = isSubscriberId(id);

  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.cli({ kind: 'eventsSubscriberRemove', subscriberId: id });
      if (result.status === 'ok') await onRemoved(id);
      else setProblem(result.status === 'failed' ? result.message : SUBSCRIBERS_COPY.unreadable);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const atTerminal = async (command: TerminalCommand) => {
    setProblem(null);
    try {
      setOpened(await bridge.openInTerminal(command));
    } catch (error) {
      setProblem(errorMessage(error));
    }
  };

  const approve = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onApprove(entry);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      <section aria-label={`Subscriber ${id}`} data-subscriber={id}>
        <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
          <div className="flex flex-wrap items-center gap-(--cue-space-2)">
            <span className="font-semibold text-(length:--cue-text-emphasis) text-fg">
              <UntrustedText text={id} />
            </span>
            <Chip tone="neutral" variant="tag" data-slot="subscriber-kind">
              {SUBSCRIBERS_COPY.kinds[entry.kind]}
            </Chip>
            <Chip tone={state.tone} data-slot="subscriber-state">
              {state.words}
            </Chip>
            <span className="text-(length:--cue-text-label) text-fg-muted">
              {SUBSCRIBERS_COPY.version(entry.version)}
            </span>
            {removed || !openable ? null : (
              <span className="ml-auto flex flex-wrap gap-(--cue-space-2)">
                {canApprove ? (
                  <Button size="sm" variant="primary" loading={busy} onClick={() => void approve()}>
                    {SUBSCRIBERS_COPY.approve}
                  </Button>
                ) : null}
                <Button size="sm" variant="danger-outline" disabled={busy} onClick={() => void remove()}>
                  {SUBSCRIBERS_COPY.remove}
                </Button>
              </span>
            )}
          </div>
          <div data-slot="subscriber-receives" className="flex flex-col gap-(--cue-space-1)">
            {entry.events === null ? (
              <p className="text-fg-muted">{SUBSCRIBERS_COPY.streamsOnly}</p>
            ) : (
              <>
                <p className="flex flex-wrap items-baseline gap-x-(--cue-space-2) text-fg">
                  <span className="text-fg-muted">{SUBSCRIBERS_COPY.receives}</span>
                  {entry.events.patterns.map((pattern) => (
                    <span key={pattern} className="font-mono">
                      <UntrustedText text={pattern} />
                    </span>
                  ))}
                  <span className="text-fg-muted">
                    <UntrustedText text={SUBSCRIBERS_COPY.inNamespaces(entry.events.namespaces)} />
                  </span>
                </p>
                <p className="text-(length:--cue-text-label) text-fg-muted">
                  {SUBSCRIBERS_COPY.content[entry.events.content]}
                </p>
              </>
            )}
          </div>
          <FactsLine
            facts={[
              <span key="where" data-slot="subscriber-where">
                {whereWords(entry)}
              </span>,
              <span key="backlog" data-slot="subscriber-backlog">
                {SUBSCRIBERS_COPY.backlog(entry.backlog)}
              </span>,
              entry.lastDeliveredAt === null ? null : (
                <span key="last">
                  {SUBSCRIBERS_COPY.lastDelivered} <Short at={entry.lastDeliveredAt} />
                </span>
              ),
            ]}
          />
          {removed || !openable ? null : (
            <div className="flex flex-col gap-(--cue-space-1)">
              <div className="flex flex-wrap gap-(--cue-space-2)">
                {secretsOf(entry).map(({ label, command }) => (
                  <Button key={label} size="sm" variant="ghost" onClick={() => void atTerminal(command)}>
                    {label}
                  </Button>
                ))}
              </div>
              <p className="text-(length:--cue-text-label) text-fg-subtle">{SUBSCRIBERS_COPY.secretsAtTerminal}</p>
              {opened === null ? null : <TerminalResult outcome={opened} />}
            </div>
          )}
          {problem === null ? null : <Problem message={problem} />}
        </Panel>
      </section>
    </li>
  );
}

function Subscribers() {
  const bridge = useBridge();
  const call = useCall<unknown>({ kind: 'eventsSubscribersList' });
  useReloadOnServiceTurn(call.reload);
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<PreparedSubscription | null>(null);
  const subscribers = useMemo(():
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | { state: 'ready'; value: SubscriberEntryV2[] } => {
    if (call.result.state === 'loading') return { state: 'loading' };
    if (call.result.state === 'error') return { state: 'error', message: call.result.message };
    try {
      return { state: 'ready', value: readSubscribers(call.result.value) };
    } catch {
      return { state: 'error', message: SUBSCRIBERS_COPY.unreadable };
    }
  }, [call.result]);
  const groups = subscribers.state === 'ready' ? bySubscriber(subscribers.value) : [];

  if (adding)
    return (
      <AddSubscriber
        taken={new Set(groups.map((group) => group.id))}
        onClose={() => setAdding(false)}
        onAdded={async (id) => {
          setAdding(false);
          setSaid(SUBSCRIBERS_COPY.added(id));
          await call.reload();
        }}
      />
    );

  const approve = async (entry: SubscriberEntryV2) => {
    setProblem(null);
    setSaid(null);
    const prepared = await prepareSubscription(bridge, entry.subscriberId, entry.version);
    if (prepared.ok) setReview(prepared.prepared);
    else setProblem(prepared.problem);
  };

  return (
    <section aria-label="Subscribers" className="flex flex-col gap-(--cue-space-4)">
      <div className="flex flex-wrap items-start gap-(--cue-space-3)">
        <p className="min-w-60 flex-1 text-fg-muted">{SUBSCRIBERS_COPY.intro}</p>
        <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
          {SUBSCRIBERS_COPY.add}
        </Button>
      </div>
      {said === null ? null : (
        <p role="status" className="text-ok">
          <UntrustedText text={said} />
        </p>
      )}
      {problem === null ? null : <Problem message={problem} />}
      {subscribers.state === 'loading' ? (
        <Spinner label={COPY.loading} />
      ) : subscribers.state === 'error' ? (
        <Panel className="p-(--cue-space-4)">
          <Problem message={subscribers.message} />
        </Panel>
      ) : groups.length === 0 ? (
        <Panel>
          <EmptyState title={SUBSCRIBERS_COPY.empty} />
        </Panel>
      ) : (
        <ul className="flex flex-col gap-(--cue-space-3)">
          {groups.map((group) => (
            <SubscriberCard
              key={group.id}
              id={group.id}
              versions={group.versions}
              onApprove={approve}
              onRemoved={async (id) => {
                setSaid(SUBSCRIBERS_COPY.removed(id));
                await call.reload();
              }}
            />
          ))}
        </ul>
      )}
      {review === null ? null : (
        <SubscriptionReview
          prepared={review}
          onApproved={() => {
            setSaid(SUBSCRIBERS_COPY.approved(review.subscriberId));
            setReview(null);
            void call.reload();
          }}
          onClosed={(closed) => {
            setReview(null);
            if (closed !== null) setProblem(closed);
          }}
          onDone={() => {
            setReview(null);
            void call.reload();
          }}
        />
      )}
    </section>
  );
}

/**
 * The tab, from 0.36.0: an older event service has subscribers without events, managed at its terminal, and says
 * so. Nothing shows while the event service's version is being read, so the screen's other tabs say they are loading.
 */
export function SubscribersTab() {
  const { eventsVersion } = useAppData();
  if (eventsVersion === 'absent' || eventsVersion.state === 'loading') return null;
  if (eventsVersion.state === 'error') return <Problem message={eventsVersion.message} />;
  if (!supports(eventsVersion.value, 'workflows'))
    return <NeedsNewerCli feature="workflows" installed={eventsVersion.value} />;
  return <Subscribers />;
}
