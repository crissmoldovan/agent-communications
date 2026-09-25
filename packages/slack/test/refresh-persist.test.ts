import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError, type SecretStore } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { callSlack } from '../src/api/call.ts';
import { closedPermit } from '../src/api/guard.ts';
import { serialiseBundle, type TokenBundle } from '../src/auth/bundle.ts';
import { exitAfterRefreshes } from '../src/auth/exit.ts';
import { accessTokenFor } from '../src/auth/refresh.ts';
import { run } from '../src/cli/program.ts';
import { openWorkspace } from '../src/operations/session.ts';
import { newHarness, slackOk } from './support/harness.ts';
import {
  contextFor,
  expired,
  fakeProcess,
  flakyStore,
  HOUR,
  markerLandsLate,
  QUICK,
  stored,
  until,
} from './support/refresh.ts';

/**
 * Where the result goes: the error surfaces, a store that will not take it, a forced renewal, and shutdown.
 *
 * The refresh, driven the way a read drives it: `openWorkspace`, with only Slack's side replaced.
 *
 * `refresh.test.ts` injects an exchange that already returns a bundle, so it never sees what is sent to Slack, how
 * Slack's reply is read, or what each kind of failure leaves in the store. Those are exactly where the first real
 * refresh can lose a credential — Slack's single-use refresh token is spent the moment Slack answers `ok:true` —
 * so they are tested here, from the parameters on the wire to the state a second call finds.
 *
 * Every store is the harness's file store in a temporary directory. Nothing here reaches Slack or the keychain.
 */

// ── Slack's code reaches the person and the model ───────────────────────────────────────────────────────────────

test('Slack’s error code reaches the CLI --json envelope', async () => {
  const harness = await newHarness();
  await expired(harness);
  harness.reply = () => ({ ok: false, error: 'invalid_refresh_token' });
  let stdout = '';
  const { PassThrough } = await import('node:stream');
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const code = await run(['--json', 'channels', '--workspace', 'acme'], {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: { stdout: out, stderr: new PassThrough(), stdin: new PassThrough() },
    read: async () => assert.fail('nothing should be read with a dead credential'),
  });
  assert.equal(code, 77);
  const envelope = JSON.parse(stdout) as { error: { details?: Record<string, unknown> } };
  assert.equal(envelope.error.details?.slackError, 'invalid_refresh_token');
  assert.equal(envelope.error.details?.stage, 'refused');
});

test('Slack’s error code reaches the MCP error payload', async () => {
  const { createSlackMcpServer } = await import('../src/mcp/server.ts');
  const harness = await newHarness();
  await expired(harness);
  harness.reply = () => ({ ok: false, error: 'ratelimited' });
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({ name: 'slack_channels', arguments: { workspace: 'acme' } })) as {
      isError?: boolean;
      structuredContent?: { error?: { code?: string; details?: Record<string, unknown> } };
    };
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error?.code, 'TRANSIENT');
    assert.equal(result.structuredContent?.error?.details?.slackError, 'ratelimited');
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

// ── A store that will not take the result ───────────────────────────────────────────────────────────────────────

test('a store that keeps failing after Slack answered: the token is returned, kept, and written on the next call', async () => {
  /*
   * Slack has spent the old refresh token. Throwing the new one away to report a storage error — what this did —
   * turned one slow keychain prompt into a forced re-authorisation.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  const store = flakyStore(await harness.core.secrets('file'));
  const context = contextFor(harness);
  context.secrets = async () => store;
  harness.reply = () => {
    store.failing = true; // everything after the marker
    return slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });
  };

  const session = await openWorkspace(context, 'acme', { persist: QUICK });
  assert.equal(session.call.token, 'fake-new-access', 'the renewed token was not returned');
  assert.ok(store.attempts > 1, `the write was tried ${store.attempts} time(s); it should be retried`);
  assert.equal((await stored(harness, account.secretRef))?.state, 'refreshing', 'nothing could have been written');

  // Still failing: this process keeps using what it holds rather than refusing.
  const again = await openWorkspace(context, 'acme', { persist: QUICK });
  assert.equal(again.call.token, 'fake-new-access');

  // The store recovers; the next call writes the kept result, and Slack is not asked again.
  store.failing = false;
  const healed = await openWorkspace(context, 'acme', { persist: QUICK });
  assert.equal(healed.call.token, 'fake-new-access');
  const after = await stored(harness, account.secretRef);
  assert.equal(after?.state, 'ready');
  assert.equal(after?.refreshToken, 'fake-new-refresh');
  assert.equal(harness.calls.length, 1, 'Slack was asked again to fix a storage problem');
});

test('the write waits for a stuck store to settle rather than spending its retries against it', async () => {
  /*
   * The keychain fails every call fast while an earlier one is held by an OS dialog, so a timer alone spends every
   * attempt against the same dialog. Two attempts here — one before, one after it settles — is the sign that the
   * wait happened; a timer-only loop makes dozens in the same time.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  const inner = await harness.core.secrets('file');
  let stuck = false;
  let attempts = 0;
  const store: SecretStore = {
    kind: 'file',
    get: (ref) => inner.get(ref),
    delete: (ref) => inner.delete(ref),
    invalidate: (ref) => inner.invalidate(ref),
    async set(ref, value) {
      if (stuck) {
        attempts += 1;
        throw new CommsError('KEYCHAIN_APPROVAL_PENDING', 'the keychain is waiting for a person');
      }
      return inner.set(ref, value);
    },
    settled: () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          stuck = false;
          resolve();
        }, 60),
      ),
  };
  const context = contextFor(harness);
  context.secrets = async () => store;
  harness.reply = () => {
    stuck = true;
    return slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });
  };
  await openWorkspace(context, 'acme', { persist: { budgetMs: 5_000, backoffMs: [1] } });
  assert.equal(attempts, 1, `expected one failed attempt before the store settled, saw ${attempts}`);
  assert.equal((await stored(harness, account.secretRef))?.refreshToken, 'fake-new-refresh');
});

test('a kept result is not written over a credential something else wrote since', async () => {
  /*
   * Between the failed write and the retry, another path can write something newer — a re-authorisation, another
   * process. Only the marker this attempt wrote, or the `refresh-uncertain` another process made of it, is ours.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  const file = await harness.core.secrets('file');
  const store = flakyStore(file);
  const context = contextFor(harness);
  context.secrets = async () => store;
  harness.reply = () => {
    store.failing = true;
    return slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });
  };
  await openWorkspace(context, 'acme', { persist: QUICK });

  // Something else writes a newer credential over the marker.
  store.failing = false;
  const newer: TokenBundle = {
    v: 1,
    state: 'ready',
    accessToken: 'fake-other-access',
    accessExpiresAt: new Date(Date.now() + 12 * HOUR).toISOString(),
    refreshToken: 'fake-other-refresh',
    issuedAt: new Date().toISOString(),
  };
  await file.set(account.secretRef, serialiseBundle(newer));

  const session = await openWorkspace(context, 'acme', { persist: QUICK });
  assert.equal(session.call.token, 'fake-other-access');
  assert.equal(
    (await stored(harness, account.secretRef))?.refreshToken,
    'fake-other-refresh',
    'a kept result overwrote a credential written after it',
  );
});

test('a kept result is written over the refresh-uncertain another process made of its own marker', async () => {
  const harness = await newHarness();
  const account = await expired(harness);
  const file = await harness.core.secrets('file');
  const store = flakyStore(file);
  const context = contextFor(harness);
  context.secrets = async () => store;
  harness.reply = () => {
    store.failing = true;
    return slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });
  };
  await openWorkspace(context, 'acme', { persist: QUICK });
  store.failing = false;

  // Another process finds the marker stale — minutes later, by its clock — and does what it must: marks it uncertain.
  const marker = await stored(harness, account.secretRef);
  assert.equal(marker?.state, 'refreshing');
  const file2 = await harness.core.secrets('file');
  await assert.rejects(
    accessTokenFor(
      {
        secrets: file2,
        openSecrets: async () => file2,
        configDir: harness.core.paths.configDir,
        stateDir: harness.core.paths.stateDir,
        now: () => new Date(Date.now() + 5 * 60_000),
        exchange: async () => assert.fail('the other process refreshed a marker it found stale'),
      },
      'acc_OTHERPROCESS0000',
      account.secretRef,
    ),
    /interrupted/,
  );
  const uncertain = await stored(harness, account.secretRef);
  assert.equal(uncertain?.state, 'refresh-uncertain');
  assert.equal(uncertain?.reason?.attemptId, marker?.attempt?.id, 'the stale marker’s attempt was not recorded');

  await openWorkspace(context, 'acme', { persist: QUICK });
  const after = await stored(harness, account.secretRef);
  assert.equal(after?.state, 'ready', 'the renewed credential this process held was not recovered');
  assert.equal(after?.refreshToken, 'fake-new-refresh');
});

test('while the store fails reads as well as writes, the renewed token this process holds is still used', async () => {
  /*
   * The keychain fails every call fast while one is held by a dialog — reads included — and a file store with a
   * broken directory does the same. The token in hand is still the only live one, and hours from expiry.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  const inner = await harness.core.secrets('file');
  let failing = false;
  const unavailable = () => new CommsError('KEYCHAIN_APPROVAL_PENDING', 'the keychain is waiting for a person');
  const store: SecretStore = {
    kind: 'file',
    get: async (ref) => {
      if (failing) throw unavailable();
      return inner.get(ref);
    },
    delete: (ref) => inner.delete(ref),
    invalidate: (ref) => inner.invalidate(ref),
    async set(ref, value) {
      if (failing) throw unavailable();
      return inner.set(ref, value);
    },
  };
  const context = contextFor(harness);
  context.secrets = async () => store;
  harness.reply = () => {
    failing = true;
    return slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });
  };

  assert.equal((await openWorkspace(context, 'acme', { persist: QUICK })).call.token, 'fake-new-access');
  const again = await openWorkspace(context, 'acme', { persist: QUICK });
  assert.equal(again.call.token, 'fake-new-access', 'a failed read turned the token in hand into an error');

  failing = false;
  await openWorkspace(context, 'acme', { persist: QUICK });
  assert.equal((await stored(harness, account.secretRef))?.refreshToken, 'fake-new-refresh');
  assert.equal(harness.calls.length, 1, 'Slack was asked again to fix a storage problem');
});

test('a marker whose write failed but landed later is taken back before anyone else can find it', async () => {
  /*
   * Nothing was sent — the exchange never started — but the marker arrives once the dialog is answered, with no
   * process behind it. Left there, every call is told another process is refreshing, and two minutes later that a
   * refresh was interrupted: a re-authorisation for a token that never left this machine.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  const store = markerLandsLate(await harness.core.secrets('file'), 20);
  const context = contextFor(harness);
  context.secrets = async () => store;
  harness.reply = () =>
    slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });

  // A wait long enough that a loaded machine still sees the write land inside it.
  const patient = { budgetMs: 5_000, backoffMs: [1] };
  await assert.rejects(openWorkspace(context, 'acme', { persist: patient }), { code: 'KEYCHAIN_APPROVAL_PENDING' });
  assert.equal(harness.calls.length, 0, 'the token was sent without its marker');
  await store.settled();
  const after = await stored(harness, account.secretRef);
  assert.equal(after?.state, 'ready', 'a marker nobody is behind was left in the store');
  assert.equal(after?.attempt, undefined);

  const session = await openWorkspace(context, 'acme', { persist: QUICK });
  assert.equal(session.call.token, 'fake-new-access');
  assert.equal(harness.calls.length, 1);
});

test('a marker that lands after the wait for it is given up is taken back by the next call', async () => {
  // The person answers the dialog later than this process waits. The next call here still owns the marker.
  const harness = await newHarness();
  const account = await expired(harness);
  const store = markerLandsLate(await harness.core.secrets('file'), 400);
  const context = contextFor(harness);
  context.secrets = async () => store;
  harness.reply = () =>
    slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });

  await assert.rejects(openWorkspace(context, 'acme', { persist: QUICK }), { code: 'KEYCHAIN_APPROVAL_PENDING' });
  await store.settled();
  assert.equal((await stored(harness, account.secretRef))?.state, 'refreshing', 'the marker should have landed');

  const session = await openWorkspace(context, 'acme', { persist: QUICK });
  assert.equal(session.call.token, 'fake-new-access', 'the next call waited on a refresh nobody is making');
  assert.equal((await stored(harness, account.secretRef))?.refreshToken, 'fake-new-refresh');
  assert.equal(harness.calls.length, 1);
});

// ── A token Slack rejects before its recorded expiry ────────────────────────────────────────────────────────────

/** A read fetch that rejects every token but `accepted`, and records which it was shown. */
function slackThatAccepts(accepted: string) {
  const shown: string[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    shown.push(token);
    const body = token === accepted ? { ok: true, channels: [] } : { ok: false, error: 'invalid_auth' };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { fetch, shown };
}

test('invalid_auth on a ready, refreshable credential forces one refresh and retries once', async () => {
  /*
   * A token revoked early — another sign-in's refreshes, or a clock more than ten minutes out — still looks valid
   * on disk, and nothing would refresh it for up to twelve hours. One forced renewal fixes it.
   */
  const harness = await newHarness();
  const account = await harness.addWorkspace({
    alias: 'acme',
    bundle: { issuedAt: new Date(Date.now() - 2 * HOUR).toISOString() },
  });
  harness.reply = () =>
    slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });
  const slack = slackThatAccepts('fake-new-access');
  const session = await openWorkspace(contextFor(harness), 'acme', { fetch: slack.fetch });
  const response = await callSlack(session.call, 'conversations.list');
  assert.equal(response.ok, true);
  assert.deepEqual(slack.shown, ['fake-user-token-0', 'fake-new-access']);
  assert.equal(harness.calls.length, 1);
  assert.equal((await stored(harness, account.secretRef))?.accessToken, 'fake-new-access');
});

test('a token rejected minutes after it was issued is not refreshed again', async () => {
  // An IP allowlist or a removed app rejects the new token too; forcing would spend a refresh on every call.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const slack = slackThatAccepts('nothing');
  const session = await openWorkspace(contextFor(harness), 'acme', { fetch: slack.fetch });
  await assert.rejects(callSlack(session.call, 'conversations.list'), { code: 'AUTH_REQUIRED' });
  assert.equal(harness.calls.length, 0, 'a token issued moments ago forced a refresh');
});

test('a rejected token on a credential that must not be refreshed is reported, not refreshed', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({
    alias: 'acme',
    bundle: { state: 'refresh-uncertain', issuedAt: new Date(Date.now() - 2 * HOUR).toISOString() },
  });
  const slack = slackThatAccepts('nothing');
  const session = await openWorkspace(contextFor(harness), 'acme', { fetch: slack.fetch });
  // Slack's own refusal, not the credential's state: the call is what failed, and that is what is reported.
  await assert.rejects(callSlack(session.call, 'conversations.list'), (error: CommsError) => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.equal(error.details?.slackError, 'invalid_auth');
    return true;
  });
  assert.equal(harness.calls.length, 0);
  assert.equal(slack.shown.length, 1, 'the call was retried with nothing new');
});

test('a write is never retried after a rejection, because its permit is already spent', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({
    alias: 'acme',
    mode: 'send',
    bundle: { issuedAt: new Date(Date.now() - 2 * HOUR).toISOString() },
  });
  const slack = slackThatAccepts('nothing');
  const session = await openWorkspace(contextFor(harness), 'acme', { fetch: slack.fetch });
  const permit = closedPermit();
  permit.approvalId = 'ap_test';
  permit.method = 'chat.postMessage';
  await assert.rejects(callSlack({ ...session.call, permit }, 'chat.postMessage', { channel: 'C1', text: 'x' }), {
    code: 'AUTH_REQUIRED',
  });
  assert.equal(harness.calls.length, 0, 'a rejected post started a refresh');
  assert.equal(slack.shown.length, 1);
});

// ── Shutdown ────────────────────────────────────────────────────────────────────────────────────────────────────

test('SIGTERM during a refresh waits for Slack’s reply to be written before exiting', async () => {
  /*
   * A client that wants its server gone sends SIGTERM, and Node's default dies on the spot — between Slack's reply
   * and the write, that loses the only renewed token. The handler holds the exit until the refresh has settled.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  harness.reply = async () => {
    await answered;
    return slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });
  };
  const host = fakeProcess();
  const exits: number[] = [];
  const release = exitAfterRefreshes({ host, exit: (code) => exits.push(code) });
  try {
    const opening = openWorkspace(contextFor(harness), 'acme');
    await until(() => harness.calls.length === 1);
    host.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(host.raised, [], 'the process died with a refresh in flight');
    assert.deepEqual(exits, [], 'the process exited with a refresh in flight');
    answer();
    await opening;
    await until(() => host.raised.length > 0);
    // Sent again with nothing left to catch it, so the process dies of it — what its parent is told happened.
    assert.deepEqual(host.raised, [{ pid: host.pid, signal: 'SIGTERM', listening: 0 }]);
    assert.deepEqual(exits, [], 'the process exited with a status instead of dying by the signal');
    assert.equal((await stored(harness, account.secretRef))?.refreshToken, 'fake-new-refresh');
  } finally {
    release();
  }
});

test('SIGTERM with a refresh that never settles still exits, after the bound', async () => {
  const harness = await newHarness();
  await expired(harness);
  let answer: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  harness.reply = async () => {
    await gate;
    return slackOk();
  };
  const host = fakeProcess();
  const release = exitAfterRefreshes({ host, waitMs: 100, exit: () => {} });
  const opening = openWorkspace(contextFor(harness), 'acme');
  try {
    await until(() => harness.calls.length === 1);
    host.emit('SIGINT');
    // The exchange is never answered before this resolves, so only the bound can end the wait.
    await until(() => host.raised.length > 0, 10_000);
    assert.deepEqual(
      host.raised,
      [{ pid: host.pid, signal: 'SIGINT', listening: 0 }],
      'a stuck refresh held the process past its bound',
    );
  } finally {
    release();
    answer();
    await opening;
  }
});

test('SIGTERM writes down a renewed token this process is still holding before it exits', async () => {
  // The kept result lives only in memory; a shutdown that did not try the store once more would lose it.
  const harness = await newHarness();
  const account = await expired(harness);
  const store = flakyStore(await harness.core.secrets('file'));
  const context = contextFor(harness);
  context.secrets = async () => store;
  harness.reply = () => {
    store.failing = true;
    return slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } });
  };
  await openWorkspace(context, 'acme', { persist: QUICK });
  store.failing = false;

  const host = fakeProcess();
  const release = exitAfterRefreshes({ host, exit: () => {} });
  try {
    host.emit('SIGTERM');
    await until(() => host.raised.length > 0);
    assert.deepEqual(host.raised, [{ pid: host.pid, signal: 'SIGTERM', listening: 0 }]);
    assert.equal((await stored(harness, account.secretRef))?.refreshToken, 'fake-new-refresh');
  } finally {
    release();
  }
});

test('a process its re-raised signal does not end still exits, with the status that signal stands for', async () => {
  /*
   * Where sending the signal again does not end the process — Windows has no POSIX signals — the hold must not be
   * what keeps it running. This process survives the signal it is sent back, as a Windows one would.
   */
  const host = fakeProcess();
  const exits: number[] = [];
  const release = exitAfterRefreshes({ host, exit: (code) => exits.push(code) });
  try {
    host.emit('SIGINT');
    await until(() => exits.length > 0, 5_000);
    assert.deepEqual(exits, [130]);
    assert.equal(host.raised.length, 1, 'the status was used without first trying to die by the signal');
  } finally {
    release();
  }
});
