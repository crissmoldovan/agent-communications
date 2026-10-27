/**
 * Taking messages' reads (0.35.0, design 2026-10-26-taking-messages §8, §9): core's `takes list` and `taking`, each the
 * person's read through the allow-list, and the messages nobody took in time — the Queue's Not taken, which counts
 * toward the Queue's badge — joined in the app from the event service's `messages list` and core's takes, as §8 says:
 * no queue item is made for one.
 */
import type { Loadable } from '../data.tsx';
import { type ActivitySince, type Bridge, errorMessage, type Product } from '../ipc.ts';
import { readAccounts } from './accounts.ts';
import { type JoinedMessage, join, takeContext } from './join.ts';
import { readMessagesPage, readTakesList, readTaking, type TakesRead, type TakingRead } from './read.ts';

/** How far back the takes are read: their own retention, 30 days, as Messages reads. */
export const TAKES_SINCE: ActivitySince = '30d';

/** How far back, and how many, events Not taken reads: the newest page of the last 30 days, as Messages reads first. */
export const NOT_TAKEN_WINDOW_MS: number = 30 * 24 * 60 * 60 * 1000;
export const NOT_TAKEN_LIMIT = 100;

export const TAKES_COPY = {
  takesUnreadable: 'Who has each message could not be read.',
  takingUnreadable: 'The taking settings could not be read.',
  messagesUnreadable: 'The messages could not be read.',
} as const;

async function readWith<T>(
  bridge: Bridge,
  call: Parameters<Bridge['cli']>[0],
  reader: (value: unknown) => T | null,
  unreadable: string,
): Promise<Loadable<T>> {
  try {
    const result = await bridge.cli(call);
    if (result.status === 'ok') {
      const value = reader(result.data);
      return value === null ? { state: 'error', message: unreadable } : { state: 'ready', value };
    }
    return { state: 'error', message: result.status === 'failed' ? result.message : unreadable };
  } catch (error) {
    return { state: 'error', message: errorMessage(error) };
  }
}

/** Core's `takes list --since 30d`: every take, with its holder's folder and client and its notes enveloped. */
export function readTakes(bridge: Bridge): Promise<Loadable<TakesRead>> {
  return readWith(bridge, { kind: 'takesList', since: TAKES_SINCE }, readTakesList, TAKES_COPY.takesUnreadable);
}

/** Core's `taking`: each account's settings. */
export function readTakingSettings(bridge: Bridge): Promise<Loadable<TakingRead>> {
  return readWith(bridge, { kind: 'taking' }, readTaking, TAKES_COPY.takingUnreadable);
}

/**
 * The messages nobody took in time, newest first (§8): read only where taking is required for an account — otherwise
 * none, and nothing more is asked than `taking`. Each comes from the newest page of the event service's messages,
 * joined with core's takes and each account's settings at `now`.
 */
export async function readNotTaken(
  bridge: Bridge,
  present: readonly Product[],
  now: number = Date.now(),
): Promise<Loadable<JoinedMessage[]>> {
  const taking = await readTakingSettings(bridge);
  if (taking.state !== 'ready') return taking;
  if (!taking.value.accounts.some((account) => account.required)) return { state: 'ready', value: [] };
  const [takes, page, accounts] = await Promise.all([
    readTakes(bridge),
    readWith(
      bridge,
      { kind: 'eventsMessagesList', since: now - NOT_TAKEN_WINDOW_MS, limit: NOT_TAKEN_LIMIT },
      readMessagesPage,
      TAKES_COPY.messagesUnreadable,
    ),
    readAccounts(bridge, present, { resend: true }),
  ]);
  if (takes.state !== 'ready') return takes;
  if (page.state !== 'ready') return page;
  const joined = join(page.value.messages, new Map(), {
    aliases: accounts.aliases,
    takes: takeContext(takes.value.takes, taking.value.accounts, now),
  });
  return { state: 'ready', value: joined.filter((message) => message.notTaken !== null) };
}
