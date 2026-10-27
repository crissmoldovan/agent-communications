import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Call, CliResult, Installation, TerminalCommand } from '../ipc.ts';
import { ADD_COPY, MCP_COPY, ONE_COPY, SNIPPET_COPY } from '../screens/connections/copy.ts';
import { createFakeBridge, EXAMPLE_INSTALLATION, type FakeBridge, failed, ok } from './fake-bridge.ts';
import channels from './fixtures/channels.connections.json';
import list from './fixtures/connection-list.json';
import shown from './fixtures/connection-show.json';
import label from './fixtures/label.connections.json';
import updateCheck from './fixtures/update-check.json';
import { renderApp } from './render.tsx';

/*
 * MCP connections in the app (0.35.0, single-server design §11; boards McpServers, AddConnection and Connection),
 * against the fake bridge and fixtures in core's own shapes. Nothing runs, and nothing reaches a CLI or an app's config.
 * The key below is a stand-in: nobody's, and no key's shape.
 */

const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

const SLOW = { timeout: 30_000 };
const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';
const OTHER_ID = 'ap_ABCDEFGHJKMNPQRSTVWXYZ0123';
const KEY = 'ack_example-not-a-real-key';
const WORK = list.connections[0]?.id ?? '';
const RAYCAST = list.connections[4]?.id ?? '';

/** Core's preview of a change, with markup that must stay text. */
const PREVIEW = 'CHANGE PREVIEW\nAdd the connection <b>Work</b> for Claude Code';

const SNIPPETS = {
  json: `{\n  "mcpServers": {\n    "agentcomms": {\n      "command": "/example/home/.local/share/agent-communications/launch/core",\n      "args": ["mcp", "--connection", "${RAYCAST}"],\n      "env": { "AGENT_COMMS_CONNECTION_KEY": "${KEY}" }\n    }\n  }\n}\n`,
  toml: `[mcp_servers.agentcomms]\ncommand = "/example/home/.local/share/agent-communications/launch/core"\n\n[mcp_servers.agentcomms.env]\nAGENT_COMMS_CONNECTION_KEY = "${KEY}"\n`,
  vscode: `{\n  "servers": {\n    "agentcomms": { "type": "stdio", "env": { "AGENT_COMMS_CONNECTION_KEY": "${KEY}" } }\n  }\n}\n`,
};

type Answers = Partial<Record<Call['kind'], (call: Call) => CliResult>>;

const pending = (approvalId = ID, preview = PREVIEW): CliResult => ({
  status: 'approvalPending',
  approvalId,
  preview,
  expiresAt: null,
});

const BASE: Answers = {
  connectionList: () => ok(structuredClone(list)),
  connectionShow: () => ok(structuredClone(shown)),
  channels: () => ok(structuredClone(channels)),
  label: () => ok(structuredClone(label)),
  updateCheck: () => ok({ ...structuredClone(updateCheck), behind: [] }),
};

/** Core at `version` (0.35.0 by default, the first with connections), answering from the fixtures and `answers`. */
function bridgeAt(version = '0.35.0', answers: Answers = {}): FakeBridge {
  const installation: Installation = { ...EXAMPLE_INSTALLATION, version };
  const base = createFakeBridge({ installation: async () => installation });
  const given = { ...BASE, ...answers };
  return createFakeBridge({
    installation: async () => installation,
    cli: async (call) => given[call.kind]?.(call) ?? base.cli(call),
  });
}

function asked<K extends Call['kind']>(bridge: FakeBridge, kind: K): Extract<Call, { kind: K }>[] {
  return bridge.calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind === kind)
    .map((call) => call.args as Extract<Call, { kind: K }>);
}
const changes = (bridge: FakeBridge): Call[] =>
  bridge.calls
    .filter((call) => call.command === 'cli')
    .map((call) => call.args as Call)
    .filter(
      (call) => call.kind.startsWith('connection') && call.kind !== 'connectionList' && call.kind !== 'connectionShow',
    );
const terminals = (bridge: FakeBridge): TerminalCommand[] =>
  bridge.calls.filter((call) => call.command === 'openInTerminal').map((call) => call.args as TerminalCommand);

const main = (): HTMLElement => screen.getByRole('main');

async function openList(bridge: FakeBridge) {
  renderApp(bridge, { screen: 'connections' });
  expect(await screen.findByRole('heading', { level: 1, name: MCP_COPY.title })).toBeTruthy();
  await within(main()).findByRole('list', { name: MCP_COPY.title });
  return within(main());
}

async function openOne(bridge: FakeBridge, name: string) {
  const view = await openList(bridge);
  fireEvent.click(view.getByRole('button', { name: MCP_COPY.openLabel(name) }));
  await view.findByRole('heading', { level: 2, name });
  return view;
}

describe('MCP connections: the list (McpServers board)', () => {
  it('shows a card for each place an app uses Agent Comms, and changes nothing by opening', SLOW, async () => {
    const bridge = bridgeAt();
    const view = await openList(bridge);
    // The nav names it as the boards do.
    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    expect(
      within(navigation)
        .getByRole('button', { name: /^MCP connections/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(view.getByText(MCP_COPY.sub)).toBeTruthy();
    expect(view.getByText('5 connections, in 4 apps')).toBeTruthy();
    const cards = view.getAllByRole('listitem').filter((item) => item.querySelector('[data-connection]'));
    expect(cards.map((card) => card.querySelector('h3')?.textContent)).toEqual([
      'Work — Claude Code',
      'Acme site — Claude Code',
      'Personal — Claude Desktop',
      'Reviews — Codex',
      'Raycast',
    ]);
    const work = within(cards[0] ?? main());
    expect(work.getByText('Claude Code · every folder')).toBeTruthy();
    expect(
      Array.from(cards[0]?.querySelectorAll('[data-slot="part-chips"] > *') ?? []).map((chip) => chip.textContent),
    ).toEqual(['Gmail · only acme/gmail', 'Slack', 'Events']);
    expect(cards[0]?.querySelector('[data-slot="connection-state"]')?.textContent).toMatch(/Connected·Last used/);
    expect(within(cards[1] ?? main()).getByText('Claude Code · project ~/work/acme-site')).toBeTruthy();
    const state = (index: number) => cards[index]?.querySelector('[data-slot="connection-state"]')?.textContent ?? '';
    expect(state(2)).toContain('Its entry has an old key');
    // Made at a terminal without Agent Comms itself: said, not hidden.
    expect(within(cards[3] ?? main()).getByText('Without Agent Comms itself')).toBeTruthy();
    expect(state(4)).toContain('Not used yet');
    expect(view.getByRole('region', { name: MCP_COPY.reach })).toBeTruthy();
    // It read the list, the parts, the accounts and the update check, and changed nothing.
    await waitFor(() => expect(asked(bridge, 'updateCheck')).toHaveLength(1));
    expect(asked(bridge, 'connectionList').length).toBeGreaterThan(0);
    expect(asked(bridge, 'channels').length).toBeGreaterThan(0);
    expect(asked(bridge, 'label').length).toBeGreaterThan(0);
    expect(changes(bridge)).toEqual([]);
  });

  it('greets a machine with none, and an older core keeps the table of apps by server', SLOW, async () => {
    const empty = bridgeAt('0.35.0', { connectionList: () => ok({ connections: [], problems: [] }) });
    renderApp(empty, { screen: 'connections' });
    expect(await within(await screen.findByRole('main')).findByText(MCP_COPY.helloLine)).toBeTruthy();
    expect(within(main()).getByRole('button', { name: MCP_COPY.add })).toBeTruthy();
  });

  it('on an older core reads no connection at all', SLOW, async () => {
    const older = bridgeAt('0.34.0');
    renderApp(older, { screen: 'connections' });
    expect(await screen.findByRole('heading', { level: 1, name: MCP_COPY.title })).toBeTruthy();
    await waitFor(() => expect(asked(older, 'channels').length).toBeGreaterThan(0));
    expect(asked(older, 'connectionList')).toEqual([]);
  });

  it(
    'moves separate entries into one connection, approved in the app, with Undo beside what it moved',
    SLOW,
    async () => {
      const bridge = bridgeAt('0.35.0', {
        connectionMigrate: (call) =>
          (call as Extract<Call, { kind: 'connectionMigrate' }>).appApproval === undefined
            ? pending(ID, 'Move "gmail", "agentcomms" in ~/.cursor/mcp.json into one connection')
            : ok({
                migrated: [{ id: RAYCAST, name: 'Cursor', app: 'cursor', replaced: 2, backups: [] }],
                left: [],
                next: ['Restart Cursor once.'],
              }),
        connectionMigrateUndo: (call) =>
          (call as Extract<Call, { kind: 'connectionMigrateUndo' }>).appApproval === undefined
            ? pending(OTHER_ID, 'Undo the connection "Cursor"')
            : ok({
                id: RAYCAST,
                name: 'Cursor',
                registered: [{ server: 'gmail', name: 'gmail', applied: true }],
                next: '',
              }),
      });
      const view = await openList(bridge);
      const move = view.getByRole('region', { name: MCP_COPY.moveTitle });
      fireEvent.click(within(move).getByRole('button', { name: MCP_COPY.moveButton }));
      expect(await within(move).findByText(/Move "gmail", "agentcomms"/)).toBeTruthy();
      fireEvent.click(within(move).getByRole('button', { name: MCP_COPY.approve }));
      expect(await view.findByText(/Moved 2 entries into the connection “Cursor” \(cursor\)\./)).toBeTruthy();
      expect(asked(bridge, 'connectionMigrate')).toEqual([
        { kind: 'connectionMigrate' },
        { kind: 'connectionMigrate', appApproval: ID },
      ]);
      // Undo, beside it: prepared, then approved in the app, for that connection only.
      fireEvent.click(view.getByRole('button', { name: MCP_COPY.undoLabel('Cursor') }));
      fireEvent.click(await view.findByRole('button', { name: MCP_COPY.approve }));
      expect(await view.findByText(MCP_COPY.undone('Cursor'))).toBeTruthy();
      expect(asked(bridge, 'connectionMigrateUndo')).toEqual([
        { kind: 'connectionMigrateUndo', connectionId: RAYCAST },
        { kind: 'connectionMigrateUndo', connectionId: RAYCAST, appApproval: OTHER_ID },
      ]);
    },
  );

  it('the test build only shows: no Add, no Move, nothing changed', SLOW, async () => {
    const bridge = bridgeAt();
    bridge.appBuild = async () => ({
      identifier: 'com.cueplusplus.agentcomms.test',
      isTest: true,
      commit: null,
      builtAt: null,
    });
    const view = await openList(bridge);
    expect(await view.findByText(MCP_COPY.testBanner)).toBeTruthy();
    expect(view.queryByRole('button', { name: MCP_COPY.add })).toBeNull();
    expect(view.queryByRole('region', { name: MCP_COPY.moveTitle })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: MCP_COPY.openLabel('Work — Claude Code') }));
    await view.findByRole('heading', { level: 2, name: 'Work — Claude Code' });
    expect(view.queryByRole('button', { name: ONE_COPY.rename })).toBeNull();
    expect(view.queryByRole('button', { name: ONE_COPY.removeButton })).toBeNull();
    expect(changes(bridge)).toEqual([]);
  });
});

describe('MCP connections: adding one (AddConnection board)', () => {
  it(
    'adds Claude Code in every folder, approved in the app, and says where it went — never its key',
    SLOW,
    async () => {
      const bridge = bridgeAt('0.35.0', {
        connectionAdd: (call) =>
          (call as Extract<Call, { kind: 'connectionAdd' }>).appApproval === undefined
            ? pending()
            : ok({ connection: list.connections[0], next: 'Restart Claude Code', verification: 'ok' }),
      });
      const view = await openList(bridge);
      fireEvent.click(view.getByRole('button', { name: MCP_COPY.add }));
      fireEvent.click(await view.findByRole('button', { name: /^Claude Code/ }));
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      // Where: every folder is the first place.
      expect(await view.findByRole('button', { name: /^Every folder/, pressed: true })).toBeTruthy();
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      expect(await view.findByDisplayValue('Claude Code — every folder')).toBeTruthy();
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      // Parts: Agent Comms itself always, each channel with an account here, and Events (it is installed).
      const editor = await view.findByText(ADD_COPY.partsTitle('Claude Code — every folder'));
      expect(editor).toBeTruthy();
      const core = view.getByRole('switch', { name: 'Agent Comms itself, always included' });
      expect(core.getAttribute('aria-checked')).toBe('true');
      expect(core.hasAttribute('data-disabled')).toBe(true);
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      // Core's preview, as text, under the app's own header.
      expect(await view.findByText(/Add the connection <b>Work<\/b>/)).toBeTruthy();
      expect(main().querySelector('b')).toBeNull();
      expect(view.getByText(ADD_COPY.askTitle('Claude Code — every folder'))).toBeTruthy();
      const prepared = {
        kind: 'connectionAdd',
        app: 'claude-code',
        name: 'Claude Code — every folder',
        parts: [
          { server: 'core' },
          { server: 'gmail' },
          { server: 'resend' },
          { server: 'slack' },
          { server: 'whatsapp' },
          { server: 'events' },
        ],
      };
      expect(asked(bridge, 'connectionAdd')).toEqual([prepared]);
      fireEvent.click(view.getByRole('button', { name: MCP_COPY.approve }));
      expect(await view.findByText(ADD_COPY.doneKnown('Claude Code'))).toBeTruthy();
      expect(asked(bridge, 'connectionAdd')).toEqual([prepared, { ...prepared, appApproval: ID }]);
      expect(view.getByText('Written into ~/.claude.json, as “agentcomms”.')).toBeTruthy();
      expect(view.getByText(ADD_COPY.nothingToPaste('Claude Code'))).toBeTruthy();
      expect(main().textContent).not.toContain('ack_');
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.done }));
      expect(await view.findByText(MCP_COPY.addedSaid('Work — Claude Code', 'Claude Code', false))).toBeTruthy();
    },
  );

  it(
    'adds Claude Code for one project by its folder, with ~ read as the home, and only Gmail read-only',
    SLOW,
    async () => {
      const bridge = bridgeAt('0.35.0', { connectionAdd: () => pending() });
      const view = await openList(bridge);
      fireEvent.click(view.getByRole('button', { name: MCP_COPY.add }));
      fireEvent.click(await view.findByRole('button', { name: /^Claude Code/ }));
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      fireEvent.click(await view.findByRole('button', { name: /^One project folder/ }));
      // The same place as another connection is said, beside the choice; a folder is asked for.
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      expect(await view.findByText(ADD_COPY.folderProblem)).toBeTruthy();
      fireEvent.change(view.getByRole('textbox', { name: ADD_COPY.folderLabel }), {
        target: { value: '~/work/acme-site' },
      });
      expect(await view.findByText(/Acme site — Claude Code uses this place already/)).toBeTruthy();
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      // A name another connection has is refused before anything is asked.
      fireEvent.change(await view.findByRole('textbox', { name: ADD_COPY.nameLabel }), {
        target: { value: 'Work — Claude Code' },
      });
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      expect(await view.findByText(ADD_COPY.nameTaken('Work — Claude Code'))).toBeTruthy();
      fireEvent.change(view.getByRole('textbox', { name: ADD_COPY.nameLabel }), { target: { value: 'Acme two' } });
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      // Gmail kept to one mailbox, and to reading; Slack has no read-only switch.
      const gmail = await waitFor(() => {
        const found = main().querySelector('[data-part="gmail"]');
        if (!(found instanceof HTMLElement)) throw new Error('Gmail is a part');
        return within(found);
      });
      fireEvent.click(gmail.getByRole('radio', { name: 'Only acme/gmail' }));
      fireEvent.click(gmail.getByRole('checkbox', { name: 'Read and search only: no drafts, no emails' }));
      const slack = main().querySelector('[data-part="slack"]') as HTMLElement;
      expect(within(slack).queryByRole('checkbox')).toBeNull();
      fireEvent.click(within(slack).getByRole('switch'));
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      await view.findByText(/Add the connection/);
      expect(asked(bridge, 'connectionAdd')).toEqual([
        {
          kind: 'connectionAdd',
          app: 'claude-code',
          name: 'Acme two',
          parts: [
            { server: 'core' },
            { server: 'gmail', account: 'acme/gmail', readOnly: true },
            { server: 'resend' },
            { server: 'whatsapp' },
            { server: 'events' },
          ],
          folder: '/example/home/work/acme-site',
        },
      ]);
      // Back takes the preview away, which revokes its approval.
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.back }));
      await waitFor(() => expect(bridge.calls.filter((call) => call.command === 'revokePreview')).toHaveLength(1));
    },
  );

  it(
    'adds a Manual connection: its snippet, with its key, shown this once, in each format, and let go at Done',
    SLOW,
    async () => {
      const bridge = bridgeAt('0.35.0', {
        connectionAdd: (call) =>
          (call as Extract<Call, { kind: 'connectionAdd' }>).appApproval === undefined
            ? pending()
            : ok({ connection: list.connections[4], next: 'Paste the snippet…', snippets: SNIPPETS }),
      });
      const view = await openList(bridge);
      fireEvent.click(view.getByRole('button', { name: MCP_COPY.add }));
      fireEvent.click(await view.findByRole('button', { name: /^Manual \/ another app/ }));
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      fireEvent.change(await view.findByRole('textbox', { name: ADD_COPY.manualLabel }), {
        target: { value: 'Raycast' },
      });
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      fireEvent.change(await view.findByRole('textbox', { name: ADD_COPY.nameLabel }), {
        target: { value: 'Raycast two' },
      });
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      await view.findByText(ADD_COPY.partsTitle('Raycast two'));
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      expect(await view.findByText(ADD_COPY.whereManual('Raycast'))).toBeTruthy();
      expect(main().textContent).not.toContain(KEY);
      fireEvent.click(view.getByRole('button', { name: MCP_COPY.approve }));
      expect(await view.findByText(ADD_COPY.doneManual('Raycast'))).toBeTruthy();
      const snippet = () => main().querySelector('[data-slot="snippet"]')?.textContent ?? '';
      expect(snippet()).toBe(SNIPPETS.json);
      fireEvent.click(view.getByRole('button', { name: SNIPPET_COPY.formats.toml }));
      expect(snippet()).toBe(SNIPPETS.toml);
      fireEvent.click(view.getByRole('button', { name: SNIPPET_COPY.formats.vscode }));
      expect(snippet()).toBe(SNIPPETS.vscode);
      fireEvent.click(view.getByRole('button', { name: SNIPPET_COPY.copy }));
      await waitFor(() =>
        expect(bridge.calls.filter((call) => call.command === 'copyText')).toEqual([
          { command: 'copyText', args: SNIPPETS.vscode },
        ]),
      );
      expect(view.getByText(SNIPPET_COPY.once)).toBeTruthy();
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.done }));
      expect(await view.findByText(MCP_COPY.addedSaid('Raycast', 'the app', true))).toBeTruthy();
      expect(document.body.textContent).not.toContain(KEY);
    },
  );

  it(
    'on Windows and Linux, Approve opens the prepared addition in Terminal, and nothing is approved here',
    SLOW,
    async () => {
      platform.mac = false;
      const bridge = bridgeAt('0.35.0', { connectionAdd: () => pending() });
      const view = await openList(bridge);
      fireEvent.click(view.getByRole('button', { name: MCP_COPY.add }));
      fireEvent.click(await view.findByRole('button', { name: /^Claude Desktop/ }));
      fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
      fireEvent.click(await view.findByRole('button', { name: ADD_COPY.continue }));
      fireEvent.click(await view.findByRole('button', { name: ADD_COPY.continue }));
      fireEvent.click(await view.findByRole('button', { name: 'Approve in Terminal' }));
      expect(await view.findByText(ADD_COPY.terminalKnown)).toBeTruthy();
      const [prepared] = asked(bridge, 'connectionAdd');
      expect(prepared?.appApproval).toBeUndefined();
      expect(terminals(bridge)).toEqual([{ kind: 'change', call: prepared, revoke: ID }]);
      expect(asked(bridge, 'connectionAdd')).toHaveLength(1);
    },
  );

  it('prepares an addition again when core calls its approval void', SLOW, async () => {
    let prepares = 0;
    const bridge = bridgeAt('0.35.0', {
      connectionAdd: (call) => {
        if ((call as Extract<Call, { kind: 'connectionAdd' }>).appApproval === undefined) {
          prepares += 1;
          return pending(prepares === 1 ? ID : OTHER_ID);
        }
        return (call as Extract<Call, { kind: 'connectionAdd' }>).appApproval === ID
          ? failed('APPROVAL_VOID', 'that approval was handed another change')
          : ok({ connection: list.connections[2] });
      },
    });
    const view = await openList(bridge);
    fireEvent.click(view.getByRole('button', { name: MCP_COPY.add }));
    fireEvent.click(await view.findByRole('button', { name: /^Cursor/ }));
    fireEvent.click(view.getByRole('button', { name: ADD_COPY.continue }));
    fireEvent.click(await view.findByRole('button', { name: ADD_COPY.continue }));
    fireEvent.click(await view.findByRole('button', { name: ADD_COPY.continue }));
    fireEvent.click(await view.findByRole('button', { name: MCP_COPY.approve }));
    expect(await view.findByText(MCP_COPY.prepareAgain)).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: MCP_COPY.approve }));
    expect(await view.findByText(ADD_COPY.doneKnown('Cursor'))).toBeTruthy();
    expect(asked(bridge, 'connectionAdd').map((call) => call.appApproval)).toEqual([
      undefined,
      ID,
      undefined,
      OTHER_ID,
    ]);
  });
});

describe('MCP connections: one connection (Connection board)', () => {
  it('shows how it stands and what runs for it now, its entry, key and parts', SLOW, async () => {
    const bridge = bridgeAt();
    const view = await openOne(bridge, 'Work — Claude Code');
    await waitFor(() =>
      expect(asked(bridge, 'connectionShow')).toEqual([{ kind: 'connectionShow', connectionId: WORK }]),
    );
    expect(await view.findByText('Running now for claude-code')).toBeTruthy();
    expect(
      view.getByText('Slack: starting again (0.35.0) — Slack stopped; Agent Comms is starting it again'),
    ).toBeTruthy();
    expect(view.getByText('“agentcomms” in ~/.claude.json')).toBeTruthy();
    const parts = Array.from(main().querySelectorAll('li[data-part]')).map((line) => line.textContent);
    expect(parts).toEqual([
      'Agent Comms itselfSetup, approvals and updates',
      'Gmailonly acme/gmail · can draft, and prepare mail that waits for your yes',
      'Slackevery account · can prepare posts that wait for your yes',
      'Eventsevery account',
    ]);
    expect(view.getByText('Not included: Resend, WhatsApp.')).toBeTruthy();
    expect(changes(bridge)).toEqual([]);
  });

  it('renames it, replaces its key and removes it, each at once', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      connectionRename: () =>
        ok({ connection: { ...list.connections[0], name: 'Work' }, before: 'Work — Claude Code' }),
      connectionKeyReplace: () =>
        ok({ connection: list.connections[0], next: 'The new key is in Claude Code’s entry' }),
      connectionRemove: () => ok({ id: WORK, name: 'Work — Claude Code', entry: { removed: 1, kept: [] }, next: '' }),
    });
    const view = await openOne(bridge, 'Work — Claude Code');
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.rename }));
    fireEvent.change(view.getByRole('textbox', { name: ONE_COPY.renameLabel }), { target: { value: 'Work' } });
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.save }));
    expect(await view.findByText(ONE_COPY.renamed('Work'))).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.replace }));
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.replaceButton }));
    expect(await view.findByText(ONE_COPY.replacedKnown('Claude Code'))).toBeTruthy();
    expect(main().querySelector('[data-slot="snippet"]')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.removeButton }));
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.removeConfirm }));
    expect(await view.findByText(MCP_COPY.removedSaid('Work — Claude Code', 'Claude Code', false))).toBeTruthy();
    expect(changes(bridge)).toEqual([
      { kind: 'connectionRename', connectionId: WORK, name: 'Work' },
      { kind: 'connectionKeyReplace', connectionId: WORK },
      { kind: 'connectionRemove', connectionId: WORK },
    ]);
  });

  it(
    'removing one project’s connection over the one for every folder asks first, and is approved in the app',
    SLOW,
    async () => {
      // Core asks where its entry shadows a wider one the agents in its folder would then use (0.35.0 review, H1).
      const acme = list.connections[1]?.id ?? '';
      const bridge = bridgeAt('0.35.0', {
        connectionRemove: (call) =>
          (call as Extract<Call, { kind: 'connectionRemove' }>).appApproval === undefined
            ? pending(
                ID,
                'Remove the connection "Acme site — Claude Code"\nAgents in ~/work/acme-site will then use the connection "Work — Claude Code"',
              )
            : ok({ id: acme, name: 'Acme site — Claude Code', entry: { removed: 1, kept: [] }, next: '' }),
      });
      const view = await openOne(bridge, 'Acme site — Claude Code');
      fireEvent.click(view.getByRole('button', { name: ONE_COPY.removeButton }));
      fireEvent.click(view.getByRole('button', { name: ONE_COPY.removeConfirm }));
      expect(await view.findByText(ONE_COPY.removeAsk('Acme site — Claude Code'))).toBeTruthy();
      expect(view.getByText(/will then use the connection "Work — Claude Code"/)).toBeTruthy();
      fireEvent.click(view.getByRole('button', { name: MCP_COPY.approve }));
      expect(
        await view.findByText(MCP_COPY.removedApprovedSaid('Acme site — Claude Code', 'Claude Code')),
      ).toBeTruthy();
      expect(changes(bridge)).toEqual([
        { kind: 'connectionRemove', connectionId: acme },
        { kind: 'connectionRemove', connectionId: acme, appApproval: ID },
      ]);
    },
  );

  it('a Manual connection’s new key comes as its snippet, shown this once', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      connectionKeyReplace: () =>
        ok({ connection: list.connections[4], next: 'Paste the new snippet…', snippets: SNIPPETS }),
    });
    const view = await openOne(bridge, 'Raycast');
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.replace }));
    expect(view.getByText(ONE_COPY.replaceManual)).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.replaceButton }));
    expect(await view.findByText(ONE_COPY.newSnippet)).toBeTruthy();
    expect(main().querySelector('[data-slot="snippet"]')?.textContent).toBe(SNIPPETS.json);
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.hideSnippet }));
    await waitFor(() => expect(main().querySelector('[data-slot="snippet"]')).toBeNull());
    expect(document.body.textContent).not.toContain(KEY);
    // A Manual connection has no separate entries to go back to.
    expect(view.queryByRole('button', { name: ONE_COPY.undoButton })).toBeNull();
  });

  it('takes a part away at once, and asks before giving one more', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      connectionChange: (call) => {
        const change = call as Extract<Call, { kind: 'connectionChange' }>;
        if (change.parts.some((part) => part.server === 'resend'))
          return change.appApproval === undefined
            ? pending(ID, 'Let agents in "Work — Claude Code" reach more')
            : ok({});
        return ok({ connection: list.connections[0], appliedAtOnce: ['Slack taken out'], next: '' });
      },
    });
    const view = await openOne(bridge, 'Work — Claude Code');
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.change }));
    const part = (server: string) => within(main().querySelector(`[data-part="${server}"]`) as HTMLElement);
    fireEvent.click(part('slack').getByRole('switch'));
    expect(await view.findByText(ONE_COPY.partsAtOnce('Slack taken out', 'Claude Code'))).toBeTruthy();
    fireEvent.click(part('resend').getByRole('switch'));
    expect(await view.findByText(/reach more$/)).toBeTruthy();
    expect(view.getByText('prepare an email, which goes only after your yes')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: MCP_COPY.approve }));
    expect(await view.findByText(ONE_COPY.partsApproved('Work — Claude Code', 'Claude Code'))).toBeTruthy();
    const everyPart = [{ server: 'core' }, { server: 'gmail', account: 'acme/gmail' }];
    expect(asked(bridge, 'connectionChange')).toEqual([
      { kind: 'connectionChange', connectionId: WORK, parts: [...everyPart, { server: 'events' }] },
      {
        kind: 'connectionChange',
        connectionId: WORK,
        parts: [...everyPart, { server: 'resend' }, { server: 'slack' }, { server: 'events' }],
      },
      {
        kind: 'connectionChange',
        connectionId: WORK,
        parts: [...everyPart, { server: 'resend' }, { server: 'slack' }, { server: 'events' }],
        appApproval: ID,
      },
    ]);
  });

  it('goes back to separate entries, approved first, and says what it registered', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      connectionMigrateUndo: (call) =>
        (call as Extract<Call, { kind: 'connectionMigrateUndo' }>).appApproval === undefined
          ? pending(ID, 'Undo the connection "Personal — Claude Desktop"')
          : ok({
              id: list.connections[2]?.id,
              name: 'Personal — Claude Desktop',
              registered: [
                { server: 'core', name: 'agentcomms', applied: true },
                { server: 'gmail', name: 'gmail', applied: true },
              ],
              next: '',
            }),
    });
    const view = await openOne(bridge, 'Personal — Claude Desktop');
    fireEvent.click(view.getByRole('button', { name: ONE_COPY.undoButton }));
    fireEvent.click(await view.findByRole('button', { name: MCP_COPY.approve }));
    expect(await view.findByText(ONE_COPY.undone('Agent Comms itself as “agentcomms”; Gmail as “gmail”'))).toBeTruthy();
  });
});
