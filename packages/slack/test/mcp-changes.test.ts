import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';
import { beginChangeApproval, EXIT_CODES, finishChangeApproval } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { openFlowStore } from '../src/auth/flow.ts';
import { run } from '../src/cli/program.ts';
import { SlackContext } from '../src/context.ts';
import { scopesForMode } from '../src/manifest.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { assertNoBareCommand, slackCommand, slackHandoffs, slackInline } from './support/handoffs.ts';
import { type Harness, newHarness, slackOk, TEST_CLIENT_ID } from './support/harness.ts';
import { fetchListener, LISTENER_COMMAND, stopListeners } from './support/listener.ts';
import { newOrganisationHarness, READ_CLIENT_ID } from './support/organisation.ts';

/**
 * Changing a workspace from a chat: connecting, signing in again, moving the mode, setting its policies, removing it.
 *
 * The owner's rule of 2026-09-25 — every capability from both surfaces — put these on the MCP server, and superseded
 * the older one that an agent never widens. What replaced it is a change approval: anything that loosens what a
 * workspace may do, or cannot be taken back, is shown to the person as a preview and applied only on the call that
 * claims their approval — a yes in the conversation under the `chat` change policy, `agentcomms approve` at their
 * terminal under `confirm`. These tests drive the tools in the order an agent and a person would, play the browser
 * against the real loopback listener, and exchange codes with a stand-in that never reaches Slack.
 */

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface Failure {
  code: string;
  message: string;
  hint: string | null;
  details?: Record<string, unknown>;
}

interface Prepared {
  applied: false;
  approvalRequired: true;
  approvalId: string;
  policy: 'chat' | 'confirm';
  preview: string;
  next: string;
}

interface Started {
  flowId: string;
  alias: string;
  mode: string;
  reauth: boolean;
  authUrl: string;
  finish: { tool: string; command: string };
}

async function connect(harness: Harness, options: { workspace?: string; platform?: NodeJS.Platform } = {}) {
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    listenerCommand: LISTENER_COMMAND,
    // Nothing here reads Slack, and anything that tried would be answered by this rather than by slack.com.
    fetch: async () => new Response(JSON.stringify({ ok: false, error: 'unknown_method' })),
    // The one Windows assertion overrides this; every other command-text assertion is POSIX-pinned.
    platform: options.platform ?? 'darwin',
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name);
  return { client, call, names, close: () => Promise.all([client.close(), server.close()]) };
}

function ok<T>(result: ToolResult): T {
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent as T;
}

function failed(result: ToolResult): Failure {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return (result.structuredContent as { error: Failure }).error;
}

/** A change the tool prepared instead of making: the preview, and nothing done. */
function prepared(result: ToolResult): Prepared {
  const data = ok<Prepared>(result);
  assert.equal(data.applied, false, JSON.stringify(data));
  assert.equal(data.approvalRequired, true);
  assert.match(data.approvalId, /^ap_/);
  return data;
}

/** A change the tool made, and what it returned. */
function applied<T>(result: ToolResult): T {
  const data = ok<{ applied: boolean; result: T }>(result);
  assert.equal(data.applied, true, JSON.stringify(data));
  return data.result;
}

/** A port nothing is listening on right now — on `localhost`, the host the listener binds. See `cli.test.ts`. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((settle) => server.listen(0, 'localhost', () => settle()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((settle) => server.close(() => settle()));
  return port;
}

/** Listeners the sign-ins below started, stopped after each test however it ended. */
let strays: number[] = [];
afterEach(async () => {
  const started = strays;
  strays = [];
  await stopListeners(started);
});

async function track(harness: Harness, flowId: string): Promise<void> {
  const flow = await openFlowStore(
    harness.core.paths.stateDir,
    () => new Date(),
    slackHandoffs(harness.core.paths),
  ).peek(flowId);
  if (flow?.listenerPid) strays.push(flow.listenerPid);
}

const pendingFlows = (harness: Harness) =>
  openFlowStore(harness.core.paths.stateDir, () => new Date(), slackHandoffs(harness.core.paths)).pending();

test('slack_workspace_add selects the profile app with omitted arguments and keeps explicit own-app port validation', async () => {
  const port = await freePort();
  const harness = await newOrganisationHarness({ port, readAppId: 'A0READ', sendAppId: 'A0SEND' });
  const mcp = await connect(harness);
  try {
    const started = applied<Started>(await mcp.call('slack_workspace_add', { workspace: 'rgc/slack' }));
    await track(harness, started.flowId);
    const flow = await harness.context().flows.peek(started.flowId);
    assert.equal(flow?.clientId, READ_CLIENT_ID);
    assert.equal(flow?.port, port);
    assert.equal(flow?.profile?.role, 'read');
    // The profile names its workspace, so the link sends the browser there rather than wherever it was last.
    assert.equal(new URL(started.authUrl).searchParams.get('team'), 'TRGC0001');
    const own = failed(await mcp.call('slack_workspace_add', { workspace: 'other/slack', clientId: TEST_CLIENT_ID }));
    assert.equal(own.code, 'USAGE');
    assert.match(own.message, /port/i);
  } finally {
    await mcp.close();
  }
});

/** Plays the browser: back to the loopback with a code, as Slack would redirect after the person approved. */
async function approveInSlack(started: Started): Promise<void> {
  const url = new URL(started.authUrl);
  const back = new URL(url.searchParams.get('redirect_uri') as string);
  back.searchParams.set('state', url.searchParams.get('state') as string);
  back.searchParams.set('code', 'fake-authorisation-code');
  await fetchListener(back);
}

/** Approves a change at a terminal the way `agentcomms approve` does, for the `confirm` change policy. */
async function approveAtTerminal(harness: Harness, approvalId: string): Promise<void> {
  const prompt = await beginChangeApproval(harness.core, approvalId, { surface: 'cli' });
  await finishChangeApproval(harness.core, approvalId, prompt.challenge, { surface: 'cli' });
}

async function modeOf(harness: Harness, alias: string): Promise<string | undefined> {
  return (await harness.core.config.load()).accounts[alias]?.mode;
}

// ── Connecting ───────────────────────────────────────────────────────────────────────────────────────────────

test('MCP cancellation leaves the detached sign-in for a later finish after browser approval', async () => {
  const harness = await newHarness();
  const mcp = await connect(harness);
  try {
    const started = applied<Started>(
      await mcp.call('slack_workspace_add', {
        workspace: 'acme',
        clientId: TEST_CLIENT_ID,
        port: await freePort(),
      }),
    );
    await track(harness, started.flowId);
    const controller = new AbortController();
    const waiting = mcp.client.callTool(
      {
        name: 'slack_workspace_finish',
        arguments: {
          flowId: started.flowId,
          waitSeconds: 3,
        },
      },
      { signal: controller.signal },
    );
    const cancelled = assert.rejects(waiting);
    await new Promise((done) => setTimeout(done, 100));
    controller.abort();
    await cancelled;
    await approveInSlack(started);
    // Give an incorrectly uncancelled server call two polling intervals to consume the callback.
    await new Promise((done) => setTimeout(done, 1100));
    assert.equal(harness.calls.length, 0, 'the cancelled MCP request consumed the callback');
    assert.equal((await harness.core.config.load()).accounts.acme, undefined);
    const view = ok<{ alias: string }>(
      await mcp.call('slack_workspace_finish', {
        flowId: started.flowId,
        waitSeconds: 0,
      }),
    );
    assert.equal(view.alias, 'acme');
    assert.equal(harness.calls.length, 1);
  } finally {
    await mcp.close();
  }
});

test('connecting in read starts at once and returns the link; finishing records what Slack granted', async () => {
  const harness = await newHarness();
  const { call, close } = await connect(harness, { platform: 'darwin' });
  try {
    const port = await freePort();
    const started = applied<Started>(
      await call('slack_workspace_add', { workspace: 'acme', clientId: TEST_CLIENT_ID, port }),
    );
    await track(harness, started.flowId);
    assert.equal(started.mode, 'read');
    assert.equal(started.reauth, false);
    assert.doesNotMatch(started.authUrl, /chat%3Awrite/, 'a read sign-in asks for no posting');
    assert.equal(new URL(started.authUrl).searchParams.has('team'), false, 'an own app names no workspace');
    assert.deepEqual(started.finish, {
      tool: 'slack_workspace_finish',
      // This installation's own command, located; never a bare `agent-slack` (CUE-403).
      command: slackCommand(harness.core.paths, ['workspace', 'add', '--finish', started.flowId], 'darwin'),
    });
    assert.deepEqual(await harness.core.approvals.list(), [], 'nothing loosened, so nobody was asked');

    await approveInSlack(started);
    const view = ok<{ alias: string; mode: string }>(
      await call('slack_workspace_finish', { flowId: started.flowId, waitSeconds: 20 }),
    );
    assert.equal(view.alias, 'acme');
    assert.equal(await modeOf(harness, 'acme'), 'read');
  } finally {
    await close();
  }
});

test('connecting in send is approved before any sign-in starts, and the approval is what lets it be recorded', async () => {
  const harness = await newHarness();
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const { call, close } = await connect(harness);
  try {
    const port = await freePort();
    const args = { workspace: 'acme', clientId: TEST_CLIENT_ID, port, mode: 'send' };
    const asked = prepared(await call('slack_workspace_add', args));
    assert.equal(asked.policy, 'chat');
    assert.match(asked.preview, /acme mode \(connected by this change\): read → send/);
    assert.match(asked.preview, /stores a token for acme that can post, upload and react/);
    assert.deepEqual(await pendingFlows(harness), [], 'no sign-in was started before the person agreed');
    assert.equal(harness.calls.length, 0);

    // The person said yes in the conversation.
    const claimed = await call('slack_workspace_add', { ...args, approvalId: asked.approvalId });
    const started = applied<Started>(claimed);
    await track(harness, started.flowId);
    assert.match(started.authUrl, /chat%3Awrite/);
    // The link, and where the approval that made it stands: used (design 2026-10-05 §D8; CUE-404).
    const spent = ok<{ approval?: { id?: string; state?: string } }>(claimed).approval;
    assert.deepEqual([spent?.id, spent?.state], [asked.approvalId, 'used']);
    await approveInSlack(started);
    ok(await call('slack_workspace_finish', { workspace: 'acme', flowId: started.flowId, waitSeconds: 20 }));
    assert.equal(await modeOf(harness, 'acme'), 'send');

    // Single use.
    const again = failed(
      await call('slack_workspace_add', { ...args, workspace: 'other', approvalId: asked.approvalId }),
    );
    assert.match(again.code, /APPROVAL_/);
  } finally {
    await close();
  }
});

test('under the confirm change policy the agent cannot claim it until a person approved it at a terminal', async () => {
  const harness = await newHarness();
  await harness.core.config.update((config) => ({
    ...config,
    defaults: { ...config.defaults, changePolicy: 'confirm' },
  }));
  const { call, close } = await connect(harness);
  try {
    const port = await freePort();
    const args = { workspace: 'acme', clientId: TEST_CLIENT_ID, port, mode: 'send' };
    const asked = prepared(await call('slack_workspace_add', args));
    assert.equal(asked.policy, 'confirm');
    const approve = slackInline(harness.core.paths, ['approve', asked.approvalId], 'darwin');
    assert.ok(asked.next.includes(`ask the user to run ${approve}`), asked.next);
    assertNoBareCommand(asked.next);

    const early = failed(await call('slack_workspace_add', { ...args, approvalId: asked.approvalId }));
    assert.equal(early.code, 'APPROVAL_PENDING');
    assert.ok(early.hint?.includes(approve), early.hint ?? undefined);
    assertNoBareCommand(early.hint ?? '');
    assert.deepEqual(await pendingFlows(harness), []);

    await approveAtTerminal(harness, asked.approvalId);
    const started = applied<Started>(await call('slack_workspace_add', { ...args, approvalId: asked.approvalId }));
    await track(harness, started.flowId);
    assert.equal(started.mode, 'send');
  } finally {
    await close();
  }
});

test('an approval is for the change it showed: another name or another app is refused, and voids it', async () => {
  const harness = await newHarness();
  const { call, close } = await connect(harness);
  try {
    const port = await freePort();
    const args = { workspace: 'acme', clientId: TEST_CLIENT_ID, port, mode: 'send' };
    for (const swapped of [{ workspace: 'zeta' }, { clientId: '999.999' }]) {
      const asked = prepared(await call('slack_workspace_add', args));
      const other = failed(await call('slack_workspace_add', { ...args, ...swapped, approvalId: asked.approvalId }));
      assert.equal(other.code, 'APPROVAL_VOID', JSON.stringify(swapped));
      // Voided, so the change it did show cannot use it either now.
      const shown = failed(await call('slack_workspace_add', { ...args, approvalId: asked.approvalId }));
      assert.equal(shown.code, 'APPROVAL_VOID');
    }
    assert.deepEqual(await pendingFlows(harness), []);
  } finally {
    await close();
  }
});

// ── Signing in again, and the mode ───────────────────────────────────────────────────────────────────────────

test('a renewal starts at once; read → send by reauth is approved first', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: await freePort() });
  const { call, close } = await connect(harness);
  try {
    const renewal = applied<Started>(await call('slack_workspace_reauth', { workspace: 'acme' }));
    await track(harness, renewal.flowId);
    assert.equal(renewal.reauth, true);
    assert.equal(renewal.mode, 'read', 'its own mode, not a default');
    // A renewal must come back as the same workspace, so the link names it.
    assert.equal(new URL(renewal.authUrl).searchParams.get('team'), 'T0001');
    assert.equal(
      renewal.finish.command,
      slackCommand(harness.core.paths, ['workspace', 'reauth', 'acme', '--finish', renewal.flowId], 'darwin'),
    );

    const widening = prepared(await call('slack_workspace_reauth', { workspace: 'acme', mode: 'send' }));
    assert.match(widening.preview, /acme mode: read → send/);
    assert.match(widening.preview, /signs in to Slack again as acme/);
  } finally {
    await close();
  }
});

test('slack_mode_set hands over the app step first, then asks, then signs in; a grant without posting says why', async () => {
  const harness = await newHarness();
  const port = await freePort();
  await harness.addWorkspace({ alias: 'acme', redirectPort: port });
  const { call, close } = await connect(harness, { platform: 'win32' });
  try {
    // 1. The recorded grant cannot show the app was widened: the manifest and its page, and nothing started.
    const appStep = ok<{
      changed: boolean;
      appUpdateNeeded: boolean;
      steps: string[];
      manifest: { manifestUrl: string; port: number };
      terminalAlternative: string;
    }>(await call('slack_mode_set', { workspace: 'acme', mode: 'send' }));
    assert.equal(appStep.changed, false);
    assert.equal(appStep.appUpdateNeeded, true);
    assert.equal(appStep.manifest.manifestUrl, 'https://api.slack.com/apps/A0001/app-manifest');
    assert.equal(appStep.manifest.port, port);
    assert.equal(
      appStep.terminalAlternative,
      slackCommand(harness.core.paths, ['app', 'update', 'acme', '--mode', 'send', '--port', String(port)], 'win32'),
    );
    assert.match(appStep.terminalAlternative, / app update acme --mode send --port "\d+"$/);
    assertNoBareCommand(JSON.stringify(appStep));
    assert.deepEqual(await harness.core.approvals.list(), []);

    // 2. The person says the app is updated: a change to approve.
    const asked = prepared(await call('slack_mode_set', { workspace: 'acme', mode: 'send', appUpdated: true }));
    assert.match(asked.preview, /acme mode: read → send/);

    // 3. They said yes. But they saved the manifest on another app, so Slack grants reading again.
    const started = applied<Started>(
      await call('slack_mode_set', { workspace: 'acme', mode: 'send', appUpdated: true, approvalId: asked.approvalId }),
    );
    await track(harness, started.flowId);
    assert.match(started.authUrl, /chat%3Awrite/);
    await approveInSlack(started);
    const refused = failed(
      await call('slack_workspace_finish', { workspace: 'acme', flowId: started.flowId, waitSeconds: 20 }),
    );
    assert.equal(refused.code, 'SCOPE_MISSING');
    assert.match(refused.message, /Slack granted no posting scope, so the app's manifest was not updated to send/);
    assert.match(refused.hint ?? '', / app update acme --mode send --port "\d+"` does it at a terminal/);
    assertNoBareCommand(refused.hint ?? '');
    assert.equal(await modeOf(harness, 'acme'), 'read', 'nothing was saved');
  } finally {
    await close();
  }
});

test('slack_mode_set to read returns the procedure and changes nothing; to the mode it has, the report', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'loud', mode: 'send', redirectPort: 50123 });
  const { call, close } = await connect(harness);
  try {
    const before = JSON.stringify(await harness.core.config.load());
    const narrowing = ok<{ changed: boolean; steps: string[] }>(
      await call('slack_mode_set', { workspace: 'loud', mode: 'read' }),
    );
    assert.equal(narrowing.changed, false);
    assert.match(narrowing.steps.join('\n'), /Remove app/);
    assert.match(narrowing.steps.join('\n'), /workspace reauth loud --mode read --port 50123/);
    const report = ok<{ mode: string; canActOutward: boolean }>(
      await call('slack_mode_set', { workspace: 'loud', mode: 'send' }),
    );
    assert.equal(report.mode, 'send');
    assert.equal(report.canActOutward, true);
    assert.equal(JSON.stringify(await harness.core.config.load()), before);
    assert.deepEqual(await harness.core.approvals.list(), []);
  } finally {
    await close();
  }
});

// ── Removing, and the policies ───────────────────────────────────────────────────────────────────────────────

test('removing is approved first, then deletes the token and the entry', async () => {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme' });
  const secrets = await harness.core.secrets('file');
  const { call, close } = await connect(harness);
  try {
    const asked = prepared(await call('slack_workspace_remove', { workspace: 'acme' }));
    assert.match(asked.preview, /removes acme and deletes its token from this machine/);
    assert.ok(await secrets.get(account.secretRef), 'removed before anybody agreed');

    const removed = applied<{ alias: string; removed: boolean }>(
      await call('slack_workspace_remove', { workspace: 'acme', approvalId: asked.approvalId }),
    );
    assert.equal(removed.removed, true);
    assert.equal(await secrets.get(account.secretRef), null);
    assert.equal((await harness.core.config.load()).accounts.acme, undefined);
  } finally {
    await close();
  }
});

test('a policy is reported; tightening applies at once; loosening is approved, under the policy in force before it', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const { call, close } = await connect(harness);
  try {
    const report = ok<Record<string, unknown>>(await call('slack_workspace_policy', { workspace: 'acme' }));
    assert.deepEqual(report, {
      alias: 'acme',
      sendPolicy: 'chat',
      sendPolicySetOn: 'default',
      changePolicy: 'chat',
      changePolicySetOn: 'default',
      changed: false,
      previous: { sendPolicy: 'chat', changePolicy: 'chat' },
    });

    // Tightening both: nobody is asked.
    const tightened = applied<{ sendPolicy: string; changePolicy: string; changed: boolean }>(
      await call('slack_workspace_policy', { workspace: 'acme', sendPolicy: 'never', changePolicy: 'confirm' }),
    );
    assert.deepEqual([tightened.sendPolicy, tightened.changePolicy, tightened.changed], ['never', 'confirm', true]);
    assert.deepEqual(await harness.core.approvals.list(), []);

    // Loosening the send policy, now that changes to acme are approved under confirm: a terminal, not the chat.
    const asked = prepared(await call('slack_workspace_policy', { workspace: 'acme', sendPolicy: 'chat' }));
    assert.equal(asked.policy, 'confirm');
    assert.match(asked.preview, /acme send policy: never → chat/);
    const early = failed(
      await call('slack_workspace_policy', { workspace: 'acme', sendPolicy: 'chat', approvalId: asked.approvalId }),
    );
    assert.equal(early.code, 'APPROVAL_PENDING');
    const account = (await harness.core.config.load()).accounts.acme;
    assert.equal(account?.sendPolicy, 'never');

    await approveAtTerminal(harness, asked.approvalId);
    const loosened = applied<{ sendPolicy: string; previous: { sendPolicy: string } }>(
      await call('slack_workspace_policy', { workspace: 'acme', sendPolicy: 'chat', approvalId: asked.approvalId }),
    );
    assert.equal(loosened.sendPolicy, 'chat');
    assert.equal(loosened.previous.sendPolicy, 'never');

    // And moving the change policy itself off confirm is approved under confirm.
    const itself = prepared(await call('slack_workspace_policy', { workspace: 'acme', changePolicy: 'chat' }));
    assert.equal(itself.policy, 'confirm');
  } finally {
    await close();
  }
});

test('an approval binds every setting its preview showed: a claim that drops a tightening is refused', async () => {
  // Shown "posts approved under never, changes approved under chat"; claimed with the change policy alone, which
  // loosens the same thing — so the loosenings matched, and posts stayed approved in chat.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const { call, close } = await connect(harness);
  const both = { workspace: 'acme', sendPolicy: 'never', changePolicy: 'chat' };
  try {
    applied(await call('slack_workspace_policy', { workspace: 'acme', changePolicy: 'confirm' }));
    const asked = prepared(await call('slack_workspace_policy', both));
    assert.equal(asked.policy, 'confirm');
    assert.match(asked.preview, /posts approved under never/);
    await approveAtTerminal(harness, asked.approvalId);

    const dropped = failed(
      await call('slack_workspace_policy', { workspace: 'acme', changePolicy: 'chat', approvalId: asked.approvalId }),
    );
    assert.equal(dropped.code, 'APPROVAL_VOID');
    assert.match(dropped.message, /accounts\.acme\.sendPolicy/);
    const acme = (await harness.core.config.load()).accounts.acme;
    assert.deepEqual([acme?.sendPolicy, acme?.changePolicy], [undefined, 'confirm'], 'the claim wrote something');

    const again = prepared(await call('slack_workspace_policy', both));
    await approveAtTerminal(harness, again.approvalId);
    applied(await call('slack_workspace_policy', { ...both, approvalId: again.approvalId }));
    const made = (await harness.core.config.load()).accounts.acme;
    assert.deepEqual([made?.sendPolicy, made?.changePolicy], ['never', 'chat']);
  } finally {
    await close();
  }
});

// ── A pinned server ──────────────────────────────────────────────────────────────────────────────────────────

test('a pinned server neither connects another workspace nor removes its own, and finishes only its own sign-in', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: await freePort() });
  const unpinned = await connect(harness);
  const pinned = await connect(harness, { workspace: 'acme' });
  try {
    const names = await pinned.names();
    assert.ok(!names.includes('slack_workspace_add'), 'a pinned server offers no way to grow what it reaches');
    assert.ok(!names.includes('slack_workspace_remove'), 'or to strand itself');
    for (const kept of [
      'slack_workspace_reauth',
      'slack_workspace_finish',
      'slack_mode_set',
      'slack_workspace_policy',
    ]) {
      assert.ok(names.includes(kept), `${kept} acts on the pinned workspace, and is offered`);
    }

    // A sign-in to connect another workspace, started elsewhere, cannot be finished here.
    const other = applied<Started>(
      await unpinned.call('slack_workspace_add', {
        workspace: 'zeta',
        clientId: TEST_CLIENT_ID,
        port: await freePort(),
      }),
    );
    await track(harness, other.flowId);
    const refused = failed(await pinned.call('slack_workspace_finish', { flowId: other.flowId, waitSeconds: 0 }));
    assert.equal(refused.code, 'USAGE');
    assert.match(refused.message, /is for "zeta", not "acme"/);

    // Its own renewal it can start and finish.
    const renewal = applied<Started>(await pinned.call('slack_workspace_reauth', {}));
    await track(harness, renewal.flowId);
    await approveInSlack(renewal);
    const view = ok<{ alias: string }>(
      await pinned.call('slack_workspace_finish', { flowId: renewal.flowId, waitSeconds: 20 }),
    );
    assert.equal(view.alias, 'acme');
  } finally {
    await Promise.all([unpinned.close(), pinned.close()]);
  }
});

test('a pinned server keeps serving its workspace after its own reauth, drafts and all', async () => {
  /*
   * A reauth gave the account a new id, and the pin is to an id — so the server's own `slack_workspace_reauth` left
   * every later call refused as "no longer connected" until the client was restarted, and the workspace's drafts,
   * filed under the old id, belonged to nobody. The renewal is the same person in the same workspace through the same
   * app, checked before anything is written; it keeps the id and replaces only the credential.
   */
  const harness = await newHarness();
  const original = await harness.addWorkspace({ alias: 'acme', redirectPort: await freePort() });
  const context = new SlackContext({ core: harness.core, env: harness.env });
  const draft = await createDraft(context, 'acme', { channel: 'C1', text: 'written before the renewal' });
  const pinned = await connect(harness, { workspace: 'acme' });
  try {
    const renewal = applied<Started>(await pinned.call('slack_workspace_reauth', {}));
    await track(harness, renewal.flowId);
    await approveInSlack(renewal);
    ok(await pinned.call('slack_workspace_finish', { flowId: renewal.flowId, waitSeconds: 20 }));

    const shown = ok<{ alias: string; accountId: string }>(await pinned.call('slack_workspace_show', {}));
    assert.equal(shown.alias, 'acme', 'the pinned server still serves the workspace it was started for');
    const listed = ok<{ workspaces: { alias: string }[] }>(await pinned.call('slack_workspaces_list', {}));
    assert.deepEqual(
      listed.workspaces.map((workspace) => workspace.alias),
      ['acme'],
    );
    const drafts = ok<{ drafts: { draftId: string }[] }>(await pinned.call('slack_draft_list', {}));
    assert.deepEqual(
      drafts.drafts.map((row) => row.draftId),
      [draft.draftId],
      'and its drafts are still its own',
    );

    const renewed = (await harness.core.config.load()).accounts.acme;
    assert.equal(renewed?.id, original.id, 'the same account, renewed');
    assert.notEqual(renewed?.secretRef, original.secretRef, 'with its new credential beside the old, not over it');
    const secrets = await harness.core.secrets('file');
    assert.equal(await secrets.get(original.secretRef), null, 'and the superseded one removed');
  } finally {
    await pinned.close();
  }
});

test('a pinned server refuses its name once it holds another workspace, or the same one connected again', async () => {
  /*
   * What the pin is for. Removed and connected again under the same name is a different connection — another
   * workspace, or this one with whatever mode and policy it was given this time — and a pinned server that followed
   * the name would serve it without anybody having pinned it to that. Only a renewal, checked to be the same person,
   * workspace and app, keeps the account the pin names.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: await freePort() });
  const pinned = await connect(harness, { workspace: 'acme' });
  const drop = () =>
    harness.core.config.update((config) => {
      const { acme: _gone, ...rest } = config.accounts;
      return { ...config, accounts: rest };
    });
  const refusedEverywhere = async (why: string) => {
    for (const [tool, args] of [
      ['slack_workspace_show', {}],
      ['slack_workspace_show', { workspace: 'acme' }],
      ['slack_draft_list', {}],
      ['slack_mode', {}],
    ] as const) {
      const refused = failed(await pinned.call(tool, args));
      assert.equal(refused.code, 'CONFIG', `${why}: ${tool} ${JSON.stringify(refused)}`);
      assert.match(refused.message, /was removed, and "acme" now names another/, `${why}: ${tool}`);
      assert.match(refused.hint ?? '', /Restart the client/, `${why}: ${tool}`);
    }
    const listed = ok<{ workspaces: unknown[] }>(await pinned.call('slack_workspaces_list', {}));
    assert.deepEqual(listed.workspaces, [], `${why}: nor does it describe what took the name`);
  };
  try {
    await drop();
    await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0002', userId: 'U0002', appId: 'A0002' });
    await refusedEverywhere('another workspace under the name');

    await drop();
    await harness.addWorkspace({ alias: 'acme' });
    await refusedEverywhere('the same workspace, connected again');

    await drop();
    const gone = failed(await pinned.call('slack_workspace_show', {}));
    assert.equal(gone.code, 'NOT_FOUND');
    assert.match(gone.message, /the workspace this server was pinned to, "acme", was removed/);
  } finally {
    await pinned.close();
  }
});

// ── The same operation on both surfaces ──────────────────────────────────────────────────────────────────────

async function cliJson(harness: Harness, argv: string[]) {
  let stdout = '';
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const quiet = new PassThrough();
  const code = await run(['--json', ...argv], {
    core: harness.core,
    env: { ...harness.env, CLAUDECODE: '1' },
    exchange: (params) => harness.exchange(params),
    streams: { stdout: out, stderr: quiet, stdin: new PassThrough() },
    openBrowser: () => undefined,
    listenerCommand: LISTENER_COMMAND,
    // The same platform as `connect`'s server, so both surfaces print a command the same way on any host.
    platform: 'darwin',
  });
  return { code, envelope: JSON.parse(stdout) as { ok: boolean; data?: unknown; error?: Failure } };
}

test('the command and the tool return the same result, and refuse the same things in the same words', async () => {
  const harness = await newHarness();
  const port = await freePort();
  await harness.addWorkspace({ alias: 'acme', redirectPort: port });
  const { call, close } = await connect(harness);
  try {
    const policyCli = await cliJson(harness, ['workspace', 'policy', 'acme']);
    assert.deepEqual(ok(await call('slack_workspace_policy', { workspace: 'acme' })), policyCli.envelope.data);

    const appStepCli = await cliJson(harness, ['workspace', 'mode', 'acme', 'send']);
    assert.equal(appStepCli.code, EXIT_CODES.OK);
    assert.deepEqual(ok(await call('slack_mode_set', { workspace: 'acme', mode: 'send' })), appStepCli.envelope.data);

    const refusals: [string[], string, Record<string, unknown>][] = [
      // A name already connected.
      [
        ['workspace', 'add', 'acme', '--client-id', TEST_CLIENT_ID, '--port', String(port)],
        'slack_workspace_add',
        { workspace: 'acme', clientId: TEST_CLIENT_ID, port },
      ],
      // No port, and none recorded for a new workspace.
      [
        ['workspace', 'add', 'zeta', '--client-id', TEST_CLIENT_ID],
        'slack_workspace_add',
        { workspace: 'zeta', clientId: TEST_CLIENT_ID },
      ],
      // A workspace that is not connected.
      [['workspace', 'remove', 'nope'], 'slack_workspace_remove', { workspace: 'nope' }],
    ];
    for (const [argv, tool, args] of refusals) {
      const fromCli = (await cliJson(harness, argv)).envelope.error;
      const fromTool = failed(await call(tool, args));
      assert.equal(fromTool.code, fromCli?.code, argv.join(' '));
      assert.equal(fromTool.message, fromCli?.message, argv.join(' '));
    }
    assert.deepEqual(await pendingFlows(harness), []);
  } finally {
    await close();
  }
});

test('the greeting says how a change is approved, and a pinned one offers no way to connect another workspace', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const greetingOf = async (workspace?: string) => {
    const { server } = await createSlackMcpServer({
      core: harness.core,
      env: harness.env,
      ...(workspace ? { workspace } : {}),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const greeting = client.getInstructions() ?? '';
    await Promise.all([client.close(), server.close()]);
    return greeting;
  };
  /*
   * The greeting no longer walks through the change tools one by one: that list pushed it past the 2 KB a client
   * keeps, and each tool's description carries its own steps. What it must still say is how any change is approved.
   */
  const open = await greetingOf();
  for (const said of [
    /`send` mode, a looser policy, removing one/,
    /approvalRequired/,
    /`approvalId` after their yes/,
    /they first run the approve command the result gives/,
    /you cannot approve it yourself/,
    /Tightening applies at once/,
  ]) {
    assert.match(open, said);
  }
  const pinned = await greetingOf('acme');
  assert.doesNotMatch(
    pinned,
    /slack_workspace_add|slack_workspace_remove|removing one/,
    'it offers what this server does not have',
  );
  assert.match(pinned, /approvalRequired/);
  assert.match(pinned, /you cannot approve it yourself/);
});
