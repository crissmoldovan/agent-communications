/**
 * Optional test seam for process loss at the durable boundaries of an event cut-over.
 *
 * Production callers never supply this callback.  It has no return value and is invoked
 * only after the named durable state is committed (or immediately before its next write),
 * so omitting it cannot alter scheduling, activation, provider calls, or persistence.
 */
export const DURABLE_CUTOVER_EDGES = [
  'before-stage',
  'after-stage',
  'before-move',
  'after-move',
  'before-finalise',
] as const;

export type DurableCutoverEdge = (typeof DURABLE_CUTOVER_EDGES)[number];

/** Test-only callback; throwing simulates a process crash at one durable edge. */
export type CutoverFailpoint = (edge: DurableCutoverEdge) => void;
