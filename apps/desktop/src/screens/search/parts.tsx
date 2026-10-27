/**
 * The parts Search, People and Settings → Search on this Mac share (0.35.0, design 2026-10-26-local-search §8): the
 * Messages tabs, where Search's status is read and the indexer is run when a screen opens (S10), the line that says
 * nothing leaves this Mac, a message's story joined as the Messages screen joins it (S4), and a found message's card.
 */
import { Button, Chip, Panel } from '@cueplusplus/ui';
import { Hash, Lock, Mail } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { OutsideText } from '../../components/OutsideText.tsx';
import { COPY, type Screen } from '../../copy.ts';
import { type Loadable, useAppData } from '../../data.tsx';
import { supports } from '../../gates.ts';
import { useReloadOnReturn } from '../../hooks/use-reload-on-return.ts';
import { errorMessage, type Product } from '../../ipc.ts';
import { type AccountsInfo, readAccounts } from '../../messages/accounts.ts';
import type { JoinedMessage } from '../../messages/join.ts';
import type { Millis } from '../../messages/read.ts';
import { cardSteps, type StoryContext } from '../../messages/story.ts';
import {
  foundBy,
  handleParts,
  type JoinedStories,
  joinStories,
  type PersonView,
  readIndexRun,
  readPeople,
  readSearchStatus,
  type SearchHitView,
  type SearchStatusView,
  type ToJoin,
} from '../../search.ts';
import { Said, StatusChip } from '../MessageParts.tsx';
import type { MessagesReads } from '../Messages.tsx';
import { MESSAGES_TABS_COPY, PEOPLE_COPY, SEARCH_COPY } from './copy.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How long the indexer a screen runs as it opens may make vectors for, in seconds (S10). */
export const OPEN_INDEX_BUDGET = 10;

/** Messages' two parts (board `Search`): all messages, and asking about past ones. Each is a screen of its own. */
export function MessagesTabs({
  current,
  onScreen,
}: {
  current: 'messages' | 'search';
  onScreen?: ((screen: Screen) => void) | undefined;
}) {
  const tab = (target: 'messages' | 'search', label: string) => (
    <Button
      size="sm"
      variant={current === target ? 'secondary' : 'ghost'}
      aria-current={current === target ? 'page' : undefined}
      disabled={onScreen === undefined}
      onClick={() => (current === target ? undefined : onScreen?.(target))}
    >
      {label}
    </Button>
  );
  return (
    <nav aria-label={MESSAGES_TABS_COPY.label} className="flex flex-wrap items-center gap-(--cue-space-1)">
      {tab('messages', MESSAGES_TABS_COPY.all)}
      {tab('search', MESSAGES_TABS_COPY.ask)}
    </nav>
  );
}

/** Whether the installed core has Search (0.35.0). */
export function useSearchSupported(): { supported: boolean; installed: string | null } {
  const { installation } = useAppData();
  const installed = installation.state === 'ready' ? installation.value.version : null;
  return { supported: supports(installed, 'search'), installed };
}

/** Whether the event service is here and keeps the messages it saw (0.32.0): then a found event's story is read too. */
export function useEventsJoin(): boolean {
  const { installation, eventsVersion } = useAppData();
  const present = installation.state === 'ready' && installation.value.present.includes('events-daemon');
  return (
    present &&
    eventsVersion !== 'absent' &&
    eventsVersion.state === 'ready' &&
    supports(eventsVersion.value, 'messages')
  );
}

/** `search status`, read when the screen opens, again on `reload` and when the window has the focus again. */
export function useSearchStatus(enabled: boolean): {
  status: Loadable<SearchStatusView>;
  reload: () => Promise<void>;
} {
  const bridge = useBridge();
  const [status, setStatus] = useState<Loadable<SearchStatusView>>({ state: 'loading' });
  const asked = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const ask = ++asked.current;
    let next: Loadable<SearchStatusView>;
    try {
      const result = await bridge.cli({ kind: 'searchStatus' });
      if (result.status === 'ok') {
        const read = readSearchStatus(result.data);
        next = read === null ? { state: 'error', message: SEARCH_COPY.unreadable } : { state: 'ready', value: read };
      } else {
        next = { state: 'error', message: result.status === 'failed' ? result.message : SEARCH_COPY.unreadable };
      }
    } catch (error) {
      next = { state: 'error', message: errorMessage(error) };
    }
    if (ask === asked.current) setStatus(next);
  }, [bridge, enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useReloadOnReturn(reload);
  return { status, reload };
}

/**
 * Runs the indexer once as the screen opens (S10: when Search, People or Settings → Search opens), for a short budget,
 * and then `after`: what agents read since the last run is kept, and what is past its days goes. A run that finds
 * Search never on, or another run going, changes nothing.
 */
export function useIndexOnOpen(enabled: boolean, after?: () => void): void {
  const bridge = useBridge();
  const latest = useRef(after);
  latest.current = after;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    bridge
      .cli({ kind: 'searchIndex', budget: OPEN_INDEX_BUDGET })
      .then((result) => {
        const run = result.status === 'ok' ? readIndexRun(result.data) : null;
        if (live && run?.ran && !run.busy && run.taken + run.pruned + run.embedded > 0) latest.current?.();
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge, enabled]);
}

/** The people Search keeps, read when the screen opens and again on `reload`; null until the first read answers. */
export function usePeople(enabled = true): {
  people: PersonView[];
  loaded: Loadable<PersonView[]>;
  reload: () => Promise<void>;
} {
  const bridge = useBridge();
  const [loaded, setLoaded] = useState<Loadable<PersonView[]>>({ state: 'loading' });
  const asked = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const ask = ++asked.current;
    let next: Loadable<PersonView[]>;
    try {
      const result = await bridge.cli({ kind: 'searchPeople' });
      const people = result.status === 'ok' ? readPeople(result.data) : null;
      next =
        people !== null
          ? { state: 'ready', value: people }
          : { state: 'error', message: result.status === 'failed' ? result.message : SEARCH_COPY.unreadable };
    } catch (error) {
      next = { state: 'error', message: errorMessage(error) };
    }
    if (ask === asked.current) setLoaded(next);
  }, [bridge, enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { people: loaded.state === 'ready' ? loaded.value : [], loaded, reload };
}

/** The accounts the app reads (`accounts`), for the story's link into Gmail or Slack and the accounts' names. */
export function useAccountsInfo(): AccountsInfo {
  const bridge = useBridge();
  const { installation } = useAppData();
  const present = installation.state === 'ready' ? installation.value.present.join(',') : '';
  const [accounts, setAccounts] = useState<AccountsInfo>(() => ({
    aliases: new Map(),
    gmailAddresses: new Map(),
    slackTeams: new Map(),
  }));
  useEffect(() => {
    let live = true;
    void readAccounts(bridge, present === '' ? [] : (present.split(',') as Product[])).then((read) => {
      if (live) setAccounts(read);
    });
    return () => {
      live = false;
    };
  }, [bridge, present]);
  return accounts;
}

/**
 * Who a person is, in the words there are: the name the person gave them (their own words, as text); else the latest
 * name a sender gave, From outside; else their first handle.
 */
export function PersonName({ person }: { person: PersonView }) {
  if (person.label !== null) return <span data-slot="person-label">{person.label}</span>;
  if (person.name !== null) return <OutsideText text={person.name} />;
  const first = person.handles[0];
  return first === undefined ? (
    <span>{PEOPLE_COPY.someone}</span>
  ) : (
    <OutsideText text={handleParts(first.handle).shown} />
  );
}

/** Where the join reads activity from: as far back as Search keeps, Activity's days. */
export function joinSince(days: number, now: number = Date.now()): Millis {
  return now - Math.max(1, days) * DAY_MS;
}

/**
 * The stories of `messages`, joined as the Messages screen joins them (S4), read again whenever the messages change;
 * null while they are read.
 */
export function useStories(
  messages: readonly ToJoin[] | null,
  options: { days: number; aliases: ReadonlyMap<string, string> },
): JoinedStories | null {
  const bridge = useBridge();
  const withEvents = useEventsJoin();
  const [stories, setStories] = useState<JoinedStories | null>(null);
  const key = messages === null ? null : JSON.stringify(messages);
  const { days, aliases } = options;
  useEffect(() => {
    if (key === null) return;
    const wanted = JSON.parse(key) as ToJoin[];
    let live = true;
    setStories(null);
    joinStories(bridge, wanted, { since: joinSince(days), withEvents, aliases })
      .then((joined) => {
        if (live) setStories(joined);
      })
      .catch((error: unknown) => {
        if (live) setStories({ bySource: new Map(), activity: new Map(), events: [], problem: errorMessage(error) });
      });
    return () => {
      live = false;
    };
  }, [bridge, key, days, withEvents, aliases]);
  return stories;
}

/** What `MessageStory` reads beside the message: the join's own activity and events, and the accounts. */
export function storyReads(stories: JoinedStories, days: number, accounts: AccountsInfo): MessagesReads {
  return {
    since: joinSince(days),
    readAt: Date.now(),
    events: { state: 'ready', value: { messages: stories.events, before: null, more: false } },
    activity: { state: 'ready', value: stories.activity },
    accounts,
    // A story opened from Search shows what was done, not who has it now: Messages reads the takes.
    takes: 'off',
    taking: 'off',
  };
}

/** Searched on this Mac: nothing leaves it (§7) — said where a search ran on the checked local model, or by words. */
export function LocalLine({ why = SEARCH_COPY.localWhy }: { why?: string }) {
  return (
    <p
      className="flex items-start gap-(--cue-space-2) rounded-control bg-ok-soft px-(--cue-space-3) py-(--cue-space-2) text-fg"
      data-slot="search-local"
    >
      <Lock aria-hidden="true" className="mt-(--cue-space-1) size-(--cue-icon-sm) shrink-0 text-ok" />
      <span>
        <span className="font-medium">{SEARCH_COPY.local}</span> <span className="text-fg-muted">{why}</span>
      </span>
    </p>
  );
}

const FULL = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** When a message was sent: the time today, the day before; the whole moment on hover. */
export function SentAt({ at }: { at: Millis }) {
  const date = new Date(at);
  const today = date.toDateString() === new Date().toDateString();
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(undefined, FULL)}>
      {today
        ? date.toLocaleTimeString(undefined, { timeStyle: 'short' })
        : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
    </time>
  );
}

/** Gmail's or Slack's mark, beside where a message came in. */
export function ChannelMark({ channel }: { channel: 'gmail' | 'slack' }) {
  const Icon = channel === 'gmail' ? Mail : Hash;
  return <Icon aria-hidden="true" className="size-(--cue-icon-sm) shrink-0 text-fg-subtle" />;
}

/** Where a message came in, in words: `Gmail · acme/gmail`. */
export function whereLine(channel: 'gmail' | 'slack', alias: string): string {
  return `${channel === 'gmail' ? 'Gmail' : 'Slack'} · ${alias}`;
}

/** What was done with a message, as the Messages card says it: its steps, from the join; or that nothing was recorded. */
export function WhatWasDone({ joined, context }: { joined: JoinedMessage | null; context: StoryContext }) {
  const steps = joined === null ? [] : cardSteps(joined, context);
  return (
    <div
      className="flex flex-col gap-(--cue-space-1) border-accent border-l-2 pl-(--cue-space-3)"
      data-slot="search-done"
    >
      <span className="text-(length:--cue-text-label) font-medium text-fg-subtle">{SEARCH_COPY.done}</span>
      {steps.length === 0 ? (
        <span className="text-fg-muted">{SEARCH_COPY.nothingRecorded}</span>
      ) : (
        <span className="flex flex-wrap items-center gap-x-(--cue-space-2) gap-y-(--cue-space-1) text-fg">
          {steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps come in their order and never move.
            <span key={index} className="contents">
              {index === 0 ? null : (
                <span aria-hidden="true" className="text-fg-subtle">
                  ›
                </span>
              )}
              <span data-slot="search-step">
                <Said parts={step} />
              </span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * One message Search found (board `Search`): who it is from and where, its state from the join, what it is about and
 * the words around what was asked — each the sender's, From outside — what was done with it, how it was found, and
 * its story. Slack's mismatch and unrenderable are said on it, as the Slack server says them (§7).
 */
export function HitCard({
  hit,
  joined,
  context,
  onOpen,
  onPerson,
}: {
  hit: SearchHitView;
  /** Its story, once the join has read it; null when nothing recorded it, undefined while it is read. */
  joined: JoinedMessage | null | undefined;
  context: StoryContext;
  onOpen?: (() => void) | undefined;
  onPerson?: (() => void) | undefined;
}) {
  const found = foundBy(hit.rank);
  return (
    <li data-hit={hit.sourceId} data-channel={hit.channel}>
      <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <div className="flex flex-wrap items-center gap-(--cue-space-2)">
          <ChannelMark channel={hit.channel} />
          {hit.from === null ? null : (
            <span className="font-medium text-fg" data-slot="hit-from">
              <OutsideText text={hit.from} />
            </span>
          )}
          <span className="text-(length:--cue-text-label) text-fg-subtle">
            {whereLine(hit.channel, hit.account.alias)} · <SentAt at={hit.at} />
          </span>
          <Chip tone="warn" variant="tag" data-slot="from-outside-label">
            {COPY.fromOutside}
          </Chip>
          <span className="ml-auto">
            {joined === null || joined === undefined ? null : <StatusChip message={joined} />}
          </span>
        </div>
        {hit.direction === 'out' ? <span className="text-fg-muted">{SEARCH_COPY.sent}</span> : null}
        <span className="font-medium text-fg" data-slot="hit-line">
          <OutsideText text={hit.line} />
        </span>
        {hit.excerpt === '' ? null : (
          <p
            className="rounded-control bg-surface-2 px-(--cue-space-3) py-(--cue-space-2) text-fg"
            data-slot="hit-excerpt"
          >
            <OutsideText text={hit.excerpt} />
          </p>
        )}
        {joined === undefined ? null : <WhatWasDone joined={joined} context={context} />}
        {hit.flags.includes('mismatch') ? <p className="text-warn">{SEARCH_COPY.mismatch}</p> : null}
        {hit.flags.includes('unrenderable') ? <p className="text-warn">{SEARCH_COPY.unrenderable}</p> : null}
        {hit.partial ? <p className="text-fg-muted">{SEARCH_COPY.partial}</p> : null}
        <div className="flex flex-wrap items-center gap-(--cue-space-2)">
          <span className="flex-1 text-(length:--cue-text-label) text-fg-subtle">
            {found === null ? null : SEARCH_COPY.found[found]}
          </span>
          {onPerson === undefined ? null : (
            <Button size="sm" variant="ghost" onClick={onPerson}>
              {SEARCH_COPY.seePerson}
            </Button>
          )}
          {onOpen === undefined ? null : (
            <Button size="sm" variant="secondary" onClick={onOpen}>
              {SEARCH_COPY.open}
            </Button>
          )}
        </div>
      </Panel>
    </li>
  );
}
