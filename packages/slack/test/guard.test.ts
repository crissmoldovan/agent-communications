import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommsError } from '@agentcomms/core';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API as TypeScriptAPI } from 'typescript/unstable/sync';
import { callSlack } from '../src/api/call.ts';
import {
  closedPermit,
  configureWith,
  downloadWith,
  type FetchLike,
  guardSlackRequests,
  type RevokeBinding,
  revokeWith,
  spendOn,
  uploadWith,
} from '../src/api/guard.ts';
import {
  classifiedMethods,
  FILE_DOWNLOAD,
  fileOfPath,
  isUploadPath,
  methodOfUrl,
  methodRule,
  SLACK_FILES_ORIGIN,
  scopesFor,
  unscopedMethods,
  writeMethods,
} from '../src/api/methods.ts';
import { slackFileUpload } from '../src/api/upload.ts';
import { startFakeSlack } from './support/fake-slack.ts';

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

function revokeBinding(token = 'fake-old-access'): RevokeBinding {
  return {
    ref: 'slack/token/superseded',
    kind: 'access',
    tokenSha256: createHash('sha256').update(token).digest('hex'),
  };
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

test('auth.revoke has its own class and cannot leave without a dedicated grant', async () => {
  const { calls, inner } = recorder();
  const fetch = guardSlackRequests(inner, closedPermit());
  assert.equal(methodRule('auth.revoke')?.kind, 'revoke');
  await assert.rejects(fetch(`${API}/auth.revoke`), /no revocation grant is open/);
  assert.deepEqual(calls, []);
});

test('a revocation grant binds one request to its ref, token kind and bearer digest, then is spent', async () => {
  const token = 'fake-old-access';
  const digest = createHash('sha256').update(token).digest('hex');
  const binding = revokeBinding(token);
  const permit = closedPermit();
  const calls: string[] = [];
  const inner: FetchLike = async (input) => {
    calls.push(String(input));
    assert.equal((permit as unknown as { revoking: unknown }).revoking, null, 'the request left before consumption');
    return new Response('{"ok":true,"revoked":true}');
  };
  const fetch = guardSlackRequests(inner, permit, binding);

  await revokeWith(permit, 'auth.revoke', binding, async () => {
    const open = (permit as unknown as { revoking: RevokeBinding | null }).revoking;
    assert.deepEqual(open, binding);
    assert.equal(Object.isFrozen(open), true, 'the ref or token kind could be changed while the grant was open');
    for (const [identity, bearer, reason] of [
      [{ ...binding, ref: 'slack/token/another-entry' }, token, 'wrong ref'],
      [{ ...binding, kind: 'refresh' as const }, token, 'wrong kind'],
      [binding, 'fake-wrong-bearer', 'wrong digest'],
      [undefined, token, 'missing identity'],
    ] as const) {
      await assert.rejects(
        guardSlackRequests(
          inner,
          permit,
          identity,
        )(`${API}/auth.revoke`, {
          headers: { authorization: `Bearer ${bearer}` },
        }),
        (error: CommsError) => {
          assert.equal(error.code, 'SEND_REFUSED', reason);
          const rendered = JSON.stringify(error);
          for (const secret of [token, bearer, digest, createHash('sha256').update(bearer).digest('hex')]) {
            assert.equal(rendered.includes(secret), false, 'a bearer or digest appeared in the refusal');
          }
          return true;
        },
        reason,
      );
      assert.deepEqual(calls, [], `${reason} reached the inner request`);
      assert.deepEqual(permit.revoking, binding, `${reason} consumed the grant`);
    }
    await fetch(`${API}/auth.revoke`, { headers: { authorization: `Bearer ${token}` } });
    await assert.rejects(
      fetch(`${API}/auth.revoke`, { headers: { authorization: `Bearer ${token}` } }),
      /no revocation grant is open/,
    );
  });

  assert.deepEqual(calls, [`${API}/auth.revoke`]);
  assert.equal((permit as unknown as { revoking: unknown }).revoking, null);
  const rendered = JSON.stringify(permit);
  assert.doesNotMatch(rendered, new RegExp(token));
  assert.doesNotMatch(rendered, new RegExp(digest));
});

for (const field of ['ref', 'kind'] as const) {
  test(`a revocation with the right bearer and wrong ${field} is refused before dispatch`, async () => {
    const token = 'fake-old-access';
    const binding = revokeBinding(token);
    const identity = { ...binding, [field]: field === 'ref' ? 'slack/token/another-entry' : 'refresh' };
    const { calls, inner } = recorder();
    const permit = closedPermit();
    await revokeWith(permit, 'auth.revoke', binding, async () => {
      await assert.rejects(
        guardSlackRequests(
          inner,
          permit,
          identity,
        )(`${API}/auth.revoke`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        (error: CommsError) => error.code === 'SEND_REFUSED',
      );
    });
    assert.deepEqual(calls, []);
  });
}

test('a revocation grant refuses the wrong bearer without exposing the token or either digest', async () => {
  const expected = 'fake-old-access';
  const wrong = 'fake-another-token';
  const binding = revokeBinding(expected);
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit, binding);

  await revokeWith(permit, 'auth.revoke', binding, async () => {
    await assert.rejects(
      fetch(`${API}/auth.revoke`, { headers: { authorization: `Bearer ${wrong}` } }),
      (error: CommsError) => {
        const rendered = JSON.stringify(error);
        for (const secret of [expected, wrong, binding.tokenSha256, createHash('sha256').update(wrong).digest('hex')]) {
          assert.equal(rendered.includes(secret), false, 'a bearer or its digest appeared in the refusal');
        }
        return true;
      },
    );
  });
  assert.deepEqual(calls, []);
});

test('a revocation grant refuses a wrong method and every empty identity before running its body', async () => {
  const permit = closedPermit();
  let ran = false;
  await assert.rejects(
    revokeWith(permit, 'auth.test', revokeBinding(), async () => {
      ran = true;
    }),
    /not a token revocation method/,
  );
  for (const binding of [
    { ...revokeBinding(), ref: '' },
    { ...revokeBinding(), kind: '' as 'access' },
    { ...revokeBinding(), tokenSha256: '' },
  ]) {
    await assert.rejects(
      revokeWith(permit, 'auth.revoke', binding, async () => {
        ran = true;
      }),
      /names one pending ref, token kind and bearer digest/,
    );
  }
  assert.equal(ran, false);
});

test('a revocation grant does not nest with any existing grant', async () => {
  const binding = revokeBinding();
  const nested = async (permit: ReturnType<typeof closedPermit>) =>
    assert.rejects(
      revokeWith(permit, 'auth.revoke', binding, async () => undefined),
      /already open/,
    );

  const posting = closedPermit();
  await spendOn(posting, 'ap_1', 'chat.postMessage', () => nested(posting));
  const configuring = closedPermit();
  await configureWith(configuring, 'apps.manifest.update', () => nested(configuring));
  const downloading = closedPermit();
  await downloadWith(downloading, { teamId: 'T0AAA1', fileId: 'F0BBB2' }, () => nested(downloading));
  const uploading = closedPermit();
  await spendOn(uploading, 'ap_2', 'files.completeUploadExternal', () =>
    uploadWith(uploading, `${SLACK_FILES_ORIGIN}/upload/one`, () => nested(uploading)),
  );
  const revoking = closedPermit();
  await revokeWith(revoking, 'auth.revoke', binding, async () => {
    await nested(revoking);
    await assert.rejects(
      spendOn(revoking, 'ap_3', 'chat.postMessage', async () => undefined),
      /already open/,
    );
    await assert.rejects(
      configureWith(revoking, 'apps.manifest.update', async () => undefined),
      /already open/,
    );
    await assert.rejects(
      downloadWith(revoking, { teamId: 'T0AAA1', fileId: 'F0BBB2' }, async () => undefined),
      /already open/,
    );
    await assert.rejects(
      uploadWith(revoking, `${SLACK_FILES_ORIGIN}/upload/two`, async () => undefined),
      /approved post/,
    );
  });
});

test('a revocation grant refuses an upload still open after its publishing permit was consumed', async () => {
  const permit = closedPermit();
  const { calls, inner } = recorder();
  const fetch = guardSlackRequests(inner, permit);
  await spendOn(permit, 'ap_1', 'files.completeUploadExternal', () =>
    uploadWith(permit, `${SLACK_FILES_ORIGIN}/upload/one`, async () => {
      await fetch(`${API}/files.completeUploadExternal`, { method: 'POST' });
      assert.equal(permit.approvalId, null);
      assert.notEqual(permit.uploading, null);
      await assert.rejects(
        revokeWith(permit, 'auth.revoke', revokeBinding(), async () => {
          assert.fail('revocation entered while an upload grant remained open');
        }),
        /already open/,
      );
    }),
  );
  assert.deepEqual(calls, [`${API}/files.completeUploadExternal`]);
});

test('a revocation grant closes in finally even when no request was made', async () => {
  const permit = closedPermit();
  await assert.rejects(
    revokeWith(permit, 'auth.revoke', revokeBinding(), async () => {
      throw new Error('stopped before dispatch');
    }),
    /stopped before dispatch/,
  );
  assert.equal((permit as unknown as { revoking: unknown }).revoking, null);
});

test('a method refused by design says why, and the reason travels with the error', async () => {
  const fetch = guardSlackRequests(recorder().inner, closedPermit());
  await assert.rejects(fetch(`${API}/conversations.mark`), /not worth a write scope/);
  await assert.rejects(fetch(`${API}/chat.postEphemeral`), /nobody else can see/);
  await assert.rejects(fetch(`${API}/apps.connections.open`), /Socket Mode/);
});

test('anything that is not the Slack Web API is refused outright', async () => {
  const { calls, inner } = recorder();
  const fetch = guardSlackRequests(inner, closedPermit());
  await assert.rejects(fetch('https://evil.test/collect'), /only calls https:\/\/slack\.com/);
  // The right host, a path that names no method.
  await assert.rejects(fetch('https://slack.com/oauth/v2/authorize'), /only calls the Slack Web API/);
  /*
   * The two hosts do not lend each other their paths. A file's path at the API host names no method, and an API path
   * at the files host names no file — even with a download open for exactly that file.
   */
  const permit = closedPermit();
  const guarded = guardSlackRequests(inner, permit);
  await downloadWith(permit, { teamId: 'T0AAA1', fileId: 'F0BBB2' }, async () => {
    await assert.rejects(guarded('https://slack.com/files-pri/T0AAA1-F0BBB2/a.pdf'), /only calls the Slack Web API/);
    await assert.rejects(guarded(`${SLACK_FILES_ORIGIN}/api/auth.test`), /not the path of the file/);
  });
  assert.deepEqual(calls, []);
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
  // The right origin with credentials in the URL: a second credential on the request that nothing here chose.
  for (const url of ['https://someone@slack.com/api/auth.test', 'https://someone:pw@slack.com/api/auth.test']) {
    await assert.rejects(fetch(url), /carrying credentials/, url);
  }
  assert.deepEqual(calls, [], 'a request reached the inner fetch despite the wrong origin');

  /*
   * The files host is the second origin, and exactly that one. Its near misses are refused as any other host is —
   * inside a download grant for the very file their paths name, so it is the host that refuses them and nothing else.
   */
  const permit = closedPermit();
  const files = guardSlackRequests(inner, permit);
  await downloadWith(permit, { teamId: 'T0AAA1', fileId: 'F0BBB2' }, async () => {
    for (const url of [
      'https://files.slack.com.attacker.net/files-pri/T0AAA1-F0BBB2/a.pdf',
      'http://files.slack.com/files-pri/T0AAA1-F0BBB2/a.pdf',
      'https://files.slack.com:8443/files-pri/T0AAA1-F0BBB2/a.pdf',
      'https://files-edge.slack.com/files-pri/T0AAA1-F0BBB2/a.pdf',
      'https://slack-files.com/files-pri/T0AAA1-F0BBB2/a.pdf',
      'https://evil.example/files-pri/T0AAA1-F0BBB2/a.pdf',
    ]) {
      await assert.rejects(files(url), /only calls https:\/\/slack\.com and https:\/\/files\.slack\.com/, url);
    }
    assert.notEqual(permit.downloading, null, 'a refused host spent the grant');
  });
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

  const fetch = guardSlackRequests(rewritingInner, closedPermit(), { ref: fake, kind: 'access' });
  await assert.rejects(fetch(`${fake}/api/auth.test`), /this package only calls/);
  await fetch('https://slack.com/api/auth.test');
  assert.deepEqual(seen, [`${fake}/api/auth.test`], 'the inner fetch is where a test redirects, not the guard');

  // The third parameter is only the local revocation identity; even a URL there cannot move the origin.
  assert.equal(guardSlackRequests.length, 3, 'guardSlackRequests grew an unaudited parameter');
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
    assert.ok(
      ['read', 'write', 'auth', 'prepare', 'configure', 'revoke', 'refused'].includes(rule.kind),
      `${method} is ${rule.kind}`,
    );
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

  /*
   * A download is a rule, and not a row of the method table: nothing at the API host can classify as one, so no
   * `/api/…` path reaches the files branch of the guard, and the name a download is audited under is not a method.
   */
  for (const method of methods) assert.notEqual(methodRule(method)?.kind, 'download', method);
  assert.equal(methodRule('files.download'), null);
  assert.equal(FILE_DOWNLOAD.kind, 'download');
  assert.deepEqual(scopesFor(['download']), ['files:read']);

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

test('a download is not followed through a redirect either, whatever the caller asks', async () => {
  /*
   * It matters more here than at the API: the download carries the token, and the address a 30x names is chosen by
   * whatever answered, not by the path the guard just checked.
   */
  const seen: (RequestInit | undefined)[] = [];
  const permit = closedPermit();
  const fetch = guardSlackRequests(async (_input, init) => {
    seen.push(init);
    return new Response('bytes');
  }, permit);
  const asked = [undefined, 'follow', 'manual'] as const;
  for (const redirect of asked) {
    await downloadWith(permit, { teamId: 'T0AAA1', fileId: 'F0BBB2' }, () =>
      fetch(`${SLACK_FILES_ORIGIN}/files-pri/T0AAA1-F0BBB2/download/a.pdf`, redirect ? { redirect } : {}),
    );
  }
  assert.deepEqual(
    seen.map((init) => init?.redirect),
    asked.map(() => 'error'),
    'a download went out with a redirect mode a caller chose',
  );
});

test('the package root does not hand out the key to its own door', async () => {
  /*
   * This exported `guardSlackRequests`, `closedPermit` and `spendOn`, so anything importing the package could
   * mint a permit and open the door the guard exists to keep shut. A boundary whose key is part of the public
   * API is not a boundary.
   */
  const surface = (await import('../src/index.ts')) as Record<string, unknown>;
  for (const name of [
    'guardSlackRequests',
    'closedPermit',
    'spendOn',
    'configureWith',
    'revokeWith',
    'downloadWith',
    'uploadWith',
    'WritePermit',
    // The download itself: it carries a token to the files host, and only this package's own operation calls it.
    'slackFileDownload',
    'checkedFileUrl',
    // And the upload: it carries a token and a file's bytes there, and only the gate calls it, inside a post.
    'slackFileUpload',
  ]) {
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

// ── App configuration: on the allowlist, behind a grant of its own ─────────────────────────────────────────────

const CONFIGURE = ['apps.manifest.validate', 'apps.manifest.update', 'apps.manifest.create'];

test('the app-configuration methods are classified as exactly that, and the rest of the family is refused', () => {
  /*
   * On the allowlist deliberately, as `configure` rather than `read`: a read is reachable by anything in this package,
   * and these rewrite an app. Deleting an app and rotating a configuration token are listed as refused, so the
   * decision is recorded rather than implied by their absence.
   */
  for (const method of CONFIGURE) assert.equal(methodRule(method)?.kind, 'configure', method);
  assert.equal(methodRule('apps.manifest.delete')?.kind, 'refused');
  assert.equal(methodRule('tooling.tokens.rotate')?.kind, 'refused');
  assert.equal(methodRule('apps.manifest.export'), null);

  // Nothing about posting moved: the same writes, the same scopes, and no configuration method among the writes.
  assert.deepEqual(writeMethods(), [
    'chat.delete',
    'chat.deleteScheduledMessage',
    'chat.meMessage',
    'chat.postMessage',
    'chat.scheduleMessage',
    'chat.update',
    'files.completeUploadExternal',
    'reactions.add',
    'reactions.remove',
  ]);
  assert.deepEqual(scopesFor(['write', 'prepare']), ['chat:write', 'files:write', 'reactions:write']);
  assert.deepEqual(scopesFor(['configure']), [], 'a configuration scope would end up in a manifest');
});

test('an app-configuration method is refused without a grant, whatever token rides on it', async () => {
  const { calls, inner } = recorder();
  const fetch = guardSlackRequests(inner, closedPermit());
  for (const method of CONFIGURE) {
    await assert.rejects(fetch(`${API}/${method}`), /only this package's `app` commands may call it/, method);
    await assert.rejects(fetch(`${API}/${method}?pretty=1`), /only this package's `app` commands may call it/, method);
  }
  assert.equal(calls.length, 0);
});

test('a workspace session cannot reach apps.manifest.update, because nothing on its path opens a grant', async () => {
  // `callSlack` with no permit is how every read goes out. It must meet the same door, before the network.
  const { calls, inner } = recorder();
  for (const method of CONFIGURE) {
    await assert.rejects(
      callSlack({ token: 'fake-user-token', fetch: inner, baseUrl: 'https://slack.com' }, method, { manifest: '{}' }),
      /only this package's `app` commands may call it/,
    );
  }
  assert.equal(calls.length, 0);
});

test('a configuration grant opens one request of one method, and closes behind it', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await configureWith(permit, 'apps.manifest.validate', async () => {
    // A grant for validation is not a grant for the update.
    await assert.rejects(fetch(`${API}/apps.manifest.update`), /only this package's `app` commands may call it/);
    await fetch(`${API}/apps.manifest.validate`);
    // Spent: a second request inside the same grant finds the door shut.
    await assert.rejects(fetch(`${API}/apps.manifest.validate`), /only this package's `app` commands may call it/);
  });
  assert.deepEqual(calls, [`${API}/apps.manifest.validate`]);
  assert.equal(permit.configuring, null);
  await assert.rejects(fetch(`${API}/apps.manifest.validate`), /only this package's `app` commands may call it/);
});

test('a configuration grant opens no post, and a post’s permit opens no configuration', async () => {
  /*
   * The two openings sit on one permit object and must lend each other nothing. Inside a configuration grant a post
   * is refused exactly as it always was — no approval is open — and inside a post's permit an app cannot be changed.
   */
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await configureWith(permit, 'apps.manifest.update', async () => {
    for (const method of ['chat.postMessage', 'files.completeUploadExternal', 'reactions.add']) {
      await assert.rejects(fetch(`${API}/${method}`), /no approval is open/, method);
    }
  });
  await spendOn(permit, 'ap_1', 'chat.postMessage', async () => {
    await assert.rejects(fetch(`${API}/apps.manifest.update`), /only this package's `app` commands may call it/);
    // And a grant cannot be opened inside a post's permit either.
    await assert.rejects(
      configureWith(permit, 'apps.manifest.update', async () => undefined),
      /already open; they do not nest/,
    );
  });
  assert.deepEqual(calls, []);
});

test('a configuration grant cannot be opened for anything that is not an app-configuration method', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);
  for (const method of ['chat.postMessage', 'auth.test', 'apps.manifest.delete', 'apps.uninstall', 'nonsense']) {
    await assert.rejects(
      configureWith(permit, method, async () => fetch(`${API}/${method}`)),
      /not a method that configures a Slack app/,
      method,
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(permit.configuring, null);
});

test('a configuration grant closes when the call inside it throws, and grants do not nest', async () => {
  const { inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);
  await assert.rejects(
    configureWith(permit, 'apps.manifest.update', async () => {
      throw new Error('network died mid-update');
    }),
    /network died/,
  );
  assert.equal(permit.configuring, null, 'a failed update left a grant open behind it');
  await assert.rejects(fetch(`${API}/apps.manifest.update`), /only this package's `app` commands may call it/);

  await assert.rejects(
    configureWith(permit, 'apps.manifest.validate', async () =>
      configureWith(permit, 'apps.manifest.update', async () => undefined),
    ),
    /already open; they do not nest/,
  );
  assert.equal(permit.configuring, null);
});

// ── Files: one more origin, for one file's bytes ──────────────────────────────────────────────────────────────

const TEAM = 'T0AAA1';
const FILE = 'F0BBB2';
const FILE_URL = `${SLACK_FILES_ORIGIN}/files-pri/${TEAM}-${FILE}/download/report.pdf`;

/** The reason a download refusal carries, which is what the download operation reports a skipped file by. */
function reasonOf(error: unknown): unknown {
  return error instanceof CommsError ? error.details?.reason : undefined;
}

test('files.slack.com is shut outside a download grant, whatever the path', async () => {
  const { calls, inner } = recorder();
  const fetch = guardSlackRequests(inner, closedPermit());
  for (const url of [
    FILE_URL,
    `${SLACK_FILES_ORIGIN}/files-pri/${TEAM}-${FILE}/report.pdf`,
    `${SLACK_FILES_ORIGIN}/`,
  ]) {
    await assert.rejects(fetch(url), (error: unknown) => {
      assert.match(String((error as Error).message), /no download is open/, url);
      assert.equal(reasonOf(error), 'wrong-path', url);
      return true;
    });
  }
  assert.deepEqual(calls, []);
});

test('a download grant opens one GET of that file’s path, and closes behind it', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  // Both links `files.info` returns: `url_private_download`, then `url_private`.
  const plain = `${SLACK_FILES_ORIGIN}/files-pri/${TEAM}-${FILE}/report.pdf`;
  for (const url of [FILE_URL, plain]) {
    await downloadWith(permit, { teamId: TEAM, fileId: FILE }, async () => {
      await fetch(url);
      // Spent: a second fetch inside the same grant finds the door shut.
      await assert.rejects(fetch(url), /no download is open/);
    });
  }
  assert.deepEqual(calls, [FILE_URL, plain]);
  assert.equal(permit.downloading, null);
  await assert.rejects(fetch(FILE_URL), /no download is open/);
  assert.equal(calls.length, 2);
});

test('every near miss of a download is refused, with a reason, and none of them spends the grant', async () => {
  /*
   * The allowance is one path shape at one host for one file, fetched one way. Each of these is one step away from
   * it. All of them are tried inside a single grant, and the right request still goes out at the end — so each was
   * refused for what it got wrong, not because an earlier one used the grant up.
   */
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);
  const at = (path: string): string => `${SLACK_FILES_ORIGIN}${path}`;
  const notThePath = /not the path of the file/;
  const cases: [string, RequestInit | undefined, RegExp, string][] = [
    // Another team, another file, either way round, or one that merely starts or ends the same.
    [at(`/files-pri/T0ZZZ9-${FILE}/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-F0ZZZ9/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${FILE}-${TEAM}/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}X/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/X${TEAM}-${FILE}/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}-F0CCC3/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM.toLowerCase()}-${FILE.toLowerCase()}/report.pdf`), undefined, notThePath, 'wrong-path'],
    // Other paths on the host: a thumbnail, the bare directory, deeper, or an API path.
    [at(`/files-tmb/${TEAM}-${FILE}-abc123/report_360.png`), undefined, notThePath, 'wrong-path'],
    [at(`/files-tmb/${TEAM}-${FILE}/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pub/${TEAM}-${FILE}/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}/`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}/download/`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}/download/a/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}/other/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at('/api/auth.test'), undefined, notThePath, 'wrong-path'],
    // A way out of the file's directory for a server that decodes again, or dot segments the parser resolves.
    [at(`/files-pri/${TEAM}-${FILE}/download/..%2F..%2Fapi%2Fauth.test`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}/download/report%5Cx.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}/download/report%00.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}/../T0ZZZ9-${FILE}/report.pdf`), undefined, notThePath, 'wrong-path'],
    [at(`/files-pri/${TEAM}-${FILE}/%2e%2e/%2e%2e/api/auth.test`), undefined, notThePath, 'wrong-path'],
    // Anything but the path: a query, a fragment.
    [`${FILE_URL}?pub_secret=abc`, undefined, /by its path alone/, 'wrong-path'],
    [`${FILE_URL}#top`, undefined, /by its path alone/, 'wrong-path'],
    // Credentials in the URL.
    [FILE_URL.replace('https://', 'https://someone@'), undefined, /carrying credentials/, 'wrong-host'],
    [FILE_URL.replace('https://', 'https://someone:pw@'), undefined, /carrying credentials/, 'wrong-host'],
    // Any verb but GET.
    [FILE_URL, { method: 'POST' }, /fetched with GET, not POST/, 'wrong-path'],
    [FILE_URL, { method: 'post' }, /fetched with GET, not POST/, 'wrong-path'],
    [FILE_URL, { method: 'PUT' }, /fetched with GET, not PUT/, 'wrong-path'],
    [FILE_URL, { method: 'HEAD' }, /fetched with GET, not HEAD/, 'wrong-path'],
    [FILE_URL, { method: 'DELETE' }, /fetched with GET, not DELETE/, 'wrong-path'],
  ];

  await downloadWith(permit, { teamId: TEAM, fileId: FILE }, async () => {
    for (const [url, init, message, reason] of cases) {
      await assert.rejects(fetch(url, init), (error: unknown) => {
        assert.match(String((error as Error).message), message, url);
        assert.equal(reasonOf(error), reason, url);
        // The path is not repeated: its last segment is a name somebody in the workspace chose.
        assert.doesNotMatch(String((error as Error).message), /report/, url);
        return true;
      });
      assert.deepEqual(permit.downloading, { teamId: TEAM, fileId: FILE }, `${url} spent the grant`);
    }
    // A Request carrying its own verb meets the same rule as an init that names one.
    await assert.rejects(fetch(new Request(FILE_URL, { method: 'POST', body: 'x' })), /fetched with GET, not POST/);
    await fetch(FILE_URL);
  });
  assert.deepEqual(calls, [FILE_URL], 'a near miss reached the inner fetch');
});

test('a download grant lends nothing, borrows nothing, and does not nest', async () => {
  /*
   * The third opening on the same permit object, and like the other two it opens only itself. Inside a download a
   * post and an app change are refused as they always were; inside a post or an app change the files host is shut;
   * and no grant opens inside another.
   */
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await downloadWith(permit, { teamId: TEAM, fileId: FILE }, async () => {
    await assert.rejects(fetch(`${API}/chat.postMessage`), /no approval is open/);
    await assert.rejects(fetch(`${API}/apps.manifest.update`), /only this package's `app` commands may call it/);
    await assert.rejects(
      downloadWith(permit, { teamId: TEAM, fileId: 'F0CCC3' }, async () => undefined),
      /already open; they do not nest/,
    );
    await assert.rejects(
      spendOn(permit, 'ap_1', 'chat.postMessage', async () => undefined),
      /already open; they do not nest/,
    );
    await assert.rejects(
      configureWith(permit, 'apps.manifest.update', async () => undefined),
      /already open; they do not nest/,
    );
    assert.deepEqual(permit.downloading, { teamId: TEAM, fileId: FILE }, 'a refused opening closed the grant');
  });
  await spendOn(permit, 'ap_1', 'chat.postMessage', async () => {
    await assert.rejects(fetch(FILE_URL), /no download is open/);
    await assert.rejects(
      downloadWith(permit, { teamId: TEAM, fileId: FILE }, async () => undefined),
      /already open; they do not nest/,
    );
  });
  await configureWith(permit, 'apps.manifest.update', async () => {
    await assert.rejects(fetch(FILE_URL), /no download is open/);
    await assert.rejects(
      downloadWith(permit, { teamId: TEAM, fileId: FILE }, async () => undefined),
      /already open; they do not nest/,
    );
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(permit, closedPermit());
});

test('a download grant names one Slack team and one Slack file, or it does not open', async () => {
  /*
   * `<TEAM>-<FILEID>` reads one way only because neither id can hold a `-` or a `/`. A grant for `T1-F2` and `F3`
   * would match the path of a different file than either names.
   */
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);
  const bad: [string, string][] = [
    [`${TEAM}-F0CCC3`, FILE],
    [TEAM, `${FILE}-F0CCC3`],
    [TEAM, `${FILE}/x`],
    [`${TEAM}/files-pri`, FILE],
    [TEAM.toLowerCase(), FILE],
    ['', FILE],
    [TEAM, ''],
    [TEAM, `F${'0'.repeat(40)}`],
    ['0AAA1', FILE],
  ];
  for (const [teamId, fileId] of bad) {
    await assert.rejects(
      downloadWith(permit, { teamId, fileId }, () => fetch(FILE_URL)),
      (error: unknown) => {
        assert.match(String((error as Error).message), /names one Slack team id and one Slack file id/);
        assert.equal(reasonOf(error), 'wrong-path');
        return true;
      },
      `${teamId} / ${fileId}`,
    );
    assert.equal(permit.downloading, null);
  }
  assert.deepEqual(calls, []);
});

test('a download grant closes when what runs inside it throws', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);
  await assert.rejects(
    downloadWith(permit, { teamId: TEAM, fileId: FILE }, async () => {
      throw new Error('network died before the request');
    }),
    /network died/,
  );
  assert.equal(permit.downloading, null, 'a failed download left a grant open behind it');
  await assert.rejects(fetch(FILE_URL), /no download is open/);
  assert.deepEqual(calls, []);
});

test('callSlack stays the Web API: pointed at the files host it is refused, grant or no grant', async () => {
  /*
   * `callSlack` builds `/api/<method>` on its base URL. The files host is now an origin the guard serves, so this is
   * the test that `callSlack` did not become a second way onto it: no `/api/` path is a file's path.
   */
  const { calls, inner } = recorder();
  await assert.rejects(
    callSlack({ token: 'fake-user-token', fetch: inner, baseUrl: SLACK_FILES_ORIGIN }, 'files.info', { file: FILE }),
    /no download is open/,
  );
  // Inside a grant for a real file it is still refused: every Web API call is a POST, and the files host takes GET.
  const permit = closedPermit();
  await downloadWith(permit, { teamId: TEAM, fileId: FILE }, async () => {
    await assert.rejects(
      callSlack({ token: 'fake-user-token', fetch: inner, baseUrl: SLACK_FILES_ORIGIN, permit }, 'files.info'),
      /fetched with GET, not POST/,
    );
  });
  assert.deepEqual(calls, []);
});

test('the path of a file is read in two shapes only', () => {
  const cases: [string, { teamId: string; fileId: string } | null][] = [
    [`/files-pri/${TEAM}-${FILE}/report.pdf`, { teamId: TEAM, fileId: FILE }],
    [`/files-pri/${TEAM}-${FILE}/download/report.pdf`, { teamId: TEAM, fileId: FILE }],
    // A file called `download` is still a file.
    [`/files-pri/${TEAM}-${FILE}/download`, { teamId: TEAM, fileId: FILE }],
    [`/files-pri/E0GRID1-${FILE}/r%C3%A9sum%C3%A9.pdf`, { teamId: 'E0GRID1', fileId: FILE }],
    [`/files-pri/${TEAM}-${FILE}/download/.`, null],
    [`/files-pri/${TEAM}-${FILE}/download/..`, null],
    [`/files-pri/${TEAM}-${FILE}/download/%2E%2E`, null],
    [`/files-pri/${TEAM}-${FILE}/download/%E0%A4%A`, null],
    [`/files-pri/${TEAM}-${FILE}/download/a%2fb`, null],
    [`/files-pri/${TEAM}-${FILE}/download/a%7fb`, null],
    [`/files-pri/${TEAM}-${FILE}/x/y`, null],
    [`/files-tmb/${TEAM}-${FILE}/report.pdf`, null],
    [`/x/files-pri/${TEAM}-${FILE}/report.pdf`, null],
    [`/files-pri/${TEAM}${FILE}/report.pdf`, null],
    [`/files-pri/-${FILE}/report.pdf`, null],
    [`files-pri/${TEAM}-${FILE}/report.pdf`, null],
    [`//files-pri/${TEAM}-${FILE}/report.pdf`, null],
    ['/', null],
    ['', null],
  ];
  for (const [path, expected] of cases) assert.deepEqual(fileOfPath(path), expected, path);
});

test('reading a file’s path is linear, even on a path made of dashes and slashes', () => {
  // The same bound as `methodOfUrl`'s: this sits on the guard, and a hostile path must not make it slow.
  const started = performance.now();
  assert.equal(fileOfPath(`/files-pri/${'-'.repeat(40_000)}/x`), null);
  assert.equal(fileOfPath(`/files-pri/${TEAM}-${FILE}/${'/'.repeat(40_000)}x`), null);
  assert.equal(fileOfPath(`/files-pri/T${'A'.repeat(40_000)}-${FILE}/x`), null);
  assert.ok(performance.now() - started < 250, `fileOfPath took ${Math.round(performance.now() - started)}ms`);
});

/** Every source file of this package, as a path relative to `src` with forward slashes, and its text. */
async function sources(): Promise<{ path: string; text: string }[]> {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const out: { path: string; text: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push({ path: relative(root, full).split(sep).join('/'), text: await readFile(full, 'utf8') });
      }
    }
  };
  await walk(root);
  return out;
}

/**
 * The ways a source file could reach `downloadWith`, each by the rule it breaks; empty when it reaches it by none.
 *
 * A text scan cannot see through every indirection — a property name built at run time is one — so these close the
 * ways that read as ordinary code. Naming it in an import or export covers a named, an aliased and a re-exported
 * import. Calling it, or reading it off an object, covers a namespace import that got past the other rules. And
 * `guard.ts` may be imported only by name, statically: a namespace import, an `export *` of it, or an `import()` —
 * of it, or of anything not written out — reaches everything it exports without spelling any of it.
 *
 * A comment that cites `downloadWith` in backquotes, as `methods.ts` does, breaks none of them.
 *
 * The same rules answer for `uploadWith`, the upload's grant, through {@link reachOf}: the two are opened by one module
 * each, and a scan written twice is two scans free to differ.
 */
function grantReach(text: string): string[] {
  return reachOf('downloadWith', text);
}

/** The same ways, for any one of `guard.ts`'s openers by name. */
function reachOf(name: string, text: string): string[] {
  const broken: string[] = [];
  if (new RegExp(`^\\s*(?:import|export)\\b[^;]*\\b${name}\\b[^;]*;`, 'm').test(text)) {
    broken.push('names it in an import or export');
  }
  if (new RegExp(`\\b${name}\\s*\\(|\\.\\s*${name}\\b|\\[\\s*['"\`]${name}['"\`]\\s*\\]`).test(text)) {
    broken.push('calls it or reads it off an object');
  }
  if (/\bimport\s*\*\s*as\s+\w+\s+from\s*['"][^'"]*guard(?:\.ts)?['"]/.test(text)) {
    broken.push('imports guard.ts as a namespace');
  }
  if (/\bexport\s*\*[^;]*from\s*['"][^'"]*guard(?:\.ts)?['"]/.test(text)) broken.push('re-exports all of guard.ts');
  for (const call of text.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const specifier = (call[1] ?? '').trim();
    if (!/^(['"])[^'"]*\1$/.test(specifier)) broken.push('imports something not written out');
    else if (/guard(?:\.ts)?['"]$/.test(specifier)) broken.push('imports guard.ts at run time');
  }
  return broken;
}

test('the check for who opens a download grant catches every ordinary way of reaching it', () => {
  const reaching: Record<string, string> = {
    named: "import { closedPermit, downloadWith } from './guard.ts';",
    aliased: "import { downloadWith as fetchFile } from '../api/guard.ts';\nfetchFile(permit, grant, work);",
    reexported: "export { downloadWith } from './guard.ts';",
    namespace: "import * as guard from '../api/guard.ts';\nguard.downloadWith(permit, grant, work);",
    'namespace, bracketed': "import * as g from './guard.ts';\ng['downloadWith'](permit, grant, work);",
    'export all': "export * from './guard.ts';",
    'at run time': "const guard = await import('./guard.ts');\nawait guard.downloadWith(permit, grant, work);",
    'at run time, destructured': "const { downloadWith: open } = await import('../api/guard.ts');",
    'at run time, computed': "const guard = await import('./gua' + 'rd.ts');",
  };
  for (const [how, text] of Object.entries(reaching)) {
    assert.notDeepEqual(grantReach(text), [], `${how}: caught`);
  }
  const innocent: Record<string, string> = {
    'another export': "import { closedPermit, guardSlackRequests } from './guard.ts';",
    'a type': "import type { FetchLike } from '../api/guard.ts';",
    'a comment': ' * inside a grant for exactly that file (`downloadWith` in `guard.ts`).',
    'another module at run time': "const { startSlackStdioServer } = await import('../mcp/stdio-entry.ts');",
  };
  for (const [how, text] of Object.entries(innocent)) {
    assert.deepEqual(grantReach(text), [], `${how}: not caught`);
  }
});

test('only the download transport opens a download grant', async () => {
  /*
   * The grant is what makes the files host reachable at all, so the question is who can open one. One module:
   * `api/download.ts`, which opens it only for a link it has already checked against the file looked up. Anything
   * else that reached it could fetch any file's path with the token on it.
   */
  const files = await sources();
  assert.deepEqual(
    files
      .filter((file) => file.path !== 'api/guard.ts' && grantReach(file.text).length > 0)
      .map((file) => [file.path, grantReach(file.text)]),
    [['api/download.ts', ['names it in an import or export', 'calls it or reads it off an object']]],
  );
});

/** Parse with the repository's direct TypeScript dependency, without resolving imports or writing files. */
function syntaxTrees(files: { path: string; text: string }[]): { path: string; tree: ts.SourceFile }[] {
  // A virtual tree, never on disk, so it is rooted the way TypeScript names paths on every platform: with forward
  // slashes. Rooted at the temporary directory, Windows gave it backslashes, which the server never asks for.
  const root = '/agentcomms-slack-source-audit';
  const config = posix.join(root, 'tsconfig.json');
  const api = new TypeScriptAPI({
    fs: createVirtualFileSystem({
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: files.map((file) => file.path),
      }),
      ...Object.fromEntries(files.map((file) => [posix.join(root, file.path), file.text])),
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      assert.ok(project);
      assert.deepEqual(project.program.getSyntacticDiagnostics(), [], 'source audit requires valid syntax');
      return files.map((file) => {
        const tree = project.program.getSourceFile(posix.join(root, file.path));
        assert.ok(tree);
        return { path: file.path, tree };
      });
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

/** Executable syntax, excluding type-only syntax, import names, comments and literal contents. */
function runtimeNodes(root: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    nodes.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return nodes;
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function revocationReach(root: ts.SourceFile): string[] {
  const found: string[] = [];
  const guardModule = (node: ts.Node | undefined) => /(?:^|\/)guard(?:\.ts)?$/.test(literalText(node) ?? '');
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return;
      const names = node.importClause?.namedBindings;
      if (names && ts.isNamedImports(names)) {
        for (const name of names.elements) {
          if (!name.isTypeOnly && (name.propertyName ?? name.name).text === 'revokeWith') {
            found.push(name.name.text === 'revokeWith' ? 'import' : 'aliased import');
          }
        }
      } else if (names && guardModule(node.moduleSpecifier)) found.push('namespace import');
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) return;
      const names = node.exportClause;
      if (names && ts.isNamedExports(names)) {
        if (
          names.elements.some(
            (name) => !name.isTypeOnly && [name.name.text, name.propertyName?.text].includes('revokeWith'),
          )
        )
          found.push('export');
      } else if (guardModule(node.moduleSpecifier)) found.push('guard re-export');
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (literalText(node.arguments[0]) === undefined || guardModule(node.arguments[0])) found.push('dynamic import');
    }
    if (ts.isIdentifier(node) && node.text === 'revokeWith') {
      found.push(ts.isCallExpression(node.parent) && node.parent.expression === node ? 'call' : 'reference');
    }
    if (ts.isElementAccessExpression(node) && literalText(node.argumentExpression) === 'revokeWith') {
      found.push('property reference');
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

function directFetchCalls(root: ts.SourceFile): ts.Node[] {
  return runtimeNodes(root).filter(
    (node) =>
      ts.isCallExpression(node) &&
      runtimeNodes(node.expression).some(
        (callee) =>
          (ts.isIdentifier(callee) && callee.text === 'fetch') ||
          (ts.isElementAccessExpression(callee) && literalText(callee.argumentExpression) === 'fetch'),
      ),
  );
}

function methodLiteralCount(root: ts.SourceFile, method: string): number {
  return runtimeNodes(root).filter((node) => literalText(node) === method).length;
}

test('syntax-aware source scans ignore comments, prose, types and unrelated imports', () => {
  const [file] = syntaxTrees([
    {
      path: 'innocent.ts',
      text: [
        "import { closedPermit, guardSlackRequests } from './guard.ts';",
        "import type { RevokeBinding, revokeWith } from './guard.ts';",
        "import { type revokeWith as RevokeType } from './guard.ts';",
        "export type { revokeWith } from './guard.ts';",
        '// revokeWith(); fetch(url); callSlack(call, `auth.revoke`);',
        '/* (context.fetch ?? globalThis.fetch)(url); `apps.uninstall` */',
        'const prose = "revokeWith(); fetch(url); callSlack(call, \'auth.revoke\')";',
        'const template = `fetch(url); callSlack(call, "apps.uninstall")`;',
        'const pattern = /revokeWith|auth.revoke|apps.uninstall|fetch/;',
        'type Example = typeof revokeWith;',
      ].join('\n'),
    },
  ]);
  assert.ok(file);
  assert.deepEqual(revocationReach(file.tree), []);
  assert.deepEqual(directFetchCalls(file.tree), []);
  assert.equal(methodLiteralCount(file.tree, 'auth.revoke'), 0);
  assert.equal(methodLiteralCount(file.tree, 'apps.uninstall'), 0);
});

test('syntax-aware source scans catch ordinary fallback calls, template methods and grant aliases', () => {
  const examples = [
    { path: 'direct.ts', text: 'fetch(url);' },
    { path: 'fallback.ts', text: '(context.fetch ?? globalThis.fetch)(url);' },
    { path: 'parenthesized.ts', text: '((globalThis.fetch))(url);' },
    { path: 'property.ts', text: "globalThis['fetch'](url);" },
    {
      path: 'methods.ts',
      text: 'callSlack(call, `auth.revoke`); callSlack(call, `apps.uninstall`);',
    },
    {
      path: 'alias.ts',
      text: "import { revokeWith } from './guard.ts'; const open = revokeWith; open(permit, method, binding, work);",
    },
    {
      path: 'allowed.ts',
      text: "import { closedPermit, revokeWith } from './guard.ts'; revokeWith(permit, method, binding, work);",
    },
    {
      path: 'import-alias.ts',
      text: "import { revokeWith as open } from './guard.ts'; open(permit, method, binding, work);",
    },
    {
      path: 'duplicate-import-alias.ts',
      text: "import { revokeWith, revokeWith as open } from './guard.ts'; revokeWith(permit, method, binding, work); open(permit, method, binding, work);",
    },
    {
      path: 'separate-import-alias.ts',
      text: "import { revokeWith } from './guard.ts'; import { revokeWith as open } from './guard.ts'; revokeWith(permit, method, binding, work); open(permit, method, binding, work);",
    },
  ];
  const files = new Map(syntaxTrees(examples).map((file) => [file.path, file.tree]));
  const tree = (path: string): ts.SourceFile => {
    const found = files.get(path);
    assert.ok(found);
    return found;
  };
  for (const path of ['direct.ts', 'fallback.ts', 'parenthesized.ts', 'property.ts']) {
    assert.equal(directFetchCalls(tree(path)).length, 1, path);
  }
  assert.equal(methodLiteralCount(tree('methods.ts'), 'auth.revoke'), 1);
  assert.equal(methodLiteralCount(tree('methods.ts'), 'apps.uninstall'), 1);
  assert.deepEqual(revocationReach(tree('alias.ts')), ['import', 'reference']);
  assert.deepEqual(revocationReach(tree('import-alias.ts')), ['aliased import']);
  for (const path of ['duplicate-import-alias.ts', 'separate-import-alias.ts']) {
    assert.deepEqual(revocationReach(tree(path)), ['import', 'aliased import', 'call'], path);
  }
  assert.deepEqual(revocationReach(tree('allowed.ts')), ['import', 'call']);
});

test('only the durable revocation operation opens a revocation grant', async () => {
  const files = syntaxTrees(await sources());
  assert.deepEqual(
    files
      .filter((file) => file.path !== 'api/guard.ts' && revocationReach(file.tree).length > 0)
      .map((file) => [file.path, revocationReach(file.tree)]),
    [['operations/revocations.ts', ['import', 'call']]],
  );
});

test('revoke and uninstall method literals stay at their audited boundaries', async () => {
  const files = syntaxTrees(await sources());
  const usesOf = (method: string) =>
    files
      .map((file) => ({
        path: file.path,
        count: methodLiteralCount(file.tree, method),
      }))
      .filter((file) => file.count > 0)
      .sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(usesOf('auth.revoke'), [
    { path: 'api/methods.ts', count: 1 },
    { path: 'operations/revocations.ts', count: 2 },
  ]);
  assert.deepEqual(usesOf('apps.uninstall'), [{ path: 'api/methods.ts', count: 1 }]);
  const operation = files.find((file) => file.path === 'operations/revocations.ts');
  assert.ok(operation);
  assert.match(operation.tree.text, /revokePendingEntry\(context: SlackContext, ref: string\)/);
});

test('only guarded transports send requests to Slack', async () => {
  const files = syntaxTrees(await sources());
  // This follows ordinary callee syntax, including parentheses/fallbacks, not arbitrary run-time indirection.
  assert.deepEqual(
    files.filter((file) => directFetchCalls(file.tree).length > 0).map((file) => file.path),
    [],
    'a direct fetch bypassed the guarded transport',
  );
  const sending = files.filter((file) =>
    runtimeNodes(file.tree).some(
      (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'send',
    ),
  );
  /*
   * `operations/identity.ts` and `operations/bot-token.ts` each make one `auth.test` with a closed permit, because what
   * they need is Slack's `x-oauth-scopes` header, which `callSlack` does not return: doctor's drift check, and the
   * check that a pasted bot token has exactly the send app's four bot scopes before it is kept (agent label design, S1).
   */
  assert.deepEqual(sending.map((file) => file.path).sort(), [
    'api/avatar.ts',
    'api/call.ts',
    'api/download.ts',
    'api/upload.ts',
    'context.ts',
    'operations/bot-token.ts',
    'operations/identity.ts',
  ]);
  for (const file of sending) {
    const bindings = runtimeNodes(file.tree).filter(
      (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'send',
    );
    assert.equal(bindings.length, 1, `${file.path} must have one guarded send binding`);
    const binding = bindings[0];
    assert.ok(binding && ts.isVariableDeclaration(binding));
    assert.ok(
      binding.initializer &&
        ts.isCallExpression(binding.initializer) &&
        ts.isIdentifier(binding.initializer.expression) &&
        binding.initializer.expression.text === 'guardSlackRequests',
      `${file.path} sends without the guard`,
    );
  }
});

// ── Uploads: one POST, to the URL Slack gave, inside the post it belongs to ─────────────────────────────────────

const UPLOAD_URL = `${SLACK_FILES_ORIGIN}/upload/v1/CwABAAAAXAoAAZnKg309`;
const PUBLISH = 'files.completeUploadExternal';

test('an upload POST goes through only to the URL Slack gave, inside an approved post', async () => {
  /*
   * The three steps of a file post, as the gate takes them: ask where to put the bytes, put them there, then name the
   * channel. Only the last publishes, and it spends the permit; the bytes go out inside that permit and not otherwise.
   */
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await spendOn(permit, 'ap_1', PUBLISH, async () => {
    await fetch(`${API}/files.getUploadURLExternal`);
    await uploadWith(permit, UPLOAD_URL, async () => {
      await fetch(UPLOAD_URL, { method: 'POST', body: 'the bytes' });
      // Spent: a second POST inside the same grant finds the door shut.
      await assert.rejects(fetch(UPLOAD_URL, { method: 'POST', body: 'the bytes' }), /no upload is open/);
    });
    assert.equal(permit.uploading, null, 'the grant closed behind the upload');
    // The upload borrowed the post's permit without spending it: the call that publishes still has it.
    assert.equal(permit.approvalId, 'ap_1');
    await fetch(`${API}/${PUBLISH}`);
  });

  assert.deepEqual(calls, [`${API}/files.getUploadURLExternal`, UPLOAD_URL, `${API}/${PUBLISH}`]);
  assert.deepEqual(permit, closedPermit());
  await assert.rejects(fetch(UPLOAD_URL, { method: 'POST', body: 'the bytes' }), /no upload is open/);
  assert.equal(calls.length, 3);
});

test('an upload is refused when no approved post is open, however the grant came to be there', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  // Outside any post, a grant does not open.
  await assert.rejects(
    uploadWith(permit, UPLOAD_URL, () => fetch(UPLOAD_URL, { method: 'POST', body: 'x' })),
    /only inside an approved post/,
  );
  // Inside a permit for another act, neither.
  await spendOn(permit, 'ap_1', 'chat.postMessage', async () => {
    await assert.rejects(
      uploadWith(permit, UPLOAD_URL, () => fetch(UPLOAD_URL, { method: 'POST', body: 'x' })),
      /only inside an approved post/,
    );
  });

  /*
   * And the guard asks again, at the request, rather than trusting that the grant was opened properly. The permit is
   * spent by the call that publishes, so bytes attempted after it — inside a grant opened while it was open — belong to
   * no approval any more.
   */
  await spendOn(permit, 'ap_2', PUBLISH, async () => {
    await uploadWith(permit, UPLOAD_URL, async () => {
      await fetch(`${API}/${PUBLISH}`);
      assert.equal(permit.approvalId, null, 'the publish spent the permit');
      await assert.rejects(
        fetch(UPLOAD_URL, { method: 'POST', body: 'x' }),
        /no approval for files\.completeUploadExternal is open/,
      );
      assert.equal(permit.uploading, UPLOAD_URL, 'a refused upload spent the grant');
    });
  });

  // A grant standing on the permit with no post open — however it got there — lets nothing through.
  for (const [approvalId, method] of [
    [null, null],
    ['ap_3', 'chat.postMessage'],
    ['ap_4', 'reactions.add'],
  ] as const) {
    permit.approvalId = approvalId;
    permit.method = method;
    permit.uploading = UPLOAD_URL;
    await assert.rejects(
      fetch(UPLOAD_URL, { method: 'POST', body: 'x' }),
      /no approval for files\.completeUploadExternal is open/,
      `${approvalId} / ${method}`,
    );
  }
  assert.deepEqual(calls, [`${API}/${PUBLISH}`], 'an upload with no post open reached the inner fetch');
});

test('an upload goes to the exact URL Slack gave, and every other URL is refused without spending the grant', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);
  const cases: [string, RegExp][] = [
    // Another upload URL, or this one with anything added.
    [`${SLACK_FILES_ORIGIN}/upload/v1/CwABAAAAXAoAAZnKg308`, /not the URL Slack gave/],
    [`${UPLOAD_URL}x`, /not the URL Slack gave/],
    [`${UPLOAD_URL}/`, /not the URL Slack gave/],
    [`${UPLOAD_URL}/more`, /not the URL Slack gave/],
    [`${UPLOAD_URL}?filename=other.pdf`, /not the URL Slack gave/],
    [`${SLACK_FILES_ORIGIN}/upload/v2/CwABAAAAXAoAAZnKg309`, /not the URL Slack gave/],
    [`${SLACK_FILES_ORIGIN}/upload/`, /not the URL Slack gave/],
    // A file's path on the same host: shut as it always was, since no download is open.
    [`${SLACK_FILES_ORIGIN}/files-pri/${TEAM}-${FILE}/report.pdf`, /no download is open/],
    // The same path at another host.
    ['https://files-edge.slack.com/upload/v1/CwABAAAAXAoAAZnKg309', /only calls https:\/\/slack\.com and/],
    ['http://files.slack.com/upload/v1/CwABAAAAXAoAAZnKg309', /only calls https:\/\/slack\.com and/],
    ['https://evil.example/upload/v1/CwABAAAAXAoAAZnKg309', /only calls https:\/\/slack\.com and/],
    [UPLOAD_URL.replace('https://', 'https://someone@'), /carrying credentials/],
  ];
  await spendOn(permit, 'ap_1', PUBLISH, async () => {
    await uploadWith(permit, UPLOAD_URL, async () => {
      for (const [url, message] of cases) {
        await assert.rejects(fetch(url, { method: 'POST', body: 'x' }), message, url);
        assert.equal(permit.uploading, UPLOAD_URL, `${url} spent the grant`);
      }
      await fetch(UPLOAD_URL, { method: 'POST', body: 'x' });
    });
  });
  assert.deepEqual(calls, [UPLOAD_URL], 'a near miss reached the inner fetch');
});

test('an upload goes by POST and nothing else', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);
  await spendOn(permit, 'ap_1', PUBLISH, async () => {
    await uploadWith(permit, UPLOAD_URL, async () => {
      for (const verb of ['PUT', 'put', 'GET', 'DELETE', 'HEAD', 'PATCH']) {
        await assert.rejects(
          fetch(UPLOAD_URL, verb === 'GET' || verb === 'HEAD' ? { method: verb } : { method: verb, body: 'x' }),
          new RegExp(`uploaded with POST, not ${verb.toUpperCase()}`),
          verb,
        );
      }
      // No verb at all is a GET.
      await assert.rejects(fetch(UPLOAD_URL), /uploaded with POST, not GET/);
      // A Request carrying its own verb meets the same rule as an init that names one.
      await assert.rejects(fetch(new Request(UPLOAD_URL, { method: 'PUT', body: 'x' })), /uploaded with POST, not PUT/);
      assert.equal(permit.uploading, UPLOAD_URL, 'a refused verb spent the grant');
      await fetch(UPLOAD_URL, { method: 'post', body: 'x' });
    });
  });
  assert.deepEqual(calls, [UPLOAD_URL]);
});

test('an upload is not followed through a redirect, whatever the caller asks', async () => {
  const seen: (RequestInit | undefined)[] = [];
  const permit = closedPermit();
  const fetch = guardSlackRequests(async (_input, init) => {
    seen.push(init);
    return new Response('OK');
  }, permit);
  const asked = [undefined, 'follow', 'manual'] as const;
  for (const redirect of asked) {
    await spendOn(permit, 'ap_1', PUBLISH, () =>
      uploadWith(permit, UPLOAD_URL, () =>
        fetch(UPLOAD_URL, redirect ? { method: 'POST', body: 'x', redirect } : { method: 'POST', body: 'x' }),
      ),
    );
  }
  assert.deepEqual(
    seen.map((init) => init?.redirect),
    asked.map(() => 'error'),
    'an upload went out with a redirect mode a caller chose',
  );
});

test('an upload grant names one URL on files.slack.com under /upload/, or it does not open', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);
  const bad = [
    'not a url',
    'https://slack.com/upload/v1/CwABAAAAXAoAAZnKg309',
    'https://files-edge.slack.com/upload/v1/CwABAAAAXAoAAZnKg309',
    'http://files.slack.com/upload/v1/CwABAAAAXAoAAZnKg309',
    'https://files.slack.com:8443/upload/v1/CwABAAAAXAoAAZnKg309',
    'https://evil.example/upload/v1/CwABAAAAXAoAAZnKg309',
    'https://someone@files.slack.com/upload/v1/CwABAAAAXAoAAZnKg309',
    `${SLACK_FILES_ORIGIN}/files-pri/${TEAM}-${FILE}/report.pdf`,
    `${SLACK_FILES_ORIGIN}/upload`,
    `${SLACK_FILES_ORIGIN}/upload/`,
    `${SLACK_FILES_ORIGIN}/upload//x`,
    `${SLACK_FILES_ORIGIN}/upload/v1/a%2F..%2F..%2Ffiles-pri`,
    `${SLACK_FILES_ORIGIN}/upload/v1/a%5Cb`,
    `${SLACK_FILES_ORIGIN}/xupload/v1/CwABAAAAXAoAAZnKg309`,
    `${UPLOAD_URL}#top`,
  ];
  await spendOn(permit, 'ap_1', PUBLISH, async () => {
    for (const url of bad) {
      await assert.rejects(
        uploadWith(permit, url, () => fetch(url, { method: 'POST', body: 'x' })),
        /an upload grant names one URL/,
        url,
      );
      assert.equal(permit.uploading, null, url);
    }
  });
  assert.deepEqual(calls, []);

  // What reads as an upload's path, as the guard and the grant both read it.
  assert.equal(isUploadPath('/upload/v1/CwABAAAAXAoAAZnKg309'), true);
  assert.equal(isUploadPath('/upload/x'), true);
  for (const path of ['/upload', '/upload/', '/upload//x', '/upload/a/', '/upload/..', '/files-pri/T-F/x', '', '/']) {
    assert.equal(isUploadPath(path), false, path);
  }
});

test('an upload grant lends nothing, borrows only the post it is part of, and does not nest', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await spendOn(permit, 'ap_1', PUBLISH, async () => {
    await uploadWith(permit, UPLOAD_URL, async () => {
      // The post's permit is for publishing the file, not for any other act.
      await assert.rejects(fetch(`${API}/chat.postMessage`), /the open approval is for files\.completeUploadExternal/);
      await assert.rejects(fetch(`${API}/apps.manifest.update`), /only this package's `app` commands may call it/);
      await assert.rejects(fetch(FILE_URL), /no download is open/);
      for (const opening of [
        () => uploadWith(permit, `${SLACK_FILES_ORIGIN}/upload/v1/other`, async () => undefined),
        () => downloadWith(permit, { teamId: TEAM, fileId: FILE }, async () => undefined),
        () => configureWith(permit, 'apps.manifest.update', async () => undefined),
        () => spendOn(permit, 'ap_2', 'chat.postMessage', async () => undefined),
      ]) {
        await assert.rejects(opening(), /already open; they do not nest/);
      }
      assert.equal(permit.uploading, UPLOAD_URL, 'a refused opening closed the grant');
    });
  });
  // Nor does one open inside a download or a configuration grant, where no post is open either.
  await downloadWith(permit, { teamId: TEAM, fileId: FILE }, async () => {
    await assert.rejects(
      uploadWith(permit, UPLOAD_URL, async () => undefined),
      /only inside an approved post/,
    );
  });
  await configureWith(permit, 'apps.manifest.update', async () => {
    await assert.rejects(
      uploadWith(permit, UPLOAD_URL, async () => undefined),
      /only inside an approved post/,
    );
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(permit, closedPermit());
});

test('an upload grant closes when what runs inside it throws', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);
  await spendOn(permit, 'ap_1', PUBLISH, async () => {
    await assert.rejects(
      uploadWith(permit, UPLOAD_URL, async () => {
        throw new Error('network died before the bytes');
      }),
      /network died/,
    );
    assert.equal(permit.uploading, null, 'a failed upload left a grant open behind it');
    await assert.rejects(fetch(UPLOAD_URL, { method: 'POST', body: 'x' }), /no upload is open/);
  });
  assert.deepEqual(calls, []);
});

test('the upload transport sends the bytes, and only to the URL Slack gave, with the token in its header alone', async () => {
  /*
   * Through the real guard to a loopback Slack: what arrives is exactly the file's bytes, at the upload path, by POST,
   * with the token in the authorization header and nowhere else in the request.
   */
  const fake = await startFakeSlack();
  try {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13, 0x25, 0x32]);
    const permit = closedPermit();
    const call = { token: 'fake-user-token-7', fetch: fake.fetch, permit };
    await spendOn(permit, 'ap_1', PUBLISH, () => slackFileUpload(call, { url: UPLOAD_URL, bytes }));
    const [upload, ...rest] = fake.requests;
    assert.deepEqual(rest, []);
    assert.equal(upload?.host, 'files');
    assert.equal(upload?.verb, 'POST');
    assert.equal(upload?.path, '/upload/v1/CwABAAAAXAoAAZnKg309');
    assert.deepEqual(upload?.body, bytes, 'the upload host received other bytes than the file’s');
    assert.equal(upload?.authorization, 'Bearer fake-user-token-7');
    assert.equal(upload?.raw.split('fake-user-token-7').length, 2, 'the token appeared somewhere besides its header');

    // Outside a post it does not go at all.
    await assert.rejects(slackFileUpload(call, { url: UPLOAD_URL, bytes }), /only inside an approved post/);
    await assert.rejects(
      slackFileUpload({ token: 't', fetch: fake.fetch }, { url: UPLOAD_URL, bytes }),
      /only inside an approved post/,
    );
    assert.equal(fake.requests.length, 1);
  } finally {
    await fake.close();
  }
});

test('an upload the host answers with a redirect is refused, and the redirect is never followed', async () => {
  const fake = await startFakeSlack();
  try {
    fake.uploadAnswer = () => ({ status: 302, headers: { location: `${fake.local}/elsewhere` } });
    const permit = closedPermit();
    await assert.rejects(
      spendOn(permit, 'ap_1', PUBLISH, () =>
        slackFileUpload({ token: 't', fetch: fake.fetch, permit }, { url: UPLOAD_URL, bytes: Buffer.from('x') }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CommsError);
        assert.match(error.message, /redirect, which is never followed/);
        return true;
      },
    );
    assert.deepEqual(
      fake.requests.map((request) => request.host),
      ['files'],
      'the redirect was followed',
    );

    // Any other failure is a failure, with the status it came with.
    fake.uploadAnswer = () => ({ status: 500, body: 'no' });
    await assert.rejects(
      spendOn(permit, 'ap_2', PUBLISH, () =>
        slackFileUpload({ token: 't', fetch: fake.fetch, permit }, { url: UPLOAD_URL, bytes: Buffer.from('x') }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CommsError);
        assert.equal(error.code, 'TRANSIENT');
        assert.match(error.message, /answered 500/);
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('the check for who opens an upload grant catches every ordinary way of reaching it', () => {
  const reaching: Record<string, string> = {
    named: "import { closedPermit, uploadWith } from './guard.ts';",
    aliased: "import { uploadWith as putFile } from '../api/guard.ts';\nputFile(permit, url, work);",
    reexported: "export { uploadWith } from './guard.ts';",
    namespace: "import * as guard from '../api/guard.ts';\nguard.uploadWith(permit, url, work);",
    'namespace, bracketed': "import * as g from './guard.ts';\ng['uploadWith'](permit, url, work);",
  };
  for (const [how, text] of Object.entries(reaching)) {
    assert.notDeepEqual(reachOf('uploadWith', text), [], `${how}: caught`);
  }
  // The download's opener is not the upload's: naming one is not reaching the other.
  assert.deepEqual(reachOf('uploadWith', "import { downloadWith } from './guard.ts';"), []);
  assert.deepEqual(reachOf('uploadWith', ' * inside the post it belongs to (`uploadWith` in `guard.ts`).'), []);
});

test('only the upload transport opens an upload grant', async () => {
  /*
   * The grant is what lets bytes leave for the files host, so the question is who can open one. One module:
   * `api/upload.ts`, which opens it only around a POST of the bytes it was handed, to the URL Slack gave, inside the
   * permit of the post they belong to. Anything else that reached it could send any bytes there with the token on them.
   */
  const files = await sources();
  assert.deepEqual(
    files
      .filter((file) => file.path !== 'api/guard.ts' && reachOf('uploadWith', file.text).length > 0)
      .map((file) => [file.path, reachOf('uploadWith', file.text)]),
    [['api/upload.ts', ['names it in an import or export', 'calls it or reads it off an object']]],
  );
});

test('only the photo transport opens a photo grant', async () => {
  /*
   * The grant is what makes Slack's photo host reachable at all, so the question is who can open one. One module:
   * `api/avatar.ts`, which opens it only for the photo `users.info` named, checked and rebuilt on the photo host, and
   * sends it no credential. Anything else that reached it could fetch from that host whatever it liked.
   */
  const files = await sources();
  assert.deepEqual(
    files
      .filter((file) => file.path !== 'api/guard.ts' && reachOf('avatarWith', file.text).length > 0)
      .map((file) => [file.path, reachOf('avatarWith', file.text)]),
    [['api/avatar.ts', ['names it in an import or export', 'calls it or reads it off an object']]],
  );
});
