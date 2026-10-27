import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { canonicalSubscriber } from '../src/domain/activation-documents.ts';
import { activeSubscriptions } from '../src/runtime/events/subscriptions.ts';
import { ATTESTED_APP, sseSubscriber, webhookSubscriber, withEventsOwner } from './support/events-owner.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';
import { seedEvent, seedRun } from './support/workflow-event-rows.ts';

/*
 * D1 (workflows plan, Track D): subscribers ask for events. A subscriber version given `events` — namespaces, patterns
 * and whether it gets what senders wrote — is inert until the person approves it: at a terminal with the challenge, or
 * in the attested app with the digest the preview showed, never over MCP. One version per subscriber is active; a newer
 * approved one supersedes it. A webhook subscriber's signing secret and secret URL are the person's, at the terminal.
 */

const LEGACY = {
  subscriberId: 'browser-feed',
  version: 1,
  kind: 'sse',
  authority: { host: '127.0.0.1', port: 4811 },
  origins: ['http://localhost:3000'],
  retentionMs: 3_600_000,
};

const AGENT_SHELL = { CLAUDECODE: '1' };
const MCP_PROCESS = { AGENTCOMMS_MCP_SERVER: 'events' };

function json(run: { readonly code: number; readonly out: string; readonly err: string }): Record<string, unknown> {
  assert.equal(run.code, 0, run.err);
  return JSON.parse(run.out) as Record<string, unknown>;
}

test('D1: a stored SSE subscriber without events keeps its bytes and digest', { skip: WINDOWS_SKIP }, async () => {
  assert.equal(canonicalJson(canonicalSubscriber(LEGACY) as never), canonicalJson(LEGACY));
  await withEventsOwner(async (harness) => {
    const created = (await harness.control.request('addSubscriber', { document: LEGACY })) as { digest: string };
    assert.equal(created.digest, sha256Hex(canonicalJson(LEGACY)));
    const row = harness.database
      .prepare('SELECT document, state FROM subscriber_versions WHERE subscriber_id = ?')
      .get('browser-feed') as { document: string; state: string | null };
    assert.equal(row.document, canonicalJson(LEGACY), 'the stored bytes are the canonical document, unchanged');
    assert.equal(row.state, null, 'a subscriber given no events has no subscription state');
    const listed = (await harness.control.request('subscribersList', {})) as Record<string, unknown>[];
    assert.deepEqual(listed[0], {
      subscriberId: 'browser-feed',
      version: 1,
      digest: created.digest,
      revokedAt: null,
      kind: 'sse',
      events: null,
      state: null,
      listening: null,
      listenError: null,
      address: null,
      backlog: 0,
      lastDeliveredAt: null,
    });
    // It cannot be enabled for events: it was given none.
    await assert.rejects(
      harness.control.request('subscriber-enable', { subscriberId: 'browser-feed', version: 1 }),
      /only an inert subscriber version that is given events/u,
    );
  });
});

test('D1: a subscriber with events is inert until approved; its preview names patterns, namespaces, content and address', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withEventsOwner(async (harness) => {
    json(await harness.cli(['subscriber', 'add', '-'], { stdin: JSON.stringify(sseSubscriber({})) }));
    const listed = (await harness.control.request('subscribersList', {})) as Record<string, unknown>[];
    assert.equal(listed[0]?.state, 'inert');
    assert.deepEqual(listed[0]?.events, {
      namespaces: ['acme'],
      patterns: ['*.*.*.failed', 'acme.client-asks.*.*'],
      content: 'none',
    });
    assert.deepEqual(activeSubscriptions(harness.database), [], 'an inert version receives nothing');
    const prepared = json(await harness.cli(['subscriber', 'enable', 'events-dashboard', '1']));
    assert.equal(prepared.kind, 'subscription');
    assert.equal(prepared.status, 'pending');
    const binding = prepared.binding as { digest: string; versions: unknown[] };
    assert.deepEqual(binding.versions, [{ kind: 'subscriber', id: 'events-dashboard', version: 1 }]);
    // The agent's view: the preview alone, with the words of what it receives.
    const agentView = (await harness.control.request('approvalView', {
      approvalId: prepared.approvalId,
      digest: binding.digest,
      agentView: true,
    })) as { kind: string; subscription?: { words: string }; challenge?: unknown };
    assert.equal(agentView.kind, 'READY');
    assert.equal(agentView.challenge, undefined, 'no challenge is issued for an agent');
    assert.equal(
      agentView.subscription?.words,
      'events-dashboard receives *.*.*.failed and acme.client-asks.*.* in the namespace acme, live on this Mac at ' +
        '127.0.0.1:4801, from the page at http://localhost:3000. Nothing a sender wrote.',
    );
    // The person's terminal view prints the same words.
    const terminal = await harness.cli(['approval', 'view', String(prepared.approvalId), '--digest', binding.digest], {
      tty: true,
    });
    assert.equal(terminal.code, 0, terminal.err);
    assert.match(terminal.out, /events-dashboard receives \*\.\*\.\*\.failed and acme\.client-asks\.\*\.\*/u);
    assert.deepEqual(activeSubscriptions(harness.database), [], 'still nothing before the approval completes');
  });
});

test('D1: approve at the terminal with the challenge, or in the app with the digest; never over MCP', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withEventsOwner(async (harness) => {
    await harness.control.request('addSubscriber', { document: sseSubscriber({}) });
    await harness.control.request('addSubscriber', {
      document: webhookSubscriber({ subscriberId: 'crm-hook' }),
    });
    // At the terminal: the challenge, typed back.
    const first = (await harness.control.request('subscriber-enable', {
      subscriberId: 'events-dashboard',
      version: 1,
    })) as { approvalId: string; binding: { digest: string } };
    await harness.approve(first.approvalId);
    assert.deepEqual(
      activeSubscriptions(harness.database).map((entry) => `${entry.subscriberId}@${entry.version}`),
      ['events-dashboard@1'],
    );
    // In the attested app: the digest its preview showed.
    const second = (await harness.control.request('subscriber-enable', { subscriberId: 'crm-hook', version: 1 })) as {
      approvalId: string;
      binding: { digest: string };
    };
    const stale = await harness.cli(['subscriber', 'approve', second.approvalId, '--digest', '0'.repeat(64)], {
      desktopOrigin: ATTESTED_APP,
    });
    assert.equal(stale.code, 10, 'a digest the preview did not show is refused');
    const approved = json(
      await harness.cli(['subscriber', 'approve', second.approvalId, '--digest', second.binding.digest], {
        desktopOrigin: ATTESTED_APP,
      }),
    );
    assert.equal(approved.approved, true);
    assert.equal(approved.approvedBy, 'desktop-app');
    assert.equal(approved.subscriberId, 'crm-hook');
    assert.deepEqual(
      activeSubscriptions(harness.database).map((entry) => `${entry.subscriberId}@${entry.version}`),
      ['crm-hook@1', 'events-dashboard@1'],
    );
    // Never over MCP, and never from an agent's shell: the app path refuses both before the owner is asked.
    const third = (await harness.control
      .request('subscriber-enable', {
        subscriberId: 'events-dashboard',
        version: 1,
      })
      .catch((error: unknown) => error)) as Error;
    assert.match(String(third), /already active/u);
    for (const env of [AGENT_SHELL, MCP_PROCESS]) {
      const refused = await harness.cli(
        ['subscriber', 'approve', second.approvalId, '--digest', second.binding.digest],
        {
          env,
          desktopOrigin: ATTESTED_APP,
        },
      );
      assert.equal(refused.code, 10, JSON.stringify(env));
    }
    // An origin other than the app's is refused by the owner itself.
    await assert.rejects(
      harness.control.request('subscriber-approve', { approvalId: second.approvalId, digest: second.binding.digest }),
      /only the person|person’s own setup|APPROVAL_REQUIRED|from the app or their terminal/u,
    );
  });
});

test('D1: a newer approved version supersedes the older', { skip: WINDOWS_SKIP }, async () => {
  await withEventsOwner(async (harness) => {
    await harness.control.request('addSubscriber', { document: sseSubscriber({ version: 1 }) });
    await harness.control.request('addSubscriber', {
      document: sseSubscriber({ version: 2, patterns: ['acme.*.*.*'] }),
    });
    for (const version of [1, 2]) {
      const prepared = (await harness.control.request('subscriber-enable', {
        subscriberId: 'events-dashboard',
        version,
      })) as { approvalId: string };
      await harness.approve(prepared.approvalId);
    }
    const states = harness.database
      .prepare(
        "SELECT version, state FROM subscriber_versions WHERE subscriber_id = 'events-dashboard' ORDER BY version",
      )
      .all() as Array<{ version: number; state: string }>;
    assert.deepEqual(
      states.map((row) => ({ ...row })),
      [
        { version: 1, state: 'superseded' },
        { version: 2, state: 'active' },
      ],
    );
    assert.deepEqual(
      activeSubscriptions(harness.database).map((entry) => entry.events.patterns),
      [['acme.*.*.*']],
    );
    // A superseded version cannot be enabled again; a new version is.
    await assert.rejects(
      harness.control.request('subscriber-enable', { subscriberId: 'events-dashboard', version: 1 }),
      /only an inert subscriber version/u,
    );
  });
});

test('D1: a pattern naming a namespace not given is refused, and so is anything that is not a literal pattern', () => {
  for (const [patterns, namespaces, why] of [
    [['other.*.*.*'], ['acme'], /not one this subscriber was given/u],
    [['acme.**.*.*'], ['acme'], /neither a segment nor \*/u],
    [['acme.client-*.*.*'], ['acme'], /neither a segment nor \*/u],
    [['acme.*.*'], ['acme'], /four segments/u],
    [['com.*.*.*'], ['acme'], /reserved/u],
    [['*.*.*.*'], ['agentcomms'], /reserved/u],
    [['*.*.*.*'], [], /1 to 8 namespaces/u],
    [[], ['acme'], /1 to 32 patterns/u],
  ] as const) {
    assert.throws(
      () =>
        canonicalSubscriber({
          ...sseSubscriber({}),
          events: { namespaces, patterns, content: 'none' },
        }),
      why,
      JSON.stringify(patterns),
    );
  }
  // Sorted and unique, and an unknown field is refused.
  assert.throws(
    () =>
      canonicalSubscriber({
        ...sseSubscriber({}),
        events: { namespaces: ['acme', 'acme'], patterns: ['*.*.*.*'], content: 'none' },
      }),
    /no duplicate values/u,
  );
  assert.throws(
    () =>
      canonicalSubscriber({
        ...sseSubscriber({}),
        events: { namespaces: ['acme'], patterns: ['*.*.*.*'], content: 'none', colour: 'red' },
      }),
    /no field colour/u,
  );
  // With events, origins may be empty: no browser page may connect. Without events, they may not.
  assert.deepEqual(
    (canonicalSubscriber({ ...sseSubscriber({}), origins: [] }) as { origins: readonly string[] }).origins,
    [],
  );
  assert.throws(() => canonicalSubscriber({ ...sseSubscriber({ events: false }), origins: [] }), /Origins/u);
  // A workflow's subscribers are SSE subscribers its SSE targets bind; a webhook subscriber is refused there.
  assert.equal(canonicalSubscriber(webhookSubscriber({})).kind, 'webhook');
});

test('D1: webhook subscribers take a secret URL and a signing secret, shown once, from the terminal only', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withEventsOwner(async (harness) => {
    await harness.control.request('addSubscriber', { document: webhookSubscriber({}) });
    // The signing secret: generated by the owner, shown once at the terminal.
    const created = await harness.cli(['subscriber', 'secret', 'create', 'crm-hook', '--version', '1'], {
      tty: true,
      json: false,
    });
    assert.equal(created.code, 0, created.err);
    const shown = /Generated credential \(shown once\): (whsec_\S+)/u.exec(created.out)?.[1];
    assert.ok(shown, 'the signing secret is shown once');
    assert.equal(created.out.split(shown).length - 1, 1, 'and only once');
    const slot = harness.database
      .prepare(
        "SELECT purpose, lifecycle FROM event_secret_generations WHERE owner_kind = 'subscriber' AND owner_id = 'crm-hook'",
      )
      .all() as Array<{ purpose: string; lifecycle: string }>;
    assert.deepEqual(
      slot.map((row) => ({ ...row })),
      [{ purpose: 'webhook-signing', lifecycle: 'current' }],
    );
    const rotated = await harness.cli(['subscriber', 'secret', 'rotate', 'crm-hook', '--version', '1'], {
      tty: true,
      json: false,
    });
    assert.equal(rotated.code, 0, rotated.err);
    assert.equal(rotated.out.includes(shown), false, 'a rotation never shows the previous secret');
    // The secret URL: hidden input, a new inert version whose document holds only its public descriptor.
    const hiddenUrl = 'http://127.0.0.1:4803/hooks/events?token=SENTINEL-URL-SECRET';
    const set = await harness.cli(['subscriber', 'url', 'set', 'crm-hook', '--version', '2'], {
      tty: true,
      json: false,
      hidden: hiddenUrl,
    });
    assert.equal(set.code, 0, set.err);
    assert.doesNotMatch(set.out, /SENTINEL-URL-SECRET/u, 'the URL is never printed');
    const version2 = harness.database
      .prepare("SELECT document, state FROM subscriber_versions WHERE subscriber_id = 'crm-hook' AND version = 2")
      .get() as { document: string; state: string };
    assert.equal(version2.state, 'inert');
    assert.doesNotMatch(version2.document, /SENTINEL-URL-SECRET|token=/u, 'the stored document has no secret URL');
    assert.equal((JSON.parse(version2.document) as { url: { kind: string } }).url.kind, 'secret');
    // `subscribers list` names each version's public address: a plain URL's path, a secret URL's authority alone.
    const listed = (await harness.control.request('subscribersList', {})) as Array<{
      version: number;
      address: { url: string } | null;
    }>;
    assert.deepEqual(
      listed.map((entry) => [entry.version, entry.address]),
      [
        [1, { url: 'http://127.0.0.1:4802/hooks/events' }],
        [2, { url: 'http://127.0.0.1:4803' }],
      ],
    );
    assert.doesNotMatch(JSON.stringify(listed), /SENTINEL-URL-SECRET|token=|hooks\/events\?/u);
    // An SSE subscriber has no signing secret.
    await harness.control.request('addSubscriber', { document: sseSubscriber({}) });
    const sse = await harness.cli(['subscriber', 'secret', 'create', 'events-dashboard', '--version', '1'], {
      tty: true,
      json: false,
    });
    assert.notEqual(sse.code, 0);
    // From an agent's shell, inside the MCP server's process, or without a terminal: refused, exit 10.
    for (const options of [
      { env: AGENT_SHELL, tty: true, json: false },
      { env: MCP_PROCESS, tty: true, json: false },
      { tty: false, json: false },
    ]) {
      for (const argv of [
        ['subscriber', 'secret', 'create', 'crm-hook', '--version', '2'],
        ['subscriber', 'secret', 'rotate', 'crm-hook', '--version', '1'],
        ['subscriber', 'url', 'set', 'crm-hook', '--version', '3'],
      ]) {
        const refused = await harness.cli(argv, { ...options, hidden: hiddenUrl });
        assert.equal(refused.code, 10, `${argv.join(' ')} ${JSON.stringify(options)}`);
      }
    }
  });
});

test('D1: subscriber remove revokes every version and cancels its queued event deliveries', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withEventsOwner(async (harness) => {
    await harness.control.request('addSubscriber', { document: sseSubscriber({ version: 1 }) });
    await harness.control.request('addSubscriber', { document: sseSubscriber({ version: 2 }) });
    const prepared = (await harness.control.request('subscriber-enable', {
      subscriberId: 'events-dashboard',
      version: 2,
    })) as { approvalId: string };
    await harness.approve(prepared.approvalId);
    const pending = (await harness.control.request('subscriber-enable', {
      subscriberId: 'events-dashboard',
      version: 1,
    })) as { intentId: string };
    const runId = seedRun(harness.database, { ruleId: 'client-asks', ruleVersion: 5, accountId: 'acme/slack' });
    const eventId = seedEvent(harness.database, {
      runId,
      ruleId: 'client-asks',
      ruleVersion: 5,
      accountId: 'acme/slack',
      deliveries: [{ subscriberId: 'events-dashboard', version: 2, kind: 'sse' }],
    });
    const listed = (await harness.control.request('subscribersList', {})) as Array<{
      version: number;
      backlog: number;
    }>;
    assert.equal(listed.find((entry) => entry.version === 2)?.backlog, 1);
    json(await harness.cli(['subscriber', 'remove', 'events-dashboard']));
    const versions = harness.database
      .prepare("SELECT version, revoked_at, state FROM subscriber_versions WHERE subscriber_id = 'events-dashboard'")
      .all() as Array<{ version: number; revoked_at: number | null; state: string }>;
    assert.ok(
      versions.every((row) => row.revoked_at !== null),
      'every version is revoked',
    );
    assert.ok(
      versions.every((row) => row.state !== 'active'),
      'none is active',
    );
    const delivery = harness.database
      .prepare('SELECT state, last_error_code FROM event_deliveries WHERE event_id = ?')
      .get(eventId) as { state: string; last_error_code: string };
    assert.deepEqual({ ...delivery }, { state: 'cancelled', last_error_code: 'SUBSCRIBER_REMOVED' });
    const event = harness.database
      .prepare('SELECT state, encrypted_record FROM workflow_events WHERE id = ?')
      .get(eventId) as { state: string; encrypted_record: Uint8Array | null };
    assert.deepEqual({ ...event }, { state: 'done', encrypted_record: null }, 'its sealed record goes with it');
    const intent = harness.database
      .prepare('SELECT status FROM activation_intents WHERE id = ?')
      .get(pending.intentId) as { status: string };
    assert.equal(intent.status, 'cancelled', 'a pending subscription of a removed subscriber is cancelled');
    assert.deepEqual(activeSubscriptions(harness.database), []);
  });
});
