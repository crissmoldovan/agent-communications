/**
 * The workflow designer (workflows design §11.3, the approved prototype's WorkflowDesigner): React Flow through cue-ui's
 * Flow parts, over the one document the editor holds. The palette sits beside the canvas, outside React Flow; a step
 * dragged from it is dropped where the pointer is (`screenToFlowPosition`), with a fresh id, its kind's defaults and no
 * arrows. A wire is drawn from an outcome's handle to a step's input, and only where `connectionAllowed` — the event
 * service's own check — lets it: no cycle, no second arrow from one outcome, no two branches of a split meeting.
 * Deleting a step turns each arrow into it into `end`.
 *
 * Every change is a pure function of the document (`workflows/canvas.ts`), handed up through `onChange`. Where the
 * boxes sit is the app's own, kept in its settings by workflow id (`positions.ts`): a drag never changes the
 * document, so moving a box makes no new version.
 *
 * React Flow and its stylesheets load only with this chunk: the Events screen opens the designer lazily.
 */
import '@xyflow/react/dist/style.css';
import '@cueplusplus/ui/flow.css';
import { FlowBackground, FlowControls, useFlowTheme } from '@cueplusplus/ui/flow';
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import type { JsonObject } from '../../rule-editor/model.ts';
import {
  applyConnect,
  applyDelete,
  applyDisconnect,
  type CanvasEdge,
  type CanvasNode,
  connectable,
  moveNode,
  type Positions,
  toGraph,
} from '../../workflows/canvas.ts';
import { type DesignerProblem, designerChecks, problemsByStep } from '../../workflows/checks.ts';
import { type DropContext, dropItem, PALETTE_MIME } from '../../workflows/palette.ts';
import { readPositions, writePositions } from '../../workflows/positions.ts';
import { Palette } from './Palette.tsx';
import { BoxContext, GateNode, StepNode } from './StepNode.tsx';
import { type SettingsContext, SettingsPanel } from './StepSettings.tsx';

/** The box types the canvas draws: stable, as React Flow asks. */
const NODE_TYPES = { step: StepNode, gate: GateNode } as const;

export const DESIGNER_COPY = {
  canvas: 'The workflow, drawn',
  legend:
    'Orange steps act outside Agent Comms, and each is listed when you approve. Drag from an outcome to a step to connect them. Drawn with React Flow.',
  dimmed: 'The canvas shows the last text that read.',
  positionsNotKept: 'Where the boxes are could not be kept on this Mac. The workflow itself is unchanged.',
} as const;

/** What the designer knows beside the document, for its palette and each step's settings. */
export interface DesignerContext extends DropContext, SettingsContext {}

export interface DesignerProps {
  document: JsonObject;
  onChange: (next: JsonObject) => void;
  context: DesignerContext;
  /** The settings of the box selected, or of the workflow when none is (each step's in E3). */
  settings?: (
    selected: string | null,
    problems: readonly DesignerProblem[],
    select: (id: string | null) => void,
  ) => ReactNode;
  /** The text view's canvas: drawn, not edited, and dimmed while the text has a mistake. */
  readOnly?: boolean;
  dimmed?: boolean;
}

/** The canvas, the palette beside it, and the settings of what is selected. */
export function Designer(props: DesignerProps) {
  return (
    <ReactFlowProvider>
      <DesignerCanvas {...props} />
    </ReactFlowProvider>
  );
}

function DesignerCanvas({ document, onChange, context, settings, readOnly = false, dimmed = false }: DesignerProps) {
  const bridge = useBridge();
  const flow = useReactFlow();
  const { nodeStyles: _nodeStyles, ...flowTheme } = useFlowTheme();
  const ruleId = typeof document.ruleId === 'string' ? document.ruleId : null;
  const [positions, setPositions] = useState<Positions>({});
  const [positionsProblem, setPositionsProblem] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const kept = useRef<Positions>({});

  useEffect(() => {
    if (ruleId === null) return;
    let live = true;
    void readPositions(bridge, ruleId).then((read) => {
      if (!live) return;
      kept.current = read;
      setPositions(read);
    });
    return () => {
      live = false;
    };
  }, [bridge, ruleId]);

  const keep = useCallback(
    (next: Positions) => {
      kept.current = next;
      setPositions(next);
      if (ruleId === null) return;
      writePositions(bridge, ruleId, next).then(
        () => setPositionsProblem(false),
        () => setPositionsProblem(true),
      );
    },
    [bridge, ruleId],
  );

  const problems = useMemo(() => designerChecks(document), [document]);
  const graph = useMemo(
    () => toGraph(document, positions, { problems: problemsByStep(problems), selected }),
    [document, positions, problems, selected],
  );

  // React Flow measures each box and moves it while it is dragged: its own copy of the boxes and wires carries that,
  // and is drawn again from the document whenever the document or the kept places change.
  const [nodes, setNodes] = useState<CanvasNode[]>(graph.nodes);
  const [edges, setEdges] = useState<CanvasEdge[]>(graph.edges);
  useEffect(() => {
    setNodes((before) => {
      const measured = new Map(before.map((node) => [node.id, node.measured]));
      return graph.nodes.map((node) => {
        const was = measured.get(node.id);
        return was === undefined ? node : ({ ...node, measured: was } as CanvasNode);
      });
    });
    setEdges(graph.edges);
  }, [graph]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      for (const change of changes) if (change.type === 'select' && change.selected) setSelected(change.id);
      const dropped = changes.filter(
        (change): change is Extract<NodeChange<CanvasNode>, { type: 'position' }> =>
          change.type === 'position' && change.dragging === false && change.position !== undefined,
      );
      if (dropped.length > 0)
        keep(
          dropped.reduce((next, change) => moveNode(next, change.id, change.position ?? { x: 0, y: 0 }), kept.current),
        );
    },
    [keep],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const isValidConnection = useCallback(
    (connection: CanvasEdge | Connection) =>
      connectable(document, connection.source, connection.sourceHandle ?? '', connection.target),
    [document],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const next = applyConnect(document, connection.source, connection.sourceHandle ?? '', connection.target);
      if (next !== null) onChange(next);
    },
    [document, onChange],
  );

  // React Flow removes nothing itself: a step is deleted from the document, and a wire is taken off its outcome.
  const onBeforeDelete = useCallback(
    async ({ nodes: gone, edges: cut }: { nodes: CanvasNode[]; edges: CanvasEdge[] }) => {
      const steps = gone.filter((node) => node.type === 'step').map((node) => node.id);
      let next = steps.reduce(applyDelete, document);
      for (const edge of cut)
        if (!steps.includes(edge.source) && !steps.includes(edge.target) && !edge.source.startsWith('gate:'))
          next = applyDisconnect(next, edge.source, edge.sourceHandle ?? '', edge.target);
      if (next !== document) onChange(next);
      if (selected !== null && steps.includes(selected)) setSelected(null);
      return false;
    },
    [document, onChange, selected],
  );

  const add = useCallback(
    (id: string, at?: { x: number; y: number }) => {
      const dropped = dropItem(document, id, context);
      if (dropped === null) return;
      onChange(dropped.document);
      if (at !== undefined) keep(moveNode(kept.current, dropped.stepId, at));
      setSelected(dropped.stepId);
    },
    [context, document, keep, onChange],
  );

  const onDragOver = useCallback((event: DragEvent) => {
    if (!event.dataTransfer.types.includes(PALETTE_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      const id = event.dataTransfer.getData(PALETTE_MIME);
      if (id === '') return;
      event.preventDefault();
      add(id, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [add, flow],
  );

  const canvas = (
    <div
      data-slot="workflow-canvas"
      data-tabs-swipe="ignore"
      className={`h-144 overflow-hidden rounded-surface border border-border bg-bg ${dimmed ? 'opacity-50' : ''}`}
    >
      <BoxContext.Provider value={{ document, names: context.names }}>
        <ReactFlow<CanvasNode, CanvasEdge>
          {...flowTheme}
          aria-label={DESIGNER_COPY.canvas}
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          {...(readOnly
            ? { onBeforeDelete: async () => false }
            : { onNodesChange, onEdgesChange, onConnect, onBeforeDelete, onDragOver, onDrop })}
          isValidConnection={isValidConnection}
          onPaneClick={() => setSelected(null)}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
          proOptions={{ hideAttribution: true }}
          fitView
          minZoom={0.2}
        >
          <FlowBackground />
          <FlowControls showInteractive={!readOnly} />
        </ReactFlow>
      </BoxContext.Provider>
    </div>
  );

  if (readOnly)
    return (
      <section aria-label={DESIGNER_COPY.canvas} className="flex flex-col gap-(--cue-space-2)">
        {canvas}
        {dimmed ? <p className="text-(length:--cue-text-label) text-fg-muted">{DESIGNER_COPY.dimmed}</p> : null}
      </section>
    );

  return (
    <div className="flex flex-wrap items-start gap-(--cue-space-3)">
      <Palette onAdd={(id) => add(id)} />
      <section
        aria-label={DESIGNER_COPY.canvas}
        className="flex min-w-0 flex-[999_1_28rem] flex-col gap-(--cue-space-2)"
      >
        {canvas}
        <p className="text-(length:--cue-text-label) text-fg-muted">{DESIGNER_COPY.legend}</p>
        {positionsProblem ? (
          <p className="text-(length:--cue-text-label) text-warn">{DESIGNER_COPY.positionsNotKept}</p>
        ) : null}
      </section>
      <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-(--cue-space-3)">
        {settings === undefined ? (
          <SettingsPanel
            document={document}
            selected={selected}
            problems={problems}
            onChange={onChange}
            onSelect={setSelected}
            context={context}
          />
        ) : (
          settings(selected, problems, setSelected)
        )}
      </div>
    </div>
  );
}
