// Scanned as src/identity/event-id.ts.
// Refused: the same call in any other file.
export const digest = (bytes: Uint8Array): Promise<ArrayBuffer> => globalThis.crypto.subtle.digest('SHA-256', bytes);
