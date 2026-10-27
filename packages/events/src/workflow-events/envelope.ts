/**
 * The step event's envelope (workflows design W26, W27, Appendix W.2): a CloudEvents 1.0 structured JSON object whose
 * attributes are fixed, and whose `data` holds exactly W.2's keys. Automatic events carry closed values only. Sender
 * content reaches an event only through a Raise step's declared `fields`, and only for a subscriber allowed it, inside
 * the untrusted-content envelope with each pointer listed in `agentcommsuntrusted`: `representWorkflowEvent` decides
 * that per subscriber. A folder path is never in `data`.
 */
import type { StepKind } from '../flow/types.ts';
import { isInstant } from '../formats/instant.ts';
import { canonicalJson, isJsonValue, type JsonValue } from '../json.ts';
import { formatPointer } from '../pointer.ts';
import { EventsError } from '../result.ts';
import { percentEncodeComponent } from '../wire/percent.ts';
import { encodeUntrustedExtension } from '../wire/untrusted-extension.ts';
import { eventsFor, WORKFLOW_EVENT_CATALOGUE_V1, type WorkflowEventSchema } from './catalogue.ts';
import { parseWorkflowEventType } from './names.ts';

/** W.2's `data`, exactly: its nine keys always, and `nextAt`, `wait` and `fields` only where they apply. */
export interface WorkflowEventDataV1 {
  readonly workflow: {
    readonly id: string;
    readonly version: number;
    readonly namespace: string;
    readonly name: string;
  };
  readonly run: {
    readonly id: string;
    readonly startedAt: string;
    readonly depth: number;
    readonly parent: string | null;
  };
  /** Null for a run's events. `label` is the workflow author's words, at most 60 characters. */
  readonly step: {
    readonly id: string;
    readonly kind: StepKind;
    readonly label: string | null;
    readonly index: number;
    readonly attempt: number;
  } | null;
  /** The steps the run has passed through so far, in order. */
  readonly path: readonly string[];
  readonly event: string;
  /** Null for `started`, `waiting`, `retrying` and `skipped`. */
  readonly outcome: string | null;
  /** For `succeeded`, `failed` and the outcome words; null otherwise. */
  readonly durationMs: number | null;
  /** A closed code, for `failed` and `retrying`; null otherwise. */
  readonly error: string | null;
  /** The step's closed outputs (W.3), never a folder path. */
  readonly outputs: Readonly<Record<string, JsonValue>>;
  /** For `retrying`: when the next attempt is due. */
  readonly nextAt?: string;
  /** For `waiting`: what it waits for, since when. */
  readonly wait?: { readonly kind: 'turn-end' | 'session-idle' | 'time' | 'limit'; readonly since: string };
  /**
   * A Raise step's declared fields, by the mapped field's name, for a subscriber allowed content: a sender wrote
   * them, so they arrive only inside the untrusted-content envelope.
   */
  readonly fields?: Readonly<Record<string, string>>;
}

/** A step or run event, as structured CloudEvents 1.0 (W.2). */
export interface WorkflowCloudEventV1 {
  readonly specversion: '1.0';
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly dataschema: string;
  readonly subject: string;
  readonly agentcommsrule: string;
  readonly agentcommsrun: string;
  readonly agentcommsstep?: string;
  readonly agentcommsuntrusted?: string;
  readonly data: WorkflowEventDataV1;
}

/** Lowercase Crockford base-32, the alphabet run and event ids are made of. */
const EVENT_ID = /^wfe_[0-9a-hjkmnp-tv-z]{26}$/;
const RUN_ID = /^wfr_[0-9a-hjkmnp-tv-z]{26}$/;
const STEP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const DATA_KEYS: readonly string[] = [
  'workflow',
  'run',
  'step',
  'path',
  'event',
  'outcome',
  'durationMs',
  'error',
  'outputs',
];
const OPTIONAL_DATA_KEYS: readonly string[] = ['nextAt', 'wait'];

const invalid = (pointer: string, message: string): never => {
  throw new EventsError('WORKFLOW_EVENT_INVALID', message, pointer);
};

function text(value: unknown, pointer: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(pointer, `${pointer} is a non-empty string`);
  return value as string;
}

function positive(value: unknown, pointer: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(pointer, `${pointer} is a positive integer`);
  return value as number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The data-relative pointer of one declared field: `/fields/<name>`. */
const fieldPointer = (name: string): string => formatPointer(['fields', name]);

/**
 * Builds a step or run event with every attribute W.2 fixes: `source` is `urn:agentcomms:<installation>:workflows:
 * <workflow id>@<version>` and `agentcommsrule` `<id>@<version>`, both percent-encoded as `buildCloudEvent`'s; `subject`
 * and `agentcommsrun` are the run; `agentcommsstep` is absent for a run's events. Refuses an id, a type, a schema or
 * `data` that W.2 and W.3 do not allow, or that disagree with each other. Given `fields`, the event holds them in
 * `data.fields` and lists their pointers in `agentcommsuntrusted`: it is never sent as it is, only as
 * `representWorkflowEvent` makes it for each subscriber.
 */
export function buildWorkflowCloudEvent(input: {
  id: string;
  installationId: string;
  ruleId: string;
  ruleVersion: number;
  type: string;
  schema: WorkflowEventSchema;
  time: string;
  runId: string;
  stepId: string | null;
  data: Omit<WorkflowEventDataV1, 'fields'>;
  fields?: Readonly<Record<string, string>>;
}): WorkflowCloudEventV1 {
  if (typeof input.id !== 'string' || !EVENT_ID.test(input.id))
    invalid('/id', "an event's id is wfe_ and 26 lowercase Crockford base-32 characters");
  if (typeof input.runId !== 'string' || !RUN_ID.test(input.runId))
    invalid('/runId', "a run's id is wfr_ and 26 lowercase Crockford base-32 characters");
  const installationId = text(input.installationId, '/installationId');
  const ruleId = text(input.ruleId, '/ruleId');
  const ruleVersion = positive(input.ruleVersion, '/ruleVersion');
  if (!isInstant(input.time)) invalid('/time', "an event's time is an RFC 3339 instant");
  if (!Object.hasOwn(WORKFLOW_EVENT_CATALOGUE_V1, input.schema))
    invalid('/schema', `${String(input.schema)} is not a step event schema`);
  const stepId = input.stepId;
  if (stepId !== null && (typeof stepId !== 'string' || !STEP_ID.test(stepId)))
    invalid('/stepId', "a step's id is a lowercase word of 1 to 32 letters, digits and -");
  if ((input.schema === 'run') !== (stepId === null))
    invalid('/stepId', "a run's events have no step, and every other event has one");
  const parsed = parseWorkflowEventType(input.type);
  if (parsed === null) invalid('/type', "an event's type is <namespace>.<workflow>.<step>.<event>");
  const type = parsed as NonNullable<typeof parsed>;
  if (type.step !== (stepId ?? 'run')) invalid('/type', "an event's type names its step, or run for a run's events");

  const data = input.data as unknown;
  if (!isRecord(data) || !isJsonValue(data)) return invalid('/data', "an event's data is a JSON object");
  for (const key of DATA_KEYS) if (!Object.hasOwn(data, key)) invalid(`/data/${key}`, `an event's data has ${key}`);
  for (const key of Object.keys(data))
    if (!DATA_KEYS.includes(key) && !OPTIONAL_DATA_KEYS.includes(key))
      invalid(`/data/${key}`, `an event's data has no ${key}`);
  const workflow = data.workflow;
  if (
    !isRecord(workflow) ||
    workflow.id !== ruleId ||
    workflow.version !== ruleVersion ||
    workflow.namespace !== type.namespace ||
    workflow.name !== type.workflow
  )
    invalid('/data/workflow', "an event's data names its workflow, version, namespace and name as its type does");
  if (!isRecord(data.run) || data.run.id !== input.runId) invalid('/data/run', "an event's data names its run");
  const step = data.step;
  if (stepId === null ? step !== null : !isRecord(step) || step.id !== stepId)
    invalid('/data/step', "an event's data names its step, or null for a run's events");
  if (data.event !== type.event) invalid('/data/event', "an event's data names the word its type ends in");
  if (input.schema !== 'raise' && !eventsFor(input.schema).includes(type.event))
    invalid('/type', `${type.event} is not an event of ${input.schema} (Appendix W.3)`);
  if (!isRecord(data.outputs)) invalid('/data/outputs', "an event's outputs are an object");

  let fields: Readonly<Record<string, string>> | undefined;
  if (input.fields !== undefined) {
    if (!isRecord(input.fields)) invalid('/fields', "a Raise step's fields are an object of text");
    for (const [name, value] of Object.entries(input.fields))
      if (name.length === 0 || typeof value !== 'string')
        invalid(fieldPointer(name), "a Raise step's fields are text, by the field's name");
    if (Object.keys(input.fields).length > 0) fields = input.fields;
  }
  const withFields: WorkflowEventDataV1 = JSON.parse(
    canonicalJson(fields === undefined ? data : { ...data, fields }),
  ) as WorkflowEventDataV1;
  const untrusted =
    fields === undefined
      ? undefined
      : encodeUntrustedExtension(withFields as unknown as JsonValue, Object.keys(fields).map(fieldPointer));
  return {
    specversion: '1.0',
    id: input.id,
    source: `urn:agentcomms:${percentEncodeComponent(installationId)}:workflows:${percentEncodeComponent(ruleId)}@${ruleVersion}`,
    type: input.type,
    time: input.time,
    datacontenttype: 'application/json',
    dataschema: `urn:agentcomms:workflow-events:v1:${input.schema}`,
    subject: input.runId,
    agentcommsrule: `${percentEncodeComponent(ruleId)}@${ruleVersion}`,
    agentcommsrun: input.runId,
    ...(stepId === null ? {} : { agentcommsstep: stepId }),
    ...(untrusted === undefined ? {} : { agentcommsuntrusted: untrusted }),
    data: withFields,
  };
}

/**
 * The event as one subscriber may see it (W27, §9.4). `none`: without `data.fields` and `agentcommsuntrusted`.
 * `enveloped`: each field's value inside `envelope` — core's `wrapUntrusted`, given the field's data-relative pointer —
 * and every pointer listed in `agentcommsuntrusted`. An event with no fields is the same for both.
 */
export function representWorkflowEvent(
  event: WorkflowCloudEventV1,
  content: 'none' | 'enveloped',
  envelope: (text: string, pointer: string) => string,
): WorkflowCloudEventV1 {
  if (content !== 'none' && content !== 'enveloped')
    throw new EventsError('WORKFLOW_EVENT_INVALID', "a subscriber's content is none or enveloped");
  const copy = JSON.parse(canonicalJson(event)) as WorkflowCloudEventV1 & { agentcommsuntrusted?: string };
  const { fields, ...data } = copy.data;
  const { agentcommsuntrusted: _dropped, ...attributes } = copy;
  if (fields === undefined || Object.keys(fields).length === 0 || content === 'none') return { ...attributes, data };
  const wrapped: Record<string, string> = {};
  for (const name of Object.keys(fields).sort()) {
    const value = envelope(fields[name] as string, fieldPointer(name));
    if (typeof value !== 'string') throw new EventsError('WORKFLOW_EVENT_INVALID', 'an envelope writes text');
    Object.defineProperty(wrapped, name, { value, enumerable: true, writable: true, configurable: true });
  }
  const enveloped: WorkflowEventDataV1 = { ...data, fields: wrapped };
  const untrusted = encodeUntrustedExtension(enveloped as unknown as JsonValue, Object.keys(wrapped).map(fieldPointer));
  return { ...attributes, ...(untrusted === undefined ? {} : { agentcommsuntrusted: untrusted }), data: enveloped };
}

/** The exact bytes an event is sent and kept as: its canonical JSON. */
export function workflowEventBytes(event: WorkflowCloudEventV1): string {
  return canonicalJson(event);
}
