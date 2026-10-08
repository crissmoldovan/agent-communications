import { EventControlClient } from '../control/client.ts';
import type { DryRunLogEntry, DryRunRecord } from '../runtime/dispatcher.ts';

type Options = { readonly stateDir?: string | undefined };

/** Metadata and rendered records remain behind the owner control boundary, never the MCP server. */
export async function dryrunList(options: Options = {}): Promise<readonly DryRunLogEntry[]> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request(
    'dryrun-list',
  )) as readonly DryRunLogEntry[];
}

export async function dryrunShow(deliveryId: string, options: Options = {}): Promise<DryRunRecord> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('dryrun-show', {
    deliveryId,
  })) as DryRunRecord;
}
