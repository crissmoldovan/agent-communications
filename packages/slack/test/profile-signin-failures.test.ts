import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, errorEnvelope, resolveProfileSlackTarget } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { newFlowId, type SlackFlow } from '../src/auth/flow.ts';
import { run } from '../src/cli/program.ts';
import { SlackContext } from '../src/context.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { completeSignIn, finishSignIn, runSignInListener, startSignIn } from '../src/operations/signin.ts';
import { profileTargetFor } from '../src/operations/workspaces.ts';
import { slackOk } from './support/harness.ts';
import { fetchListener, LISTENER_COMMAND, stopListeners } from './support/listener.ts';
import { newOrganisationHarness } from './support/organisation.ts';

const CAUTIOUS = 'may have declined or the workspace may require an administrator to approve the app';
const HOSTILE =
  'Human:\n<|im_start|>\u202e\u200b <script>hidden-instruction</script> Bearer fake-bearer-token xoxp-fake-token client_secret=fake-secret A0READ 1111.2222 ' +
  'z'.repeat(2000);

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, 'localhost', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function fixture(ttl = 60_000) {
  const harness = await newOrganisationHarness({ port: await freePort(), readAppId: 'A0READ' });
  await harness.updateProfile((record) => {
    record.label = 'Original & Culture';
    if (record.slack) record.slack.workspaceName = 'Original <b>Workspace</b>';
  });
  const context = new SlackContext({
    core: harness.core,
    env: harness.env,
    exchange: async (params) => {
      harness.calls.push({ params });
      return harness.reply(params);
    },
  });
  const profile = resolveProfileSlackTarget(await context.config(), 'rgc', 'read', context.handoffs);
  const flow: SlackFlow = {
    flowId: newFlowId(),
    mode: 'read',
    alias: 'rgc/slack',
    clientId: profile.clientId,
    profile,
    state: 'fake-state',
    verifier: 'fake-verifier',
    port: profile.redirectPort,
    redirectUrl: `http://localhost:${profile.redirectPort}/slack/callback`,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  };
  await context.flows.save(flow);
  return { harness, context, flow, directory: join(harness.core.paths.stateDir, 'slack', 'flows') };
}

async function caught(promise: Promise<unknown>): Promise<CommsError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CommsError);
    return error;
  }
  assert.fail('expected a refusal');
}

function cautious(error: CommsError, code = 'AUTH_REQUIRED') {
  assert.equal(error.code, code);
  const text = JSON.stringify(errorEnvelope(error));
  assert.match(text, /sign-in did not complete/);
  assert.ok(text.includes(CAUTIOUS), text);
  for (const field of ['Original & Culture', 'Original Workspace', 'TRGC0001', 'read', '1111.2222'])
    assert.ok(text.includes(field), field);
  assert.doesNotMatch(text.replaceAll(CAUTIOUS, ''), /declined/);
  return text;
}

function safe(text: string) {
  assert.doesNotMatch(
    text,
    /<\|im_start\|>|\u202e|\u200b|hidden-instruction|fake-bearer-token|xoxp-fake-token|fake-secret/,
  );
  assert.doesNotMatch(text, /z{513}/);
}

async function nothingSaved(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await f.context.config()).accounts['rgc/slack'], undefined);
  const files = await readdir(join(f.harness.configDir, 'secrets')).catch(() => []);
  assert.deepEqual(files, []);
}

for (const key of ['client_secret', 'access_token', 'refresh_token']) {
  for (const source of ['stored callback', 'exchange']) {
    test(`quoted ${key} is redacted from ${source} and its surfaced error`, async () => {
      const f = await fixture();
      const secret = 'test-secret-123';
      const description = `{"${key}":"${secret}"}`;
      let operation: Promise<unknown>;
      if (source === 'stored callback') {
        await f.context.flows.recordOutcome(f.flow.flowId, { error: 'access_denied', description });
        assert.doesNotMatch(
          await readFile(join(f.directory, `${f.flow.flowId}.outcome.json`), 'utf8'),
          /test-secret-123/,
        );
        operation = finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0 });
      } else {
        f.harness.reply = () => ({ ok: false, error: 'access_denied', error_description: description });
        operation = completeSignIn(f.context, f.flow.flowId, 'fake-code');
      }
      const error = await caught(operation);
      assert.doesNotMatch(JSON.stringify(errorEnvelope(error)) + error.stack, /test-secret-123/);
      assert.match(error.hint ?? '', /\[redacted\]/);
      cautious(error);
      await nothingSaved(f);
    });
  }
}

for (const finish of ['refusal', 'success']) {
  test(`entity-containing profile remains unchanged through save, patch, resave and ${finish}`, async () => {
    const f = await fixture();
    await f.harness.updateProfile((record) => {
      if (record.slack) record.slack.workspaceName = 'Plain &lt;b&gt;Workspace&lt;/b&gt;';
    });
    const flow = {
      ...f.flow,
      profile: resolveProfileSlackTarget(await f.context.config(), 'rgc', 'read', f.context.handoffs),
    };
    await f.context.flows.save(flow);
    const first = await f.context.flows.get(flow.flowId);
    await f.context.flows.patch(flow.flowId, { listenerPid: process.pid });
    const patched = await f.context.flows.get(flow.flowId);
    assert.deepEqual(patched.profile, first.profile, 'patch changed a canonical display');
    await f.context.flows.save(patched);
    assert.deepEqual(
      (await f.context.flows.get(flow.flowId)).profile,
      first.profile,
      'resave changed a canonical display',
    );
    if (finish === 'refusal') {
      await f.context.flows.recordOutcome(flow.flowId, { error: 'access_denied' });
      const error = await caught(finishSignIn(f.context, { flowId: flow.flowId, waitSeconds: 0 }));
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.match(error.message, /Plain <b>Workspace<\/b>/);
      assert.ok(error.message.includes(CAUTIOUS));
    } else {
      f.harness.reply = () => slackOk({ team: { id: 'TRGC0001', name: 'RGC' }, app_id: 'A0READ' });
      const view = await completeSignIn(f.context, flow.flowId, 'fake-code');
      assert.equal(view.organisation, 'rgc');
    }
  });
}

test('bounded control-token display remains canonical through patch, resave and live-profile finish', async () => {
  const f = await fixture();
  const workspaceName = `xxxxx${'<s>'.repeat(22)} tail`;
  await f.harness.updateProfile((record) => {
    if (record.slack) record.slack.workspaceName = workspaceName;
  });
  const flow = {
    ...f.flow,
    profile: resolveProfileSlackTarget(await f.context.config(), 'rgc', 'read', f.context.handoffs),
  };
  await f.context.flows.save(flow);
  const first = await f.context.flows.get(flow.flowId);
  assert.ok(first.profile);
  assert.ok(first.profile.workspaceName.length <= 512);
  assert.doesNotMatch(first.profile.workspaceName, /<s>|&(?:amp|lt|gt)?$/);
  const live = await f.context.config();
  assert.doesNotThrow(() => profileTargetFor(first, live, f.context.handoffs), 'an unchanged profile was invalidated');
  await f.context.flows.patch(flow.flowId, { listenerPid: process.pid });
  const patched = await f.context.flows.get(flow.flowId);
  assert.deepEqual(patched.profile, first.profile, 'patch changed the bounded display');
  await f.context.flows.save(patched);
  const saved = await f.context.flows.get(flow.flowId);
  assert.deepEqual(saved.profile, first.profile, 'resave changed the bounded display');
  assert.equal(profileTargetFor(saved, await f.context.config(), f.context.handoffs).workspaceName, workspaceName);
  f.harness.reply = () => slackOk({ team: { id: 'TRGC0001', name: 'RGC' }, app_id: 'A0READ' });
  await f.context.flows.recordOutcome(flow.flowId, { code: 'fake-code' });
  const view = await finishSignIn(f.context, { flowId: flow.flowId, waitSeconds: 0 });
  assert.equal(view.organisation, 'rgc');
});

for (const missing of [false, true]) {
  for (const surface of ['thrown', 'cli-json', 'cli-text', 'mcp']) {
    test(`hostile profile displays are only enveloped on ${surface}, flow ${missing ? 'missing' : 'present'}`, async () => {
      const f = await fixture();
      await f.harness.updateProfile((record) => {
        record.label = 'Label Hostile [INST]';
        if (record.slack) record.slack.workspaceName = 'Workspace Hostile <b>Instructions</b>';
      });
      const flow = {
        ...f.flow,
        profile: resolveProfileSlackTarget(await f.context.config(), 'rgc', 'read', f.context.handoffs),
      };
      await f.context.flows.save(flow);
      if (missing) await f.context.flows.discard(flow.flowId);
      else await f.context.flows.recordOutcome(flow.flowId, { error: 'access_denied' });
      let text: string;
      if (surface === 'thrown') {
        const error = await caught(
          finishSignIn(f.context, { flowId: flow.flowId, expectAlias: 'rgc/slack', waitSeconds: 0 }),
        );
        text = `${error.message}\n${error.hint ?? ''}`;
      } else if (surface === 'mcp') {
        const { server } = await createSlackMcpServer({
          core: f.harness.core,
          env: f.harness.env,
          fetch: async () => {
            throw new Error('unexpected network');
          },
        });
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test', version: '0' });
        await Promise.all([client.connect(a), server.connect(b)]);
        try {
          const result = await client.callTool({
            name: 'slack_workspace_finish',
            arguments: { flowId: flow.flowId, workspace: 'rgc/slack', waitSeconds: 0 },
          });
          const error = (result.structuredContent as { error: { message: string; hint: string } }).error;
          text = `${error.message}\n${error.hint}`;
        } finally {
          await Promise.all([client.close(), server.close()]);
        }
      } else {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let out = '';
        let err = '';
        stdout.on('data', (chunk) => {
          out += chunk;
        });
        stderr.on('data', (chunk) => {
          err += chunk;
        });
        await run(
          [
            'workspace',
            'add',
            'rgc/slack',
            '--finish',
            flow.flowId,
            '--wait',
            '0',
            ...(surface === 'cli-json' ? ['--json'] : []),
          ],
          {
            core: f.harness.core,
            env: f.harness.env,
            streams: { stdout, stderr, stdin: new PassThrough() },
            exchange: async () => {
              throw new Error('unexpected exchange');
            },
          },
        );
        if (surface === 'cli-json') {
          const error = JSON.parse(out).error;
          text = `${error.message}\n${error.hint}`;
        } else text = out + err;
      }
      assert.match(text, /Label Hostile \[control token removed\]/);
      assert.match(text, /Workspace Hostile Instructions/);
      const outside = text.replace(
        /<untrusted-content boundary="([A-Za-z0-9_-]+)"[^>]*>[\s\S]*?<\/untrusted-content boundary="\1">/g,
        '',
      );
      assert.doesNotMatch(outside, /Label Hostile|Workspace Hostile|TRGC0001|1111\.2222/);
      assert.doesNotMatch(text, /\[INST\]|<b>/);
    });
  }
}

for (const source of ['callback', 'exchange', 'url'] as const) {
  for (const code of ['access_denied', 'approval_required', 'unknown_refusal']) {
    test(`${source} ${code} gives cautious snapshot wording and stores no credential`, async () => {
      const f = await fixture();
      let operation: Promise<unknown>;
      if (source === 'exchange') {
        f.harness.reply = () => ({ ok: false, error: code, error_description: HOSTILE });
        operation = completeSignIn(f.context, f.flow.flowId, 'fake-code');
      } else if (source === 'url') {
        const url = new URL(f.flow.redirectUrl);
        url.search = new URLSearchParams({ state: f.flow.state, error: code, error_description: HOSTILE }).toString();
        operation = finishSignIn(f.context, { flowId: f.flow.flowId, url: url.href });
      } else {
        await f.context.flows.recordOutcome(f.flow.flowId, { error: code, description: HOSTILE });
        const stored = await readFile(join(f.directory, `${f.flow.flowId}.outcome.json`), 'utf8');
        safe(stored);
        operation = finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0 });
      }
      const error = await caught(operation);
      const shown = cautious(error);
      safe(shown);
      assert.ok(shown.includes(code));
      assert.match(shown, /untrusted-content/);
      assert.match(shown, /A0READ/);
      safe(error.stack ?? '');
      assert.equal(await f.context.flows.peek(f.flow.flowId), null);
      await nothingSaved(f);
    });
  }
}

test('detached listener expiry is observed by an already waiting finish and leaves no tombstone', async () => {
  const f = await fixture(200);
  const listening = runSignInListener(f.context, f.flow.flowId, { timeoutMs: 200 });
  const waiting = caught(finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 2, pollMs: 10 }));
  await listening;
  cautious(await waiting, 'TRANSIENT');
  assert.deepEqual(await readdir(f.directory), []);
  await nothingSaved(f);
});

test('browser abandonment removes the detached flow without any timeout outcome', async () => {
  const f = await fixture();
  await runSignInListener(f.context, f.flow.flowId, { timeoutMs: 20 });
  assert.deepEqual(await readdir(f.directory), []);
  await nothingSaved(f);
});

test('foreground profile timeout uses cautious snapshot wording', async () => {
  const f = await fixture();
  await f.context.flows.discard(f.flow.flowId);
  const started = await startSignIn(f.context, {
    alias: f.flow.alias,
    clientId: f.flow.clientId,
    profile: f.flow.profile,
    mode: 'read',
    port: f.flow.port,
    detached: false,
    listenerTimeoutMs: 20,
  });
  assert.ok(started.listener);
  const text = cautious(await caught(started.listener.result), 'TRANSIENT');
  /*
   * Slack refuses an undistributed app on its own page and never redirects, so this timeout is the only thing the
   * person hears — and "ask the administrator" sends them the wrong way when the browser was in another workspace.
   */
  assert.match(text, /invalid_team_for_non_distributed_app/);
  assert.match(text, /signed in to another Slack workspace/);
  assert.deepEqual(await readdir(f.directory), []);
  await nothingSaved(f);
});

test('no-flow cautious line requires an expectAlias with a current Slack organisation', async () => {
  const f = await fixture();
  await f.context.flows.discard(f.flow.flowId);
  for (const alias of [undefined, 'unknown/slack', 'own-app']) {
    const error = await caught(finishSignIn(f.context, { flowId: f.flow.flowId, expectAlias: alias, waitSeconds: 0 }));
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.message, 'that sign-in is not waiting to be finished');
    assert.doesNotMatch(error.hint ?? '', /administrator/);
  }
  await f.harness.updateProfile((record) => {
    record.label = 'Current & Culture';
  });
  const error = await caught(
    finishSignIn(f.context, { flowId: f.flow.flowId, expectAlias: 'rgc/slack', waitSeconds: 0 }),
  );
  assert.equal(error.code, 'NOT_FOUND');
  assert.match(error.hint ?? '', /If a sign-in through/);
  assert.match(error.hint ?? '', /Current & Culture.*Original Workspace.*TRGC0001/);
  assert.match(error.hint ?? '', /administrator to approve the app/);
  await f.harness.updateProfile((record) => {
    delete record.slack;
  });
  assert.doesNotMatch(
    (await caught(finishSignIn(f.context, { flowId: f.flow.flowId, expectAlias: 'rgc/slack', waitSeconds: 0 }))).hint ??
      '',
    /administrator/,
  );
});

for (const change of ['update', 'remove'] as const) {
  for (const stage of ['wait', 'before exchange', 'after exchange', 'commit'] as const) {
    test(`profile ${change} at ${stage} reports invalidation, never a decline`, async () => {
      const f = await fixture();
      const mutate = () =>
        f.harness.updateConfig((config) => {
          if (change === 'remove') delete config.organisations?.rgc;
          else if (config.organisations?.rgc) config.organisations.rgc.sha256 = 'b'.repeat(64);
        });
      const secrets = await f.context.secrets();
      let stages = 0;
      f.context.secrets = async () => ({
        kind: secrets.kind,
        get: (ref) => secrets.get(ref),
        delete: (ref) => secrets.delete(ref),
        invalidate: (ref) => secrets.invalidate(ref),
        async set(ref, value) {
          stages++;
          await secrets.set(ref, value);
          if (stage === 'commit') await mutate();
        },
      });
      f.harness.reply = async () => {
        if (stage === 'after exchange') await mutate();
        return slackOk({ team: { id: 'TRGC0001', name: 'RGC' }, app_id: 'A0READ' });
      };
      let result: Promise<CommsError>;
      if (stage === 'wait') {
        result = caught(finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 2, pollMs: 5 }));
        await new Promise((done) => setTimeout(done, 30));
        await mutate();
      } else {
        if (stage === 'before exchange') await mutate();
        result = caught(completeSignIn(f.context, f.flow.flowId, 'fake-code'));
      }
      const error = await result;
      assert.equal(error.code, 'CONFIG');
      assert.match(error.message, /profile changed/);
      assert.doesNotMatch(JSON.stringify(errorEnvelope(error)), /declined/);
      if (stage === 'before exchange' || stage === 'wait') assert.equal(f.harness.calls.length, 0);
      assert.equal(stages, stage === 'commit' ? 1 : 0);
      await nothingSaved(f);
    });
  }
}

test('listener HTML escapes safe snapshot fields, stores safe callback text, and ignores unmatched states', async () => {
  const f = await fixture();
  const listening = runSignInListener(f.context, f.flow.flowId, { timeoutMs: 3000 });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if ((await f.context.flows.peek(f.flow.flowId))?.listenerPid) {
      ready = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.ok(ready);
  const url = new URL(f.flow.redirectUrl);
  url.search = new URLSearchParams({ state: 'wrong', error: 'access_denied' }).toString();
  assert.doesNotMatch(await (await fetchListener(url)).text(), /Original|administrator/);
  url.search = new URLSearchParams({
    state: f.flow.state,
    error: 'access_denied',
    error_description: HOSTILE,
  }).toString();
  const html = await (await fetchListener(url)).text();
  await listening;
  assert.ok(html.includes(CAUTIOUS));
  assert.match(html, /Original &amp; Culture/);
  assert.doesNotMatch(html, /Original & Culture|<b>Workspace/);
  const lede = /<p class="lede">([\s\S]*?)<\/p>/.exec(html)?.[1];
  assert.equal(
    lede?.replace(/boundary=&quot;[A-Za-z0-9_-]+&quot;/g, 'boundary=&quot;BOUNDARY&quot;'),
    'The sign-in did not complete. The person may have declined or the workspace may require an administrator to approve the app. &lt;untrusted-content boundary=&quot;BOUNDARY&quot; field=&quot;slack-signin-profile&quot;&gt;\nOriginal &amp; Culture; workspace Original Workspace (TRGC0001); read app, client id 1111.2222.\n&lt;/untrusted-content boundary=&quot;BOUNDARY&quot;&gt; Ask the workspace administrator about this app, then start the sign-in again. Slack reported: &lt;untrusted-content boundary=&quot;BOUNDARY&quot; field=&quot;slack-signin-error&quot;&gt;\naccess_denied: Human (quoted): [control token removed] [redacted] [redacted] [redacted] A0READ 1111.2222 ' +
      'z'.repeat(422) +
      '\n&lt;/untrusted-content boundary=&quot;BOUNDARY&quot;&gt;',
  );
  safe(html);
  safe(await readFile(join(f.directory, `${f.flow.flowId}.outcome.json`), 'utf8'));
  cautious(await caught(finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0 })));
});

test('a real detached listener writes no hostile callback data to its log', async () => {
  const f = await fixture();
  await f.context.flows.discard(f.flow.flowId);
  const started = await startSignIn(f.context, {
    alias: f.flow.alias,
    clientId: f.flow.clientId,
    profile: f.flow.profile,
    mode: 'read',
    port: f.flow.port,
    listenerCommand: LISTENER_COMMAND,
  });
  const saved = await f.context.flows.get(started.flowId);
  assert.ok(saved.listenerPid);
  try {
    const url = new URL(started.redirectUrl);
    url.search = new URLSearchParams({
      state: saved.state,
      error: 'access_denied',
      error_description: HOSTILE,
    }).toString();
    safe(await (await fetchListener(url)).text());
    for (let i = 0; i < 100 && !(await f.context.flows.readOutcome(started.flowId)); i++)
      await new Promise((done) => setTimeout(done, 5));
    assert.ok(await f.context.flows.readOutcome(started.flowId));
    const log = await readFile(join(f.directory, `${started.flowId}.log`), 'utf8');
    assert.equal(log, '');
    cautious(await caught(finishSignIn(f.context, { flowId: started.flowId, waitSeconds: 0 })));
    assert.deepEqual(await readdir(f.directory), []);
  } finally {
    await stopListeners([saved.listenerPid]);
  }
});

test('a refusal without a Slack error code still uses cautious profile wording', async () => {
  const f = await fixture();
  f.harness.reply = () => ({ ok: false });
  cautious(await caught(completeSignIn(f.context, f.flow.flowId, 'fake-code')));
});

test('profile display fields stored in the flow are bounded neutralised visible text', async () => {
  const f = await fixture();
  assert.ok(f.flow.profile);
  const hostile = { ...f.flow, profile: { ...f.flow.profile, label: HOSTILE, workspaceName: HOSTILE } };
  await f.context.flows.save(hostile);
  const stored = await readFile(join(f.directory, `${f.flow.flowId}.json`), 'utf8');
  safe(stored);
  const saved = await f.context.flows.get(f.flow.flowId);
  assert.ok(saved.profile);
  for (const value of [saved.profile.label, saved.profile.workspaceName]) {
    assert.equal(value.length, 512);
    assert.doesNotMatch(value, /\n|\r/);
    assert.match(value, /^Human \(quoted\): \[control token removed\] \[redacted\]/);
  }
});

test('HTML paragraph diagnostics are flattened before outcome storage', async () => {
  const f = await fixture();
  await f.context.flows.recordOutcome(f.flow.flowId, {
    error: 'access_denied',
    description: 'first<p>second</p><p>third</p>',
  });
  const outcome = await f.context.flows.readOutcome(f.flow.flowId);
  assert.ok(outcome && 'description' in outcome);
  assert.equal(outcome.description, 'first second third');
  const error = await caught(finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0 }));
  assert.match(error.hint ?? '', /access_denied: first second third/);
});

test('a late callback cannot identify a profile after its flow was discarded', async () => {
  const f = await fixture();
  const listening = runSignInListener(f.context, f.flow.flowId, { timeoutMs: 3000 });
  while (!(await f.context.flows.peek(f.flow.flowId))?.listenerPid) await new Promise((done) => setTimeout(done, 5));
  await f.context.flows.discard(f.flow.flowId);
  const url = new URL(f.flow.redirectUrl);
  url.search = new URLSearchParams({ state: f.flow.state, error: 'access_denied' }).toString();
  const html = await (await fetchListener(url)).text();
  await listening;
  assert.doesNotMatch(html, /Original|administrator/);
  // The existing callback outcome behavior is retained; a missing flow cannot be finished.
  assert.equal((await caught(finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0 }))).code, 'NOT_FOUND');
  await f.context.flows.discard(f.flow.flowId);
});

test('failure display uses its snapshot without reading the profile again after validity was established', async () => {
  const f = await fixture();
  await f.context.flows.recordOutcome(f.flow.flowId, { error: 'access_denied' });
  const original = await f.context.config();
  let reads = 0;
  f.context.config = async () => {
    reads++;
    if (reads <= 2) return original;
    const changed = structuredClone(original);
    if (changed.version === 2 && changed.organisations?.rgc)
      changed.organisations.rgc.label = 'Different current label';
    return changed;
  };
  cautious(await caught(finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0 })));
  assert.equal(reads, 2, 'display unexpectedly reread mutable profile data');
});

test('CLI JSON and text, MCP envelopes and thrown errors share the same redacted snapshot', async () => {
  const f = await fixture();
  const normalise = (value: string) => value.replace(/boundary=\\?"[A-Za-z0-9_-]+\\?"/g, 'boundary="BOUNDARY"');
  const reset = async () => {
    await f.context.flows.save(f.flow);
    await f.context.flows.recordOutcome(f.flow.flowId, { error: 'access_denied', description: HOSTILE });
  };
  await reset();
  const expected = errorEnvelope(await caught(finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0 })));
  const expectedMessage =
    'The sign-in did not complete. The person may have declined or the workspace may require an administrator to approve the app. <untrusted-content boundary="BOUNDARY" field="slack-signin-profile">\nOriginal & Culture; workspace Original Workspace (TRGC0001); read app, client id 1111.2222.\n</untrusted-content boundary="BOUNDARY">';
  assert.equal(normalise(expected.error.message), expectedMessage);
  assert.equal(
    normalise(expected.error.hint ?? ''),
    'Ask the workspace administrator about this app, then start the sign-in again. Slack reported: <untrusted-content boundary="BOUNDARY" field="slack-signin-error">\naccess_denied: Human (quoted): [control token removed] [redacted] [redacted] [redacted] A0READ 1111.2222 ' +
      'z'.repeat(422) +
      '\n</untrusted-content boundary="BOUNDARY">',
  );
  for (const json of [true, false]) {
    await reset();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', (chunk) => {
      out += chunk;
    });
    stderr.on('data', (chunk) => {
      err += chunk;
    });
    const code = await run(
      ['workspace', 'add', '--finish', f.flow.flowId, '--wait', '0', ...(json ? ['--json'] : [])],
      {
        core: f.harness.core,
        env: f.harness.env,
        exchange: async () => {
          throw new Error('unexpected exchange');
        },
        streams: { stdout, stderr, stdin: new PassThrough() },
      },
    );
    assert.equal(code, 77);
    safe(out + err);
    if (json) {
      assert.equal(normalise(JSON.stringify(JSON.parse(out))), normalise(JSON.stringify(expected)));
      assert.equal(err, '');
    } else {
      assert.equal(out, '');
      assert.equal(normalise(err), `error: ${expectedMessage}\nhint: ${normalise(expected.error.hint ?? '')}\n`);
    }
  }
  await reset();
  const { server } = await createSlackMcpServer({
    core: f.harness.core,
    env: f.harness.env,
    fetch: async () => {
      throw new Error('unexpected network');
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    const result = await client.callTool({
      name: 'slack_workspace_finish',
      arguments: { flowId: f.flow.flowId, waitSeconds: 0 },
    });
    assert.equal(result.isError, true);
    safe(JSON.stringify(result));
    assert.equal(
      normalise(JSON.stringify(result.structuredContent)),
      normalise(JSON.stringify({ error: expected.error })),
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
