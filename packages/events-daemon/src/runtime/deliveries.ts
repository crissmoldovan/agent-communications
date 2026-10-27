import {
  type AnyEventDefinition,
  compileMapping,
  contextFieldValues,
  type JsonValue,
  type MappedClassification,
  type ResolvedContextPart,
  targetQueues,
} from '@agentcomms/events';
import type { CanonicalFullRuleDocument, TargetDocument } from '../domain/activation-documents.ts';
import { mappedFields, renderLinearIssue } from '../domain/linear-target.ts';
import { type QueueItemContent, queueItemContent } from '../domain/queue-target.ts';
import { sseDeliveryTarget } from '../domain/sse-subscriber.ts';
import { webhookDeliveryTarget } from '../domain/webhook-target.ts';
import { fixedDeadline } from '../store/retention.ts';
import type { ProjectionCipher } from './projections.ts';
import {
  constructTargetDelivery,
  type DeliveryRepresentation,
  type DeliveryTarget,
  targetDeliveryKey,
} from './target-delivery.ts';

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
