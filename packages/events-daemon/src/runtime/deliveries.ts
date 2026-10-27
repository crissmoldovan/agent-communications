import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import {
  type AnyEventDefinition,
  catalogueEntry,
  compileMapping,
  contextFieldValues,
  type JsonValue,
  type MappedClassification,
  type ResolvedContextPart,
  targetQueues,
} from '@agentcomms/events';
import type { CanonicalFullRuleDocument, TargetDocument } from '../domain/activation-documents.ts';
import { closedSlotText, isClosedSlot } from '../domain/flow.ts';
import { type LinearChangeTargetDocument, renderLinearComment } from '../domain/linear-change-target.ts';
import { mappedFields, renderLinearIssue } from '../domain/linear-target.ts';
import { type QueueItemContent, queueItemContent } from '../domain/queue-target.ts';
import { sseDeliveryTarget } from '../domain/sse-subscriber.ts';
import { webhookDeliveryTarget } from '../domain/webhook-target.ts';
import { fixedDeadline } from '../store/retention.ts';
import { allocateDeliveryOrderSequence } from './delivery-claim.ts';
import type { LinearChangeDeliveryRecord } from './linear-change-dispatcher.ts';
import type { ProjectionCipher } from './projections.ts';
import {
  constructTargetDelivery,
  type DeliveryRepresentation,
  type DeliveryTarget,
  targetDeliveryKey,
} from './target-delivery.ts';
import { addRetainedDeliveryTargetReference } from './target-version-references.ts';
import type { FlowDeliveryRequest } from './workflow/contracts.ts';
import type { RunRecord } from './workflow/runs.ts';

export interface PreparedDelivery {
  readonly id: string;
  readonly targetKey: string;
  readonly target: DeliveryTarget;
  readonly representation: DeliveryRepresentation;
  readonly cloudEventBytes: string;
  readonly encryptedRecord: Buffer;
  readonly expiresAt: number;
}

/** The exact persisted retry payload: canonical bytes plus the one durable target representation boundary. */
export interface DeliveryRecord {
  readonly cloudEventBytes: string;
  readonly untrusted: readonly string[];
  readonly representation: DeliveryRepresentation;
}

/**
 * A queue delivery's payload: the item content the rule's mapping allows (action queue design Q4), and whether a person
 * let a held decision through (Q3), which the item shows instead of a judge's answer. It never holds CloudEvent bytes.
 */
export interface QueueDeliveryRecord {
  readonly kind: 'queue-item';
  readonly item: QueueItemContent;
  readonly released: boolean;
}

/**
 * An agent-session delivery's payload (0.33.0 design §3.5–§3.6): the mapped values its context reads, by pointer, and
 * nothing else of the match; the queue item it leaves in the Queue when it falls back there, when it can; and whether
 * a person let a held decision through. The prompt is written from it at the first dispatch that reaches an idle session,
 * and kept in the same sealed record from then on.
 */
export interface SessionDeliveryRecord {
  readonly kind: 'session-message';
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly item?: QueueItemContent | undefined;
  readonly released: boolean;
  /**
   * The context parts, once resolved — each model's words, each file's text — kept so a later try sends the same words
   * and no model part runs twice. The prompt is framed from them on each try, after each file's folder is checked again.
   */
  readonly parts?: readonly ResolvedContextPart[] | undefined;
}

/**
 * A Linear delivery's payload (0.33.0 design §3.4): the issue's title and description, rendered once from the rule's
 * mapped data when the rule matched, so every try sends the same issue. It never holds CloudEvent bytes, and the team,
 * labels and assignee are read from the approved target at dispatch.
 */
export interface LinearDeliveryRecord {
  readonly kind: 'linear-issue';
  readonly title: string;
  readonly description: string;
}

export async function prepareDeliveries(input: {
  readonly cipher: ProjectionCipher;
  readonly definition: AnyEventDefinition;
  readonly event: Record<string, unknown>;
  readonly rule: CanonicalFullRuleDocument;
  readonly classification: MappedClassification;
  readonly installationId: string;
  readonly createdAt: number;
  readonly newId: () => string;
  readonly data: JsonValue;
  /** B2's private document seam; B1 derives its frozen dry-run targets when this is absent. */
  readonly targets?: readonly DeliveryTarget[] | undefined;
  /** A held decision a person let through: its queue item says so instead of showing a judge's answer (Q3). */
  readonly released?: boolean | undefined;
}): Promise<readonly PreparedDelivery[]> {
  // A workflow with a flow fans out to no target: its match is a run, whose steps deliver (workflows design W1, §5).
  if (input.rule.flow !== undefined && input.targets === undefined) return [];
  const deliveries: PreparedDelivery[] = [];
  const targets = input.targets ?? input.rule.targets.map((target) => documentDeliveryTarget(input.rule, target));
  for (const target of targets) {
    const id = input.newId();
    if (target.kind === 'queue') {
      deliveries.push(await prepareQueueDelivery(input, target, id));
      continue;
    }
    if (target.kind === 'session') {
      deliveries.push(await prepareSessionDelivery(input, target, id));
      continue;
    }
    if (target.kind === 'linear') {
      deliveries.push(await prepareLinearDelivery(input, target, id));
      continue;
    }
    const constructed = constructTargetDelivery({
      target,
      definition: input.definition,
      event: input.event,
      deliveryId: id,
      installationId: input.installationId,
      ruleId: input.rule.ruleId,
      ruleVersion: input.rule.version,
      ...(input.rule.cloudEventType === undefined ? {} : { cloudEventType: input.rule.cloudEventType }),
      data: input.data,
      classification: input.classification,
    });
    const record: DeliveryRecord = {
      cloudEventBytes: constructed.cloudEventBytes,
      untrusted: constructed.untrusted,
      representation: constructed.representation,
    };
    // Encryption reserves its nonce outside the decision transaction. A rolled-back decision only spends a nonce.
    const encryptedRecord = await input.cipher.encrypt(
      { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text', value: id }] },
      Buffer.from(JSON.stringify(record)),
    );
    deliveries.push({
      id,
      targetKey: constructed.targetKey,
      target,
      representation: constructed.representation,
      cloudEventBytes: constructed.cloudEventBytes,
      encryptedRecord,
      expiresAt: fixedDeadline(input.createdAt, input.rule.retention.deliveryMs),
    });
  }
  return deliveries;
}

/** A queue delivery carries its item content, encrypted for the delivery row; nothing is mapped or fetched again. */
async function prepareQueueDelivery(
  input: Parameters<typeof prepareDeliveries>[0],
  target: Extract<DeliveryTarget, { readonly kind: 'queue' }>,
  id: string,
): Promise<PreparedDelivery> {
  const record: QueueDeliveryRecord = {
    kind: 'queue-item',
    item: queueItemContent({
      eventType: input.rule.event.type,
      mapping: input.rule.mapping,
      event: input.event as JsonValue,
      show: target.show,
    }),
    released: input.released === true,
  };
  const encryptedRecord = await input.cipher.encrypt(
    { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text', value: id }] },
    Buffer.from(JSON.stringify(record)),
  );
  return {
    id,
    targetKey: targetDeliveryKey(target),
    target,
    representation: target.representation,
    // A queue item is not a CloudEvent; there are no bytes to select later.
    cloudEventBytes: '',
    encryptedRecord,
    expiresAt: fixedDeadline(input.createdAt, input.rule.retention.deliveryMs),
  };
}

/** A session delivery carries the mapped values its context reads, and its fallback item; both sealed for the row. */
async function prepareSessionDelivery(
  input: Parameters<typeof prepareDeliveries>[0],
  target: Extract<DeliveryTarget, { readonly kind: 'session' }>,
  id: string,
): Promise<PreparedDelivery> {
  const record: SessionDeliveryRecord = {
    kind: 'session-message',
    values: contextFieldValues(target.document.context, input.data),
    ...(targetQueues(target.document)
      ? {
          item: queueItemContent({
            eventType: input.rule.event.type,
            mapping: input.rule.mapping,
            event: input.event as JsonValue,
            show: 'summary',
          }),
        }
      : {}),
    released: input.released === true,
  };
  const encryptedRecord = await input.cipher.encrypt(
    { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text', value: id }] },
    Buffer.from(JSON.stringify(record)),
  );
  return {
    id,
    targetKey: targetDeliveryKey(target),
    target,
    representation: target.representation,
    cloudEventBytes: '',
    encryptedRecord,
    expiresAt: fixedDeadline(input.createdAt, input.rule.retention.deliveryMs),
  };
}

/** A Linear delivery carries its rendered issue, encrypted for the delivery row; nothing is mapped again at dispatch. */
async function prepareLinearDelivery(
  input: Parameters<typeof prepareDeliveries>[0],
  target: Extract<DeliveryTarget, { readonly kind: 'linear' }>,
  id: string,
): Promise<PreparedDelivery> {
  const document = input.rule.targets.find(
    (candidate) =>
      candidate.kind === 'linear' &&
      candidate.targetId === target.targetId &&
      candidate.version === target.targetVersion,
  );
  if (document?.kind !== 'linear') throw new Error('a Linear delivery has no approved Linear target');
  const compiled = compileMapping(input.definition, input.rule.mapping);
  if (!compiled.ok) throw new Error("the rule's approved mapping no longer compiles");
  const issue = renderLinearIssue({
    target: document,
    ruleId: input.rule.ruleId,
    ruleVersion: input.rule.version,
    deliveryId: id,
    data: input.data,
    fields: mappedFields(compiled.value),
  });
  const record: LinearDeliveryRecord = { kind: 'linear-issue', ...issue };
  const encryptedRecord = await input.cipher.encrypt(
    { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text', value: id }] },
    Buffer.from(JSON.stringify(record)),
  );
  return {
    id,
    targetKey: targetDeliveryKey(target),
    target,
    representation: target.representation,
    // An issue is not a CloudEvent; there are no bytes to select later.
    cloudEventBytes: '',
    encryptedRecord,
    expiresAt: fixedDeadline(input.createdAt, input.rule.retention.deliveryMs),
  };
}

function documentDeliveryTarget(rule: CanonicalFullRuleDocument, target: TargetDocument): DeliveryTarget {
  switch (target.kind) {
    case 'dry-run':
      return {
        kind: 'dry-run',
        targetId: target.targetId,
        targetVersion: target.version,
        representation: 'plain',
      };
    case 'webhook':
      return webhookDeliveryTarget(target);
    case 'sse': {
      const subscriber = rule.subscribers.find(
        (candidate) => candidate.subscriberId === target.subscriberId && candidate.version === target.subscriberVersion,
      );
      if (subscriber === undefined) throw new Error('an immutable SSE target has no bound subscriber version');
      return sseDeliveryTarget({
        targetId: target.targetId,
        version: target.version,
        subscriber,
        representation: target.representation,
      });
    }
    case 'queue':
      return {
        kind: 'queue',
        targetId: target.targetId,
        targetVersion: target.version,
        representation: 'plain',
        show: target.show,
        retentionMs: target.retentionMs,
      };
    case 'session':
      // Its sender values are enveloped when the prompt is written: the record keeps them as the source sanitised them.
      return {
        kind: 'session',
        targetId: target.targetId,
        targetVersion: target.version,
        representation: 'enveloped',
        document: target,
      };
    case 'linear':
      return { kind: 'linear', targetId: target.targetId, targetVersion: target.version, representation: 'plain' };
    case 'linear-change':
      // Only a workflow's flow delivers a Linear change, through its own step (workflows design W5): never a fan-out.
      throw new Error('a Linear change is delivered only by its workflow step');
  }
}

/**
 * A workflow deliver step's delivery (workflows design §5, §6.4, W5), made ready outside any transaction: its target's
 * record, sealed for its row as a match's deliveries are — from the run's own sealed record, which kept the mapped
 * values and what the message's deliveries need of it — and the session the flow chose, recorded beside it so the
 * dispatcher gives that session the turn and looks for no other. Its target key ends in `#<step>`, so one decision
 * holds one delivery per step.
 */
export interface PreparedFlowDelivery {
  readonly deliveryId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly decisionId: string;
  readonly accountId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly target: DeliveryTarget;
  readonly targetKey: string;
  readonly representation: DeliveryRepresentation;
  readonly encryptedRecord: Buffer;
  readonly expiresAt: number;
  readonly switchGeneration: number;
  readonly whatsappMessageId: string | null;
  /** The relay session the flow chose, for a session target found by `{ flow: true }`. */
  readonly session: string | null;
}

/**
 * A Linear change's sealed record (workflows design §6.7, plan B5): the run's own issue, and the comment rendered once —
 * from the target as approved, the run's mapped fields, its steps' closed outputs and its sealed summaries — each slot's
 * value a quoted block labelled by who wrote it, a session's summary "Written by an agent, not checked".
 */
export function prepareLinearChangeDelivery(input: {
  readonly rule: CanonicalFullRuleDocument;
  readonly target: LinearChangeTargetDocument;
  readonly deliveryId: string;
  readonly issue: NonNullable<FlowDeliveryRequest['issue']>;
  readonly record: RunRecord;
  readonly runId: string;
  readonly output: (stepId: string) => Readonly<Record<string, JsonValue>> | null;
}): LinearChangeDeliveryRecord {
  const { rule, record } = input;
  const flow = rule.flow;
  let comment: string | null = null;
  if (input.target.comment !== undefined) {
    const definition = catalogueEntry(rule.event.type, rule.event.version);
    if (!definition.ok) throw new CommsError('BAD_DATA', "the workflow's event definition is unavailable");
    const compiled = compileMapping(definition.value, rule.mapping);
    if (!compiled.ok) throw new Error("the workflow's approved mapping no longer compiles");
    comment = renderLinearComment({
      target: input.target,
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      deliveryId: input.deliveryId,
      data: record.fields,
      fields: mappedFields(compiled.value),
      // A session's summary, an agent's words: from the run's sealed record, never a step's output.
      summary: (slot) => {
        const named = /^steps\.([^.]+)\.summary$/u.exec(slot)?.[1];
        if (named === undefined || flow?.steps[named]?.kind !== 'wait') return undefined;
        return record.summaries?.[named] ?? '';
      },
      ...(flow === undefined
        ? {}
        : {
            closed: (slot: string) =>
              isClosedSlot(slot)
                ? closedSlotText(slot, {
                    runId: input.runId,
                    flow,
                    output: input.output,
                    trigger: record.trigger ?? null,
                  })
                : undefined,
          }),
    });
  }
  return {
    kind: 'linear-change',
    issue: { id: input.issue.id, identifier: input.issue.identifier, url: input.issue.url },
    comment,
  };
}

export async function prepareFlowDelivery(input: {
  readonly cipher: ProjectionCipher;
  readonly run: {
    readonly id: string;
    readonly decisionId: string;
    readonly accountId: string;
    readonly switchGeneration: number;
    readonly whatsappMessageId: string | null;
  };
  readonly rule: CanonicalFullRuleDocument;
  readonly request: FlowDeliveryRequest;
  readonly record: RunRecord;
  /** The run's settled steps' closed outputs, for a Linear target's closed slots. */
  readonly output: (stepId: string) => Readonly<Record<string, JsonValue>> | null;
  readonly installationId: string;
  readonly now: number;
  readonly newId?: (() => string) | undefined;
}): Promise<PreparedFlowDelivery> {
  const { rule, request, record } = input;
  const document = rule.targets.find(
    (target) => target.targetId === request.target.targetId && target.version === request.target.version,
  );
  if (document === undefined) throw new CommsError('APPROVAL_VOID', "the deliver step's target is not the workflow's");
  const target: DeliveryTarget =
    document.kind === 'linear-change'
      ? { kind: 'linear-change', targetId: document.targetId, targetVersion: document.version, representation: 'plain' }
      : documentDeliveryTarget(rule, document);
  const id = (input.newId ?? (() => crypto.randomUUID()))();
  const key = `${document.targetId}@${document.version}`;
  const data = record.fields;
  let sealed: unknown;
  if (document.kind === 'linear-change') {
    // The issue is the one the step's `to.issue` names, from that create step's closed output: never a message's.
    if (request.issue === undefined)
      throw new CommsError('BAD_DATA', 'a Linear change acts on the issue its run made, and the run made none');
    sealed = prepareLinearChangeDelivery({
      rule,
      target: document,
      deliveryId: id,
      issue: request.issue,
      record,
      runId: input.run.id,
      output: input.output,
    });
  } else if (target.kind === 'session') {
    const sessionRecord: SessionDeliveryRecord = {
      kind: 'session-message',
      values: contextFieldValues(target.document.context, data),
      ...(record.items?.[key] === undefined ? {} : { item: record.items[key] }),
      released: false,
    };
    sealed = sessionRecord;
  } else if (target.kind === 'queue') {
    const item = record.items?.[key];
    if (item === undefined) throw new CommsError('BAD_DATA', "the run kept no Queue item for the step's target");
    const queueRecord: QueueDeliveryRecord = { kind: 'queue-item', item, released: false };
    sealed = queueRecord;
  } else if (target.kind === 'linear') {
    if (document.kind !== 'linear') throw new CommsError('APPROVAL_VOID', 'a Linear delivery has no Linear target');
    const definition = catalogueEntry(rule.event.type, rule.event.version);
    if (!definition.ok) throw new CommsError('BAD_DATA', "the workflow's event definition is unavailable");
    const compiled = compileMapping(definition.value, rule.mapping);
    if (!compiled.ok) throw new Error("the workflow's approved mapping no longer compiles");
    const flow = rule.flow;
    const linearRecord: LinearDeliveryRecord = {
      kind: 'linear-issue',
      ...renderLinearIssue({
        target: document,
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        deliveryId: id,
        data,
        fields: mappedFields(compiled.value),
        ...(flow === undefined
          ? {}
          : {
              closed: (slot: string) =>
                isClosedSlot(slot)
                  ? closedSlotText(slot, {
                      runId: input.run.id,
                      flow,
                      output: input.output,
                      trigger: record.trigger ?? null,
                    })
                  : undefined,
            }),
      }),
    };
    sealed = linearRecord;
  } else {
    // A CloudEvent target — webhook, SSE, dry-run — is built from what the decision kept of the message: its
    // account, time and subject, and which mapped values a sender wrote; never the message again.
    const source = record.source;
    const definition = catalogueEntry(rule.event.type, rule.event.version);
    if (source === undefined || !definition.ok)
      throw new CommsError('BAD_DATA', "the run kept none of what its step's CloudEvent is built of");
    const constructed = constructTargetDelivery({
      target,
      definition: { ...definition.value, subject: () => source.subject } as never,
      event: { account: { id: source.accountId }, occurredAt: source.occurredAt },
      deliveryId: id,
      installationId: input.installationId,
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      ...(rule.cloudEventType === undefined ? {} : { cloudEventType: rule.cloudEventType }),
      data,
      classification: source.classification,
    });
    const cloudRecord: DeliveryRecord = {
      cloudEventBytes: constructed.cloudEventBytes,
      untrusted: constructed.untrusted,
      representation: constructed.representation,
    };
    sealed = cloudRecord;
  }
  const encryptedRecord = await input.cipher.encrypt(
    { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text', value: id }] },
    Buffer.from(JSON.stringify(sealed)),
  );
  return {
    deliveryId: id,
    runId: input.run.id,
    stepId: request.stepId,
    decisionId: input.run.decisionId,
    accountId: input.run.accountId,
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    target,
    targetKey: `${targetDeliveryKey(target)}#${request.stepId}`,
    representation: target.representation,
    encryptedRecord,
    expiresAt: fixedDeadline(input.now, rule.retention.deliveryMs),
    switchGeneration: input.run.switchGeneration,
    whatsappMessageId: input.run.whatsappMessageId,
    session: target.kind === 'session' && 'flow' in target.document.find ? (request.session ?? null) : null,
  };
}

/**
 * Inserts a workflow step's delivery inside the transaction that settles its step waiting on it (§5): one row of the
 * run's decision, the run and step named, in its target's own order, holding its target version; and, for the session
 * the flow chose, the dispatcher's record of that choice. Returns the delivery's id.
 */
export function insertFlowDeliveryInTransaction(database: DatabaseSync, prepared: PreparedFlowDelivery): string {
  const orderingSequence = allocateDeliveryOrderSequence(database, {
    ruleId: prepared.ruleId,
    accountId: prepared.accountId,
    targetId: prepared.target.targetId,
  });
  database
    .prepare(
      `INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
        target_kind, target_representation, subscriber_id, subscriber_version, encrypted_record, expires_at,
        state, switch_generation, next_at, ordering_sequence, whatsapp_visibility_version, whatsapp_message_id,
        run_id, step_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      prepared.deliveryId,
      prepared.decisionId,
      prepared.accountId,
      prepared.ruleId,
      prepared.ruleVersion,
      prepared.targetKey,
      prepared.target.targetId,
      prepared.target.targetVersion,
      prepared.target.kind,
      prepared.representation,
      prepared.target.kind === 'sse' ? prepared.target.subscriberId : null,
      prepared.target.kind === 'sse' ? prepared.target.subscriberVersion : null,
      prepared.encryptedRecord,
      prepared.expiresAt,
      prepared.switchGeneration,
      0,
      orderingSequence,
      prepared.whatsappMessageId,
      prepared.runId,
      prepared.stepId,
    );
  addRetainedDeliveryTargetReference(database, {
    deliveryId: prepared.deliveryId,
    ruleId: prepared.ruleId,
    ruleVersion: prepared.ruleVersion,
    targetId: prepared.target.targetId,
    targetVersion: prepared.target.targetVersion,
    createdAt: Date.now(),
  });
  if (prepared.session !== null)
    database
      .prepare(
        `INSERT INTO session_deliveries (delivery_id, relay_session_id, started, run_id, chosen_at)
         VALUES (?, ?, 0, NULL, ?)`,
      )
      .run(prepared.deliveryId, prepared.session, Date.now());
  return prepared.deliveryId;
}
