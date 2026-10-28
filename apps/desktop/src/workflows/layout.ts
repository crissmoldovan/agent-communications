/**
 * Where a box goes when the person never put it anywhere (workflows design §11.3, Q13): a small function of the flow,
 * with no layout library. The workflow reads left to right: the gate's boxes (what starts it, which messages, its
 * judge, what it keeps) one column each, then the flow's steps in layers from `start`, one column per depth, a step
 * that several arrows reach in the column after the deepest of them. Each column stacks its steps by the printer's
 * order, each box its own height and a gap apart, so no two boxes overlap. A box's height is fixed by what it shows:
 * cue-ui's `NodeCard` header, then one row for its id and one per outcome (`boxHeight`). A position the person kept
 * wins over every one of these. It reads the flow and writes nothing.
 */
import { type FlowDocumentV1, type FlowStep, stepOrder, successors } from './flow.ts';

/** A box's place on the canvas, in the canvas's own units. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Every box's kept place, by its id: a step's id, or a gate box's (`gate:trigger` …). */
export type Positions = Readonly<Record<string, Point>>;

/** A box's width, and the heights it is made of (cue-ui's `NodeCard`: its frame is an outline, so the box is the number). */
export const NODE_WIDTH = 240;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 22;
const BODY_PADDING = 12;
const COLUMN_GAP = 96;
const ROW_GAP = 40;

/** The height of a box of `rows` rows under its header. */
export function boxHeight(rows: number): number {
  return HEADER_HEIGHT + BODY_PADDING + Math.max(1, rows) * ROW_HEIGHT;
}

/** The least a box is: its header, its id and two outcomes. */
export const NODE_HEIGHT: number = boxHeight(3);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const columnX = (column: number): number => column * (NODE_WIDTH + COLUMN_GAP);

/**
 * Each box's place: `lead`'s boxes (the gate) one column each on the first row, then every step of `flow` by its depth
 * from `start`, and any step no arrow reaches in a column after the last, each column's boxes stacked by their heights
 * (`heightOf`, `NODE_HEIGHT` for each when not given). `kept` places a box where the person put it.
 */
export function layout(
  flow: FlowDocumentV1,
  kept: Positions,
  lead: readonly string[] = [],
  heightOf: (id: string) => number = () => NODE_HEIGHT,
): Record<string, Point> {
  const steps = (isRecord(flow.steps) ? flow.steps : {}) as Readonly<Record<string, FlowStep>>;
  const order = stepOrder({ ...flow, steps });
  const depth = new Map<string, number>();
  if (typeof flow.start === 'string' && Object.hasOwn(steps, flow.start)) depth.set(flow.start, 0);
  for (const id of order) {
    const here = depth.get(id);
    const step = steps[id];
    if (here === undefined || !isRecord(step)) continue;
    for (const next of successors(step))
      if (next !== id && Object.hasOwn(steps, next)) depth.set(next, Math.max(depth.get(next) ?? 0, here + 1));
  }
  const deepest = Math.max(-1, ...depth.values());
  const filled = new Map<number, number>();
  const placed = new Map<string, Point>();
  lead.forEach((id, column) => {
    placed.set(id, { x: columnX(column), y: 0 });
  });
  for (const id of order) {
    const column = lead.length + (depth.get(id) ?? deepest + 1);
    const y = filled.get(column) ?? 0;
    filled.set(column, y + heightOf(id) + ROW_GAP);
    placed.set(id, { x: columnX(column), y });
  }
  for (const [id, point] of Object.entries(kept))
    if (placed.has(id) && Number.isFinite(point.x) && Number.isFinite(point.y))
      placed.set(id, { x: point.x, y: point.y });
  return Object.fromEntries(placed);
}
