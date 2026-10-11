import type { ControlResponse, SafeAppResult, ScopeValue, Selection } from './types';

export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const invalidating = new Set([
  'rule-disable',
  'rule-remove',
  'target-remove',
  'removeSubscriber',
  'removeJudge',
  'disableJudgeKind',
  'dropDelivery',
  'decideHeld',
  'dryrun-show',
  'ruleTestRetained',
  'disable-all',
  'stop',
]);

/** Memory only. An invalidation cancels publication, never retries or queues a daemon mutation. */
export class ControlModel {
  readonly rows = new Map<string, SafeAppResult>();
  #epoch = 0;
  #generation: number | undefined;
  #requests = new Map<string, number>();
  #nextRequest = 0;
  #invoke: NativeInvoke;
  constructor(invoke: NativeInvoke) {
    this.#invoke = invoke;
  }
  reconnect() {
    this.#epoch++;
    this.rows.clear();
    this.#generation = undefined;
    this.#requests.clear();
  }
  close() {
    this.reconnect();
  }
  #current(operation: string, requestId: number, epoch: number) {
    return epoch === this.#epoch && this.#requests.get(operation) === requestId;
  }
  async control(operation: string, args: Record<string, unknown>, expected: Selection | null = null) {
    const epoch = this.#epoch;
    const requestId = ++this.#nextRequest;
    this.#requests.set(operation, requestId);
    this.rows.delete(operation);
    const selection = requestSelection(operation, args, expected ?? {});
    let response: ControlResponse;
    try {
      response = await this.#invoke<ControlResponse>('desktop_control', {
        input: { request: { operation, args }, selection },
      });
    } catch (error) {
      if (!this.#current(operation, requestId, epoch)) return null;
      throw error;
    }
    const current = this.#current(operation, requestId, epoch);
    // A superseded mutation can still have changed daemon state. Validate its binding and invalidate,
    // but never publish its reply or errors as the current selection.
    if (!current && !invalidating.has(operation)) return null;
    if (selection && (!response.association || !sameSelection(selection, response.association))) {
      if (!current) return null;
      throw new Error('SCOPE_MISMATCH');
    }
    if (response.result.operation !== operation) {
      if (!current) return null;
      throw new Error('OPERATION_MISMATCH');
    }
    if (invalidating.has(operation)) {
      this.#epoch++;
      this.rows.clear();
    }
    if (!current) return null;
    if (this.#generation !== undefined && this.#generation !== response.generation) this.reconnect();
    this.#generation = response.generation;
    this.rows.set(operation, response.result);
    return response.result;
  }
  async approval(approvalId: string, digest: string, typedResponse: string | null) {
    const epoch = this.#epoch;
    const requestId = ++this.#nextRequest;
    this.#requests.set('approvalView', requestId);
    this.rows.delete('approvalView');
    let result: SafeAppResult;
    try {
      result = await this.#invoke<SafeAppResult>('desktop_approve', {
        input: { approvalId, digest, typedResponse },
      });
    } catch (error) {
      if (!this.#current('approvalView', requestId, epoch)) return null;
      throw error;
    }
    if (!this.#current('approvalView', requestId, epoch)) return null;
    if (result.approval && (result.approval.approvalId !== approvalId || result.approval.digest !== digest))
      throw new Error('SCOPE_MISMATCH');
    this.rows.set('approvalView', result);
    return result;
  }
}

function sameSelection(expected: Selection, actual: Selection) {
  return (
    Object.keys(expected).length === Object.keys(actual).length &&
    Object.entries(expected).every(([field, value]) => sameScopeValue(actual[field], value))
  );
}

function sameScopeValue(actual: ScopeValue | undefined, expected: ScopeValue) {
  if (Array.isArray(actual) || Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
    );
  return actual === expected;
}

const directIdentityFields = new Set([
  'id',
  'objectId',
  'type',
  'version',
  'source',
  'accountId',
  'ruleId',
  'ruleVersion',
  'targetId',
  'targetVersion',
  'subscriberId',
  'deliveryId',
  'eventId',
  'judgeId',
  'budgetId',
]);
const documentIdFields = ['ruleId', 'targetId', 'subscriberId', 'judgeId', 'budgetId'] as const;

function isScopeValue(value: unknown): value is ScopeValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

/** Mirrors Rust's schema-closed request scope: document ids remain bound to their nested identity and result object. */
function scopeForRequest(args: Record<string, unknown>): Selection {
  const scope: Selection = {};
  for (const [field, value] of Object.entries(args)) {
    if (field === 'document' && value && typeof value === 'object' && !Array.isArray(value)) {
      const document = value as Record<string, unknown>;
      const idField = documentIdFields.find((candidate) => typeof document[candidate] === 'string');
      if (idField) {
        scope.objectId = document[idField] as string;
        scope[`document.${idField}`] = document[idField] as string;
      }
      if (typeof document.version === 'number') {
        scope.version = document.version;
        scope['document.version'] = document.version;
      }
      const source = document.source;
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        const sourceRecord = source as Record<string, unknown>;
        if (typeof sourceRecord.channel === 'string') scope['document.source.channel'] = sourceRecord.channel;
        if (isScopeValue(sourceRecord.accountIds)) scope['document.source.accountIds'] = sourceRecord.accountIds;
      }
      continue;
    }
    if (directIdentityFields.has(field) && isScopeValue(value)) scope[field] = value;
  }
  return scope;
}

export function requestSelection(
  _operation: string,
  args: Record<string, unknown>,
  expected: Selection = {},
): Selection | null {
  const selection = scopeForRequest(args);
  for (const [field, value] of Object.entries(expected)) {
    if (field in selection && !sameScopeValue(selection[field], value)) throw new Error('SCOPE_MISMATCH');
    selection[field] = value;
  }
  return Object.keys(selection).length ? selection : null;
}
