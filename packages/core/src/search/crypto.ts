import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { CommsError } from '../errors.ts';
import { withFileLock } from '../lock.ts';
import type { SecretStore } from '../secrets.ts';

/**
 * What Search keeps of a message's words, encrypted (design 2026-10-26-local-search, S11): AES-256-GCM, in the event
 * service's packed record format v1 (`events-daemon/src/store/crypto.ts`, copied: core cannot depend on it) —
 * `[1][key id length][key id][96-bit nonce][ciphertext][128-bit tag]` — under a key per purpose derived from one master
 * with HKDF-SHA256, and bound to its row by its additional data, so a record moved to another row does not open.
 *
 * The master is `search-index` in the configured secret store — the Keychain on macOS — as `{ v, keyId, key }`. It is
 * made when Search is first switched on (or first needed while on), under a lock so two processes cannot each make
 * one, and deleted by Delete everything: whatever copy of the folder is left anywhere then opens for nobody.
 *
 * The words index holds no word: each is an HMAC under the `words` subkey (`words.ts`), so full-text search reads
 * tokens nobody can turn back into words without the key. What is not encrypted, and cannot be: the vectors (a scan must
 * read them) and the handles (lookups need them). The screens and doctor say so.
 */

export const SEARCH_KEY_REF = 'search-index';

const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^sk-[0-9a-f]{16}$/;

/** The master, as read from the secret store. Never written anywhere else, never printed. */
export interface SearchKey {
  readonly keyId: string;
  readonly key: Buffer;
}

/**
 * What each subkey is for: the inbox's lines, a message's record, a person's label, a handle's latest name — and the
 * keyed hashes the words index holds in place of words (`words`, which hashes and never seals).
 */
export type SearchKeyPurpose = 'inbox' | 'messages' | 'people' | 'handles' | 'words';

/** A purpose's subkey, from the master. */
export function searchSubkey(master: SearchKey, purpose: SearchKeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', master.key, Buffer.alloc(0), `agentcomms-search/${purpose}/v1`, 32));
}

/** One record, sealed for `aad` under `purpose`'s subkey. */
export function sealSearchRecord(
  master: SearchKey,
  purpose: SearchKeyPurpose,
  aad: string,
  plaintext: string | Uint8Array,
): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const keyId = Buffer.from(master.keyId, 'ascii');
  const cipher = createCipheriv('aes-256-gcm', searchSubkey(master, purpose), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(`${purpose}\0${aad}`, 'utf8'));
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([
    Buffer.from([FORMAT_VERSION, keyId.byteLength]),
    keyId,
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ]);
}

/**
 * A record opened, or a refusal: BAD_DATA for a record that is not one, or did not authenticate for this row; CONFIG
 * for one sealed under another master — one Delete everything has deleted, or another machine's.
 */
export function openSearchRecord(
  master: SearchKey,
  purpose: SearchKeyPurpose,
  aad: string,
  record: Uint8Array,
): Buffer {
  const bytes = Buffer.from(record);
  if (bytes.byteLength < 2 + NONCE_BYTES + TAG_BYTES + 1 || bytes[0] !== FORMAT_VERSION) {
    throw new CommsError('BAD_DATA', 'a kept record is not one Search wrote');
  }
  const keyIdLength = bytes[1] ?? 0;
  const nonceStart = 2 + keyIdLength;
  const ciphertextStart = nonceStart + NONCE_BYTES;
  const tagStart = bytes.byteLength - TAG_BYTES;
  if (keyIdLength === 0 || ciphertextStart > tagStart) {
    throw new CommsError('BAD_DATA', 'a kept record is not one Search wrote');
  }
  const keyId = bytes.subarray(2, nonceStart).toString('ascii');
  if (keyId !== master.keyId) {
    throw new CommsError('CONFIG', 'a kept record was sealed with a key this machine no longer has', {
      details: { reason: 'SEARCH_KEY_UNKNOWN' },
    });
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      searchSubkey(master, purpose),
      bytes.subarray(nonceStart, ciphertextStart),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(Buffer.from(`${purpose}\0${aad}`, 'utf8'));
    decipher.setAuthTag(bytes.subarray(tagStart));
    return Buffer.concat([decipher.update(bytes.subarray(ciphertextStart, tagStart)), decipher.final()]);
  } catch {
    throw new CommsError('BAD_DATA', 'a kept record did not open for its row');
  }
}

/** The master as the secret store holds it, or null when there is none — or when what is there is not one. */
export async function readSearchKey(store: SecretStore): Promise<SearchKey | null> {
  const raw = await store.get(SEARCH_KEY_REF);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; keyId?: unknown; key?: unknown };
    if (parsed.v !== 1 || typeof parsed.keyId !== 'string' || !KEY_ID.test(parsed.keyId)) return null;
    const key = typeof parsed.key === 'string' ? Buffer.from(parsed.key, 'base64') : Buffer.alloc(0);
    return key.byteLength === 32 ? { keyId: parsed.keyId, key } : null;
  } catch {
    return null;
  }
}

/**
 * The master, made now when there is none: 32 random bytes and a random id, written once under `lockPath`, so two
 * processes that both find none make one between them.
 */
export async function ensureSearchKey(store: SecretStore, lockPath: string): Promise<SearchKey> {
  const held = await readSearchKey(store);
  if (held !== null) return held;
  return withFileLock(lockPath, async () => {
    store.invalidate(SEARCH_KEY_REF);
    const again = await readSearchKey(store);
    if (again !== null) return again;
    const made: SearchKey = { keyId: `sk-${randomBytes(8).toString('hex')}`, key: randomBytes(32) };
    await store.set(SEARCH_KEY_REF, JSON.stringify({ v: 1, keyId: made.keyId, key: made.key.toString('base64') }));
    return made;
  });
}

const REAL_HOME_ATTEMPTS = Symbol.for('agentcomms.test.real-home-attempts.v1');

/**
 * The secret store Search's key is in: the configured one. Under test (`AGENTCOMMS_TEST_NO_REAL_HOME=1`, which the test
 * preload sets) the system keychain is refused loudly and counted, as the real-home guard counts a real home: a test
 * that forgot its own store fails, rather than writing a key into the person's keychain.
 */
export async function searchSecretStore(core: { secrets(): Promise<SecretStore> }): Promise<SecretStore> {
  const store = await core.secrets();
  if (store.kind === 'keychain' && process.env.AGENTCOMMS_TEST_NO_REAL_HOME === '1') {
    const attempts = globalThis as unknown as Record<symbol, string[] | undefined>;
    attempts[REAL_HOME_ATTEMPTS] ??= [];
    attempts[REAL_HOME_ATTEMPTS].push("the system keychain, for Search's key");
    throw new Error(
      "under test, Search's key would have been kept in the system keychain: give the test a secret store",
    );
  }
  return store;
}

/** Deletes the master. True when there was one. */
export async function deleteSearchKey(store: SecretStore): Promise<boolean> {
  const removed = await store.delete(SEARCH_KEY_REF);
  store.invalidate(SEARCH_KEY_REF);
  return removed;
}
