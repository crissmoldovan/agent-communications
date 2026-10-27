/**
 * A box on the designer's canvas (workflows design §11.3): cue-ui's `NodeCard`, its frame toned by what the step is —
 * the trigger an input, a step that stays in Agent Comms processing, one that acts outside it an output — with an input
 * on its left and, down its right, a row per outcome with its `NodeHandle`. An outcome no wire leaves is marked
 * "Stops": that branch ends there. A step that raises events carries a small mark with how many are ticked, and one
 * the checks refuse a warning chip. The gate's boxes (what starts the workflow, which messages, its judge, what it
 * keeps) say their part in the rule editor's own sentences.
 *
 * A step's id and its label are the workflow author's text, shown as text; nothing a sender wrote is on a box.
 */
import { Chip } from '@cueplusplus/ui';
import { NodeCard, NodeHandle } from '@cueplusplus/ui/flow';
import { type Node, type NodeProps, Position } from '@xyflow/react';
import { Radio, TriangleAlert } from 'lucide-react';
import { createContext, useContext } from 'react';
import type { AccountNames } from '../../account-aliases.ts';
import { aliasOf } from '../../account-aliases.ts';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { judgeLine, watches, whatsKept, whichMessages } from '../../events-rules.ts';
import type { JsonObject } from '../../rule-editor/model.ts';
import { type GateBox, IN, OUT, type StepBox } from '../../workflows/canvas.ts';
import { CANVAS_COPY, TRY_COPY } from '../../workflows/copy.ts';
import { Sentence } from '../events/parts.tsx';

/** What every box reads beside its own data: the workflow, for the gate's sentences, and the accounts' names. */
export const BoxContext = createContext<{ document: JsonObject; names: AccountNames }>({
  document: {},
  names: new Map(),
});

/**
 * Try it (§11.3, §7.7): each box's outcomes become a picker, the one chosen is what `workflow test` makes the step
 * answer. Null while the designer is not trying the workflow.
 */
export const TryContext = createContext<{
  chosen: Readonly<Record<string, string>>;
  choose: (stepId: string, outcome: string | null) => void;
} | null>(null);

/** The marks a step's header carries: the events it raises, and what the checks found. */
function Marks({ emits, problems }: { emits: number; problems: number }) {
  return (
    <>
      {emits === 0 ? null : (
        <Chip
          tone="accent"
          data-slot="emit-mark"
          aria-label={CANVAS_COPY.emits(emits)}
          title={CANVAS_COPY.emits(emits)}
        >
          <Radio aria-hidden="true" className="size-(--cue-icon-sm)" />
          {emits}
        </Chip>
      )}
      {problems === 0 ? null : (
        <Chip
          tone="warn"
          data-slot="step-problems"
          aria-label={CANVAS_COPY.problems(problems)}
          title={CANVAS_COPY.problems(problems)}
        >
          <TriangleAlert aria-hidden="true" className="size-(--cue-icon-sm)" />
        </Chip>
      )}
    </>
  );
}

const ROW = 'relative flex min-h-0 flex-1 items-center gap-(--cue-space-2) px-(--cue-space-3)';

/** A step's box: its header, its id and label, then each outcome with its handle. */
export function StepNode({ data, selected }: NodeProps<Node<StepBox, 'step'>>) {
  const trying = useContext(TryContext);
  const chosen = trying?.chosen[data.stepId];
  return (
    <NodeCard
      tone={data.tone}
      state={selected ? 'selected' : data.lit ? 'live' : 'idle'}
      data-step={data.stepId}
      data-lit={data.lit ? 'true' : undefined}
      className="flex h-full w-full flex-col"
      header={
        <span className="flex min-w-0 flex-1 items-center gap-(--cue-space-2)">
          <span className="min-w-0 flex-1 truncate font-semibold text-fg">{data.title}</span>
          <Marks emits={data.emits} problems={data.problems} />
        </span>
      }
    >
      <NodeHandle type="target" position={Position.Left} id={IN} tone="muted" />
      <div className="flex h-full min-h-0 flex-col py-(--cue-space-1)">
        <div className={`${ROW} text-(length:--cue-text-label) text-fg-muted`}>
          <span className="shrink-0 font-mono">
            <UntrustedText text={data.stepId} />
          </span>
          {data.label === null ? null : (
            <span className="min-w-0 truncate">
              <UntrustedText text={data.label} />
            </span>
          )}
        </div>
        {data.handles.map((handle) => (
          <div
            key={handle.id}
            data-outcome={handle.id}
            className={`${ROW} justify-end text-(length:--cue-text-label) ${handle.wired ? 'text-fg' : 'text-fg-muted'}`}
          >
            {handle.stops ? (
              <Chip tone="neutral" variant="tag" data-slot="stops">
                {CANVAS_COPY.stops}
              </Chip>
            ) : null}
            {trying === null || handle.id === 'otherwise' ? (
              <span className="truncate">{handle.words}</span>
            ) : (
              <button
                type="button"
                data-choose={handle.id}
                aria-pressed={chosen === handle.id}
                aria-label={TRY_COPY.answer(data.stepId, handle.words)}
                className="nodrag truncate rounded-control px-(--cue-space-1) hover:bg-surface-2 aria-pressed:bg-accent-soft aria-pressed:text-accent"
                onClick={() => trying.choose(data.stepId, chosen === handle.id ? null : handle.id)}
              >
                {handle.words}
              </button>
            )}
            <NodeHandle
              type="source"
              position={Position.Right}
              id={handle.id}
              tone={handle.id === 'otherwise' ? 'muted' : 'accent'}
              aria-label={handle.words}
            />
          </div>
        ))}
      </div>
    </NodeCard>
  );
}

/** One of the gate's boxes: its part of the workflow in the rule editor's sentence, and its one way on. */
export function GateNode({ data, selected }: NodeProps<Node<GateBox, 'gate'>>) {
  const { document, names } = useContext(BoxContext);
  const line =
    data.part === 'trigger'
      ? watches(document, (id) => aliasOf(names, id))
      : data.part === 'condition'
        ? whichMessages(document)
        : data.part === 'judge'
          ? judgeLine(document)
          : whatsKept(document);
  return (
    <NodeCard
      tone={data.tone}
      state={selected ? 'selected' : 'idle'}
      data-gate={data.part}
      className="flex h-full w-full flex-col"
      header={<span className="truncate font-semibold text-fg">{data.title}</span>}
    >
      {data.part === 'trigger' ? null : <NodeHandle type="target" position={Position.Left} id={IN} tone="muted" />}
      <div className="flex h-full min-h-0 flex-col justify-center px-(--cue-space-3) py-(--cue-space-1) text-(length:--cue-text-label) text-fg-muted">
        <span className="line-clamp-3">
          <Sentence parts={line.main} names={names} />
        </span>
      </div>
      <NodeHandle type="source" position={Position.Right} id={OUT} tone={data.wired ? 'accent' : 'muted'} />
    </NodeCard>
  );
}
