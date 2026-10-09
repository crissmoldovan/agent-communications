import { timingSafeEqual } from 'node:crypto';

export interface SubscriberBearerGeneration {
  readonly generation: number;
  readonly lifecycle: 'current' | 'overlap';
  readonly material: string;
  readonly expiresAt?: number | undefined;
}

export interface SubscriberStreamRegistration {
  readonly subscriberId: string;
  readonly subscriberVersion: number;
  readonly generation: number;
  readonly close: () => void;
  /** The persisted current bearer generation this admission was checked against; it, not arrival order, is current. */
  readonly currentGeneration?: number | undefined;
  /** Set when the stream was admitted with the bounded previous (overlap) bearer: its authority ends at this instant. */
  readonly authorizedUntil?: number | undefined;
}

/** One admitted bearer: its generation, the persisted current generation, and an overlap admission's end. */
export interface SubscriberStreamAdmission {
  readonly generation: number;
  readonly currentGeneration: number;
  readonly authorizedUntil?: number | undefined;
}

export interface SubscriberStreamsOptions {
  readonly now?: (() => number) | undefined;
}

function streamKey(subscriberId: string, subscriberVersion: number): string {
  return `${subscriberId}\u0000${subscriberVersion}`;
}

function equalBearer(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * The internal SSE registration boundary. It contains no HTTP listener and no subscriber operation: Task 9 supplies
 * the transport. Rotation advances the in-memory generation before synchronous close callbacks observe the old stream.
 */
export class SubscriberStreams {
  readonly #now: () => number;
  readonly #streams = new Map<string, Map<number, Set<() => void>>>();
  readonly #currentGeneration = new Map<string, number>();

  constructor(options: SubscriberStreamsOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  authenticate(input: {
    readonly bearer: string;
    readonly generations: readonly SubscriberBearerGeneration[];
  }): number | null {
    return this.admit(input)?.generation ?? null;
  }

  /** Accepts exactly the current bearer, or the one unexpired previous bearer within its five-minute overlap. */
  admit(input: {
    readonly bearer: string;
    readonly generations: readonly SubscriberBearerGeneration[];
  }): SubscriberStreamAdmission | null {
    const now = this.#now();
    const current = input.generations.filter((generation) => generation.lifecycle === 'current');
    const overlap = input.generations.filter(
      (generation) =>
        generation.lifecycle === 'overlap' &&
        generation.expiresAt !== undefined &&
        generation.expiresAt > now &&
        generation.expiresAt <= now + 300_000,
    );
    if (current.length !== 1 || overlap.length > 1) return null;
    const accepted = [...current, ...overlap].find((generation) => equalBearer(input.bearer, generation.material));
    if (accepted === undefined) return null;
    const currentGeneration = (current[0] as SubscriberBearerGeneration).generation;
    return accepted.lifecycle === 'current'
      ? { generation: accepted.generation, currentGeneration }
      : { generation: accepted.generation, currentGeneration, authorizedUntil: accepted.expiresAt };
  }

  register(input: SubscriberStreamRegistration): boolean {
    const key = streamKey(input.subscriberId, input.subscriberVersion);
    const known = this.#currentGeneration.get(key);
    if (input.currentGeneration !== undefined) {
      // A rotation this process already applied is newer than the admission's read: that admission is stale.
      if (known !== undefined && known > input.currentGeneration) return false;
      // A rotation persisted elsewhere: close older streams exactly as an in-process rotation does.
      if (known !== undefined && known < input.currentGeneration)
        this.rotate({ ...input, generation: input.currentGeneration });
      else this.#currentGeneration.set(key, input.currentGeneration);
    } else if (known === undefined) {
      // Without a persisted current generation only a current-bearer stream can name one; an overlap stream cannot.
      if (input.authorizedUntil !== undefined) return false;
      this.#currentGeneration.set(key, input.generation);
    }
    if (!this.isCurrent(input)) return false;
    let byGeneration = this.#streams.get(key);
    if (byGeneration === undefined) {
      byGeneration = new Map();
      this.#streams.set(key, byGeneration);
    }
    const callbacks = byGeneration.get(input.generation) ?? new Set<() => void>();
    callbacks.add(input.close);
    byGeneration.set(input.generation, callbacks);
    return true;
  }

  unregister(input: Omit<SubscriberStreamRegistration, 'close'> & { readonly close: () => void }): void {
    const callbacks = this.#streams.get(streamKey(input.subscriberId, input.subscriberVersion))?.get(input.generation);
    callbacks?.delete(input.close);
  }

  /** The mutation precedes every close callback, so a re-entrant send sees the new generation and refuses the old one. */
  rotate(input: {
    readonly subscriberId: string;
    readonly subscriberVersion: number;
    readonly generation: number;
  }): void {
    const key = streamKey(input.subscriberId, input.subscriberVersion);
    this.#currentGeneration.set(key, input.generation);
    const byGeneration = this.#streams.get(key);
    if (byGeneration === undefined) return;
    for (const [generation, callbacks] of byGeneration) {
      if (generation === input.generation) continue;
      byGeneration.delete(generation);
      for (const close of callbacks) close();
    }
  }

  isCurrent(input: {
    readonly subscriberId: string;
    readonly subscriberVersion: number;
    readonly generation: number;
    readonly authorizedUntil?: number | undefined;
  }): boolean {
    const current = this.#currentGeneration.get(streamKey(input.subscriberId, input.subscriberVersion));
    if (input.authorizedUntil !== undefined)
      return current !== undefined && input.generation < current && this.#now() < input.authorizedUntil;
    return current === input.generation;
  }
}
