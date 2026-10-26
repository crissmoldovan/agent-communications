import { EventControlClient } from '../control/client.ts';
import type { IntegrationShowResultV1 } from '../runtime/linear-integration.ts';

type Options = { readonly stateDir?: string | undefined };

/*
 * Settings → Integrations (0.33.0 design §3.4). `integration show linear` is the person's read, at a terminal or in the
 * app: the CLI refuses it inside an MCP server's process, and no MCP tool calls it. With a team, it also lists the
 * labels an issue in that team can carry.
 */

/** Whether a Linear key is kept, and the workspace and teams it sees — and, for `team`, its labels. Never the key. */
export async function integrationShow(
  integration: string,
  options: Options & { readonly team?: string | undefined } = {},
): Promise<IntegrationShowResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('integration-show', {
    integration,
    ...(options.team === undefined ? {} : { team: options.team }),
  })) as IntegrationShowResultV1;
}
