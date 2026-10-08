/**
 * Serialises all state transitions for one Gmail mailbox in this owner process. The lock deliberately spans awaits:
 * a provider baseline or history page cannot slip between another caller's durable stage and final cursor commit.
 */
export class MailboxLock {
  readonly #tails = new Map<string, Promise<void>>();

  async withMailbox<T>(accountId: string, work: () => Promise<T> | T): Promise<T> {
    const previous = this.#tails.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(accountId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(accountId) === tail) this.#tails.delete(accountId);
    }
  }
}
