// @vitest-environment node
import { describe, expect, it } from 'vitest';
import owner from '../../../../packages/events/test/fixtures/flows/owner-example.json';
import { canonical, copyOf, type JsonObject, newRule } from '../rule-editor/model.ts';
import {
  applyConnect,
  applyDelete,
  applyEmit,
  applyNodeDrop,
  type CanvasNode,
  connectable,
  flowOfDocument,
  GATE,
  moveNode,
  type StepBox,
  stepDefaults,
  toGraph,
} from '../workflows/canvas.ts';
import { checkFlow } from '../workflows/flow.ts';
import { layout, NODE_HEIGHT, NODE_WIDTH } from '../workflows/layout.ts';
import { readPositions, writePositions } from '../workflows/positions.ts';
import { createFakeBridge } from './fake-bridge.ts';

/** The spec's owner example (§4.4), as T0.1 wrote it: a workflow with a flow. */
const doc = (): JsonObject => copyOf(owner as unknown as JsonObject);
/** A straight line: one target, no flow. */
const straight = (): JsonObject => newRule('invoices', { id: 'cue/gmail', channel: 'gmail' });

const steps = (document: JsonObject) => (document.flow as { steps: Record<string, JsonObject> }).steps;
const box = (nodes: CanvasNode[], id: string) => nodes.find((node) => node.id === id)?.data as StepBox;

describe('the canvas as pure functions of the workflow (E1)', () => {
  it("a drag changes positions only: the document's bytes are unchanged", () => {
    const document = doc();
    const before = canonical(document);
    const positions = moveNode({}, 'find', { x: 9, y: 9 });
    expect(positions).toEqual({ find: { x: 9, y: 9 } });
    expect(canonical(document)).toBe(before);
    const { nodes } = toGraph(document, positions);
    expect(nodes.find((node) => node.id === 'find')?.position).toEqual({ x: 9, y: 9 });
    expect(canonical(document)).toBe(before);
  });

  it("a drop adds <kind>-<n> with the kind's defaults and no arrows", () => {
    const dropped = applyNodeDrop(doc(), 'wait');
    expect(steps(dropped)['wait-1']).toEqual({
      kind: 'wait',
      for: { time: { afterMs: 3_600_000 } },
      timeoutMs: 3_600_000,
      next: {},
    });
    expect(steps(applyNodeDrop(dropped, 'wait'))['wait-2']).toEqual(stepDefaults('wait'));
    // Nothing reaches it yet, so the flow is not one the event service takes.
    const checked = checkFlow(dropped.flow, {});
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems.map((problem) => problem.code)).toContain('FLOW_UNREACHABLE');
  });

  it('a straight line is drawn as flowOf derives it, and its first drop writes that flow', () => {
    const line = straight();
    expect(line.flow).toBeUndefined();
    const { flow, derived } = flowOfDocument(line);
    expect(derived).toBe(true);
    expect(Object.keys(flow.steps)).toEqual(['deliver-invoices-log']);
    const before = canonical(line);
    toGraph(line, {});
    expect(canonical(line)).toBe(before);
    const dropped = applyNodeDrop(line, 'notify');
    expect(Object.keys(steps(dropped))).toEqual(['deliver-invoices-log', 'notify-1']);
    expect((dropped.flow as JsonObject).start).toBe('deliver-invoices-log');
    expect(line.flow).toBeUndefined();
  });

  it('connect refuses a cycle and a second arrow from one outcome', () => {
    const document = doc();
    // give → route would go round in a circle.
    expect(applyConnect(document, 'give', 'done', 'route')).toBeNull();
    // find's idle already goes to give.
    expect(applyConnect(document, 'find', 'idle', 'tell')).toBeNull();
    // An outcome the step does not have.
    expect(applyConnect(document, 'tell', 'busy', 'note')).toBeNull();
    // wait's timed out is free: wiring it to tell writes the arrow.
    const wired = applyConnect(document, 'wait', 'timed-out', 'tell');
    expect(wired).not.toBeNull();
    expect((steps(wired as JsonObject).wait as JsonObject).next).toEqual({
      done: 'note',
      otherwise: 'tell',
      'timed-out': 'tell',
    });
    expect(connectable(document, 'wait', 'timed-out', 'tell')).toBe(true);
    expect(canonical(document)).toBe(canonical(doc()));
  });

  it('connect gives a split a branch, and refuses two branches that would meet', () => {
    let document = applyNodeDrop(doc(), 'split', 'side');
    document = applyNodeDrop(document, 'notify', 'one', { step: { kind: 'notify', text: 'one', next: {} } });
    document = applyNodeDrop(document, 'notify', 'two', {
      step: { kind: 'notify', text: 'two', next: { otherwise: 'one' } },
    });
    const one = applyConnect(document, 'side', 'branches', 'one') as JsonObject;
    expect((steps(one).side as JsonObject).branches).toEqual(['one']);
    // two reaches one, which is already a branch: the branches would meet.
    expect(applyConnect(one, 'side', 'branches', 'two')).toBeNull();
  });

  it('the gate wires once: its last box to the start of a flow that has none', () => {
    const empty: JsonObject = {
      ...straight(),
      targets: [],
      flow: { flowVersion: 1, start: '', steps: {}, limits: {} },
    };
    const dropped = applyNodeDrop(empty, 'notify');
    expect((dropped.flow as JsonObject).start).toBe('notify-1');
    const deleted = applyDelete(dropped, 'notify-1');
    expect((deleted.flow as JsonObject).start).toBe('');
    const again = applyNodeDrop(applyNodeDrop(deleted, 'notify'), 'wait');
    expect(applyConnect(again, GATE.keep, 'out', 'wait-1')).toBeNull();
  });

  it('delete turns arrows into it into end and drops its target when unused', () => {
    const deleted = applyDelete(doc(), 'give');
    const after = steps(deleted);
    expect(after.give).toBeUndefined();
    expect((after.find as JsonObject).next).toEqual({ busy: 'free', idle: 'end', none: 'another', otherwise: 'free' });
    expect((after.start as JsonObject).next).toEqual({ otherwise: 'end' });
    expect((after.free as JsonObject).next).toEqual({ free: 'end', otherwise: 'tell' });
    expect((deleted.targets as JsonObject[]).map((target) => target.targetId)).toEqual([
      'client-issues',
      'client-done',
    ]);
    // A target another step still delivers to stays.
    const twice = applyNodeDrop(doc(), 'deliver', 'again', {
      step: { kind: 'deliver', target: { targetId: 'client-issues', version: 1 }, next: {} },
    });
    expect((applyDelete(twice, 'issue').targets as JsonObject[]).map((target) => target.targetId)).toContain(
      'client-issues',
    );
  });

  it('ticking an event writes emit sorted; unticking the last removes emit', () => {
    let document = applyEmit(doc(), 'find', 'not-found', true);
    document = applyEmit(document, 'find', 'busy', true);
    expect((steps(document).find as JsonObject).emit).toEqual(['busy', 'not-found']);
    document = applyEmit(document, 'find', 'busy', false);
    document = applyEmit(document, 'find', 'not-found', false);
    expect(Object.hasOwn(steps(document).find as JsonObject, 'emit')).toBe(false);
    expect(canonical(document)).toBe(canonical(doc()));
  });

  it("layout: layers from start, one column per depth, NodeCard's fixed height", () => {
    const { flow } = flowOfDocument(doc());
    const placed = layout(flow, {});
    const column = (id: string) => (placed[id]?.x ?? -1) / (placed.found?.x ?? 1);
    expect(placed.route).toEqual({ x: 0, y: 0 });
    expect(column('found')).toBe(1);
    // tell is reached from route, from free, from tree and from wait: it goes after the deepest of them.
    expect(placed.tell?.x).toBeGreaterThan(placed.wait?.x ?? Number.POSITIVE_INFINITY);
    // Two steps in one column are a box's height and a gap apart.
    const shared = Object.entries(placed).filter(([, point]) => point.x === placed.another?.x);
    if (shared.length > 1) {
      const ys = shared.map(([, point]) => point.y).sort((a, b) => a - b);
      expect((ys[1] ?? 0) - (ys[0] ?? 0)).toBeGreaterThan(NODE_HEIGHT);
    }
    expect((placed.found?.x ?? 0) - (placed.route?.x ?? 0)).toBeGreaterThan(NODE_WIDTH);
    // A kept place wins; the gate's boxes come first.
    const kept = layout(flow, { route: { x: 5, y: 6 } }, [GATE.trigger, GATE.keep]);
    expect(kept.route).toEqual({ x: 5, y: 6 });
    expect(kept[GATE.trigger]).toEqual({ x: 0, y: 0 });
    expect((kept.found?.x ?? 0) > (kept[GATE.keep]?.x ?? 0)).toBe(true);
  });

  it('toGraph draws a handle per outcome and a Stops mark where none has an edge', () => {
    const { nodes, edges } = toGraph(doc(), {});
    const find = box(nodes, 'find');
    expect(find.handles.map((handle) => handle.id)).toEqual(['idle', 'busy', 'none', 'watched', 'otherwise']);
    // watched has no arrow of its own, but otherwise goes to free: no Stops mark.
    expect(find.handles.find((handle) => handle.id === 'watched')?.stops).toBe(false);
    const tell = box(nodes, 'tell');
    expect(tell.handles).toEqual([
      { id: 'sent', words: 'sent', wired: false, stops: true },
      { id: 'otherwise', words: 'otherwise', wired: false, stops: false },
    ]);
    const note = box(nodes, 'note');
    expect(note.handles.filter((handle) => handle.stops).map((handle) => handle.id)).toEqual([
      'done',
      'left-in-queue',
      'failed',
    ]);
    expect(box(nodes, 'issue').emits).toBe(1);
    expect(box(nodes, 'route').entry).toBe(true);
    expect(edges.find((edge) => edge.id === 'find:idle->give')).toMatchObject({
      source: 'find',
      sourceHandle: 'idle',
      target: 'give',
      label: 'idle',
    });
    // The gate: When → Which messages → Ask a judge → Keep → the start.
    expect(nodes.slice(0, 4).map((node) => node.id)).toEqual([GATE.trigger, GATE.condition, GATE.judge, GATE.keep]);
    expect(edges.find((edge) => edge.source === GATE.keep)?.target).toBe('route');
  });

  it("positions are kept in the app's settings, by workflow, and read back", async () => {
    const bridge = createFakeBridge();
    expect(await readPositions(bridge, 'client-asks')).toEqual({});
    await writePositions(bridge, 'client-asks', { find: { x: 1, y: 2 }, broken: { x: Number.NaN, y: 1 } });
    expect(await readPositions(bridge, 'client-asks')).toEqual({ find: { x: 1, y: 2 } });
    expect(await readPositions(bridge, 'other')).toEqual({});
    const failing = createFakeBridge({
      workflowPositions: async () => {
        throw { code: 'APP_IO', message: 'no folder' };
      },
    });
    expect(await readPositions(failing, 'client-asks')).toEqual({});
  });
});
