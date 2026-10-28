import type { EventDatabase } from '../../store/database.ts';
import { needsThePerson, RELAY_RUN_END_TYPES, type RelayEventV1, type RelaySnapshotV1 } from '../relay-client.ts';

/*
 * The waits the relay ends (workflows design W9, §6.5, §7.3; plan B4): a turn's end and a free session. A wait is a
 * row, never a process; this only marks one over — `wake_at = 0`, which no timeout can be — and wakes its run, which
 * then reads how the turn ended from the relay itself. It is told by the busy queue's follower: each run-end record of
 * the relay's stream as it comes, and each watched session's snapshot on every (re)connect and every interval, so a
 * turn that ended while the service was down, or across a journal reset, is found then. Marking is idempotent, so a
 * repeated record or a second reconcile wakes each wait once.
 */

/** A wait the relay ended, as `workflow_waits` holds it: over, whatever its timeout. */
export const RELAY_WAIT_OVER = 0;

export class RelayWaits {
  readonly #store: EventDatabase;
  readonly #wake: (runId: string) => void;

  constructor(options: { readonly store: EventDatabase; readonly wake: (runId: string) => void }) {
    this.#store = options.store;
    this.#wake = options.wake;
  }

  /** The relay sessions a live wait listens to: each free-session wait's, and the session of each awaited turn. */
  watchedSessions(): readonly string[] {
    return (
      this.#store.database
        .prepare(
          `SELECT w.key AS session FROM workflow_waits AS w
            WHERE w.kind = 'session-idle' AND w.key IS NOT NULL AND w.wake_at <> 0
           UNION
           SELECT sd.relay_session_id AS session FROM workflow_waits AS w
             JOIN session_deliveries AS sd ON sd.run_id = w.key
            WHERE w.kind = 'turn-end' AND w.wake_at <> 0
           ORDER BY session`,
        )
        .all() as Array<{ session: string }>
    ).map((row) => row.session);
  }

  /** A record of the relay's stream: a turn's end ends the wait for that turn, and frees its session's waits. */
  onRelayEvent(event: RelayEventV1): void {
    if (!(RELAY_RUN_END_TYPES as readonly string[]).includes(event.type)) return;
    if (event.runId !== undefined) this.#over('turn-end', event.runId);
    this.#over('session-idle', event.sessionId);
  }

  /**
   * One watched session as it is now: every awaited turn of it that is no longer its live turn has ended, and a wait for
   * it to be free is over when it has no live turn.
   */
  reconcile(snapshot: RelaySnapshotV1): void {
    this.#settle(snapshot.session.id, snapshot);
  }

  /** A watched session the relay no longer knows: every wait on it is over, and its step reads what that means. */
  gone(sessionId: string): void {
    this.#settle(sessionId, null);
  }

  #settle(sessionId: string, snapshot: RelaySnapshotV1 | null): void {
    const turns = this.#store.database
      .prepare(
        `SELECT w.key AS turn FROM workflow_waits AS w JOIN session_deliveries AS sd ON sd.run_id = w.key
          WHERE w.kind = 'turn-end' AND w.wake_at <> 0 AND sd.relay_session_id = ?`,
      )
      .all(sessionId) as Array<{ turn: string }>;
    for (const { turn } of turns) {
      if (snapshot === null || snapshot.session.activeRunId !== turn) this.#over('turn-end', turn);
      else this.#needsYou(turn, needsThePerson(snapshot, turn));
    }
    if (snapshot === null || snapshot.session.activeRunId === undefined) this.#over('session-idle', sessionId);
  }

  /**
   * A turn that goes on, and whether it waits on the person in claude-stream now (§6.5): the waiting step's stored output
   * says so, content-free, for `runs list`, `runs show` and the run view. Nothing wakes, and nothing counts as a step.
   */
  #needsYou(turn: string, needed: boolean): void {
    this.#store.immediate(() =>
      this.#store.database
        .prepare(
          `UPDATE workflow_steps
              SET output = json_set(COALESCE(output, '{}'), '$.needsYouInClaudeStream', json(?))
            WHERE state = 'waiting'
              AND COALESCE(json_extract(output, '$.needsYouInClaudeStream'), 0) <> ?
              AND (run_id, step_id) IN (SELECT run_id, step_id FROM workflow_waits
                                         WHERE kind = 'turn-end' AND key = ? AND wake_at <> 0)`,
        )
        .run(needed ? 'true' : 'false', needed ? 1 : 0, turn),
    );
  }

  #over(kind: 'turn-end' | 'session-idle', key: string): void {
    const runs = this.#store.immediate(() => {
      const waiting = this.#store.database
        .prepare('SELECT run_id FROM workflow_waits WHERE kind = ? AND key = ? AND wake_at <> 0')
        .all(kind, key) as Array<{ run_id: string }>;
      if (waiting.length === 0) return [];
      this.#store.database
        .prepare('UPDATE workflow_waits SET wake_at = ? WHERE kind = ? AND key = ? AND wake_at <> 0')
        .run(RELAY_WAIT_OVER, kind, key);
      return waiting.map((row) => row.run_id);
    });
    for (const runId of new Set(runs)) this.#wake(runId);
  }
}
