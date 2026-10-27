import { EventControlClient } from '../control/client.ts';
import type { RuleCheckResultV1 } from '../runtime/workflow/flow-test.ts';

type Options = { readonly stateDir?: string | undefined };

/**
 * Checks a workflow document as the event service reads it (workflows design §7.7, §10.1; plan B7): canonical, its flow
 * checked, its events' name free among the active workflows. Every problem is named; nothing is written, so an agent
 * may check a document as the person may.
 */
export async function ruleCheck(document: unknown, options: Options = {}): Promise<RuleCheckResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('rule-check', {
    document,
  })) as RuleCheckResultV1;
}
