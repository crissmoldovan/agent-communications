import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Call } from '../ipc.ts';
import { cliKinds, createFakeBridge, EXAMPLE_FOLDERS, EXAMPLE_INSTALLATION, failed } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

/** The table a channel's accounts are listed in, by its caption, once its rows are there. */
async function table(name: string): Promise<HTMLElement> {
  return screen.findByRole('table', { name });
}

/** The row of `account` in `table`. */
function row(container: HTMLElement, account: string): HTMLElement {
  const found = within(container)
    .getAllByRole('row')
    .find((each) => within(each).queryByText(account, { exact: true }) !== null);
  if (found === undefined) throw new Error(`no row for ${account}`);
  return found;
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
    expect(screen.queryByRole('table', { name: 'Gmail mailboxes' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Resend accounts' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'WhatsApp accounts' })).toBeNull();
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
    expect(await screen.findByText('No Resend accounts yet.')).toBeTruthy();
    expect(await screen.findByText('the configuration cannot be read')).toBeTruthy();
    expect(await screen.findByText('WhatsApp answered in a shape this app cannot read.')).toBeTruthy();
  });

  it('Open writing profile calls openProfile with the account', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'accounts' });
    const gmail = row(await table('Gmail mailboxes'), 'example/gmail');
    fireEvent.click(within(gmail).getByRole('button', { name: 'Open writing profile' }));
    expect(
      await within(gmail).findByText(`Created ${EXAMPLE_FOLDERS.configDir}/compose/example/gmail.md`),
    ).toBeTruthy();
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
    expect(await screen.findByText(`Opened ${EXAMPLE_FOLDERS.configDir}/compose/user.md`)).toBeTruthy();
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
});
