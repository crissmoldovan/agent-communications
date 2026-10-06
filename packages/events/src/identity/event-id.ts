/**
 * Event identity, exactly as D3 defines it (design 2026-10-05, D3; events phase A plan, decision 23).
 *
 * An event's id is the first 32 lowercase hexadecimal characters of SHA-256 over the UTF-8 bytes of core's canonical
 * JSON for `["agentcomms-event-v1", installationId, accountId, eventType, typeVersion, dedupeKey]`. The literal domain
 * separator and the length-delimited JSON values make the encoding unambiguous, so the same provider id in two
 * accounts, two installations or two event types gives two ids, and the same occurrence observed twice gives one.
 *
 * The function is pure, so it is the library's: the daemon computes ids at ingest (phase B1). The comparison tells a
 * repeat from the theoretical truncated-hash collision — equal ids, unequal preimages — which the daemon stops on
 * without advancing the source cursor (D8). Stopping is the daemon's; telling them apart is this.
 */
import { canonicalJson } from '../json.ts';
import { EventsError } from '../result.ts';
import { utf8Encode } from '../text.ts';
import { sha256 } from './sha256.ts';

/** The tuple an event id is derived from. `typeVersion` is the event's own JSON integer `version`. */
export interface EventIdentityInput {
  readonly installationId: string;
  readonly accountId: string;
  readonly eventType: string;
  readonly typeVersion: number;
  readonly dedupeKey: string;
}

/** An event id together with the preimage it was derived from: what the daemon stores beside it. */
export interface EventIdentity {
  readonly eventId: string;
  readonly preimage: string;
}

/** D3's domain separator, the tuple's first element. */
const DOMAIN = 'agentcomms-event-v1';

const HEX = '0123456789abcdef';

/** The canonical JSON an event id hashes. Throws `EventsError` (`IDENTITY_INVALID`) for a tuple D3 does not type. */
export function eventIdPreimage(input: EventIdentityInput): string {
  for (const field of ['installationId', 'accountId', 'eventType', 'dedupeKey'] as const) {
    if (typeof input[field] !== 'string') {
      throw new EventsError(
        'IDENTITY_INVALID',
        `${field} is a string, and this is ${typeof input[field]}`,
        `/${field}`,
      );
    }
  }
  if (typeof input.typeVersion !== 'number' || !Number.isSafeInteger(input.typeVersion)) {
    throw new EventsError(
      'IDENTITY_INVALID',
      `typeVersion is the event's integer version, written as a JSON integer, and this is ${JSON.stringify(input.typeVersion)}`,
      '/typeVersion',
    );
  }
  return canonicalJson([
    DOMAIN,
    input.installationId,
    input.accountId,
    input.eventType,
    input.typeVersion,
    input.dedupeKey,
  ]);
}

/**
 * The event id: the first 32 lowercase hexadecimal characters of SHA-256 over the preimage's UTF-8 bytes. Asynchronous
 * because WebCrypto is. `digest` replaces SHA-256, for tests only — an injected collision is data — and must answer
 * with SHA-256's 32 bytes.
 */
export async function eventId(
  input: EventIdentityInput,
  options: {
    readonly digest?: (bytes: Uint8Array) => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>;
  } = {},
): Promise<string> {
  const preimage = eventIdPreimage(input);
  const answer = await (options.digest ?? sha256)(utf8Encode(preimage));
  // Read through a view, so an answer made in another realm is read as well as one made here.
  const bytes = ArrayBuffer.isView(answer)
    ? new Uint8Array(answer.buffer, answer.byteOffset, answer.byteLength)
    : new Uint8Array(answer);
  if (bytes.length !== 32) {
    throw new EventsError('IDENTITY_INVALID', `a SHA-256 digest is 32 bytes, and this one is ${bytes.length}`);
  }
  let hex = '';
  for (const byte of bytes.subarray(0, 16)) hex += HEX.charAt(byte >> 4) + HEX.charAt(byte & 15);
  return hex;
}

/**
 * How an incoming identity relates to a stored one: `same-occurrence` when the preimages are equal; `distinct` when
 * the ids differ; `collision` when the ids are equal and the preimages are not.
 */
export function compareEventIdentities(
  stored: EventIdentity,
  incoming: EventIdentity,
): 'same-occurrence' | 'distinct' | 'collision' {
  if (stored.preimage === incoming.preimage) return 'same-occurrence';
  if (stored.eventId !== incoming.eventId) return 'distinct';
  return 'collision';
}
