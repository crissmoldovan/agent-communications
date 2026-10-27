import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FlowDocumentV1 } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../../src/domain/activation-documents.ts';
import { createWorkflowEventSink } from '../../src/runtime/events/sink.ts';
import { eventPaths } from '../../src/runtime/paths.ts';
import type { RunView, StepTransition } from '../../src/runtime/workflow/contracts.ts';
import { WriterQuiescer } from '../../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../../src/store/database.ts';
import { openEventSecretStore } from '../../src/store/event-secrets.ts';
import { EventRecordCipher } from '../../src/store/records.ts';
import { runCli } from './events-owner.ts';
import { ACCOUNT, dryRun, type LaneHarness, RULE, rule, withLaneOwner } from './lane-harness.ts';
import { OWNER_EXAMPLE } from './step-context.ts';
import { seedRun } from './workflow-event-rows.ts';

/**
 * A real owner whose one workflow is active, with subscribers approved for its events (Track D, D3–D5). The workflow
 * is lane-harness's fake-Gmail rule, so the W35 fence finds a live approved version and a connected account; its
 * events are raised through the real sink, into the owner's store, as the engine (B2) will raise them. An SSE
 * subscriber it binds through an SSE target also carries rule-target frames.
 */

export interface LiveSubscriber {
  readonly document: Record<string, unknown>;
  /** Approve its events (the default), or leave it inert. */
  readonly approve?: boolean;
  /** Bind it through an SSE target of the workflow, so rule frames reach it too. */
  readonly bound?: boolean;
}

export interface LiveEventsHarness {
  readonly lane: LaneHarness;
  readonly stateDir: string;
  /** Each SSE subscriber's bearer token, made at the terminal. */
  readonly tokens: ReadonlyMap<string, string>;
  /** A second connection to the owner's store. */
  readonly database: DatabaseSync;
  /** Raises events as the engine would: the transitions through the real sink, committed in one transaction. */
  raise(
    transitions: (run: RunView, workflow: CanonicalFullRuleDocument & { flow: FlowDocumentV1 }) => StepTransition[],
  ): Promise<string[]>;
  tick(): Promise<void>;
}

/** A loopback port nothing listens on now. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** The workflow's flow, in memory: the owner example's, named after lane-harness's rule. */
export function liveWorkflow(): CanonicalFullRuleDocument & { flow: FlowDocumentV1 } {
  const copy = structuredClone(OWNER_EXAMPLE) as CanonicalFullRuleDocument & { flow: FlowDocumentV1 };
  return { ...copy, ruleId: RULE, version: 1 };
}

/** One settle of the owner example's `issue` step: acme.client-asks.issue.created. */
export function issueCreated(run: RunView, workflow: CanonicalFullRuleDocument, at: number, index = 1): StepTransition {
  return {
    run,
    rule: workflow,
    stepId: 'issue',
    transition: 'succeeded',
    outcome: 'done',
    output: {
      delivery: `delivery-${index}`,
      issue: { id: `issue-${index}`, identifier: `ACME-${index}`, url: `https://linear.app/acme/issue/ACME-${index}` },
    },
    attempt: 1,
    index,
    path: ['route', 'issue'],
    durationMs: 10,
    error: null,
    nextAt: null,
    wait: null,
    at,
  };
}

export async function withLiveEvents(
  subscribers: readonly LiveSubscriber[],
  work: (harness: LiveEventsHarness) => Promise<void>,
  options: Parameters<typeof withLaneOwner>[1] = {},
): Promise<void> {
  await withLaneOwner(async (lane) => {
    const stateDir = lane.stateDir;
    const tokens = new Map<string, string>();
    for (const subscriber of subscribers) {
      await lane.control.request('addSubscriber', { document: subscriber.document });
      if (subscriber.document.kind !== 'sse') continue;
      const id = subscriber.document.subscriberId as string;
      const made = await runCli(
        stateDir,
        ['subscriber', 'token', 'create', id, '--version', String(subscriber.document.version)],
        {
          tty: true,
          json: false,
        },
      );
      assert.equal(made.code, 0, made.err);
      const token = /Generated credential \(shown once\): (\S+)/u.exec(made.out)?.[1];
      assert.ok(token, 'the bearer token is shown once at the terminal');
      tokens.set(id, token);
    }
    const bound = subscribers.filter((subscriber) => subscriber.bound === true);
    const targets = [
      dryRun,
      ...bound.map((subscriber) => ({
        targetId: `live-${subscriber.document.subscriberId as string}`,
        version: 1,
        kind: 'sse',
        subscriberId: subscriber.document.subscriberId,
        subscriberVersion: subscriber.document.version,
        representation: 'plain',
      })),
    ];
    for (const target of targets) await lane.control.request('target-add', { document: target });
    await lane.control.request('rule-create', {
      document: { ...rule(1, targets), subscribers: bound.map((subscriber) => subscriber.document) },
    });
    await lane.approve(1);
    const enabled = (await lane.control.request('enable-all')) as { approvalId: string };
    const challenge = (await lane.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
    await lane.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
    for (const subscriber of subscribers) {
      if (subscriber.approve === false) continue;
      const prepared = (await lane.control.request('subscriber-enable', {
        subscriberId: subscriber.document.subscriberId,
        version: subscriber.document.version,
      })) as { approvalId: string };
      const answer = (await lane.control.request('approve-challenge', { approvalId: prepared.approvalId })) as string;
      await lane.control.request('approve', { approvalId: prepared.approvalId, answer });
    }
    await lane.tick();
    const database = new DatabaseSync(eventPaths(stateDir).database);
    database.exec('PRAGMA busy_timeout = 5000');
    const store = await openEventDatabase({ stateDir });
    const secrets = await openEventSecretStore({
      database: store.database,
      paths: store.paths,
      configDir: join(dirname(stateDir), 'config'),
    });
    const cipher = new EventRecordCipher(store.database, secrets, new WriterQuiescer());
    try {
      await work({
        lane,
        stateDir,
        tokens,
        database,
        tick: () => lane.tick(),
        async raise(transitions) {
          const { switch_generation } = database
            .prepare('SELECT switch_generation FROM event_settings WHERE singleton = 1')
            .get() as { switch_generation: number };
          const now = Date.now();
          const runId = seedRun(database, {
            ruleId: RULE,
            ruleVersion: 1,
            accountId: ACCOUNT,
            switchGeneration: switch_generation,
            now,
          });
          const run: RunView = {
            id: runId,
            ruleId: RULE,
            ruleVersion: 1,
            accountId: ACCOUNT,
            eventId: `event-${runId}`,
            depth: 0,
            parentRunId: null,
            startedAt: now,
            expiresAt: now + 86_400_000,
            shadow: false,
          };
          const sink = createWorkflowEventSink({ cipher, installationId: store.installationId });
          const prepared = await sink.prepare(transitions(run, liveWorkflow()));
          store.immediate(() => sink.commitInTransaction(store.database, prepared));
          return (prepared.rows as Array<{ id: string }>).map((row) => row.id);
        },
      });
    } finally {
      database.close();
      store.close();
    }
  }, options);
}

/** An open SSE stream: every frame it received, and its end. */
export interface SseStream {
  readonly status: number;
  readonly frames: () => readonly {
    readonly id: string | null;
    readonly event: string | null;
    readonly data: string;
  }[];
  readonly ended: () => boolean;
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  close(): void;
}

export async function openSse(input: {
  readonly port: number;
  readonly subscriberId: string;
  readonly token: string;
  readonly lastEventId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<SseStream> {
  let buffer = '';
  let ended = false;
  const parsed: { id: string | null; event: string | null; data: string }[] = [];
  const req = request({
    host: '127.0.0.1',
    port: input.port,
    path: `/v1/streams/${encodeURIComponent(input.subscriberId)}`,
    headers: {
      host: `127.0.0.1:${input.port}`,
      authorization: `Bearer ${input.token}`,
      ...(input.lastEventId === undefined ? {} : { 'last-event-id': input.lastEventId }),
      ...input.headers,
    },
  });
  const status = await new Promise<number>((resolve, reject) => {
    req.once('response', (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let at = buffer.indexOf('\n\n');
        while (at !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const lines = block.split('\n');
          const field = (name: string) =>
            lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
          parsed.push({ id: field('id'), event: field('event'), data: field('data') ?? '' });
          at = buffer.indexOf('\n\n');
        }
      });
      response.once('end', () => {
        ended = true;
      });
      response.once('close', () => {
        ended = true;
      });
      resolve(response.statusCode ?? 0);
    });
    req.once('error', reject);
    req.end();
  });
  return {
    status,
    frames: () => [...parsed],
    ended: () => ended,
    async waitFor(count, timeoutMs = 5_000) {
      for (let waited = 0; parsed.length < count && waited < timeoutMs; waited += 10)
        await new Promise((resolve) => setTimeout(resolve, 10));
    },
    close: () => req.destroy(),
  };
}
