import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

/** Lists the held Phase A catalogue through the owner without opening event SQLite in a client. */
export async function catalogueList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('catalogue-list');
}

/** Shows one selectable catalogue definition through the owner. */
export async function catalogueShow(type: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('catalogue-show', { type });
}
