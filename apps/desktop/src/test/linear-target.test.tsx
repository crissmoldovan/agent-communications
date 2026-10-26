/*
 * The Linear target in the app (0.33.0, design 2026-10-26-rules-that-act-0330 §3.4): the editor's Linear card offers
 * the labels Linear lists for the team (`integration show linear --team`), and keeps them as the target does — each
 * once, sorted by id; and a Linear delivery says which issue it added, its page opened only in the person's browser.
 * The answers are the shapes the event service's Linear builder wrote.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Call } from '../ipc.ts';
import { printRuleText } from '../rule-text.ts';
import deliveries from './fixtures/events-deliveries.v032.json';
import shows from './fixtures/events-rule-show.v032.json';
import { renderApp } from './render.tsx';
import { editorBridge, LINEAR } from './rule-editor-bridge.ts';

const CUE = LINEAR.connected.teams[0] as { id: string; key: string };
const LABELS = [
  { id: '1a2b3c4d-0000-4000-8000-0000000000b2', name: 'Billing' },
  { id: '1a2b3c4d-0000-4000-8000-0000000000a1', name: '<b>Urgent</b>' },
];

async function openRulesTab(): Promise<void> {
  const tab = await screen.findByRole('tab', { name: /^Rules\b/ });
  fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
}

describe('the Linear target', () => {
  it("offers the team's labels, and keeps the ones chosen sorted by id, as the target does", async () => {
    const service = editorBridge({
      fixtures: {
        integrationShow: (call: Call) => {
          const { integration, team } = call as Extract<Call, { kind: 'integrationShow' }>;
          if (integration !== 'linear') return {};
          return team === undefined ? LINEAR.connected : { ...LINEAR.connected, labels: LABELS };
        },
      },
    });
    renderApp(service.bridge, { screen: 'events' });
    await openRulesTab();
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-rule="invoices"]');
      if (found === null) throw new Error('no card');
      return found;
    });
    fireEvent.click(card);
    const page = await screen.findByRole('region', { name: 'Rule invoices' });
    fireEvent.click(await within(page).findByRole('button', { name: 'Edit…' }));
    const editor = await screen.findByRole('region', { name: 'Edit invoices' });
    // The rule as text, its action a Linear issue in team CUE.
    const invoices = (shows as Record<string, { document: Record<string, unknown> }[]>).invoices?.[1]?.document ?? {};
    const linear = {
      targetId: 'invoices-linear',
      version: 1,
      kind: 'linear',
      team: { id: CUE.id, key: CUE.key },
      title: { text: 'Invoice from {{from}}' },
      description: { text: '' },
      labels: [],
      assignee: 'me',
    };
    const retention = { ...(invoices.retention as Record<string, unknown>) };
    delete retention.queueMs;
    fireEvent.click(
      within(within(editor).getByRole('group', { name: 'Edit as' })).getByRole('button', { name: 'Text' }),
    );
    const text = (await within(editor).findByRole('textbox', { name: 'The rule as text' })) as HTMLTextAreaElement;
    fireEvent.change(text, {
      target: { value: printRuleText({ ...invoices, version: 3, targets: [linear], retention } as never) },
    });
    fireEvent.click(
      within(within(editor).getByRole('group', { name: 'Edit as' })).getByRole('button', { name: 'Visual' }),
    );
    const action = await waitFor(() => {
      const found = editor.querySelector<HTMLElement>('[data-action="linear"]');
      if (found === null) throw new Error('no Linear card');
      return found;
    });
    // The labels Linear lists for the team, read with the team's key; a name is text, never markup.
    const urgent = await within(action).findByRole('button', { name: '<b>Urgent</b>' });
    expect(action.querySelector('b')).toBeNull();
    expect(
      service
        .calls('integrationShow')
        .some((each) => (each as Extract<Call, { kind: 'integrationShow' }>).team === 'CUE'),
    ).toBe(true);
    fireEvent.click(within(action).getByRole('button', { name: 'Billing' }));
    fireEvent.click(urgent);
    fireEvent.click(
      within(within(editor).getByRole('group', { name: 'Edit as' })).getByRole('button', { name: 'Advanced: JSON' }),
    );
    const json = await within(editor).findByRole('region', { name: 'Advanced: JSON' });
    const shown = JSON.parse(json.querySelector('[data-slot="rule-json"]')?.textContent ?? '{}') as {
      targets: { labels: { id: string }[]; title: unknown }[];
    };
    expect(shown.targets[0]?.labels.map((label) => label.id)).toEqual([
      '1a2b3c4d-0000-4000-8000-0000000000a1',
      '1a2b3c4d-0000-4000-8000-0000000000b2',
    ]);
    expect(shown.targets[0]?.title).toEqual({ text: 'Invoice from {{from}}' });
  });

  it('a Linear delivery names the issue it added, and opens its page only in the browser', async () => {
    const row = {
      ...deliveries[0],
      deliveryId: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b99',
      targetId: 'invoices-linear',
      targetKind: 'linear',
      linear: { identifier: 'CUE-1', url: 'https://linear.app/example/issue/CUE-1' },
    };
    const odd = {
      ...row,
      deliveryId: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b98',
      linear: { identifier: 'CUE-2', url: 'https://evil.example/issue/CUE-2' },
    };
    const service = editorBridge({
      fixtures: {
        eventsDeliveries: [row, odd],
        eventsDeliveryShow: (call: Call) => ({
          delivery: (call as Extract<Call, { kind: 'eventsDeliveryShow' }>).deliveryId === row.deliveryId ? row : odd,
          decision: null,
          event: null,
          target: { kind: 'linear', id: 'invoices-linear', version: 1, host: null, lane: null },
          dryRun: null,
        }),
      },
    });
    renderApp(service.bridge, { screen: 'events' });
    const tab = await screen.findByRole('tab', { name: /^Deliveries\b/ });
    fireEvent.click(tab);
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-delivery="${row.deliveryId}"]`);
      if (found === null) throw new Error('no row');
      return found;
    });
    expect(line.querySelector('[data-slot="delivery-title"]')?.textContent).toBe('invoices → Linear, CUE-1');
    fireEvent.click(line);
    const page = await screen.findByRole('region', { name: 'Delivery' });
    await within(page).findByText('Added CUE-1 in Linear.');
    fireEvent.click(within(page).getByRole('link', { name: 'Open in Linear' }));
    await waitFor(() =>
      expect(service.bridge.calls.filter((each) => each.command === 'openLink').map((each) => each.args)).toEqual([
        'https://linear.app/example/issue/CUE-1',
      ]),
    );
    // An address that is not Linear's issue page is named, and never offered to open.
    fireEvent.click(within(page).getByRole('button', { name: 'All deliveries' }));
    const other = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-delivery="${odd.deliveryId}"]`);
      if (found === null) throw new Error('no row');
      return found;
    });
    fireEvent.click(other);
    const second = await screen.findByRole('region', { name: 'Delivery' });
    await within(second).findByText('Added CUE-2 in Linear.');
    expect(within(second).queryByRole('link', { name: 'Open in Linear' })).toBeNull();
  });
});
