import { Button, EmptyState, Input, Link, PageShell, Panel, Select, Spinner } from '@cueplusplus/ui';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { NeedsNewerCli } from '../../components/NeedsNewerCli.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY, type Screen } from '../../copy.ts';
import { type Loadable, useAppData } from '../../data.tsx';
import { errorMessage, type SearchQueryCall } from '../../ipc.ts';
import type { JoinedMessage, StatusKind } from '../../messages/join.ts';
import { type StoryContext, statusLabel } from '../../messages/story.ts';
import { NavigationProvider, useNavigate } from '../../navigation.tsx';
import {
  namedPeople,
  questionProblem,
  readSearchResult,
  type SearchResultView,
  type SearchStatusView,
  type SearchWindow,
  windowSince,
} from '../../search.ts';
import { MessageStory } from '../MessageStory.tsx';
import { MESSAGES_COPY, timeWords } from '../Messages.tsx';
import { SEARCH_COPY } from './copy.ts';
import {
  HitCard,
  LocalLine,
  MessagesTabs,
  PersonName,
  storyOf,
  storyReads,
  useAccountsInfo,
  useIndexOnOpen,
  usePeople,
  useSearchStatus,
  useSearchSupported,
  useStories,
  useStoryTakes,
} from './parts.tsx';

/** How many hits one search asks for: the most core gives, so a state narrows the best 50 (§6). */
export const SEARCH_LIMIT = 50;

const ANYONE = 'anyone';
const ANY_STATE = 'any';

function Frame({ onScreen, children }: { onScreen?: ((screen: Screen) => void) | undefined; children: ReactNode }) {
  return (
    <PageShell title={MESSAGES_COPY.title} subtitle={MESSAGES_COPY.about} width="wide">
      <div className="flex flex-col gap-(--cue-space-4)">
        <MessagesTabs current="search" onScreen={onScreen} />
        {children}
      </div>
    </PageShell>
  );
}

/**
 * Ask about past messages (0.35.0, design 2026-10-26-local-search §6, board `Search`): what people asked, found on this
 * Mac by its words and by its meaning (`search query`), each hit joined to what was done with it as the Messages screen
 * joins it (S4), and its story a press away. Only the person reads it: no agent searches (S13).
 */
export function Search({ onScreen }: { onScreen?: (screen: Screen) => void }) {
  const { supported, installed } = useSearchSupported();
  if (!supported) {
    return (
      <Frame onScreen={onScreen}>
        <NeedsNewerCli feature="search" installed={installed} />
      </Frame>
    );
  }
  return (
    <NavigationProvider onScreen={onScreen}>
      <SearchView onScreen={onScreen} />
    </NavigationProvider>
  );
}

interface Asked {
  text: string;
  person: string | null;
  window: SearchWindow;
}

function SearchView({ onScreen }: { onScreen?: ((screen: Screen) => void) | undefined }) {
  const bridge = useBridge();
  const navigate = useNavigate();
  const { installation } = useAppData();
  const home = installation.state === 'ready' ? (installation.value.home ?? null) : null;
  const { status, reload: reloadStatus } = useSearchStatus(true);
  const { people, reload: reloadPeople } = usePeople();
  const accounts = useAccountsInfo();
  useIndexOnOpen(true, () => {
    void reloadStatus();
    void reloadPeople();
  });
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [span, setSpan] = useState<SearchWindow>('kept');
  const [asked, setAsked] = useState<Asked | null>(null);
  const [result, setResult] = useState<Loadable<SearchResultView> | null>(null);
  const [state, setState] = useState<StatusKind | typeof ANY_STATE>(ANY_STATE);
  const [open, setOpen] = useState<string | null>(null);
  const askedNumber = useRef(0);
  const days = status.state === 'ready' ? status.value.retentionDays : 30;
  const context: StoryContext = useMemo(() => ({ time: timeWords, home }), [home]);

  const run = useCallback(
    async (next: Asked) => {
      const ask = ++askedNumber.current;
      setAsked(next);
      setResult({ state: 'loading' });
      setState(ANY_STATE);
      const since = windowSince(next.window);
      const call: SearchQueryCall = {
        kind: 'searchQuery',
        text: next.text,
        limit: SEARCH_LIMIT,
        ...(next.person === null ? {} : { person: next.person }),
        ...(since === undefined ? {} : { since }),
      };
      let shown: Loadable<SearchResultView>;
      try {
        const answer = await bridge.cli(call);
        if (answer.status === 'ok') {
          const read = readSearchResult(answer.data);
          shown = read === null ? { state: 'error', message: SEARCH_COPY.unreadable } : { state: 'ready', value: read };
        } else {
          shown = {
            state: 'error',
            message:
              answer.status === 'failed'
                ? [answer.message, answer.hint].filter(Boolean).join(' ')
                : SEARCH_COPY.unreadable,
          };
        }
      } catch (error) {
        shown = { state: 'error', message: errorMessage(error) };
      }
      if (ask === askedNumber.current) setResult(shown);
    },
    [bridge],
  );

  const ask = (text: string = draft) => {
    const why = questionProblem(text);
    setProblem(why);
    if (why !== null) return;
    void run({ text: text.trim(), person, window: span });
  };
  // From and When narrow a question already asked: it is asked again with them.
  const narrow = (next: { person?: string | null; window?: SearchWindow }) => {
    const chosen = { person: next.person === undefined ? person : next.person, window: next.window ?? span };
    setPerson(chosen.person);
    setSpan(chosen.window);
    if (asked !== null) void run({ text: asked.text, ...chosen });
  };

  const hits = result?.state === 'ready' ? result.value.hits : null;
  const toJoin = useMemo(
    () => (hits === null ? null : hits.map((hit) => ({ sourceId: hit.sourceId, eventId: hit.eventId }))),
    [hits],
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
      : storyOf(stories, open, reads, hits?.find((hit) => hit.sourceId === open)?.account);

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

  const known = status.state === 'ready' ? status.value : null;
  if (status.state === 'loading') {
    return (
      <Frame onScreen={onScreen}>
        <Spinner label={COPY.loading} />
      </Frame>
    );
  }
  if (known !== null && !known.on && known.kept.messages === 0) {
    return (
      <Frame onScreen={onScreen}>
        <Panel>
          <EmptyState
            title={SEARCH_COPY.off}
            hint={SEARCH_COPY.offEmpty}
            action={
              navigate === null ? undefined : (
                <Button size="sm" onClick={() => navigate({ screen: 'settings', section: 'search' })}>
                  {SEARCH_COPY.settings}
                </Button>
              )
            }
          />
        </Panel>
      </Frame>
    );
  }

  const suggested = asked === null ? [] : namedPeople(asked.text, people).filter((each) => each.id !== person);
  const states = stateChoices(hits ?? [], joinedOf);
  const shown = (hits ?? []).filter((hit) => {
    if (state === ANY_STATE) return true;
    return joinedOf(hit.sourceId)?.status.kind === state;
  });
  const narrowed = person !== null || span !== 'kept';

  return (
    <Frame onScreen={onScreen}>
      {status.state === 'error' ? (
        <p role="alert" className="text-danger">
          <UntrustedText text={status.message} />
        </p>
      ) : null}
      {known !== null && !known.on ? (
        <p role="status" className="text-fg-muted">
          <span className="font-medium text-fg">{SEARCH_COPY.off}</span> {SEARCH_COPY.offKept}
        </p>
      ) : null}
      {known?.words === 'needs-newer-node' ? <p className="text-warn">{SEARCH_COPY.needsNode}</p> : null}
      <section aria-label={SEARCH_COPY.heading}>
        <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
          <h2 className="font-semibold text-fg">{SEARCH_COPY.heading}</h2>
          <form
            className="flex flex-wrap items-center gap-(--cue-space-2)"
            onSubmit={(event) => {
              event.preventDefault();
              ask();
            }}
          >
            <Input
              className="min-w-0 flex-1"
              type="search"
              aria-label={SEARCH_COPY.field}
              placeholder={SEARCH_COPY.placeholder}
              value={draft}
              spellCheck={false}
              autoComplete="off"
              onValueChange={(value: string) => {
                setDraft(value);
                setProblem(null);
              }}
            />
            <Button type="submit" variant="primary">
              {SEARCH_COPY.ask}
            </Button>
          </form>
          {problem === null ? null : (
            <p role="status" className="text-fg-muted">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-(--cue-space-2)">
            <span className="text-(length:--cue-text-label) text-fg-subtle">{SEARCH_COPY.try}</span>
            {SEARCH_COPY.examples.map((example) => (
              <Button
                key={example}
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDraft(example);
                  ask(example);
                }}
              >
                {example}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-(--cue-space-2)">
            <span className="text-(length:--cue-text-label) text-fg-subtle">{SEARCH_COPY.from}</span>
            <Select
              aria-label={SEARCH_COPY.from}
              size="sm"
              items={[
                { value: ANYONE, label: SEARCH_COPY.anyone },
                ...people.map((each) => ({ value: each.id, label: <PersonName person={each} /> })),
              ]}
              value={person ?? ANYONE}
              onValueChange={(value) => narrow({ person: value === null || value === ANYONE ? null : value })}
            />
            <span className="ml-(--cue-space-2) text-(length:--cue-text-label) text-fg-subtle">{SEARCH_COPY.when}</span>
            <Select
              aria-label={SEARCH_COPY.when}
              size="sm"
              items={[
                { value: 'kept', label: SEARCH_COPY.windows.kept(days) },
                { value: 'week', label: SEARCH_COPY.windows.week },
                { value: 'today', label: SEARCH_COPY.windows.today },
              ]}
              value={span}
              onValueChange={(value) => narrow({ window: (value ?? 'kept') as SearchWindow })}
            />
          </div>
          {suggested.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-(--cue-space-2)" data-slot="search-suggestion">
              <span className="text-fg-muted">{SEARCH_COPY.suggestion}</span>
              {suggested.slice(0, 3).map((each) => (
                <Button key={each.id} size="sm" variant="secondary" onClick={() => narrow({ person: each.id })}>
                  {SEARCH_COPY.onlyFrom} <PersonName person={each} />
                </Button>
              ))}
            </div>
          )}
          <LocalLine />
          {result?.state === 'ready' ? <ModeLine result={result.value} /> : null}
        </Panel>
      </section>
      {result === null ? null : result.state === 'loading' ? (
        <Spinner label={SEARCH_COPY.searching} />
      ) : result.state === 'error' ? (
        <p role="alert" className="text-danger">
          <UntrustedText text={result.message} />
        </p>
      ) : (
        <section aria-label={SEARCH_COPY.count(result.value.hits.length)} className="flex flex-col gap-(--cue-space-3)">
          <div className="flex flex-wrap items-center gap-(--cue-space-3)">
            <span className="font-semibold text-fg">{SEARCH_COPY.count(shown.length)}</span>
            <span role="status" className="text-(length:--cue-text-label) text-fg-subtle">
              {SEARCH_COPY.looked(result.value.looked, result.value.ms)} · {SEARCH_COPY.closest}
            </span>
            {states.length <= 1 ? null : (
              <span className="ml-auto flex items-center gap-(--cue-space-2)">
                <Select
                  aria-label={SEARCH_COPY.state}
                  size="sm"
                  items={[{ value: ANY_STATE, label: SEARCH_COPY.anyState }, ...states]}
                  value={state}
                  onValueChange={(value) => setState((value ?? ANY_STATE) as StatusKind)}
                />
                {state === ANY_STATE ? null : (
                  <span className="text-(length:--cue-text-label) text-fg-subtle">{SEARCH_COPY.amongBest}</span>
                )}
              </span>
            )}
          </div>
          {stories?.problem ? (
            <p role="alert" className="text-danger">
              {SEARCH_COPY.storyProblem} <UntrustedText text={stories.problem} />
            </p>
          ) : null}
          {result.value.hits.length === 0 ? (
            <Panel>
              <EmptyState title={narrowed ? SEARCH_COPY.nothingNarrowed : SEARCH_COPY.nothing} />
            </Panel>
          ) : shown.length === 0 ? (
            <Panel>
              <EmptyState title={SEARCH_COPY.nothingInState} />
            </Panel>
          ) : (
            <ul className="flex flex-col gap-(--cue-space-3)">
              {shown.map((hit) => {
                const joined = joinedOf(hit.sourceId);
                return (
                  <HitCard
                    key={hit.sourceId}
                    hit={hit}
                    joined={joined}
                    context={context}
                    onOpen={joined ? () => setOpen(hit.sourceId) : undefined}
                    onPerson={
                      hit.person === null || navigate === null
                        ? undefined
                        : () => navigate({ screen: 'people', person: hit.person?.id })
                    }
                  />
                );
              })}
            </ul>
          )}
        </section>
      )}
      {known === null ? null : (
        <Coverage
          status={known}
          onSettings={navigate === null ? undefined : () => navigate({ screen: 'settings', section: 'search' })}
        />
      )}
    </Frame>
  );
}

/** By words and meaning, or by words only and why; and how many kept messages are not searchable by meaning yet. */
function ModeLine({ result }: { result: SearchResultView }) {
  if (result.mode === 'hybrid') {
    return result.pending === 0 ? null : (
      <p className="text-(length:--cue-text-label) text-fg-subtle">{SEARCH_COPY.pending(result.pending)}</p>
    );
  }
  return (
    <p className="text-fg-muted" data-slot="search-words-only">
      <span className="font-medium text-fg">{SEARCH_COPY.wordsOnly}</span>{' '}
      {result.modelNote === null ? SEARCH_COPY.noModel : <UntrustedText text={result.modelNote} />}
    </p>
  );
}

/** What Ask looks through (§10: coverage looks complete when it is not), and what of it is not encrypted (S11). */
function Coverage({ status, onSettings }: { status: SearchStatusView; onSettings?: (() => void) | undefined }) {
  return (
    <div
      className="flex flex-col gap-(--cue-space-1) text-(length:--cue-text-label) text-fg-subtle"
      data-slot="search-coverage"
    >
      <p>
        {SEARCH_COPY.coverage(
          status.accounts.map((account) => account.alias),
          status.retentionDays,
        )}
      </p>
      <p>{SEARCH_COPY.notEncrypted}</p>
      {onSettings === undefined ? null : (
        <p>
          <Link
            href="#search-settings"
            onClick={(event) => {
              event.preventDefault();
              onSettings();
            }}
          >
            {SEARCH_COPY.settings} ›
          </Link>
        </p>
      )}
    </div>
  );
}

/** The states the joined hits are in, each once, in the join's order, in the chip's words. */
function stateChoices(
  hits: readonly { sourceId: string }[],
  joinedOf: (sourceId: string) => JoinedMessage | null | undefined,
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const hit of hits) {
    const joined = joinedOf(hit.sourceId);
    if (joined === null || joined === undefined || seen.has(joined.status.kind)) continue;
    seen.set(joined.status.kind, statusLabel(joined.status).label.replace(/ by (you|an agent)$/, ''));
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label }));
}
