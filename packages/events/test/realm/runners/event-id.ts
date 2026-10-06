import type { Runner } from './types.ts';

interface IdentityInput {
  readonly installationId: string;
  readonly accountId: string;
  readonly eventType: string;
  readonly typeVersion: number;
  readonly dedupeKey: string;
}

/** An input's exact preimage, its UTF-8 bytes, its SHA-256 and its id — and how it relates to an earlier vector. */
interface IdVector {
  readonly kind: 'id';
  readonly name: string;
  readonly input: IdentityInput;
  readonly sameAs?: string;
  readonly differsFrom?: string;
  readonly preimage: string;
  readonly preimageUtf8Hex: string;
  readonly sha256: string;
  readonly eventId: string;
}

/** An input `eventIdPreimage` and `eventId` refuse, with the issue code they refuse it with. */
interface RefusedVector {
  readonly kind: 'refused';
  readonly name: string;
  readonly input: IdentityInput;
  readonly code: string;
}

/** Two different tuples given one injected digest, and how the comparison classifies them. */
interface CollisionVector {
  readonly kind: 'collision';
  readonly name: string;
  readonly digest: string;
  readonly first: IdentityInput;
  readonly second: IdentityInput;
  readonly eventId: string;
  readonly outcomes: { readonly injected: string; readonly sameTuple: string; readonly differentIds: string };
}

type EventIdVector = IdVector | RefusedVector | CollisionVector;

const HEX = '0123456789abcdef';
const toHex = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += HEX.charAt(byte >> 4) + HEX.charAt(byte & 15);
  return text;
};
const fromHex = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};
const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : `not an EventsError: ${String(error)}`;

/** `eventIdPreimage`, `utf8Encode`, `eventId` and `compareEventIdentities` over every vector. */
export const eventIdRunner: Runner = async (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  const ids = new Map<string, string>();
  for (const vector of file.vectors as readonly EventIdVector[]) {
    const fail = (why: string) => failures.push(`${vector.name}: ${why}`);
    if (vector.kind === 'id') {
      const preimage = library.eventIdPreimage(vector.input);
      const preimageUtf8Hex = toHex(library.utf8Encode(preimage));
      const eventId = await library.eventId(vector.input);
      ids.set(vector.name, eventId);
      results.push({ name: vector.name, preimage, preimageUtf8Hex, eventId });
      if (preimage !== vector.preimage) fail(`preimage ${preimage} is not ${vector.preimage}`);
      if (preimageUtf8Hex !== vector.preimageUtf8Hex)
        fail(`preimage bytes ${preimageUtf8Hex} are not ${vector.preimageUtf8Hex}`);
      if (eventId !== vector.eventId) fail(`id ${eventId} is not ${vector.eventId}`);
      if (!/^[0-9a-f]{64}$/.test(vector.sha256) || vector.sha256.slice(0, 32) !== vector.eventId) {
        fail('the vector’s id is not the first 32 characters of its SHA-256');
      }
      if ((await library.eventId(vector.input)) !== eventId) fail('the same input twice gave two ids');
      if (vector.sameAs !== undefined && ids.get(vector.sameAs) !== eventId)
        fail(`its id differs from ${vector.sameAs}`);
      if (vector.differsFrom !== undefined) {
        const other = ids.get(vector.differsFrom);
        if (other === undefined || other === eventId) fail(`its id is not different from ${vector.differsFrom}`);
      }
    } else if (vector.kind === 'refused') {
      let preimageCode = 'accepted';
      let idCode = 'accepted';
      try {
        library.eventIdPreimage(vector.input);
      } catch (error) {
        preimageCode = codeOf(error);
      }
      try {
        await library.eventId(vector.input);
      } catch (error) {
        idCode = codeOf(error);
      }
      results.push({ name: vector.name, preimage: preimageCode, eventId: idCode });
      if (preimageCode !== vector.code) fail(`eventIdPreimage gave ${preimageCode}, not ${vector.code}`);
      if (idCode !== vector.code) fail(`eventId gave ${idCode}, not ${vector.code}`);
    } else if (vector.kind === 'collision') {
      const digest = fromHex(vector.digest);
      const injected = { digest: () => digest.slice() };
      const first = {
        eventId: await library.eventId(vector.first, injected),
        preimage: library.eventIdPreimage(vector.first),
      };
      const second = {
        eventId: await library.eventId(vector.second, injected),
        preimage: library.eventIdPreimage(vector.second),
      };
      const real = {
        first: { eventId: await library.eventId(vector.first), preimage: first.preimage },
        second: { eventId: await library.eventId(vector.second), preimage: second.preimage },
      };
      const outcomes = {
        injected: library.compareEventIdentities(first, second),
        sameTuple: library.compareEventIdentities(first, { ...first }),
        differentIds: library.compareEventIdentities(real.first, real.second),
      };
      results.push({ name: vector.name, first: first.eventId, second: second.eventId, outcomes });
      if (first.eventId !== vector.eventId || second.eventId !== vector.eventId) {
        fail(`the injected digest gave ${first.eventId} and ${second.eventId}, not ${vector.eventId} twice`);
      }
      if (first.preimage === second.preimage) fail('the two tuples are not different');
      for (const key of ['injected', 'sameTuple', 'differentIds'] as const) {
        if (outcomes[key] !== vector.outcomes[key]) fail(`${key} is ${outcomes[key]}, not ${vector.outcomes[key]}`);
      }
    } else {
      fail(`unknown kind ${String((vector as { kind?: unknown }).kind)}`);
    }
  }
  return { results, failures };
};
