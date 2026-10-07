const AAD_PREFIX = Buffer.from('aec-v1', 'ascii');

const PRIMARY_KEY_COMPONENT_COUNTS = {
  'source_scan_state.encryptedRecord': 1,
  'rule_activation_points.encryptedPosition': 5,
  'activation_baselines.encryptedPosition': 4,
  'ingest_rules.encryptedProjection': 3,
  'decisions.encryptedRecord': 1,
  'deliveries.encryptedRecord': 1,
  'dryrun_log.encryptedRecord': 1,
} as const;

export type AadComponent =
  | { readonly type: 'integer'; readonly value: number | bigint }
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'blob'; readonly value: Uint8Array };

export class AadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AadError';
  }
}

function lengthPrefixed(value: Uint8Array): Buffer {
  if (value.byteLength > 0xffffffff) throw new AadError('AAD value is too large to encode');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.byteLength);
  return Buffer.concat([length, value]);
}

function integerBytes(value: number | bigint): Buffer {
  const integer = typeof value === 'bigint' ? value : BigInt(value);
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || !Number.isInteger(value))) {
    throw new AadError('AAD INTEGER must be a safe integer or bigint');
  }
  if (integer < -(1n << 63n) || integer > (1n << 63n) - 1n) {
    throw new AadError('AAD INTEGER is outside SQLite’s signed 64-bit range');
  }
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigInt64BE(integer);
  return encoded;
}

function componentBytes(component: AadComponent): Buffer {
  switch (component.type) {
    case 'integer':
      return Buffer.concat([Buffer.from([0x01]), integerBytes(component.value)]);
    case 'text':
      return Buffer.concat([Buffer.from([0x02]), lengthPrefixed(Buffer.from(component.value, 'utf8'))]);
    case 'blob':
      return Buffer.concat([Buffer.from([0x03]), lengthPrefixed(Buffer.from(component.value))]);
  }
}

/**
 * Encodes the one AAD form every encrypted event record uses.
 *
 * Components must arrive in the primary-key order declared by the migration. The table/column map intentionally
 * lives here as well as in the schema, so a caller cannot silently encrypt an unsupported column or omit one part
 * of its row identity.
 */
export function encodeAad(table: string, column: string, components: readonly AadComponent[]): Buffer {
  const id = `${table}.${column}` as keyof typeof PRIMARY_KEY_COMPONENT_COUNTS;
  const expected = PRIMARY_KEY_COMPONENT_COUNTS[id];
  if (expected === undefined) throw new AadError(`no encrypted event column is named ${id}`);
  if (components.length !== expected) {
    throw new AadError(`${id} needs ${expected} primary-key components, got ${components.length}`);
  }
  return Buffer.concat([
    AAD_PREFIX,
    lengthPrefixed(Buffer.from(table, 'utf8')),
    lengthPrefixed(Buffer.from(column, 'utf8')),
    Buffer.from([components.length]),
    ...components.map(componentBytes),
  ]);
}

export const ENCRYPTED_EVENT_COLUMNS: Readonly<Record<string, number>> = Object.freeze({
  ...PRIMARY_KEY_COMPONENT_COUNTS,
});
