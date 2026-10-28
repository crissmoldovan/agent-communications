import { EventControlClient } from '../control/client.ts';
import { B3_SECRET_TERMINAL_ORIGIN } from './b3-contract.ts';

type Options = { readonly stateDir?: string | undefined };
type HiddenOptions = Options & { readonly hidden: string };

function terminalClient(options: Options): EventControlClient {
  // The owner still treats this as a self-declared label and rejects every other label. C replaces this narrow B3
  // bridge only after it presents its own verified capability.
  return new EventControlClient({ stateDir: options.stateDir, clientName: B3_SECRET_TERMINAL_ORIGIN });
}

/** Terminal-only operations name immutable owners; Commander reads hidden bytes before calling the input-bearing rows. */
export async function targetSecretCreate(targetId: string, version: number, options: Options = {}): Promise<unknown> {
  return terminalClient(options).request('targetSecretCreate', { targetId, version });
}

export async function targetSecretRotate(targetId: string, version: number, options: Options = {}): Promise<unknown> {
  return terminalClient(options).request('targetSecretRotate', { targetId, version });
}

export async function targetUrlSet(
  targetId: string,
  input: {
    readonly predecessorVersion?: number | undefined;
    readonly inertDraft?: Record<string, unknown> | undefined;
    readonly newVersion: number;
  },
  options: HiddenOptions,
): Promise<unknown> {
  return terminalClient(options).request('targetUrlSet', { targetId, ...input, hidden: options.hidden });
}

export async function subscriberTokenCreate(
  subscriberId: string,
  version: number,
  options: Options = {},
): Promise<unknown> {
  return terminalClient(options).request('subscriberTokenCreate', {
    subscriberId,
    version,
  });
}

/** A webhook subscriber version's signing secret (0.36.0, W29), generated at the terminal and shown once. */
export async function subscriberSecretCreate(
  subscriberId: string,
  version: number,
  options: Options = {},
): Promise<unknown> {
  return terminalClient(options).request('subscriberSecretCreate', { subscriberId, version });
}

/** Rotates a webhook subscriber version's signing secret; the previous one keeps signing through its overlap. */
export async function subscriberSecretRotate(
  subscriberId: string,
  version: number,
  options: Options = {},
): Promise<unknown> {
  return terminalClient(options).request('subscriberSecretRotate', { subscriberId, version });
}

/**
 * A webhook subscriber's secret URL (0.36.0, W29): a new immutable version, the newest before it with the URL's public
 * descriptor in place of its URL, its complete URL kept only in the secret store. The URL is hidden input.
 */
export async function subscriberUrlSet(
  subscriberId: string,
  version: number,
  options: HiddenOptions,
): Promise<unknown> {
  return terminalClient(options).request('subscriberUrlSet', { subscriberId, version, hidden: options.hidden });
}

export async function subscriberTokenRotate(
  subscriberId: string,
  version: number,
  options: Options = {},
): Promise<unknown> {
  return terminalClient(options).request('subscriberTokenRotate', {
    subscriberId,
    version,
  });
}

export async function judgeKeySet(judgeId: string, version: number, options: HiddenOptions): Promise<unknown> {
  return terminalClient(options).request('judgeKeySet', { judgeId, version, hidden: options.hidden });
}

export async function judgeKeyRotate(judgeId: string, version: number, options: HiddenOptions): Promise<unknown> {
  return terminalClient(options).request('judgeKeyRotate', { judgeId, version, hidden: options.hidden });
}

export async function migrateSecrets(to: 'file' | 'keychain', options: Options = {}): Promise<unknown> {
  return terminalClient(options).request('migrateSecrets', { to });
}
