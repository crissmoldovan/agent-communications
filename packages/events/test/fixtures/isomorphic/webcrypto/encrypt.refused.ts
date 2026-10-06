// Scanned as src/identity/sha256.ts.
// Refused: crypto by its bare name, and any member of subtle but digest.
export const seal = (key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer> =>
  crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, data);
