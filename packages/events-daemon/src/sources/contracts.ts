import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import type { SourceOptions } from '../domain/source-options.ts';
import { createSourceStageRetention, type SourceStageRetention } from '../store/retention.ts';
import type { SourceScopeLock } from './scope-lock.ts';
import { isSourceScopeFenced } from './source-scope-fence.ts';

/** A durable cursor scope owned by exactly one local event source. */
export interface SourceScope {
  readonly source: SourceOptions['channel'];
  readonly accountId: string;
  readonly scopeId: string;
}

/** The source-facing part of an immutable rule version. Provider clients stay outside this contract. */
export interface SourceRuleVersion {
  readonly ruleId: string;
  readonly ruleVersion: number;
}

/** The exact rule-version debt a shared source representation must retain. */
export interface SourceStageDebt extends SourceRuleVersion {
  readonly ingestRetentionMs: number;
}

/** Source adapters use this one calculator when their provider content first becomes durable. */
export function sourceStageRetentionForDebts(
  stagedAt: number,
  debts: readonly SourceStageDebt[],
): SourceStageRetention {
  return createSourceStageRetention(
    stagedAt,
    debts.map((debt) => debt.ingestRetentionMs),
  );
}

/** A source operation returns normalised candidate facts or a content-free terminal outcome. */
export type SourceScanStep<TCandidate, TTerminal> =
  | { readonly kind: 'candidate'; readonly candidate: TCandidate }
  | { readonly kind: 'terminal'; readonly terminal: TTerminal };

export type SourceCleanupKind = 'reset' | 'drain' | 'purge';

/** The closed local-source contract. Concrete adapters are registered by the owner, not discovered at runtime. */
export interface LocalEventSource {
  readonly source: SourceOptions['channel'];
  canonicalise(options: unknown): SourceOptions;
  scopesFor(input: {
    readonly accountId: string;
    readonly options?: SourceOptions | undefined;
  }): readonly SourceScope[];
  withScopes<T>(lock: SourceScopeLock, scopes: readonly SourceScope[], work: () => Promise<T> | T): Promise<T>;
  baseline<TPosition>(sample: () => Promise<TPosition>): Promise<TPosition>;
  resume<TCandidate, TTerminal>(
    step: () => Promise<SourceScanStep<TCandidate, TTerminal>>,
  ): Promise<SourceScanStep<TCandidate, TTerminal>>;
  describeCursor<TCursor>(cursor: TCursor): TCursor;
  cleanup<T>(kind: SourceCleanupKind, work: () => Promise<T> | T): Promise<T>;
}

/** A stable snapshot of the exact rule fan-out an in-flight source operation may write for. */
export function sourceRuleSetSnapshot(rules: readonly SourceRuleVersion[]): string {
  return rules
    .map((rule) => `${rule.ruleId}@${rule.ruleVersion}`)
    .sort()
    .join(',');
}

export interface SourceWriteSnapshot {
  readonly generation: number;
  readonly enabled: number;
  readonly startedAt: number;
  readonly rules: string;
}

/** A source call completed after its authority, rule fan-out, or scope fence moved. */
export class StaleSourceWriteError extends CommsError {
  constructor() {
    super('APPROVAL_VOID', 'stale source write', { details: { reason: 'STALE_SOURCE_WRITE' } });
  }
}

/**
 * The in-transaction half of every generic source write after an await. Callers load configuration before entering
 * their transaction; this function then proves the switch, revocation, exact rules and cut-over fence still match.
 */
export function assertSourceWriteStillLive(
  database: DatabaseSync,
  scope: SourceScope,
  snapshot: SourceWriteSnapshot,
  rules: () => readonly SourceRuleVersion[],
): void {
  const settings = database
    .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
    .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
  const revoked = database
    .prepare('SELECT 1 AS present FROM account_revocations WHERE account_id = ? AND revoked_at >= ?')
    .get(scope.accountId, snapshot.startedAt);
  if (
    settings === undefined ||
    settings.enabled !== snapshot.enabled ||
    settings.paused !== 0 ||
    settings.switch_generation !== snapshot.generation ||
    revoked !== undefined ||
    sourceRuleSetSnapshot(rules()) !== snapshot.rules ||
    isSourceScopeFenced(database, scope)
  ) {
    throw new StaleSourceWriteError();
  }
}

function sourceScopeKey(scope: SourceScope): string {
  return `${scope.source}\u0000${scope.accountId}\u0000${scope.scopeId}`;
}

/** Deterministic ready-work rotation; the real scheduler can expose only the registered source scopes. */
export class RoundRobinReadyScopes {
  #scopes: readonly SourceScope[] = [];
  #next = 0;

  /**
   * Replace the ready set without giving the lexically first scope an accidental priority after a restart or an
   * unrelated account becoming eligible. `after` is the durable key selected on the preceding owner turn.
   */
  replace(scopes: readonly SourceScope[], after?: string): void {
    this.#scopes = [...scopes].sort((left, right) => sourceScopeKey(left).localeCompare(sourceScopeKey(right)));
    const index = after === undefined ? -1 : this.#scopes.findIndex((scope) => sourceScopeKey(scope) === after);
    this.#next = index < 0 ? 0 : (index + 1) % this.#scopes.length;
  }

  next(): SourceScope | undefined {
    if (this.#scopes.length === 0) return undefined;
    const scope = this.#scopes[this.#next % this.#scopes.length];
    this.#next = (this.#next + 1) % this.#scopes.length;
    return scope;
  }
}
