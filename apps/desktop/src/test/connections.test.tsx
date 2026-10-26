import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call, CliResult, Installation, McpServer, TerminalCommand } from '../ipc.ts';
import { CONNECTIONS_COPY } from '../screens/Connections.tsx';
import { createFakeBridge, EXAMPLE_INSTALLATION, type FakeBridge, failed, ok } from './fake-bridge.ts';
import sessions from './fixtures/activity-sessions-clients.json';
import channels from './fixtures/channels.json';
import { renderApp } from './render.tsx';

// macOS unless a test says otherwise: there core can attest that the app started its `mcp install`.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
beforeEach(() => {
  platform.mac = true;
});

/** A screen that reads under a loaded machine: each test is given room. */
const SLOW = { timeout: 30_000 };

const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';
const OTHER_ID = 'ap_ABCDEFGHJKMNPQRSTVWXYZ0123';

/** What core previews for an install, with a tag a sender could not have put there but that must stay text. */
const PREVIEW = 'Register the Resend server with Claude Code.\nAgents there could send mail <b>through Resend</b>.';

const main = (): HTMLElement => screen.getByRole('main');

/** The channels report, loosely: enough to take a registration out of it. */
type Report = { channels: { channel: string; registered: { client: string }[] }[] };

/**
 * Core at `version` (0.32.0 by default, the first with `mcp uninstall`), answering `channels` from a report that keeps
 * what is taken away, `mcp install` with a change waiting for approval, and the agent windows of the last 30 days.
 */
function bridgeAt(
  version = '0.32.0',
  options: {
    install?: (call: Call) => CliResult;
    uninstall?: (call: Call) => CliResult;
    approved?: (call: Call) => CliResult;
  } = {},
): FakeBridge & { report: Report } {
  const report = structuredClone(channels) as unknown as Report;
  const installation: Installation = { ...EXAMPLE_INSTALLATION, version };
  let approvals = 0;
  const bridge = createFakeBridge(
    {
      installation: async () => installation,
      cli: async (call) => {
        if (call.kind === 'version') return { status: 'version', version };
        if (call.kind === 'channels') return ok(structuredClone(report));
        if (call.kind === 'activitySessions') return ok(sessions);
        if (call.kind === 'mcpInstall') {
          if (options.install) return options.install(call);
          approvals += 1;
          return {
            status: 'approvalPending',
            approvalId: approvals === 1 ? ID : OTHER_ID,
            preview: PREVIEW,
            expiresAt: null,
          };
        }
        if (call.kind === 'mcpInstallApproved') {
          // Core approves the install through the app channel, and registers it.
          if (options.approved) return options.approved(call);
          const entry = report.channels.find((channel) => channel.channel === call.server);
          entry?.registered.push({ client: call.client, scope: 'user', path: '/example/home/.claude.json' } as never);
          return ok({ applied: true, restart: `Restart ${call.client} to use it.` });
        }
        if (call.kind === 'mcpUninstall') {
          if (options.uninstall) return options.uninstall(call);
          const entry = report.channels.find((channel) => channel.channel === call.server);
          if (entry) entry.registered = entry.registered.filter((registration) => registration.client !== call.client);
          return ok({ client: call.client, server: call.server, removed: [{ name: call.server }] });
        }
        if (call.kind === 'approvalsPending') return ok([]);
        if (call.kind === 'updateStatus' || call.kind === 'eventsStatus' || call.kind === 'doctor') return ok({});
        return failed('APP_NOT_BUILT', `no fixture answers ${call.kind}`);
      },
    },
    {},
  );
  return Object.assign(bridge, { report });
}

const cliCalls = (bridge: FakeBridge): Call[] =>
  bridge.calls.filter((call) => call.command === 'cli').map((call) => call.args as Call);
const changes = (bridge: FakeBridge): Call[] =>
  cliCalls(bridge).filter((call) => call.kind === 'mcpInstall' || call.kind === 'mcpUninstall');
/** Every approval the app answered in the app, by the install it answered. */
const approvedInApp = (bridge: FakeBridge): Call[] =>
  cliCalls(bridge).filter((call) => call.kind === 'mcpInstallApproved');
const terminals = (bridge: FakeBridge): TerminalCommand[] =>
  bridge.calls.filter((call) => call.command === 'openInTerminal').map((call) => call.args as TerminalCommand);

async function openConnections(bridge: FakeBridge) {
  renderApp(bridge);
  const navigation = await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.click(within(navigation).getByRole('button', { name: /^Connections/ }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Connections' })).toBeTruthy();
  return within(main());
}

/** The table's row for `app`, and its cells by column: the app, then the six servers, then its button. */
async function rowOf(app: string) {
  const table = await within(main()).findByRole('table', { name: CONNECTIONS_COPY.tableCaption });
  const row = within(table)
    .getAllByRole('row')
    .find(
      (each) => within(each).queryAllByRole('cell')[0]?.querySelector('[data-slot="app-name"]')?.textContent === app,
    );
  if (row === undefined) throw new Error(`no row for ${app}`);
  return { row, cells: within(row).getAllByRole('cell') };
}

const SERVER_COLUMN: Record<McpServer, number> = { core: 1, gmail: 2, slack: 3, resend: 4, whatsapp: 5, events: 6 };

describe('Connections (spec §3.3)', () => {
  it(
    'sits after Accounts with a New tag, and opens with what it shows and when an app sees a change',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      renderApp(bridge);
      const navigation = await screen.findByRole('navigation', { name: 'Sections' });
      const names = within(navigation)
        .getAllByRole('button')
        .map((button) => button.textContent?.trim());
      expect(names.indexOf('Connections New')).toBe(names.indexOf('Accounts') + 1);
      const item = within(navigation).getByRole('button', { name: /^Connections/ });
      expect(item.querySelector('[data-slot="new-tag"]')?.textContent).toBe(' New');
      fireEvent.click(item);
      expect(await screen.findByRole('heading', { level: 1, name: 'Connections' })).toBeTruthy();
      expect(item.getAttribute('aria-current')).toBe('page');
      expect(within(main()).getByText(CONNECTIONS_COPY.intro)).toBeTruthy();
      expect(CONNECTIONS_COPY.intro).toContain('An app sees a change after you restart it.');
      // It reads core's channels and the agent windows of the last 30 days, and changes nothing by opening.
      await waitFor(() => expect(cliCalls(bridge)).toContainEqual({ kind: 'channels' }));
      expect(cliCalls(bridge)).toContainEqual({ kind: 'activitySessions', since: '30d' });
      expect(changes(bridge)).toEqual([]);
    },
  );

  it(
    'shows the apps by servers: a tick, or a note of what is wrong or where, and the configs core could not read',
    SLOW,
    async () => {
      const view = await openConnections(bridgeAt());
      const table = await view.findByRole('table', { name: CONNECTIONS_COPY.tableCaption });
      const head = within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent?.trim());
      expect(head).toEqual(['App', 'Core', 'Gmail', 'Slack', 'Resend', 'WhatsApp', 'Events', 'Actions']);
      // Claude Code, Claude Desktop, Codex and Cursor always; VS Code because it has the event service's server.
      const apps = [...table.querySelectorAll('[data-slot="app-name"]')].map((name) => name.textContent);
      expect(apps).toEqual(['Claude Code', 'Claude Desktop', 'Codex', 'Cursor', 'VS Code']);

      const code = await rowOf('Claude Code');
      const cell = (server: McpServer) => code.cells[SERVER_COLUMN[server]]?.textContent;
      expect(cell('core')).toBe('✓Yes');
      expect(cell('gmail')).toBe('behind core');
      expect(cell('slack')).toBe('file missing');
      expect(cell('resend')).toBe('–No');
      expect(cell('whatsapp')).toBe('–No');
      expect(cell('events')).toBe('✓Yesproject: ~/work/acme-site');
      // Every folder (a user entry), and used when its newest window said so.
      const name = code.cells[0];
      expect(name?.textContent).toContain('Every folder');
      expect(name?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-26T13:58:00.000Z');
      expect(within(code.row).getByRole('button', { name: 'Change…' })).toBeTruthy();

      const desktop = await rowOf('Claude Desktop');
      expect(desktop.cells[0]?.textContent).toBe('Claude DesktopNot connected');
      expect(within(desktop.row).getByRole('button', { name: 'Add…' })).toBeTruthy();
      // Cursor's window said it was Cursor: last used, though nothing is registered with it.
      const cursor = await rowOf('Cursor');
      expect(cursor.cells[0]?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-25T10:00:00.000Z');
      // Codex: no window reported itself as Codex, so no "used" at all.
      const codex = await rowOf('Codex');
      expect(codex.cells[0]?.textContent).toBe('CodexEvery folder');
      expect(codex.cells[0]?.querySelector('time')).toBeNull();

      // What "used" is, said under the table.
      expect(view.getByText(CONNECTIONS_COPY.lastUsedNote)).toBeTruthy();
      expect(CONNECTIONS_COPY.lastUsedNote).toMatch(/reported/);
      // The config core could not read, with the home as `~`.
      const unreadable = view.getByRole('list', { name: CONNECTIONS_COPY.unreadable });
      expect(unreadable.textContent).toContain('Cursor');
      expect(unreadable.textContent).toContain('~/.cursor/mcp.json');
      expect(unreadable.textContent).toContain('it is not valid JSON, so what it registers is not known');
    },
  );

  it(
    'says who can reach the servers: windows on this Mac, Remote Control included, and never cloud sessions',
    SLOW,
    async () => {
      const view = await openConnections(bridgeAt());
      const reach = view.getByRole('region', { name: CONNECTIONS_COPY.reach });
      expect(within(reach).getByText('Yes')).toBeTruthy();
      expect(within(reach).getByText('No')).toBeTruthy();
      expect(within(reach).getByText(CONNECTIONS_COPY.yesLine)).toBeTruthy();
      expect(within(reach).getByText(CONNECTIONS_COPY.noLine)).toBeTruthy();
      expect(CONNECTIONS_COPY.yesLine).toContain('Remote Control');
      expect(CONNECTIONS_COPY.noLine).toContain('Cloud sessions');
    },
  );

  it('lists the agent windows used recently, a name no app gives as text, and opens Activity', SLOW, async () => {
    const view = await openConnections(bridgeAt());
    const recent = view.getByRole('region', { name: CONNECTIONS_COPY.recent });
    const items = await within(recent).findAllByRole('listitem');
    expect(items.map((item) => item.querySelector('[data-slot="window-folder"]')?.textContent)).toEqual([
      '~/work/acme-site',
      '~/work/ops',
      '~/work/billing-tool',
      '~/work/side-project',
    ]);
    expect(items[0]?.textContent).toContain('Claude Code · Gmail, Events');
    expect(items[2]?.textContent).toContain('Cursor · Gmail');
    // The window that named itself with markup: the name as it came, as text, and no element made of it.
    expect(items[3]?.textContent).toContain('<b>helpful-agent</b> · WhatsApp');
    expect(items[3]?.querySelector('b')).toBeNull();
    expect(items[0]?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-26T13:58:00.000Z');
    // The event service and a command are not agent windows.
    expect(items).toHaveLength(4);
    fireEvent.click(within(recent).getByRole('button', { name: CONNECTIONS_COPY.seeActivity }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Activity' })).toBeTruthy();
  });

  it(
    'Change… takes an unticked server away at once, and adds a ticked one once the person approves it in the app',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const view = await openConnections(bridge);
      const code = await rowOf('Claude Code');
      fireEvent.click(within(code.row).getByRole('button', { name: 'Change…' }));
      const editor = await view.findByRole('group', { name: 'Claude Code: which parts?' });
      const box = (name: string) => within(editor).getByRole('checkbox', { name });
      // Ticked as the table has them.
      expect(
        ['Core', 'Gmail', 'Slack', 'Resend', 'WhatsApp', 'Events'].map((name) =>
          box(name).getAttribute('aria-checked'),
        ),
      ).toEqual(['true', 'true', 'true', 'false', 'false', 'true']);
      expect(within(editor).getByText(CONNECTIONS_COPY.editHint)).toBeTruthy();
      fireEvent.click(box('Slack'));
      fireEvent.click(box('Resend'));
      fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));

      // Slack is taken away at once; Resend is asked for, and waits for the person.
      const preview = await view.findByRole('region', { name: 'Add Resend to Claude Code' });
      expect(changes(bridge)).toEqual([
        { kind: 'mcpUninstall', client: 'claude-code', server: 'slack' },
        { kind: 'mcpInstall', client: 'claude-code', server: 'resend' },
      ]);
      expect(
        await view.findByText('Slack was taken away from Claude Code. Restart Claude Code to see the change.'),
      ).toBeTruthy();
      // Core's preview, as text: what the server lets agents do; and the app's own confirm, with Cancel.
      expect(preview.textContent).toContain('Agents there could send mail <b>through Resend</b>.');
      expect(preview.querySelector('b')).toBeNull();
      expect(within(preview).getByText(CONNECTIONS_COPY.approveHere)).toBeTruthy();
      expect(within(preview).queryByRole('button', { name: 'Approve in Terminal' })).toBeNull();
      // Nothing was added yet: nothing approved, nothing opened, and the table reads core again without Slack.
      expect(approvedInApp(bridge)).toEqual([]);
      expect(terminals(bridge)).toEqual([]);
      await waitFor(async () =>
        expect((await rowOf('Claude Code')).cells[SERVER_COLUMN.slack]?.textContent).toBe('–No'),
      );
      expect((await rowOf('Claude Code')).cells[SERVER_COLUMN.resend]?.textContent).toBe('–No');

      fireEvent.click(within(preview).getByRole('button', { name: CONNECTIONS_COPY.approveAndAdd }));
      // The person's confirm answers the approval core prepared, for that install, once — and nothing is opened.
      await waitFor(() =>
        expect(approvedInApp(bridge)).toEqual([
          { kind: 'mcpInstallApproved', client: 'claude-code', server: 'resend', approvalId: ID },
        ]),
      );
      expect(await view.findByText('Resend was added to Claude Code. Restart Claude Code to use it.')).toBeTruthy();
      await waitFor(() => expect(view.queryByRole('region', { name: 'Add Resend to Claude Code' })).toBeNull());
      await waitFor(async () =>
        expect((await rowOf('Claude Code')).cells[SERVER_COLUMN.resend]?.textContent).toBe('✓Yes'),
      );
      expect(terminals(bridge)).toEqual([]);
      // Answered, so not revoked when it goes.
      expect(bridge.calls.some((call) => call.command === 'revokePreview')).toBe(false);
    },
  );

  it('the app never approves an install without the person pressing its confirm', SLOW, async () => {
    const bridge = bridgeAt();
    const view = await openConnections(bridge);
    fireEvent.click(within((await rowOf('Claude Desktop')).row).getByRole('button', { name: 'Add…' }));
    const editor = await view.findByRole('group', { name: 'Claude Desktop: which parts?' });
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Gmail' }));
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Slack' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    const gmail = await view.findByRole('region', { name: 'Add Gmail to Claude Desktop' });
    expect(await view.findByRole('region', { name: 'Add Slack to Claude Desktop' })).toBeTruthy();
    // Prepared, shown, and waiting: a moment passes, the window reads again, and still nothing is approved.
    await new Promise((settled) => setTimeout(settled, 50));
    window.dispatchEvent(new Event('focus'));
    await new Promise((settled) => setTimeout(settled, 50));
    expect(approvedInApp(bridge)).toEqual([]);
    // Cancel revokes it, and approves nothing.
    fireEvent.click(within(gmail).getByRole('button', { name: 'Cancel' }));
    expect(await view.findByText('Cancelled: Gmail was not added to Claude Desktop.')).toBeTruthy();
    expect(bridge.calls).toContainEqual({ command: 'revokePreview', args: ID });
    // Leaving the screen with one still waiting revokes that one too, and approves nothing.
    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    fireEvent.click(within(navigation).getByRole('button', { name: 'Overview' }));
    await waitFor(() => expect(bridge.calls).toContainEqual({ command: 'revokePreview', args: OTHER_ID }));
    expect(approvedInApp(bridge)).toEqual([]);
    expect(terminals(bridge)).toEqual([]);
  });

  it('an install core did not apply says why, and its approval can still be cancelled', SLOW, async () => {
    const bridge = bridgeAt('0.32.0', {
      approved: () => failed('APPROVAL_VOID', 'the change is not the one that was approved', 'Add it again.'),
    });
    const view = await openConnections(bridge);
    fireEvent.click(within((await rowOf('Claude Desktop')).row).getByRole('button', { name: 'Add…' }));
    const editor = await view.findByRole('group', { name: 'Claude Desktop: which parts?' });
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Core' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    const preview = await view.findByRole('region', { name: 'Add Core to Claude Desktop' });
    fireEvent.click(within(preview).getByRole('button', { name: CONNECTIONS_COPY.approveAndAdd }));
    expect((await within(preview).findByRole('alert')).textContent).toBe(
      'Core was not added to Claude Desktop: the change is not the one that was approved Add it again.',
    );
    fireEvent.click(within(preview).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(bridge.calls).toContainEqual({ command: 'revokePreview', args: ID }));
    expect((await rowOf('Claude Desktop')).cells[SERVER_COLUMN.core]?.textContent).toBe('–No');
  });

  it('Add… on an app with nothing only adds, and Cancel revokes the waiting approval', SLOW, async () => {
    const bridge = bridgeAt();
    const view = await openConnections(bridge);
    const desktop = await rowOf('Claude Desktop');
    fireEvent.click(within(desktop.row).getByRole('button', { name: 'Add…' }));
    const editor = await view.findByRole('group', { name: 'Claude Desktop: which parts?' });
    for (const box of within(editor).getAllByRole('checkbox')) expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Gmail' }));
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Events' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    const gmail = await view.findByRole('region', { name: 'Add Gmail to Claude Desktop' });
    expect(await view.findByRole('region', { name: 'Add Events to Claude Desktop' })).toBeTruthy();
    expect(changes(bridge)).toEqual([
      { kind: 'mcpInstall', client: 'claude-desktop', server: 'gmail' },
      { kind: 'mcpInstall', client: 'claude-desktop', server: 'events' },
    ]);
    fireEvent.click(within(gmail).getByRole('button', { name: 'Cancel' }));
    expect(await view.findByText('Cancelled: Gmail was not added to Claude Desktop.')).toBeTruthy();
    expect(bridge.calls).toContainEqual({ command: 'revokePreview', args: ID });
    expect(view.queryByRole('region', { name: 'Add Gmail to Claude Desktop' })).toBeNull();
    expect(terminals(bridge)).toEqual([]);
  });

  it('Cancel in the editor changes nothing, and saving the same ticks calls nothing', SLOW, async () => {
    const bridge = bridgeAt();
    const view = await openConnections(bridge);
    fireEvent.click(within((await rowOf('Claude Code')).row).getByRole('button', { name: 'Change…' }));
    let editor = await view.findByRole('group', { name: 'Claude Code: which parts?' });
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Gmail' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(view.queryByRole('group', { name: 'Claude Code: which parts?' })).toBeNull());
    fireEvent.click(within((await rowOf('Claude Code')).row).getByRole('button', { name: 'Change…' }));
    editor = await view.findByRole('group', { name: 'Claude Code: which parts?' });
    expect(within(editor).getByRole('checkbox', { name: 'Gmail' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(view.queryByRole('group', { name: 'Claude Code: which parts?' })).toBeNull());
    expect(changes(bridge)).toEqual([]);
  });

  it('says why a server was not taken away, and what core said', SLOW, async () => {
    const bridge = bridgeAt('0.32.0', {
      uninstall: () => failed('CONFIG_UNWRITABLE', 'the config file is read-only', 'Make it writable, then try again.'),
    });
    const view = await openConnections(bridge);
    fireEvent.click(within((await rowOf('Claude Code')).row).getByRole('button', { name: 'Change…' }));
    const editor = await view.findByRole('group', { name: 'Claude Code: which parts?' });
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Core' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    const alert = await view.findByRole('alert');
    expect(alert.textContent).toBe('Core was not taken away from Claude Code: the config file is read-only');
    expect(view.getByText('Make it writable, then try again.')).toBeTruthy();
    expect((await rowOf('Claude Code')).cells[SERVER_COLUMN.core]?.textContent).toBe('✓Yes');
  });

  it('a removal core would not apply at once is not taken as done, and its approval is revoked', SLOW, async () => {
    const bridge = bridgeAt('0.32.0', {
      uninstall: () => ({ status: 'approvalPending', approvalId: OTHER_ID, preview: 'p', expiresAt: null }),
    });
    const view = await openConnections(bridge);
    fireEvent.click(within((await rowOf('Claude Code')).row).getByRole('button', { name: 'Change…' }));
    const editor = await view.findByRole('group', { name: 'Claude Code: which parts?' });
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Gmail' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    expect((await view.findByRole('alert')).textContent).toBe('Gmail was not taken away from Claude Code.');
    await waitFor(() => expect(cliCalls(bridge)).toContainEqual({ kind: 'approvalRevoke', approvalId: OTHER_ID }));
    expect(terminals(bridge)).toEqual([]);
  });

  it(
    'on a core before 0.32.0, a server cannot be taken away here, and adding is approved in Terminal',
    SLOW,
    async () => {
      const bridge = bridgeAt('0.31.0');
      const view = await openConnections(bridge);
      fireEvent.click(within((await rowOf('Claude Code')).row).getByRole('button', { name: 'Change…' }));
      const editor = await view.findByRole('group', { name: 'Claude Code: which parts?' });
      expect(
        within(editor).getByText('Taking a part away needs 0.32.0 or later; this machine has 0.31.0.'),
      ).toBeTruthy();
      const gmail = within(editor).getByRole('checkbox', { name: 'Gmail' });
      expect(gmail.getAttribute('aria-disabled') === 'true' || gmail.hasAttribute('data-disabled')).toBe(true);
      fireEvent.click(gmail);
      expect(gmail.getAttribute('aria-checked')).toBe('true');
      fireEvent.click(within(editor).getByRole('checkbox', { name: 'WhatsApp' }));
      fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
      const preview = await view.findByRole('region', { name: 'Add WhatsApp to Claude Code' });
      expect(changes(bridge)).toEqual([{ kind: 'mcpInstall', client: 'claude-code', server: 'whatsapp' }]);
      // A core without the app's approval: the person approves it at their own terminal, as before.
      expect(within(preview).queryByRole('button', { name: CONNECTIONS_COPY.approveAndAdd })).toBeNull();
      fireEvent.click(within(preview).getByRole('button', { name: 'Approve in Terminal' }));
      await waitFor(() =>
        expect(terminals(bridge)).toEqual([
          { kind: 'change', call: { kind: 'mcpInstall', client: 'claude-code', server: 'whatsapp' }, revoke: ID },
        ]),
      );
      expect(await view.findByText('Confirm it in Terminal, then restart Claude Code to use it.')).toBeTruthy();
      expect(approvedInApp(bridge)).toEqual([]);
    },
  );

  it('on Windows and Linux, where nothing attests the app, adding is approved in Terminal', SLOW, async () => {
    platform.mac = false;
    const bridge = bridgeAt('0.33.0');
    const view = await openConnections(bridge);
    fireEvent.click(within((await rowOf('Claude Desktop')).row).getByRole('button', { name: 'Add…' }));
    const editor = await view.findByRole('group', { name: 'Claude Desktop: which parts?' });
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Gmail' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    const preview = await view.findByRole('region', { name: 'Add Gmail to Claude Desktop' });
    // Core's preview, and the person approves it at their own terminal: no confirm here, nothing answered in the app.
    expect(preview.textContent).toContain('Agents there could send mail <b>through Resend</b>.');
    expect(within(preview).queryByRole('button', { name: CONNECTIONS_COPY.approveAndAdd })).toBeNull();
    fireEvent.click(within(preview).getByRole('button', { name: 'Approve in Terminal' }));
    await waitFor(() =>
      expect(terminals(bridge)).toEqual([
        { kind: 'change', call: { kind: 'mcpInstall', client: 'claude-desktop', server: 'gmail' }, revoke: ID },
      ]),
    );
    expect(await view.findByText('Confirm it in Terminal, then restart Claude Desktop to use it.')).toBeTruthy();
    expect(approvedInApp(bridge)).toEqual([]);
  });

  it('when core will not take the approval here (exit 10), it is offered in Terminal instead', SLOW, async () => {
    // Core's refusal of an approval from a process nothing attests as the app (0.33.0, the second look).
    const bridge = bridgeAt('0.33.0', {
      approved: () => ({
        status: 'failed',
        exit: 10,
        code: 'APPROVAL_REQUIRED',
        message:
          'nothing on this platform attests that the Agent Comms app started this, so approve the change at your terminal',
        hint: null,
      }),
    });
    const view = await openConnections(bridge);
    fireEvent.click(within((await rowOf('Claude Desktop')).row).getByRole('button', { name: 'Add…' }));
    const editor = await view.findByRole('group', { name: 'Claude Desktop: which parts?' });
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Slack' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    const preview = await view.findByRole('region', { name: 'Add Slack to Claude Desktop' });
    fireEvent.click(within(preview).getByRole('button', { name: CONNECTIONS_COPY.approveAndAdd }));
    // Said, and the confirm becomes Approve in Terminal; the approval is still this preview's, and not revoked yet.
    expect((await within(preview).findByRole('alert')).textContent).toContain(
      'Slack was not added to Claude Desktop: nothing on this platform attests',
    );
    const terminal = await within(preview).findByRole('button', { name: 'Approve in Terminal' });
    expect(within(preview).queryByRole('button', { name: CONNECTIONS_COPY.approveAndAdd })).toBeNull();
    expect(bridge.calls.some((call) => call.command === 'revokePreview')).toBe(false);
    fireEvent.click(terminal);
    await waitFor(() =>
      expect(terminals(bridge)).toEqual([
        { kind: 'change', call: { kind: 'mcpInstall', client: 'claude-desktop', server: 'slack' }, revoke: ID },
      ]),
    );
    expect(await view.findByText('Confirm it in Terminal, then restart Claude Desktop to use it.')).toBeTruthy();
    expect(approvedInApp(bridge)).toEqual([
      { kind: 'mcpInstallApproved', client: 'claude-desktop', server: 'slack', approvalId: ID },
    ]);
  });

  it(
    'on a core before 0.29.0 there is no activity to read: no "used", and Used recently says to update',
    SLOW,
    async () => {
      const bridge = bridgeAt('0.28.0');
      const view = await openConnections(bridge);
      const code = await rowOf('Claude Code');
      expect(code.cells[0]?.querySelector('time')).toBeNull();
      const recent = view.getByRole('region', { name: CONNECTIONS_COPY.recent });
      expect(within(recent).getByText('Needs 0.29.0 or later; this machine has 0.28.0.')).toBeTruthy();
      expect(cliCalls(bridge).filter((call) => call.kind === 'activitySessions')).toEqual([]);
    },
  );

  it('in the test build Connections only shows: no Change… or Add…, and it says why', SLOW, async () => {
    const bridge = bridgeAt();
    bridge.appBuild = async () => ({
      identifier: 'com.cueplusplus.agentcomms.test',
      isTest: true,
      commit: 'a1b2c3d feat/0.32',
      builtAt: '2026-10-26T14:05:00Z',
    });
    const view = await openConnections(bridge);
    // The table is there, as it is in a release.
    expect((await rowOf('Claude Code')).cells[SERVER_COLUMN.core]?.textContent).toBe('✓Yes');
    expect(await view.findByText(CONNECTIONS_COPY.testBuildOnly)).toBeTruthy();
    expect(CONNECTIONS_COPY.testBuildOnly).toBe(
      "In the test build, Connections only shows. Changing it would edit your real apps' settings.",
    );
    expect(view.queryByRole('button', { name: 'Change…' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Add…' })).toBeNull();
    expect(view.queryByRole('group', { name: /which parts\?/ })).toBeNull();
    expect(changes(bridge)).toEqual([]);
    expect(approvedInApp(bridge)).toEqual([]);
  });

  it('a release build has no such line, and its Change… and Add…', SLOW, async () => {
    const view = await openConnections(bridgeAt());
    expect(await view.findAllByRole('button', { name: 'Change…' })).not.toHaveLength(0);
    expect(view.getAllByRole('button', { name: 'Add…' })).not.toHaveLength(0);
    expect(view.queryByText(CONNECTIONS_COPY.testBuildOnly)).toBeNull();
  });

  it("says what went wrong when core's channels cannot be read", SLOW, async () => {
    const bridge = createFakeBridge(
      { installation: async () => ({ ...EXAMPLE_INSTALLATION, version: '0.32.0' }) },
      { activitySessions: sessions },
    );
    const view = await openConnections(bridge);
    expect((await view.findByRole('alert')).textContent).toBe('no fixture answers channels');
  });
});
