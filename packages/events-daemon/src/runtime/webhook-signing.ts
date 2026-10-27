import { createHmac } from 'node:crypto';
import { CommsError } from '@agentcomms/core';

export interface StandardWebhookSigningInput {
  readonly id: string;
  readonly timestamp: number;
  /** The byte-stable structured CloudEvent representation prepared before this delivery boundary. */
  readonly body: string;
  readonly current: string;
  readonly overlap: readonly string[];
}

function isStandardSecret(secret: string): boolean {
  if (!secret.startsWith('whsec_')) return false;
  const encoded = secret.slice('whsec_'.length);
  const key = Buffer.from(encoded, 'base64');
  return key.byteLength > 0 && key.toString('base64') === encoded;
}

function signingKey(secret: string): Buffer {
  if (!isStandardSecret(secret)) {
    throw new CommsError('BAD_DATA', 'the webhook signing secret has an unsupported format');
  }
  return Buffer.from(secret.slice('whsec_'.length), 'base64');
}

function signature(secret: string, id: string, timestamp: string, body: string): string {
  return createHmac('sha256', signingKey(secret)).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64');
}

/** Builds exactly the Standard Webhooks signature headers without retaining or exposing any secret material. */
export function signStandardWebhook(input: StandardWebhookSigningInput): Readonly<Record<string, string>> {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new CommsError('BAD_DATA', 'the webhook timestamp is invalid');
  }
  if (input.id.length === 0) throw new CommsError('BAD_DATA', 'the webhook id is invalid');
  const timestamp = String(input.timestamp);
  // A previous generation that could never sign — every secret made before 0.36.0 was base64url — is left out, so
  // rotating away from one signs at once instead of failing for its overlap. The current one must sign.
  const signatures = [input.current, ...input.overlap.filter(isStandardSecret)].map(
    (secret) => `v1,${signature(secret, input.id, timestamp, input.body)}`,
  );
  return {
    'webhook-id': input.id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signatures.join(' '),
  };
}
