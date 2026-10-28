/**
 * Where the designer keeps a workflow's boxes (workflows design W20, §11.3, Q13): in the app's settings, by workflow id
 * and box id, through Rust (`positions.rs`), which keeps them beside `settings.json` and takes only names the grammar
 * allows. Never the window's own storage, never the event service: a position is the app's convenience and no part of
 * what is approved, so a box dragged makes no new version, and Approve… lays the graph out afresh.
 */
import type { Bridge, WorkflowPositions } from '../ipc.ts';
import type { Positions } from './layout.ts';

/** Only the boxes with finite places: what a reader of the kept file can trust, whatever Rust answered. */
function finite(value: unknown): Positions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const kept = new Map<string, { x: number; y: number }>();
  for (const [id, point] of Object.entries(value)) {
    if (typeof point !== 'object' || point === null) continue;
    const { x, y } = point as { x?: unknown; y?: unknown };
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y))
      kept.set(id, { x, y });
  }
  return Object.fromEntries(kept);
}

/** The boxes kept for `ruleId`: none when nothing is kept, or the app could not read them. */
export async function readPositions(bridge: Pick<Bridge, 'workflowPositions'>, ruleId: string): Promise<Positions> {
  try {
    return finite(await bridge.workflowPositions(ruleId));
  } catch {
    return {};
  }
}

/** Keeps `positions` for `ruleId`. A failure is said by the caller; nothing about the workflow depends on it. */
export async function writePositions(
  bridge: Pick<Bridge, 'setWorkflowPositions'>,
  ruleId: string,
  positions: Positions,
): Promise<void> {
  await bridge.setWorkflowPositions(ruleId, finite(positions) as WorkflowPositions);
}
