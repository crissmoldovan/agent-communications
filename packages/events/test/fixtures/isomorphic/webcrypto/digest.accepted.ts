// Scanned as src/identity/sha256.ts.
// Accepted: the one exemption, WebCrypto's SHA-256, reached as exactly globalThis.crypto.subtle.digest.
interface WebCrypto {
  readonly crypto: { readonly subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> } };
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await (globalThis as unknown as WebCrypto).crypto.subtle.digest('SHA-256', bytes));
}
