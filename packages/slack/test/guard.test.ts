import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommsError } from '@agentcomms/core';
import { closedPermit, guardSlackRequests, spendOn } from '../src/api/guard.ts';
import {
  classifiedMethods,
  methodOfUrl,
  methodRule,
  scopesFor,
  unscopedMethods,
  writeMethods,
} from '../src/api/methods.ts';

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
  await assert.rejects(fetch('https://evil.test/collect'), /only calls https:\/\/slack\.com/);
  // The right host, a path that names no method.
  await assert.rejects(fetch('https://slack.com/oauth/v2/authorize'), /only calls the Slack Web API/);
});

test('the host is checked, not just the path that names the method', async () => {
  /*
   * The method name is the *last path segment*, and any host in the world can offer that path. This guard read
   * the path and never the host, so `https://evil.example/api/auth.test` classified as a read and went out —
   * with the workspace's token attached to it. The error message already claimed "this package only calls the
   * Slack Web API"; it was aspiration rather than enforcement.
   */
  const { calls, inner } = recorder();
  const fetch = guardSlackRequests(inner, closedPermit());

  for (const url of [
    'https://evil.example/api/auth.test',
    'http://127.0.0.1:9/api/auth.test',
    // Starts with the right characters and is a different site — which is why this compares parsed origins
    // rather than a prefix.
    'https://slack.com.attacker.net/api/auth.test',
    // Right host, wrong scheme. A token must not go out in clear.
    'http://slack.com/api/auth.test',
    'https://slack.com:8443/api/auth.test',
  ]) {
    await assert.rejects(fetch(url), /only calls https:\/\/slack\.com/, url);
  }
  assert.deepEqual(calls, [], 'a request reached the inner fetch despite the wrong origin');

  // The error names the origin and nothing else: a query string can carry a token.
  await assert.rejects(fetch('https://evil.example/api/auth.test?token=xoxp-secret'), (error: CommsError) => {
    assert.doesNotMatch(error.message, /xoxp-secret/, 'the refusal quoted the query back');
    return true;
  });
});

test('there is no way to tell the guard to accept another origin', async () => {
  /*
   * The first version of this made the origin an argument defaulting to Slack's, reasoning that the check still
   * always ran and only its target moved. The type was exported from the package root, so any caller could name
   * any origin — which is the production override it claimed not to be.
   *
   * A test reaches a fake Slack by rewriting the URL in the **inner** fetch, after the guard has already
   * approved the real one. The guard never sees the fake origin, and nothing it exports can move it.
   */
  const seen: string[] = [];
  const fake = 'http://127.0.0.1:65535';
  const rewritingInner: typeof globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Only ever a URL the guard has already validated as Slack's.
    assert.ok(url.startsWith('https://slack.com/'), url);
    seen.push(url.replace('https://slack.com', fake));
    return new Response('{"ok":true}');
  };

  const fetch = guardSlackRequests(rewritingInner, closedPermit());
  await fetch('https://slack.com/api/auth.test');
  assert.deepEqual(seen, [`${fake}/api/auth.test`], 'the inner fetch is where a test redirects, not the guard');

  // And the guard itself takes no second argument that could relax it.
  assert.equal(guardSlackRequests.length, 2, 'guardSlackRequests grew a parameter that could move the origin');
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
    assert.ok(['read', 'write', 'auth', 'prepare', 'refused'].includes(rule.kind), `${method} is ${rule.kind}`);
    if (rule.kind === 'refused') assert.ok(rule.note, `${method} is refused without saying why`);
  }

  // Every write says which scope it needs, so the manifest can be checked against this table rather than
  // against a second one somebody keeps in step by hand. A write with no scope recorded is a write nobody
  // checked, and `requiredScopes` would hide it by returning the others.
  assert.deepEqual(unscopedMethods(), [], 'a method that reaches Slack has no required scope recorded');
  assert.deepEqual(scopesFor(['write', 'prepare']), ['chat:write', 'files:write', 'reactions:write']);

  /*
   * Getting an upload URL publishes nothing, and must not spend the one-shot permit.
   *
   * Classified `write`, the preparation consumed the approval and `files.completeUploadExternal` — the call that
   * makes the file visible — found the door shut. The gate would have blocked the post and allowed the upload.
   */
  assert.equal(methodRule('files.getUploadURLExternal')?.kind, 'prepare');
  assert.equal(methodRule('files.completeUploadExternal')?.kind, 'write');

  // A scope field that held one string could not describe `conversations.history`, which takes any of four.
  assert.ok(Array.isArray(methodRule('chat.postMessage')?.requiredScopes));

  // Getting a token is neither a read nor a write: there is no approval to attach a permit to, and no account
  // token to carry, because these are the calls that produce the credential.
  assert.equal(methodRule('oauth.v2.user.access')?.kind, 'auth');
  assert.equal(writeMethods().includes('oauth.v2.user.access'), false);

  // `team.info` is gone: it needed `team:read`, a scope neither manifest otherwise wants, to return what
  // `auth.test` already returns.
  assert.equal(methodRule('team.info'), null);

  // The four write paths the design enumerated are all classified as writes, by name. A future edit that
  // reclassified one as a read would have to delete a line here saying it is not.
  for (const method of ['chat.postMessage', 'files.completeUploadExternal', 'reactions.add']) {
    assert.equal(methodRule(method)?.kind, 'write', method);
  }
  assert.ok(writeMethods().includes('chat.postMessage'));
  assert.equal(writeMethods().includes('auth.test'), false);
});

test('preparing an upload does not spend the permit the publish needs', async () => {
  /*
   * The two-call file flow: ask Slack where to put the bytes, then name a channel and make it visible. Only the
   * second is a post. Classified `write`, the first one consumed the one-shot permit and the second was refused
   * — the gate blocking the publish while waving the upload through.
   */
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await spendOn(permit, 'apr_1', 'files.completeUploadExternal', async () => {
    await fetch(`${API}/files.getUploadURLExternal`);
    await fetch(`${API}/files.completeUploadExternal`);
  });

  assert.deepEqual(
    calls.map((c) => c.split('/api/')[1]),
    ['files.getUploadURLExternal', 'files.completeUploadExternal'],
  );
});

test('the token exchange passes with a closed permit, because it is not a write', async () => {
  /*
   * The exchange goes through this guard rather than calling `fetch` directly, so that "the one door every Slack
   * request goes through" is true rather than nearly true. That only works if `auth` methods are reachable with
   * no permit open — which is almost always, since a permit exists only around a send.
   */
  const calls: string[] = [];
  const fetch = guardSlackRequests(async (input) => {
    calls.push(String(input));
    return new Response('{}');
  }, closedPermit());

  await fetch(`${API}/oauth.v2.access`);
  assert.deepEqual(calls, [`${API}/oauth.v2.access`]);
});

test('a redirect is refused rather than followed to an address nothing checked', async () => {
  /*
   * Everything this guard does validates the URL in hand. `fetch` then follows a 30x wherever it points, and the
   * header carrying a workspace token travels with it unless the runtime decides otherwise — which is not ours
   * to rely on. The Slack Web API does not redirect, so one here is a mistake or somebody's idea.
   */
  let seen: RequestInit | undefined;
  const fetch = guardSlackRequests(async (_input, init) => {
    seen = init;
    return new Response('{}');
  }, closedPermit());

  await fetch(`${API}/auth.test`);
  assert.equal(seen?.redirect, 'error');

  // And it is not something a caller can hand back the other way.
  await fetch(`${API}/auth.test`, { redirect: 'follow' });
  assert.equal(seen?.redirect, 'error', 'a caller turned redirect-following back on');
});

test('the package root does not hand out the key to its own door', async () => {
  /*
   * This exported `guardSlackRequests`, `closedPermit` and `spendOn`, so anything importing the package could
   * mint a permit and open the door the guard exists to keep shut. A boundary whose key is part of the public
   * API is not a boundary.
   */
  const surface = (await import('../src/index.ts')) as Record<string, unknown>;
  for (const name of ['guardSlackRequests', 'closedPermit', 'spendOn', 'WritePermit']) {
    assert.equal(surface[name], undefined, `${name} is exported from the package root`);
  }
  // The method registry stays: knowing a method's name grants nothing, and it is worth reading.
  assert.equal(typeof surface.methodRule, 'function');
});

test('reading the method out of a URL is linear, even on a path made of slashes', () => {
  /*
   * This used `/\/+$/` to collapse trailing slashes. An unanchored regex tries it from every position in a run of
   * slashes, so a long run that does not end the string is quadratic — flagged by code scanning, on the one
   * function every Slack request passes through.
   *
   * Timed rather than argued. Measured under the old regex: 5,000 slashes 37ms, 10,000 159ms, 20,000 607ms —
   * doubling the input quadrupled the time. 40,000 took about 2.4 seconds there and must now take
   * milliseconds; sized to fail this test by name rather than by timing out the whole file.
   */
  const hostile = `https://slack.com/${'/'.repeat(40_000)}x`;
  const started = performance.now();
  assert.equal(methodOfUrl(hostile), null);
  assert.ok(performance.now() - started < 250, `methodOfUrl took ${Math.round(performance.now() - started)}ms`);
});

test('the method is still read the way it was: the last segment, when the one before is `api`', () => {
  // Rewriting a guard is how a guard changes meaning; these are the shapes it has to keep answering the same way.
  const cases: [string, string | null][] = [
    ['https://slack.com/api/auth.test', 'auth.test'],
    ['https://slack.com/api/auth.test/', 'auth.test'],
    ['https://slack.com/api/auth.test///', 'auth.test'],
    ['https://slack.com/api/chat.postMessage?channel=C1', 'chat.postMessage'],
    ['https://slack.com/api/', null],
    ['https://slack.com/api', null],
    ['https://slack.com/xapi/auth.test', null],
    ['https://slack.com/oauth/v2/authorize', null],
    ['https://slack.com/api/auth.test/extra', null],
  ];
  for (const [url, expected] of cases) assert.equal(methodOfUrl(url), expected, url);
});
