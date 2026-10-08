import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

export async function rulesList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('rules-list');
}

export async function ruleShow(ruleId: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('rule-show', { ruleId });
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
