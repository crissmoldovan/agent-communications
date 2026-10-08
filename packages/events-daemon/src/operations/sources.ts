import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

export async function sourcesList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('sources-list');
}

export async function sourceShow(source: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('source-show', { source });
}
