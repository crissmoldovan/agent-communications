import type { Config } from '@agentcomms/core';
import type { Harness } from './harness.ts';

/**
 * Behaviour rules for a test (design 2026-10-19-agent-behaviour-rules, B3), written to core's configuration as a
 * person's own change writes them. A rule added where none was tightens, and applies as it is; one removed or widened
 * loosens, and `loosening` gives it the consent a person's yes to that change carries.
 */

/** A rule as the configuration keeps it: here the agent may do these acts, and only these. */
export interface TestBehaviourRule {
  account: string;
  accountId?: string;
  conversation?: string;
  acts: string[];
}

/** Replaces every behaviour rule with `rules`. */
export async function setBehaviourRules(
  harness: Pick<Harness, 'core'>,
  rules: readonly TestBehaviourRule[],
  options: { loosening?: boolean } = {},
): Promise<void> {
  await harness.core.config.update(
    (config): Config => ({ ...config, behaviour: { rules: rules.map((rule) => ({ ...rule })) } }),
    options.loosening ? { consent: { kind: 'loosening-consent', paths: ['behaviour.rules'] } } : {},
  );
}
