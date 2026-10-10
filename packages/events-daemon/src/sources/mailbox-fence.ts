import type { DatabaseSync } from 'node:sqlite';
import { isSourceScopeFenced } from './source-scope-fence.ts';

/**
 * D12's activation-completion scope fence. A claimed activation that has sampled P for a mailbox but not yet installed
 * its point there — a first activation, or a replacement's scope with no old-version drain (a new-only scope, or one the
 * old version had gone dark for) — pauses every commit on that mailbox until finalisation installs the point and drops
 * the baseline in one transaction. Otherwise another rule's scan, or the scheduler's initial-cursor install, could move
 * the shared cursor past P and the new version, starting at P, would never see what was consumed. A scope with an old-
 * version drain is not paused: the drain withholds after-P work itself, and the old version must reach P. A stuck claim
 * fails at its completion deadline, which drops the baseline and lifts the fence.
 */
export function isMailboxFenced(database: DatabaseSync, accountId: string): boolean {
  return isSourceScopeFenced(database, { source: 'gmail', accountId, scopeId: 'mailbox' });
}
