import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InboxView } from '../cli-types.ts';
import type { Call, TerminalOutcome } from '../ipc.ts';
import { PROFILE_HINT } from '../screens/Accounts.tsx';
import { cliKinds, createFakeBridge, EXAMPLE_FOLDERS, EXAMPLE_INSTALLATION, failed } from './fake-bridge.ts';
import accountsGmail from './fixtures/accounts-gmail.populated.json';
import doctorWhatsapp from './fixtures/doctor-whatsapp.json';
import { renderApp } from './render.tsx';

/** Each channel's tab, by the name it shows first. */
const TAB = { gmail: 'Gmail', slack: 'Slack', resend: 'Resend', whatsapp: 'WhatsApp' } as const;

/** The list a channel's accounts are in, by its name: its tab is chosen first, as a person would. */
const LISTS = {
  'Gmail mailboxes': TAB.gmail,
  'Slack workspaces': TAB.slack,
  'Resend accounts': TAB.resend,
  'WhatsApp accounts': TAB.whatsapp,
} as const;

/** A channel's tab, by its name, whatever count it carries. */
function tab(name: string): Promise<HTMLElement> {
  return screen.findByRole('tab', { name: new RegExp(`^${name}(,|$)`) });
}

/** Chooses a channel's tab. */
async function choose(name: string): Promise<void> {
  fireEvent.click(await tab(name));
  await waitFor(async () => expect((await tab(name)).getAttribute('aria-selected')).toBe('true'));
}

/** The list a channel's accounts are in, by its name, once its tab is chosen and its rows are there. */
async function table(name: keyof typeof LISTS): Promise<HTMLElement> {
  await choose(LISTS[name]);
  return screen.findByRole('list', { name });
}

/** The row of `account` in `list`. */
function row(container: HTMLElement, account: string): HTMLElement {
  const found = within(container)
    .getAllByRole('listitem')
    .find((each) => within(each).queryByText(account, { exact: true }) !== null);
  if (found === undefined) throw new Error(`no row for ${account}`);
  return found;
}

/** The count a tab shows, or null when it shows none. */
function countOn(element: HTMLElement): string | null {
  return element.querySelector('[data-slot="needs-a-look"]')?.textContent ?? null;
}

/** A Gmail mailbox like the fixture's, under another name, and in the health given. */
function mailbox(alias: string, health: InboxView['health']): InboxView {
  return { ...(accountsGmail[0] as InboxView), alias, email: `${alias.replace('/', '.')}@example.com`, health };
}

/** WhatsApp's status, with one account in each access state given. */
function whatsappIn(...states: string[]): unknown {
  return {
    ...doctorWhatsapp,
    accounts: states.map((state, index) => ({
      ...doctorWhatsapp.accounts[0],
      account: `example/whatsapp-${index}`,
      access: { state },
    })),
  };
}

/** The `accounts` products asked for, in order. */
function accountsAsked(calls: { command: string; args: unknown }[]): string[] {
  return calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind === 'accounts')
    .map((call) => (call.args as Extract<Call, { kind: 'accounts' }>).product);
}

describe('Accounts', () => {
  it("Accounts lists each channel's accounts with policies, label style and what agents may do", async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'accounts' });

    const gmail = row(await table('Gmail mailboxes'), 'example/gmail');
    expect(within(gmail).getByText('jo@example.com')).toBeTruthy();
    // Send policy set on the mailbox; change policy inherited from the defaults.
    expect(within(gmail).getByText('confirm')).toBeTruthy();
    expect(within(gmail).getByText('chat (default)')).toBeTruthy();
    // The label: a rule sends it as the person.
    expect(within(gmail).getByText('as you, with no label')).toBeTruthy();
    // What agents may do: everything across the account, nothing to anyone at example.com.
    expect(within(gmail).getByText('all')).toBeTruthy();
    expect(within(gmail).getByText('@example.com: nothing')).toBeTruthy();

    const slack = row(await table('Slack workspaces'), 'example/slack');
    expect(within(slack).getByText('Example')).toBeTruthy();
    expect(within(slack).getByText('send')).toBeTruthy();
    expect(within(slack).getByText('app')).toBeTruthy();
    expect(within(slack).getByText('reply, reaction')).toBeTruthy();

    const resend = row(await table('Resend accounts'), 'example/resend');
    expect(within(resend).getByText('read')).toBeTruthy();
    expect(within(resend).getByText('never (default)')).toBeTruthy();
    expect(within(resend).getByText('confirm')).toBeTruthy();

    const whatsapp = row(await table('WhatsApp accounts'), 'example/whatsapp');
    expect(within(whatsapp).getByText('readable')).toBeTruthy();

    // Each list from its own launcher, WhatsApp from its status, and the label and the rules once each.
    expect(accountsAsked(bridge.calls).sort()).toEqual(['gmail', 'resend', 'slack']);
    expect(bridge.calls).toContainEqual({ command: 'cli', args: { kind: 'doctor', product: 'whatsapp' } });
    const kinds = cliKinds(bridge);
    expect(kinds.filter((kind) => kind === 'label')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'behaviour')).toHaveLength(1);
    // Showing asks for nothing to change.
    expect(kinds).not.toContain('profileInit');
    expect(bridge.calls.map((call) => call.command)).not.toContain('openProfile');
  });

  it('a channel whose launcher is missing has no section, and nothing is asked of it', async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'slack'] }),
    });
    renderApp(bridge, { screen: 'accounts' });
    await table('Slack workspaces');
    // Slack's is the only tab, and the only list.
    expect(screen.getAllByRole('tab').map((each) => each.textContent)).toEqual(['Slack']);
    expect(screen.queryByRole('list', { name: 'Gmail mailboxes' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Resend accounts' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'WhatsApp accounts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a mailbox' })).toBeNull();
    expect(accountsAsked(bridge.calls)).toEqual(['slack']);
    expect(bridge.calls).not.toContainEqual({ command: 'cli', args: { kind: 'doctor', product: 'whatsapp' } });
  });

  it('a channel with no accounts says so, and one that failed says what went wrong', async () => {
    const bridge = createFakeBridge(
      {},
      {
        accounts: (call: Call) =>
          (call as Extract<Call, { kind: 'accounts' }>).product === 'resend' ? { accounts: [] } : [],
        // WhatsApp's status in a shape this app does not know: said, not a broken screen.
        doctor: (call: Call) =>
          (call as Extract<Call, { kind: 'doctor' }>).product === 'whatsapp'
            ? { accounts: 'not a list' }
            : { ok: true, checks: [] },
      },
    );
    const failing = createFakeBridge({
      cli: async (call) =>
        call.kind === 'accounts' && call.product === 'slack'
          ? failed('CONFIG', 'the configuration cannot be read')
          : bridge.cli(call),
    });
    renderApp(failing, { screen: 'accounts' });
    expect(await screen.findByText('No mailboxes yet.')).toBeTruthy();
    await choose(TAB.resend);
    expect(await screen.findByText('No Resend accounts yet.')).toBeTruthy();
    await choose(TAB.slack);
    expect(await screen.findByText('the configuration cannot be read')).toBeTruthy();
    await choose(TAB.whatsapp);
    expect(await screen.findByText('WhatsApp answered in a shape this app cannot read.')).toBeTruthy();
    // A list that could not be read needs a look too: its tab says so before it is chosen.
    expect(screen.getByRole('tab', { name: 'Slack, 1 needs a look' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'WhatsApp, 1 needs a look' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Gmail' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Resend' })).toBeTruthy();
  });

  it('Open writing profile calls openProfile with the account', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'accounts' });
    const gmail = row(await table('Gmail mailboxes'), 'example/gmail');
    fireEvent.click(within(gmail).getByRole('button', { name: 'Open writing profile' }));
    // The path is a literal value, set in mono after the word.
    const said = await within(gmail).findByRole('status');
    expect(said.textContent).toBe(`Created ${EXAMPLE_FOLDERS.configDir}/compose/example/gmail.md`);
    expect(said.querySelector('.font-mono')?.textContent).toBe(`${EXAMPLE_FOLDERS.configDir}/compose/example/gmail.md`);
    expect(bridge.calls.filter((call) => call.command === 'openProfile')).toEqual([
      { command: 'openProfile', args: { account: 'example/gmail' } },
    ]);
  });

  it('a profile already there is opened, and says so', async () => {
    const bridge = createFakeBridge({
      openProfile: async () => ({ path: `${EXAMPLE_FOLDERS.configDir}/compose/user.md`, created: false }),
    });
    renderApp(bridge, { screen: 'accounts' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open your own writing profile' }));
    const own = screen.getByRole('region', { name: 'Writing profiles and what agents may do' });
    const said = await within(own).findByRole('status');
    expect(said.textContent).toBe(`Opened ${EXAMPLE_FOLDERS.configDir}/compose/user.md`);
    // Your own profile, which every account reads: no account named.
    expect(bridge.calls.filter((call) => call.command === 'openProfile')).toEqual([
      { command: 'openProfile', args: {} },
    ]);
  });

  it('an invalid account name never reaches the bridge', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'accounts' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a mailbox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a mailbox' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    const run = within(dialog).getByRole('button', { name: 'Run in Terminal' });

    for (const typed of ['', 'Example Gmail', '-x', 'con/gmail', 'example/gmail‮', 'example/gmail; rm -rf ~']) {
      fireEvent.change(name, { target: { value: typed } });
      fireEvent.click(run);
      expect(within(dialog).getByText('Names look like organisation/platform, such as example/gmail.')).toBeTruthy();
    }
    // A name the grammar takes, but for another channel: a mailbox's ends in /gmail.
    fireEvent.change(name, { target: { value: 'example/slack' } });
    fireEvent.click(run);
    expect(within(dialog).getByText("A mailbox's name ends in /gmail, such as example/gmail.")).toBeTruthy();

    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
  });

  it('Add a mailbox opens the terminal with a gmail sign-in', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'accounts' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a mailbox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a mailbox' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'example/gmail-work' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run in Terminal' }));
    expect(await within(dialog).findByText('Opened in Terminal.')).toBeTruthy();
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([
      {
        command: 'openInTerminal',
        args: { kind: 'signIn', product: 'gmail', account: 'example/gmail-work', again: false },
      },
    ]);
  });

  it('Add a workspace and Add a Resend account sign in through their own channels', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'accounts' });
    for (const [button, product, account] of [
      ['Add a workspace', 'slack', 'example/slack-ops'],
      ['Add a Resend account', 'resend', 'example/resend'],
    ] as const) {
      // Each channel's Add sits beside the tabs while its tab is chosen.
      await choose(product === 'slack' ? TAB.slack : TAB.resend);
      fireEvent.click(await screen.findByRole('button', { name: button }));
      const dialog = await screen.findByRole('dialog', { name: button });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: account } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Run in Terminal' }));
      expect(await within(dialog).findByText('Opened in Terminal.')).toBeTruthy();
      expect(bridge.calls.at(-1)).toEqual({
        command: 'openInTerminal',
        args: { kind: 'signIn', product, account, again: false },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it('Sign in again sends again: true, for Gmail and Slack only', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'accounts' });
    const slack = row(await table('Slack workspaces'), 'example/slack');
    fireEvent.click(within(slack).getByRole('button', { name: 'Sign in again' }));
    expect(await within(slack).findByText('Opened in Terminal.')).toBeTruthy();
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([
      { command: 'openInTerminal', args: { kind: 'signIn', product: 'slack', account: 'example/slack', again: true } },
    ]);
    const gmail = row(await table('Gmail mailboxes'), 'example/gmail');
    expect(within(gmail).getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    // Resend's key is added again, not signed in again; WhatsApp has nothing to sign in to.
    const resend = row(await table('Resend accounts'), 'example/resend');
    expect(within(resend).queryByRole('button', { name: 'Sign in again' })).toBeNull();
    const whatsapp = row(await table('WhatsApp accounts'), 'example/whatsapp');
    expect(within(whatsapp).queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  it("a row's sign-in and profile keep what they came to, and a sign-in stays busy, across a change of tab", async () => {
    let open = (_outcome: TerminalOutcome) => {};
    const bridge = createFakeBridge({
      openInTerminal: () =>
        new Promise<TerminalOutcome>((resolve) => {
          open = resolve;
        }),
    });
    renderApp(bridge, { screen: 'accounts' });
    const gmail = () => table('Gmail mailboxes').then((list) => row(list, 'example/gmail'));
    const signIn = async () => within(await gmail()).getByRole('button', { name: 'Sign in again' });

    // A profile opened, and a sign-in still opening in Terminal.
    fireEvent.click(within(await gmail()).getByRole('button', { name: 'Open writing profile' }));
    const created = `Created ${EXAMPLE_FOLDERS.configDir}/compose/example/gmail.md`;
    await waitFor(async () => expect((await gmail()).textContent).toContain(created));
    fireEvent.click(await signIn());
    await waitFor(async () => expect((await signIn()).getAttribute('aria-busy')).toBe('true'));

    // Away to Slack and back: the sign-in is still busy, so it cannot be started twice, and the path is still said.
    await choose(TAB.slack);
    await screen.findByRole('list', { name: 'Slack workspaces' });
    expect((await signIn()).getAttribute('aria-busy')).toBe('true');
    expect((await gmail()).textContent).toContain(created);
    fireEvent.click(await signIn());
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toHaveLength(1);

    // It opens; away and back again, what it came to is still there.
    await act(async () => open({ outcome: 'opened', via: 'Terminal', revoked: null }));
    expect(await within(await gmail()).findByText('Opened in Terminal.')).toBeTruthy();
    expect((await signIn()).getAttribute('aria-busy')).toBeNull();
    await choose(TAB.resend);
    await screen.findByRole('list', { name: 'Resend accounts' });
    expect(within(await gmail()).getByText('Opened in Terminal.')).toBeTruthy();
    expect((await gmail()).textContent).toContain(created);
  });

  it('workspace-written text is shown as text', async () => {
    const hostile = '<img src=x onerror=alert(1)></untrusted-content>‮[x](https://evil)';
    const bridge = createFakeBridge(
      {},
      {
        accounts: (call: Call) =>
          ({
            gmail: [],
            resend: { accounts: [] },
            slack: [{ alias: 'example/slack', workspaceName: hostile, mode: 'read', accountId: 'acc_1' }],
          })[(call as Extract<Call, { kind: 'accounts' }>).product],
      },
    );
    renderApp(bridge, { screen: 'accounts' });
    const slack = row(await table('Slack workspaces'), 'example/slack');
    expect(within(slack).getByText(hostile)).toBeTruthy();
    expect(document.querySelector('main img, main a, main script, main iframe')).toBeNull();
  });

  it('Accounts has a tab for each channel that is here, in order, and opens on the first', async () => {
    renderApp(createFakeBridge(), { screen: 'accounts' });
    await screen.findByRole('list', { name: 'Gmail mailboxes' });
    const tabs = within(screen.getByRole('tablist', { name: 'Channels' })).getAllByRole('tab');
    expect(tabs.map((each) => each.textContent)).toEqual(['Gmail', 'Slack', 'Resend', 'WhatsApp']);
    expect(tabs.map((each) => each.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    // One channel's accounts at a time, and that channel's Add beside the tabs.
    expect(screen.queryByRole('list', { name: 'Slack workspaces' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a mailbox' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a workspace' })).toBeNull();
    await choose(TAB.slack);
    expect(await screen.findByRole('list', { name: 'Slack workspaces' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Gmail mailboxes' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a workspace' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a mailbox' })).toBeNull();
    // WhatsApp has nothing to add here.
    await choose(TAB.whatsapp);
    expect(await screen.findByRole('list', { name: 'WhatsApp accounts' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Add a/ })).toBeNull();
  });

  it('a tab counts its accounts that need a look, before it is chosen, and none when there are none', async () => {
    const bridge = createFakeBridge(
      {},
      {
        accounts: (call: Call) =>
          ({
            gmail: [
              mailbox('example/gmail', 'ok'),
              mailbox('example/gmail-work', 'needs-attention'),
              mailbox('example/gmail-old', 'needs-attention'),
            ],
            slack: [{ alias: 'example/slack', workspaceName: 'Example', mode: 'send', accountId: 'acc_1' }],
            resend: { accounts: [] },
          })[(call as Extract<Call, { kind: 'accounts' }>).product],
        doctor: (call: Call) =>
          (call as Extract<Call, { kind: 'doctor' }>).product === 'whatsapp'
            ? whatsappIn('readable', 'not-checked', 'waiting', 'denied', 'missing', 'unreadable', 'something new')
            : { ok: true, checks: [] },
      },
    );
    renderApp(bridge, { screen: 'accounts' });
    // Gmail: two mailboxes need attention. WhatsApp: every state Doctor warns or fails on, and one it does not know.
    const gmail = await screen.findByRole('tab', { name: 'Gmail, 2 need a look' });
    expect(countOn(gmail)).toBe('2');
    const whatsapp = await screen.findByRole('tab', { name: 'WhatsApp, 5 need a look' });
    expect(countOn(whatsapp)).toBe('5');
    expect(whatsapp.getAttribute('aria-selected')).toBe('false');
    // Nothing to look at, nothing to count: no number, and the tab's name is the channel's.
    expect(countOn(screen.getByRole('tab', { name: 'Slack' }))).toBeNull();
    expect(countOn(screen.getByRole('tab', { name: 'Resend' }))).toBeNull();

    // The rows behind the counts: each mailbox that needs attention says so.
    const mailboxes = await screen.findByRole('list', { name: 'Gmail mailboxes' });
    expect(within(row(mailboxes, 'example/gmail-work')).getByText('needs attention')).toBeTruthy();
    expect(within(row(mailboxes, 'example/gmail-old')).getByText('needs attention')).toBeTruthy();
    expect(within(row(mailboxes, 'example/gmail')).queryByText('needs attention')).toBeNull();
    // Each WhatsApp state is shown as it came; one that needs a look is in the warning's ink.
    const accounts = await table('WhatsApp accounts');
    expect(within(row(accounts, 'example/whatsapp-0')).getByText('readable').className).not.toContain('text-warn');
    expect(within(row(accounts, 'example/whatsapp-1')).getByText('not-checked').className).not.toContain('text-warn');
    expect(within(row(accounts, 'example/whatsapp-3')).getByText('denied').className).toContain('text-warn');
  });

  it('a count follows the accounts when they are read again', async () => {
    let health: InboxView['health'] = 'needs-attention';
    const bridge = createFakeBridge(
      {},
      {
        accounts: (call: Call) =>
          ({
            gmail: [mailbox('example/gmail', health)],
            slack: [],
            resend: { accounts: [] },
          })[(call as Extract<Call, { kind: 'accounts' }>).product],
      },
    );
    renderApp(bridge, { screen: 'accounts' });
    expect(await screen.findByRole('tab', { name: 'Gmail, 1 needs a look' })).toBeTruthy();
    // Signed in again in Terminal; back in the app, the list is read again and the count goes.
    health = 'ok';
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(await screen.findByRole('tab', { name: 'Gmail' })).toBeTruthy();
  });

  it('what a writing profile is stays one hover or focus away, beside its button', async () => {
    renderApp(createFakeBridge(), { screen: 'accounts' });
    const own = await screen.findByRole('region', { name: 'Writing profiles and what agents may do' });
    // The line no longer stands on the page; its words are the hint's.
    expect(within(own).queryByText(PROFILE_HINT)).toBeNull();
    const hint = within(own).getByRole('button', { name: 'About writing profiles' });
    fireEvent.mouseEnter(hint);
    fireEvent.pointerEnter(hint);
    fireEvent.focus(hint);
    expect((await screen.findByRole('tooltip')).textContent).toBe(PROFILE_HINT);
  });
});
