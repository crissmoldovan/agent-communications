import type { ActivationRuntime, PreparedActivation } from './activations.ts';

/**
 * The singleton-budget activation entry point. It deliberately delegates the whole disclosure protocol to the
 * shared activation runtime, so budget pointers have no alternate write path.
 */
export class JudgeBudgetActivation {
  readonly #activations: Pick<ActivationRuntime, 'prepareJudgeBudget'>;

  constructor(input: { readonly activations: Pick<ActivationRuntime, 'prepareJudgeBudget'> }) {
    this.#activations = input.activations;
  }

  prepare(input: { readonly version: number }): Promise<PreparedActivation> {
    return this.#activations.prepareJudgeBudget(input);
  }
}
