import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Call, CliResult, Installation } from '../ipc.ts';
import { NavigationProvider, useNavigate } from '../navigation.tsx';
import { AGENTS_HERE_COPY } from '../screens/accounts/AgentsHere.tsx';
import { createFakeBridge, EXAMPLE_INSTALLATION, type FakeBridge, failed, ok } from './fake-bridge.ts';
import behaviour from './fixtures/behaviour.json';
import label from './fixtures/label.populated.json';
import standingList from './fixtures/standing-list.json';
import { renderApp } from './render.tsx';

// Core takes the app's own approval only where the app is attested (macOS). These tests run as macOS unless one says
// otherwise.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

const SLOW = { timeout: 30_000 };
const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';
const OTHER_ID = 'ap_ABCDEFGHJKMNPQRSTVWXYZ0123';

/** What core previews for a loosening, with a tag that must stay text. */
const PREVIEW = 'Let an agent only post, reply, reaction in example/slack\n<b>more</b>';

const pending = (approvalId = ID): CliResult => ({
  status: 'approvalPending',
  approvalId,
  preview: PREVIEW,
  expiresAt: null,
});

type Answers = Partial<Record<Call['kind'], (call: Call) => CliResult>>;

/** Core at `version` (0.34.0 by default, the first that takes the app's approval here), answering `answers` its way. */
function bridgeAt(version = '0.34.0', answers: Answers = {}): FakeBridge {
  const installation: Installation = { ...EXAMPLE_INSTALLATION, version };
  const base = createFakeBridge({ installation: async () => installation });
  return createFakeBridge({
    installation: async () => installation,
    cli: async (call) => answers[call.kind]?.(call) ?? base.cli(call),
  });
}

/** The calls of one kind the screen made, in order. */
function asked<K extends Call['kind']>(bridge: FakeBridge, kind: K): Extract<Call, { kind: K }>[] {
  return bridge.calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind === kind)
    .map((call) => call.args as Extract<Call, { kind: K }>);
}

/** Opens an account's page from its row, on its channel's tab, as a person would. */
async function openAccount(bridge: FakeBridge, tab: string, account: string): Promise<HTMLElement> {
  renderApp(bridge, { screen: 'accounts' });
  fireEvent.click(await screen.findByRole('tab', { name: new RegExp(`^${tab}(,|$)`) }));
  fireEvent.click(await screen.findByRole('button', { name: `Open ${account}` }));
  return screen.findByRole('region', { name: account });
}

/** A section of the page, by its title. */
function section(page: HTMLElement, title: string): HTMLElement {
  return within(page).getByRole('region', { name: title });
}

describe('an account’s page: Agents here', () => {
  it(
    'opens from its row on Agents here, with a switch per act as the rules say, and back to the list',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const page = await openAccount(bridge, 'Slack', 'example/slack');
      expect(within(page).getByRole('button', { name: 'Agents here' }).getAttribute('aria-pressed')).toBe('true');
      const may = section(page, AGENTS_HERE_COPY.may);
      const on = (name: string) => within(may).getByRole('switch', { name }).getAttribute('aria-checked');
      await waitFor(() => expect(on('Reply')).toBe('true'));
      expect(on('React')).toBe('true');
      for (const off of ['Post', 'Edit', 'Delete', 'Share files']) expect(on(off)).toBe('false');
      // No line of its own for any conversation.
      expect(within(may).getByText(AGENTS_HERE_COPY.noConversations('example/slack'))).toBeTruthy();
      // About has what the row had: the mode and the label style.
      fireEvent.click(within(page).getByRole('button', { name: 'About' }));
      expect(within(page).getByText('send')).toBeTruthy();
      // The trail goes back to the list.
      fireEvent.click(within(page).getByRole('button', { name: 'Slack' }));
      expect(await screen.findByRole('list', { name: 'Slack workspaces' })).toBeTruthy();
    },
  );

  it('turning an act off applies at once, and the rules are read again', SLOW, async () => {
    const bridge = bridgeAt('0.34.0', { behaviourAllow: () => ok({ ...behaviour, changed: true, note: null }) });
    const page = await openAccount(bridge, 'Slack', 'example/slack');
    const may = section(page, AGENTS_HERE_COPY.may);
    await waitFor(() => expect(within(may).getByRole('switch', { name: 'React' })).toBeTruthy());
    const before = asked(bridge, 'behaviour').length;
    fireEvent.click(within(may).getByRole('switch', { name: 'React' }));
    expect(
      await within(may).findByText('Applied at once: agents may no longer react with an emoji in example/slack.'),
    ).toBeTruthy();
    expect(asked(bridge, 'behaviourAllow')).toEqual([
      { kind: 'behaviourAllow', account: 'example/slack', acts: 'reply' },
    ]);
    await waitFor(() => expect(asked(bridge, 'behaviour').length).toBeGreaterThan(before));
    expect(asked(bridge, 'behaviourAllowApproved')).toEqual([]);
  });

  it('turning one on shows core’s preview and is approved in the app, for that very change', SLOW, async () => {
    const bridge = bridgeAt('0.34.0', {
      behaviourAllow: () => pending(),
      behaviourAllowApproved: () => ok({ ...behaviour, changed: true, note: null }),
    });
    const page = await openAccount(bridge, 'Slack', 'example/slack');
    const may = section(page, AGENTS_HERE_COPY.may);
    await waitFor(() => expect(within(may).getByRole('switch', { name: 'Post' })).toBeTruthy());
    fireEvent.click(within(may).getByRole('switch', { name: 'Post' }));
    const asking = await within(may).findByRole('region', {
      name: 'Let agents post new messages in example/slack? Approve it',
    });
    // Core's preview, as text: the tag is not markup.
    expect(asking.textContent).toContain('<b>more</b>');
    expect(asked(bridge, 'behaviourAllow')).toEqual([
      { kind: 'behaviourAllow', account: 'example/slack', acts: 'post,reply,reaction' },
    ]);
    fireEvent.click(within(asking).getByRole('button', { name: 'Approve' }));
    expect(
      await within(may).findByText(
        'Approved. Agents may now post new messages in example/slack. Each one still waits for your yes.',
      ),
    ).toBeTruthy();
    expect(asked(bridge, 'behaviourAllowApproved')).toEqual([
      { kind: 'behaviourAllowApproved', account: 'example/slack', acts: 'post,reply,reaction', approvalId: ID },
    ]);
    // Approved here: nothing went to Terminal, and nothing was revoked.
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
    expect(bridge.calls.map((call) => call.command)).not.toContain('revokePreview');
  });

  it('an approval core voided is prepared again, and the new one is approved', SLOW, async () => {
    let prepared = 0;
    let approved = 0;
    const bridge = bridgeAt('0.34.0', {
      behaviourAllow: () => {
        prepared += 1;
        return pending(prepared === 1 ? ID : OTHER_ID);
      },
      behaviourAllowApproved: () => {
        approved += 1;
        return approved === 1
          ? failed('APPROVAL_VOID', 'that approval was prepared for another change', null, 10)
          : ok({ ...behaviour, changed: true, note: null });
      },
    });
    const page = await openAccount(bridge, 'Slack', 'example/slack');
    const may = section(page, AGENTS_HERE_COPY.may);
    await waitFor(() => expect(within(may).getByRole('switch', { name: 'Post' })).toBeTruthy());
    fireEvent.click(within(may).getByRole('switch', { name: 'Post' }));
    const title = 'Let agents post new messages in example/slack? Approve it';
    fireEvent.click(
      within(await within(may).findByRole('region', { name: title })).getByRole('button', { name: 'Approve' }),
    );
    await waitFor(() => expect(asked(bridge, 'behaviourAllow')).toHaveLength(2));
    fireEvent.click(
      within(await within(may).findByRole('region', { name: title })).getByRole('button', { name: 'Approve' }),
    );
    expect(await within(may).findByText(/^Approved\. Agents may now post new messages/)).toBeTruthy();
    expect(asked(bridge, 'behaviourAllowApproved').map((call) => call.approvalId)).toEqual([ID, OTHER_ID]);
    // A voided approval is not the Terminal's.
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
  });

  for (const [where, version, mac] of [
    ['an older core', '0.24.0', true],
    ['Windows or Linux', '0.34.0', false],
  ] as const) {
    it(`on ${where}, a loosening is approved in Terminal, as before`, SLOW, async () => {
      platform.mac = mac;
      const bridge = bridgeAt(version, { behaviourAllow: () => pending() });
      const page = await openAccount(bridge, 'Slack', 'example/slack');
      const may = section(page, AGENTS_HERE_COPY.may);
      await waitFor(() => expect(within(may).getByRole('switch', { name: 'Post' })).toBeTruthy());
      fireEvent.click(within(may).getByRole('switch', { name: 'Post' }));
      fireEvent.click(await within(may).findByRole('button', { name: 'Approve in Terminal' }));
      await waitFor(() =>
        expect(bridge.calls).toContainEqual({
          command: 'openInTerminal',
          args: {
            kind: 'change',
            call: { kind: 'behaviourAllow', account: 'example/slack', acts: 'post,reply,reaction' },
            revoke: ID,
          },
        }),
      );
      expect(asked(bridge, 'behaviourAllowApproved')).toEqual([]);
    });
  }

  it('how messages look: “as you, tagged” is approved in the app; the app’s own applies at once', SLOW, async () => {
    const labelled = structuredClone(label);
    const slack = labelled.accounts.find((each) => each.account === 'example/slack');
    if (slack !== undefined) slack.style = 'labelled';
    let style = 'app';
    const bridge = bridgeAt('0.34.0', {
      label: () => ok(style === 'app' ? label : labelled),
      labelStyle: (call) =>
        (call as Extract<Call, { kind: 'labelStyle' }>).style === 'labelled'
          ? pending()
          : ok({ ...label, change: 'style', changed: true, note: null }),
      labelStyleApproved: () => {
        style = 'labelled';
        return ok({ ...labelled, change: 'style', changed: true, note: null });
      },
    });
    const page = await openAccount(bridge, 'Slack', 'example/slack');
    const look = section(page, AGENTS_HERE_COPY.look);
    const tagged = await within(look).findByRole('radio', { name: /^As you, tagged/ });
    expect(
      within(look)
        .getByRole('radio', { name: /^As the Agent Comms app/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    // Each drawn with the phrase recipients see.
    expect(within(look).getAllByText('Jo Example (agent)').length).toBeGreaterThan(0);
    fireEvent.click(tagged);
    const asking = await within(look).findByRole('region', {
      name: 'Post as you, tagged, in example/slack? Approve it',
    });
    // Not chosen until it is approved.
    expect(tagged.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(asking).getByRole('button', { name: 'Approve' }));
    expect(await within(look).findByText(/^Approved\. Agents’ messages in example\/slack now go as you/)).toBeTruthy();
    expect(asked(bridge, 'labelStyle')).toEqual([{ kind: 'labelStyle', account: 'example/slack', style: 'labelled' }]);
    expect(asked(bridge, 'labelStyleApproved')).toEqual([
      { kind: 'labelStyleApproved', account: 'example/slack', style: 'labelled', approvalId: ID },
    ]);
    await waitFor(() => expect(tagged.getAttribute('aria-checked')).toBe('true'));
    // Back to the app's own: at once, and never approved.
    fireEvent.click(within(look).getByRole('radio', { name: /^As the Agent Comms app/ }));
    expect(await within(look).findByText(/^Applied at once: agents’ messages in example\/slack now come/)).toBeTruthy();
    expect(asked(bridge, 'labelStyle').at(-1)).toEqual({ kind: 'labelStyle', account: 'example/slack', style: 'app' });
    expect(asked(bridge, 'labelStyleApproved')).toHaveLength(1);
  });

  it('replies approved in advance: this workspace’s live ones, each ended at once, or all of them', SLOW, async () => {
    const bridge = bridgeAt('0.34.0', {
      standingRevoke: () => ok(standingList),
      standingOff: () => ok({ ...standingList, partial: ['One record could not be written down.'] }),
    });
    const page = await openAccount(bridge, 'Slack', 'example/slack');
    const advance = section(page, AGENTS_HERE_COPY.advance);
    const list = await within(advance).findByRole('list', { name: AGENTS_HERE_COPY.advance });
    // The active one, in #general; the ended one is not listed.
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('In #general')).toBeTruthy();
    expect(within(list).getByText('a :white_check_mark: reaction')).toBeTruthy();
    expect(within(list).getByText("“Thanks, I'll take a look.”")).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: /^End the replies approved in advance/ }));
    expect(await within(advance).findByText(/^Ended at once\. In #general, agents ask you/)).toBeTruthy();
    expect(asked(bridge, 'standingRevoke')).toEqual([{ kind: 'standingRevoke', id: 'ap_5S6T7V8W9X0Y1Z2A3B4C5D6E7F' }]);
    fireEvent.click(within(advance).getByRole('button', { name: AGENTS_HERE_COPY.endAll }));
    expect(
      await within(advance).findByText(/^Ended at once: no replies are approved in advance in example\/slack now\./),
    ).toBeTruthy();
    expect(within(advance).getByText(/One record could not be written down\./)).toBeTruthy();
    expect(asked(bridge, 'standingOff')).toHaveLength(1);
    // Making one stays at the terminal: nothing here prepares one.
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
  });

  it('Gmail’s people and domains: each line, Remove… as core decides, and Add… checked first', SLOW, async () => {
    const bridge = bridgeAt('0.34.0', {
      behaviourClear: () => pending(),
      behaviourAllow: () => ok({ ...behaviour, changed: true, note: null }),
    });
    const page = await openAccount(bridge, 'Gmail', 'example/gmail');
    const may = section(page, AGENTS_HERE_COPY.may);
    expect(await within(may).findByText('Never: no new mail, and no replies, to anyone there')).toBeTruthy();
    expect(within(may).getByRole('switch', { name: 'Send' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(may).getByRole('button', { name: 'Remove the line for @example.com' }));
    expect(
      await within(may).findByRole('region', { name: 'Remove the line for @example.com? Approve it' }),
    ).toBeTruthy();
    expect(asked(bridge, 'behaviourClear')).toEqual([
      { kind: 'behaviourClear', account: 'example/gmail', conversation: '@example.com' },
    ]);
    fireEvent.click(within(may).getByRole('button', { name: AGENTS_HERE_COPY.addPerson }));
    const form = within(may).getByRole('form', { name: 'Add a person or domain' });
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'not an address' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(AGENTS_HERE_COPY.whoProblem)).toBeTruthy();
    expect(asked(bridge, 'behaviourAllow')).toEqual([]);
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'jo@client.test' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Reply' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(may).findByText(
        'Added at once, because it allows no more than the rest of example/gmail: for jo@client.test, agents may reply.',
      ),
    ).toBeTruthy();
    expect(asked(bridge, 'behaviourAllow')).toEqual([
      { kind: 'behaviourAllow', account: 'example/gmail', acts: 'reply', conversation: 'jo@client.test' },
    ]);
  });

  it('WhatsApp’s page has no Agents here: it only drafts', SLOW, async () => {
    const bridge = bridgeAt();
    const page = await openAccount(bridge, 'WhatsApp', 'example/whatsapp');
    expect(within(page).queryByRole('button', { name: 'Agents here' })).toBeNull();
    expect(within(page).queryByRole('region', { name: AGENTS_HERE_COPY.may })).toBeNull();
    expect(within(page).getByText('readable')).toBeTruthy();
  });

  it('another screen opens an account’s page by its name', SLOW, async () => {
    const bridge = bridgeAt();
    function Asker() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate?.({ screen: 'accounts', account: 'example/slack' })}>
          Open in Accounts
        </button>
      );
    }
    renderApp(bridge, { screen: 'overview' });
    const navigation = await screen.findByRole('navigation', { name: 'Sections' });
    const asker = render(
      <NavigationProvider onScreen={() => undefined}>
        <Asker />
      </NavigationProvider>,
    );
    fireEvent.click(asker.getByRole('button', { name: 'Open in Accounts' }));
    asker.unmount();
    fireEvent.click(within(navigation).getByRole('button', { name: /^Accounts/ }));
    const page = await screen.findByRole('region', { name: 'example/slack' });
    expect(within(page).getByRole('button', { name: 'Agents here' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Slack(,|$)/ }).getAttribute('aria-selected')).toBe('true');
  });
});
