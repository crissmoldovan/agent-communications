/*
 * Each step's settings, with its Events, and the workflow's settings (0.36.0, plan E3, spec §11.3, W23, W24, W33,
 * W36). A step's Events list its kind's words from Appendix W, every one off until ticked; the first tick writes where
 * the events are named, and a workflow whose id cannot be part of a name is given one first. A Deliver's settings edit
 * its target, which Save makes a new version of; the limits refuse a value above their ceiling; and Find this
 * conversation's session looks in the thread, with Claude only. Every answer is a fixture.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Call } from '../ipc.ts';
import type { JsonObject } from '../rule-editor/model.ts';
import { WorkflowSettings } from '../screens/workflows/WorkflowSettings.tsx';
import { eventNames, namespaceFor, tickEvent, ticks } from '../workflows/settings.ts';
import { renderApp } from './render.tsx';
import {
  DESIGNER_SLOW,
  OWNER,
  openDesigner,
  polyfillCanvas,
  REMINDERS,
  select,
  workflowService,
} from './workflow-bridge.ts';

beforeAll(polyfillCanvas);

type Flow = { events?: JsonObject; steps: Record<string, JsonObject>; limits: JsonObject };
const flowOf = (document: unknown) => (document as { flow: Flow }).flow;

/** The document the last `rule update` stored. */
function lastSaved(service: ReturnType<typeof workflowService>): JsonObject | undefined {
  return service.stored.filter((each) => each.kind === 'eventsRuleUpdate').at(-1)?.document as JsonObject | undefined;
}

async function saveDraft(editor: HTMLElement): Promise<void> {
  const save = within(editor).getByRole('button', { name: 'Save draft' }) as HTMLButtonElement;
  await waitFor(() => expect(save.disabled).toBe(false));
  fireEvent.click(save);
  await within(editor).findByText(/^Saved as version \d+\./);
}

describe("each step's settings and the workflow's", () => {
  it("Events lists the kind's words from Appendix W, all off by default", DESIGNER_SLOW, async () => {
    expect(ticks('find-session')).toEqual([
      'started',
      'succeeded',
      'failed',
      'skipped',
      'retrying',
      'found',
      'busy',
      'not-found',
      'watched',
    ]);
    // A wait's own words follow what it waits for; a delivery's, its target's kind; a Raise step has none to tick.
    expect(ticks('wait', { kind: 'wait', for: { time: { afterMs: 1 } }, timeoutMs: 1, next: {} })).toEqual([
      'started',
      'succeeded',
      'waiting',
      'skipped',
      'elapsed',
    ]);
    expect(ticks('deliver', undefined, 'linear')).toContain('created');
    expect(ticks('deliver')).toEqual([]);
    expect(ticks('raise')).toEqual([]);
    // On the canvas: find's settings show each word, none of them ticked.
    renderApp(workflowService().bridge, { screen: 'events' });
    const editor = await openDesigner('client-asks');
    const settings = await select(editor, 'find');
    const events = within(settings).getByRole('region', { name: 'Events' });
    const words = [...events.querySelectorAll<HTMLElement>('[data-event]')];
    expect(words.map((each) => each.dataset.event)).toEqual(ticks('find-session'));
    for (const word of words) expect(word.getAttribute('aria-pressed'), word.dataset.event).toBe('false');
  });

  it(
    'the first tick fills flow.events with the namespace from the trigger account (acme for acme/slack) and the workflow id',
    DESIGNER_SLOW,
    async () => {
      expect(namespaceFor('acme/slack')).toBe('acme');
      expect(namespaceFor('Cue Plus/slack')).toBe('me');
      expect(namespaceFor('com/gmail')).toBe('me');
      const names = eventNames(REMINDERS as JsonObject, new Map());
      expect(names).toEqual({ namespace: 'acme', workflow: 'reminders', written: false });
      const ticked = tickEvent(REMINDERS as JsonObject, 'wait', 'elapsed', true, names) as JsonObject;
      expect(flowOf(ticked).events).toEqual({ namespace: 'acme', workflow: 'reminders' });
      expect(flowOf(ticked).steps.wait?.emit).toEqual(['elapsed']);
      // In the designer, ticked and saved.
      const service = workflowService();
      renderApp(service.bridge, { screen: 'events' });
      const editor = await openDesigner('reminders');
      const settings = await select(editor, 'wait');
      const events = within(settings).getByRole('region', { name: 'Events' });
      fireEvent.click(events.querySelector('[data-event="elapsed"]') as HTMLElement);
      await waitFor(() =>
        expect(within(settings).getByRole('region', { name: 'Events' }).textContent).toContain(
          'acme.reminders.wait.<event>',
        ),
      );
      await saveDraft(editor);
      const saved = flowOf(lastSaved(service));
      expect(saved.events).toEqual({ namespace: 'acme', workflow: 'reminders' });
      expect(saved.steps.wait?.emit).toEqual(['elapsed']);
    },
  );

  it('a workflow id that is not a segment asks for a name before the first tick', DESIGNER_SLOW, async () => {
    const odd = { ...REMINDERS, ruleId: 'Reminders.Daily' };
    expect(tickEvent(odd as JsonObject, 'wait', 'elapsed', true, eventNames(odd as JsonObject, new Map()))).toBeNull();
    const service = workflowService([odd]);
    renderApp(service.bridge, { screen: 'events' });
    const editor = await openDesigner('Reminders.Daily');
    const settings = await select(editor, 'wait');
    const events = within(settings).getByRole('region', { name: 'Events' });
    const elapsed = events.querySelector<HTMLButtonElement>('[data-event="elapsed"]') as HTMLButtonElement;
    expect(elapsed.disabled).toBe(true);
    const name = within(events).getByRole('textbox', { name: 'Name its events' });
    fireEvent.change(name, { target: { value: 'Daily!' } });
    expect(await within(events).findByText(/Lowercase letters, digits, _ and -/)).toBeTruthy();
    fireEvent.change(name, { target: { value: 'daily-reminders' } });
    await waitFor(() => expect(elapsed.disabled).toBe(false));
    fireEvent.click(elapsed);
    await saveDraft(editor);
    expect(flowOf(lastSaved(service)).events).toEqual({ namespace: 'acme', workflow: 'daily-reminders' });
  });

  it("a Deliver's settings edit its target; Save makes a new target version", DESIGNER_SLOW, async () => {
    const service = workflowService();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await openDesigner('client-asks');
    const settings = await select(editor, 'issue');
    const title = within(settings).getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
    expect(title.value).toBe('{{author.name}} asks about {{steps.route.project}}');
    fireEvent.change(title, { target: { value: '{{author.name}}: {{steps.route.project}}' } });
    await saveDraft(editor);
    const target = service.stored.find((each) => each.kind === 'eventsTargetUpdate')?.document as JsonObject;
    expect(target).toMatchObject({
      targetId: 'client-issues',
      version: 2,
      title: { text: '{{author.name}}: {{steps.route.project}}' },
    });
    const saved = lastSaved(service) as JsonObject;
    expect((saved.targets as JsonObject[]).find((each) => each.targetId === 'client-issues')?.version).toBe(2);
    // The step that delivers to it follows it to the new version.
    expect(flowOf(saved).steps.issue?.target).toEqual({ targetId: 'client-issues', version: 2 });
    // The targets it did not change keep their versions.
    expect(flowOf(saved).steps.give?.target).toEqual({ targetId: 'client-prompt', version: 2 });
    expect(service.calls('eventsTargetUpdate' as Call['kind'])).toHaveLength(1);
  });

  it('limits refuse a value above the ceiling', async () => {
    let changed: JsonObject | null = null;
    render(
      <WorkflowSettings
        document={OWNER as JsonObject}
        problems={[]}
        names={new Map()}
        onChange={(next) => {
          changed = next;
        }}
        onNames={() => undefined}
      />,
    );
    const runs = screen.getByRole('textbox', { name: 'Runs an hour' });
    fireEvent.change(runs, { target: { value: '61' } });
    expect(await screen.findByText('At most 60.')).toBeTruthy();
    expect(changed).toBeNull();
    fireEvent.change(runs, { target: { value: '60' } });
    await waitFor(() => expect(changed).not.toBeNull());
    expect(flowOf(changed).limits.runsPerHour).toBe(60);
    changed = null;
    fireEvent.change(screen.getByRole('textbox', { name: 'A run lasts at most, in hours' }), {
      target: { value: '721' },
    });
    expect(await screen.findByText('At most 720 hours.')).toBeTruthy();
    expect(changed).toBeNull();
  });

  it("Find this conversation's session sets in { thread: true } and offers Claude only", DESIGNER_SLOW, async () => {
    const service = workflowService();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await openDesigner('client-asks');
    const settings = await select(editor, 'find');
    const where = within(settings).getByRole('group', { name: 'Where' });
    fireEvent.click(within(where).getByRole('button', { name: 'This conversation' }));
    const provider = await waitFor(() => within(settings).getByRole('group', { name: 'With' }));
    await waitFor(() =>
      expect((within(provider).getByRole('button', { name: 'Codex' }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(within(settings).getByText(/Only Claude Code records which session took a message/)).toBeTruthy();
    expect(
      within(editor).getByText('Find this conversation’s session', { selector: '[data-step="find"] *' }),
    ).toBeTruthy();
    await saveDraft(editor);
    const find = flowOf(lastSaved(service)).steps.find as JsonObject;
    expect(find.in).toEqual({ thread: true });
    expect(find.provider).toBe('claude');
  });
});
