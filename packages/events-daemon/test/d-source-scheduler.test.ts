import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { LocalEventSourceRegistry } from '../src/sources/registry.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const first = { source: 'resend' as const, accountId: 'acc_RESENDSOURCE001', scopeId: 'received' };
const second = {
  source: 'slack' as const,
  accountId: 'acc_SLACKSOURCE001',
  scopeId: 'slack:acc_SLACKSOURCE001:C-source',
};

test('D7b: source turns are fair, persisted across restart, rate limited, and never run when paused or fenced', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-d-source-scheduler-');
  const store = await openEventDatabase({ stateDir });
  try {
    installBoundScope(store, first, { channel: 'resend', kinds: ['received'] }, { anchorId: 'empty' });
    installBoundScope(store, second, { channel: 'slack', conversations: ['C-source'] }, { timestamp: '1.000000' });
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    let now = 10_000;
    const calls: string[] = [];
    const config = {
      inboxes: {},
      accounts: {
        resend: { id: first.accountId, platform: 'resend' },
        slack: { id: second.accountId, platform: 'slack' },
      },
    };
    const make = () =>
      new EventScheduler({
        store,
        lifecycle: new EventLifecycle(store, () => now),
        activations: { resumeClaimedCompletions: async () => undefined } as never,
        dispatcher: { recoverLeases: async () => undefined } as never,
        expiry: { sweepAll: async () => undefined } as never,
        cipher: { decrypt: async (_location: unknown, record: Uint8Array) => Buffer.from(record) } as never,
        approvals: {} as never,
        config: { load: async () => config } as never,
        taint: {} as never,
        gmailSourceFor: async () => {
          throw new Error('the source scheduler must not poll Gmail for source work');
        },
        sourceWorkFor: async (scope) => {
          calls.push(`${scope.source}:${scope.scopeId}`);
          return { retryAfterMs: 500 };
        },
        mailboxLock: new MailboxLock(new SourceScopeLock()),
        sourceRegistry: registry(),
        pollIntervalMs: 100,
        now: () => now,
      });

    const scheduler = make();
    await scheduler.tick();
    assert.deepEqual(calls, ['resend:received']);
    assert.equal(
      (
        store.database
          .prepare('SELECT updated_at FROM cursors WHERE source = ? AND account_id = ? AND cursor_scope = ?')
          .get(first.source, first.accountId, first.scopeId) as { updated_at: number }
      ).updated_at,
      10_500,
      'the provider Retry-After is persisted as the next eligible instant',
    );
    assert.equal(
      (
        store.database
          .prepare(
            "SELECT cursor FROM cursors WHERE source = 'scheduler' AND account_id = 'owner' AND cursor_scope = 'ready-scope'",
          )
          .get() as { cursor: string }
      ).cursor,
      JSON.stringify([first.source, first.accountId, first.scopeId]),
    );

    now = 10_500;
    const restarted = make();
    await restarted.tick();
    assert.equal(calls.at(-1), `slack:${second.scopeId}`, 'a restart resumes after the durable prior source turn');
    assert.equal(
      (
        store.database
          .prepare('SELECT cursor FROM cursors WHERE source = ? AND account_id = ? AND cursor_scope = ?')
          .get(second.source, second.accountId, second.scopeId) as { cursor: string }
      ).cursor,
      '1.000000',
      'the first Slack cursor is its encrypted activation point, not a current provider head',
    );

    const lifecycle = new EventLifecycle(store, () => now);
    await lifecycle.pause();
    now += 1_000;
    await restarted.tick();
    assert.equal(calls.length, 2, 'pause blocks every new provider turn');

    await lifecycle.resume();
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, replacement_of_version, required_points, acquisition_scopes, status, claimed_at, completion_deadline, failure_code, created_at, updated_at)
         VALUES ('fence', 'rule', '{}', 'd', 'new', NULL, '[]', '[]', 'pending-completion', 0, NULL, NULL, 0, 0)`,
      )
      .run();
    store.database
      .prepare(
        `INSERT INTO activation_baselines (intent_id, source, account_id, position_scope, encrypted_position, response_at)
         VALUES ('fence', ?, ?, ?, ?, 0)`,
      )
      .run(second.source, second.accountId, second.scopeId, Buffer.from('{}'));
    store.database
      .prepare('UPDATE cursors SET updated_at = ? WHERE source = ? AND account_id = ? AND cursor_scope = ?')
      .run(now + 100_000, first.source, first.accountId, first.scopeId);
    now += 1_000;
    await restarted.tick();
    assert.equal(calls.length, 2, 'a fenced scope is never given a provider turn');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D7b: a changed point set after decrypt installs no source cursor and makes no provider call', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-d-source-cursor-race-');
  const store = await openEventDatabase({ stateDir });
  try {
    installBoundScope(store, second, { channel: 'slack', conversations: ['C-source'] }, { timestamp: '1.000000' });
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    let changed = false;
    let calls = 0;
    const scheduler = new EventScheduler({
      store,
      lifecycle: new EventLifecycle(store),
      activations: { resumeClaimedCompletions: async () => undefined } as never,
      dispatcher: { recoverLeases: async () => undefined } as never,
      expiry: { sweepAll: async () => undefined } as never,
      cipher: {
        decrypt: async (_location: unknown, record: Uint8Array) => {
          if (!changed) {
            changed = true;
            installBoundScope(
              store,
              second,
              { channel: 'slack', conversations: ['C-source'] },
              { timestamp: '2.000000' },
              'new-point',
            );
          }
          return Buffer.from(record);
        },
      } as never,
      approvals: {} as never,
      config: {
        load: async () => ({ inboxes: {}, accounts: { slack: { id: second.accountId, platform: 'slack' } } }),
      } as never,
      taint: {} as never,
      gmailSourceFor: async () => {
        throw new Error('not Gmail');
      },
      sourceWorkFor: async () => {
        calls += 1;
        return undefined;
      },
      mailboxLock: new MailboxLock(new SourceScopeLock()),
      sourceRegistry: registry(),
      now: () => 1_000,
    });
    await scheduler.tick();
    assert.equal(calls, 0);
    assert.equal(
      store.database
        .prepare('SELECT 1 FROM cursors WHERE source = ? AND account_id = ? AND cursor_scope = ?')
        .get(second.source, second.accountId, second.scopeId),
      undefined,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D7b: the owner re-reads live config after a provider await and purges a removed source account', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-d-source-live-after-await-');
  const store = await openEventDatabase({ stateDir });
  try {
    installBoundScope(store, second, { channel: 'slack', conversations: ['C-source'] }, { timestamp: '1.000000' });
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    let current: { inboxes: Record<string, never>; accounts: Record<string, unknown> } = {
      inboxes: {},
      accounts: { slack: { id: second.accountId, platform: 'slack' } },
    };
    let calls = 0;
    const scheduler = new EventScheduler({
      store,
      lifecycle: new EventLifecycle(store),
      activations: { resumeClaimedCompletions: async () => undefined } as never,
      dispatcher: { recoverLeases: async () => undefined } as never,
      expiry: { sweepAll: async () => undefined } as never,
      cipher: { decrypt: async (_location: unknown, record: Uint8Array) => Buffer.from(record) } as never,
      approvals: {} as never,
      config: { load: async () => current } as never,
      taint: {} as never,
      gmailSourceFor: async () => {
        throw new Error('not Gmail');
      },
      sourceWorkFor: async () => {
        calls += 1;
        current = { inboxes: {}, accounts: {} };
        return undefined;
      },
      mailboxLock: new MailboxLock(new SourceScopeLock()),
      sourceRegistry: registry(),
      now: () => 1_000,
    });
    await scheduler.tick();
    assert.equal(calls, 1);
    assert.equal(
      store.database
        .prepare('SELECT 1 FROM rule_activation_points WHERE source = ? AND account_id = ?')
        .get(second.source, second.accountId),
      undefined,
    );
    assert.equal(
      store.database
        .prepare('SELECT 1 FROM cursors WHERE source = ? AND account_id = ?')
        .get(second.source, second.accountId),
      undefined,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

function registry(): LocalEventSourceRegistry {
  const adapter = (source: 'slack' | 'resend') => ({
    source,
    canonicalise: (value: unknown) => value as never,
    scopesFor: ({
      accountId,
      options,
    }: {
      accountId: string;
      options?: { channel?: string; kinds?: string[]; conversations?: string[] };
    }) => {
      if (source === 'resend' && options?.channel === 'resend') return [{ source, accountId, scopeId: 'received' }];
      if (source === 'slack' && options?.channel === 'slack')
        return [{ source, accountId, scopeId: `slack:${accountId}:${options.conversations?.[0]}` }];
      return [];
    },
    withScopes: (lock: SourceScopeLock, scopes: readonly (typeof first)[], work: () => Promise<unknown>) =>
      lock.withScopes(scopes, work),
    baseline: <T>(sample: () => Promise<T>) => sample(),
    resume: <T>(step: () => Promise<T>) => step(),
    describeCursor: <T>(cursor: T) => cursor,
    cleanup: <T>(_kind: 'reset' | 'drain' | 'purge', work: () => Promise<T>) => work(),
  });
  return new LocalEventSourceRegistry([adapter('resend'), adapter('slack')] as never);
}

function installBoundScope(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  scope: typeof first | typeof second,
  options: unknown,
  point: unknown,
  suffix = '',
): void {
  const id = `rule-${scope.source}-${scope.accountId}${suffix}`;
  const rule = {
    ruleId: id,
    version: 1,
    source: { channel: scope.source, accountIds: [scope.accountId], options },
    event: { type: scope.source === 'slack' ? 'slack.message.posted' : 'resend.email.received', version: 1 },
    condition: { path: '/id', op: 'exists' },
    mapping: { constant: 'safe' },
    targets: [],
    subscribers: [],
    judges: [],
    retention: { ingestMs: 1 },
  };
  store.database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, 1, ?, 'digest', 'active', 'approval', 'activation', 0)`,
    )
    .run(`${id}@1`, id, JSON.stringify(rule));
  store.database
    .prepare(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, 1, ?, 0)",
    )
    .run(id, `activation-${id}`);
  store.database
    .prepare(
      `INSERT INTO rule_activation_points
       (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, inherited_from_version_id, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, NULL, 0)`,
    )
    .run(`activation-${id}`, id, scope.source, scope.accountId, scope.scopeId, Buffer.from(JSON.stringify(point)));
}
