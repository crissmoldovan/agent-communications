import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closedPermit, guardSlackRequests, spendOn } from '../src/api/guard.ts';
import { classifiedMethods, methodOfUrl, methodRule, writeMethods } from '../src/api/methods.ts';

const API = 'https://slack.com/api';

/** A fetch that records what reached it, so "was it refused" and "did it go out" are different questions. */
function recorder() {
  const calls: string[] = [];
  const inner = async (input: string | URL | Request) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response('{"ok":true}');
  };
  return { calls, inner };
}

test('a read goes out; a write without a permit does not', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await fetch(`${API}/auth.test`);
  assert.deepEqual(calls, [`${API}/auth.test`]);

  await assert.rejects(fetch(`${API}/chat.postMessage`), /no approval is open/);
  assert.equal(calls.length, 1, 'the refused write never reached fetch');
});

test('every way to put a message in front of people needs a permit, not just chat.postMessage', async () => {
  // The research found four write paths and only one of them needs `chat:write`. A guard that knew about that one
  // would be a guard against that one.
  const { calls, inner } = recorder();
  const fetch = guardSlackRequests(inner, closedPermit());

  for (const method of ['chat.postMessage', 'files.completeUploadExternal', 'reactions.add', 'chat.update']) {
    await assert.rejects(fetch(`${API}/${method}`), /no approval is open/, method);
  }
  assert.equal(calls.length, 0);
});

test('a permit opens for one method and one request', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await spendOn(permit, 'ap_1', 'chat.postMessage', async () => {
    await fetch(`${API}/chat.postMessage`);
    // Spent. A retry inside the same permit finds the door shut — a retried post may deliver twice and nothing
    // here could tell.
    await assert.rejects(fetch(`${API}/chat.postMessage`), /no approval is open/);
  });
  assert.deepEqual(calls, [`${API}/chat.postMessage`]);

  // And closed again afterwards.
  await assert.rejects(fetch(`${API}/chat.postMessage`), /no approval is open/);
});

test('a permit for one act does not open the door for another', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await spendOn(permit, 'ap_1', 'reactions.add', async () => {
    await assert.rejects(fetch(`${API}/chat.postMessage`), /the open approval is for reactions\.add/);
  });
  assert.equal(calls.length, 0);
});

test('a permit closes even when the write throws', async () => {
  const { inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await assert.rejects(
    spendOn(permit, 'ap_1', 'chat.postMessage', async () => {
      throw new Error('network died mid-post');
    }),
    /network died/,
  );
  assert.equal(permit.approvalId, null, 'a write that failed halfway left no door open behind it');
  await assert.rejects(fetch(`${API}/chat.postMessage`), /no approval is open/);
});

test('permits do not nest', async () => {
  const permit = closedPermit();
  await assert.rejects(
    spendOn(permit, 'ap_1', 'chat.postMessage', async () => {
      await spendOn(permit, 'ap_2', 'reactions.add', async () => undefined);
    }),
    /already open/,
  );
  assert.equal(permit.approvalId, null);
});

test('an unclassified method is refused, so the registry cannot fall behind the code', async () => {
  const { calls, inner } = recorder();
  const fetch = guardSlackRequests(inner, closedPermit());

  await assert.rejects(fetch(`${API}/chat.postSomethingNew`), /not a method this package is allowed to call/);
  await assert.rejects(fetch(`${API}/conversations.invite`), /not a method this package is allowed to call/);
  assert.equal(calls.length, 0);
});

test('a method refused by design says why, and the reason travels with the error', async () => {
  const fetch = guardSlackRequests(recorder().inner, closedPermit());
  await assert.rejects(fetch(`${API}/conversations.mark`), /not worth a write scope/);
  await assert.rejects(fetch(`${API}/chat.postEphemeral`), /nobody else can see/);
  await assert.rejects(fetch(`${API}/apps.connections.open`), /Socket Mode/);
});

test('anything that is not the Slack Web API is refused outright', async () => {
  const fetch = guardSlackRequests(recorder().inner, closedPermit());
  await assert.rejects(fetch('https://evil.test/collect'), /only calls the Slack Web API/);
  await assert.rejects(fetch('https://slack.com/oauth/v2/authorize'), /only calls the Slack Web API/);
});

test('a query string cannot hide the method from the guard', () => {
  // `chat.postMessage?pretty=1` names no method to a reader that stops at the query, and the guard would wave
  // through the one call it exists to stop.
  assert.equal(methodOfUrl(`${API}/chat.postMessage?pretty=1`), 'chat.postMessage');
  assert.equal(methodOfUrl(`${API}/chat.postMessage#x`), 'chat.postMessage');
  assert.equal(methodOfUrl(`${API}/chat.postMessage/`), 'chat.postMessage');
  assert.equal(methodOfUrl('/api/chat.postMessage?a=b'), 'chat.postMessage');
  assert.equal(methodOfUrl('https://slack.com/oauth/v2/authorize'), null);
});

test('a query string cannot hide a write from the guard either', async () => {
  const { calls, inner } = recorder();
  const fetch = guardSlackRequests(inner, closedPermit());
  await assert.rejects(fetch(`${API}/chat.postMessage?pretty=1`), /no approval is open/);
  await assert.rejects(fetch(`${API}/chat.postMessage/`), /no approval is open/);
  assert.equal(calls.length, 0);
});

test('every classified method is read, write or refused, and every write is named', () => {
  const methods = classifiedMethods();
  assert.ok(methods.length > 0);
  for (const method of methods) {
    const rule = methodRule(method);
    assert.ok(rule, method);
    assert.ok(['read', 'write', 'refused'].includes(rule.kind), `${method} is ${rule.kind}`);
    if (rule.kind === 'refused') assert.ok(rule.note, `${method} is refused without saying why`);
  }

  // The four write paths the design enumerated are all classified as writes, by name. A future edit that
  // reclassified one as a read would have to delete a line here saying it is not.
  for (const method of ['chat.postMessage', 'files.completeUploadExternal', 'reactions.add']) {
    assert.equal(methodRule(method)?.kind, 'write', method);
  }
  assert.ok(writeMethods().includes('chat.postMessage'));
  assert.equal(writeMethods().includes('auth.test'), false);
});
