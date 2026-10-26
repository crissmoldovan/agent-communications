/**
 * Search on this Mac's settings (design 2026-10-26-local-search, S1, S9, S12): `config.json`'s `search` block, read as
 * the stricter value wherever it cannot be read.
 *
 * - `enabled`: `on` or `off`, off when absent (S1: search is the first store whose job is to keep message text).
 * - `accounts`: the immutable ids of the accounts whose messages are kept — Gmail mailboxes and Slack workspaces only
 *   (S2: never WhatsApp, never Resend in v1). None when absent.
 * - `model`: the local model server's address and the model's name, or none (S9): words only.
 *
 * The block is a key the schemas do not name, so every release sharing the file keeps it through its writes, as it
 * keeps `activity`. A value this release cannot read is read as off, as no account and as no model — never as more —
 * and named in `problems`. Switching on, adding an account and setting a model are loosenings a person approves
 * (`classifyChange`); off, removing an account and no model apply at once.
 *
 * `config.ts` imports this module to judge a change, so it imports nothing but the loopback rule, which imports nothing.
 */

import { type SearchEndpoint, searchEndpoint } from './endpoint-rule.ts';
import { searchModelName } from './models.ts';

export const SEARCH_ENABLED_SETTINGS: readonly ['on', 'off'] = Object.freeze(['on', 'off'] as const);
export type SearchEnabledSetting = (typeof SEARCH_ENABLED_SETTINGS)[number];

/** The model a person chose: where its server is, on this machine, and which model of the reviewed list. */
export interface SearchModelSetting {
  /** The server's root, canonical: `http://127.0.0.1:<port>` or `http://[::1]:<port>`. */
  readonly address: string;
  /** The model's name with its tag, as Ollama lists it: `qwen3-embedding:0.6b`. */
  readonly name: string;
}

export interface SearchSettings {
  readonly enabled: SearchEnabledSetting;
  /** Account ids, each once, in the order the file holds them. */
  readonly accounts: readonly string[];
  readonly model: SearchModelSetting | null;
  /** One sentence for each value read as something stricter than the file says. */
  readonly problems: readonly string[];
}

/** An account's immutable id, as config.json keeps it: `ibx_…` for a mailbox, `acc_…` for a workspace. */
export const SEARCH_ACCOUNT_ID: RegExp = /^(?:ibx|acc)_[A-Za-z0-9]{1,64}$/;

/** The `search` block as the file holds it, raw: an object, or nothing. */
export function storedSearch(config: { readonly search?: unknown }): Readonly<Record<string, unknown>> | null {
  const stored = config.search;
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : null;
}

const OFF: SearchSettings = Object.freeze({ enabled: 'off', accounts: [], model: null, problems: [] });

/**
 * The settings in force for `config`. A missing block is off, with no account and no model. Anything this release
 * cannot read is named in `problems` and read as less: a word other than `on` or `off` as off; an account list that is
 * not a list of ids as no account (an entry that is not an id is left out); a model this release cannot read — an
 * address off this machine, a name off the reviewed list — as no model.
 */
export function readSearchSettings(config: { readonly search?: unknown }): SearchSettings {
  if (config.search === undefined) return OFF;
  const stored = storedSearch(config);
  if (stored === null) {
    return { ...OFF, problems: ['search in config.json is not an object, so search is off'] };
  }
  const problems: string[] = [];
  let enabled: SearchEnabledSetting = 'off';
  if (stored.enabled !== undefined) {
    if (stored.enabled === 'on' || stored.enabled === 'off') enabled = stored.enabled;
    else problems.push(`search.enabled is ${describe(stored.enabled)}, not on or off, so search is off`);
  }
  const accounts: string[] = [];
  if (stored.accounts !== undefined) {
    if (!Array.isArray(stored.accounts)) {
      problems.push('search.accounts is not a list, so no account is kept');
    } else {
      for (const entry of stored.accounts) {
        if (typeof entry === 'string' && SEARCH_ACCOUNT_ID.test(entry)) {
          if (!accounts.includes(entry)) accounts.push(entry);
        } else {
          problems.push(`search.accounts holds ${describe(entry)}, which is not an account's id, and it is left out`);
        }
      }
    }
  }
  let model: SearchModelSetting | null = null;
  if (stored.model !== undefined && stored.model !== null) {
    model = readModel(stored.model, problems);
  }
  return { enabled, accounts, model, problems };
}

function readModel(raw: unknown, problems: string[]): SearchModelSetting | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push('search.model is not an object, so no model is used: search is by words only');
    return null;
  }
  const { address, name } = raw as { address?: unknown; name?: unknown };
  let endpoint: SearchEndpoint;
  try {
    endpoint = searchEndpoint(address);
  } catch {
    problems.push(
      `search.model.address is ${describe(address)}, which is not a model server on this machine, so no model is used`,
    );
    return null;
  }
  const known = searchModelName(name);
  if (known === undefined) {
    problems.push(`search.model.name is ${describe(name)}, which is not on the reviewed list, so no model is used`);
    return null;
  }
  return { address: endpoint.address, name: known };
}

/** Whether `config` keeps the messages of the account `id` — search on, and the account included. */
export function searchKeeps(settings: SearchSettings, id: string): boolean {
  return settings.enabled === 'on' && settings.accounts.includes(id);
}

/** A model setting in a sentence: `qwen3-embedding:0.6b at http://127.0.0.1:11434`, or null for none. */
export function searchModelText(model: SearchModelSetting | null): string | null {
  return model === null ? null : `${model.name} at ${model.address}`;
}

/** A stored value in a sentence: short, and never more than a few dozen characters of whatever the file held. */
function describe(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value) ?? value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
