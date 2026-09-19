import type { CommsError } from './errors.ts';

/** Version of the JSON envelope shape. Bump only on a breaking change to `ok`, `data` or `error`. */
export const SCHEMA_VERSION = 1;

export interface OkEnvelope<T> {
  ok: true;
  schemaVersion: typeof SCHEMA_VERSION;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  schemaVersion: typeof SCHEMA_VERSION;
  error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

export type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;

export function okEnvelope<T>(data: T): OkEnvelope<T> {
  return { ok: true, schemaVersion: SCHEMA_VERSION, data };
}

export function errorEnvelope(error: CommsError): ErrorEnvelope {
  const body: ErrorEnvelope['error'] = { code: error.code, message: error.message };
  if (error.hint !== undefined) body.hint = error.hint;
  if (error.details !== undefined) body.details = error.details;
  return { ok: false, schemaVersion: SCHEMA_VERSION, error: body };
}
