import { CommsError } from '@agentcomms/core';
import type { GmailEventSource } from '@agentcomms/gmail';

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
