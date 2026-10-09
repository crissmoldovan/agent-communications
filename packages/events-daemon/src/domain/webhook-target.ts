import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { assertApprovedAddressSet } from '../network/address-policy.ts';
import { validateLocalEndpoint } from '../network/local-endpoint.ts';
import type { DeliveryTarget } from '../runtime/target-delivery.ts';
import { EventDomainError } from './lifecycle.ts';

export interface PlainWebhookUrl {
  readonly kind: 'plain';
  readonly value: string;
}

export interface SecretWebhookUrl {
  readonly kind: 'secret';
  readonly scheme: 'http' | 'https';
  readonly host: string;
  readonly port: number;
  readonly sha256: string;
}

export interface WebhookTargetDocument {
  readonly targetId: string;
  readonly version: number;
  readonly kind: 'webhook';
  readonly url: PlainWebhookUrl | SecretWebhookUrl;
  readonly approvedAddressSet: readonly string[];
  readonly signing: 'standard-webhooks';
  readonly ordering: 'strict';
  readonly retryLimit: number;
  readonly representation: 'plain' | 'enveloped';
}

function fail(message: string): never {
  throw new EventDomainError('VERSION_DOCUMENT_INVALID', message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(`${name} is an object`);
  try {
    return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  } catch {
    return fail(`${name} is canonical JSON`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) return fail(`${name} is a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail(`${name} is a positive safe integer`);
  return value as number;
}

function canonicalPercentEscapes(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, (encoded) => encoded.toUpperCase());
}

function canonicalUrl(
  value: string,
  allowQuery: boolean,
): { readonly value: string; readonly authority: Omit<SecretWebhookUrl, 'kind' | 'sha256'> } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('a webhook URL is absolute');
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (scheme !== 'http' && scheme !== 'https') return fail('a webhook URL uses http or https');
  if (parsed.hash.length !== 0) return fail('a webhook URL has no fragment');
  if (!allowQuery && (parsed.username.length !== 0 || parsed.password.length !== 0 || parsed.search.length !== 0)) {
    return fail('a plain webhook URL has no userinfo or query');
  }
  const port = parsed.port.length === 0 ? (scheme === 'https' ? 443 : 80) : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return fail('a webhook URL has a valid port');
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return fail('a webhook URL has a host');
  const userinfo =
    allowQuery && (parsed.username.length !== 0 || parsed.password.length !== 0)
      ? `${canonicalPercentEscapes(parsed.username)}${parsed.password.length === 0 ? '' : `:${canonicalPercentEscapes(parsed.password)}`}@`
      : '';
  const bracketedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const path = canonicalPercentEscapes(parsed.pathname);
  const query = allowQuery ? canonicalPercentEscapes(parsed.search) : '';
  return {
    value: `${scheme}://${userinfo}${bracketedHost}:${port}${path}${query}`,
    authority: { scheme, host, port } as Omit<SecretWebhookUrl, 'kind' | 'sha256'>,
  };
}

/** Canonicalises the complete hidden URL only for the daemon's secret-store factory. */
export function secretWebhookUrlDescriptor(value: string): SecretWebhookUrl {
  const canonical = canonicalUrl(value, true);
  return { kind: 'secret', ...canonical.authority, sha256: sha256Hex(canonical.value) };
}

/** Produces the private stored URL and its public descriptor together; callers return only the descriptor. */
export function canonicalSecretWebhookUrl(value: string): {
  readonly value: string;
  readonly descriptor: SecretWebhookUrl;
} {
  const canonical = canonicalUrl(value, true);
  return {
    value: canonical.value,
    descriptor: { kind: 'secret', ...canonical.authority, sha256: sha256Hex(canonical.value) },
  };
}

function canonicalAddressSet(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return fail('a webhook approvedAddressSet is a non-empty array');
  const addresses = value.map((entry) => text(entry, 'a webhook approvedAddressSet entry'));
  const sorted = [...addresses].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((entry, index) => entry !== addresses[index])) {
    return fail('a webhook approvedAddressSet is sorted and duplicate-free');
  }
  return sorted;
}

function canonicalUrlDescriptor(value: unknown): PlainWebhookUrl | SecretWebhookUrl {
  const url = record(value, 'a webhook URL descriptor');
  if (url.kind === 'plain') {
    const canonical = canonicalUrl(text(url.value, 'a plain webhook URL'), false);
    return { kind: 'plain', value: canonical.value };
  }
  if (url.kind === 'secret') {
    const scheme = text(url.scheme, 'a secret webhook scheme');
    if (scheme !== 'http' && scheme !== 'https') return fail('a secret webhook scheme is http or https');
    const host = text(url.host, 'a secret webhook host').toLowerCase();
    const port = positiveInteger(url.port, 'a secret webhook port');
    if (port > 65_535) return fail('a secret webhook port is at most 65535');
    const bracketedHost = host.includes(':') ? `[${host}]` : host;
    const authority = canonicalUrl(`${scheme}://${bracketedHost}:${port}/`, false).authority;
    if (authority.scheme !== scheme || authority.host !== host || authority.port !== port) {
      return fail('a secret webhook authority is canonical');
    }
    const sha256 = text(url.sha256, 'a secret webhook fingerprint');
    if (!/^[a-f0-9]{64}$/.test(sha256)) return fail('a secret webhook fingerprint is lowercase SHA-256');
    return { kind: 'secret', scheme, host, port, sha256 };
  }
  return fail('a webhook URL descriptor has a known kind');
}

/** The canonical immutable webhook target contains public authority only, never a slot or complete secret URL. */
export function canonicalWebhookTarget(value: unknown): WebhookTargetDocument {
  const target = record(value, 'a webhook target document');
  if (target.kind !== 'webhook') return fail('a webhook target document has kind webhook');
  if (target.signing !== 'standard-webhooks') return fail('a webhook target uses standard-webhooks signing');
  if (target.ordering !== 'strict') return fail('a webhook target uses strict delivery ordering');
  const retryLimit = positiveInteger(target.retryLimit, 'a webhook retry limit');
  if (retryLimit > 20) return fail('a webhook retry limit is at most 20');
  if (target.representation !== 'plain' && target.representation !== 'enveloped') {
    return fail('a webhook representation is plain or enveloped');
  }
  const url = canonicalUrlDescriptor(target.url);
  const approvedAddressSet = canonicalAddressSet(target.approvedAddressSet);
  try {
    assertApprovedAddressSet(approvedAddressSet);
    if (url.kind === 'plain' && url.value.startsWith('http:')) {
      validateLocalEndpoint(url.value, approvedAddressSet);
    }
    if (url.kind === 'secret' && url.scheme === 'http') {
      const host = url.host.includes(':') ? `[${url.host}]` : url.host;
      validateLocalEndpoint(`http://${host}:${url.port}/`, approvedAddressSet);
    }
  } catch {
    return fail('a webhook target has an approved network authority');
  }
  return {
    targetId: text(target.targetId, 'a webhook target id'),
    version: positiveInteger(target.version, 'a webhook target version'),
    kind: 'webhook',
    url,
    approvedAddressSet,
    signing: 'standard-webhooks',
    ordering: 'strict',
    retryLimit,
    representation: target.representation,
  };
}

/** Maps an already canonical document to Task 2's closed delivery union without rebuilding delivery bytes. */
export function webhookDeliveryTarget(document: WebhookTargetDocument): DeliveryTarget {
  return {
    kind: 'webhook',
    targetId: document.targetId,
    targetVersion: document.version,
    representation: document.representation,
  };
}
