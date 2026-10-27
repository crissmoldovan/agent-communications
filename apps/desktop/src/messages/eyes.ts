/**
 * Which standing approval a 👀 on taking would use (design 2026-10-26-taking-messages §7): the account's standing
 * approvals that hold the `eyes` reaction, active, soonest to end first — the line Settings → Taking messages shows
 * beside "Say so to the sender with 👀". The setting is not a permission: the approval the person made at their
 * terminal is what permits the reaction, and with none, nothing is posted.
 */
import type { StandingView } from '../cli-types.ts';

/** The standing approvals in a workspace whose contents hold a 👀 reaction, active ones, soonest to end first (§7). */
export function eyesApprovals(approvals: readonly StandingView[], workspace: string): StandingView[] {
  return approvals
    .filter(
      (approval) =>
        approval.workspace === workspace &&
        approval.state === 'active' &&
        approval.contents.some((content) => content.kind === 'reaction' && content.text === 'eyes'),
    )
    .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999'));
}

function placesWords(approval: StandingView): string {
  if (approval.places.kind === 'threads-i-am-in') return 'in threads you’re in';
  const names = approval.places.places.map((place) => (place.name === null ? place.id : `#${place.name}`));
  return `in ${names.join(', ')}`;
}

/** The line naming the standing approval a 👀 on taking would use, or null when there is none. */
export function eyesLine(approvals: readonly StandingView[], workspace: string): string | null {
  const first = eyesApprovals(approvals, workspace)[0];
  if (first === undefined) return null;
  const ends =
    first.expiresAt === null
      ? ''
      : `, which ends ${new Date(first.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const thread =
    first.limits.perThread < 2
      ? ' It allows one acknowledgement in each thread, so the 👀 uses it: a reply approved in advance after it is refused there, unless you allow 2 or more.'
      : '';
  return `It would use the reply you approved in advance ${placesWords(first)}${ends}.${thread}`;
}
