import { newBoundary, wrapUntrusted } from '@agentcomms/core';
import {
  type AnyEventDefinition,
  applyRepresentation,
  buildCloudEvent,
  cloudEventBytes,
  type JsonValue,
  type MappedClassification,
} from '@agentcomms/events';
import type { QueueShow } from '../domain/queue-target.ts';
import type { SessionTargetDocument } from '../domain/session-target.ts';

export type DeliveryRepresentation = 'plain' | 'enveloped';

interface BaseDeliveryTarget {
  readonly targetId: string;
  readonly targetVersion: number;
  readonly representation: DeliveryRepresentation;
}

/** The closed B2 delivery seam. Public target documents do not select these forms until Task 3. */
export type DeliveryTarget =
  | (BaseDeliveryTarget & { readonly kind: 'dry-run' })
  | (BaseDeliveryTarget & { readonly kind: 'webhook' })
  | (BaseDeliveryTarget & {
      readonly kind: 'sse';
      readonly subscriberId: string;
      readonly subscriberVersion: number;
    })
  // The action queue: a local list item, built from the projection rather than from CloudEvent bytes.
  | (BaseDeliveryTarget & { readonly kind: 'queue'; readonly show: QueueShow; readonly retentionMs: number })
  // An agent session (0.33.0 §3.5): the mapped values its context reads, built from the mapped data, never CloudEvent
  // bytes; the prompt is written at dispatch, when its model and file parts are read.
  | (BaseDeliveryTarget & { readonly kind: 'session'; readonly document: SessionTargetDocument })
  // A Linear issue (0.33.0 design §3.4): its title and description, rendered once from the mapped data.
  | (BaseDeliveryTarget & { readonly kind: 'linear' });

export interface ConstructedTargetDelivery {
  readonly target: DeliveryTarget;
  readonly targetKey: string;
  readonly representation: DeliveryRepresentation;
  readonly cloudEventBytes: string;
  readonly untrusted: readonly string[];
}

export interface ConstructTargetDeliveryInput {
  readonly target: DeliveryTarget;
  readonly definition: AnyEventDefinition;
  readonly event: Record<string, unknown>;
  readonly deliveryId: string;
  readonly installationId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly cloudEventType?: string | undefined;
  readonly data: JsonValue;
  readonly classification: MappedClassification;
  /** Tests may supply a stable envelope implementation without changing a persisted delivery boundary. */
  readonly envelope?: ((text: string, pointer: string, deliveryId: string) => string) | undefined;
}

/** Exact D7 identity, including the subscriber binding that distinguishes otherwise shared SSE targets. */
export function targetDeliveryKey(target: DeliveryTarget): string {
  switch (target.kind) {
    case 'dry-run':
      return `dryrun:${target.targetId}:${target.targetVersion}`;
    case 'webhook':
      return `webhook:${target.targetId}:${target.targetVersion}`;
    case 'sse':
      return `sse:${target.targetId}:${target.targetVersion}:${target.subscriberId}:${target.subscriberVersion}`;
    case 'queue':
      return `queue:${target.targetId}:${target.targetVersion}`;
    case 'session':
      return `session:${target.targetId}:${target.targetVersion}`;
    case 'linear':
      return `linear:${target.targetId}:${target.targetVersion}`;
  }
}

/**
 * Produces the one durable target-specific CloudEvent representation before the caller opens its persistence write.
 * Later dispatch selects these bytes by kind; it never maps, envelopes, or serialises them again.
 */
export function constructTargetDelivery(input: ConstructTargetDeliveryInput): ConstructedTargetDelivery {
  const untrusted = [...new Set(input.classification.untrusted.map((entry) => entry.pointer))].sort();
  const data = representedData(input);
  const cloudEvent = buildCloudEvent(input.definition as never, input.event as never, {
    deliveryId: input.deliveryId,
    installationId: input.installationId,
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    targetId: input.target.targetId,
    targetVersion: input.target.targetVersion,
    data,
    untrusted,
    ...(input.cloudEventType === undefined ? {} : { cloudEventType: input.cloudEventType }),
  });
  return {
    target: input.target,
    targetKey: targetDeliveryKey(input.target),
    representation: input.target.representation,
    cloudEventBytes: cloudEventBytes(cloudEvent),
    untrusted,
  };
}

function representedData(input: ConstructTargetDeliveryInput): JsonValue {
  if (input.target.representation === 'plain')
    return applyRepresentation(input.data, input.classification, { kind: 'plain' });
  const boundary = newBoundary();
  const envelope =
    input.envelope ??
    ((text: string, _pointer: string, deliveryId: string) =>
      wrapUntrusted(text, { field: 'event', id: deliveryId }, boundary));
  return applyRepresentation(input.data, input.classification, {
    kind: 'enveloped',
    envelope: (text, pointer) => envelope(text, pointer, input.deliveryId),
  });
}
