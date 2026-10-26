import { EventControlClient } from '../control/client.ts';
import type { AnalyseProvider } from '../domain/analyse-model.ts';
import type { RuleAnalyseResultV1 } from '../domain/rule-analyse.ts';

type Options = { readonly stateDir?: string | undefined };

/**
 * Analyse (0.33.0 design §3.3): suggestions for one rule, or for a draft of it, from the rule's own text and content-free
 * counts of its last 30 days, and from a model on the person's own provider key. The person's view, at a terminal or in
 * the app: the CLI refuses it inside an MCP server's process, and no MCP tool reaches it. It never applies anything.
 */
export async function ruleAnalyse(
  ruleId: string,
  options: Options & {
    readonly draft?: Readonly<Record<string, unknown>> | undefined;
    readonly provider?: AnalyseProvider | undefined;
  } = {},
): Promise<RuleAnalyseResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('rule-analyse', {
    ruleId,
    ...(options.draft === undefined ? {} : { draft: options.draft }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  })) as RuleAnalyseResultV1;
}
