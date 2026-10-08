import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

export async function targetsList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('targets-list');
}

export async function addTarget(document: unknown, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('target-add', { document });
}

export async function updateTarget(document: unknown, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('target-update', { document });
}

export async function removeTarget(targetId: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('target-remove', { targetId });
}
