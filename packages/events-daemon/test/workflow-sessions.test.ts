import assert from 'node:assert/strict';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FlowDocumentV1, FlowStep } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { RelayClient, RelayError, readRelayToken } from '../src/runtime/relay-client.ts';
import { createFindSessionExecutor, type SessionStepDeps } from '../src/runtime/workflow/steps/find-session.ts';
import { createStartSessionExecutor, sessionTitle } from '../src/runtime/workflow/steps/start-session.ts';
import { FakeRelay } from './support/fake-relay.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { OWNER_EXAMPLE, STEP_CONTEXT_NOW, stepContext } from './support/step-context.ts';

/*
 * Find a session, and start one (workflows design §6.2, §6.3, §7.4), against the loopback fake relay: no real
 * claude-stream is started or contacted, and its token is the fake's, in a temporary relay home. Every folder is a
 * temporary one, and the allowed roots are those folders' own root.
 */

interface Relayed {
  readonly relay: FakeRelay;
  readonly root: string;
  readonly acme: string;
  readonly billing: string;
  readonly outside: string;
  readonly own: string;
  readonly rule: CanonicalFullRuleDocument & { readonly flow: FlowDocumentV1 };
  readonly deps: SessionStepDeps & { readonly bindings: Map<string, { sessionId: string | null; since: number }> };
}

async function withRelay(work: (relayed: Relayed) => Promise<void>): Promise<void> {
  const root = await realpath(await shortTempDir('aev-flow-sessions-'));
  const away = await realpath(await shortTempDir('aev-flow-away-'));
  const work_ = join(root, 'work');
  const acme = join(work_, 'acme-site');
  const billing = join(work_, 'billing');
  const own = join(work_, 'agentcomms');
  const outside = join(away, 'elsewhere');
  for (const folder of [acme, billing, own, outside]) await mkdir(folder, { recursive: true });
  const relay = await new FakeRelay({ allowedRoots: [work_] }).start();
  try {
    const home = await relay.writeHome(root);
    const client = new RelayClient({
      url: relay.url,
      token: await readRelayToken(home),
      attestListener: async () => ({ kind: 'unattested', platform: 'test' }),
    });
    const route = OWNER_EXAMPLE.flow.steps.route as Extract<FlowStep, { kind: 'route' }>;
    const rule = {
      ...OWNER_EXAMPLE,
      flow: {
        ...OWNER_EXAMPLE.flow,
        steps: {
          ...OWNER_EXAMPLE.flow.steps,
          route: {
            ...route,
            candidates: [
              { projectId: 'acme-site', name: 'acme-site', folders: [acme], worktreeRoot: null },
              { projectId: 'billing', name: 'billing', folders: [billing], worktreeRoot: null },
            ],
          },
        },
      },
    } as CanonicalFullRuleDocument & { readonly flow: FlowDocumentV1 };
    const bindings = new Map<string, { sessionId: string | null; since: number }>();
    const deps = {
      relay: async () => ({ client }),
      sessionRoots: async () => [work_],
      deniedFolders: () => [own],
      laneBinding: (lane: string) => bindings.get(lane) ?? null,
      bindings,
    };
    await work({ relay, root, acme, billing, outside, own, rule, deps });
  } finally {
    await relay.stop();
    await rm(root, { recursive: true, force: true });
    await rm(away, { recursive: true, force: true });
  }
}

const ROUTED = {
  route: { project: 'acme-site', projectName: 'acme-site', reason: 'judge', score: 0.9, profileHash: 'x' },
};

test('find in a project: idle, busy, none and watched, by realpath cwd among the approved folders', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRelay(async ({ relay, acme, billing, rule, deps, root }) => {
    const find = createFindSessionExecutor(deps);
    const ctx = () => stepContext({ rule, stepId: 'find', outputs: ROUTED });
    relay.addSession({ cwd: billing });
    assert.deepEqual(await find.run(ctx()), {
      kind: 'settled',
      outcome: 'none',
      output: { session: null, provider: 'claude' },
    });
    const watched = relay.addSession({ cwd: acme, attached: 'observer' });
    assert.deepEqual(await find.run(ctx()), {
      kind: 'settled',
      outcome: 'watched',
      output: { session: watched.id, provider: 'claude' },
    });
    const session = relay.addSession({ cwd: acme });
    assert.deepEqual(await find.run(ctx()), {
      kind: 'settled',
      outcome: 'idle',
      output: { session: session.id, provider: 'claude' },
    });
    relay.startRunElsewhere(session.id);
    assert.deepEqual(await find.run(ctx()), {
      kind: 'settled',
      outcome: 'busy',
      output: { session: session.id, provider: 'claude' },
    });
    // A worktree this run made of the project is one of its folders too.
    const tree = join(root, 'work', 'acme-site-wt', 'ac-acme-1');
    await mkdir(tree, { recursive: true });
    relay.endRun(session.id);
    relay.startRunElsewhere(session.id);
    const inTree = relay.addSession({ cwd: tree });
    const fromTree = await find.run(
      stepContext({
        rule,
        stepId: 'find',
        outputs: { ...ROUTED, tree: { branch: 'ac/acme-1', path: tree, refusal: null } },
      }),
    );
    assert.equal(fromTree.kind === 'settled' && fromTree.output.session, session.id, 'the busy one is the most recent');
    relay.endRun(session.id);
    const idleTree = await find.run(
      stepContext({
        rule,
        stepId: 'another',
        outputs: { ...ROUTED, tree: { branch: 'ac/acme-1', path: tree, refusal: null } },
      }),
    );
    assert.equal(idleTree.kind === 'settled' && idleTree.outcome, 'idle');
    assert.ok(
      idleTree.kind === 'settled' && [session.id, inTree.id].includes(idleTree.output.session as string),
      'an idle session in the checkout or the run-made worktree',
    );
    // A route that chose nothing leaves nowhere to look.
    const nowhere = await find.run(stepContext({ rule, stepId: 'find', outputs: {} }));
    assert.equal(nowhere.kind === 'settled' && nowhere.outcome, 'none');
  });
});

test('only idle passes over busy sessions', { skip: WINDOWS_SKIP }, async () => {
  await withRelay(async ({ relay, acme, rule, deps }) => {
    const another = createFindSessionExecutor(deps);
    const busy = relay.addSession({ cwd: acme });
    relay.startRunElsewhere(busy.id);
    assert.deepEqual(await another.run(stepContext({ rule, stepId: 'another', outputs: ROUTED })), {
      kind: 'settled',
      outcome: 'none',
      output: { session: null, provider: 'claude' },
    });
    const idle = relay.addSession({ cwd: acme, createdAt: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(await another.run(stepContext({ rule, stepId: 'another', outputs: ROUTED })), {
      kind: 'settled',
      outcome: 'idle',
      output: { session: idle.id, provider: 'claude' },
    });
  });
});

test('the provider must match; of several, the most recently active wins', { skip: WINDOWS_SKIP }, async () => {
  await withRelay(async ({ relay, acme, rule, deps }) => {
    const find = createFindSessionExecutor(deps);
    relay.addSession({ cwd: acme, provider: 'codex', createdAt: '2026-10-27T12:00:00.000Z' });
    relay.addSession({ cwd: acme, createdAt: '2026-10-27T08:00:00.000Z' });
    const newer = relay.addSession({ cwd: acme, createdAt: '2026-10-27T10:00:00.000Z' });
    assert.deepEqual(await find.run(stepContext({ rule, stepId: 'find', outputs: ROUTED })), {
      kind: 'settled',
      outcome: 'idle',
      output: { session: newer.id, provider: 'claude' },
    });
  });
});

test('a lane finds the window bound to it, never one from before the binding', { skip: WINDOWS_SKIP }, async () => {
  await withRelay(async ({ relay, acme, rule, deps }) => {
    const find = createFindSessionExecutor(deps);
    const step = { kind: 'find-session', in: { lane: 'acme' }, provider: 'claude', next: {} } as FlowStep;
    const window = relay.addSession({ cwd: acme, nativeSessionId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' });
    const unbound = await find.run(stepContext({ rule, stepId: 'find', step }));
    assert.equal(unbound.kind === 'settled' && unbound.outcome, 'none', 'no window is bound to the lane');
    deps.bindings.set('acme', { sessionId: window.nativeSessionId ?? null, since: STEP_CONTEXT_NOW - 1 });
    assert.deepEqual(await find.run(stepContext({ rule, stepId: 'find', step })), {
      kind: 'settled',
      outcome: 'idle',
      output: { session: window.id, provider: 'claude' },
    });
    deps.bindings.set('acme', { sessionId: window.nativeSessionId ?? null, since: STEP_CONTEXT_NOW + 1 });
    const before = await find.run(stepContext({ rule, stepId: 'find', step }));
    assert.equal(before.kind === 'settled' && before.outcome, 'none');
  });
});

test('relay down retries 12 times, then failed', { skip: WINDOWS_SKIP }, async () => {
  await withRelay(async ({ relay, rule, deps }) => {
    await relay.stop();
    const find = createFindSessionExecutor(deps);
    const first = await find.run(stepContext({ rule, stepId: 'find', outputs: ROUTED }));
    assert.equal(first.kind, 'retry');
    assert.equal(first.kind === 'retry' && first.at, STEP_CONTEXT_NOW + 1_000);
    const sixth = await find.run(
      stepContext({ rule, stepId: 'find', outputs: ROUTED, attempt: { id: 'a-6', number: 6 } }),
    );
    assert.equal(sixth.kind === 'retry' && sixth.at, STEP_CONTEXT_NOW + 32_000);
    const last = await find.run(
      stepContext({ rule, stepId: 'find', outputs: ROUTED, attempt: { id: 'a-12', number: 12 } }),
    );
    assert.equal(last.kind, 'failed');
    assert.match(last.kind === 'failed' ? last.code : '', /^RELAY_/u);
    const refused = createFindSessionExecutor({
      ...deps,
      relay: async () => {
        throw new RelayError('RELAY_NOT_FOUND', 'no relay');
      },
    });
    assert.deepEqual(
      await refused.run(stepContext({ rule, stepId: 'find', outputs: ROUTED, attempt: { id: 'b', number: 12 } })),
      {
        kind: 'failed',
        code: 'RELAY_NOT_FOUND',
      },
    );
  });
});

const startIn = (place: Record<string, unknown>, mode = 'manual'): FlowStep =>
  ({ kind: 'start-session', in: place, provider: 'claude', mode, next: {} }) as unknown as FlowStep;

function posts(relay: FakeRelay) {
  return relay.requests.filter((request) => request.method === 'POST' && request.path === '/v1/sessions');
}

test('start posts provider, cwd, requestedMode and the title Agent Comms · <workflow> · <run 8>', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRelay(async ({ relay, acme, rule, deps, root }) => {
    const start = createStartSessionExecutor(deps);
    const ctx = stepContext({ rule, stepId: 'start', step: startIn({ folder: acme }) });
    const result = await start.run(ctx);
    const made = relay.sessions.at(-1);
    assert.deepEqual(result, {
      kind: 'settled',
      outcome: 'started',
      output: { session: made?.id, provider: 'claude', mode: 'manual', refusal: null },
    });
    assert.deepEqual(
      posts(relay).map((request) => request.body),
      [{ provider: 'claude', cwd: acme, requestedMode: 'manual', title: 'Agent Comms · client-asks · 01234567' }],
    );
    assert.equal(sessionTitle(ctx), 'Agent Comms · client-asks · 01234567');
    assert.deepEqual(ctx.charged, ['session-start']);
    assert.ok(ctx.fenced.count >= 1);
    // In a worktree this run made, acceptEdits; anywhere else it is refused and nothing starts.
    const tree = join(root, 'work', 'acme-site-wt', 'ac-acme-1');
    await mkdir(tree, { recursive: true });
    const inTree = await start.run(
      stepContext({
        rule,
        stepId: 'start',
        run: { id: 'wfr_abcdefghjkmnpqrstvwxyz0123' },
        outputs: { ...ROUTED, tree: { branch: 'ac/acme-1', path: tree, refusal: null } },
      }),
    );
    assert.equal(inTree.kind === 'settled' && inTree.outcome, 'started');
    const edits = await start.run(
      stepContext({ rule, stepId: 'start', step: startIn({ folder: acme }, 'acceptEdits') }),
    );
    assert.deepEqual(edits, {
      kind: 'settled',
      outcome: 'refused',
      output: { session: null, provider: 'claude', mode: 'acceptEdits', refusal: 'ACCEPT_EDITS_OUTSIDE_RUN_WORKTREE' },
    });
    assert.equal(posts(relay).length, 2);
  });
});

test('start charges sessionsPerHour; at the limit it waits', { skip: WINDOWS_SKIP }, async () => {
  await withRelay(async ({ relay, acme, rule, deps }) => {
    const start = createStartSessionExecutor(deps);
    const ctx = stepContext({
      rule,
      stepId: 'start',
      step: startIn({ folder: acme }),
      charge: () => ({ ok: false, until: STEP_CONTEXT_NOW + 600_000 }),
    });
    assert.deepEqual(await start.run(ctx), {
      kind: 'wait',
      wait: 'limit',
      key: null,
      wakeAt: STEP_CONTEXT_NOW + 600_000,
    });
    assert.equal(posts(relay).length, 0);
  });
});

test("a crash after POST /v1/sessions: the retry adopts the session with this run's title and cwd", {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRelay(async ({ relay, acme, rule, deps }) => {
    const { client } = await deps.relay();
    const lost = createStartSessionExecutor({
      ...deps,
      relay: async () => ({
        client: {
          sessions: () => client.sessions(),
          snapshot: (id: string) => client.snapshot(id),
          createSession: async (input: Parameters<RelayClient['createSession']>[0]) => {
            await client.createSession(input);
            throw new RelayError('RELAY_UNREACHABLE', 'the answer was lost');
          },
        },
      }),
    });
    const first = await lost.run(stepContext({ rule, stepId: 'start', step: startIn({ folder: acme }) }));
    assert.equal(first.kind, 'retry');
    const retry = stepContext({
      rule,
      stepId: 'start',
      step: startIn({ folder: acme }),
      attempt: { id: 'a-2', number: 2 },
    });
    const second = await createStartSessionExecutor(deps).run(retry);
    assert.equal(posts(relay).length, 1, 'one session, never two');
    assert.deepEqual(second, {
      kind: 'settled',
      outcome: 'started',
      output: { session: relay.sessions[0]?.id, provider: 'claude', mode: 'manual', refusal: null },
    });
    assert.deepEqual(retry.charged, [], 'an adopted session is not charged again');
  });
});

test('two with the marker: the newer is adopted, the other named', { skip: WINDOWS_SKIP }, async () => {
  await withRelay(async ({ relay, acme, rule, deps }) => {
    const title = 'Agent Comms · client-asks · 01234567';
    const older = relay.addSession({ cwd: acme, title, createdAt: '2026-10-27T08:00:00.000Z' });
    const newer = relay.addSession({ cwd: acme, title, createdAt: '2026-10-27T08:00:05.000Z' });
    relay.addSession({ cwd: acme, title: 'Agent Comms · client-asks · zzzzzzzz' });
    const result = await createStartSessionExecutor(deps).run(
      stepContext({ rule, stepId: 'start', step: startIn({ folder: acme }) }),
    );
    assert.deepEqual(result, {
      kind: 'settled',
      outcome: 'started',
      output: { session: newer.id, provider: 'claude', mode: 'manual', refusal: null, alsoStarted: [older.id] },
    });
    assert.equal(posts(relay).length, 0);
  });
});

test('a folder outside the allowed roots is refused, not started', { skip: WINDOWS_SKIP }, async () => {
  await withRelay(async ({ relay, outside, own, acme, rule, deps }) => {
    const start = createStartSessionExecutor(deps);
    for (const [folder, refusal] of [
      [outside, 'OUTSIDE_ALLOWED_ROOTS'],
      [own, 'AGENT_COMMS_FOLDER'],
      [join(acme, 'not-there'), 'FOLDER_MISSING'],
    ] as const) {
      const result = await start.run(stepContext({ rule, stepId: 'start', step: startIn({ folder }) }));
      assert.deepEqual(result, {
        kind: 'settled',
        outcome: 'refused',
        output: { session: null, provider: 'claude', mode: 'manual', refusal },
      });
    }
    // The relay's own no is the step's refusal too: here its roots are narrower than the person's.
    const wider = createStartSessionExecutor({ ...deps, sessionRoots: async () => [outside] });
    const relayNo = await wider.run(stepContext({ rule, stepId: 'start', step: startIn({ folder: outside }) }));
    assert.equal(relayNo.kind === 'settled' && relayNo.output.refusal, 'RELAY_REFUSED');
    assert.equal(relay.sessions.length, 0, 'nothing was started');
  });
});
