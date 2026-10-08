import {
  type AnyEventDefinition,
  buildCloudEvent,
  cloudEventBytes,
  type MappedClassification,
} from '@agentcomms/events';
import type { CanonicalFullRuleDocument, DryRunTargetDocument } from '../domain/activation-documents.ts';
import { fixedDeadline } from '../store/retention.ts';
import type { ProjectionCipher } from './projections.ts';

export interface PreparedDelivery {
  readonly id: string;
  readonly targetKey: string;
  readonly target: DryRunTargetDocument;
  readonly encryptedRecord: Buffer;
  readonly expiresAt: number;
}

/** The exact persisted retry payload: canonical bytes plus the one durable target representation boundary. */
export interface DeliveryRecord {
  readonly cloudEventBytes: string;
  readonly untrusted: readonly string[];
  readonly representation: 'plain';
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
  readonly data: import('@agentcomms/events').JsonValue;
}): Promise<readonly PreparedDelivery[]> {
  const untrusted = [...new Set(input.classification.untrusted.map((entry) => entry.pointer))].sort();
  const deliveries: PreparedDelivery[] = [];
  for (const target of input.rule.targets) {
    const id = input.newId();
    const cloudEvent = buildCloudEvent(input.definition as never, input.event as never, {
      deliveryId: id,
      installationId: input.installationId,
      ruleId: input.rule.ruleId,
      ruleVersion: input.rule.version,
      targetId: target.targetId,
      targetVersion: target.version,
      data: input.data,
      untrusted,
      ...(input.rule.cloudEventType === undefined ? {} : { cloudEventType: input.rule.cloudEventType }),
    });
    const record: DeliveryRecord = { cloudEventBytes: cloudEventBytes(cloudEvent), untrusted, representation: 'plain' };
    // Encryption reserves its nonce outside the decision transaction. A rolled-back decision only spends a nonce.
    const encryptedRecord = await input.cipher.encrypt(
      { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text', value: id }] },
      Buffer.from(JSON.stringify(record)),
    );
    deliveries.push({
      id,
      targetKey: `dryrun:${target.targetId}:${target.version}`,
      target,
      encryptedRecord,
      expiresAt: fixedDeadline(input.createdAt, input.rule.retention.deliveryMs),
    });
  }
  return deliveries;
}
