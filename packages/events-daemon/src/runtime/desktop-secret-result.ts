import { isB3ControlOperation, isB3SecretOperation } from '../operations/b3-contract.ts';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid desktop secret result');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('invalid desktop secret fields');
}

/** Validate the actual core envelope before projecting D2's flat logical record. Never hide unexpected fields. */
export function projectDesktopSecretAudit(value: unknown): Record<string, unknown> {
  const row = record(value);
  keys(row, ['at', 'inboxId', 'operation', 'outcome', 'ids', 'reason']);
  const operation = typeof row.operation === 'string' ? row.operation.replace(/^events\./, '') : '';
  if (
    row.operation !== `events.${operation}` ||
    !isB3ControlOperation(operation) ||
    !isB3SecretOperation(operation) ||
    row.inboxId !== '' ||
    typeof row.at !== 'string' ||
    !Number.isFinite(Date.parse(row.at)) ||
    !['ok', 'failed', 'refused'].includes(String(row.outcome)) ||
    (row.reason !== undefined && (row.outcome !== 'refused' || row.reason !== 'APP_SECRET_CAPABILITY_UNAVAILABLE'))
  ) {
    throw new Error('invalid desktop secret audit');
  }
  const projected: Record<string, unknown> = { operation, outcome: row.outcome, time: row.at };
  if (row.ids !== undefined) {
    const ids = record(row.ids);
    const idKey = operation.startsWith('target')
      ? 'targetId'
      : operation.startsWith('subscriber')
        ? 'subscriberId'
        : 'judgeId';
    keys(ids, [idKey, 'version']);
    if (
      operation === 'migrateSecrets' ||
      typeof ids[idKey] !== 'string' ||
      ids[idKey].length === 0 ||
      (ids.version !== undefined && (typeof ids.version !== 'string' || !/^[1-9][0-9]*$/.test(ids.version)))
    ) {
      throw new Error('invalid desktop secret identity');
    }
    projected.id = ids[idKey];
    if (ids.version !== undefined) projected.version = Number(ids.version);
  }
  return projected;
}

/** App-only serialization after the owner consumed the proof and durably appended its validated audit row. */
export function desktopSecretResult(operation: string, result: unknown): unknown {
  const value = record(result);
  if (
    ['targetSecretCreate', 'targetSecretRotate', 'subscriberTokenCreate', 'subscriberTokenRotate'].includes(operation)
  ) {
    keys(value, ['receipt', 'terminalReveal']);
    if (typeof value.terminalReveal !== 'string' || value.terminalReveal.length === 0)
      throw new Error('missing one-time material');
    const material = value.terminalReveal;
    delete value.terminalReveal;
    return { kind: 'RevealOnce', material };
  }
  if (operation === 'targetUrlSet') {
    keys(value, ['scheme', 'host', 'port', 'sha256']);
    return { kind: 'UrlFingerprint', scheme: value.scheme, host: value.host, port: value.port, sha256: value.sha256 };
  }
  if (operation === 'migrateSecrets') {
    keys(value, ['moved', 'leftovers', 'code']);
    return { kind: 'MigrationStatus', ...value };
  }
  keys(value, ['kind', 'judgeId', 'version', 'generation']);
  return { kind: 'Acknowledgement' };
}
