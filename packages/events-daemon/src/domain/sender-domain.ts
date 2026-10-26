import { catalogueEntry, getPointer, type JsonValue, toAsciiDomain } from '@agentcomms/events';

/**
 * The domain of a message's sender address, for Analyse's per-domain counts (0.33.0 design §3.3): what a judge said of
 * each sending domain, never of a person. Only the domain is kept, and only inside the decision's encrypted judge
 * metadata, which goes when the rule's decision metadata does.
 *
 * A domain is taken only when it is already a plain ASCII hostname — lowercase letters, digits, hyphens and dots, as
 * the `domainIs` condition compares it — so what is kept can carry no markup, no space and no other text. Anything else
 * (no From address, a Slack or WhatsApp event, an internationalised or odd form) gives null, and nothing is kept.
 */

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`, 'u');
const SENDER_ADDRESS = '/from/address';

/** Whether `value` is a domain as Analyse keeps one: a plain lowercase ASCII hostname of two labels or more. */
export function isKeptSenderDomain(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 253 || !HOSTNAME.test(value)) return false;
  const ascii = toAsciiDomain(value);
  return ascii.ok && ascii.value === value;
}

/**
 * The sender's domain from a rule's projected event, when the event type has a From address, the projection kept it
 * (the rule tests or keeps `from.address`) and its domain is plain; null otherwise.
 */
export function senderDomainOf(
  eventType: string,
  eventVersion: number,
  event: Readonly<Record<string, unknown>>,
): string | null {
  const definition = catalogueEntry(eventType, eventVersion);
  if (!definition.ok) return null;
  const hasSender = definition.value.addresses.some(
    (pattern) => pattern.length === 2 && pattern[0] === 'from' && pattern[1] === 'address',
  );
  if (!hasSender) return null;
  const found = getPointer(event as JsonValue, SENDER_ADDRESS);
  if (!found.found || typeof found.value !== 'string') return null;
  const at = found.value.lastIndexOf('@');
  if (at < 1) return null;
  const domain = found.value.slice(at + 1);
  return isKeptSenderDomain(domain) ? domain : null;
}

/** A judged decision's metadata with its sender's domain beside the judge's answer, when there is one to keep. */
export function withSenderDomain(
  metadata: Readonly<Record<string, unknown>>,
  rule: { readonly event: { readonly type: string; readonly version: number } },
  event: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const senderDomain = senderDomainOf(rule.event.type, rule.event.version, event);
  return senderDomain === null ? metadata : { ...metadata, senderDomain };
}
