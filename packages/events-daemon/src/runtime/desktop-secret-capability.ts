import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type B3SecretCapabilityUnavailableV1,
  isB3ControlOperation,
  isB3SecretOperation,
} from '../operations/b3-contract.ts';

export const DESKTOP_SECRET_UNAVAILABLE: B3SecretCapabilityUnavailableV1 = Object.freeze({
  kind: 'unavailable',
  code: 'APP_SECRET_CAPABILITY_UNAVAILABLE',
});

/** Internal owner authority, never part of the CLI/MCP operation registry or a persisted record. */
export class DesktopSecretAuthority {
  readonly #key: Buffer;
  readonly #nonces = new Map<string, { session: string; operation: string; expires: number }>();

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error('invalid desktop capability key');
    this.#key = Buffer.from(key);
  }

  issue(session: string, operation: unknown): unknown {
    if (typeof operation !== 'string' || !isB3ControlOperation(operation) || !isB3SecretOperation(operation))
      return DESKTOP_SECRET_UNAVAILABLE;
    const now = Date.now();
    for (const [nonce, pending] of this.#nonces) {
      if (pending.expires <= now || pending.session === session) this.#nonces.delete(nonce);
    }
    if (this.#nonces.size >= 128) return DESKTOP_SECRET_UNAVAILABLE;
    const nonce = randomBytes(32).toString('hex');
    this.#nonces.set(nonce, { session, operation, expires: now + 60_000 });
    return { nonce };
  }

  consume(session: string, operation: string, proof: unknown): boolean {
    // Read and consume a supplied nonce before validating any other proof field. A malformed proof that names an
    // issued nonce is still an attempt, never an opportunity to retry that nonce with a corrected proof.
    const candidateNonce = (proof as { readonly nonce?: string } | null | undefined)?.nonce ?? '';
    const pending = this.#nonces.get(candidateNonce);
    this.#nonces.delete(candidateNonce);
    if (typeof proof !== 'object' || proof === null) return false;
    const { nonce, mac } = proof as Record<string, unknown>;
    if (typeof nonce !== 'string' || typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac)) return false;
    if (!pending || pending.expires <= Date.now()) return false;
    if (pending.session !== session || pending.operation !== operation) return false;
    const expected = createHmac('sha256', this.#key)
      .update(session + operation + nonce)
      .digest();
    const received = Buffer.from(mac, 'hex');
    try {
      return timingSafeEqual(expected, received);
    } finally {
      expected.fill(0);
      received.fill(0);
    }
  }

  cancel(session: string): void {
    for (const [nonce, pending] of this.#nonces) if (pending.session === session) this.#nonces.delete(nonce);
  }

  close(): void {
    this.#nonces.clear();
    this.#key.fill(0);
  }
}
