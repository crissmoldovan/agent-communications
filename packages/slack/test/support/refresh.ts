import type { AccountConfig } from '@agentcomms/core';
import { parseBundle, type TokenBundle } from '../../src/auth/bundle.ts';
import type { PersistPolicy } from '../../src/auth/refresh.ts';
import { SlackContext } from '../../src/context.ts';
import type { Harness } from './harness.ts';

/** Shared by the three refresh-session suites, which are split only so each stays inside the per-file timeout. */

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
