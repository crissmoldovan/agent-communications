import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CommsError } from '@agentcomms/core';
import { buildAuthorizeUrl } from '../src/auth/authorize.ts';
import { type FlowStore, newFlowId, openFlowStore, type SlackFlow } from '../src/auth/flow.ts';
import { startLoopback } from '../src/auth/listener.ts';

/**
 * The sign-in that outlives the process which started it.
 *
 * An agent's shell call returns in seconds; consent takes minutes. Keeping the PKCE verifier in a variable works
 * at a terminal and fails for exactly the case this package exists to serve — so it is written down, and these
 * tests are about the consequences of writing it down.
 */

const NOW = new Date('2026-09-22T12:00:00.000Z');

async function store(now: () => Date = () => NOW): Promise<{ dir: string; flows: FlowStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'slack-flow-'));
  return { dir, flows: openFlowStore(dir, now) };
}

function flow(over: Partial<SlackFlow> = {}): SlackFlow {
  const request = buildAuthorizeUrl({ clientId: '1.2', mode: 'read', port: 51234 });
  return {
    flowId: newFlowId(),
    mode: 'read',
    alias: 'acme',
    clientId: '1.2',
    verifier: request.pkce.verifier,
    state: request.state,
    redirectUrl: request.redirectUrl,
    port: 51234,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    ...over,
  };
}

test('a saved flow is readable by another process, which is the whole point', async () => {
  const { dir, flows } = await store();
  const original = flow();
  await flows.save(original);

  // A different store object over the same directory — the stand-in for `--finish` in a later process.
  const later = openFlowStore(dir, () => NOW);
  assert.deepEqual(await later.peek(original.flowId), original);
});

test('the flow file is owner-only, because it holds the verifier', async () => {
  // Not a credential — it is useless once the flow completes or expires — but it is the secret that binds the
  // code to this machine, and a world-readable one would let anything here finish somebody's sign-in.
  const { dir, flows } = await store();
  const saved = flow();
  await flows.save(saved);
  const mode = (await stat(join(dir, 'slack', 'flows', `${saved.flowId}.json`))).mode & 0o777;
  assert.equal(mode, 0o600, `the flow file is ${mode.toString(8)}`);
});

test('claiming a flow consumes it, so two finishes cannot exchange one code', async () => {
  /*
   * Slack refuses a code the second time. Without an atomic claim, two `--finish` calls would race: the first
   * would store a credential, the second would report a failure — for a sign-in that actually worked.
   */
  const { flows } = await store();
  const saved = flow();
  await flows.save(saved);

  const claimed = await flows.claim(saved.flowId);
  assert.equal(claimed.flowId, saved.flowId);
  await assert.rejects(flows.claim(saved.flowId), (error: CommsError) => {
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
});

test('an expired flow is refused, and says how long they last', async () => {
  const { flows } = await store();
  const saved = flow({ expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
  await flows.save(saved);
  await assert.rejects(flows.claim(saved.flowId), (error: CommsError) => {
    assert.match(error.message, /expired/);
    assert.match(error.hint ?? '', /ten minutes/);
    return true;
  });
  // And it is gone rather than left to be found again.
  assert.equal(await flows.peek(saved.flowId), null);
});

test('a flow id that is not one cannot become a path', async () => {
  // The id arrives from a command line and is about to be joined into a directory.
  const { flows } = await store();
  for (const bad of ['../../etc/passwd', 'sfl_short', 'nope', '']) {
    await assert.rejects(flows.claim(bad), (error: CommsError) => {
      assert.equal(error.code, 'USAGE');
      return true;
    });
  }
});

test('pending lists the live ones, newest first, and sweeps the dead', async () => {
  const { flows } = await store();
  const old = flow({ createdAt: '2026-09-22T11:00:00.000Z' });
  const recent = flow({ createdAt: '2026-09-22T11:59:00.000Z' });
  const dead = flow({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
  for (const f of [old, recent, dead]) await flows.save(f);

  const pending = await flows.pending();
  assert.deepEqual(
    pending.map((f) => f.flowId),
    [recent.flowId, old.flowId],
    'a stale sign-in was listed, or the order is wrong',
  );
  // Swept, not merely filtered: nothing can be done about a flow that can no longer be finished.
  assert.equal(await flows.peek(dead.flowId), null);
});

test('ids are unique and shaped so they can be recognised', async () => {
  const ids = new Set(Array.from({ length: 200 }, () => newFlowId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^sfl_[A-Za-z0-9]{22}$/);
});

// ── the listener ───────────────────────────────────────────────────────────────────────────────────────────

test('the redirect is received and the code handed back', async () => {
  const listener = await startLoopback({
    state: 'st-1',
    timeoutMs: 5_000,
    about: { alias: 'acme', mode: 'read', reauth: false },
  });
  try {
    const response = await fetch(`${listener.redirectUrl}?state=st-1&code=abc`);
    assert.equal(response.status, 200);
    assert.deepEqual(await listener.result, { kind: 'code', code: 'abc' });
  } finally {
    await listener.close();
  }
});

test('the page says what it knows, and does not claim the workspace is connected', async () => {
  const listener = await startLoopback({
    state: 'st-2',
    timeoutMs: 5_000,
    about: { alias: 'acme', mode: 'read', reauth: false },
  });
  try {
    const html = await (await fetch(`${listener.redirectUrl}?state=st-2&code=abc`)).text();
    assert.match(html, /agent-slack/);
    assert.match(html, /Connecting/);
    assert.match(html, /acme/);
    assert.match(html, /Nothing is stored yet/i);
    // At this moment the code has not been exchanged. Which account was granted is not yet known, and on a
    // reauth it is exactly what is being checked.
    assert.doesNotMatch(html, /connected as/i);
    assert.doesNotMatch(html, /signed in as/i);
  } finally {
    await listener.close();
  }
});

test('a reauth page says so rather than saying it is connecting something new', async () => {
  const listener = await startLoopback({
    state: 'st-3',
    timeoutMs: 5_000,
    about: { alias: 'acme', mode: 'send', reauth: true },
  });
  try {
    const html = await (await fetch(`${listener.redirectUrl}?state=st-3&code=abc`)).text();
    assert.match(html, /Re-authorising/);
    assert.doesNotMatch(html, /Connecting/);
  } finally {
    await listener.close();
  }
});

test('an alias is escaped, because it comes from a flag', async () => {
  const listener = await startLoopback({
    state: 'st-4',
    timeoutMs: 5_000,
    about: { alias: '<img src=x onerror=alert(1)>', mode: 'read', reauth: false },
  });
  try {
    const html = await (await fetch(`${listener.redirectUrl}?state=st-4&code=abc`)).text();
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
  } finally {
    await listener.close();
  }
});

test('a redirect with the wrong state does not end the sign-in, and is told nothing', async () => {
  const listener = await startLoopback({
    state: 'st-5',
    timeoutMs: 5_000,
    about: { alias: 'acme', mode: 'read', reauth: false },
  });
  try {
    const response = await fetch(`${listener.redirectUrl}?state=somebody-else&code=abc`);
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.doesNotMatch(html, /acme/, 'a stray request was told which workspace is being connected');

    // The real one still works afterwards: the stray request must not have settled anything.
    await fetch(`${listener.redirectUrl}?state=st-5&code=real`);
    assert.deepEqual(await listener.result, { kind: 'code', code: 'real' });
  } finally {
    await listener.close();
  }
});

test('a refusal in Slack comes back as a denial, with its reason', async () => {
  const listener = await startLoopback({ state: 'st-6', timeoutMs: 5_000 });
  try {
    await fetch(`${listener.redirectUrl}?state=st-6&error=access_denied&error_description=nope`);
    assert.deepEqual(await listener.result, { kind: 'denied', error: 'access_denied', description: 'nope' });
  } finally {
    await listener.close();
  }
});
