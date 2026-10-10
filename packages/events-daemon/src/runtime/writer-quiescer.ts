import { AsyncLocalStorage } from 'node:async_hooks';

type LeaseKind = 'shared' | 'exclusive';

interface LeaseContext {
  readonly quiescer: WriterQuiescer;
  readonly kind: LeaseKind;
}

const leaseContext = new AsyncLocalStorage<LeaseContext>();

/**
 * Stops new encrypted-state writers while a rare owner-wide rekey drains the
 * writers already between their cipher work and durable commit.  It is purely
 * in-memory: a failed operation never leaves persistent pause state behind.
 */
export class WriterQuiescer {
  #shared = 0;
  #exclusive = false;
  #exclusiveWaiting = 0;
  #waiters: Array<() => void> = [];

  async withShared<T>(work: () => Promise<T>): Promise<T> {
    const held = leaseContext.getStore();
    if (held?.quiescer === this) return work();
    await this.acquireShared();
    try {
      return await leaseContext.run({ quiescer: this, kind: 'shared' }, work);
    } finally {
      this.#shared -= 1;
      this.wake();
    }
  }

  async withExclusive<T>(work: () => Promise<T>): Promise<T> {
    const held = leaseContext.getStore();
    if (held?.quiescer === this && held.kind === 'exclusive') return work();
    if (held?.quiescer === this)
      throw new Error('an event writer cannot upgrade its shared lease to an exclusive lease');
    this.#exclusiveWaiting += 1;
    try {
      await this.waitFor(() => !this.#exclusive && this.#shared === 0);
      this.#exclusive = true;
      return await leaseContext.run({ quiescer: this, kind: 'exclusive' }, work);
    } finally {
      if (this.#exclusive) this.#exclusive = false;
      this.#exclusiveWaiting -= 1;
      this.wake();
    }
  }

  /** Fails closed when a destructive key operation escaped the owner-wide rekey lease. */
  assertExclusive(): void {
    const held = leaseContext.getStore();
    if (held?.quiescer !== this || held.kind !== 'exclusive')
      throw new Error('the event writer quiescer exclusive lease is required');
  }

  private async acquireShared(): Promise<void> {
    await this.waitFor(() => !this.#exclusive && this.#exclusiveWaiting === 0);
    this.#shared += 1;
  }

  private async waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  private wake(): void {
    const waiters = this.#waiters.splice(0);
    for (const wake of waiters) wake();
  }
}

/** Required shared lease wrapper for every B3 writer-inventory entrypoint. */
export async function withEventWriterLease<T>(quiescer: WriterQuiescer, work: () => Promise<T>): Promise<T> {
  return quiescer.withShared(work);
}
