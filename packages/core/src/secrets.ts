import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';

/**
 * Where refresh tokens, client secrets and approval keys live. Two backends, chosen per inbox or client and recorded
 * in config; the choice is never switched at runtime and there is no silent fallback from one to the other.
 *
 * - `keychain`: the OS store (macOS Keychain, Windows Credential Manager, Linux Secret Service — pinned, never the
 *   kernel keyring, which forgets everything on reboot) through the optional `@napi-rs/keyring` package.
 * - `file`: one owner-only JSON file per secret in an owner-only directory. Chosen explicitly, never by default.
 */
export type SecretStoreKind = 'keychain' | 'file';

export interface SecretStore {
  readonly kind: SecretStoreKind;
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<boolean>;
  /** Forgets any cached value, so the next read goes to the backend (e.g. after another process re-authorised). */
  invalidate(ref: string): void;
}

export const KEYCHAIN_SERVICE = 'agent-communications';

/**
 * How long a keychain call may take before the tool call fails with a clear message. A background MCP server cannot
 * answer an OS prompt, so it must not hang.
 */
export const KEYCHAIN_TIMEOUT_MS = 12_000;

export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  #path(ref: string): string {
    return join(this.directory, `${createHash('sha256').update(ref).digest('hex').slice(0, 32)}.json`);
  }

  async get(ref: string): Promise<string | null> {
    try {
      // `O_NOFOLLOW`, because `readFile` follows a symlink and this file holds a refresh token. Anything able to
      // drop a link into the secrets directory could otherwise have this process open a file of its choosing and
      // report what it found — and the attachment jail two files over already knows to do this.
      const handle = await open(this.#path(ref), constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: string;
      try {
        raw = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
      const parsed = JSON.parse(raw) as { ref?: string; value?: unknown };
      if (parsed.ref !== ref || typeof parsed.value !== 'string') return null;
      return parsed.value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CommsError('SECRET_STORE_UNAVAILABLE', 'a stored secret file could not be read', {
        hint: 'Run `agentcomms doctor`; re-authorise the inbox if the file is damaged.',
        cause: error,
      });
    }
  }

  async set(ref: string, value: string): Promise<void> {
    await writeFileAtomic(this.#path(ref), JSON.stringify({ ref, value, updatedAt: new Date().toISOString() }));
  }

  invalidate(_ref: string): void {
    // Nothing is cached: every read goes to the file.
  }

  async delete(ref: string): Promise<boolean> {
    try {
      await rm(this.#path(ref));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}

interface KeyringEntry {
  getPassword(signal?: AbortSignal | null): Promise<string | undefined>;
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  deletePassword(signal?: AbortSignal | null): Promise<boolean>;
}

export interface KeyringModule {
  AsyncEntry: new (
    service: string,
    username: string,
    options?: { linux?: { store?: 'secret-service' | 'keyutils' } } | null,
  ) => KeyringEntry;
}

/** Loads the optional native keyring. Null when it is not installed or has no binary for this platform. */
export async function loadKeyringModule(): Promise<KeyringModule | null> {
  try {
    const module = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
    return typeof module.AsyncEntry === 'function' ? module : null;
  } catch {
    return null;
  }
}

class KeychainTimeout extends Error {
  override name = 'KeychainTimeout';
}

function keychainError(action: string, cause: unknown, timeoutMs: number): CommsError {
  const timedOut = cause instanceof KeychainTimeout;
  return new CommsError(
    timedOut ? 'KEYCHAIN_APPROVAL_PENDING' : 'SECRET_STORE_UNAVAILABLE',
    timedOut
      ? `the system keychain did not answer within ${Math.round(timeoutMs / 1000)}s while trying to ${action}`
      : `the system keychain refused to ${action} (it may be locked, or access was denied)`,
    {
      hint: timedOut
        ? 'Look for a system dialog asking to allow access to the keychain, then retry. Run `agentcomms doctor` for details.'
        : 'Unlock the keychain and retry, or run `agentcomms doctor`. On macOS a Node upgrade can require allowing access again.',
      details: { reason: timedOut ? 'KEYCHAIN_APPROVAL_PENDING' : 'KEYCHAIN_UNAVAILABLE' },
      cause,
    },
  );
}

/**
 * Races a keychain call against a JS timer. The native call runs on the libuv thread pool and cannot be cancelled
 * once started — an OS approval dialog can hold it indefinitely — so the timeout must not depend on it cooperating.
 */
async function raceTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new KeychainTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class KeychainSecretStore implements SecretStore {
  readonly kind = 'keychain' as const;
  readonly #module: KeyringModule;
  readonly #timeoutMs: number;
  readonly #namespace: string;
  /** One keychain call at a time: parallel calls would each raise their own OS prompt and exhaust the thread pool. */
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * A native call that timed out but has not settled — typically held by an OS dialog. It still occupies a libuv
   * thread (which file I/O shares), so no further native call may start until it settles; callers fail fast instead.
   */
  #stuck: Promise<unknown> | null = null;
  /** Values already read, so a server start costs at most one prompt per secret. */
  readonly #cache = new Map<string, string | null>();

  /**
   * @param namespace keeps entries of different config directories apart (a test run or a second setup must never
   *   read or overwrite another's `client:default:secret`); see {@link keychainNamespace}.
   */
  constructor(module: KeyringModule, namespace: string, timeoutMs: number = KEYCHAIN_TIMEOUT_MS) {
    this.#module = module;
    this.#namespace = namespace;
    this.#timeoutMs = timeoutMs;
  }

  #entry(ref: string): KeyringEntry {
    return new this.#module.AsyncEntry(KEYCHAIN_SERVICE, `${this.#namespace}:${ref}`, {
      linux: { store: 'secret-service' },
    });
  }

  #serial<T>(action: string, fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      if (this.#stuck) throw keychainError(action, new KeychainTimeout(), this.#timeoutMs);
      const native = fn();
      try {
        return await raceTimeout(native, this.#timeoutMs);
      } catch (error) {
        if (error instanceof KeychainTimeout) {
          const stuck: Promise<unknown> = native.then(
            () => undefined,
            () => undefined,
          );
          this.#stuck = stuck;
          void stuck.then(() => {
            if (this.#stuck === stuck) this.#stuck = null;
          });
        }
        throw keychainError(action, error, this.#timeoutMs);
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  invalidate(ref: string): void {
    this.#cache.delete(ref);
  }

  async get(ref: string): Promise<string | null> {
    if (this.#cache.has(ref)) return this.#cache.get(ref) ?? null;
    const value = await this.#serial(
      'read a stored secret',
      async () => (await this.#entry(ref).getPassword()) ?? null,
    );
    this.#cache.set(ref, value);
    return value;
  }

  async set(ref: string, value: string): Promise<void> {
    await this.#serial('store a secret', () => this.#entry(ref).setPassword(value));
    this.#cache.set(ref, value);
  }

  async delete(ref: string): Promise<boolean> {
    const removed = await this.#serial('delete a stored secret', () => this.#entry(ref).deletePassword());
    this.#cache.delete(ref);
    return removed;
  }
}

/** A short, stable namespace for keychain entries, derived from the resolved config directory. */
export function keychainNamespace(configDir: string): string {
  return createHash('sha256').update(configDir).digest('hex').slice(0, 12);
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/** A full round trip — write, read back, delete — on a scratch entry. The only honest test that the store works. */
export async function probeKeychain(module: KeyringModule | null = null, namespace = 'probe'): Promise<ProbeResult> {
  const keyring = module ?? (await loadKeyringModule());
  if (!keyring)
    return { ok: false, reason: 'the optional @napi-rs/keyring package is not installed for this platform' };
  const ref = `probe:${process.pid}:${Date.now()}`;
  try {
    await new KeychainSecretStore(keyring, namespace).set(ref, 'probe');
    // A separate instance, so the read goes to the keychain rather than to the writer's cache.
    const reader = new KeychainSecretStore(keyring, namespace);
    const value = await reader.get(ref);
    await reader.delete(ref);
    return value === 'probe' ? { ok: true } : { ok: false, reason: 'the keychain did not return what was stored' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Opens the backend recorded in config for an inbox or client. */
export async function openSecretStore(
  kind: SecretStoreKind,
  options: { secretsDir: string; namespace: string; keyring?: KeyringModule | null },
): Promise<SecretStore> {
  if (kind === 'file') return new FileSecretStore(options.secretsDir);
  const keyring = options.keyring === undefined ? await loadKeyringModule() : options.keyring;
  if (!keyring) {
    throw new CommsError(
      'SECRET_STORE_UNAVAILABLE',
      'secrets are kept in the system keychain, but the keychain module is missing',
      {
        hint: 'Reinstall with optional dependencies, or re-add the inbox with --store file.',
      },
    );
  }
  return new KeychainSecretStore(keyring, options.namespace);
}
