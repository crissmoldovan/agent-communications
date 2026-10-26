import { Tabs } from '@cueplusplus/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RuleJsonPane, RuleTextPane } from '../screens/events/RuleText.tsx';
import {
  ACTIVITY_INSTALLATION,
  createFakeBridge,
  type FakeBridge,
  fakeQueue,
  QUEUE_INSTALLATION,
} from './fake-bridge.ts';
import { renderApp } from './render.tsx';

/*
 * cue-ui 0.34.0's gliding marks and swipeable tabs (cue-ui-79, cue-ui-80), in the rendered app: each page's tab strip
 * draws the gliding indicator and swipes, the sidebar and a segmented control draw one gliding mark once measured, a
 * sideways swipe over a panel moves to the next tab, and what moves sideways itself inside a panel is left to itself
 * (`marks-source.test.ts` holds the source to the same).
 */

/** The Queue screen's bridge, as its own tests give it (a core and an events service that have the queue). */
const queueBridge = (): FakeBridge =>
  createFakeBridge({ installation: async () => QUEUE_INSTALLATION }, { ...fakeQueue(), version: () => '0.30.0' });

/** The four screens whose tab strips are the page's own, each with its strip's name and a bridge that shows it. */
const STRIPS = [
  ['approvals', 'Approvals', createFakeBridge],
  ['queue', 'Queue', queueBridge],
  ['events', 'Events', createFakeBridge],
  ['accounts', 'Channels', createFakeBridge],
] as const;

describe('the marks and the swipe, in the rendered app', () => {
  for (const [name, label, bridge] of STRIPS) {
    it(`${name}: its tab strip draws the gliding indicator, and its tabs swipe`, async () => {
      renderApp(bridge(), { screen: name });
      const list = await screen.findByRole('tablist', { name: label });
      expect(list.querySelectorAll(':scope > [data-slot="tabs-indicator"]')).toHaveLength(1);
      expect(list.closest('[data-slot="tabs"]')?.hasAttribute('data-swipe')).toBe(true);
    });
  }

  describe('once measured', () => {
    // jsdom lays nothing out, and a mark is drawn only once its item has a size: give every element one, its box and
    // its client rect alike, so the mark's scale (rect over box) is one.
    const BOX = 40;
    const sized = {
      offsetWidth: { configurable: true, get: () => BOX },
      offsetHeight: { configurable: true, get: () => BOX },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, BOX, BOX) },
    } satisfies Record<string, PropertyDescriptor>;
    const original = Object.fromEntries(
      Object.keys(sized).map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]),
    );
    const restore = () => {
      for (const key of Object.keys(sized)) {
        const descriptor = original[key];
        if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, key);
        else Object.defineProperty(HTMLElement.prototype, key, descriptor);
      }
    };
    afterEach(restore);

    it("the sidebar's ground and a segmented control's fill are each one gliding mark", async () => {
      Object.defineProperties(HTMLElement.prototype, sized);
      renderApp(createFakeBridge({ installation: async () => ACTIVITY_INSTALLATION }), { screen: 'activity' });
      const range = await screen.findByRole('group', { name: 'Time range' });
      await waitFor(() => expect(range.querySelectorAll('[data-slot="segmented-control-indicator"]')).toHaveLength(1));
      const sections = within(screen.getByRole('navigation', { name: 'Sections' }));
      expect(sections.getByRole('button', { name: /^Activity/ }).hasAttribute('data-active')).toBe(true);
      expect(document.querySelectorAll('[data-slot="sidebar-indicator"]').length).toBeGreaterThan(0);
    });
  });

  it('a sideways swipe over a panel moves to the next tab', async () => {
    renderApp(createFakeBridge(), { screen: 'approvals' });
    const list = await screen.findByRole('tablist', { name: 'Approvals' });
    const waiting = within(list).getByRole('tab', { name: /^Waiting/ });
    expect(waiting.getAttribute('aria-selected')).toBe('true');
    const panel = screen.getByRole('tabpanel');
    await act(async () => {
      fireEvent.wheel(panel, { deltaX: 60, deltaY: 0 });
    });
    await waitFor(() =>
      expect(within(list).getByRole('tab', { name: 'Recent' }).getAttribute('aria-selected')).toBe('true'),
    );
  });
});

/** Two tabs that swipe, the first panel holding `children` beside a line of its own. */
function Swiping({ children }: { children: ReactNode }) {
  return (
    <Tabs.Root swipe defaultValue="first">
      <Tabs.List aria-label="Views">
        <Tabs.Tab value="first">First</Tabs.Tab>
        <Tabs.Tab value="second">Second</Tabs.Tab>
        <Tabs.Indicator />
      </Tabs.List>
      <Tabs.Panel value="first">
        <p>Beside it</p>
        {children}
      </Tabs.Panel>
      <Tabs.Panel value="second">The second view</Tabs.Panel>
    </Tabs.Root>
  );
}

const selected = () => screen.getByRole('tab', { selected: true }).textContent;

describe("the rule editor's panes are left to themselves", () => {
  it("a swipe over the rule's JSON, which scrolls sideways, stays with it", () => {
    render(
      <Swiping>
        <RuleJsonPane document={{ kind: 'rule', when: { channel: 'slack' } }} />
      </Swiping>,
    );
    const json = document.querySelector('[data-slot="rule-json"]');
    expect(json?.getAttribute('data-tabs-swipe')).toBe('ignore');
    fireEvent.wheel(json as Element, { deltaX: 60, deltaY: 0 });
    expect(selected()).toBe('First');
  });

  it("a swipe over the text editor's bar stays with the editor, where one over the panel beside it moves on", () => {
    const first = render(
      <Swiping>
        <RuleTextPane text="when slack" onText={() => undefined} />
      </Swiping>,
    );
    const editor = screen.getByRole('textbox').closest('[data-slot="panel"]');
    expect(editor?.getAttribute('data-tabs-swipe')).toBe('ignore');
    // The bar is not a field, so only the mark keeps the gesture from the tabs.
    fireEvent.wheel(editor?.querySelector('p') as Element, { deltaX: 60, deltaY: 0 });
    expect(selected()).toBe('First');
    first.unmount();

    render(
      <Swiping>
        <RuleTextPane text="when slack" onText={() => undefined} />
      </Swiping>,
    );
    fireEvent.wheel(screen.getByText('Beside it'), { deltaX: 60, deltaY: 0 });
    expect(selected()).toBe('Second');
  });
});
