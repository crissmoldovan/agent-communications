/**
 * SHA-256 through WebCrypto: the one host capability the library uses (events phase A plan, decision 23).
 *
 * `globalThis.crypto.subtle.digest('SHA-256', …)` is there in Node 22 and in every browser's secure context, the
 * desktop app's own origin included, so event identity needs no Node module and no hash of its own. This file is the
 * only one the isomorphism guard lets reach it, and only as exactly that call (`test/isomorphic.test.ts`).
 */

/** The part of WebCrypto this file uses, typed here: the library compiles with no DOM and no Node types. */
interface WebCrypto {
  readonly crypto: {
    readonly subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
  };
}

/** The SHA-256 digest of `bytes`: 32 bytes. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await (globalThis as unknown as WebCrypto).crypto.subtle.digest('SHA-256', bytes));
}
