/**
 * Account ids as the person knows them (owner feedback 0.32.0, §3.4 and §3.8): the event service names an account by
 * its id, and the Accounts screen by its alias. These read the same lists the Accounts screen does — Gmail's `inbox
 * list`, Slack's `workspace list`, Resend's `account list` — and map each id to its alias, falling back to the id where
 * no list names it. For a link to the message, they also keep a mailbox's address and a workspace's team id.
 */
import { useMemo } from 'react';
import { useAppData } from './data.tsx';
import { useCall } from './hooks/use-call.ts';
import type { AccountsProduct, Call } from './ipc.ts';

/** What the app knows of one account, by its id. */
export interface AccountName {
  alias: string;
  /** A Gmail mailbox's address, for an Open in Gmail link. */
  email: string | null;
  /** A Slack workspace's team id, for an Open in Slack link. */
  team: string | null;
}

export type AccountNames = ReadonlyMap<string, AccountName>;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * One product's account list, read: Gmail's `[{ alias, id, email }]`, Slack's `[{ alias, accountId, workspaceId }]`,
 * Resend's `{ accounts: [{ name, id }] }`. Anything else names nothing.
 */
export function readAccountNames(product: AccountsProduct, value: unknown): [string, AccountName][] {
  const rows = product === 'resend' ? (isRecord(value) ? value.accounts : null) : value;
  if (!Array.isArray(rows)) return [];
  return rows.filter(isRecord).flatMap((row): [string, AccountName][] => {
    const id = text(product === 'slack' ? row.accountId : row.id);
    const alias = text(product === 'resend' ? row.name : row.alias);
    if (id === null || alias === null) return [];
    return [
      [
        id,
        {
          alias,
          email: product === 'gmail' ? text(row.email) : null,
          team: product === 'slack' ? text(row.workspaceId) : null,
        },
      ],
    ];
  });
}

const GMAIL: Call = { kind: 'accounts', product: 'gmail' };
const SLACK: Call = { kind: 'accounts', product: 'slack' };
const RESEND: Call = { kind: 'accounts', product: 'resend' };

/**
 * Every account the three lists name, by id: read when the screen opens, each list only where its launcher is here. A
 * list that is loading, failed or cannot be read names nothing, and its ids show as they are.
 */
export function useAccountNames(): AccountNames {
  const { installation } = useAppData();
  const present = installation.state === 'ready' ? installation.value.present : [];
  const gmail = useCall<unknown>(present.includes('gmail') ? GMAIL : null).result;
  const slack = useCall<unknown>(present.includes('slack') ? SLACK : null).result;
  const resend = useCall<unknown>(present.includes('resend') ? RESEND : null).result;
  return useMemo(() => {
    const names = new Map<string, AccountName>();
    for (const [product, read] of [
      ['gmail', gmail],
      ['slack', slack],
      ['resend', resend],
    ] as const) {
      if (read.state !== 'ready') continue;
      for (const [id, name] of readAccountNames(product, read.value)) names.set(id, name);
    }
    return names;
  }, [gmail, slack, resend]);
}

/** An account's alias, or its id where no list names it. */
export function aliasOf(names: AccountNames, id: string): string {
  return names.get(id)?.alias ?? id;
}
