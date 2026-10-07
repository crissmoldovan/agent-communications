import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type PackedRecordErrorCode = 'PACKED_RECORD_INVALID' | 'UNKNOWN_KEY' | 'AUTHENTICATION_FAILED';

export class PackedRecordError extends Error {
  readonly code: PackedRecordErrorCode;

  constructor(code: PackedRecordErrorCode, message: string) {
    super(message);
    this.name = 'PackedRecordError';
    this.code = code;
  }
}

export interface EncryptPackedRecordInput {
  readonly keyId: string;
  readonly key: Uint8Array;
  readonly aad: Uint8Array;
  readonly plaintext: Uint8Array;
  readonly nonce?: Uint8Array | undefined;
}

export interface DecryptPackedRecordInput {
  readonly record: Uint8Array;
  readonly keyForId: (keyId: string) => Uint8Array | null;
  readonly aad: Uint8Array;
}

function checkedKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new PackedRecordError('PACKED_RECORD_INVALID', 'AES-256-GCM needs a 32-byte key');
  return Buffer.from(key);
}

function checkedKeyId(keyId: string): Buffer {
  const encoded = Buffer.from(keyId, 'ascii');
  if (keyId.length === 0 || keyId.length > 255 || encoded.toString('ascii') !== keyId) {
    throw new PackedRecordError(
      'PACKED_RECORD_INVALID',
      'packed record key identifiers are non-empty ASCII of at most 255 bytes',
    );
  }
  return encoded;
}

function unpack(record: Uint8Array): { keyId: string; nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const bytes = Buffer.from(record);
  if (bytes.byteLength < 1 + 1 + 1 + NONCE_BYTES + TAG_BYTES || bytes[0] !== FORMAT_VERSION) {
    throw new PackedRecordError('PACKED_RECORD_INVALID', 'encrypted record is not packed record format v1');
  }
  const keyIdLength = bytes[1] ?? 0;
  const keyStart = 2;
  const nonceStart = keyStart + keyIdLength;
  const ciphertextStart = nonceStart + NONCE_BYTES;
  const tagStart = bytes.byteLength - TAG_BYTES;
  if (keyIdLength === 0 || ciphertextStart > tagStart) {
    throw new PackedRecordError('PACKED_RECORD_INVALID', 'encrypted record has invalid packed boundaries');
  }
  const keyIdBytes = bytes.subarray(keyStart, nonceStart);
  const keyId = keyIdBytes.toString('ascii');
  if (keyIdBytes.toString('ascii') !== keyId || !/^[\x21-\x7e]+$/.test(keyId)) {
    throw new PackedRecordError('PACKED_RECORD_INVALID', 'encrypted record has a non-ASCII key identifier');
  }
  return {
    keyId,
    nonce: bytes.subarray(nonceStart, ciphertextStart),
    ciphertext: bytes.subarray(ciphertextStart, tagStart),
    tag: bytes.subarray(tagStart),
  };
}

/** Packs AES-256-GCM ciphertext exactly as D8 record format v1. */
export function encryptPackedRecord(input: EncryptPackedRecordInput): Buffer {
  const keyId = checkedKeyId(input.keyId);
  const key = checkedKey(input.key);
  const nonce = input.nonce === undefined ? randomBytes(NONCE_BYTES) : Buffer.from(input.nonce);
  if (nonce.byteLength !== NONCE_BYTES) {
    throw new PackedRecordError('PACKED_RECORD_INVALID', 'packed record nonces must be 96 bits');
  }
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(input.aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(input.plaintext)), cipher.final()]);
  return Buffer.concat([
    Buffer.from([FORMAT_VERSION, keyId.byteLength]),
    keyId,
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ]);
}

/** Opens one packed record and refuses a missing key, malformed record, or an authentication mismatch. */
export function decryptPackedRecord(input: DecryptPackedRecordInput): Buffer {
  const parsed = unpack(input.record);
  const selected = input.keyForId(parsed.keyId);
  if (selected === null) throw new PackedRecordError('UNKNOWN_KEY', 'encrypted record names an unavailable master key');
  try {
    const decipher = createDecipheriv('aes-256-gcm', checkedKey(selected), parsed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(input.aad));
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  } catch (error) {
    if (error instanceof PackedRecordError) throw error;
    throw new PackedRecordError('AUTHENTICATION_FAILED', 'encrypted record did not authenticate for its declared row');
  }
}

/** Reads only the identifier from a syntactically valid packed record, before its master is looked up asynchronously. */
export function packedRecordKeyId(record: Uint8Array): string {
  return unpack(record).keyId;
}

/** Derives the prescribed table subkey from one installation master without putting the key id in HKDF info. */
export function deriveTableKey(master: Uint8Array, table: string): Buffer {
  return Buffer.from(hkdfSync('sha256', checkedKey(master), Buffer.alloc(0), `agentcomms-events/${table}/v1`, 32));
}

export const PACKED_RECORD_FORMAT_VERSION: number = FORMAT_VERSION;
export const PACKED_RECORD_NONCE_BYTES: number = NONCE_BYTES;
