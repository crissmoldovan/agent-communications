import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Call, CliResult, Installation } from '../ipc.ts';
import { PEOPLE_COPY, SEARCH_COPY, SEARCH_SETTINGS_COPY } from '../screens/search/copy.ts';
import { createFakeBridge, EXAMPLE_INSTALLATION, type FakeBridge, failed, ok } from './fake-bridge.ts';
import activityItems from './fixtures/activity-items.json';
import searchPeople from './fixtures/search-people.json';
import searchPerson from './fixtures/search-person.json';
import searchQuery from './fixtures/search-query.json';
import statusNever from './fixtures/search-status.never.json';
import statusOn from './fixtures/search-status.on.json';
import { renderApp } from './render.tsx';

/*
 * Search on this machine in the app (0.35.0, design 2026-10-26-local-search §8; boards `Search`, `Person` and
 * `SettingsSearch`): People, Ask about past messages, and Settings → Search on this Mac, against the fake bridge and
 * fixtures in core's own shapes. Nothing runs, and nothing reaches a CLI, Gmail, Slack or a model.
 */

// Core takes the app's own approval only where the app is attested (macOS). These tests run as macOS unless one says
// otherwise.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

const SLOW = { timeout: 30_000 };
const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';
const DAVID = 'p_K19FVJ41QS08HPWN3XC3RQ2K7B';
const DAVID_SLACK = 'p_8GE1HWF42A0071A07VARPJWX1D';

const main = (): HTMLElement => screen.getByRole('main');

type Answers = Partial<Record<Call['kind'], (call: Call) => CliResult>>;

/** `activity items --ids`, answered from the Messages fixture: only the ids asked for. */
function activityFor(call: Call): CliResult {
  const ids = new Set((call as Extract<Call, { kind: 'activityItems' }>).ids ?? []);
  return ok({ items: Object.fromEntries(Object.entries(activityItems.items).filter(([id]) => ids.has(id))) });
}

const SEARCH_ANSWERS: Answers = {
  searchStatus: () => ok(statusOn),
  searchQuery: () => ok(searchQuery),
  searchPeople: () => ok(searchPeople),
  searchPerson: () => ok(searchPerson),
  searchIndex: () =>
    ok({ ran: true, busy: false, taken: 0, embedded: 0, pending: 0, pruned: 0, model: null, stopped: false }),
  activityItems: activityFor,
  approvalsFinished: () => ok([]),
};

/** Core at `version` (0.35.0 by default, the first with Search), answering Search's calls from the fixtures. */
function bridgeAt(version = '0.35.0', answers: Answers = {}): FakeBridge {
  const installation: Installation = { ...EXAMPLE_INSTALLATION, version };
  const base = createFakeBridge({ installation: async () => installation });
  const given = { ...SEARCH_ANSWERS, ...answers };
  return createFakeBridge({
    installation: async () => installation,
    cli: async (call) => given[call.kind]?.(call) ?? base.cli(call),
  });
}

/** The calls of one kind made, in order. */
function asked<K extends Call['kind']>(bridge: FakeBridge, kind: K): Extract<Call, { kind: K }>[] {
  return bridge.calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind === kind)
    .map((call) => call.args as Extract<Call, { kind: K }>);
}

const searchKinds = (bridge: FakeBridge): string[] =>
  bridge.calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind.startsWith('search'))
    .map((call) => (call.args as Call).kind);

/** Each part a sender wrote, boxed From outside, holds only text: no element came from their words. */
function onlyText(root: HTMLElement): void {
  const boxes = root.querySelectorAll('[data-slot="from-outside"]');
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of Array.from(boxes)) {
    expect(box.querySelector('b, img, script, a')).toBeNull();
  }
}

/** Chooses `option` in the select named `name`, as a pointer does. */
async function choose(root: HTMLElement, name: string, option: string | RegExp): Promise<void> {
  fireEvent.click(within(root).getByRole('combobox', { name }));
  const item = await screen.findByRole('option', { name: option });
  fireEvent.pointerMove(item);
  fireEvent.mouseMove(item);
  fireEvent.click(item);
}

/** Asks `text` on the Search screen. */
async function ask(text: string): Promise<void> {
  const field = await screen.findByRole('searchbox', { name: SEARCH_COPY.field });
  fireEvent.change(field, { target: { value: text } });
  fireEvent.click(within(main()).getByRole('button', { name: SEARCH_COPY.ask }));
}

describe('People', () => {
  it('sits after Messages with a New tag; an older core gets the update line and no Search call', SLOW, async () => {
    const bridge = bridgeAt('0.34.0');
    renderApp(bridge);
    const navigation = await screen.findByRole('navigation', { name: 'Sections' });
    const labels = Array.from(navigation.querySelectorAll('[data-slot="sidebar-item-label"]')).map(
      (label) => label.textContent,
    );
    expect(labels.slice(0, 4)).toEqual(['Overview', 'Queue', 'Messages', 'People']);
    const entry = within(navigation).getByRole('button', { name: /^People/ });
    expect(entry.querySelector('[data-slot="new-tag"]')?.textContent?.trim()).toBe('New');
    fireEvent.click(entry);
    expect(await screen.findByRole('heading', { level: 1, name: PEOPLE_COPY.title })).toBeTruthy();
    expect(within(main()).getByText('Needs 0.35.0 or later; this machine has 0.34.0.')).toBeTruthy();
    expect(searchKinds(bridge)).toEqual([]);
  });

  it(
    'lists everyone a message is kept from, each name a sender gave boxed From outside, and runs the indexer once',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      renderApp(bridge, { screen: 'people' });
      await waitFor(() => expect(main().querySelectorAll('li[data-person]')).toHaveLength(3));
      const rows = Array.from(main().querySelectorAll<HTMLElement>('li[data-person]'));
      expect(rows.map((row) => row.dataset.person)).toEqual([DAVID, DAVID_SLACK, 'p_0B6F0RV3TG2X85D5K95WQFESA3']);
      // A hostile name is text, inside its box; its closing tag, defused by core, closes nothing.
      const mallory = rows[2] as HTMLElement;
      onlyText(mallory);
      expect(mallory.textContent).toContain('<b>bold</b>');
      expect(within(rows[0] as HTMLElement).getByText('david@example.com')).toBeTruthy();
      expect(within(rows[1] as HTMLElement).getByText('U0DAVID in T0EXAMPLE')).toBeTruthy();
      // S10: the indexer runs as People opens, for a short budget.
      expect(asked(bridge, 'searchIndex')).toContainEqual({ kind: 'searchIndex', budget: 10 });
    },
  );

  it(
    'one person: their handles, what they asked with what was done, and only the person joins, parts or names them',
    SLOW,
    async () => {
      const linked: Call[] = [];
      const bridge = bridgeAt('0.35.0', {
        searchLink: (call) => {
          linked.push(call);
          return ok({ person: DAVID, joined: DAVID_SLACK, handles: ['email:david@example.com'] });
        },
        searchLabel: (call) => {
          linked.push(call);
          return ok({ person: DAVID, label: 'David' });
        },
      });
      renderApp(bridge, { screen: 'people' });
      fireEvent.click(await screen.findByRole('button', { name: /david@example\.com/ }));
      const asks = await screen.findByRole('region', { name: PEOPLE_COPY.asked });
      // What he asked, and the join's state for it: replied, from the send listed under its draft.
      const row = await waitFor(() => {
        const found = asks.querySelector<HTMLElement>('li[data-asked="18c2f0a1b2c3d4e5"]');
        expect(found?.textContent).toContain('Replied');
        return found as HTMLElement;
      });
      onlyText(row);
      expect(asked(bridge, 'searchPerson')).toEqual([{ kind: 'searchPerson', personId: DAVID, limit: 50 }]);
      expect(asked(bridge, 'activityItems').map((call) => call.ids)).toEqual([
        ['18c2f0a1b2c3d4e5'],
        ['r-2000000000000000001'],
      ]);
      // One handle: nothing to separate.
      expect(within(main()).queryByRole('button', { name: PEOPLE_COPY.separate })).toBeNull();
      // The Slack David gave the same name: offered as a suggestion, joined only when the person presses it.
      const same = main().querySelector<HTMLElement>('[data-slot="same-name"]') as HTMLElement;
      expect(same.textContent).toContain(PEOPLE_COPY.sameName);
      expect(linked).toEqual([]);
      fireEvent.click(within(same).getByRole('button', { name: /^Same person/ }));
      await waitFor(() => expect(linked).toEqual([{ kind: 'searchLink', personId: DAVID, otherId: DAVID_SLACK }]));
      expect(await within(main()).findByText(PEOPLE_COPY.joined)).toBeTruthy();
      // Their name, as the person knows them.
      const name = within(main()).getByRole('textbox', { name: PEOPLE_COPY.name });
      fireEvent.change(name, { target: { value: '  David  ' } });
      fireEvent.click(within(main()).getByRole('button', { name: PEOPLE_COPY.save }));
      await waitFor(() => expect(linked.at(-1)).toEqual({ kind: 'searchLabel', personId: DAVID, label: 'David' }));
      // A name core would refuse is never sent.
      fireEvent.change(name, { target: { value: 'Da‮vid' } });
      fireEvent.click(within(main()).getByRole('button', { name: PEOPLE_COPY.save }));
      expect(await within(main()).findByText(PEOPLE_COPY.nameRefused)).toBeTruthy();
      expect(asked(bridge, 'searchLabel')).toHaveLength(1);
    },
  );

  it('a person with two handles may be parted, handle by handle, at once', SLOW, async () => {
    const both = {
      ...searchPerson,
      person: {
        ...searchPerson.person,
        linked: true,
        handles: [
          ...searchPerson.person.handles,
          { handle: 'slack:T0EXAMPLE/U0DAVID', name: searchPerson.person.handles[0]?.name },
        ],
      },
    };
    const bridge = bridgeAt('0.35.0', {
      searchPerson: () => ok(both),
      searchUnlink: () => ok({ handle: 'slack:T0EXAMPLE/U0DAVID', person: DAVID_SLACK, from: DAVID }),
    });
    renderApp(bridge, { screen: 'people' });
    fireEvent.click(await screen.findByRole('button', { name: /david@example\.com/ }));
    const slack = await waitFor(() => {
      const found = main().querySelector<HTMLElement>('li[data-handle="slack:T0EXAMPLE/U0DAVID"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(main()).getByText(PEOPLE_COPY.joinedByYou)).toBeTruthy();
    fireEvent.click(within(slack).getByRole('button', { name: PEOPLE_COPY.separate }));
    await waitFor(() =>
      expect(asked(bridge, 'searchUnlink')).toEqual([{ kind: 'searchUnlink', handle: 'slack:T0EXAMPLE/U0DAVID' }]),
    );
    expect(await within(main()).findByText(PEOPLE_COPY.separated)).toBeTruthy();
  });
});

describe('Ask about past messages', () => {
  it('is Messages’ second part: its tab opens it, and the sidebar still lights Messages', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      eventsMessagesList: () => ok({ messages: [], next: null }),
      activityItems: () => ok({ items: {} }),
    });
    renderApp(bridge, { screen: 'messages' });
    const tabs = await screen.findByRole('navigation', { name: 'Messages' });
    expect(within(tabs).getByRole('button', { name: 'All messages' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(tabs).getByRole('button', { name: SEARCH_COPY.heading }));
    // The whole app renders Search for the first time here: it is given room on a loaded machine.
    expect(await screen.findByRole('searchbox', { name: SEARCH_COPY.field }, { timeout: 15_000 })).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    expect(
      within(navigation)
        .getByRole('button', { name: /^Messages/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it(
    'finds what people asked, each sender’s word From outside, with what was done joined in and its story a press away',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      renderApp(bridge, { screen: 'search' });
      expect(await screen.findByText(SEARCH_COPY.local)).toBeTruthy();
      await ask('invoices');
      await waitFor(() => expect(main().querySelectorAll('li[data-hit]')).toHaveLength(3));
      expect(asked(bridge, 'searchQuery')).toEqual([{ kind: 'searchQuery', text: 'invoices', limit: 50 }]);
      const hits = Array.from(main().querySelectorAll<HTMLElement>('li[data-hit]'));
      for (const hit of hits) onlyText(hit);
      const [slack, gmail, hostile] = hits as [HTMLElement, HTMLElement, HTMLElement];
      // What was done, from the join (S4): reacted to, replied to, read by an agent.
      await waitFor(() => expect(gmail.textContent).toContain('Replied'));
      expect(slack.textContent).toContain('Acknowledged');
      expect(hostile.textContent).toContain('Read by an agent');
      // Slack's mismatch, a partial read, how each was found.
      expect(within(slack).getByText(SEARCH_COPY.mismatch)).toBeTruthy();
      expect(within(hostile).getByText(SEARCH_COPY.partial)).toBeTruthy();
      expect(within(hostile).getByText(SEARCH_COPY.found.meaning)).toBeTruthy();
      expect(hostile.textContent).toContain('<b>bold</b>');
      // What Ask covers, and what is not encrypted (S11).
      expect(within(main()).getByText(SEARCH_COPY.notEncrypted)).toBeTruthy();
      expect(
        within(main()).getByText(/Ask looks through what Agent Comms saw: the messages agents read in/),
      ).toBeTruthy();
      expect(within(main()).getByText(SEARCH_COPY.pending(2))).toBeTruthy();
      // Its story, as Messages tells it; back to what was found.
      fireEvent.click(within(gmail).getByRole('button', { name: SEARCH_COPY.open }));
      expect(await screen.findByRole('region', { name: 'What happened' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
      await waitFor(() => expect(main().querySelectorAll('li[data-hit]')).toHaveLength(3));
      // Nothing an agent could reach: no other Search call ran but the reads and the indexer.
      expect(new Set(searchKinds(bridge))).toEqual(
        new Set(['searchStatus', 'searchPeople', 'searchIndex', 'searchQuery']),
      );
    },
  );

  it('a question core would refuse is never sent; From, When and a state narrow what is found', SLOW, async () => {
    const bridge = bridgeAt();
    renderApp(bridge, { screen: 'search' });
    await ask('a‮b');
    expect(await within(main()).findByText(SEARCH_COPY.refusedCharacter)).toBeTruthy();
    expect(asked(bridge, 'searchQuery')).toEqual([]);
    await ask('-draft');
    await waitFor(() => expect(asked(bridge, 'searchQuery')).toHaveLength(1));
    await waitFor(() => expect(main().querySelectorAll('li[data-hit]')).toHaveLength(3));
    await choose(main(), SEARCH_COPY.when, SEARCH_COPY.windows.week);
    await waitFor(() => expect(asked(bridge, 'searchQuery')).toHaveLength(2));
    const week = asked(bridge, 'searchQuery')[1];
    expect(week?.text).toBe('-draft');
    expect(week?.since).toBeLessThanOrEqual(Date.now() - 7 * 24 * 60 * 60 * 1000 + 60_000);
    await waitFor(() => expect(main().querySelector('li[data-hit] [data-slot="message-status"]')).not.toBeNull());
    await choose(main(), SEARCH_COPY.state, 'Replied');
    await waitFor(() => expect(main().querySelectorAll('li[data-hit]')).toHaveLength(1));
    expect(within(main()).getByText(SEARCH_COPY.amongBest)).toBeTruthy();
  });

  it(
    'a name in the question is offered as a suggestion, and choosing it asks again from that person only',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      renderApp(bridge, { screen: 'search' });
      await waitFor(() => expect(asked(bridge, 'searchPeople')).toHaveLength(1));
      await ask('what did David Example ask about invoices');
      const suggestion = await waitFor(() => {
        const found = main().querySelector<HTMLElement>('[data-slot="search-suggestion"]');
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      expect(suggestion.textContent).toContain(SEARCH_COPY.suggestion);
      const offers = within(suggestion).getAllByRole('button', { name: /^Only from/ });
      expect(offers).toHaveLength(2);
      fireEvent.click(offers[0] as HTMLElement);
      await waitFor(() => expect(asked(bridge, 'searchQuery')).toHaveLength(2));
      expect(asked(bridge, 'searchQuery')[1]).toEqual({
        kind: 'searchQuery',
        text: 'what did David Example ask about invoices',
        person: DAVID,
        limit: 50,
      });
    },
  );

  it(
    'by words only, it says so and why; switched off with nothing kept, it says where to switch it on',
    SLOW,
    async () => {
      const words = {
        ...searchQuery,
        mode: 'words',
        pending: 0,
        model: null,
        modelNote: 'Ollama isn’t answering at http://127.0.0.1:11434',
      };
      const bridge = bridgeAt('0.35.0', { searchQuery: () => ok(words) });
      renderApp(bridge, { screen: 'search' });
      await ask('invoices');
      const line = await waitFor(() => {
        const found = main().querySelector<HTMLElement>('[data-slot="search-words-only"]');
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      expect(line.textContent).toContain('Ollama isn’t answering');
      // Off, and nothing kept: nothing to ask about.
      const off = bridgeAt('0.35.0', { searchStatus: () => ok(statusNever) });
      renderApp(off, { screen: 'search' });
      expect(await screen.findByText(SEARCH_COPY.offEmpty)).toBeTruthy();
      expect(asked(off, 'searchQuery')).toEqual([]);
    },
  );
});

describe('Settings → Search on this Mac', () => {
  /** The section, once its status is read. */
  async function section(bridge: FakeBridge): Promise<HTMLElement> {
    renderApp(bridge, { screen: 'settings' });
    const found = await screen.findByRole('region', { name: SEARCH_SETTINGS_COPY.title });
    await within(found).findByRole('switch', { name: SEARCH_SETTINGS_COPY.switchLabel });
    return found;
  }

  it('an older core gets the update line, and no Search call', SLOW, async () => {
    const bridge = bridgeAt('0.34.0');
    renderApp(bridge, { screen: 'settings' });
    const found = await screen.findByRole('region', { name: SEARCH_SETTINGS_COPY.title });
    expect(within(found).getByText('Needs 0.35.0 or later; this machine has 0.34.0.')).toBeTruthy();
    expect(searchKinds(bridge)).toEqual([]);
  });

  it('is off by default; switching it on is approved in the app, for the change it prepared', SLOW, async () => {
    let on = false;
    const bridge = bridgeAt('0.35.0', {
      searchStatus: () => ok(on ? statusOn : statusNever),
      searchOn: (call) => {
        if ((call as Extract<Call, { kind: 'searchOn' }>).appApproval === undefined) {
          return {
            status: 'approvalPending',
            approvalId: ID,
            preview: 'Keep the words of new messages <b>x</b>',
            expiresAt: null,
          };
        }
        on = true;
        return ok({ changed: true, on: true, accounts: [], model: null, deleted: 0, next: null });
      },
    });
    const found = await section(bridge);
    const toggle = within(found).getByRole('switch', { name: SEARCH_SETTINGS_COPY.switchLabel });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(within(found).getByText(SEARCH_SETTINGS_COPY.local)).toBeTruthy();
    fireEvent.click(toggle);
    const asking = await within(found).findByRole('region', { name: SEARCH_SETTINGS_COPY.askOn.title });
    expect(within(asking).getByText(SEARCH_SETTINGS_COPY.askOn.body)).toBeTruthy();
    // The preview is text: its tag shows as written.
    expect(asking.textContent).toContain('<b>x</b>');
    expect(asked(bridge, 'searchOn')).toEqual([{ kind: 'searchOn' }]);
    fireEvent.click(within(asking).getByRole('button', { name: 'Approve' }));
    expect(await within(found).findByText(SEARCH_SETTINGS_COPY.askOn.approved)).toBeTruthy();
    expect(asked(bridge, 'searchOn')).toEqual([{ kind: 'searchOn' }, { kind: 'searchOn', appApproval: ID }]);
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([]);
  });

  it('where nothing attests the app, switching on is approved in Terminal instead', SLOW, async () => {
    platform.mac = false;
    const bridge = bridgeAt('0.35.0', {
      searchStatus: () => ok(statusNever),
      searchOn: () => ({ status: 'approvalPending', approvalId: ID, preview: 'Keep the words', expiresAt: null }),
    });
    const found = await section(bridge);
    fireEvent.click(within(found).getByRole('switch', { name: SEARCH_SETTINGS_COPY.switchLabel }));
    fireEvent.click(await within(found).findByRole('button', { name: 'Approve in Terminal' }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'openInTerminal').map((call) => call.args)).toEqual([
        { kind: 'change', call: { kind: 'searchOn' }, revoke: ID },
      ]),
    );
    expect(asked(bridge, 'searchOn')).toEqual([{ kind: 'searchOn' }]);
  });

  it('off, an account taken out and words only apply at once; an account added is approved', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      searchOff: () => ok({ changed: true, on: false, accounts: [], model: null, deleted: 0, next: null }),
      searchAccountsRemove: () => ok({ changed: true, on: true, accounts: [], model: null, deleted: 3, next: null }),
      searchModelNone: () => ok({ changed: true, on: true, accounts: [], model: null, deleted: 0, next: null }),
      searchAccountsAdd: () => ({ status: 'approvalPending', approvalId: ID, preview: 'Keep more', expiresAt: null }),
    });
    const found = await section(bridge);
    fireEvent.click(within(found).getByRole('switch', { name: SEARCH_SETTINGS_COPY.accountSwitch('example/gmail') }));
    expect(await within(found).findByText(SEARCH_SETTINGS_COPY.accountRemoved('example/gmail', 3))).toBeTruthy();
    expect(asked(bridge, 'searchAccountsRemove')).toEqual([{ kind: 'searchAccountsRemove', account: 'example/gmail' }]);
    fireEvent.click(within(found).getByRole('button', { name: SEARCH_SETTINGS_COPY.wordsOnly }));
    expect(await within(found).findByText(SEARCH_SETTINGS_COPY.wordsOnlyApplied)).toBeTruthy();
    fireEvent.click(within(found).getByRole('switch', { name: SEARCH_SETTINGS_COPY.switchLabel }));
    expect(await within(found).findByText(SEARCH_SETTINGS_COPY.switchedOff)).toBeTruthy();
    expect(asked(bridge, 'searchOff')).toEqual([{ kind: 'searchOff' }]);
    // None of them was a preview to approve.
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([]);
  });

  it('the model is one of the reviewed list at an address on this Mac, approved in the app', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      searchModelSet: (call) =>
        (call as Extract<Call, { kind: 'searchModelSet' }>).appApproval === undefined
          ? { status: 'approvalPending', approvalId: ID, preview: 'Make kept messages searchable', expiresAt: null }
          : ok({ changed: true, on: true, accounts: [], model: null, deleted: 0, next: 'ollama pull bge-m3:latest' }),
    });
    const found = await section(bridge);
    const model = within(found).getByRole('region', { name: SEARCH_SETTINGS_COPY.model });
    expect(within(model).getByText(SEARCH_SETTINGS_COPY.states.running)).toBeTruthy();
    expect(within(model).getByText(SEARCH_SETTINGS_COPY.localOnlyOff)).toBeTruthy();
    // An address off this Mac is never sent.
    const address = within(model).getByRole('textbox', { name: SEARCH_SETTINGS_COPY.address });
    fireEvent.change(address, { target: { value: 'http://example.com:11434' } });
    fireEvent.click(within(model).getByRole('button', { name: SEARCH_SETTINGS_COPY.use }));
    expect(await within(model).findByText(SEARCH_SETTINGS_COPY.addressRefused)).toBeTruthy();
    expect(asked(bridge, 'searchModelSet')).toEqual([]);
    fireEvent.change(address, { target: { value: 'http://[::1]:11434' } });
    await choose(model, SEARCH_SETTINGS_COPY.choose, /^bge-m3:latest/);
    fireEvent.click(within(model).getByRole('button', { name: SEARCH_SETTINGS_COPY.use }));
    const title = SEARCH_SETTINGS_COPY.askModel('bge-m3:latest', 'http://[::1]:11434').title;
    const asking = await within(model).findByRole('region', { name: title });
    fireEvent.click(within(asking).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(asked(bridge, 'searchModelSet')).toEqual([
        { kind: 'searchModelSet', address: 'http://[::1]:11434', model: 'bge-m3:latest' },
        { kind: 'searchModelSet', address: 'http://[::1]:11434', model: 'bge-m3:latest', appApproval: ID },
      ]),
    );
  });

  it('Rebuild makes vectors again step by step; Delete everything asks first, then deletes at once', SLOW, async () => {
    let left = 3;
    const bridge = bridgeAt('0.35.0', {
      searchRebuild: () => {
        left = 2;
        return ok({ ran: true, busy: false, taken: 0, embedded: 2, pending: left, pruned: 0, model: null });
      },
      searchIndex: () => {
        left = Math.max(0, left - 2);
        return ok({ ran: true, busy: false, taken: 0, embedded: 2, pending: left, pruned: 0, model: null });
      },
      searchDeleteAll: () => ok({ folder: '/example/home/state/search', files: 4, keyDeleted: true }),
    });
    const found = await section(bridge);
    const again = within(found).getByRole('region', { name: SEARCH_SETTINGS_COPY.again });
    fireEvent.click(within(again).getByRole('button', { name: SEARCH_SETTINGS_COPY.rebuild }));
    expect(await within(again).findByText(SEARCH_SETTINGS_COPY.rebuilt)).toBeTruthy();
    expect(asked(bridge, 'searchRebuild')).toEqual([{ kind: 'searchRebuild', budget: 20 }]);
    expect(asked(bridge, 'searchIndex')).toContainEqual({ kind: 'searchIndex', budget: 20 });
    fireEvent.click(within(again).getByRole('button', { name: SEARCH_SETTINGS_COPY.deleteAll }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(SEARCH_SETTINGS_COPY.deleteBody(4))).toBeTruthy();
    expect(asked(bridge, 'searchDeleteAll')).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: SEARCH_SETTINGS_COPY.deleteAction }));
    expect(await within(again).findByText(SEARCH_SETTINGS_COPY.deleted(4, true))).toBeTruthy();
    expect(asked(bridge, 'searchDeleteAll')).toEqual([{ kind: 'searchDeleteAll' }]);
  });

  it('says what is kept, for how long, and what is and is not protected', SLOW, async () => {
    const found = await section(bridgeAt());
    expect(within(found).getByText(SEARCH_SETTINGS_COPY.coverage)).toBeTruthy();
    expect(within(found).getByText(SEARCH_SETTINGS_COPY.howLongLine(30))).toBeTruthy();
    expect(within(found).getByText(SEARCH_SETTINGS_COPY.howLongChange)).toBeTruthy();
    const where = within(found).getByRole('region', { name: SEARCH_SETTINGS_COPY.whereKept });
    expect(within(where).getByText(SEARCH_SETTINGS_COPY.backupStates.excluded)).toBeTruthy();
    expect(within(where).getByText(SEARCH_SETTINGS_COPY.diskStates.on)).toBeTruthy();
    expect(within(where).getByText(/^Treat this folder like your mail/)).toBeTruthy();
    expect(found.querySelector('[data-slot="search-kept"]')?.textContent).toContain('4 messages from 3 people');
  });

  it('a failure core gives is said, and changes nothing', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      searchStatus: () => ok(statusNever),
      searchOn: () => failed('APPROVAL_REQUIRED', 'only a person can let Search on this machine keep more'),
    });
    const found = await section(bridge);
    fireEvent.click(within(found).getByRole('switch', { name: SEARCH_SETTINGS_COPY.switchLabel }));
    expect(await within(found).findByText(/only a person can let Search/)).toBeTruthy();
  });
});
