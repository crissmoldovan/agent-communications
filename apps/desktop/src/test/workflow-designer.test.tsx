/*
 * The workflow designer (0.36.0, plan E2, spec §11.3): Events → Rules opens a workflow in the designer once the event
 * service has workflows. Its palette sits outside React Flow, grouped as the prototype draws it; a step dropped on the
 * canvas lands where the pointer is, through React Flow's own `screenToFlowPosition` (mocked here: jsdom lays nothing
 * out), with a fresh id, its kind's defaults and no arrows, and stays invalid — Save off — until it is wired and set.
 * A step that raises events carries a mark with the count. Every answer is a fixture; nothing is stored by looking.
 */
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PALETTE_MIME } from '../workflows/palette.ts';
import { renderApp } from './render.tsx';
import { DESIGNER_SLOW, openDesigner, polyfillCanvas, workflowService as service } from './workflow-bridge.ts';

// React Flow's helper, where jsdom draws nothing: a point on the screen is the canvas point 100 left and 40 up.
vi.mock('@xyflow/react', async (importOriginal) => {
  const real = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...real,
    useReactFlow: () => ({ screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: x - 100, y: y - 40 }) }),
  };
});

beforeAll(polyfillCanvas);

/** A drag's data, as the palette writes it and the canvas reads it. */
function dataTransfer(item: string) {
  const data = new Map<string, string>([[PALETTE_MIME, item]]);
  return {
    types: [...data.keys()],
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => data.set(type, value),
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

const button = (editor: HTMLElement, name: string) => within(editor).getByRole('button', { name }) as HTMLButtonElement;

describe('the workflow designer', () => {
  it(
    'the palette groups Decide, Sessions, Linear, Hand over and tell, and Wait, with Raise an event',
    DESIGNER_SLOW,
    async () => {
      renderApp(service().bridge, { screen: 'events' });
      const editor = await openDesigner('invoices');
      const palette = within(editor).getByRole('complementary', { name: 'Steps' });
      const groups = [...palette.querySelectorAll<HTMLElement>('[data-palette-group]')].map(
        (group) => group.dataset.paletteGroup,
      );
      expect(groups).toEqual(['Decide', 'Sessions', 'Linear', 'Hand over, and tell', 'Wait']);
      const items = (group: string) =>
        [...(palette.querySelector(`[data-palette-group="${group}"]`)?.querySelectorAll('button') ?? [])].map(
          (each) => each.textContent,
        );
      expect(items('Decide')).toEqual(['Condition', 'Ask a judge', 'Which project?', 'Side by side']);
      expect(items('Sessions')).toContain('Find this conversation’s session');
      expect(items('Linear')).toEqual(['Create', 'Update', 'Comment', 'Close']);
      expect(items('Hand over, and tell')).toEqual([
        'Put it in the Queue',
        'Send to a webhook',
        'Notify me',
        'Raise an event',
      ]);
      expect(items('Wait')).toEqual(['For a session’s turn to end', 'For a session to be free', 'For a time']);
      // Each is dragged with its own id under the app's own type.
      const wait = palette.querySelector<HTMLElement>('[data-palette="wait-time"]') as HTMLElement;
      const transfer = dataTransfer('');
      fireEvent.dragStart(wait, { dataTransfer: transfer });
      expect(transfer.getData(PALETTE_MIME)).toBe('wait-time');
      // The palette is beside the canvas, not inside React Flow.
      expect(palette.closest('.react-flow')).toBeNull();
    },
  );

  it('dropping Wait at a client point adds wait-1 at screenToFlowPosition of that point', DESIGNER_SLOW, async () => {
    const fake = service();
    renderApp(fake.bridge, { screen: 'events' });
    const editor = await openDesigner('invoices');
    const pane = await waitFor(() => {
      const found = editor.querySelector<HTMLElement>('.react-flow');
      if (found === null) throw new Error('no canvas yet');
      return found;
    });
    await act(async () => {
      fireEvent.dragOver(pane, { dataTransfer: dataTransfer('wait-time'), clientX: 400, clientY: 300 });
      fireEvent.drop(pane, { dataTransfer: dataTransfer('wait-time'), clientX: 400, clientY: 300 });
    });
    await waitFor(() => expect(editor.querySelector('[data-step="wait-1"]')).not.toBeNull());
    // Kept where it was dropped, in the app's settings — the document itself has no positions.
    await waitFor(() =>
      expect(fake.bridge.calls.filter((call) => call.command === 'setWorkflowPositions').at(-1)?.args).toEqual([
        'invoices',
        { 'wait-1': { x: 300, y: 260 } },
      ]),
    );
    // The straight line became a flow with the new step beside its one delivery.
    expect(editor.querySelector('[data-step="deliver-billing-queue"]')).not.toBeNull();
    for (const kind of ['eventsRuleUpdate', 'eventsTargetUpdate'] as const) expect(fake.calls(kind), kind).toEqual([]);
  });

  it('a dropped step stays invalid and Save stays off until its fields pass', DESIGNER_SLOW, async () => {
    renderApp(service().bridge, { screen: 'events' });
    const editor = await openDesigner('invoices');
    // Untouched, there is nothing to save.
    expect(button(editor, 'Save draft').disabled).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: 'Add Notify me' }));
    const box = await waitFor(() => {
      const found = editor.querySelector<HTMLElement>('[data-step="notify-1"]');
      if (found === null) throw new Error('not dropped yet');
      return found;
    });
    // Nothing reaches it, and it says nothing yet: both are things to fix, so neither Save is on.
    expect(box.querySelector('[data-slot="step-problems"]')).not.toBeNull();
    expect(button(editor, 'Save draft').disabled).toBe(true);
    expect(button(editor, 'Review and approve…').disabled).toBe(true);
    expect(editor.textContent).toMatch(/to fix before it can be saved/);
    // Removed again, the workflow is as it was.
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove this step' }));
    await waitFor(() => expect(editor.querySelector('[data-step="notify-1"]')).toBeNull());
    expect(button(editor, 'Save draft').disabled).toBe(true);
  });

  it('a step that emits shows a mark with the count', DESIGNER_SLOW, async () => {
    renderApp(service().bridge, { screen: 'events' });
    const editor = await openDesigner('client-asks');
    const issue = await waitFor(() => {
      const found = editor.querySelector<HTMLElement>('[data-step="issue"]');
      if (found === null) throw new Error('not drawn yet');
      return found;
    });
    const mark = issue.querySelector<HTMLElement>('[data-slot="emit-mark"]');
    expect(mark?.textContent).toBe('1');
    expect(mark?.getAttribute('aria-label')).toBe('Raises 1 event');
    expect(editor.querySelector('[data-step="route"] [data-slot="emit-mark"]')?.textContent).toBe('2');
    expect(editor.querySelector('[data-step="find"] [data-slot="emit-mark"]')).toBeNull();
    // An outcome no wire leaves says it stops there.
    const tell = editor.querySelector<HTMLElement>('[data-step="tell"]') as HTMLElement;
    expect(tell.querySelector('[data-outcome="sent"] [data-slot="stops"]')?.textContent).toBe('Stops');
  });
});
