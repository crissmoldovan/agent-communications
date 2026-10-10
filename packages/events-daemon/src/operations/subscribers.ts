import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

export async function subscribersList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('subscribersList');
}

export async function addSubscriber(document: unknown, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('addSubscriber', { document });
}

export async function updateSubscriber(document: unknown, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('updateSubscriber', { document });
}

export async function removeSubscriber(subscriberId: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('removeSubscriber', { subscriberId });
}
