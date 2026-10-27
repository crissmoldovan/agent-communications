import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256Hex, wrapUntrusted } from '@agentcomms/core';
import {
  type FlowDocumentV1,
  representWorkflowEvent,
  WORKFLOW_EVENT_CATALOGUE_V1,
  type WorkflowCloudEventV1,
} from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { createWorkflowEventSink, workflowEventLocation } from '../src/runtime/events/sink.ts';
import type { RunView, StepTransition } from '../src/runtime/workflow/contracts.ts';
import { raiseExecutor } from '../src/runtime/workflow/steps/raise.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { withEventsOwner } from './support/events-owner.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome, standInSecrets } from './support/stand-ins.ts';
import { OWNER_EXAMPLE, stepContext } from './support/step-context.ts';
import { seedRun, testId } from './support/workflow-event-rows.ts';

/*
 * D2 (workflows plan, Track D): workflows raise events. The sink is tested with recorded transitions and a real store,
 * and the Raise step with T0.2's stand-in context: no engine is needed (G2 proves them inside one). A word that is not
 * ticked writes nothing; a ticked one is Appendix W.2's CloudEvent, sealed, with one queued delivery per active
 * subscription it matches; automatic events hold closed values only; a Raise step's fields are sealed with it.
 */

const SENDER_SENTINEL = 'SENTINEL-SENDER acme.client-asks.issue.created {{steps.route.project}}';
const ACCOUNT = 'acme/slack';
const AT = Date.UTC(2026, 9, 27, 11, 20, 4, 120);

type FlowRule = CanonicalFullRuleDocument & { flow: FlowDocumentV1 };

interface Store {
  readonly root: string;
  readonly store: EventDatabase;
  readonly cipher: EventRecordCipher;
  readonly runId: string;
  close(): void;
}

async function openStore(): Promise<Store> {
  const root = await shortTempDir('aev-d2-raise-');
  const home = await standInHome(root);
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  await standInSecrets(store.database);
  const secrets = await openEventSecretStore({
    database: store.database,
    paths: store.paths,
    configDir: home.configDir,
  });
  const cipher = new EventRecordCipher(store.database, secrets, new WriterQuiescer());
  const runId = seedRun(store.database, { ruleId: 'client-asks', ruleVersion: 5, accountId: ACCOUNT, now: AT });
  return { root, store, cipher, runId, close: () => store.close() };
}

/** A subscriber version written straight into the store, with the subscription state the test needs. */
function subscriber(
  store: EventDatabase,
  input: {
    readonly id: string;
    readonly version?: number;
    readonly kind?: 'sse' | 'webhook';
    readonly namespaces?: readonly string[];
    readonly patterns: readonly string[];
    readonly state: 'inert' | 'active' | 'superseded';
  },
): void {
  const events = { namespaces: input.namespaces ?? ['acme'], patterns: input.patterns, content: 'none' };
  const document =
    input.kind === 'webhook'
      ? {
          subscriberId: input.id,
          version: input.version ?? 1,
          kind: 'webhook',
          url: { kind: 'plain', value: 'http://127.0.0.1:4802/hooks' },
          approvedAddressSet: ['127.0.0.1'],
          signing: 'standard-webhooks',
          retryLimit: 3,
          events,
        }
      : {
          subscriberId: input.id,
          version: input.version ?? 1,
          kind: 'sse',
          authority: { host: '127.0.0.1', port: 4801 },
          origins: [],
          retentionMs: 86_400_000,
          events,
        };
  const bytes = canonicalJson(document as never);
  store.database
    .prepare(
      'INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest, state) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(`${input.id}@${input.version ?? 1}`, input.id, input.version ?? 1, bytes, sha256Hex(bytes), input.state);
}

function rule(edit?: (flow: FlowDocumentV1 & Record<string, unknown>) => void): FlowRule {
  const copy = structuredClone(OWNER_EXAMPLE) as FlowRule;
  edit?.(copy.flow as FlowDocumentV1 & Record<string, unknown>);
  return copy;
}

function runView(store: Store, partial: Partial<RunView> = {}): RunView {
  return {
    id: store.runId,
    ruleId: 'client-asks',
    ruleVersion: 5,
    accountId: ACCOUNT,
    eventId: `event-${store.runId}`,
    depth: 0,
    parentRunId: null,
    startedAt: AT - 6_000,
    expiresAt: AT + 259_200_000,
    shadow: false,
    ...partial,
  };
}

function transition(
  store: Store,
  workflow: FlowRule,
  stepId: string | null,
  kind: StepTransition['transition'],
  partial: Partial<StepTransition> = {},
): StepTransition {
  return {
    run: runView(store),
    rule: workflow,
    stepId,
    transition: kind,
    outcome: null,
    output: null,
    attempt: 1,
    index: 0,
    path: [],
    durationMs: null,
    error: null,
    nextAt: null,
    wait: null,
    at: AT,
    ...partial,
  };
}

async function raise(store: Store, transitions: readonly StepTransition[], fields?: Record<string, string>) {
  const sink = createWorkflowEventSink({
    cipher: store.cipher,
    installationId: 'inst-1',
    ...(fields === undefined ? {} : { fields: async () => fields }),
  });
  const prepared = await sink.prepare(transitions);
  store.store.immediate(() => sink.commitInTransaction(store.store.database, prepared));
  return prepared;
}

function events(store: Store): Array<{ id: string; type: string; state: string; sequence: number; schema: string }> {
  return (
    store.store.database
      .prepare('SELECT id, type, state, sequence, schema FROM workflow_events ORDER BY sequence')
      .all() as Array<{ id: string; type: string; state: string; sequence: number; schema: string }>
  ).map((row) => ({ ...row }));
}

async function sealedEvent(store: Store, id: string): Promise<WorkflowCloudEventV1> {
  const row = store.store.database.prepare('SELECT encrypted_record FROM workflow_events WHERE id = ?').get(id) as {
    encrypted_record: Uint8Array;
  };
  return JSON.parse(
    (await store.cipher.decrypt(workflowEventLocation(id), row.encrypted_record)).toString('utf8'),
  ) as WorkflowCloudEventV1;
}

/** Every transition of the owner example's path up to giving the session the message, none of them a Raise step. */
function aRun(store: Store, workflow: FlowRule): StepTransition[] {
  return [
    transition(store, workflow, null, 'run-started'),
    transition(store, workflow, 'route', 'started'),
    transition(store, workflow, 'route', 'succeeded', {
      outcome: 'chosen',
      output: {
        project: 'acme-site',
        projectName: 'Acme site',
        reason: 'hint:sender-domain',
        score: null,
        profileHash: 'a'.repeat(64),
      },
      path: ['route'],
      durationMs: 12,
    }),
    transition(store, workflow, 'issue', 'started', { index: 2, path: ['route', 'found'] }),
    transition(store, workflow, 'issue', 'succeeded', {
      outcome: 'done',
      index: 2,
      path: ['route', 'found', 'issue'],
      durationMs: 1_840,
      output: {
        delivery: 'delivery-1',
        issue: { id: 'issue-id-1', identifier: 'ACME-123', url: 'https://linear.app/acme/issue/ACME-123' },
      },
    }),
    transition(store, workflow, null, 'run-finished', { index: 9, durationMs: 9_000 }),
  ];
}

test('D2: nothing ticked: no workflow_events row for a whole run', { skip: WINDOWS_SKIP }, async () => {
  const store = await openStore();
  try {
    subscriber(store.store, { id: 'events-dashboard', patterns: ['*.*.*.*'], state: 'active' });
    const quiet = rule((flow) => {
      for (const step of Object.values(flow.steps)) delete (step as { emit?: unknown }).emit;
      (flow.events as { run?: unknown }).run = undefined;
      delete (flow.events as { run?: unknown }).run;
    });
    const prepared = await raise(store, aRun(store, quiet));
    assert.deepEqual(prepared.rows, []);
    assert.deepEqual(events(store), []);
    assert.equal(
      (store.store.database.prepare('SELECT COUNT(*) AS count FROM event_deliveries').get() as { count: number }).count,
      0,
    );
  } finally {
    store.close();
  }
});

test('D2: issue emits created: one event acme.client-asks.issue.created, one delivery per matching active subscription', {
  skip: WINDOWS_SKIP,
}, async () => {
  const store = await openStore();
  try {
    subscriber(store.store, { id: 'events-dashboard', patterns: ['acme.client-asks.*.*'], state: 'active' });
    subscriber(store.store, { id: 'crm-hook', kind: 'webhook', patterns: ['*.*.issue.created'], state: 'active' });
    subscriber(store.store, { id: 'other-team', namespaces: ['other'], patterns: ['*.*.*.*'], state: 'active' });
    // D2: an inert or superseded subscription gets no delivery.
    subscriber(store.store, { id: 'not-yet', patterns: ['*.*.*.*'], state: 'inert' });
    subscriber(store.store, { id: 'replaced', version: 1, patterns: ['*.*.*.*'], state: 'superseded' });
    const quiet = rule((flow) => {
      delete (flow.events as { run?: unknown }).run;
      delete (flow.steps.route as { emit?: unknown }).emit;
    });
    await raise(store, aRun(store, quiet));
    const raised = events(store);
    assert.deepEqual(
      raised.map(({ type, state, sequence, schema }) => ({ type, state, sequence, schema })),
      [{ type: 'acme.client-asks.issue.created', state: 'open', sequence: 1, schema: 'step.deliver.linear' }],
    );
    const deliveries = (
      store.store.database
        .prepare(
          'SELECT subscriber_id, subscriber_version, kind, state, ordering_sequence FROM event_deliveries ORDER BY subscriber_id',
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({ ...row }));
    assert.deepEqual(deliveries, [
      { subscriber_id: 'crm-hook', subscriber_version: 1, kind: 'webhook', state: 'queued', ordering_sequence: 1 },
      { subscriber_id: 'events-dashboard', subscriber_version: 1, kind: 'sse', state: 'queued', ordering_sequence: 1 },
    ]);
    // The CloudEvent's attributes, by value (W.2).
    const event = await sealedEvent(store, raised[0]?.id as string);
    assert.equal(event.specversion, '1.0');
    assert.equal(event.source, 'urn:agentcomms:inst-1:workflows:client-asks@5');
    assert.equal(event.type, 'acme.client-asks.issue.created');
    assert.equal(event.time, '2026-10-27T11:20:04.120Z');
    assert.equal(event.datacontenttype, 'application/json');
    assert.equal(event.dataschema, 'urn:agentcomms:workflow-events:v1:step.deliver.linear');
    assert.equal(event.subject, store.runId);
    assert.equal(event.agentcommsrule, 'client-asks@5');
    assert.equal(event.agentcommsrun, store.runId);
    assert.equal(event.agentcommsstep, 'issue');
    assert.equal(event.agentcommsuntrusted, undefined, 'an automatic event carries no untrusted content');
    assert.deepEqual(event.data, {
      workflow: { id: 'client-asks', version: 5, namespace: 'acme', name: 'client-asks' },
      run: { id: store.runId, startedAt: '2026-10-27T11:19:58.120Z', depth: 0, parent: null },
      step: { id: 'issue', kind: 'deliver', label: null, index: 2, attempt: 1 },
      path: ['route', 'found', 'issue'],
      event: 'created',
      outcome: 'done',
      durationMs: 1_840,
      error: null,
      outputs: {
        delivery: 'delivery-1',
        issue: { id: 'issue-id-1', identifier: 'ACME-123', url: 'https://linear.app/acme/issue/ACME-123' },
      },
    });
    // A second event of the run is numbered after the first, and each subscriber's order goes on from its own.
    await raise(store, [
      transition(store, quiet, null, 'run-failed', { error: 'STEP_FAILED' }),
      transition(store, quiet, 'issue', 'succeeded', { outcome: 'done', output: { delivery: 'delivery-2' } }),
    ]);
    assert.deepEqual(
      events(store).map((row) => row.sequence),
      [1, 2],
    );
  } finally {
    store.close();
  }
});

test('D2: automatic events hold no sender sentinel and no folder path, in any byte', {
  skip: WINDOWS_SKIP,
}, async () => {
  const store = await openStore();
  try {
    subscriber(store.store, { id: 'events-dashboard', patterns: ['*.*.*.*'], state: 'active' });
    const folder = join(store.root, 'acme-site', '.worktrees', 'acme-123');
    const loud = rule((flow) => {
      // Every word each step on the path has, ticked; the author's labels too.
      for (const [id, step] of Object.entries(flow.steps)) {
        if (step.kind === 'raise') continue;
        const words = Object.values(WORKFLOW_EVENT_CATALOGUE_V1)
          .flatMap((entry) => [...entry.standard, ...entry.own])
          .filter((word, index, all) => all.indexOf(word) === index);
        (step as unknown as { emit?: string[] }).emit = words.filter((word) =>
          id === 'tree'
            ? ['made', 'succeeded', 'started'].includes(word)
            : ['succeeded', 'started', 'matched'].includes(word),
        );
        (step as unknown as { label?: string }).label = `the author's ${id}`;
      }
    });
    const transitions = [
      ...aRun(store, loud),
      transition(store, loud, 'tree', 'started', { index: 5 }),
      transition(store, loud, 'tree', 'succeeded', {
        outcome: 'made',
        index: 5,
        durationMs: 400,
        output: { branch: 'acme/acme-123', path: folder, refusal: null },
      }),
    ];
    // The run's mapped values hold the sender's words: no automatic event may ask for them.
    await raise(store, transitions, { text: SENDER_SENTINEL, subject: SENDER_SENTINEL });
    const raised = events(store);
    assert.ok(raised.length >= 6, `the ticked words are raised (${raised.length})`);
    assert.ok(raised.some((row) => row.type === 'acme.client-asks.tree.made'));
    for (const row of raised) {
      const bytes = canonicalJson((await sealedEvent(store, row.id)) as never);
      assert.equal(bytes.includes('SENTINEL-SENDER'), false, `${row.type} holds no sender text`);
      assert.equal(bytes.includes(store.root), false, `${row.type} holds no folder path`);
      assert.equal(bytes.includes('profileHash'), false, `${row.type} carries W.3's outputs, not the stored ones`);
    }
    const made = await sealedEvent(
      store,
      raised.find((row) => row.type === 'acme.client-asks.tree.made')?.id as string,
    );
    assert.deepEqual(made.data.outputs, { branch: 'acme/acme-123', refusal: null });
    assert.equal(made.data.step?.label, "the author's tree");
  } finally {
    store.close();
  }
});

test('D2: raise with fields: sealed with the fields; data.fields only for content enveloped', {
  skip: WINDOWS_SKIP,
}, async () => {
  const store = await openStore();
  try {
    subscriber(store.store, { id: 'events-dashboard', patterns: ['acme.client-asks.found.*'], state: 'active' });
    const withFields = rule((flow) => {
      (flow.steps.found as unknown as { fields?: string[] }).fields = ['text'];
    });
    const settled = await raiseExecutor.run(stepContext({ rule: withFields, stepId: 'found' }));
    assert.equal(settled.kind, 'settled');
    const output = (settled as unknown as { output: { event: string; name: string } }).output;
    await raise(
      store,
      [transition(store, withFields, 'found', 'succeeded', { outcome: 'raised', output, durationMs: 0, index: 1 })],
      { text: SENDER_SENTINEL, subject: 'not declared' },
    );
    const raised = events(store);
    assert.deepEqual(
      raised.map((row) => ({ id: row.id, type: row.type, schema: row.schema })),
      [{ id: output.event, type: 'acme.client-asks.found.project-found', schema: 'raise' }],
      "the event's id is the Raise step's settled output",
    );
    const sealed = await sealedEvent(store, output.event);
    assert.deepEqual(sealed.data.fields, { text: SENDER_SENTINEL }, 'only the declared field is sealed');
    assert.deepEqual(sealed.data.outputs, { name: 'project-found', fields: ['text'] });
    assert.ok(sealed.agentcommsuntrusted, 'the sealed event lists its untrusted pointer');
    const none = representWorkflowEvent(sealed, 'none', (text, pointer) =>
      wrapUntrusted(text, { field: pointer, id: output.event }),
    );
    assert.equal(JSON.stringify(none).includes('SENTINEL-SENDER'), false, 'content none: no field reaches it');
    assert.equal(none.agentcommsuntrusted, undefined);
    const enveloped = representWorkflowEvent(sealed, 'enveloped', (text, pointer) =>
      wrapUntrusted(text, { field: pointer, id: output.event }),
    );
    assert.match(
      enveloped.data.fields?.text ?? '',
      /<untrusted-content[^>]*>[\s\S]*SENTINEL-SENDER[\s\S]*<\/untrusted-content/u,
    );
    assert.ok(enveloped.agentcommsuntrusted);
  } finally {
    store.close();
  }
});

test('D2: the raise executor settles raised at once, with its event id, and never waits or fails', async () => {
  const ctx = stepContext({ stepId: 'found' });
  const first = await raiseExecutor.run(ctx);
  assert.equal(first.kind, 'settled');
  const settled = first as { kind: 'settled'; outcome: string; output: { event: string; name: string } };
  assert.equal(settled.outcome, 'raised');
  assert.match(settled.output.event, /^wfe_[0-9a-hjkmnp-tv-z]{26}$/u);
  assert.equal(settled.output.name, 'project-found');
  const resumed = await raiseExecutor.resume(ctx, { kind: 'time' });
  assert.equal(resumed.kind, 'settled');
  assert.notEqual((resumed as typeof settled).output.event, settled.output.event, 'each attempt makes its own id');
  assert.deepEqual(ctx.charged, [], 'it charges nothing');
  assert.deepEqual(ctx.judged, [], 'it asks no judge');
  assert.equal(raiseExecutor.kind, 'raise');
});

test('D2: eventsPerHour 2: the third is not raised, workflow_runs.events_not_raised counts it, and commit still succeeds', {
  skip: WINDOWS_SKIP,
}, async () => {
  const store = await openStore();
  try {
    subscriber(store.store, { id: 'events-dashboard', patterns: ['*.*.*.*'], state: 'active' });
    const capped = rule((flow) => {
      (flow.limits as { eventsPerHour: number }).eventsPerHour = 2;
    });
    const settles = [1, 2, 3].map((index) =>
      transition(store, capped, 'issue', 'succeeded', { outcome: 'done', index, output: { delivery: `d-${index}` } }),
    );
    await assert.doesNotReject(raise(store, settles));
    assert.equal(events(store).length, 2);
    const run = store.store.database
      .prepare('SELECT events_not_raised FROM workflow_runs WHERE id = ?')
      .get(store.runId) as { events_not_raised: number };
    assert.equal(run.events_not_raised, 1);
    // The ceiling across all workflows counts too.
    store.store.database.prepare('UPDATE workflow_settings SET events_per_hour_max = 2 WHERE singleton = 1').run();
    const other = { ...rule(), ruleId: 'other-workflow' } as FlowRule;
    await raise(store, [transition(store, other, 'issue', 'succeeded', { outcome: 'done', output: {} })]);
    assert.equal(
      events(store).length,
      2,
      'past 1,000 an hour — here, the stored ceiling of 2 — nothing more is raised',
    );
  } finally {
    store.close();
  }
});

test('D2: skipped and retrying are raised when ticked; shadow raises nothing', { skip: WINDOWS_SKIP }, async () => {
  const store = await openStore();
  try {
    subscriber(store.store, { id: 'events-dashboard', patterns: ['*.*.*.*'], state: 'active' });
    const ticked = rule((flow) => {
      (flow.steps.find as unknown as { emit?: string[] }).emit = ['retrying', 'skipped'];
    });
    await raise(store, [
      transition(store, ticked, 'find', 'retrying', { error: 'RELAY_UNAVAILABLE', nextAt: AT + 30_000 }),
      transition(store, ticked, 'find', 'skipped'),
    ]);
    const raised = events(store);
    assert.deepEqual(
      raised.map((row) => row.type),
      ['acme.client-asks.find.retrying', 'acme.client-asks.find.skipped'],
    );
    const retrying = await sealedEvent(store, raised[0]?.id as string);
    assert.equal(retrying.data.error, 'RELAY_UNAVAILABLE');
    assert.equal(retrying.data.nextAt, '2026-10-27T11:20:34.120Z');
    assert.equal(retrying.data.outcome, null);
    const skipped = await sealedEvent(store, raised[1]?.id as string);
    assert.equal(skipped.data.error, null);
    assert.equal(skipped.data.durationMs, null);
    // Shadow (§7.7): every raised event becomes a dry-run record elsewhere; the sink raises nothing.
    const before = events(store).length;
    const sink = createWorkflowEventSink({ cipher: store.cipher, installationId: 'inst-1' });
    const shadowed = await sink.prepare([
      { ...transition(store, ticked, 'find', 'skipped'), run: runView(store, { shadow: true }) },
    ]);
    assert.deepEqual(shadowed.rows, []);
    assert.equal(events(store).length, before);
    // A run's own word, ticked in flow.events.run, has no step.
    await raise(store, [transition(store, ticked, null, 'run-failed', { error: 'STEP_FAILED' })]);
    const failed = events(store).find((row) => row.type === 'acme.client-asks.run.failed');
    assert.ok(failed);
    const runEvent = await sealedEvent(store, failed.id);
    assert.equal(runEvent.agentcommsstep, undefined);
    assert.equal(runEvent.data.step, null);
    assert.equal(runEvent.dataschema, 'urn:agentcomms:workflow-events:v1:run');
  } finally {
    store.close();
  }
});

test('D2: workflow-events list prints Appendix W.3, and show prints one schema', { skip: WINDOWS_SKIP }, async () => {
  await withEventsOwner(async (harness) => {
    const listed = await harness.cli(['workflow-events', 'list']);
    assert.equal(listed.code, 0, listed.err);
    const result = JSON.parse(listed.out) as {
      catalogueVersion: number;
      schemas: { schema: string; own: string[]; standard: string[]; outputs: string[] }[];
    };
    assert.equal(result.catalogueVersion, 1);
    assert.deepEqual(result.schemas.find((entry) => entry.schema === 'step.wait')?.own, [
      'finished',
      'timed-out',
      'free',
      'elapsed',
    ]);
    assert.deepEqual(
      Object.fromEntries(result.schemas.map(({ schema, ...entry }) => [schema, entry])),
      JSON.parse(JSON.stringify(WORKFLOW_EVENT_CATALOGUE_V1)),
    );
    const shown = await harness.cli(['workflow-events', 'show', 'step.route']);
    assert.equal(shown.code, 0, shown.err);
    assert.deepEqual(JSON.parse(shown.out), {
      catalogueVersion: 1,
      schema: 'step.route',
      ...JSON.parse(JSON.stringify(WORKFLOW_EVENT_CATALOGUE_V1['step.route'])),
    });
    const unknown = await harness.cli(['workflow-events', 'show', 'step.nothing']);
    assert.equal(unknown.code, 66, 'an unknown schema is not found');
  });
});

void testId;
