// Scanned as src/identity/sha256.ts.
// Refused: anything of WebCrypto but subtle.digest, even in the file that may reach it.
export const noise = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(16));
