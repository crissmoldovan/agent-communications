import type { SourceScope } from './contracts.ts';

function key(scope: SourceScope): string {
  return `${scope.source}\u0000${scope.accountId}\u0000${scope.scopeId}`;
}

/** Serialises provider, baseline, stage and cursor transitions for one concrete source scope. */
export class SourceScopeLock {
  readonly #tails = new Map<string, Promise<void>>();

  async withScope<T>(scope: SourceScope, work: () => Promise<T> | T): Promise<T> {
    const scopeKey = key(scope);
    const previous = this.#tails.get(scopeKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(scopeKey, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(scopeKey) === tail) this.#tails.delete(scopeKey);
    }
  }

  /** Takes a deterministic source/scope order so a replacement spanning scopes cannot deadlock another one. */
  async withScopes<T>(scopes: readonly SourceScope[], work: () => Promise<T> | T): Promise<T> {
    const ordered = [
      ...new Map(
        [...scopes].sort((left, right) => key(left).localeCompare(key(right))).map((scope) => [key(scope), scope]),
      ).values(),
    ];
    const enter = async (index: number): Promise<T> => {
      if (index === ordered.length) return work();
      const scope = ordered[index];
      if (scope === undefined) return work();
      return this.withScope(scope, () => enter(index + 1));
    };
    return enter(0);
  }
}
