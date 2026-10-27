import { Button, Chip, EmptyState, Input, Link, PageShell, Panel, Select, Spinner } from '@cueplusplus/ui';
import { ChevronLeft } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { NeedsNewerCli } from '../../components/NeedsNewerCli.tsx';
import { OutsideText } from '../../components/OutsideText.tsx';
import { ScreenState } from '../../components/ScreenState.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY, type Screen } from '../../copy.ts';
import { type Loadable, useAppData } from '../../data.tsx';
import { isPersonId, isPersonLabel, isSearchHandle } from '../../grammar.ts';
import { type Call, errorMessage } from '../../ipc.ts';
import type { JoinedMessage } from '../../messages/join.ts';
import type { StoryContext } from '../../messages/story.ts';
import { NavigationProvider, takeDestination, useNavigate } from '../../navigation.tsx';
import {
  envelopedText,
  folded,
  handleParts,
  type PersonMessageView,
  type PersonView,
  questionProblem,
  readPerson,
  readSearchResult,
  type SearchHitView,
} from '../../search.ts';
import { StatusChip } from '../MessageParts.tsx';
import { MessageStory } from '../MessageStory.tsx';
import { timeWords } from '../Messages.tsx';
import { PEOPLE_COPY, SEARCH_COPY } from './copy.ts';
import {
  ChannelMark,
  PersonName,
  SentAt,
  storyOf,
  storyReads,
  useAccountsInfo,
  useIndexOnOpen,
  usePeople,
  useSearchStatus,
  useSearchSupported,
  useStories,
  useStoryTakes,
  whereLine,
} from './parts.tsx';
import { SEARCH_LIMIT } from './Search.tsx';

/** How many of a person's messages their page reads: as many as one join reads (`activity items --ids`). */
export const PERSON_LIMIT = 50;

function Frame({ children }: { children: ReactNode }) {
  return (
    <PageShell title={PEOPLE_COPY.title} subtitle={PEOPLE_COPY.about} width="wide">
      <div className="flex flex-col gap-(--cue-space-4)">{children}</div>
    </PageShell>
  );
}

/**
 * People (0.35.0, design 2026-10-26-local-search S5, board `Person`): everyone a kept message is from. A person is a set
 * of exact handles — a Gmail address, a Slack user — joined on their own only where one handle is seen in several
 * accounts; a Gmail person and a Slack person are one only when the person says so, and names never join anyone.
 */
export function People({ onScreen }: { onScreen?: (screen: Screen) => void }) {
  const { supported, installed } = useSearchSupported();
  // A person another screen asked for (`navigation.tsx`), by their id: read once, as the screen opens.
  const [requested] = useState(() => {
    const person = takeDestination('people')?.person ?? null;
    return person !== null && isPersonId(person) ? person : null;
  });
  if (!supported) {
    return (
      <Frame>
        <NeedsNewerCli feature="search" installed={installed} />
      </Frame>
    );
  }
  return (
    <NavigationProvider onScreen={onScreen}>
      <PeopleView requested={requested} onScreen={onScreen} />
    </NavigationProvider>
  );
}

function PeopleView({
  requested,
  onScreen,
}: {
  requested: string | null;
  onScreen?: ((screen: Screen) => void) | undefined;
}) {
  const navigate = useNavigate();
  const { status, reload: reloadStatus } = useSearchStatus(true);
  const { people, loaded, reload } = usePeople();
  useIndexOnOpen(true, () => {
    void reload();
    void reloadStatus();
  });
  const [open, setOpen] = useState<string | null>(requested);
  const days = status.state === 'ready' ? status.value.retentionDays : 30;
  if (open !== null) {
    return (
      <PersonPage
        id={open}
        people={people}
        days={days}
        onBack={() => {
          setOpen(null);
          void reload();
        }}
        onPeopleChanged={() => void reload()}
        onScreen={onScreen}
      />
    );
  }
  const off = status.state === 'ready' && !status.value.on;
  return (
    <Frame>
      <ScreenState value={loaded}>
        {(list) =>
          list.length === 0 ? (
            <Panel>
              <EmptyState
                title={PEOPLE_COPY.none}
                hint={off ? `${SEARCH_COPY.off} ${SEARCH_COPY.offEmpty}` : PEOPLE_COPY.noneHint}
                action={
                  off && navigate !== null ? (
                    <Button size="sm" onClick={() => navigate({ screen: 'settings', section: 'search' })}>
                      {SEARCH_COPY.settings}
                    </Button>
                  ) : undefined
                }
              />
            </Panel>
          ) : (
            <ul className="flex flex-col gap-(--cue-space-2)">
              {list.map((person) => (
                <PersonRow key={person.id} person={person} onOpen={() => setOpen(person.id)} />
              ))}
            </ul>
          )
        }
      </ScreenState>
      {off && people.length > 0 ? (
        <p role="status" className="text-fg-muted">
          <span className="font-medium text-fg">{SEARCH_COPY.off}</span> {SEARCH_COPY.offKept}
        </p>
      ) : null}
    </Frame>
  );
}

/** One person in the list: who, by which handles, how many messages, and when they last wrote. */
function PersonRow({ person, onOpen }: { person: PersonView; onOpen: () => void }) {
  return (
    <li data-person={person.id}>
      <Panel>
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full cursor-pointer flex-wrap items-center gap-(--cue-space-3) p-(--cue-space-4) text-left transition-colors duration-fast hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
            <span className="flex flex-wrap items-center gap-(--cue-space-2) font-medium text-fg">
              <PersonName person={person} />
              {person.linked ? (
                <Chip tone="neutral" variant="tinted">
                  {PEOPLE_COPY.joinedByYou}
                </Chip>
              ) : null}
            </span>
            <Handles person={person} />
          </span>
          <span className="flex flex-col items-end gap-(--cue-space-1) text-(length:--cue-text-label) text-fg-subtle">
            <span>{PEOPLE_COPY.messages(person.count)}</span>
            {person.lastAt === null ? null : (
              <span>
                {PEOPLE_COPY.lastWrote} <SentAt at={person.lastAt} />
              </span>
            )}
          </span>
        </button>
      </Panel>
    </li>
  );
}

/** A person's handles, each by its channel: an address in Gmail, a user in a Slack workspace. */
function Handles({ person }: { person: PersonView }) {
  return (
    <span className="flex flex-wrap items-center gap-x-(--cue-space-3) gap-y-(--cue-space-1) text-(length:--cue-text-ui) text-fg-muted">
      {person.handles.map(({ handle }) => {
        const { channel, shown } = handleParts(handle);
        return (
          <span key={handle} className="inline-flex items-center gap-(--cue-space-1)" data-handle={handle}>
            {channel === null ? null : <ChannelMark channel={channel} />}
            <OutsideText text={shown} />
          </span>
        );
      })}
    </span>
  );
}

type PersonRead = { person: PersonView; messages: PersonMessageView[]; more: boolean };

/** `search person <id>`, read when the page opens and again on `reload`. */
function usePerson(id: string): { read: Loadable<PersonRead>; reload: () => Promise<void> } {
  const bridge = useBridge();
  const [read, setRead] = useState<Loadable<PersonRead>>({ state: 'loading' });
  const asked = useRef(0);
  const reload = useCallback(async () => {
    const ask = ++asked.current;
    let next: Loadable<PersonRead>;
    try {
      const result = await bridge.cli({ kind: 'searchPerson', personId: id, limit: PERSON_LIMIT });
      if (result.status === 'ok') {
        const person = readPerson(result.data);
        next =
          person === null ? { state: 'error', message: SEARCH_COPY.unreadable } : { state: 'ready', value: person };
      } else if (result.status === 'failed' && result.code === 'NOT_FOUND') {
        next = { state: 'error', message: PEOPLE_COPY.gone };
      } else {
        next = { state: 'error', message: result.status === 'failed' ? result.message : SEARCH_COPY.unreadable };
      }
    } catch (error) {
      next = { state: 'error', message: errorMessage(error) };
    }
    if (ask === asked.current) setRead(next);
  }, [bridge, id]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { read, reload };
}

/** A change to the person's own data — joined, parted, named — applied at once, and what it came to. */
function usePeopleChange(after: () => void) {
  const bridge = useBridge();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; ok: boolean } | null>(null);
  const run = async (key: string, call: Call, done: string) => {
    setBusy(key);
    setSaid(null);
    try {
      const result = await bridge.cli(call);
      if (result.status === 'ok') {
        setSaid({ text: done, ok: true });
        after();
      } else {
        setSaid({
          text:
            result.status === 'failed'
              ? [result.message, result.hint].filter(Boolean).join(' ')
              : SEARCH_COPY.unreadable,
          ok: false,
        });
      }
    } catch (error) {
      setSaid({ text: errorMessage(error), ok: false });
    } finally {
      setBusy(null);
    }
  };
  return { busy, said, run, setSaid };
}

/** What a name is to compare by: the person's own, else the latest a sender gave, case-folded. */
function nameKey(person: PersonView): string | null {
  const name = person.label ?? (person.name === null ? null : envelopedText(person.name));
  const key = name === null ? '' : folded(name).trim();
  return key === '' ? null : key;
}

/**
 * One person's page (board `Person`): who they are, by which handles and in which accounts; joining and parting them,
 * which only the person does; the name the person knows them by; and what they asked, newest first, each with what was
 * done with it — searchable on this Mac, by their words and by their meaning.
 */
function PersonPage({
  id,
  people,
  days,
  onBack,
  onPeopleChanged,
  onScreen,
}: {
  id: string;
  people: readonly PersonView[];
  days: number;
  onBack: () => void;
  onPeopleChanged: () => void;
  onScreen?: ((screen: Screen) => void) | undefined;
}) {
  const bridge = useBridge();
  const { installation } = useAppData();
  const home = installation.state === 'ready' ? (installation.value.home ?? null) : null;
  const context: StoryContext = useMemo(() => ({ time: timeWords, home }), [home]);
  const accounts = useAccountsInfo();
  const { read, reload } = usePerson(id);
  const changed = () => {
    void reload();
    onPeopleChanged();
  };
  const change = usePeopleChange(changed);
  const [other, setOther] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [found, setFound] = useState<Loadable<SearchHitView[]> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const shown = read.state === 'ready' ? read.value : null;
  const messages = found?.state === 'ready' ? found.value : (shown?.messages ?? null);
  const toJoin = useMemo(
    () => (messages === null ? null : messages.map((each) => ({ sourceId: each.sourceId, eventId: each.eventId }))),
    [messages],
  );
  const stories = useStories(toJoin, { days, aliases: accounts.aliases });
  const joinedOf = (sourceId: string): JoinedMessage | null | undefined =>
    stories === null ? undefined : (stories.bySource.get(sourceId) ?? null);
  // Who has each message (0.35.0), read as Messages reads it once a story is open: its Who has it, from here too.
  const storyTakes = useStoryTakes(open !== null);
  const reads = useMemo(
    () =>
      stories === null
        ? null
        : storyReads(stories, days, accounts, {
            takes: storyTakes.takes,
            taking: storyTakes.taking,
            readAt: storyTakes.readAt,
          }),
    [stories, days, accounts, storyTakes.takes, storyTakes.taking, storyTakes.readAt],
  );
  const opened =
    open === null || stories === null || reads === null
      ? undefined
      : storyOf(stories, open, reads, messages?.find((each) => each.sourceId === open)?.account);

  const searchHere = async () => {
    const why = questionProblem(draft);
    setProblem(why);
    if (why !== null) return;
    setFound({ state: 'loading' });
    try {
      const result = await bridge.cli({ kind: 'searchQuery', text: draft.trim(), person: id, limit: SEARCH_LIMIT });
      const hits = result.status === 'ok' ? readSearchResult(result.data) : null;
      setFound(
        hits !== null
          ? { state: 'ready', value: hits.hits }
          : { state: 'error', message: result.status === 'failed' ? result.message : SEARCH_COPY.unreadable },
      );
    } catch (error) {
      setFound({ state: 'error', message: errorMessage(error) });
    }
  };

  if (opened !== undefined && reads !== null) {
    return (
      <MessageStory
        listed={opened}
        reads={reads}
        context={context}
        onBack={() => setOpen(null)}
        onScreen={onScreen}
        onChanged={storyTakes.reload}
      />
    );
  }

  const back = (
    <Button variant="ghost" size="sm" icon={ChevronLeft} onClick={onBack} className="self-start">
      {PEOPLE_COPY.back}
    </Button>
  );
  if (shown === null) {
    return (
      <PageShell width="wide" eyebrow={back} title={PEOPLE_COPY.someone}>
        <ScreenState value={read}>{() => null}</ScreenState>
      </PageShell>
    );
  }
  const { person } = shown;
  const others = people.filter((each) => each.id !== person.id);
  const key = nameKey(person);
  const sameName = key === null ? [] : others.filter((each) => nameKey(each) === key);
  const counts = { replied: 0, done: 0, waiting: 0 };
  for (const message of shown.messages) {
    const kind = joinedOf(message.sourceId)?.status.kind;
    if (kind === 'replied' || kind === 'done' || kind === 'waiting') counts[kind] += 1;
  }
  const typedLabel = label ?? person.label ?? '';
  const saveLabel = () => {
    const text = typedLabel.trim();
    if (!isPersonLabel(text)) {
      change.setSaid({ text: PEOPLE_COPY.nameRefused, ok: false });
      return;
    }
    void change.run('label', { kind: 'searchLabel', personId: person.id, label: text }, PEOPLE_COPY.saved);
  };

  return (
    <PageShell
      width="wide"
      eyebrow={back}
      title={
        <span className="inline-flex flex-wrap items-center gap-(--cue-space-2)">
          <PersonName person={person} />
          {person.label === null && person.name !== null ? (
            <Chip tone="warn" variant="tag" data-slot="from-outside-label">
              {COPY.fromOutside}
            </Chip>
          ) : null}
          {person.linked ? (
            <Chip tone="neutral" variant="tinted">
              {PEOPLE_COPY.joinedByYou}
            </Chip>
          ) : null}
        </span>
      }
      subtitle={PEOPLE_COPY.about1}
    >
      <div className="flex flex-col gap-(--cue-space-4)">
        <section aria-label={PEOPLE_COPY.title}>
          <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
            <ul className="flex flex-col">
              {person.handles.map(({ handle, name }) => {
                const { channel, shown: shownHandle } = handleParts(handle);
                return (
                  <li
                    key={handle}
                    data-handle={handle}
                    className="flex flex-wrap items-center gap-(--cue-space-3) border-border border-t py-(--cue-space-2) first:border-t-0"
                  >
                    <span className="w-24 shrink-0 text-fg-muted">
                      {channel === 'gmail' ? PEOPLE_COPY.gmail : channel === 'slack' ? PEOPLE_COPY.slack : ''}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-(--cue-space-2)">
                      <OutsideText text={shownHandle} />
                      {name === null ? null : (
                        <span className="text-(length:--cue-text-ui) text-fg-muted">
                          {PEOPLE_COPY.gave} <OutsideText text={name} />
                        </span>
                      )}
                    </span>
                    {person.handles.length > 1 && isSearchHandle(handle) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={change.busy === `unlink:${handle}`}
                        disabled={change.busy !== null}
                        onClick={() =>
                          void change.run(`unlink:${handle}`, { kind: 'searchUnlink', handle }, PEOPLE_COPY.separated)
                        }
                      >
                        {PEOPLE_COPY.separate}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="text-(length:--cue-text-label) text-fg-subtle">
              {person.linked ? PEOPLE_COPY.joinedLinked : PEOPLE_COPY.joinedAuto}
              {person.handles.length > 1 ? ` ${PEOPLE_COPY.separateWhy}` : ''}
            </p>
            <div className="flex flex-wrap gap-(--cue-space-3)" data-slot="person-counts">
              <Stat value={person.count} words={PEOPLE_COPY.messagesIn(person.count, days)} />
              <Stat value={counts.replied} words={PEOPLE_COPY.replied} />
              <Stat value={counts.done} words={PEOPLE_COPY.done} />
              <Stat value={counts.waiting} words={PEOPLE_COPY.waiting} />
            </div>
          </Panel>
        </section>
        {change.said === null ? null : (
          <p role={change.said.ok ? 'status' : 'alert'} className={change.said.ok ? 'text-fg' : 'text-danger'}>
            <UntrustedText text={change.said.text} />
          </p>
        )}
        {sameName.length === 0 ? null : (
          <div className="flex flex-col gap-(--cue-space-2)" data-slot="same-name">
            <p className="text-fg-muted">{PEOPLE_COPY.sameName}</p>
            <div className="flex flex-wrap gap-(--cue-space-2)">
              {sameName.slice(0, 3).map((each) => (
                <Button
                  key={each.id}
                  size="sm"
                  variant="secondary"
                  disabled={change.busy !== null}
                  onClick={() =>
                    void change.run(
                      `link:${each.id}`,
                      { kind: 'searchLink', personId: person.id, otherId: each.id },
                      PEOPLE_COPY.joined,
                    )
                  }
                >
                  {PEOPLE_COPY.sameNameJoin}: <PersonName person={each} />
                </Button>
              ))}
            </div>
          </div>
        )}
        <section aria-label={PEOPLE_COPY.sameAs}>
          <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
            <span className="font-medium text-fg">{PEOPLE_COPY.sameAs}</span>
            <p className="text-fg-muted">{PEOPLE_COPY.sameAsWhy}</p>
            <div className="flex flex-wrap items-center gap-(--cue-space-2)">
              <Select
                aria-label={PEOPLE_COPY.sameAs}
                size="sm"
                placeholder={PEOPLE_COPY.choose}
                items={others.map((each) => ({ value: each.id, label: <PersonName person={each} /> }))}
                value={other}
                onValueChange={(value) => setOther(value)}
                disabled={others.length === 0}
              />
              <Button
                size="sm"
                disabled={other === null || change.busy !== null}
                loading={change.busy === 'link'}
                onClick={() => {
                  if (other === null) return;
                  void change.run(
                    'link',
                    { kind: 'searchLink', personId: person.id, otherId: other },
                    PEOPLE_COPY.joined,
                  );
                  setOther(null);
                }}
              >
                {PEOPLE_COPY.join}
              </Button>
            </div>
          </Panel>
        </section>
        <section aria-label={PEOPLE_COPY.name}>
          <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
            <form
              className="flex flex-wrap items-center gap-(--cue-space-2)"
              onSubmit={(event) => {
                event.preventDefault();
                saveLabel();
              }}
            >
              <Input
                className="min-w-0 flex-1"
                aria-label={PEOPLE_COPY.name}
                placeholder={PEOPLE_COPY.name}
                value={typedLabel}
                spellCheck={false}
                autoComplete="off"
                onValueChange={(value: string) => setLabel(value)}
              />
              <Button type="submit" size="sm" loading={change.busy === 'label'} disabled={change.busy !== null}>
                {PEOPLE_COPY.save}
              </Button>
            </form>
            <p className="text-(length:--cue-text-label) text-fg-subtle">{PEOPLE_COPY.nameWhy}</p>
          </Panel>
        </section>
        <section aria-label={PEOPLE_COPY.asked}>
          <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
            <div className="flex flex-wrap items-center gap-(--cue-space-2)">
              <h2 className="flex-1 font-semibold text-fg">{PEOPLE_COPY.asked}</h2>
              <span className="text-(length:--cue-text-label) text-fg-subtle">{PEOPLE_COPY.newest}</span>
            </div>
            <form
              className="flex flex-wrap items-center gap-(--cue-space-2)"
              onSubmit={(event) => {
                event.preventDefault();
                void searchHere();
              }}
            >
              <Input
                className="min-w-0 flex-1"
                type="search"
                aria-label={PEOPLE_COPY.searchField}
                placeholder={PEOPLE_COPY.searchPlaceholder}
                value={draft}
                spellCheck={false}
                autoComplete="off"
                onValueChange={(value: string) => {
                  setDraft(value);
                  setProblem(null);
                }}
              />
              <Button type="submit" variant="primary" size="sm">
                {PEOPLE_COPY.search}
              </Button>
              {found === null ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft('');
                    setFound(null);
                  }}
                >
                  {PEOPLE_COPY.clear}
                </Button>
              )}
            </form>
            {problem === null ? null : (
              <p role="status" className="text-fg-muted">
                {problem}
              </p>
            )}
            {found?.state === 'ready' ? (
              <p className="text-(length:--cue-text-label) text-fg-subtle">
                {PEOPLE_COPY.matched(found.value.length)}{' '}
                {onScreen === undefined ? null : (
                  <Link
                    href="#search"
                    onClick={(event) => {
                      event.preventDefault();
                      onScreen('search');
                    }}
                  >
                    {PEOPLE_COPY.askAll} ›
                  </Link>
                )}
              </p>
            ) : null}
            {found?.state === 'loading' ? <Spinner label={COPY.loading} /> : null}
            {found?.state === 'error' ? (
              <p role="alert" className="text-danger">
                <UntrustedText text={found.message} />
              </p>
            ) : null}
            {stories?.problem ? (
              <p role="alert" className="text-danger">
                {SEARCH_COPY.storyProblem} <UntrustedText text={stories.problem} />
              </p>
            ) : null}
            {messages === null ? null : messages.length === 0 ? (
              <p className="text-fg-muted">{found === null ? PEOPLE_COPY.nothingKept : PEOPLE_COPY.noMatch}</p>
            ) : (
              <ul className="flex flex-col" data-slot="person-messages">
                {messages.map((message) => (
                  <AskedRow
                    key={message.sourceId}
                    message={message}
                    joined={joinedOf(message.sourceId)}
                    onOpen={() => setOpen(message.sourceId)}
                  />
                ))}
              </ul>
            )}
            {found === null && shown.more ? <p className="text-fg-muted">{PEOPLE_COPY.more}</p> : null}
            <p className="text-(length:--cue-text-label) text-fg-subtle">{PEOPLE_COPY.footnote}</p>
          </Panel>
        </section>
      </div>
    </PageShell>
  );
}

/** A count and its words, in the person's header. */
function Stat({ value, words }: { value: number; words: string }) {
  return (
    <span className="flex min-w-24 flex-col rounded-control bg-surface-2 px-(--cue-space-3) py-(--cue-space-2)">
      <span className="font-semibold text-(length:--cue-text-title) text-fg tabular-nums">
        {value.toLocaleString()}
      </span>
      <span className="text-(length:--cue-text-label) text-fg-subtle">{words}</span>
    </span>
  );
}

/** One thing a person asked: when, its line and where, and how far it got, opening its story once the join has it. */
function AskedRow({
  message,
  joined,
  onOpen,
}: {
  message: { sourceId: string; channel: 'gmail' | 'slack'; account: { alias: string }; at: number; line: string };
  joined: JoinedMessage | null | undefined;
  onOpen: () => void;
}) {
  const body = (
    <>
      <span className="w-20 shrink-0 text-(length:--cue-text-label) text-fg-subtle">
        <SentAt at={message.at} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
        <span className="font-medium text-fg">
          <OutsideText text={message.line} />
        </span>
        <span className="text-(length:--cue-text-label) text-fg-subtle">
          {whereLine(message.channel, message.account.alias)}
        </span>
      </span>
      <span className="shrink-0">{joined ? <StatusChip message={joined} /> : null}</span>
    </>
  );
  const row =
    'flex w-full items-center gap-(--cue-space-3) border-border border-t px-(--cue-space-2) py-(--cue-space-2) text-left';
  return (
    <li data-asked={message.sourceId}>
      {joined ? (
        <button
          type="button"
          onClick={onOpen}
          className={`${row} cursor-pointer rounded-control transition-colors duration-fast hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus`}
        >
          {body}
        </button>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}
