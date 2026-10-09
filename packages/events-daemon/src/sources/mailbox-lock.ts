import { SourceScopeLock } from './scope-lock.ts';

/** Gmail compatibility wrapper around D3's source-scope lock. */
export class MailboxLock {
  readonly #lock: SourceScopeLock;

  constructor(lock: SourceScopeLock = new SourceScopeLock()) {
    this.#lock = lock;
  }

  /** Transitional access for Gmail's source-neutral baseline helper; callers still use withMailbox for Gmail work. */
  get sourceScopeLock(): SourceScopeLock {
    return this.#lock;
  }

  async withMailbox<T>(accountId: string, work: () => Promise<T> | T): Promise<T> {
    return this.#lock.withScope({ source: 'gmail', accountId, scopeId: 'mailbox' }, work);
  }
}
