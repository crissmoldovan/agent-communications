import type { AnyEventDefinition, CatalogueEventV1, EventDefinition } from '../catalogue/types.ts';
import { canonicalJson, isJsonValue, type JsonValue } from '../json.ts';
import { deliverySchemaId } from '../mapping/delivery-schema.ts';
import { EventsError, type Result } from '../result.ts';
import { percentEncodeComponent } from './percent.ts';
import { encodeUntrustedExtension } from './untrusted-extension.ts';

/** The structured-mode HTTP content type D6 fixes for a CloudEvents delivery. */
export const CLOUDEVENTS_CONTENT_TYPE = 'application/cloudevents+json; charset=utf-8';

/** The version-1 structured CloudEvents object carried over the external wire. */
export interface CloudEventV1 {
  readonly specversion: '1.0';
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly dataschema: string;
  readonly subject: string;
  readonly agentcommsrule: string;
  readonly agentcommsuntrusted?: string;
  readonly data: JsonValue;
}

/** Stable delivery fields a daemon supplies after mapping and taint classification. */
export interface BuildCloudEventInput {
  readonly deliveryId: string;
  readonly installationId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly data: JsonValue;
  readonly untrusted?: readonly string[];
  readonly cloudEventType?: unknown;
}

const invalid = (pointer: string, message: string): never => {
  throw new EventsError('CLOUD_EVENT_INVALID', message, pointer);
};

function nonEmpty(value: unknown, pointer: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(pointer, `${pointer} is a non-empty string`);
  return value as string;
}

function version(value: unknown, pointer: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(pointer, `${pointer} is a positive integer`);
  return value as number;
}

/** The default D6 type for a catalogue definition. */
export function defaultCloudEventType(definition: Pick<AnyEventDefinition, 'type' | 'version'>): string {
  return `com.agentcomms.${definition.type}.v${definition.version}`;
}

/** Validate precisely D6's optional rule-defined type: a non-empty string, kept exactly as given. */
export function validateCloudEventType(value: unknown): Result<string> {
  if (typeof value === 'string' && value.length > 0) return { ok: true, value };
  return {
    ok: false,
    issues: [{ code: 'CLOUD_EVENT_TYPE_INVALID', message: 'cloudEventType is a non-empty string' }],
  };
}

/** Derive every D6 CloudEvents attribute that a mapping may not override. */
export function buildCloudEvent<T extends CatalogueEventV1, S>(
  definition: EventDefinition<T, S>,
  event: T,
  input: BuildCloudEventInput,
): CloudEventV1 {
  const deliveryId = nonEmpty(input.deliveryId, '/deliveryId');
  const installationId = nonEmpty(input.installationId, '/installationId');
  const ruleId = nonEmpty(input.ruleId, '/ruleId');
  const targetId = nonEmpty(input.targetId, '/targetId');
  const ruleVersion = version(input.ruleVersion, '/ruleVersion');
  const targetVersion = version(input.targetVersion, '/targetVersion');
  if (!isJsonValue(input.data)) invalid('/data', '/data is JSON');
  const requested = input.cloudEventType;
  const chosen = requested === undefined ? defaultCloudEventType(definition) : validateCloudEventType(requested);
  if (typeof chosen !== 'string') {
    if (!chosen.ok)
      throw new EventsError('CLOUD_EVENT_TYPE_INVALID', chosen.issues[0]?.message ?? 'invalid cloudEventType');
  }
  const cloudEventType = typeof chosen === 'string' ? chosen : chosen.value;
  const accountId = nonEmpty(event.account.id, '/account/id');
  const extension = encodeUntrustedExtension(input.data, input.untrusted ?? []);
  return {
    specversion: '1.0',
    id: deliveryId,
    source: `urn:agentcomms:${percentEncodeComponent(installationId)}:${percentEncodeComponent(accountId)}`,
    type: cloudEventType,
    time: event.occurredAt,
    datacontenttype: 'application/json',
    dataschema: deliverySchemaId(ruleId, ruleVersion, targetId, targetVersion),
    subject: definition.subject(event),
    agentcommsrule: `${percentEncodeComponent(ruleId)}@${ruleVersion}`,
    ...(extension === undefined ? {} : { agentcommsuntrusted: extension }),
    data: input.data,
  };
}

/** The exact canonical JSON bytes represented as a JavaScript string before UTF-8 transport encoding. */
export function cloudEventBytes(event: CloudEventV1): string {
  return canonicalJson(event);
}
