/** Durable boundaries where the webhook crash matrix stops an owner. */
export const WEBHOOK_CRASH_POINTS = [
  'before-claim',
  'after-claim',
  'after-dns',
  'after-tcp',
  'after-tls',
  'after-write',
  'after-response',
  'after-outcome',
] as const;

export type WebhookCrashPoint = (typeof WEBHOOK_CRASH_POINTS)[number];
