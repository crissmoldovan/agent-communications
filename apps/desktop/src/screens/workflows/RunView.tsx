/**
 * One run of a workflow (workflows design §11.2, §7, the approved prototype's WorkflowRun): the graph of the version it
 * ran — `workflow show <id> --version <its version>`, never the newest draft — lit along the path it took; each step's
 * time, what it came out with, and what it waits for ("Waiting for acme-site · Claude Code, 1 ahead", "Needs you in
 * claude-stream"); the steps it did not take, and why; the events it raised, and who received them; and Cancel, which
 * asks first. While the run is live its record is read again every 2 seconds: the app opens no socket or stream.
 *
 * This is the person's own view: a worktree's folder shows, with the home as `~`. A run's records carry no sender
 * text; every line is the app's own words, a closed word the event service wrote, or the person's own (a project's
 * name, a step's label).
 */
import { AlertDialog, Button, Checkbox, Chip, Link, Panel, Spinner, Timeline } from '@cueplusplus/ui';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY } from '../../copy.ts';
import { useAppData } from '../../data.tsx';
import { readRuleShow } from '../../events-rules.ts';
import { useCall } from '../../hooks/use-call.ts';
import { errorMessage } from '../../ipc.ts';
import { useNavigate } from '../../navigation.tsx';
import type { JsonObject } from '../../rule-editor/model.ts';
import { notTaken, pathLine, type RunContext, type RunMark, runSteps, sessionOf } from '../../workflows/run-graph.ts';
import {
  eventDeliveryWords,
  isLive,
  NEEDS_YOU_IN_CLAUDE_STREAM,
  RUN_STATE_WORDS,
  runTone,
  waitingWords,
} from '../../workflows/runs.ts';
import { type RunShowResultV1, readRunShow } from '../../workflows/types.ts';
import { messageStoryOpener } from '../events/DeliveryDetail.tsx';
import { BackTo, Problem } from '../events/parts.tsx';
import { RunGraph } from './RunGraph.tsx';

/** How often a live run's record is read again (spec §11.2). */
export const RUN_POLL_MS = 2_000;

export const RUN_COPY = {
  title: (ruleId: string) => `A run of ${ruleId}`,
  aRun: 'A run',
  started: (at: string, version: number) => `Started ${at}, on version ${version}.`,
  shadow: 'A shadow run: everything it would have done was written as a dry run, and nothing reached anyone.',
  chained: 'Started by an event another workflow raised, about the same message.',
  ended: (code: string) => `It ended with ${code}.`,
  story: 'The message’s story',
  steps: 'Step by step',
  path: 'The path it took',
  notTaken: 'Not taken, and why',
  noneNotTaken: 'It has passed over no step.',
  events: 'Events it raised',
  noEvents: 'It has raised no event.',
  noSubscriber: 'No subscriber receives it.',
  notRaised: (count: number) =>
    count === 1
      ? '1 event was not raised: its workflow had raised as many as its limit allows.'
      : `${count} events were not raised: its workflow had raised as many as its limit allows.`,
  subscriber: (id: string, version: number) => `${id}, version ${version}`,
  cancel: 'Cancel this run…',
  cancelTitle: 'Cancel this run?',
  cancelBody:
    'It stops here. Deliveries still waiting are cancelled, and so are the events it raised that have not been delivered. Nothing it already did is undone.',
  interrupt: 'Also stop the session’s turn now',
  cancelAction: 'Cancel the run',
  keep: 'Keep it running',
  cancelled: (deliveries: number, events: number) =>
    `Cancelled. ${deliveries === 1 ? '1 delivery' : `${deliveries} deliveries`} and ${events === 1 ? '1 event' : `${events} events`} were cancelled.`,
  interrupted: 'The session’s turn was stopped too.',
  unreadable: 'This run could not be read.',
  versionUnreadable: 'The version it ran could not be read, so its graph is not drawn.',
  marks: {
    taken: 'taken',
    now: 'now',
    failed: 'failed',
    'not-taken': 'not taken',
    'not-yet': 'not yet',
  } satisfies Record<RunMark, string>,
} as const;

/** A step's moment, to the second: the time today, the day and the time before. */
function stepTime(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { timeStyle: 'medium' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

const MARKER: Readonly<Record<RunMark, 'idle' | 'busy' | 'warn' | 'ok'>> = {
  taken: 'ok',
  now: 'busy',
  failed: 'warn',
  'not-taken': 'idle',
  'not-yet': 'idle',
};

/** A titled part of the page, in a panel. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <h3 id={id} className="font-medium text-(length:--cue-text-label) text-fg-muted">
          {title}
        </h3>
        {children}
      </Panel>
    </section>
  );
}

/** A run's record, read again on `reload`; `null` when it is not a shape the app knows. */
function useRun(runId: string) {
  const call = useCall<unknown>({ kind: 'eventsRunShow', runId });
  const run = useMemo(():
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | { state: 'ready'; run: RunShowResultV1 } => {
    if (call.result.state === 'loading') return { state: 'loading' };
    if (call.result.state === 'error') return { state: 'error', message: call.result.message };
    try {
      return { state: 'ready', run: readRunShow(call.result.value) };
    } catch {
      return { state: 'error', message: RUN_COPY.unreadable };
    }
  }, [call.result]);
  return { run, reload: call.reload };
}

/**
 * Reads the run again every 2 seconds while `live`, never two reads at a time, and stops when it is not: a run that
 * ended is read no more.
 */
function usePollWhileLive(reload: () => Promise<void>, live: boolean): void {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  useEffect(() => {
    if (!live) return;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void latest.current().finally(() => {
        busy = false;
      });
    }, RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [live]);
}

/** The version the run ran: its document, from `workflow show <id> --version <n>`. */
function useVersionDocument(run: RunShowResultV1 | null) {
  const call = useCall<unknown>(
    run === null ? null : { kind: 'eventsRuleShowVersion', ruleId: run.ruleId, version: run.ruleVersion },
  );
  return useMemo(():
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | { state: 'ready'; document: JsonObject } => {
    if (call.result.state === 'loading') return { state: 'loading' };
    if (call.result.state === 'error') return { state: 'error', message: call.result.message };
    const versions = readRuleShow(call.result.value);
    const document = versions?.find((each) => each.version === run?.ruleVersion)?.document ?? null;
    return document === null
      ? { state: 'error', message: RUN_COPY.versionUnreadable }
      : { state: 'ready', document: document as JsonObject };
  }, [call.result, run?.ruleVersion]);
}

/** Cancel this run…: asks first, and offers to stop the session's turn when one is running for it. */
function Cancel({ run, onCancelled }: { run: RunShowResultV1; onCancelled: (line: string) => Promise<void> }) {
  const bridge = useBridge();
  const [interrupt, setInterrupt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const turn = run.waiting?.kind === 'turn-end';
  const cancel = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.cli({ kind: 'eventsRunCancel', runId: run.runId, interrupt: turn && interrupt });
      if (result.status !== 'ok') {
        setProblem(result.status === 'failed' ? result.message : RUN_COPY.unreadable);
        return;
      }
      const data = (result.data ?? {}) as Record<string, unknown>;
      const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) ? value : 0);
      const line = [
        RUN_COPY.cancelled(count(data.cancelledDeliveries), count(data.cancelledEvents)),
        data.interrupted === true ? RUN_COPY.interrupted : null,
      ]
        .filter(Boolean)
        .join(' ');
      await onCancelled(line);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <AlertDialog.Root>
        <AlertDialog.Trigger
          render={
            <Button size="sm" variant="danger-outline" disabled={busy} className="ml-auto">
              {RUN_COPY.cancel}
            </Button>
          }
        />
        <AlertDialog.Content>
          <AlertDialog.Title>{RUN_COPY.cancelTitle}</AlertDialog.Title>
          <AlertDialog.Description>{RUN_COPY.cancelBody}</AlertDialog.Description>
          {turn ? (
            <Checkbox
              label={RUN_COPY.interrupt}
              checked={interrupt}
              onCheckedChange={(checked: boolean) => setInterrupt(checked)}
            />
          ) : null}
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{RUN_COPY.keep}</AlertDialog.Cancel>
            <AlertDialog.Action tone="danger" onClick={() => void cancel()}>
              {RUN_COPY.cancelAction}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      {problem === null ? null : <Problem message={problem} />}
    </>
  );
}

export function RunView({ runId, onBack, backLabel }: { runId: string; onBack: () => void; backLabel: string }) {
  const { installation } = useAppData();
  const home = installation.state === 'ready' ? (installation.value.home ?? null) : null;
  const context: RunContext = useMemo(() => ({ time: stepTime, home }), [home]);
  const { run, reload } = useRun(runId);
  const shown = run.state === 'ready' ? run.run : null;
  usePollWhileLive(reload, shown !== null && isLive(shown.state));
  const version = useVersionDocument(shown);
  const [said, setSaid] = useState<string | null>(null);
  const openStory = messageStoryOpener(shown?.eventId ?? null, useNavigate());
  const onCancelled = useCallback(
    async (line: string) => {
      setSaid(line);
      await reload();
    },
    [reload],
  );

  if (shown === null)
    return (
      <section aria-label={RUN_COPY.aRun} className="flex flex-col gap-(--cue-space-4)">
        <BackTo label={backLabel} onBack={onBack} />
        {run.state === 'error' ? <Problem message={run.message} /> : <Spinner label={COPY.loading} />}
      </section>
    );

  const document = version.state === 'ready' ? version.document : null;
  const steps = document === null ? [] : runSteps(document, shown, context);
  const passed = document === null ? [] : notTaken(document, shown);
  const waiting = shown.waiting;
  const waitLine =
    waiting === null || document === null
      ? null
      : waitingWords(waiting, sessionOf(document, shown, waiting.stepId), {
          wakeAt: shown.steps.find((step) => step.stepId === waiting.stepId)?.wait?.wakeAt ?? null,
          time: stepTime,
        });
  return (
    <section aria-label={RUN_COPY.title(shown.ruleId)} className="flex flex-col gap-(--cue-space-4)">
      <BackTo label={backLabel} onBack={onBack} />
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <h2 className="font-semibold text-(length:--cue-text-title) text-fg">
          <UntrustedText text={RUN_COPY.title(shown.ruleId)} />
        </h2>
        <Chip tone={runTone(shown.state)} data-slot="run-state">
          {RUN_STATE_WORDS[shown.state]}
        </Chip>
        {isLive(shown.state) ? <Cancel run={shown} onCancelled={onCancelled} /> : null}
      </div>
      <div className="flex flex-col gap-(--cue-space-1) text-fg-muted">
        <p>
          {RUN_COPY.started(stepTime(shown.startedAt), shown.ruleVersion)}
          {shown.endCode === null || isLive(shown.state) ? null : (
            <>
              {' '}
              <UntrustedText text={RUN_COPY.ended(shown.endCode)} />
            </>
          )}
        </p>
        {shown.shadow ? <p>{RUN_COPY.shadow}</p> : null}
        {shown.depth > 0 ? <p>{RUN_COPY.chained}</p> : null}
        {openStory === null ? null : (
          <p className="text-(length:--cue-text-label)">
            <Link variant="underline" render={<button type="button" />} onClick={openStory}>
              {RUN_COPY.story}
            </Link>
          </p>
        )}
      </div>
      {said === null ? null : (
        <p role="status" className="text-fg">
          {said}
        </p>
      )}
      {waiting === null ? null : (
        <div
          data-slot="run-waiting"
          className="flex flex-col gap-(--cue-space-1) rounded-control bg-(color:--cue-warn-soft) px-(--cue-space-3) py-(--cue-space-2)"
        >
          {waitLine === null ? null : (
            <p className="text-fg">
              <UntrustedText text={waitLine} />
            </p>
          )}
          {waiting.needsYouInClaudeStream ? <p className="font-medium text-fg">{NEEDS_YOU_IN_CLAUDE_STREAM}</p> : null}
        </div>
      )}
      {version.state === 'error' ? <Problem message={version.message} /> : null}
      {version.state === 'loading' ? <Spinner label={COPY.loading} /> : null}
      {document === null ? null : (
        <div className="grid items-start gap-(--cue-space-4) xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <RunGraph document={document} run={shown} context={context} />
          <Part title={RUN_COPY.steps}>
            <Timeline.Root>
              {steps.map((step) => (
                <Timeline.Item key={step.stepId} data-run-step={step.stepId} data-run={step.mark}>
                  <Timeline.Marker
                    tone={MARKER[step.mark]}
                    label={RUN_COPY.marks[step.mark]}
                    pulse={step.mark === 'now'}
                    className="bg-surface-1"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1) pb-(--cue-space-2)">
                    <span className="flex flex-wrap items-baseline gap-x-(--cue-space-3)">
                      <span className={`font-medium ${step.mark === 'not-taken' ? 'text-fg-muted' : 'text-fg'}`}>
                        {step.title}
                      </span>
                      <span className="font-mono text-(length:--cue-text-label) text-fg-muted">
                        <UntrustedText text={step.stepId} />
                      </span>
                      <span className="text-(length:--cue-text-label) text-fg-subtle">{RUN_COPY.marks[step.mark]}</span>
                      {step.at === null ? null : (
                        <time
                          dateTime={new Date(step.at).toISOString()}
                          className="ml-auto text-(length:--cue-text-label) text-fg-subtle tabular-nums"
                        >
                          {stepTime(step.at)}
                        </time>
                      )}
                    </span>
                    {step.line === null ? null : (
                      <span className="text-(length:--cue-text-ui) text-fg-muted">
                        <UntrustedText text={step.line} />
                      </span>
                    )}
                  </div>
                </Timeline.Item>
              ))}
            </Timeline.Root>
          </Part>
        </div>
      )}
      {document === null ? null : (
        <Part title={RUN_COPY.path}>
          <p className="text-fg" data-slot="run-path">
            <UntrustedText text={pathLine(document, shown)} />
          </p>
        </Part>
      )}
      {document === null ? null : (
        <Part title={RUN_COPY.notTaken}>
          {passed.length === 0 ? (
            <p className="text-fg-muted">{RUN_COPY.noneNotTaken}</p>
          ) : (
            <ul className="flex flex-col gap-(--cue-space-2)">
              {passed.map((step) => (
                <li key={step.stepId} data-not-taken={step.stepId} className="flex flex-col">
                  <span className="font-medium text-fg">
                    {step.title}{' '}
                    <span className="font-mono text-(length:--cue-text-label) text-fg-muted">
                      <UntrustedText text={step.stepId} />
                    </span>
                  </span>
                  <span className="text-fg-muted">{step.why}</span>
                </li>
              ))}
            </ul>
          )}
        </Part>
      )}
      <Part title={RUN_COPY.events}>
        {shown.events.length === 0 ? (
          <p className="text-fg-muted">{RUN_COPY.noEvents}</p>
        ) : (
          <ul className="flex flex-col gap-(--cue-space-3)">
            {shown.events.map((event) => (
              <li key={event.eventId} data-run-event={event.eventId} className="flex flex-col gap-(--cue-space-1)">
                <span className="flex flex-wrap items-baseline gap-x-(--cue-space-3)">
                  <span className="break-all font-mono text-fg">
                    <UntrustedText text={event.type} />
                  </span>
                  <time
                    dateTime={new Date(event.raisedAt).toISOString()}
                    className="ml-auto text-(length:--cue-text-label) text-fg-subtle tabular-nums"
                  >
                    {stepTime(event.raisedAt)}
                  </time>
                </span>
                {event.deliveries.length === 0 ? (
                  <span className="text-fg-muted">{RUN_COPY.noSubscriber}</span>
                ) : (
                  <ul className="flex flex-col">
                    {event.deliveries.map((delivery) => (
                      <li
                        key={`${delivery.subscriberId}@${delivery.subscriberVersion}`}
                        data-received-by={delivery.subscriberId}
                        className="text-fg-muted"
                      >
                        <UntrustedText text={RUN_COPY.subscriber(delivery.subscriberId, delivery.subscriberVersion)} />
                        {`: ${eventDeliveryWords(delivery.state)}`}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {shown.notRaised === 0 ? null : <p className="text-warn">{RUN_COPY.notRaised(shown.notRaised)}</p>}
      </Part>
    </section>
  );
}
