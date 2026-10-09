import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChannelEntries } from '../src/channel-manifest.ts';
import {
  CHANNEL_LABELS,
  CHANNEL_SERVERS,
  CHANNELS,
  channelManifest,
  channelServer,
  narrowingArgs,
  narrowingFromArgs,
} from '../src/channel-servers.ts';
import { CHANNEL_SNAPSHOT } from '../src/channels.generated.ts';
import { quoteCommand } from '../src/command-line.ts';
import type { RegisteredServer } from '../src/mcp-clients.ts';
import { type InstallOptions, isProductServer, managedRuntimeEntry, type SupportedClient } from '../src/mcp-install.ts';
import {
  describeOtherSlackServer,
  findOtherSlackServers,
  findUngatedGmailServers,
  gmailServerWarnings,
  otherSlackServerRemoval,
  slackServerWarnings,
} from '../src/other-servers.ts';
import * as golden from './fixtures/channel-servers-0.6.0.ts';

/*
 * The channel table is derived from each channel's manifest now (design 2026-09-26), and nothing a person sees may
 * change because of it: the flags a registration writes, what `--force` keeps, what a registration warns about and
 * which entries count as ours. So the derived table is held here to 0.6.0's hand-written one, kept verbatim in
 * `fixtures/channel-servers-0.6.0.ts`, over every combination the installer can be asked for.
 */

const CHANNEL_NAMES = ['core', 'gmail', 'slack'] as const;

test('the channels, their labels and their static facts are exactly the hand-written table’s', () => {
  // Every channel 0.6.0 had, in the order it had them; a channel added since sits among them and changes none of it.
  const golden060 = new Set<string>(golden.GOLDEN_CHANNELS);
  assert.deepEqual(
    CHANNELS.filter((channel) => golden060.has(channel)),
    [...golden.GOLDEN_CHANNELS],
  );
  assert.deepEqual(Object.fromEntries(Object.entries(CHANNEL_LABELS).filter(([channel]) => golden060.has(channel))), {
    ...golden.GOLDEN_CHANNEL_LABELS,
  });
  for (const channel of CHANNEL_NAMES) {
    const { serverArgs: _a, narrowingOf: _n, warnAbout: derivedWarn, ...derived } = CHANNEL_SERVERS[channel];
    const {
      serverArgs: _b,
      narrowingOf: _m,
      warnAbout: goldenWarn,
      ...expected
    } = golden.GOLDEN_CHANNEL_SERVERS[channel];
    assert.deepEqual(derived, expected, channel);
    assert.equal(typeof derivedWarn, typeof goldenWarn, `${channel} warns, or does not, as before`);
  }
});

/** Every value each narrowing option can take, including the ones that must write nothing. */
const PINS = [undefined, '', 'acme/gmail', 'acme/slack', 'wf/gmail-tech', 'odd value with spaces'];
const SWITCHES = [undefined, false, true];
const CLIENTS: SupportedClient[] = ['claude-code', 'json'];

function* everyOption(): Generator<InstallOptions> {
  for (const client of CLIENTS)
    for (const inbox of PINS)
      for (const workspace of PINS)
        for (const readOnly of SWITCHES) {
          yield {
            client,
            ...(inbox === undefined ? {} : { inbox }),
            ...(workspace === undefined ? {} : { workspace }),
            ...(readOnly === undefined ? {} : { readOnly }),
          };
        }
}

test('serverArgs: every flag combination writes the arguments it always wrote', () => {
  let checked = 0;
  for (const channel of CHANNEL_NAMES) {
    for (const options of everyOption()) {
      assert.deepEqual(
        CHANNEL_SERVERS[channel].serverArgs(options),
        golden.GOLDEN_CHANNEL_SERVERS[channel].serverArgs(options),
        `${channel} ${JSON.stringify(options)}`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, CHANNEL_NAMES.length * CLIENTS.length * PINS.length * PINS.length * SWITCHES.length);
});

test('narrowingOf: what an entry’s arguments carry reads back as before, and round-trips through serverArgs', () => {
  for (const channel of CHANNEL_NAMES) {
    const derived = CHANNEL_SERVERS[channel];
    const expected = golden.GOLDEN_CHANNEL_SERVERS[channel];
    for (const options of everyOption()) {
      const args = expected.serverArgs(options);
      assert.deepEqual(derived.narrowingOf(args), expected.narrowingOf(args), `${channel} ${JSON.stringify(args)}`);
      // Round trip: what is read back from an entry writes that entry's flags again.
      assert.deepEqual(derived.serverArgs({ client: 'json', ...derived.narrowingOf(args) }), args);
    }
    // Entries nobody wrote with this installer: a trailing flag, a repeated one, flags mixed with other words.
    for (const args of [
      [],
      ['mcp'],
      ['--inbox'],
      ['--workspace'],
      ['--inbox', 'a/gmail', '--inbox', 'b/gmail'],
      ['--workspace', 'a/slack', '--workspace', 'b/slack'],
      ['/opt/cli.mjs', 'mcp', '--read-only', '--inbox', 'x/gmail'],
      ['--inbox', '--read-only'],
      ['--workspace', '', '--read-only'],
      ['-y', '@agentcomms/slack@0.6.0', 'mcp', '--workspace', 'acme/slack'],
    ]) {
      assert.deepEqual(derived.narrowingOf(args), expected.narrowingOf(args), `${channel} ${JSON.stringify(args)}`);
    }
  }
});

test('narrowingOf reads a pin written as one argument, `--flag=value`, for every channel’s pin', () => {
  /*
   * Every server reads `--account=acme/resend` as `--account acme/resend` — Commander does, and so does
   * `agent-gmail-mcp` — but the pin was read back only in the two-argument form. So an entry pinned that way, by hand,
   * lost its pin on `mcp install --force` and on `comms_update`, whose preview said "not pinned … as now". 0.6.0 read
   * `--inbox=` and `--workspace=` the same way; this is the one place narrowingOf departs from it, on purpose.
   */
  let pinned = 0;
  for (const channel of CHANNELS) {
    const facts = channelServer(channel);
    const manifest = channelManifest(channel);
    for (const { option, flag, kind } of manifest?.narrowing ?? []) {
      if (kind !== 'pin') continue;
      pinned += 1;
      const value = `acme/${channel}`;
      assert.deepEqual(facts.narrowingOf([`${flag}=${value}`]), { [option]: value }, `${channel} ${flag}=`);
      assert.deepEqual(facts.narrowingOf(['mcp', `${flag}=${value}`, '--other']), { [option]: value });
      // Written back in the form every entry this installer writes has.
      assert.deepEqual(facts.serverArgs({ client: 'json', ...facts.narrowingOf([`${flag}=${value}`]) }), [flag, value]);
      // An empty value pins nothing, in either form; and the first pin given is the one read, in either form.
      assert.deepEqual(facts.narrowingOf([`${flag}=`]), {});
      assert.deepEqual(facts.narrowingOf([`${flag}=a/${channel}`, flag, `b/${channel}`]), { [option]: `a/${channel}` });
      assert.deepEqual(facts.narrowingOf([flag, `a/${channel}`, `${flag}=b/${channel}`]), { [option]: `a/${channel}` });
      // A longer flag that begins with this one is not it.
      assert.deepEqual(facts.narrowingOf([`${flag}s=${value}`]), {});
    }
  }
  assert.equal(pinned, CHANNELS.length - 1, 'every channel but the core has a pin');
  // `--read-only` takes no value: Commander refuses `--read-only=true` and `agent-gmail-mcp` ignores it, so no server
  // runs read-only from it, and it is not read as the switch.
  assert.deepEqual(CHANNEL_SERVERS.gmail.narrowingOf(['--read-only=true', '--inbox=x/gmail']), { inbox: 'x/gmail' });
});

/** A registered entry, as a client scan reports one. */
function entry(over: Partial<RegisteredServer> & Pick<RegisteredServer, 'name'>): RegisteredServer {
  return { client: 'cursor', path: '/cfg/.cursor/mcp.json', command: 'npx', args: [], scope: 'user', ...over };
}

/**
 * The entries the existing suites register, and the near misses around them: every rival package, scoped and bare;
 * other Slack servers found by name, command, argument or URL; and our own servers, which are never a rival.
 */
const FIXTURES: RegisteredServer[] = [
  entry({ name: 'old-gmail', args: ['-y', '@artymclabin/gmail-mcp'] }),
  entry({ name: 'gmail-old', client: 'claude-desktop', args: ['-y', '@artymclabin/gmail-mcp@1.2.3'] }),
  entry({ name: 'autoauth', args: ['@gongrzhe/server-gmail-autoauth-mcp'] }),
  entry({ name: 'bare-autoauth', client: 'claude-code', args: ['-y', 'server-gmail-autoauth-mcp'] }),
  entry({ name: 'bare-autoauth-command', client: 'codex', command: 'server-gmail-autoauth-mcp', args: [] }),
  entry({ name: 'not-autoauth', args: ['-y', '@someone/server-gmail-autoauth-mcp'] }),
  entry({ name: 'not-autoauth-either', args: ['-y', 'my-server-gmail-autoauth-mcp'] }),
  entry({ name: 'gmail', client: 'codex', args: ['-y', '@shinzolabs/gmail-mcp'], scope: 'project' }),
  entry({ name: 'unscoped-shinzo', args: ['-y', 'gmail-mcp'] }),
  entry({ name: 'notagentcomms', args: ['-y', '@notagentcomms/gmail-mcp'] }),
  entry({
    name: 'team-slack',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    packageName: '@modelcontextprotocol/server-slack',
    env: { SLACK_BOT_TOKEN: 'fake-bot-token-2' },
  }),
  entry({ name: 'official', command: '', args: [], url: 'https://mcp.slack.com/mcp', type: 'http' }),
  entry({ name: 'chat', command: '/usr/local/bin/SLACK-bridge', args: [] }),
  entry({ name: 'Slack Helper', command: 'node', args: ['/opt/helper.js'] }),
  entry({ name: 'relay', command: 'node', args: ['/opt/relay.js', '--to', 'slack'], scope: 'project' }),
  entry({ name: 'hermes-remote', command: 'node', args: ['/opt/hermes/bridge.js'] }),
  entry({ name: 'slack', client: 'claude-code', command: 'agent-slack', args: ['mcp', '--workspace', 'acme/slack'] }),
  entry({
    name: 'slack-managed',
    command: '/usr/bin/node',
    args: [managedRuntimeEntry('/data', '@agentcomms/slack', '0.6.0'), 'mcp'],
  }),
  entry({ name: 'slack-npx', args: ['-y', '@agentcomms/slack@0.6.0', 'mcp'], packageName: '@agentcomms/slack' }),
  entry({ name: 'slack-checkout', command: 'node', args: ['/src/agent-communications/packages/slack/src/cli.ts'] }),
  entry({ name: 'gmail-ours', command: 'agent-gmail-mcp', args: ['--inbox', 'acme/gmail'] }),
  entry({ name: 'agentcomms', args: ['-y', '@agentcomms/core@0.6.0', 'mcp'], packageName: '@agentcomms/core' }),
];

test('rival warnings: every channel warns about exactly the servers it warned about, in the same words', () => {
  for (const channel of CHANNEL_NAMES) {
    const derived = CHANNEL_SERVERS[channel].warnAbout?.(FIXTURES, 'darwin');
    const expected = golden.GOLDEN_CHANNEL_SERVERS[channel].warnAbout?.(FIXTURES);
    assert.deepEqual(derived, expected, channel);
    // One at a time as well, so an empty list on both sides cannot hide a fixture that matches nothing.
    for (const fixture of FIXTURES) {
      assert.deepEqual(
        CHANNEL_SERVERS[channel].warnAbout?.([fixture], 'darwin'),
        golden.GOLDEN_CHANNEL_SERVERS[channel].warnAbout?.([fixture]),
        `${channel}: ${fixture.name}`,
      );
    }
  }
  // The fixtures exercise both detectors: several rivals each, and several that are not.
  assert.equal(golden.gmailServerWarnings(FIXTURES).length, 6);
  assert.ok(golden.findOtherSlackServers(FIXTURES, golden.GOLDEN_CHANNEL_SERVERS.slack).length >= 5);
});

test('the doctors’ detectors, now read from the manifests, find and describe what they found before', () => {
  assert.deepEqual(findUngatedGmailServers(FIXTURES), golden.findUngatedGmailServers(FIXTURES));
  assert.deepEqual(gmailServerWarnings(FIXTURES), golden.gmailServerWarnings(FIXTURES));
  const product = golden.GOLDEN_CHANNEL_SERVERS.slack;
  assert.deepEqual(findOtherSlackServers(FIXTURES, product), golden.findOtherSlackServers(FIXTURES, product));
  assert.deepEqual(slackServerWarnings(FIXTURES, product), golden.slackServerWarnings(FIXTURES, product));
  for (const fixture of FIXTURES) {
    assert.equal(describeOtherSlackServer(fixture), golden.describeOtherSlackServer(fixture));
    assert.equal(otherSlackServerRemoval(fixture), golden.otherSlackServerRemoval(fixture));
  }
});

test('a command that removes another server gives its name as one word, quoted for the shell (CUE-306)', () => {
  // The hand-written table pasted the name in as it was: none of its fixtures has a space where a command is printed.
  for (const [client, binary] of [
    ['claude-code', 'claude'],
    ['codex', 'codex'],
  ] as const) {
    const helper = entry({ name: 'Slack Helper', client, command: 'node', args: ['/opt/helper.js'] });
    assert.equal(
      otherSlackServerRemoval(helper, 'darwin'),
      quoteCommand([binary, 'mcp', 'remove', 'Slack Helper'], 'darwin').line,
    );
    const rival = entry({ name: 'old gmail', client, args: ['-y', '@artymclabin/gmail-mcp'] });
    assert.equal(
      findUngatedGmailServers([rival], 'darwin')[0]?.removal,
      quoteCommand([binary, 'mcp', 'remove', 'old gmail'], 'darwin').line,
    );
  }
});

test('manifest-derived rival warnings render removal commands for the selected Windows shell', () => {
  const rival = entry({
    name: '$x&whoami&',
    client: 'claude-code',
    args: ['-y', '@artymclabin/gmail-mcp'],
  });
  const [warning] = CHANNEL_SERVERS.gmail.warnAbout?.([rival], 'win32') ?? [];
  assert.match(warning ?? '', /\["claude","mcp","remove","\\u0024x&whoami&"\].*command's words, written as JSON/);
  assert.doesNotMatch(warning ?? '', /claude mcp remove /);
});

test('a removal with a name Windows cannot print is shown as its words in JSON, never as a line (CUE-306)', () => {
  /*
   * A client's file may name an entry anything, and this is printed for a person to paste. Quoted for PowerShell, a
   * name like `$x&whoami&` came out as `'$x&whoami&'`, and pasted into cmd.exe it ran `whoami`; with a placeholder in
   * its place, `claude mcp remove NAME` removed whatever entry was called `NAME`.
   */
  const name = '$x&whoami&';
  for (const [client, binary] of [
    ['claude-code', 'claude'],
    ['codex', 'codex'],
  ] as const) {
    const helper = entry({ name, client, command: 'node', args: ['/opt/slack-helper.js'] });
    const rival = entry({ name, client, args: ['-y', '@artymclabin/gmail-mcp'] });
    for (const removal of [
      otherSlackServerRemoval(helper, 'win32'),
      findUngatedGmailServers([rival], 'win32')[0]?.removal,
    ]) {
      assert.equal(
        removal,
        `["${binary}","mcp","remove","\\u0024x&whoami&"] (the command's words, written as JSON: one of them cannot be quoted the same way for cmd.exe and for PowerShell, so type the command yourself, with that word quoted for the shell you use)`,
      );
      assert.doesNotMatch(String(removal), /mcp remove /, 'and no line to run');
    }
    // A POSIX shell takes it in single quotes, whole.
    assert.equal(otherSlackServerRemoval(helper, 'linux'), `${binary} mcp remove '${name}'`);
    assert.equal(findUngatedGmailServers([rival], 'darwin')[0]?.removal, `${binary} mcp remove '${name}'`);
  }
});

test('isProductServer: the same entries are ours, for every channel', () => {
  const near: RegisteredServer[] = [
    ...FIXTURES,
    entry({ name: 'evil', command: 'node', args: ['/opt/node_modules/@agentcomms/slack-evil/dist/cli.mjs'] }),
    entry({ name: 'evil-bin', command: 'agent-slack-evil', args: ['mcp'] }),
    entry({ name: 'npx-bare', args: ['-y', 'agent-slack', 'mcp'] }),
    entry({ name: 'win', command: 'C:\\tools\\npm\\agent-slack.cmd', args: ['mcp'] }),
    entry({ name: 'gmail-lib', command: 'node', args: ['/opt/node_modules/@agentcomms/gmail/dist/index.mjs'] }),
    entry({
      name: 'gmail-mcp-entry',
      command: 'node',
      args: ['/opt/node_modules/@agentcomms/gmail-mcp/dist/server.mjs'],
    }),
    entry({ name: 'gmail-cli', command: 'node', args: ['/r/packages/gmail/src/cli.ts'] }),
    entry({ name: 'gmail-nested', command: 'node', args: ['/r/packages/gmail/src/nested/cli.ts'] }),
    entry({ name: 'core-cli', command: 'node', args: ['/r/packages/core/dist/cli.mjs', 'mcp'] }),
    entry({ name: 'url-only', command: '', args: [] }),
  ];
  for (const channel of CHANNEL_NAMES) {
    for (const server of near) {
      assert.equal(
        isProductServer(server, CHANNEL_SERVERS[channel]),
        isProductServer(server, golden.GOLDEN_CHANNEL_SERVERS[channel]),
        `${channel}: ${server.name}`,
      );
    }
  }
});

// ── The manifests themselves ─────────────────────────────────────────────────────────────────────────────────────

const valid = () => structuredClone(CHANNEL_SNAPSHOT.map(({ packageName, manifest }) => ({ packageName, manifest })));

test('the snapshot is a valid set of manifests, and narrowing is read off its data', () => {
  assert.deepEqual(parseChannelEntries(valid()), CHANNEL_SNAPSHOT);
  const gmail = channelManifest('gmail');
  assert.ok(gmail);
  assert.deepEqual(narrowingArgs(gmail, { client: 'json', inbox: 'a/gmail', readOnly: true }), [
    '--inbox',
    'a/gmail',
    '--read-only',
  ]);
  assert.deepEqual(narrowingFromArgs(gmail, ['--read-only']), { readOnly: true });
  assert.equal(channelManifest('discord'), undefined);
});

test('D4: each event source manifest has strict typed event metadata and an explicit credential kind', () => {
  const expected = {
    gmail: {
      types: ['gmail.message.received', 'gmail.message.sent', 'gmail.message.labelled'],
      minimumIntervalMs: 60_000,
      access: { kind: 'oauth-user', requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    },
    slack: {
      types: ['slack.message.posted'],
      minimumIntervalMs: 60_000,
      access: {
        kind: 'oauth-user',
        requiredScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
      },
    },
    resend: {
      types: ['resend.email.received', 'resend.email.status_changed'],
      minimumIntervalMs: 60_000,
      access: { kind: 'resend-full-access' },
    },
    whatsapp: {
      types: ['whatsapp.message.received'],
      minimumIntervalMs: 60_000,
      access: { kind: 'local-store' },
    },
  } as const;
  for (const [channel, events] of Object.entries(expected)) {
    assert.deepEqual(channelManifest(channel)?.events, events, channel);
  }

  const cases: ReadonlyArray<readonly [string, (events: Record<string, unknown>) => void, RegExp]> = [
    ['an unknown key', (events) => (events.extra = true), /events.*extra|Unrecognized key/i],
    ['a zero interval', (events) => (events.minimumIntervalMs = 0), /minimumIntervalMs/i],
    ['a non-integer interval', (events) => (events.minimumIntervalMs = 1.5), /minimumIntervalMs/i],
    ['no types', (events) => (events.types = []), /types/i],
    ['empty OAuth scopes', (events) => (events.access = { kind: 'oauth-user', requiredScopes: [] }), /requiredScopes/i],
    [
      'an incompatible access kind',
      (events) => (events.access = { kind: 'local-store', requiredScopes: ['channels:history'] }),
      /access|requiredScopes/i,
    ],
  ];
  for (const [what, edit, expectedError] of cases) {
    assert.match(
      problemsAfter((entries) => {
        const events = structuredClone(at(entries, 'slack').events) as Record<string, unknown>;
        edit(events);
        at(entries, 'slack').events = events;
      }),
      expectedError,
      what,
    );
  }
});

/** The problems `parseChannelEntries` reports after `edit` is applied to the committed manifests. */
function problemsAfter(edit: (entries: ReturnType<typeof valid>) => void): string {
  const entries = valid();
  edit(entries);
  try {
    parseChannelEntries(entries);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

/** A manifest by channel, writable. */
type Writable = Record<string, unknown> &
  Record<'server' | 'rivals' | 'skills', Record<string, unknown>> & {
    accounts?: Record<string, unknown>;
    narrowing: unknown[];
  };
const at = (entries: ReturnType<typeof valid>, channel: string): Writable =>
  entries.find((e) => e.manifest.channel === channel)?.manifest as unknown as Writable;

test('a manifest is refused for what would make a server, a pin or a skill mean something else', () => {
  const cases: [string, (entries: ReturnType<typeof valid>) => void, RegExp][] = [
    [
      'an unknown key',
      (e) => {
        at(e, 'slack').extra = 1;
      },
      /agentcomms: .*extra|Unrecognized key/,
    ],
    [
      'a mode outside the vocabulary',
      (e) => {
        (at(e, 'slack').accounts as Record<string, unknown>).modes = ['read', 'post'];
      },
      /modes/,
    ],
    [
      'modes out of order',
      (e) => {
        (at(e, 'slack').accounts as Record<string, unknown>).modes = ['send', 'read'];
      },
      /narrow to wide/,
    ],
    [
      'a channel with no pin',
      (e) => {
        at(e, 'slack').narrowing = [];
      },
      /exactly one pin/,
    ],
    [
      'a channel with two pins',
      (e) => void at(e, 'slack').narrowing.push({ option: 'account', flag: '--account', kind: 'pin' }),
      /exactly one pin/,
    ],
    [
      'readOnly as a pin',
      (e) => {
        at(e, 'gmail').narrowing = [{ option: 'readOnly', flag: '--read-only', kind: 'pin' }];
      },
      /one switch/,
    ],
    [
      'a word rival with nothing it can do',
      (e) => {
        delete at(e, 'slack').rivals.can;
      },
      /come together/,
    ],
    [
      'a channel with no accounts',
      (e) => {
        delete at(e, 'slack').accounts;
      },
      /accounts: every channel says this/,
    ],
    [
      'a channel that does not say which hosts it reaches',
      (e) => {
        delete at(e, 'slack').hosts;
      },
      /hosts: every channel says this/,
    ],
    [
      'a host that is not a host name',
      (e) => {
        at(e, 'slack').hosts = ['https://slack.com/api'];
      },
      /hosts\.0: a host name/,
    ],
    [
      'a core with accounts',
      (e) => {
        at(e, 'core').accounts = at(e, 'slack').accounts ?? {};
      },
      /core connects no account/,
    ],
    [
      'an approve that is not its own',
      (e) => {
        at(e, 'slack').approve = 'agent-gmail approve';
      },
      /own command/,
    ],
    [
      'a contract its prefix does not choose',
      (e) => {
        at(e, 'slack').skills.contract = 'skills/_shared/contract-gmail.md';
      },
      /chosen by its prefix/,
    ],
    [
      'another suite’s package',
      (e) => {
        at(e, 'slack').server.npxPackage = 'slack-mcp';
      },
      /this suite/,
    ],
    [
      'a channel word that is not a platform word',
      (e) => {
        at(e, 'slack').channel = 'Slack';
      },
      /platform word/,
    ],
    [
      // Two channels of the generic shape: Gmail renamed to `slack` is refused for its shape before it can collide.
      'a second whatsapp',
      (e) => {
        at(e, 'resend').channel = 'whatsapp';
      },
      /channel "whatsapp" is @agentcomms\/resend's too/,
    ],
    [
      'a shared binary',
      (e) => {
        at(e, 'slack').binary = 'agent-gmail';
        at(e, 'slack').approve = 'agent-gmail approve';
      },
      /binary "agent-gmail"/,
    ],
    [
      'a shared server name',
      (e) => {
        at(e, 'slack').server.defaultName = 'gmail';
      },
      /server name "gmail"/,
    ],
    [
      'a shared skill prefix',
      (e) => {
        at(e, 'slack').skills = { prefix: 'gmail-', contract: 'skills/_shared/contract-gmail.md' };
      },
      /skill prefix "gmail-"/,
    ],
    ['no core', (e) => void e.splice(0, 1), /core's manifest appears 0 times/],
    [
      'a contract version this release does not read',
      (e) => {
        at(e, 'slack').contract = 2;
      },
      /contract/,
    ],
  ];
  for (const [what, edit, expected] of cases) assert.match(problemsAfter(edit), expected, what);
});

test('only Gmail and Slack keep the shapes they had before the manifest; every other channel is `accounts`, `--account` and `agent-*`', () => {
  /*
   * Gmail's accounts are in `inboxes` and its server is pinned by `--inbox` and narrowed by `--read-only`; Slack's is
   * pinned by `--workspace`. Both are kept only because entries, tools and skills already say them. A new channel that
   * borrowed either shape passed, and the core then treated its accounts as mailboxes — checking its pin against the
   * inbox map — or wrote Slack's flag for it. So each exception is Gmail's or Slack's by name, and nobody else's.
   */
  const cases: [string, (entries: ReturnType<typeof valid>) => void, RegExp][] = [
    [
      'a new channel keeping its accounts in inboxes',
      (e) => {
        (at(e, 'resend').accounts as Record<string, unknown>).map = 'inboxes';
      },
      /@agentcomms\/resend: agentcomms\.accounts\.map: `inboxes` is Gmail's alone/,
    ],
    [
      'Slack keeping its accounts in inboxes',
      (e) => {
        (at(e, 'slack').accounts as Record<string, unknown>).map = 'inboxes';
      },
      /@agentcomms\/slack: agentcomms\.accounts\.map: `inboxes` is Gmail's alone/,
    ],
    [
      'Gmail moving its mailboxes to accounts',
      (e) => {
        (at(e, 'gmail').accounts as Record<string, unknown>).map = 'accounts';
      },
      /@agentcomms\/gmail: agentcomms\.accounts\.map: Gmail's mailboxes are in `inboxes`/,
    ],
    [
      'a new channel pinned by --inbox',
      (e) => {
        at(e, 'resend').narrowing = [{ option: 'inbox', flag: '--inbox', kind: 'pin' }];
      },
      /@agentcomms\/resend: agentcomms\.narrowing: .*pinned by `account` \/ `--account` and nothing else/,
    ],
    [
      'a new channel pinned by --workspace',
      (e) => {
        at(e, 'resend').narrowing = [{ option: 'workspace', flag: '--workspace', kind: 'pin' }];
      },
      /@agentcomms\/resend: agentcomms\.narrowing: .*pinned by `account` \/ `--account` and nothing else/,
    ],
    [
      'a new channel with the generic pin under another flag',
      (e) => {
        at(e, 'resend').narrowing = [{ option: 'account', flag: '--acct', kind: 'pin' }];
      },
      /@agentcomms\/resend: agentcomms\.narrowing: .*`--account` and nothing else/,
    ],
    [
      'a new channel with Gmail’s read-only switch',
      (e) => void at(e, 'resend').narrowing.push({ option: 'readOnly', flag: '--read-only', kind: 'switch' }),
      /@agentcomms\/resend: agentcomms\.narrowing: .*and nothing else/,
    ],
    [
      'Slack pinned by the generic flag',
      (e) => {
        at(e, 'slack').narrowing = [{ option: 'account', flag: '--account', kind: 'pin' }];
      },
      /@agentcomms\/slack: agentcomms\.narrowing: Slack's server is pinned by `workspace` \/ `--workspace`/,
    ],
    [
      'Slack with Gmail’s read-only switch',
      (e) => void at(e, 'slack').narrowing.push({ option: 'readOnly', flag: '--read-only', kind: 'switch' }),
      /@agentcomms\/slack: agentcomms\.narrowing: Slack's server/,
    ],
    [
      'Gmail pinned by --workspace',
      (e) => {
        at(e, 'gmail').narrowing = [
          { option: 'workspace', flag: '--workspace', kind: 'pin' },
          { option: 'readOnly', flag: '--read-only', kind: 'switch' },
        ];
      },
      /@agentcomms\/gmail: agentcomms\.narrowing: Gmail's server is pinned by `inbox` \/ `--inbox`/,
    ],
    [
      'a new channel whose command is not agent-*',
      (e) => {
        at(e, 'resend').binary = 'teams';
        at(e, 'resend').approve = 'teams approve';
      },
      /@agentcomms\/resend: agentcomms\.binary: a channel's command is `agent-<something>`/,
    ],
    [
      'another command for a channel that is not agent-*',
      (e) => {
        at(e, 'gmail').server.bins = ['gmail-mcp-server'];
      },
      /@agentcomms\/gmail: agentcomms\.server\.bins\.0: a channel's command is `agent-<something>`/,
    ],
    [
      'a core whose command is not agentcomms',
      (e) => {
        at(e, 'core').binary = 'agent-core';
        at(e, 'core').approve = 'agent-core approve';
      },
      /@agentcomms\/core: agentcomms\.binary: is not the core's own command name/,
    ],
  ];
  for (const [what, edit, expected] of cases) assert.match(problemsAfter(edit), expected, what);
  assert.equal(
    problemsAfter(() => undefined),
    '',
    'the committed manifests pass',
  );
});

test('a channel that reaches no host says so with an empty list, and must still say it', () => {
  // WhatsApp reads a file on this Mac: `[]` is its honest answer, and the strictest a later transport could hold.
  assert.deepEqual(channelManifest('whatsapp')?.hosts, []);
  assert.equal(
    problemsAfter((e) => {
      at(e, 'slack').hosts = [];
    }),
    '',
    'an empty list is a valid answer',
  );
});

test('a channel says how the unsent report groups its approvals with one of two rules, or not at all; the core says nothing (R16d)', () => {
  // Design 2026-10-05 §D9: `draft` (mailbox or account, and draft) or `draft-revision-digest` (and the exact revision
  // and content digest). Anything else is refused by the schema, never read as no rule.
  for (const value of ['thread', '', 'Draft', 'draft revision digest', 'draft-revision', 3, null, ['draft'], {}]) {
    assert.match(
      problemsAfter((e) => {
        at(e, 'gmail').approvalGrouping = value;
      }),
      /@agentcomms\/gmail: agentcomms\.approvalGrouping: /,
      JSON.stringify(value),
    );
  }
  assert.match(
    problemsAfter((e) => {
      at(e, 'core').approvalGrouping = 'draft';
    }),
    /@agentcomms\/core: agentcomms\.approvalGrouping: the core sends nothing, so it groups no approvals/,
  );
  for (const value of ['draft', 'draft-revision-digest']) {
    assert.equal(
      problemsAfter((e) => {
        at(e, 'whatsapp').approvalGrouping = value;
      }),
      '',
      value,
    );
  }
  assert.equal(
    problemsAfter((e) => {
      delete at(e, 'slack').approvalGrouping;
    }),
    '',
    'a channel may declare none',
  );
});

test("a registration's pinned folders never make it another server for that service (CUE-403)", () => {
  /*
   * Every registration the installer writes carries its four suite folders, and a folder may be named anything: a
   * Gmail entry pinned under `/work/slack-bot` was "another Slack server", and one under a folder named like a rival
   * package was that rival. The folders are taken out before the service's word or a rival's name is looked for.
   */
  const gmail = entry({
    name: 'gmail',
    client: 'claude-code',
    command: '/usr/bin/node',
    args: [
      '/data/runtime/0.13.0-gmail/node_modules/@agentcomms/gmail/dist/cli.mjs',
      '--config-dir',
      '/work/slack-bot/config',
      '--state-dir=/work/@shinzolabs/gmail-mcp/state',
      'mcp',
    ],
  });
  assert.deepEqual(findOtherSlackServers([gmail], CHANNEL_SERVERS.slack), []);
  assert.deepEqual(findUngatedGmailServers([gmail], 'linux'), []);
  // The service's word, or a rival's name, in the entry's own words still counts.
  const helper = entry({ name: 'helper', command: 'node', args: ['/opt/slack-helper.js', '--config-dir', '/x'] });
  assert.deepEqual(
    findOtherSlackServers([helper], CHANNEL_SERVERS.slack).map((server) => server.name),
    ['helper'],
  );
  const rival = entry({ name: 'rival', args: ['--config-dir', '/x', '-y', '@shinzolabs/gmail-mcp'] });
  assert.deepEqual(
    findUngatedGmailServers([rival], 'linux').map((finding) => finding.name),
    ['rival'],
  );
});
