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
    return accepted?.generation ?? null;
  }

  register(input: SubscriberStreamRegistration): boolean {
    const key = streamKey(input.subscriberId, input.subscriberVersion);
    const current = this.#currentGeneration.get(key);
    if (current !== undefined && current !== input.generation) return false;
    if (current === undefined) this.#currentGeneration.set(key, input.generation);
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
  }): boolean {
    return this.#currentGeneration.get(streamKey(input.subscriberId, input.subscriberVersion)) === input.generation;
  }
}
