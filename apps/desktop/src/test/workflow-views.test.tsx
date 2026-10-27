/*
 * The three views in step, and Events → Workflows (0.36.0, plan E4, spec §11.2–§11.3, W17, W20, W22). One document
 * and one undo stack: the canvas, the text (parsed as it is typed) and the JSON (read-only). Text that does not parse
 * leaves the canvas on the last good document, dimmed, with the line of the mistake. The text reads no position. A
 * save keeps every step id. New workflow… starts from words, an empty canvas or a copy, and a straight line opened and
 * left untouched makes no call. The sidebar's Workflows opens Events on its Workflows tab.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonical, copyOf, type JsonObject } from '../rule-editor/model.ts';
import { printRuleText } from '../rule-text.ts';
import { moveNode, toGraph } from '../workflows/canvas.ts';
import { renderApp } from './render.tsx';
import { box, OWNER, openDesigner, polyfillCanvas, select, workflowService } from './workflow-bridge.ts';

beforeAll(polyfillCanvas);

function view(editor: HTMLElement, name: 'Canvas' | 'Text' | 'JSON'): void {
  fireEvent.click(within(within(editor).getByRole('group', { name: 'View as' })).getByRole('button', { name }));
}

const textArea = (editor: HTMLElement) =>
  within(editor).getByRole('textbox', { name: 'The workflow as text' }) as HTMLTextAreaElement;

const writes = [
  'eventsRuleUpdate',
  'eventsRuleCreate',
  'eventsRuleEnable',
  'eventsTargetUpdate',
  'eventsTargetAdd',
] as const;

describe('the three views of one workflow', () => {
  it('text that parses replaces the document and redraws the canvas', async () => {
    renderApp(workflowService().bridge, { screen: 'events' });
    const editor = await openDesigner('reminders');
    view(editor, 'Text');
    const text = await waitFor(() => textArea(editor));
    expect(text.value).toMatch(/^workflow reminders, version 2$/m);
    expect(text.value).toContain('step tell: tell me "Time to look at it again"');
    // The notice's step renamed, and the arrow into it with it.
    fireEvent.change(text, {
      target: { value: text.value.replace('step tell:', 'step say:').replace(/→ tell$/m, '→ say') },
    });
    await box(editor, 'say');
    expect(editor.querySelector('[data-step="tell"]')).toBeNull();
    view(editor, 'JSON');
    const json = await within(editor).findByRole('region', { name: 'Advanced: JSON' });
    expect(json.textContent).toContain('"say": {');
    expect(within(json).queryByRole('textbox')).toBeNull();
    // One undo stack: Undo puts the canvas back, whichever view made the change.
    view(editor, 'Canvas');
    fireEvent.click(within(editor).getByRole('button', { name: 'Undo' }));
    await box(editor, 'tell');
  });

  it('text that does not parse leaves the canvas on the last good document, dimmed, with the line', async () => {
    renderApp(workflowService().bridge, { screen: 'events' });
    const editor = await openDesigner('reminders');
    view(editor, 'Text');
    const text = await waitFor(() => textArea(editor));
    const lines = text.value.split('\n');
    const at = lines.findIndex((line) => line.includes('step tell:'));
    lines[at] = lines[at]?.replace('step tell: tell me', 'step tell: tel me') ?? '';
    fireEvent.change(text, { target: { value: lines.join('\n') } });
    const mistake = await within(editor).findByText(`The text has a mistake on line ${at + 1}`);
    expect(mistake).toBeTruthy();
    const canvas = editor.querySelector<HTMLElement>('[data-slot="workflow-canvas"]') as HTMLElement;
    expect(canvas.className).toContain('opacity-50');
    // The last good document: tell is still there, and the other views wait for the text.
    expect(canvas.querySelector('[data-step="tell"]')).not.toBeNull();
    const views = within(editor).getByRole('group', { name: 'View as' });
    expect((within(views).getByRole('button', { name: 'Canvas' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(editor).getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('printRuleText of a document is the same whatever its positions', () => {
    const document = copyOf(OWNER as JsonObject);
    const before = printRuleText(document);
    let positions = {};
    for (const id of ['route', 'find', 'gate:keep']) positions = moveNode(positions, id, { x: 4321, y: -40 });
    const drawn = toGraph(document, positions);
    expect(drawn.nodes.find((node) => node.id === 'route')?.position).toEqual({ x: 4321, y: -40 });
    expect(printRuleText(document)).toBe(before);
    expect(before).not.toContain('4321');
    expect(canonical(document)).toBe(canonical(OWNER));
  });

  it('saving keeps every step id of the last version', async () => {
    const service = workflowService();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await openDesigner('client-asks');
    const settings = await select(editor, 'find');
    fireEvent.click(settings.querySelector('[data-event="busy"]') as HTMLElement);
    const save = within(editor).getByRole('button', { name: 'Save draft' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await within(editor).findByText(/^Saved as version 6\./);
    const saved = service.stored.filter((each) => each.kind === 'eventsRuleUpdate').at(-1)?.document as JsonObject;
    const ids = (document: unknown) => Object.keys((document as { flow: { steps: object } }).flow.steps).sort();
    expect(ids(saved)).toEqual(ids(OWNER));
    expect((saved as { flow: { steps: { find: JsonObject } } }).flow.steps.find.emit).toEqual(['busy']);
  });

  it('New workflow… offers from your words, an empty canvas, or a copy', async () => {
    renderApp(workflowService().bridge, { screen: 'events' });
    fireEvent.click(await screen.findByRole('tab', { name: /^Workflows\b/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New workflow' });
    const starts = within(dialog).getByRole('radiogroup', { name: 'Start from' });
    const options = within(starts)
      .getAllByRole('radio')
      .map((radio) => radio.closest('label')?.textContent ?? radio.getAttribute('aria-label') ?? '');
    expect(options.map((each) => each.split(':')[0])).toEqual([
      'Your own words',
      'An empty canvas',
      'A copy of another workflow',
    ]);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'helper' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    const editor = await screen.findByRole('region', { name: 'New workflow helper' });
    // An empty canvas: the gate's boxes, and no step yet.
    await waitFor(() => expect(editor.querySelector('[data-gate="trigger"]')).not.toBeNull());
    expect(editor.querySelector('[data-step]')).toBeNull();
  });

  it('a straight-line workflow opened and closed untouched makes no call', async () => {
    const service = workflowService();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await openDesigner('invoices');
    await box(editor, 'deliver-billing-queue');
    expect((within(editor).getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(editor).getByRole('button', { name: 'Review and approve…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('region', { name: 'Workflow invoices' });
    for (const kind of writes) expect(service.calls(kind), kind).toEqual([]);
    expect(service.bridge.calls.filter((call) => call.command === 'setWorkflowPositions')).toEqual([]);
  });

  it("the sidebar's Workflows opens Events on its Workflows tab", async () => {
    renderApp(workflowService().bridge);
    const navigation = await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.click(within(navigation).getByRole('button', { name: /^Workflows ?New$/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Events' })).toBeTruthy();
    const tab = await screen.findByRole('tab', { name: /^Workflows\b/ });
    await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
    await screen.findByRole('region', { name: 'Workflows' });
    expect(
      within(navigation)
        .getByRole('button', { name: /^Workflows ?New$/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });
});
