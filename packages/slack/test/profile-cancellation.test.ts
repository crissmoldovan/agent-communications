import assert from 'node:assert/strict';
import fs, { readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError, resolveProfileSlackTarget } from '@agentcomms/core';
import type { FlowOutcome } from '../src/auth/flow.ts';
import { SlackContext } from '../src/context.ts';
import { finishSignIn, startSignIn } from '../src/operations/signin.ts';
import { assertNoBareCommand, slackInline } from './support/handoffs.ts';
import { slackOk } from './support/harness.ts';
import { fetchListener, LISTENER_COMMAND, running, stopListeners } from './support/listener.ts';
import { newOrganisationHarness } from './support/organisation.ts';

let nextManifestPort = 47_000;
async function fixture(platform: NodeJS.Platform = 'darwin', interrupted?: AbortController) {
  const port = nextManifestPort++;
  const harness = await newOrganisationHarness({ port, readAppId: 'A0READ' });
  const context = new SlackContext({
    core: harness.core,
    env: harness.env,
    platform,
    foregroundSignIn: interrupted
      ? { signal: interrupted.signal, register: () => assert.fail('a detached listener was registered as foreground') }
      : undefined,
    exchange: async (params) => {
      harness.calls.push({ params });
      interrupted?.abort();
      return slackOk({ team: { id: 'TRGC0001', name: 'RGC' }, app_id: 'A0READ' });
    },
  });
  const profile = resolveProfileSlackTarget(await context.config(), 'rgc', 'read', context.handoffs);
  const started = await startSignIn(context, {
    alias: 'rgc/slack',
    clientId: profile.clientId,
    mode: 'read',
    port,
    profile,
    listenerCommand: LISTENER_COMMAND,
  });
  const flow = await context.flows.get(started.flowId);
  assert.ok(flow.listenerPid);
  return { harness, context, flow, pid: flow.listenerPid };
}

test('a detached callback already exchanging is unaffected by the foreground interruption signal', async (t) => {
  const interrupted = new AbortController();
  const f = await fixture('darwin', interrupted);
  t.after(() => stopListeners([f.pid]));
  const back = new URL(f.flow.redirectUrl);
  back.searchParams.set('state', f.flow.state);
  back.searchParams.set('code', 'fake-code');
  await fetchListener(back);
  const view = await finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 5, pollMs: 10 });
  assert.equal(interrupted.signal.aborted, true, 'the exchange never reached its interruption boundary');
  assert.equal(view.alias, 'rgc/slack');
  assert.equal(f.harness.calls.length, 1);
  assert.ok((await f.context.config()).accounts['rgc/slack']);
  assert.equal(await f.context.flows.peek(f.flow.flowId), null);
});

function cancelled(error: unknown, flowId: string, context: SlackContext) {
  assert.ok(error instanceof CommsError);
  assert.equal(error.code, 'APPROVAL_PENDING');
  assert.match(error.message, /still open/);
  assert.doesNotMatch(`${error.message} ${error.hint}`, /did not complete|declined|administrator/);
  // This installation's own command, located, for the shell the context prints for (CUE-403).
  const command = slackInline(context.core.paths, ['workspace', 'add', '--finish', flowId], context.platform);
  assert.equal(error.hint, `Finish signing in in the browser, then run ${command}.`);
  // All these words are shell-safe on both pinned platforms, including the generated flow id.
  assert.match(error.hint ?? '', new RegExp(` workspace add --finish ${flowId}\`\\.$`));
  assertNoBareCommand(error.hint ?? '');
  assert.equal(error.details?.flowId, flowId);
  return true;
}

for (const platform of ['darwin', 'win32'] as const) {
  test(`pre-aborted detached finish leaves listener and flow untouched (${platform})`, async (t) => {
    const f = await fixture(platform);
    t.after(() => stopListeners([f.pid]));
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    const read = f.context.flows.readOutcome.bind(f.context.flows);
    f.context.flows.readOutcome = async (id) => {
      reads++;
      return read(id);
    };
    await assert.rejects(
      finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0, signal: controller.signal }),
      (error) => cancelled(error, f.flow.flowId, f.context),
    );
    assert.equal(reads, 0, 'an aborted wait polled the outcome');
    assert.deepEqual(await f.context.flows.get(f.flow.flowId), f.flow);
    assert.ok(running(f.pid), 'cancellation stopped the detached listener');
    assert.deepEqual(
      (await readdir(join(f.harness.core.paths.stateDir, 'slack', 'flows'))).sort(),
      [`${f.flow.flowId}.json`, `${f.flow.flowId}.log`].sort(),
    );
    assert.equal(f.harness.calls.length, 0);
    assert.equal((await f.context.config()).accounts['rgc/slack'], undefined);
    assert.deepEqual(await readdir(join(f.harness.configDir, 'secrets')).catch(() => []), []);
    const back = new URL(f.flow.redirectUrl);
    back.searchParams.set('state', f.flow.state);
    back.searchParams.set('code', 'fake-code');
    assert.equal((await fetchListener(back)).status, 200);
    const view = await finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 5, pollMs: 10 });
    assert.equal(view.alias, 'rgc/slack');
    assert.equal(f.harness.calls.length, 1);
  });
}

test('abort during a long polling sleep promptly leaves the detached sign-in open', async (t) => {
  const f = await fixture();
  t.after(() => stopListeners([f.pid]));
  const controller = new AbortController();
  const read = f.context.flows.readOutcome.bind(f.context.flows);
  let polled!: () => void;
  const firstPoll = new Promise<void>((resolve) => {
    polled = resolve;
  });
  f.context.flows.readOutcome = async (id) => {
    const result = await read(id);
    polled();
    return result;
  };
  const waiting = finishSignIn(f.context, {
    flowId: f.flow.flowId,
    waitSeconds: 1,
    pollMs: 1000,
    signal: controller.signal,
  });
  const rejected = assert.rejects(waiting, (error) => cancelled(error, f.flow.flowId, f.context));
  await firstPoll;
  await new Promise((done) => setTimeout(done, 30));
  controller.abort();
  await Promise.race([
    rejected,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('cancelled wait did not settle promptly')), 500);
      void rejected.finally(() => clearTimeout(timer)).catch(() => undefined);
    }),
  ]);
  assert.deepEqual(await f.context.flows.get(f.flow.flowId), f.flow);
  assert.equal(await f.context.flows.readOutcome(f.flow.flowId), null);
  assert.ok(running(f.pid));
});

for (const outcome of [{ code: 'fake-code' }, { error: 'access_denied' }] satisfies FlowOutcome[]) {
  test(`abort racing an unclaimed ${'code' in outcome ? 'code' : 'refusal'} preserves the outcome`, async (t) => {
    const f = await fixture();
    t.after(() => stopListeners([f.pid]));
    const controller = new AbortController();
    await f.context.flows.recordOutcome(f.flow.flowId, outcome);
    const read = f.context.flows.readOutcome.bind(f.context.flows);
    const saved = await read(f.flow.flowId);
    f.context.flows.readOutcome = async (id) => {
      const result = await read(id);
      controller.abort();
      return result;
    };
    await assert.rejects(
      finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0, signal: controller.signal }),
      (error) => cancelled(error, f.flow.flowId, f.context),
    );
    assert.deepEqual(await f.context.flows.get(f.flow.flowId), f.flow);
    assert.deepEqual(await read(f.flow.flowId), saved);
    assert.equal(f.harness.calls.length, 0);
    assert.ok(running(f.pid));
    assert.ok(
      !(await readdir(join(f.harness.core.paths.stateDir, 'slack', 'flows'))).some((file) => file.endsWith('.claim')),
    );
  });
}

test('abort after the finisher owns the outcome lets that owner complete once', async (t) => {
  const f = await fixture();
  t.after(() => stopListeners([f.pid]));
  const controller = new AbortController();
  const claim = f.context.flows.claim.bind(f.context.flows);
  f.context.flows.claim = async (id) => {
    const flow = await claim(id);
    controller.abort();
    return flow;
  };
  await f.context.flows.recordOutcome(f.flow.flowId, { code: 'fake-code' });
  const view = await finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0, signal: controller.signal });
  assert.equal(view.alias, 'rgc/slack');
  assert.equal(f.harness.calls.length, 1);
  assert.equal(await f.context.flows.peek(f.flow.flowId), null);
});

for (const when of ['during mkdir', 'after atomic open'] as const) {
  test(`abort ${when} respects the claim ownership boundary`, async (t) => {
    const f = await fixture();
    t.after(() => stopListeners([f.pid]));
    const controller = new AbortController();
    const directory = join(f.harness.core.paths.stateDir, 'slack', 'flows');
    const marker = join(directory, `${f.flow.flowId}.claim`);
    await f.context.flows.recordOutcome(f.flow.flowId, { code: 'fake-code' });
    const saved = await f.context.flows.readOutcome(f.flow.flowId);
    let intercepted = false;
    const mkdir = fs.mkdir;
    const open = fs.open;
    if (when === 'during mkdir') {
      t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
        const result = await mkdir(...args);
        if (String(args[0]) === directory && !intercepted) {
          intercepted = true;
          assert.ok(!(await readdir(directory)).includes(`${f.flow.flowId}.claim`));
          controller.abort();
        }
        return result;
      });
    } else {
      t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (String(args[0]) === marker && !intercepted) {
          intercepted = true;
          assert.ok((await readdir(directory)).includes(`${f.flow.flowId}.claim`));
          controller.abort();
        }
        return handle;
      });
    }
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const finishing = finishSignIn(f.context, { flowId: f.flow.flowId, waitSeconds: 0, signal: controller.signal });
    if (when === 'during mkdir') {
      await assert.rejects(finishing, (error) => cancelled(error, f.flow.flowId, f.context));
      assert.equal(f.harness.calls.length, 0);
      assert.deepEqual(await f.context.flows.get(f.flow.flowId), f.flow);
      assert.deepEqual(await f.context.flows.readOutcome(f.flow.flowId), saved);
      assert.ok(!(await readdir(directory)).includes(`${f.flow.flowId}.claim`));
      assert.ok(running(f.pid));
      // The listener must still answer a callback, not merely have an as-yet-live pid.
      const back = new URL(f.flow.redirectUrl);
      back.searchParams.set('state', f.flow.state);
      back.searchParams.set('code', 'fake-code');
      assert.equal((await fetchListener(back)).status, 200);
    } else {
      assert.equal((await finishing).alias, 'rgc/slack');
      assert.equal(f.harness.calls.length, 1);
      assert.equal(await f.context.flows.peek(f.flow.flowId), null);
    }
    assert.equal(intercepted, true, 'the test did not reach the real claim boundary');
  });
}
