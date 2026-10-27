// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { connectionOfSession, readSessions, readTimeline, runnerOf } from '../activity.ts';
import { CONNECTIONS_VERSION, GATES } from '../gates.ts';
import { CONNECTION_APPS } from '../ipc.ts';
import {
  CONNECTION_APP_LABELS,
  countLine,
  grantsFor,
  nameProblem,
  partChips,
  partLine,
  partsNow,
  partsRequest,
  readAccountChoices,
  readAdded,
  readConnectionList,
  readMigrated,
  readPartChoices,
  readReplaced,
  readShownConnection,
  samePlace,
  startingParts,
  statusOf,
  whereLong,
  whereShort,
  wholeFolder,
} from '../mcp-connections.ts';
import channels from './fixtures/channels.connections.json';
import list from './fixtures/connection-list.json';
import shown from './fixtures/connection-show.json';
import label from './fixtures/label.connections.json';

const HOME = '/example/home';

const views = () => {
  const read = readConnectionList(list);
  if (read === null) throw new Error('the fixture is a connection list');
  return read.connections;
};
const view = (name: string) => {
  const found = views().find((each) => each.name === name);
  if (found === undefined) throw new Error(`no connection ${name}`);
  return found;
};
const choices = () => {
  const read = readPartChoices(channels);
  if (read === null) throw new Error('the fixture is a channels report');
  return read;
};

describe("MCP connections, from core's connection list (single-server design §11)", () => {
  it('is gated on core 0.35.0, and knows core’s seven apps', () => {
    expect(GATES.connections).toBe('0.35.0');
    expect(CONNECTIONS_VERSION).toBe('0.35.0');
    expect(CONNECTION_APPS).toEqual(['claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini', 'vscode', 'manual']);
    expect(Object.keys(CONNECTION_APP_LABELS)).toEqual([...CONNECTION_APPS]);
  });

  it('reads every connection field by field, and never a key: core gives none', () => {
    const read = views();
    expect(read.map((each) => each.name)).toEqual([
      'Work — Claude Code',
      'Acme site — Claude Code',
      'Personal — Claude Desktop',
      'Reviews — Codex',
      'Raycast',
    ]);
    const work = view('Work — Claude Code');
    expect(work.app).toBe('claude-code');
    expect(work.entry).toEqual({
      name: 'agentcomms',
      path: '/example/home/.claude.json',
      present: true,
      keyMatches: true,
    });
    expect(work.parts.map((part) => [part.server, part.account, part.readOnly])).toEqual([
      ['core', null, false],
      ['gmail', 'acme/gmail', false],
      ['slack', null, false],
      ['events', null, false],
    ]);
    expect(JSON.stringify(read)).not.toMatch(/ack_|keyHash|sha256/);
    // One with an id core would not make is left out: nothing could act on it.
    const odd = readConnectionList({ connections: [{ id: 'cn_short', name: 'x' }, list.connections[0]], problems: [] });
    expect(odd?.connections.map((each) => each.id)).toEqual([list.connections[0]?.id]);
    expect(readConnectionList({ nope: true })).toBeNull();
  });

  it('says where each is, in a few words and in a sentence, with the home as ~', () => {
    expect(views().map((each) => whereShort(each, HOME))).toEqual([
      'Claude Code · every folder',
      'Claude Code · project ~/work/acme-site',
      'Claude Desktop',
      'Codex · home ~/.codex-reviews',
      'Manual · a snippet you paste',
    ]);
    expect(whereLong(view('Acme site — Claude Code'), HOME)).toBe('One project: ~/work/acme-site');
    expect(whereLong(view('Reviews — Codex'), HOME)).toBe('Another Codex home: ~/.codex-reviews');
    expect(whereLong(view('Raycast'), HOME)).toContain('Agent Comms can’t see them');
  });

  it('chips each part but Agent Comms itself, and says when a connection has no Agent Comms itself', () => {
    expect(partChips(view('Work — Claude Code'))).toEqual(['Gmail · only acme/gmail', 'Slack', 'Events']);
    expect(partChips(view('Acme site — Claude Code'))).toEqual(['Gmail · read-only']);
    expect(partChips(view('Personal — Claude Desktop'))).toEqual([
      'Gmail · only personal/gmail',
      'WhatsApp · only old/whatsapp · not started',
    ]);
    // Made at a terminal without core: shown truthfully, not hidden (lead's decision, 2026-10-27).
    expect(partChips(view('Reviews — Codex'))).toEqual(['Gmail · read-only', 'Without Agent Comms itself']);
    expect(partLine(view('Work — Claude Code').parts[1] ?? never())).toEqual({
      name: 'Gmail',
      detail: 'only acme/gmail · can draft, and prepare mail that waits for your yes',
    });
    expect(partLine(view('Acme site — Claude Code').parts[1] ?? never())).toEqual({
      name: 'Gmail',
      detail: 'every account · read and search only',
    });
  });

  it('says how each stands, from its entry, its key and its last use', () => {
    const words = views().map((each) => [statusOf(each, HOME).tone, statusOf(each, HOME).word]);
    expect(words).toEqual([
      ['ok', 'Connected'],
      ['warn', 'Open the project in Claude Code to finish'],
      ['warn', 'Its entry has an old key'],
      ['ok', 'Connected'],
      ['idle', 'Not used yet'],
    ]);
    const work = view('Work — Claude Code');
    expect(statusOf({ ...work, key: { issuedAt: null, revoked: true } }, HOME).word).toBe('Cut off');
    expect(statusOf({ ...work, readable: false }, HOME).tone).toBe('danger');
    expect(statusOf({ ...work, entry: { ...(work.entry ?? never()), present: false } }, HOME).word).toBe(
      'Not in Claude Code’s settings',
    );
    expect(statusOf({ ...work, lastUsed: null }, HOME).word).toBe('Restart Claude Code to finish');
    // What `connection show` says runs for it now comes before its last use.
    const running = readShownConnection(shown)?.running ?? never();
    expect(statusOf(work, HOME, running)).toMatchObject({ tone: 'ok', word: 'Running now' });
    expect(statusOf(work, HOME, [{ ...(running[0] ?? never()), refused: 'its key is not the connection’s' }])).toEqual({
      tone: 'warn',
      word: 'Running, but serving nothing',
      line: 'its key is not the connection’s',
    });
  });

  it('reads what runs for a connection now, part by part', () => {
    const read = readShownConnection(shown);
    expect(read?.running).toHaveLength(1);
    expect(read?.running[0]?.client).toBe('claude-code');
    expect(read?.running[0]?.parts.map((part) => [part.server, part.state])).toEqual([
      ['core', 'running'],
      ['gmail', 'running'],
      ['slack', 'restarting'],
      ['events', 'running'],
    ]);
  });

  it('tells two connections in one place apart from two in different places', () => {
    const work = view('Work — Claude Code');
    const site = view('Acme site — Claude Code');
    expect(samePlace(work, { app: 'claude-code', where: { scope: 'user', folder: null, configDir: null } })).toBe(true);
    expect(samePlace(work, site)).toBe(false);
    expect(samePlace(site, { app: 'claude-code', where: { ...(site.where ?? never()) } })).toBe(true);
    expect(samePlace(view('Raycast'), view('Raycast'))).toBe(false);
    expect(countLine(views())).toBe('5 connections, in 4 apps');
  });
});

describe('the parts a connection can have (D20) and the accounts each can be kept to', () => {
  it('takes the parts from channels, in core’s order, and finds the entries outside any connection', () => {
    const read = choices();
    expect(read.parts.map((part) => [part.server, part.name, part.kind])).toEqual([
      ['core', 'Agent Comms itself', 'channel'],
      ['gmail', 'Gmail', 'channel'],
      ['resend', 'Resend', 'channel'],
      ['slack', 'Slack', 'channel'],
      ['whatsapp', 'WhatsApp', 'channel'],
      ['events', 'Events', 'service'],
    ]);
    // Cursor's two entries stand on their own; Claude Code's are its connection's parts.
    expect(read.standalone).toEqual([
      { client: 'cursor', server: 'core' },
      { client: 'cursor', server: 'gmail' },
    ]);
    // A channel a later release adds needs no edit here: core's label names it.
    const later = readPartChoices({ channels: [{ channel: 'teams', kind: 'channel', label: 'Microsoft Teams' }] });
    expect(later?.parts).toEqual([{ server: 'teams', name: 'Microsoft Teams', kind: 'channel' }]);
    expect(readPartChoices({ channels: [{ channel: '--parts', kind: 'channel' }] })?.parts).toEqual([]);
  });

  it('starts a new connection with Agent Comms itself, each channel with an account, and Events when it is here', () => {
    const accounts = readAccountChoices(label) ?? never();
    const start = startingParts(choices().parts, accounts, true);
    expect(
      Object.entries(start)
        .filter(([, setting]) => setting.on)
        .map(([server]) => server),
    ).toEqual(['core', 'gmail', 'resend', 'slack', 'whatsapp', 'events']);
    expect(startingParts(choices().parts, [], false).core?.on).toBe(true);
    expect(startingParts(choices().parts, [], false).events?.on).toBe(false);
  });

  it('asks for exactly the parts that are on, with an account and read-only only where set and possible', () => {
    const settings = startingParts(choices().parts, readAccountChoices(label) ?? never(), false);
    settings.gmail = { on: true, account: 'acme/gmail', readOnly: true };
    settings.slack = { on: true, account: null, readOnly: true };
    settings.resend = { on: false, account: null, readOnly: false };
    expect(partsRequest(choices().parts, settings)).toEqual([
      { server: 'core' },
      { server: 'gmail', account: 'acme/gmail', readOnly: true },
      // Slack has no read-only switch: core refuses one, so none is asked for.
      { server: 'slack' },
      { server: 'whatsapp' },
    ]);
  });

  it('starts a connection’s editor from what it has, keeping a part the channels do not list', () => {
    const now = partsNow(choices().parts, view('Reviews — Codex'));
    expect(now.core?.on).toBe(false);
    expect(now.gmail).toEqual({ on: true, account: null, readOnly: true });
    const odd = {
      ...view('Reviews — Codex'),
      parts: [
        ...view('Reviews — Codex').parts,
        { server: 'teams', label: 'Teams', account: null, readOnly: false, available: true, why: null },
      ],
    };
    expect(partsRequest(choices().parts, partsNow(choices().parts, odd))).toEqual([
      { server: 'gmail', readOnly: true },
      { server: 'teams' },
    ]);
  });

  it('says what a connection would let agents do, part by part', () => {
    const grants = grantsFor(
      [
        { server: 'core' },
        { server: 'gmail', readOnly: true },
        { server: 'slack', account: 'acme/slack' },
        { server: 'teams' },
      ],
      (server) => (server === 'gmail' ? ['acme/gmail', 'personal/gmail'] : []),
      (server) => (server === 'teams' ? 'Teams' : server),
    );
    expect(grants).toEqual([
      'check how Agent Comms is set up, and ask you to approve a change',
      'read and search mail in acme/gmail and personal/gmail',
      'read channels and threads in acme/slack',
      'prepare a post, a reply or a reaction, which goes only after your yes',
      'use Teams’s tools',
    ]);
  });
});

describe('what a change comes back with', () => {
  it('reads a Manual addition’s snippets, and an addition’s check', () => {
    const added = readAdded({
      connection: list.connections[4],
      next: 'Paste the snippet…',
      snippets: { json: '{"mcpServers":{}}\n', toml: '[mcp_servers.agentcomms]\n', vscode: '{"servers":{}}\n' },
    });
    expect(added.connection?.name).toBe('Raycast');
    expect(added.snippets).toEqual({
      json: '{"mcpServers":{}}\n',
      toml: '[mcp_servers.agentcomms]\n',
      vscode: '{"servers":{}}\n',
    });
    expect(
      readAdded({ connection: list.connections[0], verification: 'failed', verifyDetail: 'no tools' }),
    ).toMatchObject({
      snippets: null,
      verification: 'failed',
      verifyDetail: 'no tools',
    });
    // A snippet missing one format is no snippet: the screen shows none rather than a part of one.
    expect(readReplaced({ snippets: { json: '{}' } }).snippets).toBeNull();
  });

  it('reads a migration: each connection made, each entry left, and what to do next', () => {
    expect(
      readMigrated({
        migrated: [
          { id: list.connections[0]?.id, name: 'Claude Code', app: 'claude-code', replaced: 3, backups: [] },
          { id: 'nope', name: 'x' },
        ],
        left: [{ client: 'cursor', name: 'gmail', path: '/example/home/.cursor/mcp.json', why: 'a second Gmail' }],
        next: ['Restart each app once.'],
      }),
    ).toEqual({
      migrated: [{ id: list.connections[0]?.id, name: 'Claude Code', app: 'claude-code', replaced: 3 }],
      left: [{ name: 'gmail', path: '/example/home/.cursor/mcp.json', why: 'a second Gmail' }],
      next: ['Restart each app once.'],
    });
  });
});

describe('what the person types', () => {
  it('takes a folder written whole, with ~ for the home, and refuses anything else', () => {
    expect(wholeFolder('~/work/acme-site', HOME)).toBe('/example/home/work/acme-site');
    expect(wholeFolder(' /example/home/work/acme-site ', HOME)).toBe('/example/home/work/acme-site');
    expect(wholeFolder('D:\\work\\acme-site', HOME)).toBe('D:\\work\\acme-site');
    for (const bad of [
      '',
      'work/acme',
      '/',
      '/example/home/',
      '/a//b',
      '/a/../b',
      '/a/./b',
      '~x',
      'C:\\',
      'C:\\a/b',
      '/a\u202Eb',
    ]) {
      expect(wholeFolder(bad, HOME)).toBeNull();
    }
    expect(wholeFolder('~/work', null)).toBeNull();
  });

  it('says what is wrong with a name, by core’s rule', () => {
    expect(nameProblem('Work — Claude Code')).toBeNull();
    expect(nameProblem('')).toContain('Give it a name');
    expect(nameProblem(' Work')).toContain('space');
    expect(nameProblem('-Work')).toContain('“-”');
    expect(nameProblem('x'.repeat(65))).toContain('64');
    expect(nameProblem('Work\nCode')).toContain('line breaks');
    expect(nameProblem('Work “Code”')).toContain('quotation');
    // A name that imitates the label a preview gives it (0.35.0 re-review, LOW 6).
    for (const name of ['Everywhere) (Claude Code, every folder, cn_0MCZ…', 'Work (x', 'Work)', 'Work…']) {
      expect(nameProblem(name)).toBe('A name has no brackets or “…”: a preview puts its app, place and id there.');
    }
  });
});

describe('Activity says which connection a session came through (§7)', () => {
  const session = {
    key: '3f9a1c2e7b4d5a60',
    grouped: true,
    surfaces: ['mcp'],
    folder: '/example/home/work/acme-site',
    folderShown: '~/work/acme-site',
    client: { name: 'claude-code', version: '2.3.0' },
    firstSeen: '2026-10-27T10:00:00.000Z',
    lastSeen: '2026-10-27T10:42:00.000Z',
    processes: 2,
    channels: ['gmail'],
    accounts: ['acme/gmail'],
    counts: { kind: { read: 3 }, outcome: { ok: 3 } },
  };
  const named = { id: 'cn_01JB8Y3K7Q2M9XRF84TZWP8C5D', name: 'Work — Claude Code' };

  it('says "Used by" the connection a session names, and the client as it said otherwise', () => {
    const plain = readSessions({ since: null, sessions: [session] })?.sessions[0] ?? never();
    expect(runnerOf(plain)).toEqual({ said: 'claude-code 2.3.0', asTheClientSays: true });
    const through =
      readSessions({ since: null, sessions: [{ ...session, connection: named }] })?.sessions[0] ?? never();
    expect(runnerOf(through)).toEqual({ said: 'Used by Work — Claude Code', asTheClientSays: false });
    // One whose id is not a connection's is read as none.
    const odd = readSessions({ since: null, sessions: [{ ...session, connection: { id: 'x', name: 'Work' } }] })
      ?.sessions[0];
    expect(odd?.connection).toBeNull();
  });

  it('takes the connection from the newest line of a timeline when the session does not name one', () => {
    const line = (at: string, connection?: unknown) => ({
      at,
      channel: 'gmail',
      account: { id: 'ibx_1', alias: 'acme/gmail' },
      operation: 'gmail.search',
      kind: 'read',
      outcome: 'ok',
      session: { key: session.key, ...(connection === undefined ? {} : { connection }) },
    });
    const timeline = readTimeline({
      session,
      lines: [
        line('2026-10-27T10:00:00.000Z'),
        line('2026-10-27T10:40:00.000Z', named),
        line('2026-10-27T10:10:00.000Z', { id: named.id, name: 'Old name' }),
      ],
    });
    if (timeline === null) throw new Error('a timeline');
    expect(connectionOfSession(timeline.session, timeline.lines)).toEqual(named);
    expect(connectionOfSession(timeline.session, [])).toBeNull();
  });
});

function never(): never {
  throw new Error('the fixture has it');
}
