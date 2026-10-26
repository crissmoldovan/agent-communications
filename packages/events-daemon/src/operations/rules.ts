import { EventControlClient } from '../control/client.ts';
import type { LaneWindowIdentity } from '../domain/lanes.ts';

type Options = { readonly stateDir?: string | undefined };

export async function rulesList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('rules-list');
}

/**
 * Every version of one rule. `caller` is the agent window an MCP call comes from: a version with a lane target other
 * than that window's own comes without its `counts7d` (review of 0.32.0, finding 8). The CLI passes none.
 */
export async function ruleShow(
  ruleId: string,
  options: Options & { readonly caller?: LaneWindowIdentity | undefined } = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request(
    'rule-show',
    options.caller === undefined ? { ruleId } : { ruleId, caller: options.caller },
  );
}

export async function createRule(document: unknown, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('rule-create', { document });
}

export async function updateRule(document: unknown, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('rule-update', { document });
}

export async function enableRule(ruleId: string, version: number, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('rule-enable', { ruleId, version });
}

export async function disableRule(ruleId: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('rule-disable', { ruleId });
}

export async function removeRule(ruleId: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('rule-remove', { ruleId });
}
