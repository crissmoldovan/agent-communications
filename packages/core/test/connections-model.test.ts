import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Config, changedSettings, classifyChange, emptyConfig } from '../src/config.ts';
import {
  type ConnectionRecord,
  connectionKeyHash,
  connectionKeyMatches,
  connectionNameProblem,
  connectionReach,
  newConnectionId,
  newConnectionKey,
  readConnections,
  storedConnection,
  withConnection,
} from '../src/connections.ts';
import { openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The connection model (single-server design §6, D9–D12): read strictly, as reaching less wherever it cannot be read,
 * and judged by `classifyChange` — every loosening in §6.2 waits for the person, every tightening applies at once.
 */

const MAIL = { id: 'ibx_AAAAAAAAAAAAAAAA', alias: 'cue/gmail' };
const OTHER_MAIL = { id: 'ibx_BBBBBBBBBBBBBBBB', alias: 'wf/gmail' };
const KEY = newConnectionKey();

function record(over: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: 'cn_0123456789ABCDEFGHJKMNPQRS',
    name: 'Claude Code · cue++',
    app: 'claude-code',
    where: { scope: 'user', folder: null, configDir: null },
    entry: { name: 'agentcomms', path: '/example/home/.claude.json' },
    launcher: 'managed',
    parts: [{ server: 'core' }, { server: 'gmail', pin: MAIL, readOnly: true }, { server: 'events' }],
    keyHash: connectionKeyHash(KEY),
    keyIssuedAt: '2026-10-27T09:00:00.000Z',
    createdAt: '2026-10-27T09:00:00.000Z',
    revokedAt: null,
    ...over,
  };
}

function withRecords(...records: unknown[]): Config {
  const config = emptyConfig();
  return {
    ...config,
    connections: Object.fromEntries(
      records.map((each, index) => [
        (each as { id?: unknown } | null)?.id ?? `cn_${String(index).padStart(26, '0')}`,
        each,
      ]),
    ),
  };
}

const loosened = (before: Config, after: Config) => classifyChange(before, after).changes;

test('a record reads whole, and what it reaches is its parts, pins and read-only', () => {
  const read = readConnections(withRecords(storedConnection(record())));
  assert.equal(read.problems.length, 0, read.problems.join('; '));
  const [only] = read.connections;
  assert.ok(only?.readable);
  assert.deepEqual(
    [...connectionReach(only)].map(([server, reach]) => [server, reach.pin?.alias ?? null, reach.readOnly]),
    [
      ['core', null, false],
      ['gmail', 'cue/gmail', true],
      ['events', null, false],
    ],
  );
});

test('what cannot be read reaches less: an unknown part, an unreadable pin or read-only leave the part out', () => {
  const parts = [
    { server: 'core' },
    { server: 'telegram' },
    { server: 'gmail', pin: { id: 'not-an-id', alias: 'cue/gmail' } },
    { server: 'slack', pin: 'cue/slack' },
    { server: 'resend', readOnly: 'yes' },
    { server: 'slack', readOnly: true },
    { server: 'core' },
  ];
  const read = readConnections(withRecords({ ...storedConnection(record()), parts }));
  const [only] = read.connections;
  assert.ok(only?.readable);
  // Only core is left: never a Gmail or Slack reaching every account because its pin could not be read.
  assert.deepEqual([...connectionReach(only).keys()], ['core']);
  assert.equal(read.problems.length, 6, read.problems.join('\n'));
  assert.match(read.problems.join('\n'), /pin could not be read, so the part was left out/);
  assert.match(read.problems.join('\n'), /Slack cannot be started read-only/);
});

test('a record that cannot be read serves nothing, and so does one cut off or named like another', () => {
  const good = storedConnection(record());
  const cases: unknown[] = [
    'not an object',
    { ...good, id: 'cn_SOMETHINGELSE0000000000000' },
    { ...good, name: 'two\nlines' },
    { ...good, app: 'raycast' },
    { ...good, where: { scope: 'local', folder: null, configDir: null } },
    { ...good, launcher: 'docker' },
    { ...good, keyHash: 'sha1:abc' },
    { ...good, createdAt: 'yesterday' },
    { ...good, parts: 'core,gmail' },
  ];
  for (const raw of cases) {
    const config = { ...emptyConfig(), connections: { cn_0123456789ABCDEFGHJKMNPQRS: raw } };
    const [only] = readConnections(config).connections;
    assert.equal(only?.readable, false, JSON.stringify(raw));
    assert.equal(connectionReach(only).size, 0);
  }
  const revoked = readConnections(withRecords(storedConnection(record({ revokedAt: '2026-10-27T10:00:00.000Z' }))));
  assert.equal(connectionReach(revoked.connections[0]).size, 0, 'a connection cut off reaches nothing');
  const twins = readConnections(
    withRecords(
      storedConnection(record()),
      storedConnection(record({ id: 'cn_1123456789ABCDEFGHJKMNPQRS', name: 'claude code · CUE++' })),
    ),
  );
  assert.deepEqual(
    twins.connections.map((each) => each.readable),
    [true, false],
  );
  assert.deepEqual(readConnections({ connections: [] }).connections, []);
  assert.match(readConnections({ connections: [] }).problems[0] ?? '', /not an object/);
});

test('§6.2 loosenings: adding a connection or a part, unpinning or moving a pin, and read-only off', () => {
  const none = emptyConfig();
  const base = withRecords(storedConnection(record()));
  const paths = (after: Config) => loosened(base, after).map((change) => change.path);
  assert.deepEqual(
    loosened(none, base).map((change) => [change.path, change.before]),
    [['connections["Claude Code · cue++"]', null]],
  );
  const [added] = loosened(none, base);
  assert.match(String(added?.after), /Gmail, the mailbox cue\/gmail, read-only; Events/);
  const parts = (next: ConnectionRecord['parts']) => withRecords(storedConnection(record({ parts: next })));
  assert.deepEqual(paths(parts([...record().parts, { server: 'slack' }])), [
    'connections["Claude Code · cue++"].parts.slack',
  ]);
  assert.deepEqual(paths(parts([{ server: 'core' }, { server: 'gmail', readOnly: true }, { server: 'events' }])), [
    'connections["Claude Code · cue++"].parts.gmail.pin',
  ]);
  const unpinned = loosened(
    base,
    parts([{ server: 'core' }, { server: 'gmail', readOnly: true }, { server: 'events' }]),
  );
  assert.deepEqual([unpinned[0]?.before, unpinned[0]?.after], ['cue/gmail', 'every mailbox']);
  assert.deepEqual(
    paths(parts([{ server: 'core' }, { server: 'gmail', pin: OTHER_MAIL, readOnly: true }, { server: 'events' }])),
    ['connections["Claude Code · cue++"].parts.gmail.pin'],
  );
  assert.deepEqual(paths(parts([{ server: 'core' }, { server: 'gmail', pin: MAIL }, { server: 'events' }])), [
    'connections["Claude Code · cue++"].parts.gmail.readOnly',
  ]);
  // A connection cut off that serves again is the loosening adding it is.
  const revoked = withRecords(storedConnection(record({ revokedAt: '2026-10-27T10:00:00.000Z' })));
  assert.deepEqual(
    loosened(revoked, base).map((change) => change.path),
    ['connections["Claude Code · cue++"]'],
  );
});

test('§6.2 tightenings and neutral changes loosen nothing: a part removed, a pin added, read-only on, cut off, renamed, a new key', () => {
  const wide = withRecords(
    storedConnection(record({ parts: [{ server: 'core' }, { server: 'gmail' }, { server: 'slack' }] })),
  );
  const after = (over: Partial<ConnectionRecord>) => withRecords(storedConnection(record(over)));
  const cases: [string, Config][] = [
    ['a part removed', after({ parts: [{ server: 'core' }, { server: 'gmail' }] })],
    ['a pin added', after({ parts: [{ server: 'core' }, { server: 'gmail', pin: MAIL }, { server: 'slack' }] })],
    ['read-only on', after({ parts: [{ server: 'core' }, { server: 'gmail', readOnly: true }, { server: 'slack' }] })],
    [
      'cut off',
      after({
        parts: [{ server: 'core' }, { server: 'gmail' }, { server: 'slack' }],
        revokedAt: '2026-10-27T10:00:00.000Z',
      }),
    ],
    ['removed', emptyConfig()],
    ['renamed', after({ name: 'Work', parts: [{ server: 'core' }, { server: 'gmail' }, { server: 'slack' }] })],
    [
      'a new key',
      after({
        parts: [{ server: 'core' }, { server: 'gmail' }, { server: 'slack' }],
        keyHash: connectionKeyHash(newConnectionKey()),
        keyIssuedAt: '2026-10-27T11:00:00.000Z',
      }),
    ],
  ];
  for (const [what, config] of cases) assert.deepEqual(loosened(wide, config), [], what);
  // A tightening is still part of what an approval binds, so a claim cannot drop one the person read.
  const narrowed = cases[0]?.[1] as Config;
  assert.deepEqual(
    changedSettings(wide, narrowed).map((change) => change.path),
    ['connections["Claude Code · cue++"].parts'],
  );
});

test('a new connection plans the same twice: its id, key and times are in no path and no bound setting', () => {
  const none = emptyConfig();
  const one = withRecords(storedConnection(record()));
  const two = withRecords(
    storedConnection(
      record({
        id: newConnectionId(),
        keyHash: connectionKeyHash(newConnectionKey()),
        createdAt: '2026-10-27T12:00:00.000Z',
        keyIssuedAt: '2026-10-27T12:00:00.000Z',
      }),
    ),
  );
  assert.deepEqual(classifyChange(none, one).changes, classifyChange(none, two).changes);
  assert.deepEqual(changedSettings(none, one), changedSettings(none, two));
});

test('the key: random, kept as its hash, compared in constant time, and never matched by anything else', () => {
  const key = newConnectionKey();
  assert.match(key, /^ack_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(key, newConnectionKey());
  const hash = connectionKeyHash(key);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash.includes(key.slice(4)), false);
  assert.equal(connectionKeyMatches(key, hash), true);
  assert.equal(connectionKeyMatches(newConnectionKey(), hash), false);
  for (const wrong of [undefined, '', 'ack_short', `${key}x`, key.toUpperCase(), 42]) {
    assert.equal(connectionKeyMatches(wrong, hash), false, String(wrong));
  }
  assert.equal(connectionKeyMatches(key, 'sha256:00'), false);
  assert.equal(connectionKeyMatches(key, undefined), false);
  assert.match(newConnectionId(), /^cn_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('a name is 1 to 64 printable characters with no quotes, newlines or bidi controls', () => {
  assert.equal(connectionNameProblem('Claude Code · cue++'), null);
  assert.equal(connectionNameProblem('Work — Claude Code'), null);
  for (const bad of [
    '',
    ' padded',
    'two\nlines',
    'tab\there',
    'quote"d',
    'smart “quotes”',
    'rtl‮txt',
    'x'.repeat(65),
    7,
  ]) {
    assert.notEqual(connectionNameProblem(bad), null, JSON.stringify(bad));
  }
});

test('a connection loosened without consent is refused by the store, and one narrowed is written at once', async () => {
  const home = tempDir('comms-connections-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const env = {
    HOME: home,
    USERPROFILE: home,
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  const core = openCore({ env, caller: CORE_CALLER });
  const put = (next: ConnectionRecord) => (config: Config) => ({
    ...config,
    connections: withConnection(config, { put: next }),
  });
  await assert.rejects(core.config.update(put(record())), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'LOOSENING_REFUSED');
    assert.match(error.message, /connections\["Claude Code · cue\+\+"\]/);
    return true;
  });
  await core.config.update(put(record()), {
    consent: { kind: 'loosening-consent', paths: ['connections["Claude Code · cue++"]'] },
  });
  // Narrowing applies at once, with no consent: read-only already, now Gmail is gone too.
  await core.config.update(put(record({ parts: [{ server: 'core' }, { server: 'events' }] })));
  // And widening it again is refused.
  await assert.rejects(
    core.config.update(put(record())),
    (error: unknown) => error instanceof CommsError && error.code === 'LOOSENING_REFUSED',
  );
  const [held] = readConnections(await core.config.load()).connections;
  assert.ok(held?.readable);
  assert.deepEqual(
    held.record.parts.map((part) => part.server),
    ['core', 'events'],
  );
});
