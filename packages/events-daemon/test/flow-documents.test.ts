import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import {
  type ActivationDocumentV1,
  activationDocumentDigest,
  type CanonicalFullRuleDocument,
  canonicalActivationDocument,
  canonicalFullRuleDocument,
} from '../src/domain/activation-documents.ts';
import { FLOW_DOCUMENT_MAX_BYTES } from '../src/domain/flow.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { assertFlowActivation } from '../src/runtime/activations.ts';
import { LinearClient } from '../src/runtime/linear-client.ts';
import { LinearIntegration } from '../src/runtime/linear-integration.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { FAKE_LINEAR_KEY, FAKE_STATES, FAKE_TEAM, startFakeLinear } from './support/fake-linear.ts';
import { RULE, rule, withLaneOwner } from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { OWNER_EXAMPLE } from './support/step-context.ts';

assertLoopbackSeal();

/*
 * B1 (workflows plan): a workflow document may hold a flow. Every document stored before 0.36 keeps its bytes and its
 * digest; a flow is canonical — `checkFlow`'s form, its limits written out in full — and the event service refuses, by
 * a closed code, what `checkFlow` cannot know: its targets, the steps each step names, who may report or edit, its
 * events' name among the active workflows, and the checks every track's composition hands activation.
 */

type Mutable = Record<string, unknown> & {
  flow: Record<string, unknown> & { steps: Record<string, Record<string, unknown>> };
};

const owner = (): Mutable => structuredClone(OWNER_EXAMPLE) as unknown as Mutable;

function refusedWith(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof EventDomainError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  };
}

interface ActivationVector {
  readonly name: string;
  readonly document: ActivationDocumentV1;
  readonly canonical: string;
  readonly digest: string;
}

test('B1: every stored fixture keeps its bytes and digest', async () => {
  const vectors = JSON.parse(
    await readFile(new URL('./fixtures/activation-documents-v1.json', import.meta.url), 'utf8'),
  ) as ActivationVector[];
  assert.ok(vectors.some((vector) => vector.document.kind === 'rule'));
  for (const vector of vectors) {
    assert.equal(canonicalActivationDocument(vector.document), vector.canonical, vector.name);
    assert.equal(activationDocumentDigest(vector.document), vector.digest, vector.name);
  }
});

test('B1: a workflow without a flow canonicalises with no flow key', async () => {
  const vectors = JSON.parse(
    await readFile(new URL('./fixtures/activation-documents-v1.json', import.meta.url), 'utf8'),
  ) as ActivationVector[];
  for (const vector of vectors) {
    if (vector.document.kind !== 'rule') continue;
    const canonical = canonicalFullRuleDocument(vector.document.rule);
    assert.equal(Object.hasOwn(canonical, 'flow'), false, vector.name);
  }
  assert.equal(Object.hasOwn(canonicalFullRuleDocument(rule(1, [dryRun()])), 'flow'), false);
});

test('B1: an unknown top-level key is refused', () => {
  assert.throws(
    () => canonicalFullRuleDocument({ ...rule(1, [dryRun()]), colour: 'red' }),
    (error: unknown) =>
      error instanceof EventDomainError &&
      error.code === 'VERSION_DOCUMENT_INVALID' &&
      /a workflow document has no field colour/u.test(error.message),
  );
});

test('B1: the owner example canonicalises; its limits are written out in full, and a missing one is FLOW_INVALID', () => {
  const canonical = canonicalFullRuleDocument(owner());
  assert.ok(canonical.flow !== undefined);
  assert.deepEqual(Object.keys(canonical.flow.limits).sort(), [
    'concurrentRuns',
    'eventsPerHour',
    'linearWritesPerHour',
    'runMs',
    'runsPerHour',
    'sessionsPerHour',
    'worktreesPerDay',
  ]);
  assert.equal(canonical.flow.limits.runsPerHour, 6);
  // Canonical twice is the same bytes: the digest binds one form.
  assert.deepEqual(canonicalFullRuleDocument(canonical), canonical);
  const missing = owner();
  delete (missing.flow.limits as Record<string, unknown>).runMs;
  assert.throws(
    () => canonicalFullRuleDocument(missing),
    (error: unknown) => {
      refusedWith('FLOW_INVALID')(error);
      const problems = (error as EventDomainError).details?.problems as { code: string; pointer: string | null }[];
      assert.deepEqual(
        problems.map((problem) => [problem.code, problem.pointer]),
        [['FLOW_LIMIT', '/limits/runMs']],
      );
      return true;
    },
  );
});

test('B1: a flow with a cycle is FLOW_INVALID, listing FLOW_CYCLE', () => {
  const cyclic = owner();
  cyclic.flow.steps.note = { ...cyclic.flow.steps.note, next: { otherwise: 'route' } };
  assert.throws(
    () => canonicalFullRuleDocument(cyclic),
    (error: unknown) =>
      refusedWith('FLOW_INVALID')(error) &&
      ((error as EventDomainError).details?.problems as { code: string }[] | undefined)?.some(
        (problem) => problem.code === 'FLOW_CYCLE',
      ) === true,
  );
});

function dryRun(version = 1): Record<string, unknown> {
  return { targetId: 'dry-flow', version, kind: 'dry-run', retentionMs: 86_400_000 };
}

/** The owner example's session target, its provider and the find and start steps' provider set to `provider`. */
function withProvider(document: Mutable, provider: 'claude' | 'codex'): Mutable {
  const targets = document.targets as Record<string, unknown>[];
  document.targets = targets.map((target) => (target.kind === 'session' ? { ...target, provider } : target));
  for (const id of ['find', 'another', 'start']) document.flow.steps[id] = { ...document.flow.steps[id], provider };
  return document;
}

/** A chain of notices, each 4,000 characters, after `tell`: a valid flow larger than 48 KiB. */
function oversized(document: Mutable): Mutable {
  let previous = 'tell';
  for (let index = 1; index <= 13; index += 1) {
    const id = `long-${index}`;
    document.flow.steps[previous] = { ...document.flow.steps[previous], next: { sent: id } };
    document.flow.steps[id] = { kind: 'notify', text: `${'x'.repeat(3_990)} ${index}`, next: {} };
    previous = id;
  }
  return document;
}

const REFUSALS: readonly (readonly [string, () => Record<string, unknown>, string])[] = [
  [
    'a flow: true session target outside a flow',
    () => {
      const document = owner();
      delete (document as Record<string, unknown>).flow;
      return document;
    },
    'FLOW_ONLY_TARGET',
  ],
  [
    'a linear-change target outside a flow',
    () =>
      rule(1, [
        dryRun(),
        {
          targetId: 'close-it',
          version: 1,
          kind: 'linear-change',
          team: { id: FAKE_TEAM.id, key: FAKE_TEAM.key },
          state: { id: FAKE_STATES[1].id, name: 'Done', type: 'completed' },
        },
      ]),
    'FLOW_ONLY_TARGET',
  ],
  ['a report from a Codex session', () => withProvider(owner(), 'codex'), 'REPORT_NEEDS_CLAUDE'],
  [
    'acceptEdits in a project checkout',
    () => {
      const document = owner();
      document.flow.steps.start = { ...document.flow.steps.start, in: { project: 'route' }, mode: 'acceptEdits' };
      return document;
    },
    'ACCEPT_EDITS_OUTSIDE_RUN_WORKTREE',
  ],
  [
    'on.raised naming its own events',
    () => {
      const document = owner();
      document.flow.on = { raised: ['acme.client-asks.issue.created'], withinMs: 86_400_000 };
      return document;
    },
    'CHAIN_SELF',
  ],
  ['a document over 48 KiB', () => oversized(owner()), 'DOCUMENT_TOO_LARGE'],
  [
    'a target no step delivers to',
    () => {
      const document = owner();
      document.targets = [...(document.targets as unknown[]), dryRun()];
      return document;
    },
    'FLOW_TARGET_UNUSED',
  ],
  [
    'a step delivering to a target the workflow does not name',
    () => {
      const document = owner();
      document.flow.steps.issue = { ...document.flow.steps.issue, target: { targetId: 'client-issues', version: 9 } };
      return document;
    },
    'FLOW_TARGET_UNKNOWN',
  ],
  [
    'a Linear change whose to names a step of the wrong kind',
    () => {
      const document = owner();
      document.flow.steps.note = { ...document.flow.steps.note, to: { issue: 'route' } };
      return document;
    },
    'FLOW_TO_KIND',
  ],
  [
    "a worktree whose branch names a step's output that comes after it",
    () => {
      const document = owner();
      document.flow.steps.tree = { ...document.flow.steps.tree, branch: 'ac/{{steps.give.turn}}' };
      return document;
    },
    'FLOW_TO_KIND',
  ],
  [
    'a condition comparing a closed output with a word it never is',
    () => {
      const document = owner();
      document.flow.steps.check = {
        kind: 'condition',
        when: { path: '/steps/route/reason', op: 'equals', value: 'because', caseSensitive: false },
        next: { yes: 'found', no: 'tell' },
      };
      document.flow.steps.route = { ...document.flow.steps.route, next: { none: 'tell', otherwise: 'check' } };
      return document;
    },
    'FLOW_TO_KIND',
  ],
  [
    "the conversation's session, found with Codex",
    () => {
      const document = owner();
      document.flow.steps.find = { ...document.flow.steps.find, in: { thread: true }, provider: 'codex' };
      return document;
    },
    'FIND_THREAD_NEEDS_CLAUDE',
  ],
  [
    'a mapped field named steps in a workflow with a flow',
    () => {
      const document = owner();
      document.mapping = { ...(document.mapping as Record<string, unknown>), steps: { $path: '/text' } };
      return document;
    },
    'VERSION_DOCUMENT_INVALID',
  ],
];

for (const [name, document, code] of REFUSALS)
  test(`B1: a workflow document is refused: ${name} (${code})`, () => {
    assert.throws(() => canonicalFullRuleDocument(document()), refusedWith(code));
  });

test('B1: the oversized flow is otherwise valid, and its bound is the app’s 48 KiB', () => {
  assert.equal(FLOW_DOCUMENT_MAX_BYTES, 48 * 1024);
  const small = owner();
  small.flow.steps.tell = { ...small.flow.steps.tell, next: { sent: 'long-1' } };
  small.flow.steps['long-1'] = { kind: 'notify', text: 'x'.repeat(3_990), next: {} };
  assert.ok(canonicalFullRuleDocument(small).flow !== undefined);
});

test('B1: in a flow a session target may give a step’s closed output, and a Linear title may name one', () => {
  const document = owner();
  const targets = document.targets as Record<string, unknown>[];
  document.targets = targets.map((target) =>
    target.kind === 'session'
      ? { ...target, context: [...(target.context as unknown[]), { step: 'route', field: 'projectName' }] }
      : target,
  );
  const canonical = canonicalFullRuleDocument(document);
  const session = canonical.targets.find((target) => target.kind === 'session');
  assert.deepEqual(session?.kind === 'session' ? session.context.at(-1) : undefined, {
    step: 'route',
    field: 'projectName',
  });
  // A step part names a closed output: a session's summary is not one.
  document.targets = targets.map((target) =>
    target.kind === 'session'
      ? { ...target, context: [...(target.context as unknown[]), { step: 'wait', field: 'summary' }] }
      : target,
  );
  assert.throws(() => canonicalFullRuleDocument(document), refusedWith('FLOW_TO_KIND'));
});

test('B1: activation refuses a second active workflow raising acme.client-asks (EVENT_NAME_IN_USE)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('aev-flow-names-');
  const database = await openEventDatabase({ stateDir: join(root, 'state') });
  try {
    const versions = new ImmutableVersions(database.database);
    for (const target of OWNER_EXAMPLE.targets) versions.createTarget(target as never);
    // Without its judge, whose version and kind are a judge's own activation: here only the names are in question.
    const unjudged = (): Mutable => {
      const document = owner();
      delete (document as Record<string, unknown>).agentic;
      // The route chooses by hints alone, so no judge version needs storing first.
      const { judge: _judge, ...route } = document.flow.steps.route as Record<string, unknown>;
      document.flow.steps.route = { ...route, by: ['hints'] };
      return document;
    };
    versions.createRule(unjudged());
    versions.createRule({ ...unjudged(), ruleId: 'client-asks-copy', version: 1 });
    // Nothing holds the name yet: the second prepares.
    assert.equal(versions.prepareRule('client-asks-copy', 1).rule.ruleId, 'client-asks-copy');
    database.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'client-asks', 5, NULL, 1)",
      )
      .run();
    assert.throws(() => versions.prepareRule('client-asks-copy', 1), refusedWith('EVENT_NAME_IN_USE'));
    // The active workflow's own next version keeps its name.
    versions.createRule({ ...unjudged(), version: 6 });
    assert.equal(versions.prepareRule('client-asks', 6).rule.version, 6);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('B1: a FlowActivationCheck handed in runs after these checks and can refuse', async () => {
  const canonical = canonicalFullRuleDocument(owner());
  const seen: string[] = [];
  const database = {} as never;
  await assertFlowActivation(canonical, database, [
    (rule) => {
      seen.push(`first:${rule.ruleId}`);
    },
    async () => {
      seen.push('second');
    },
  ]);
  assert.deepEqual(seen, ['first:client-asks', 'second']);
  await assert.rejects(
    assertFlowActivation(canonical, database, [
      () => {
        throw new EventDomainError('FLOW_TO_KIND', 'a composition refused');
      },
      () => {
        seen.push('never');
      },
    ]),
    refusedWith('FLOW_TO_KIND'),
  );
  assert.equal(seen.includes('never'), false);
  // Chains are available (0.36 D6): a chained start goes on to the compositions' checks like any other workflow.
  const chained = owner();
  chained.flow.on = { raised: ['other.asks.issue.created'], withinMs: 86_400_000 };
  await assertFlowActivation(canonicalFullRuleDocument(chained), database, [
    () => {
      seen.push('after-chain');
    },
  ]);
  assert.equal(seen.includes('after-chain'), true);
  // A workflow without a flow runs no flow check.
  await assertFlowActivation(canonicalFullRuleDocument(rule(1, [dryRun()])), database, [
    () => {
      throw new Error('never for a straight line');
    },
  ]);
});

test('B1: a linear-change state id is checked against the team in fake Linear', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fake = await startFakeLinear();
  try {
    const integration = new LinearIntegration({
      secrets: {
        readLiveGenerations: async () => [
          { generation: 1, lifecycle: 'current', secretDigest: 'digest', material: FAKE_LINEAR_KEY },
        ],
      } as never,
      cipher: {} as never,
      client: new LinearClient(fake.clientOptions()),
    });
    const change = (state: Record<string, unknown>): CanonicalFullRuleDocument => {
      const document = owner();
      const targets = document.targets as Record<string, unknown>[];
      document.targets = targets.map((target) =>
        target.kind === 'linear-change' || target.kind === 'linear'
          ? {
              ...target,
              team: { id: FAKE_TEAM.id, key: FAKE_TEAM.key },
              ...(target.kind === 'linear-change' ? { state } : {}),
            }
          : target,
      );
      return canonicalFullRuleDocument(document);
    };
    assert.equal(await integration.assertActivation(change({ ...FAKE_STATES[1] })), 'checked');
    await assert.rejects(
      integration.assertActivation(change({ ...FAKE_STATES[1], name: 'Shipped' })),
      refusedWith('LINEAR_STATE_MISMATCH'),
    );
    await assert.rejects(
      integration.assertActivation(change({ ...FAKE_STATES[1], type: 'canceled' })),
      refusedWith('LINEAR_STATE_MISMATCH'),
    );
    await assert.rejects(
      integration.assertActivation(
        change({ id: '00000000-0000-4000-8000-000000000000', name: 'Done', type: 'completed' }),
      ),
      refusedWith('LINEAR_STATE_MISMATCH'),
    );
    assert.ok(fake.requests.some((request) => request.operation === 'AgentCommsLinearStates'));
  } finally {
    await fake.close();
  }
});

test('B1: through a real owner, a flow is created and prepared, and a refusal carries its problems', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    const target = dryRun();
    await harness.control.request('target-add', { document: target });
    const flow = {
      flowVersion: 1,
      start: 'check',
      steps: {
        check: { kind: 'condition', when: { path: '/fields/subject', op: 'exists' }, next: { yes: 'keep' } },
        keep: { kind: 'deliver', target: { targetId: 'dry-flow', version: 1 }, next: {} },
      },
      limits: {
        runsPerHour: 10,
        concurrentRuns: 2,
        sessionsPerHour: 2,
        worktreesPerDay: 5,
        linearWritesPerHour: 30,
        eventsPerHour: 120,
        runMs: 259_200_000,
      },
    };
    const cyclic = { ...flow, steps: { ...flow.steps, keep: { ...flow.steps.keep, next: { otherwise: 'check' } } } };
    await assert.rejects(
      harness.control.request('rule-create', { document: { ...rule(1, [target]), flow: cyclic } }),
      (error: unknown) => {
        const details = (error as { details?: { reason?: unknown; problems?: { code: string }[] } }).details;
        assert.equal(details?.reason, 'FLOW_INVALID');
        assert.ok(details?.problems?.some((problem) => problem.code === 'FLOW_CYCLE'));
        return true;
      },
    );
    const created = (await harness.control.request('rule-create', { document: { ...rule(1, [target]), flow } })) as {
      document: { flow?: unknown };
    };
    assert.deepEqual(created.document.flow, flow);
    const prepared = (await harness.control.request('rule-enable', { ruleId: RULE, version: 1 })) as {
      approvalId?: string;
    };
    assert.equal(typeof prepared.approvalId, 'string');
  });
});
