import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

/**
 * Future terminal/app-only registrars use these one-operation client calls.
 * No secret argument is accepted here: Task 6 owns hidden input and supplies
 * it over the authenticated owner path only after its origin gate.
 */
export async function targetSecretCreate(targetId: string, version: number, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('targetSecretCreate', { targetId, version });
}

export async function targetSecretRotate(targetId: string, version: number, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('targetSecretRotate', { targetId, version });
}

export async function subscriberTokenCreate(
  subscriberId: string,
  version: number,
  options: Options = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('subscriberTokenCreate', {
    subscriberId,
    version,
  });
}

export async function subscriberTokenRotate(
  subscriberId: string,
  version: number,
  options: Options = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('subscriberTokenRotate', {
    subscriberId,
    version,
  });
}
