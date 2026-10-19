import { CommsError } from '@agentcomms/core';
import { JUDGE_KIND_DEFINITIONS } from '../domain/judges.ts';
import { EventDomainError, JUDGE_KINDS, type JudgeKind } from '../domain/lifecycle.ts';
import { ImmutableVersions } from '../domain/versions.ts';
import type { EventDatabase } from '../store/database.ts';
import type { ActivationRuntime, PreparedActivation } from './activations.ts';
import { JudgePurgeParticipant } from './judge-purge.ts';
import { purgeJudgeKindRuleWork } from './replacements.ts';

function available(kind: string): JudgeKind {
  if (!(JUDGE_KINDS as readonly string[]).includes(kind))
    throw new CommsError('BAD_DATA', 'the judge kind is not recognised');
  const definition = JUDGE_KIND_DEFINITIONS.find((entry) => entry.kind === kind);
  if (definition?.availability !== 'available' && definition?.implementation === undefined)
    throw new EventDomainError('E2_REQUIRED', 'the judge kind is unavailable');
  return kind as JudgeKind;
}

/**
 * E2's artifact lifecycle around one kind's immediate disable. It fences and stops that kind's in-memory artifact work
 * first, runs E's whole disable transaction under the artifact lock, then removes what the disable orphaned.
 */
export interface JudgeKindArtifactLifecycle {
  readonly kind: JudgeKind;
  disableKind<T>(disable: () => T): Promise<T>;
}

export type JudgeKindDisableResult = ReturnType<JudgeKinds['disable']>;

/** Task 4's dormant kind authority. Public operation registration remains Task 9's job. */
export class JudgeKinds {
  readonly #store: EventDatabase;
  readonly #now: () => number;
  readonly #activations: Pick<ActivationRuntime, 'prepareJudgeKind' | 'cancelForJudgeKindInTransaction'> | undefined;
  readonly #artifacts: JudgeKindArtifactLifecycle | undefined;

  constructor(input: {
    readonly store: EventDatabase;
    readonly now?: (() => number) | undefined;
    readonly activations?: Pick<ActivationRuntime, 'prepareJudgeKind' | 'cancelForJudgeKindInTransaction'> | undefined;
    readonly artifacts?: JudgeKindArtifactLifecycle | undefined;
  }) {
    this.#store = input.store;
    this.#now = input.now ?? Date.now;
    this.#activations = input.activations;
    this.#artifacts = input.artifacts;
  }

  /**
   * The operation-facing disable. A kind with installed artifacts disables through their lifecycle, which wraps
   * exactly the transaction below; every other kind is that transaction alone.
   */
  async disableKind(kind: string): Promise<JudgeKindDisableResult> {
    const enabledKind = available(kind);
    if (this.#artifacts !== undefined && this.#artifacts.kind === enabledKind)
      return this.#artifacts.disableKind(() => this.disable(enabledKind));
    return this.disable(enabledKind);
  }

  prepareEnable(input: { readonly kind: string; readonly version: number }): Promise<PreparedActivation> {
    available(input.kind);
    if (this.#activations === undefined)
      return Promise.reject(new CommsError('CONFIG', 'judge-kind activation is not composed for this runtime'));
    return this.#activations.prepareJudgeKind(input);
  }

  disable(kind: string): {
    readonly kind: JudgeKind;
    readonly disabled: true;
    readonly pointer: 'absent' | 'removed';
    readonly pendingActivationsCancelled: number;
  } {
    const enabledKind = available(kind);
    return this.#store.immediate(() => {
      const active = new ImmutableVersions(this.#store.database).activeVersion('judge-kind', enabledKind);
      this.#store.database
        .prepare(
          `INSERT INTO judge_kind_disable_generations (kind, generation, disabled_at)
           VALUES (?, 1, ?)
           ON CONFLICT(kind) DO UPDATE SET generation = generation + 1, disabled_at = excluded.disabled_at`,
        )
        .run(enabledKind, this.#now());
      // Disable is tightening. It must cancel an initial enablement just as it cancels a replacement, even though no
      // pointer exists yet; otherwise the original approval could recreate authority after this transaction commits.
      const pendingActivationsCancelled = this.#activations?.cancelForJudgeKindInTransaction(enabledKind) ?? 0;
      new JudgePurgeParticipant({ database: this.#store.database, now: this.#now }).kind(enabledKind);
      purgeJudgeKindRuleWork(this.#store.database, enabledKind, this.#now());
      if (active !== null)
        this.#store.database
          .prepare("DELETE FROM active_versions WHERE kind = 'judge-kind' AND object_id = ? AND version = ?")
          .run(enabledKind, active.version);
      return {
        kind: enabledKind,
        disabled: true,
        pointer: active === null ? 'absent' : 'removed',
        pendingActivationsCancelled,
      };
    });
  }
}
