import assert from 'node:assert/strict';
import { type AccountConfig, CommsError, type SecretStore } from '@agentcomms/core';
import { parseBundle, type TokenBundle } from '../../src/auth/bundle.ts';
import type { PersistPolicy } from '../../src/auth/refresh.ts';
import { SlackContext } from '../../src/context.ts';
import type { Harness } from './harness.ts';

/** Shared by the refresh suites, which are split only so each stays inside the per-file timeout. */

export const HOUR: number = 60 * 60_000;
export const QUICK: PersistPolicy = { budgetMs: 200, backoffMs: [5] };

/** A workspace whose access token has expired, so the next open refreshes it. */
export async function expired(harness: Harness, over: Partial<TokenBundle> = {}): Promise<AccountConfig> {
  return harness.addWorkspace({
    alias: 'acme',
    bundle: { accessExpiresAt: new Date(Date.now() - HOUR).toISOString(), ...over },
  });
}

export function contextFor(harness: Harness): SlackContext {
  return new SlackContext({ core: harness.core, env: harness.env, exchange: (params) => harness.exchange(params) });
}

export async function stored(harness: Harness, secretRef: string): Promise<TokenBundle | null> {
  const secrets = await harness.core.secrets('file');
  return parseBundle(await secrets.get(secretRef));
}

/** `fetch` failing the way undici does: a `TypeError` whose `cause` carries the system error's code. */
export function fetchFailed(...codes: string[]): TypeError {
  const causes = codes.map((code) => Object.assign(new Error(`connect ${code}`), { code }));
  const cause = causes.length === 1 ? causes[0] : Object.assign(new AggregateError(causes), { code: codes[0] });
  return new TypeError('fetch failed', { cause });
}

/**
 * `fetch` failing because no address it tried would connect, in the exact shape Node gives it.
 *
 * Node tries each address a name resolves to, and drops an attempt that has not connected within 250 ms with an
 * `ETIMEDOUT` whose `syscall` is `connect`. When every attempt fails, `net` raises an `AggregateError` carrying the
 * first attempt's code, one error per address inside it. Each `[code, syscall]` pair is one address tried; the
 * addresses are from the documentation ranges.
 */
export function attemptsFailed(...attempts: readonly (readonly [code: string, syscall: string])[]): TypeError {
  const errors = attempts.map(([code, syscall], index) =>
    Object.assign(new Error(`${syscall} ${code}`), {
      code,
      syscall,
      address: index % 2 === 0 ? '2001:db8::1' : '192.0.2.1',
      port: 443,
    }),
  );
  const cause = Object.assign(new AggregateError(errors), { code: attempts[0]?.[0] });
  return new TypeError('fetch failed', { cause });
}

/** `fetch` failing with one system error from the given call: `connect` before a connection, `read` after one. */
export function syscallFailed(code: string, syscall: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(`${syscall} ${code}`), { code, syscall }) });
}

export interface FlakyStore extends SecretStore {
  /** While true, every write fails. */
  failing: boolean;
  /** How many writes have failed. */
  attempts: number;
}

/** The harness's file store, with its writes switched off on demand and counted. */
export function flakyStore(inner: SecretStore): FlakyStore {
  const self: FlakyStore = {
    failing: false,
    attempts: 0,
    kind: inner.kind,
    get: (ref) => inner.get(ref),
    delete: (ref) => inner.delete(ref),
    invalidate: (ref) => inner.invalidate(ref),
    async set(ref, value) {
      if (self.failing) {
        self.attempts += 1;
        throw new CommsError('SECRET_STORE_UNAVAILABLE', 'the store is unavailable');
      }
      return inner.set(ref, value);
    },
  };
  return self;
}

/** Polls for a condition rather than sleeping a fixed time, which a loaded machine makes too short. */
export async function until(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
