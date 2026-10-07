import { DatabaseSync } from 'node:sqlite';

export interface EventsDaemonStatus {
  owner: 'not-running';
}

/**
 * Reports the intentionally held service's ownership state.
 *
 * Task B1 only establishes the package and its public surfaces. Starting an
 * owner, opening the database and accepting event ingress are later work.
 */
export async function status(): Promise<EventsDaemonStatus> {
  // Keep the Node-owned SQLite contract observable without opening a database.
  if (typeof DatabaseSync !== 'function') throw new Error('This Node runtime does not provide node:sqlite.');
  return { owner: 'not-running' };
}
