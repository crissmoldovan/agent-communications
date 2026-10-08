import type { AnyEventDefinition, JsonValue, MappedClassification } from '@agentcomms/events';
import type { CanonicalFullRuleDocument, DryRunTargetDocument } from '../domain/activation-documents.ts';
import { fixedDeadline } from '../store/retention.ts';
import type { ProjectionCipher } from './projections.ts';
import { constructTargetDelivery, type DeliveryRepresentation, type DeliveryTarget } from './target-delivery.ts';

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
}): Promise<readonly PreparedDelivery[]> {
  const deliveries: PreparedDelivery[] = [];
  const targets = input.targets ?? input.rule.targets.map(dryRunDeliveryTarget);
  for (const target of targets) {
    const id = input.newId();
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

function dryRunDeliveryTarget(target: DryRunTargetDocument): DeliveryTarget {
  return {
    kind: 'dry-run',
    targetId: target.targetId,
    targetVersion: target.version,
    representation: 'plain',
  };
}
