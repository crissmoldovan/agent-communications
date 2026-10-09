import { CommsError } from '@agentcomms/core';
import type { GmailEventSource } from '@agentcomms/gmail';
import type { LocalEventSource, SourceScope } from '../sources/contracts.ts';
import type { MailboxLock } from '../sources/mailbox-lock.ts';
import type { SourceScopeLock } from '../sources/scope-lock.ts';

/** The source-neutral lock-and-sample shape used by every activation baseline. */
export async function persistSourceBaseline<TPosition, TResult>(
  source: LocalEventSource,
  lock: SourceScopeLock,
  scope: SourceScope,
  sample: () => Promise<TPosition>,
  persist: (position: TPosition) => Promise<TResult> | TResult,
): Promise<TResult> {
  return source.withScopes(lock, [scope], async () => persist(await source.baseline(sample)));
}

/** The only Gmail activation baseline: a profile history id, never a history or body/materialisation read. */
export async function gmailBaseline(
  source: Pick<GmailEventSource, 'getProfile'>,
): Promise<{ readonly historyId: string }> {
  const profile = await source.getProfile();
  if (typeof profile.historyId !== 'string' || !/^[0-9]+$/.test(profile.historyId)) {
    throw new CommsError('BAD_DATA', 'the Gmail profile baseline did not contain an unsigned history id');
  }
  return { historyId: profile.historyId };
}

/**
 * Captures and durably records a Gmail activation point under the same account lock as history staging and its final
 * cursor commit. The callback is deliberately inside the lock because its encryption and write define the point.
 */
export async function persistGmailBaseline<T>(
  source: LocalEventSource,
  mailboxLock: MailboxLock,
  accountId: string,
  sourceFor: () => Promise<Pick<GmailEventSource, 'getProfile'>>,
  persist: (position: { readonly historyId: string }) => Promise<T> | T,
): Promise<T> {
  return persistSourceBaseline(
    source,
    mailboxLock.sourceScopeLock,
    { source: 'gmail', accountId, scopeId: 'mailbox' },
    async () => gmailBaseline(await sourceFor()),
    persist,
  );
}
