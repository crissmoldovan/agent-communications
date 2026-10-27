/**
 * Try it (workflows design §7.7, §11.3, W18): the draft walked over an example message by the event service's
 * `workflow test`, with no I/O. Each box's outcomes are a picker; the step answers with the one chosen, or its first.
 * The path the try took is lit on the canvas (`SignalEdge` live, `NodeCard` live), and each step it took says what it
 * would have done — the prompt a session would be told and the issue as it would read, the sender's words inside their
 * envelopes, and every event it would raise. Nothing is sent, started, written or raised.
 */
import { Button, Chip, Panel, Spinner } from '@cueplusplus/ui';
import { useMemo, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { errorMessage } from '../../ipc.ts';
import { isObject, type JsonObject } from '../../rule-editor/model.ts';
import { exampleOf } from '../../workflows/approve.ts';
import { flowOfDocument, type Lit } from '../../workflows/canvas.ts';
import { outcomeWords, TRY_COPY } from '../../workflows/copy.ts';
import { type FlowTestResultV1, readFlowTest } from '../../workflows/types.ts';
import { Problem, Sentence } from '../events/parts.tsx';
import { Designer, type DesignerContext } from './Designer.tsx';

export function TryIt({
  document,
  context,
  onBack,
}: {
  document: JsonObject;
  context: DesignerContext;
  onBack: () => void;
}) {
  const bridge = useBridge();
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const [result, setResult] = useState<FlowTestResultV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const example = exampleOf(document);
  // A straight line is tried as the graph it already is (W2): the same behaviour, written out for the try alone.
  const tried = useMemo(
    () =>
      isObject(document.flow)
        ? document
        : { ...document, flow: flowOfDocument(document).flow as unknown as JsonObject },
    [document],
  );
  const lit: Lit | null = useMemo(
    () =>
      result === null
        ? null
        : { path: result.path, taken: Object.fromEntries(result.steps.map((step) => [step.stepId, step.outcome])) },
    [result],
  );

  const choose = (stepId: string, outcome: string | null) => {
    setResult(null);
    setChosen((before) => {
      const next = { ...before };
      if (outcome === null) delete next[stepId];
      else next[stepId] = outcome;
      return next;
    });
  };

  const run = async () => {
    if (example === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await bridge.cli({
        kind: 'eventsRuleTestFlow',
        document: tried,
        example,
        outcomes: { ...chosen },
      });
      if (answer.status !== 'ok') {
        setProblem(answer.status === 'failed' ? answer.message : TRY_COPY.unreadable);
        return;
      }
      try {
        setResult(readFlowTest(answer.data));
      } catch {
        setProblem(TRY_COPY.unreadable);
      }
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={TRY_COPY.title} className="flex flex-col gap-(--cue-space-3)">
      <div className="flex flex-wrap items-center gap-(--cue-space-2)">
        <p className="min-w-60 flex-1 text-fg-muted">{TRY_COPY.body}</p>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onBack}>
          {TRY_COPY.back}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || Object.keys(chosen).length === 0}
          onClick={() => {
            setResult(null);
            setChosen({});
          }}
        >
          {TRY_COPY.clear}
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={busy || example === null}
          onClick={() => void run()}
        >
          {result === null ? TRY_COPY.run : TRY_COPY.again}
        </Button>
        {busy ? <Spinner size="sm" label={TRY_COPY.trying} /> : null}
      </div>
      {problem === null ? null : <Problem message={problem} />}
      <Designer
        document={document}
        onChange={() => undefined}
        context={context}
        readOnly
        trying={{ chosen, choose, lit }}
      />
      {result === null ? null : (
        <section aria-label={TRY_COPY.path}>
          <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
            <h3 className="font-semibold text-fg">{TRY_COPY.path}</h3>
            {result.steps.length === 0 ? <p className="text-fg-muted">{TRY_COPY.noPath}</p> : null}
            <ol className="flex flex-col gap-(--cue-space-3)">
              {result.steps.map((step) => (
                <li key={step.stepId} data-tried={step.stepId} className="flex flex-col gap-(--cue-space-1)">
                  <span className="flex flex-wrap items-center gap-(--cue-space-2)">
                    <span className="font-mono text-fg">
                      <UntrustedText text={step.stepId} />
                    </span>
                    <Chip tone="accent">{outcomeWords(step.outcome)}</Chip>
                  </span>
                  <span className="text-fg">
                    <Sentence parts={step.would} names={context.names} />
                  </span>
                  {step.prompt === undefined ? null : (
                    <div className="flex flex-col gap-(--cue-space-1)">
                      <span className="text-(length:--cue-text-label) text-fg-muted">{TRY_COPY.prompt}</span>
                      <pre className="m-0 whitespace-pre-wrap rounded-control bg-surface-2 p-(--cue-space-2) font-mono text-(length:--cue-text-label) text-fg">
                        <UntrustedText text={step.prompt} />
                      </pre>
                    </div>
                  )}
                  {step.issue === undefined ? null : (
                    <div className="flex flex-col gap-(--cue-space-1)">
                      <span className="text-(length:--cue-text-label) text-fg-muted">{TRY_COPY.issue}</span>
                      <p className="font-semibold text-fg">
                        <UntrustedText text={step.issue.title} />
                      </p>
                      <p className="whitespace-pre-wrap text-fg-muted">
                        <UntrustedText text={step.issue.description} />
                      </p>
                    </div>
                  )}
                  {step.events.length === 0 ? null : (
                    <p className="flex flex-wrap items-center gap-(--cue-space-1) text-(length:--cue-text-label) text-fg-muted">
                      {TRY_COPY.wouldRaise}
                      {step.events.map((event, at) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a step's events come in the order it raises them.
                        <span key={at} className="font-mono text-fg">
                          <UntrustedText text={event.type} />
                        </span>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </Panel>
        </section>
      )}
    </section>
  );
}
