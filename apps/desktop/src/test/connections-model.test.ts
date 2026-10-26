// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readSessions } from '../activity.ts';
import {
  ALWAYS_SHOWN,
  APP_LABELS,
  appOfClient,
  CLIENT_NAMES,
  changePlan,
  installServers,
  lastUsedByApp,
  olderLine,
  readChannels,
  readUpdateCheck,
  recentWindows,
  SERVER_LABELS,
  serverNames,
} from '../connections.ts';
import { MCP_CLIENTS, MCP_SERVERS } from '../ipc.ts';
import sessionsFixture from './fixtures/activity-sessions-clients.json';
import channels from './fixtures/channels.json';
import none from './fixtures/channels.none.json';
import updateCheck from './fixtures/update-check.json';

const HOME = '/example/home';

const view = () => {
  const read = readChannels(channels, HOME);
  if (read === null) throw new Error('the fixture is a channels report');
  return read;
};
const app = (client: string) => {
  const row = view().apps.find((each) => each.client === client);
  if (row === undefined) throw new Error(`no row for ${client}`);
  return row;
};

describe("Connections' table, from core's channels (spec §3.3)", () => {
  it('shows Claude Code, Claude Desktop, Codex and Cursor always, and Gemini and VS Code only with a registration', () => {
    expect(ALWAYS_SHOWN).toEqual(['claude-code', 'claude-desktop', 'codex', 'cursor']);
    // VS Code has the event service's server; Gemini has nothing.
    expect(view().apps.map((row) => row.client)).toEqual([
      'claude-code',
      'claude-desktop',
      'codex',
      'cursor',
      'vscode',
    ]);
    expect(view().apps.map((row) => row.label)).toEqual([
      'Claude Code',
      'Claude Desktop',
      'Codex',
      'Cursor',
      'VS Code',
    ]);
    // With nothing registered anywhere, the four, each with nothing.
    const empty = readChannels(none, HOME);
    expect(empty?.apps.map((row) => row.client)).toEqual(ALWAYS_SHOWN);
    for (const row of empty?.apps ?? []) {
      expect(row.servers).toEqual([]);
      expect(row.reach).toBe('none');
      for (const server of MCP_SERVERS) expect(row.cells[server]).toEqual({ registered: false, ok: false, notes: [] });
    }
  });

  it('names the six servers in their order, and every app core registers with', () => {
    expect(MCP_SERVERS.map((server) => SERVER_LABELS[server])).toEqual([
      'Core',
      'Gmail',
      'Slack',
      'Resend',
      'WhatsApp',
      'Events',
    ]);
    expect(MCP_CLIENTS.map((client) => APP_LABELS[client])).toEqual([
      'Claude Code',
      'Claude Desktop',
      'Codex',
      'Cursor',
      'Gemini',
      'VS Code',
    ]);
  });

  it('a cell is a tick, or a note: its file missing, or a project with its folder; never "behind core"', () => {
    const code = app('claude-code');
    expect(code.cells.core).toEqual({ registered: true, ok: true, notes: [] });
    // Its entry pins a release older than the core answering (`behindCore`), which is not what `update` compares with:
    // without `update --check`'s answer, nothing is said of its version.
    expect(code.cells.gmail).toEqual({ registered: true, ok: true, notes: [] });
    expect(code.older).toBeNull();
    expect(code.cells.slack).toEqual({ registered: true, ok: false, notes: ['file missing'] });
    expect(code.cells.resend).toEqual({ registered: false, ok: false, notes: [] });
    expect(code.cells.whatsapp).toEqual({ registered: false, ok: false, notes: [] });
    // A project's entry starts it in that folder only, shown with the home as `~`.
    expect(code.cells.events).toEqual({ registered: true, ok: true, notes: ['project: ~/work/acme-site'] });
    expect(code.servers).toEqual(['core', 'gmail', 'slack', 'events']);
    expect(code.reach).toBe('every-folder');
    expect(app('codex').servers).toEqual(['core']);
    expect(app('vscode').cells.events).toEqual({ registered: true, ok: true, notes: [] });
    expect(app('claude-desktop').reach).toBe('none');
  });

  it("an app whose only entries are a project's reaches some folders; one kept in Claude Code's own file has none", () => {
    const report = structuredClone(none) as unknown as { channels: { channel: string; registered: unknown[] }[] };
    const entry = (path: string) => ({
      client: 'claude-code',
      name: 'gmail',
      scope: 'project',
      path,
      launcher: 'managed',
      version: '0.32.0',
      narrowing: [],
      pathPins: {},
      missing: null,
      behindCore: false,
    });
    const gmail = report.channels.find((channel) => channel.channel === 'gmail');
    gmail?.registered.push(entry('/example/home/work/a/.mcp.json'), entry('/example/home/.claude.json'));
    const row = readChannels(report, HOME)?.apps.find((each) => each.client === 'claude-code');
    expect(row?.reach).toBe('some-folders');
    // `~/.claude.json` keeps a project's entries under its folder's name, which core does not report.
    expect(row?.cells.gmail).toEqual({ registered: true, ok: true, notes: ['project: ~/work/a', 'project'] });
  });

  it('lists the configs core could not read, the folder shown with the home as `~`', () => {
    expect(view().unreadable).toEqual([
      {
        client: 'cursor',
        label: 'Cursor',
        path: '~/.cursor/mcp.json',
        reason: 'it is not valid JSON, so what it registers is not known',
      },
    ]);
  });

  it("ignores servers and apps it does not know, and refuses what is not core's report", () => {
    const report = structuredClone(channels) as { channels: unknown[] };
    report.channels.push({ channel: 'telegram', registered: [{ client: 'claude-code', scope: 'user', path: 'x' }] });
    const extra = readChannels(report, HOME);
    expect(extra?.apps.find((row) => row.client === 'claude-code')?.servers).toEqual([
      'core',
      'gmail',
      'slack',
      'events',
    ]);
    const odd = structuredClone(none) as { channels: { channel: string; registered: unknown[] }[] };
    odd.channels[0]?.registered.push({
      client: 'windsurf',
      scope: 'user',
      path: 'x',
      missing: null,
      behindCore: false,
    });
    expect(readChannels(odd, HOME)?.apps.map((row) => row.client)).toEqual(ALWAYS_SHOWN);
    for (const bad of [null, [], 'channels', { channels: 'x' }, { unreadable: [] }])
      expect(readChannels(bad)).toBeNull();
  });
});

describe('which app a window says it is (spec §3.3, L: approximate)', () => {
  it('maps the names windows give themselves to an app, through a small table, and nothing else', () => {
    expect(appOfClient('claude-code')).toBe('claude-code');
    expect(appOfClient('Claude-Code')).toBe('claude-code');
    expect(appOfClient(' claude-code ')).toBe('claude-code');
    expect(appOfClient('claude-ai')).toBe('claude-desktop');
    expect(appOfClient('cursor-vscode')).toBe('cursor');
    expect(appOfClient('codex-mcp-client')).toBe('codex');
    expect(appOfClient('gemini-cli-mcp-client')).toBe('gemini');
    expect(appOfClient('Visual Studio Code')).toBe('vscode');
    for (const unknown of [
      '',
      'claude',
      'helpful-agent',
      '<b>claude-code</b>',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(appOfClient(unknown)).toBeNull();
    }
    expect(appOfClient(null)).toBeNull();
    expect(appOfClient(undefined)).toBeNull();
    // Every name in the table is one an app gives: lowercase, and an app core registers with.
    for (const [name, client] of CLIENT_NAMES) {
      expect(name).toBe(name.toLowerCase());
      expect(MCP_CLIENTS).toContain(client);
    }
  });

  it("each app's last use is the newest an agent window of it reported; an app no window reported has none", () => {
    const sessions = readSessions(sessionsFixture)?.sessions ?? [];
    expect(lastUsedByApp(sessions)).toEqual({
      'claude-code': '2026-10-26T13:58:00.000Z',
      cursor: '2026-10-25T10:00:00.000Z',
    });
  });

  it('the windows used recently are the agent windows, newest first, each with its folder, client and channels', () => {
    const sessions = readSessions(sessionsFixture)?.sessions ?? [];
    expect(recentWindows(sessions)).toEqual([
      {
        key: '5e55105e00000001',
        folder: '~/work/acme-site',
        app: 'claude-code',
        client: 'claude-code',
        channels: ['Gmail', 'Events'],
        at: '2026-10-26T13:58:00.000Z',
      },
      {
        key: '5e55105e00000002',
        folder: '~/work/ops',
        app: 'claude-code',
        client: 'claude-code',
        channels: ['Slack'],
        at: '2026-10-26T13:00:00.000Z',
      },
      {
        key: '5e55105e00000004',
        folder: '~/work/billing-tool',
        app: 'cursor',
        client: 'cursor-vscode',
        channels: ['Gmail'],
        at: '2026-10-25T10:00:00.000Z',
      },
      {
        key: '5e55105e00000005',
        folder: '~/work/side-project',
        app: null,
        client: '<b>helpful-agent</b>',
        channels: ['WhatsApp'],
        at: '2026-10-24T08:30:00.000Z',
      },
    ]);
    expect(recentWindows(sessions, 2).map((window) => window.key)).toEqual(['5e55105e00000001', '5e55105e00000002']);
  });
});

describe('which entries start an older Agent Comms, by `update --check` (0.34.0)', () => {
  const check = () => {
    const read = readUpdateCheck(updateCheck);
    if (read === null) throw new Error('the fixture is an update check');
    return read;
  };

  it("reads the check's registrations that are behind, by app and server, and whether anything at all is", () => {
    expect(check()).toEqual({ latest: '0.32.0', older: { 'claude-code': { gmail: '0.31.0' } }, anyBehind: true });
    // Only a runtime behind: no entry is older, and there is still something to bring up to date.
    const runtime = { ...updateCheck, behind: updateCheck.behind.filter((item) => item.kind === 'runtime') };
    expect(readUpdateCheck(runtime)).toEqual({ latest: '0.32.0', older: {}, anyBehind: true });
    expect(readUpdateCheck({ ...updateCheck, behind: [] })?.anyBehind).toBe(false);
    // An app or server it does not know, or an entry without a version, is not read as one.
    const odd = {
      ...updateCheck,
      behind: [
        { kind: 'registration', client: 'windsurf', channel: 'gmail', version: '0.1.0' },
        { kind: 'registration', client: 'codex', channel: 'telegram', version: '0.1.0' },
        { kind: 'registration', client: 'codex', channel: 'core', version: null },
        { kind: 'registration', client: '__proto__', channel: 'core', version: '0.1.0' },
      ],
    };
    expect(readUpdateCheck(odd)?.older).toEqual({});
    for (const bad of [null, [], 'behind', { behind: 'x' }, { latest: {} }]) expect(readUpdateCheck(bad)).toBeNull();
  });

  it('marks the older entry and says what it means for the app, in plain words', () => {
    const read = readChannels(channels, HOME, check());
    const code = read?.apps.find((row) => row.client === 'claude-code');
    expect(code?.cells.gmail).toEqual({ registered: true, ok: false, notes: ['older (0.31.0)'] });
    expect(code?.cells.core).toEqual({ registered: true, ok: true, notes: [] });
    expect(code?.older).toBe('Starts an older Agent Comms (0.31.0); this Mac has 0.32.0.');
    expect(read?.apps.find((row) => row.client === 'codex')?.older).toBeNull();
    // The newest version any entry starts: which Agent Comms the apps start.
    expect(read?.started).toBe('0.32.0');
    expect(readChannels(none, HOME)?.started).toBeNull();
  });

  it("says this Mac's version when the entry is older than it, and otherwise the latest", () => {
    expect(olderLine('0.30.0', '0.34.0', '0.34.0')).toBe('Starts an older Agent Comms (0.30.0); this Mac has 0.34.0.');
    expect(olderLine('0.33.0', '0.33.0', '0.34.0')).toBe('Starts an older Agent Comms (0.33.0); the latest is 0.34.0.');
    expect(olderLine('0.33.0', null, null)).toBe('Starts an older Agent Comms (0.33.0).');
  });
});

describe('a change to one app', () => {
  it('gives core one server on its own and several as a list, and names them as a person lists them', () => {
    expect(installServers(['gmail'])).toBe('gmail');
    expect(installServers(['core', 'gmail', 'events'])).toEqual(['core', 'gmail', 'events']);
    expect(serverNames(['gmail'])).toBe('Gmail');
    expect(serverNames(['gmail', 'slack'])).toBe('Gmail and Slack');
    expect(serverNames(['core', 'gmail', 'events'])).toBe('Core, Gmail and Events');
  });

  it('takes away the servers unticked and adds the ones ticked, each in the table order', () => {
    const code = app('claude-code');
    expect(changePlan(code, ['resend', 'core', 'events', 'whatsapp'])).toEqual({
      add: ['resend', 'whatsapp'],
      remove: ['gmail', 'slack'],
    });
    expect(changePlan(code, code.servers)).toEqual({ add: [], remove: [] });
    expect(changePlan(app('claude-desktop'), ['gmail'])).toEqual({ add: ['gmail'], remove: [] });
  });
});
