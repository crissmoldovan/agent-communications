/**
 * A run on its version's canvas (workflows design §11.2, the approved prototype's WorkflowRun): React Flow through
 * cue-ui's Flow parts, read only. Each box is cue-ui's `NodeCard`, its frame the run's state — lit where the run went or
 * is now, dimmed where it did not go — and each wire a `SignalEdge`, lit along the taken path and live into the step the
 * run is at now. Nothing on it can be moved, wired or deleted: it draws what happened.
 *
 * A step's id and label are the workflow author's text and its line the app's words; nothing a sender wrote is drawn.
 */
import '@xyflow/react/dist/style.css';
import '@cueplusplus/ui/flow.css';
import { Chip } from '@cueplusplus/ui';
import {
  FlowBackground,
  FlowControls,
  type FlowNodeState,
  NodeCard,
  NodeHandle,
  useFlowTheme,
} from '@cueplusplus/ui/flow';
import { type Node, type NodeProps, Position, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import type { JsonObject } from '../../rule-editor/model.ts';
import { type GateBox, IN, OUT, type Positions, type StepBox } from '../../workflows/canvas.ts';
import { readPositions } from '../../workflows/positions.ts';
import { type RunBox, type RunContext, type RunMark, runGraph } from '../../workflows/run-graph.ts';
import type { RunShowResultV1 } from '../../workflows/types.ts';

export const RUN_GRAPH_COPY = {
  canvas: 'The run, drawn on its version',
  legend: 'Lit: the path it took. Dimmed: steps it did not take.',
  marks: {
    taken: 'Taken',
    now: 'Now',
    failed: 'Failed',
    'not-taken': 'Not taken',
    'not-yet': 'Not yet',
  } satisfies Record<RunMark, string>,
} as const;

/** Each mark as a box's frame says it: lit where the run went, dimmed where it did not. */
const FRAME: Readonly<Record<RunMark, FlowNodeState>> = {
  taken: 'live',
  now: 'live',
  failed: 'live',
  'not-taken': 'disabled',
  'not-yet': 'idle',
};

const MARK_TONE = { taken: 'ok', now: 'accent', failed: 'warn', 'not-taken': 'neutral', 'not-yet': 'neutral' } as const;

const Marks = createContext<ReadonlyMap<string, RunBox>>(new Map());

function RunStepNode({ id, data }: NodeProps<Node<StepBox, 'step'>>) {
  const box = useContext(Marks).get(id) ?? { mark: 'not-yet' as const, line: null };
  return (
    <NodeCard
      tone={data.tone}
      state={FRAME[box.mark]}
      data-step={data.stepId}
      data-run={box.mark}
      className={`flex h-full w-full flex-col ${box.mark === 'not-taken' ? 'opacity-60' : ''}`}
      header={
        <span className="flex min-w-0 flex-1 items-center gap-(--cue-space-2)">
          <span className="min-w-0 flex-1 truncate font-semibold text-fg">{data.title}</span>
          <Chip tone={MARK_TONE[box.mark]} variant="tag">
            {RUN_GRAPH_COPY.marks[box.mark]}
          </Chip>
        </span>
      }
    >
      <NodeHandle type="target" position={Position.Left} id={IN} tone="muted" />
      <div className="flex h-full min-h-0 flex-col gap-(--cue-space-1) px-(--cue-space-3) py-(--cue-space-1) text-(length:--cue-text-label) text-fg-muted">
        <span className="flex min-w-0 gap-(--cue-space-2)">
          <span className="shrink-0 font-mono">
            <UntrustedText text={data.stepId} />
          </span>
          {data.label === null ? null : (
            <span className="min-w-0 truncate">
              <UntrustedText text={data.label} />
            </span>
          )}
        </span>
        {box.line === null ? null : (
          <span className="line-clamp-3 text-fg">
            <UntrustedText text={box.line} />
          </span>
        )}
      </div>
      {data.handles.map((handle) => (
        <NodeHandle key={handle.id} type="source" position={Position.Right} id={handle.id} tone="muted" />
      ))}
    </NodeCard>
  );
}

function RunGateNode({ data }: NodeProps<Node<GateBox, 'gate'>>) {
  return (
    <NodeCard
      tone={data.tone}
      state="live"
      data-gate={data.part}
      className="flex h-full w-full flex-col"
      header={<span className="truncate font-semibold text-fg">{data.title}</span>}
    >
      {data.part === 'trigger' ? null : <NodeHandle type="target" position={Position.Left} id={IN} tone="muted" />}
      <NodeHandle type="source" position={Position.Right} id={OUT} tone="accent" />
    </NodeCard>
  );
}

const NODE_TYPES = { step: RunStepNode, gate: RunGateNode } as const;

export function RunGraph(props: { document: JsonObject; run: RunShowResultV1; context: RunContext }) {
  return (
    <ReactFlowProvider>
      <RunCanvas {...props} />
    </ReactFlowProvider>
  );
}

function RunCanvas({ document, run, context }: { document: JsonObject; run: RunShowResultV1; context: RunContext }) {
  const bridge = useBridge();
  const { nodeStyles: _nodeStyles, ...flowTheme } = useFlowTheme();
  // Where the person put the boxes in the designer, so the run reads as the workflow they drew.
  const [positions, setPositions] = useState<Positions>({});
  useEffect(() => {
    let live = true;
    void readPositions(bridge, run.ruleId).then((read) => {
      if (live) setPositions(read);
    });
    return () => {
      live = false;
    };
  }, [bridge, run.ruleId]);
  const graph = useMemo(() => runGraph(document, run, positions, context), [document, run, positions, context]);
  return (
    <section aria-label={RUN_GRAPH_COPY.canvas} className="flex flex-col gap-(--cue-space-2)">
      <div
        data-slot="run-canvas"
        data-tabs-swipe="ignore"
        className="h-112 overflow-hidden rounded-surface border border-border bg-bg"
      >
        <Marks.Provider value={graph.marks}>
          <ReactFlow
            {...flowTheme}
            aria-label={RUN_GRAPH_COPY.canvas}
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            deleteKeyCode={null}
            onBeforeDelete={async () => false}
            proOptions={{ hideAttribution: true }}
            fitView
            minZoom={0.2}
          >
            <FlowBackground />
            <FlowControls showInteractive={false} />
          </ReactFlow>
        </Marks.Provider>
      </div>
      <p className="text-(length:--cue-text-label) text-fg-muted">{RUN_GRAPH_COPY.legend}</p>
    </section>
  );
}
