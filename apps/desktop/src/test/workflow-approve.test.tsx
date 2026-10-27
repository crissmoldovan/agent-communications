/*
 * Approve… and Try it (0.36.0, plan E5, spec §7.7, §10.2, §11.3, W18, W20). Approve… lists describeFlow's numbered
 * effects — the event service's own words for the document the activation binds — beside the graph laid out afresh,
 * every kept position ignored, with what changed since the version that runs; the person types the workflow's id to
 * approve. Try it makes each box's outcomes a picker, runs `workflow test` with the ones chosen, and lights the path
 * it returns. Every answer is a fixture; nothing is sent.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BridgeProvider } from '../bridge-context.tsx';
import type { Call } from '../ipc.ts';
import type { JsonObject } from '../rule-editor/model.ts';
import { FlowApproval } from '../screens/workflows/Approve.tsx';
import { approvalLines, flowChanges } from '../workflows/approve.ts';
import { applyDelete, applyEmit, applyNodeDrop, toGraph } from '../workflows/canvas.ts';
import { createFakeBridge } from './fake-bridge.ts';
import { renderApp } from './render.tsx';
import { APPROVAL, DIGEST } from './rule-editor-bridge.ts';
import {
  box,
  DESIGNER_SLOW,
  OWNER,
  openDesigner,
  polyfillCanvas,
  REMINDERS,
  select,
  workflowService,
} from './workflow-bridge.ts';

// The app attests the person in the app only on macOS; these tests run as macOS.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

beforeAll(polyfillCanvas);

/** Where React Flow put a box: its translate, in the canvas's units. */
const placeOf = (within: HTMLElement, id: string) =>
  within.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)?.style.transform ?? '';

/** client-asks with one change — find raises busy — reviewed: the dialog. */
async function review(service: ReturnType<typeof workflowService>, open?: HTMLElement): Promise<HTMLElement> {
  if (open === undefined) renderApp(service.bridge, { screen: 'events' });
  const editor = open ?? (await openDesigner('client-asks'));
  const settings = await select(editor, 'find');
  fireEvent.click(settings.querySelector('[data-event="busy"]') as HTMLElement);
  const approve = within(editor).getByRole('button', { name: 'Review and approve…' }) as HTMLButtonElement;
  await waitFor(() => expect(approve.disabled).toBe(false));
  fireEvent.click(approve);
  return screen.findByRole('dialog', { name: 'Approve version 6 of client-asks' }, { timeout: 15_000 });
}

describe('Approve… and Try it', () => {
  it(
    "Approve… shows describeFlow's numbered lines beside a fresh layout, ignoring kept positions",
    DESIGNER_SLOW,
    async () => {
      const service = workflowService();
      await service.bridge.setWorkflowPositions('client-asks', { route: { x: 4321, y: 7 } });
      renderApp(service.bridge, { screen: 'events' });
      const editor = await openDesigner('client-asks');
      await box(editor, 'route');
      // In the designer, route is where the person kept it.
      await waitFor(() => expect(placeOf(editor, 'route')).toContain('4321'));
      const dialog = await review(service, editor);
      const saved = service.stored.filter((each) => each.kind === 'eventsRuleUpdate').at(-1)?.document as JsonObject;
      const expected = approvalLines(saved);
      const effects = await within(dialog).findByRole('region', { name: 'What it does, step by step' });
      const lines = [...effects.querySelectorAll<HTMLElement>('li[data-line]')];
      expect(lines).toHaveLength(expected.length);
      expect(lines[0]?.textContent?.startsWith('1.')).toBe(true);
      // The start line names where the find before it looked.
      expect(effects.textContent).toContain(
        'If no session is idle in the project route chose, start a Claude Code session',
      );
      // Laid out afresh: the kept place is not used.
      const drawn = within(dialog).getByRole('region', { name: 'The workflow, laid out afresh' });
      await waitFor(() => expect(drawn.querySelector('[data-step="route"]')).not.toBeNull(), { timeout: 15_000 });
      expect(placeOf(drawn, 'route')).not.toContain('4321');
    },
  );

  it('it shows what changed since the last version', DESIGNER_SLOW, async () => {
    const dialog = await review(workflowService());
    const changed = await within(dialog).findByRole('region', { name: 'What changed since version 5' });
    expect(changed.textContent).toContain('Changes the events find raises');
    // Pure: a step added and one removed, by id.
    const before = OWNER as JsonObject;
    const after = applyEmit(before, 'find', 'busy', true);
    expect(flowChanges(before, after).map((line) => line.map((part) => part.text).join(''))).toEqual([
      'Changes the events find raises',
    ]);
    const words = (lines: ReturnType<typeof flowChanges>) =>
      lines.map((each) => each.map((part) => part.text).join(''));
    expect(words(flowChanges(before, applyDelete(before, 'tell')))).toContain('Removes the step tell');
    expect(words(flowChanges(before, applyNodeDrop(before, 'notify')))).toEqual(['Adds the step notify-1: Notify me']);
    // A new workflow has no version before it to compare with.
    expect(flowChanges(null, before)).toEqual([]);
  });

  it('approving types the workflow id; a mistyped id keeps the button off', DESIGNER_SLOW, async () => {
    const service = workflowService();
    const dialog = await review(service);
    const typed = within(dialog).getByRole('textbox', { name: 'Type client-asks to approve' });
    const approve = within(dialog).getByRole('button', { name: 'Approve and switch on' }) as HTMLButtonElement;
    fireEvent.change(typed, { target: { value: 'client-ask' } });
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(service.calls('eventsRuleApprove')).toEqual([]);
    fireEvent.change(typed, { target: { value: 'client-asks' } });
    await waitFor(() => expect(approve.disabled).toBe(false));
    fireEvent.click(approve);
    await waitFor(() =>
      expect(service.calls('eventsRuleApprove')).toEqual([
        { kind: 'eventsRuleApprove', approvalId: APPROVAL, digest: DIGEST },
      ]),
    );
  });

  it("Try it sets each node's outcome and lights the path workflow test returns", DESIGNER_SLOW, async () => {
    const service = workflowService();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await openDesigner('client-asks');
    await box(editor, 'find');
    fireEvent.click(within(editor).getByRole('button', { name: 'Try it' }));
    const trying = await within(editor).findByRole('region', { name: 'Try it' });
    const busy = await waitFor(() => {
      const found = trying.querySelector<HTMLElement>('[data-step="find"] [data-choose="busy"]');
      if (found === null) throw new Error('no picker yet');
      return found;
    });
    fireEvent.click(busy);
    expect(busy.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(trying).getByRole('button', { name: 'Try it' }));
    await waitFor(() => expect(service.calls('eventsRuleTestFlow')).toHaveLength(1));
    const call = service.calls('eventsRuleTestFlow')[0] as Extract<Call, { kind: 'eventsRuleTestFlow' }>;
    expect(call.outcomes).toEqual({ find: 'busy' });
    expect(call.example).toBe('slack.message.posted@1:0');
    // The fixture's path: route, then issue, lit; every other box is not.
    await waitFor(() => expect(trying.querySelector('[data-step="route"]')?.getAttribute('data-lit')).toBe('true'));
    expect(trying.querySelector('[data-step="issue"]')?.getAttribute('data-lit')).toBe('true');
    expect(trying.querySelector('[data-step="find"]')?.getAttribute('data-lit')).toBeNull();
    const path = within(trying).getByRole('region', { name: 'The path it took' });
    expect(path.textContent).toContain("would choose acme-site, by its sender's domain");
    expect(path.textContent).toContain('acme.client-asks.issue.created');
    // Nothing was stored, enabled or sent to try it.
    for (const kind of ['eventsRuleUpdate', 'eventsRuleEnable', 'eventsTargetUpdate'] as const)
      expect(service.calls(kind), kind).toEqual([]);
    // On the canvas, the wires a try took are live: from the gate into route, and none route never took.
    const { edges } = toGraph(
      OWNER as JsonObject,
      {},
      { lit: { path: ['route', 'issue'], taken: { route: 'chosen' } } },
    );
    expect(edges.find((edge) => edge.target === 'route')?.data?.live).toBe(true);
    expect(edges.find((edge) => edge.id === 'route:none->tell')?.data?.live).toBeUndefined();
  });

  it('a preview over 20 lines says to split the workflow', () => {
    const steps: Record<string, JsonObject> = {};
    for (let n = 1; n <= 21; n += 1)
      steps[`tell-${n}`] = { kind: 'notify', text: `Notice ${n}`, next: n < 21 ? { otherwise: `tell-${n + 1}` } : {} };
    const long = {
      ...(REMINDERS as JsonObject),
      flow: { ...((REMINDERS as JsonObject).flow as JsonObject), start: 'tell-1', steps },
    } as JsonObject;
    expect(approvalLines(long).length).toBeGreaterThan(20);
    render(
      <BridgeProvider bridge={createFakeBridge()}>
        <FlowApproval rule={long} before={null} beforeVersion={null} names={new Map()} />
      </BridgeProvider>,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/^This workflow does 2\d things/);
    expect(screen.getByRole('alert').textContent).toContain('Split it into smaller workflows');
  });
});
