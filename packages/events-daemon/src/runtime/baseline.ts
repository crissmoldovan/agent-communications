import { CommsError } from '@agentcomms/core';
import type { GmailEventSource } from '@agentcomms/gmail';
import type { MailboxLock } from '../sources/mailbox-lock.ts';

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
  mailboxLock: MailboxLock,
  accountId: string,
  sourceFor: () => Promise<Pick<GmailEventSource, 'getProfile'>>,
  persist: (position: { readonly historyId: string }) => Promise<T> | T,
): Promise<T> {
  return mailboxLock.withMailbox(accountId, async () => persist(await gmailBaseline(await sourceFor())));
}
