import { JUDGE_KIND_LAYA, JUDGE_KIND_LOCAL_ENDPOINT, JUDGE_KIND_TYPESAFE } from '../domain/lifecycle.ts';
import type { PreparedActivation } from '../runtime/activations.ts';
import type { LayaModelStatus, LayaUnavailableCode } from '../runtime/laya/contracts.ts';
import type { DoctorLayaKindV3, DoctorReportV3 } from './doctor.ts';

/**
 * B3 control v2 is v1 with E2's real Laya answers. A v1 reader keeps every operation v1 names; v2 replaces exactly
 * the results that carried B3 v1's typed `E2_REQUIRED` placeholder, each now reporting the real model state
 * (`contracts/b3-control-v2.schema.json`, vectors in `test/fixtures/b3-control-contract-v2/`). An owner composed
 * without E2's artifact manager still answers v1.
 */
export const B3_CONTROL_V2_SCHEMA_VERSION = 'b3-control-v2' as const;

export const LAYA_UNAVAILABLE_CODES: readonly LayaUnavailableCode[] = Object.freeze([
  'E2_EXTERNAL_REFERENCE_BLOCKED',
  'LAYA_PLATFORM_UNAVAILABLE',
  'LAYA_SANDBOX_UNAVAILABLE',
]);

/** The operations whose result B3 control v2 replaces; every other operation's result is v1's. */
export const B3_CONTROL_V2_LAYA_OPERATIONS: readonly [
  'judgeKindsList',
  'enableJudgeKind',
  'disableJudgeKind',
  'judgeModelStatus',
  'removeJudgeModel',
  'doctor',
] = Object.freeze([
  'judgeKindsList',
  'enableJudgeKind',
  'disableJudgeKind',
  'judgeModelStatus',
  'removeJudgeModel',
  'doctor',
] as const);

export type B3ControlV2LayaOperation = (typeof B3_CONTROL_V2_LAYA_OPERATIONS)[number];

/** A Laya enable refused before any version, intent, approval or file: the machine or release does not offer it. */
export interface B3LayaUnavailableV2 {
  readonly kind: 'unavailable';
  readonly code: LayaUnavailableCode;
  readonly phase: 'E2';
}

/** E's immediate kind disable, for every kind: the pointer removed (or already absent) and pending enables cancelled. */
export interface B3JudgeKindDisabledV2 {
  readonly kind: typeof JUDGE_KIND_TYPESAFE | typeof JUDGE_KIND_LAYA | typeof JUDGE_KIND_LOCAL_ENDPOINT;
  readonly disabled: true;
  readonly pointer: 'absent' | 'removed';
  readonly pendingActivationsCancelled: number;
}

export type B3JudgeKindEntryV2 =
  | {
      readonly kind: typeof JUDGE_KIND_TYPESAFE | typeof JUDGE_KIND_LOCAL_ENDPOINT;
      readonly state: 'disabled' | 'enabled';
      readonly version: number | null;
    }
  | DoctorLayaKindV3;

export interface B3ControlV2LayaResultsByOperation {
  readonly judgeKindsList: readonly B3JudgeKindEntryV2[];
  /** The same pending judge-kind approval E prepares for every kind, or Laya's closed refusal. */
  readonly enableJudgeKind: PreparedActivation | B3LayaUnavailableV2;
  readonly disableJudgeKind: B3JudgeKindDisabledV2;
  readonly judgeModelStatus: LayaModelStatus;
  readonly removeJudgeModel: LayaModelStatus;
  readonly doctor: DoctorReportV3;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closed(value: unknown, keys: readonly string[], name: string): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new TypeError(`${name} must be a closed object`);
}

function nullableInteger(value: unknown, name: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0))
    throw new TypeError(`${name} is a non-negative integer or null`);
}

const STATES = new Set(['idle', 'installing', 'downloading', 'verifying', 'ready', 'failed', 'unavailable']);
const FAILURES = new Set(['boundary-failed', 'download-failed', 'integrity', 'runtime-failed']);

/** The runtime half of laya-model-status-v1.schema.json, including its state/failure/reason coupling. */
export function assertLayaModelStatusV1(value: unknown): asserts value is LayaModelStatus {
  closed(
    value,
    ['state', 'manifestId', 'runtimeLockDigest', 'bytesVerified', 'totalBytes', 'failureCode', 'reason', 'updatedAt'],
    'a Laya model status',
  );
  if (typeof value.state !== 'string' || !STATES.has(value.state)) throw new TypeError('a Laya state is closed');
  if (value.manifestId !== null && (typeof value.manifestId !== 'string' || value.manifestId.length === 0))
    throw new TypeError('a Laya manifest id is text or null');
  if (value.runtimeLockDigest !== null && !/^[a-f0-9]{64}$/.test(String(value.runtimeLockDigest)))
    throw new TypeError('a Laya runtime lock digest is lowercase SHA-256 or null');
  if (!Number.isSafeInteger(value.bytesVerified) || (value.bytesVerified as number) < 0)
    throw new TypeError('verified bytes are a non-negative integer');
  if (!Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 0)
    throw new TypeError('total bytes are a non-negative integer');
  nullableInteger(value.updatedAt, 'a Laya update time');
  const failure = value.failureCode;
  const reason = value.reason;
  if (failure !== null && (typeof failure !== 'string' || !FAILURES.has(failure)))
    throw new TypeError('a Laya failure code is closed');
  if (reason !== null && !LAYA_UNAVAILABLE_CODES.includes(reason as LayaUnavailableCode))
    throw new TypeError('a Laya reason is closed');
  if (value.state === 'unavailable') {
    if (failure !== null || reason === null) throw new TypeError('an unavailable Laya status names only its reason');
  } else if (value.state === 'failed') {
    if (failure === null) throw new TypeError('a failed Laya status names its failure code');
    if (reason !== null && (failure !== 'boundary-failed' || reason === 'E2_EXTERNAL_REFERENCE_BLOCKED'))
      throw new TypeError('only a boundary failure names a platform or sandbox reason');
  } else if (failure !== null || reason !== null) throw new TypeError('a working Laya status names no failure');
}

function assertKindEntry(value: unknown): void {
  if (!isRecord(value)) throw new TypeError('a judge kind entry is an object');
  if (value.kind === JUDGE_KIND_LAYA && value.state === 'unavailable') {
    closed(value, ['kind', 'state', 'code'], 'an unavailable Laya kind');
    if (!LAYA_UNAVAILABLE_CODES.includes(value.code as LayaUnavailableCode))
      throw new TypeError('an unavailable Laya kind names its closed reason');
    return;
  }
  closed(value, ['kind', 'state', 'version'], 'a judge kind entry');
  if (![JUDGE_KIND_TYPESAFE, JUDGE_KIND_LAYA, JUDGE_KIND_LOCAL_ENDPOINT].includes(value.kind as never))
    throw new TypeError('a judge kind entry names a known kind');
  if (value.state === 'disabled' && value.version === null) return;
  if (value.state === 'enabled' && Number.isSafeInteger(value.version) && (value.version as number) >= 1) return;
  throw new TypeError('a judge kind entry pairs its state with its version');
}

/** Runtime companion to B3ControlV2LayaResultsByOperation; doctor reports are checked by doctor-v3's own schema. */
export function assertB3ControlV2LayaResult(operation: B3ControlV2LayaOperation, value: unknown): void {
  switch (operation) {
    case 'judgeModelStatus':
    case 'removeJudgeModel':
      assertLayaModelStatusV1(value);
      return;
    case 'judgeKindsList': {
      if (!Array.isArray(value) || value.length !== 3) throw new TypeError('the judge kind list names every kind');
      value.forEach(assertKindEntry);
      const kinds = value.map((entry) => (entry as { kind: unknown }).kind);
      if (new Set(kinds).size !== 3) throw new TypeError('the judge kind list names each kind once');
      return;
    }
    case 'enableJudgeKind':
      if (isRecord(value) && value.kind === 'unavailable') {
        closed(value, ['kind', 'code', 'phase'], 'an unavailable Laya enable');
        if (!LAYA_UNAVAILABLE_CODES.includes(value.code as LayaUnavailableCode) || value.phase !== 'E2')
          throw new TypeError('an unavailable Laya enable names its closed reason');
        return;
      }
      if (!isRecord(value) || value.kind !== 'judge-kind' || value.status !== 'pending')
        throw new TypeError('a judge kind enable prepares one pending judge-kind approval');
      return;
    case 'disableJudgeKind':
      closed(value, ['kind', 'disabled', 'pointer', 'pendingActivationsCancelled'], 'a judge kind disable');
      if (
        ![JUDGE_KIND_TYPESAFE, JUDGE_KIND_LAYA, JUDGE_KIND_LOCAL_ENDPOINT].includes(value.kind as never) ||
        value.disabled !== true ||
        (value.pointer !== 'absent' && value.pointer !== 'removed') ||
        !Number.isSafeInteger(value.pendingActivationsCancelled) ||
        (value.pendingActivationsCancelled as number) < 0
      )
        throw new TypeError('a judge kind disable is closed');
      return;
    case 'doctor':
      if (!isRecord(value) || value.schemaVersion !== 'doctor-v3') throw new TypeError('doctor answers doctor-v3');
      return;
  }
}
