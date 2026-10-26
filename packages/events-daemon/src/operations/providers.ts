import { EventControlClient } from '../control/client.ts';
import { PERSON_SETUP_ORIGIN } from '../domain/judge-setup.ts';

type Options = { readonly stateDir?: string | undefined };

/*
 * AI provider keys (owner decision 2026-10-26): the accounts a person keeps with TypeSafe and OpenRouter, whose keys Jev
 * uses. The list says only whether each has a key. Setting and removing one are the person's, at their terminal or in
 * the app: the CLI refuses an agent and the MCP server first, the key is read from the person's hidden input or the
 * app's stdin, never argv, and no MCP tool sets, removes or sees one.
 */

/** Whether TypeSafe and OpenRouter each have a key; never a key, nor any part of one. */
export function providerList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('provider-list', {});
}

/** Stores the provider's key, replacing any it had, and gives it to every live Jev judge of that provider. */
export function providerKeySet(provider: string, options: Options & { readonly hidden: string }): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir, clientName: PERSON_SETUP_ORIGIN }).request(
    'provider-key-set',
    { provider, hidden: options.hidden },
  );
}

/** Removes the provider's key, and the copy its Jev judges hold: they then refuse their calls until a key is added. */
export function providerKeyRemove(provider: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir, clientName: PERSON_SETUP_ORIGIN }).request(
    'provider-key-remove',
    { provider },
  );
}
