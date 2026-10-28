/**
 * A workflow's runs (workflows design §11.2: "A workflow: its designer, its Runs, and its versions"): `runs list
 * --workflow <id>`, newest first, each with where it stands, when it started, the version it ran, and what it waits for.
 * A run opens its view. Everything shown is read; nothing here changes a run.
 */
import { Chip, EmptyState, Panel, Row, Spinner } from '@cueplusplus/ui';
import { ChevronRight } from 'lucide-react';
import { useId, useMemo } from 'react';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY } from '../../copy.ts';
import { isRunId } from '../../grammar.ts';
import { useCall } from '../../hooks/use-call.ts';
import { useReloadOnServiceTurn } from '../../hooks/use-reload-on-return.ts';
import { RUN_STATE_WORDS, runTone, summaryWords } from '../../workflows/runs.ts';
import { type RunListEntryV1, readRunsList } from '../../workflows/types.ts';
import { FactsLine, Problem, Short } from '../events/parts.tsx';

export const RUNS_COPY = {
  title: 'Runs',
  empty: 'No runs yet. A run starts when a message passes its trigger and its judge.',
  unreadable: 'Its runs could not be read.',
  version: (version: number) => `version ${version}`,
  started: 'started',
  shadow: 'shadow',
  waitingFor: {
    'turn-end': 'waiting for a turn to end',
    'session-idle': 'waiting for a session to be free',
    time: 'waiting for a time',
    limit: 'held by a limit',
  },
  needsYou: 'needs you in claude-stream',
  more: (shown: number, all: number) => `The newest ${shown} of ${all}.`,
} as const;

/** How many runs the list shows: the newest. */
const SHOWN = 20;

function RunLine({ run, onOpen }: { run: RunListEntryV1; onOpen: () => void }) {
  const openable = isRunId(run.runId);
  const body = (
    <>
      <Chip tone={runTone(run.state)} data-slot="run-state">
        {RUN_STATE_WORDS[run.state]}
      </Chip>
      <span className="min-w-0 flex-1">
        <FactsLine
          facts={[
            <>
              {RUNS_COPY.started} <Short at={run.startedAt} />
            </>,
            RUNS_COPY.version(run.ruleVersion),
            run.shadow ? RUNS_COPY.shadow : null,
            run.waiting === null ? null : RUNS_COPY.waitingFor[run.waiting.kind],
            run.waiting?.needsYouInClaudeStream === true ? RUNS_COPY.needsYou : null,
            ...summaryWords(run.summary).map((word) => (
              <span key={word} data-slot="run-summary">
                <UntrustedText text={word} />
              </span>
            )),
          ]}
        />
      </span>
      {openable ? <ChevronRight aria-hidden="true" className="size-(--cue-icon-sm) shrink-0 text-fg-subtle" /> : null}
    </>
  );
  const layout = 'items-center gap-(--cue-space-3) text-left';
  return openable ? (
    <Row interactive data-run={run.runId} onClick={onOpen} className={layout}>
      {body}
    </Row>
  ) : (
    <Row data-run={run.runId} className={layout}>
      {body}
    </Row>
  );
}

/** The runs of workflow `ruleId`, newest first; a row opens the run. */
export function Runs({ ruleId, onOpen }: { ruleId: string; onOpen: (runId: string) => void }) {
  const id = useId();
  const call = useCall<unknown>({ kind: 'eventsRunsList', ruleId });
  useReloadOnServiceTurn(call.reload);
  const runs = useMemo(():
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | { state: 'ready'; runs: RunListEntryV1[] } => {
    if (call.result.state === 'loading') return { state: 'loading' };
    if (call.result.state === 'error') return { state: 'error', message: call.result.message };
    try {
      return { state: 'ready', runs: readRunsList(call.result.value).runs.filter((run) => run.ruleId === ruleId) };
    } catch {
      return { state: 'error', message: RUNS_COPY.unreadable };
    }
  }, [call.result, ruleId]);
  return (
    <section aria-labelledby={id}>
      <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <h3 id={id} className="font-medium text-(length:--cue-text-label) text-fg-muted">
          {RUNS_COPY.title}
        </h3>
        {runs.state === 'loading' ? (
          <Spinner label={COPY.loading} />
        ) : runs.state === 'error' ? (
          <Problem message={runs.message} />
        ) : runs.runs.length === 0 ? (
          <EmptyState title={RUNS_COPY.empty} />
        ) : (
          <>
            <div className="flex flex-col">
              {runs.runs.slice(0, SHOWN).map((run) => (
                <RunLine key={run.runId} run={run} onOpen={() => onOpen(run.runId)} />
              ))}
            </div>
            {runs.runs.length > SHOWN ? (
              <p className="text-(length:--cue-text-label) text-fg-muted">{RUNS_COPY.more(SHOWN, runs.runs.length)}</p>
            ) : null}
          </>
        )}
      </Panel>
    </section>
  );
}
