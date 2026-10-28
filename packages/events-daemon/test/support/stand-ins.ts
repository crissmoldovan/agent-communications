import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { KeyringModule, SecretStore } from '@agentcomms/core';
import { type EventSecretStoreKind, selectEventSecretStore } from '../../src/store/event-secrets.ts';

/**
 * Stand-ins every 0.36 test that starts core or the event service uses (workflows plan, Global Constraints): a home
 * of the test's own, a secret store that is never the system Keychain, and an in-memory keyring. On 2026-10-26 a
 * test wrote into the person's real login Keychain, and an earlier one read the real relay token: these exist so
 * neither can happen again.
 */

/**
 * A home, a configuration folder and a data folder under `root`, each made empty. Spread it into `startEventOwner`'s
 * options, so lanes, agent sessions and Laya's artifacts look there, and the owner reads no real configuration.
 */
export async function standInHome(
  root: string,
): Promise<{ readonly homeDirectory: string; readonly configDir: string; readonly dataDir: string }> {
  const homeDirectory = join(root, 'home');
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  for (const folder of [homeDirectory, configDir, dataDir]) await mkdir(folder, { recursive: true });
  return { homeDirectory, configDir, dataDir };
}

/** Selects the event service's file secret store in `database`, before an owner opens it: never the Keychain. */
export async function standInSecrets(database: DatabaseSync): Promise<void> {
  await selectEventSecretStore(database, 'file');
}

/** A secret store in memory, of either kind, for a migration between stores. */
export class MemorySecretStore implements SecretStore {
  readonly values: Map<string, string> = new Map();
  readonly kind: EventSecretStoreKind;
  constructor(kind: EventSecretStoreKind) {
    this.kind = kind;
  }
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }
  invalidate(): void {}
}

/**
 * Stands in for the native keyring that core's real keychain store drives. `items` is what the keychain holds;
 * `persist: false` models a keychain that accepts a write and keeps nothing.
 */
export function standInKeyring(
  items: Map<string, string> = new Map(),
  options: { readonly persist: boolean } = { persist: true },
): KeyringModule {
  const module: KeyringModule = {
    AsyncEntry: class {
      readonly #account: string;
      constructor(_service: string, account: string) {
        this.#account = account;
      }
      async getPassword(): Promise<string | undefined> {
        return items.get(this.#account);
      }
      async setPassword(password: string): Promise<void> {
        if (options.persist) items.set(this.#account, password);
      }
      async deletePassword(): Promise<boolean> {
        return items.delete(this.#account);
      }
    } as unknown as KeyringModule['AsyncEntry'],
  };
  return module;
}
